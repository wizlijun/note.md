// Ordered proxy: every accepted edit is journaled locally before plugin IPC.
#[path = "journal.rs"]
mod journal;
use journal::Journal;
use super::service::Backend;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{collections::VecDeque, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};
use write_core::{catalog::{DirectoryOperation, Entry}, storage::{FilePair, PendingUpdate}};
pub use sumi_protocol::durability::{Loaded, Create, LocalEdit, Outgoing, PublishedBaseline,
    ProjectionIdentity, DurableEvent, RecordedIncoming, IncomingReceipt, CommitReceipt, PageObservation};
use sumi_protocol::durability::Request;
type Result<T> = std::result::Result<T, String>;
const EDIT_CAPACITY: usize = 256;
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_DELAY: Duration = Duration::from_millis(500);
type Notify = Arc<dyn Fn(DurableEvent) + Send + Sync>;

#[derive(Clone)]
pub struct Durability {
    mode: Mode,
    notify: Notify,
}
#[derive(Clone)]
enum Mode {
    Remote { sender: mpsc::Sender<Job>, edits: Arc<Semaphore>, journal: Arc<Journal> },
    #[cfg(test)]
    Local(notemd_sumi_backend::durability::Durability),
}
struct Job {
    request: Request,
    reply: Option<Reply>,
    // Kept across failures/retries, not merely until removal from the channel.
    _reservation: Option<OwnedSemaphorePermit>,
}
enum Reply {
    Value(oneshot::Sender<Result<Value>>),
    Loaded(oneshot::Sender<Result<Loaded>>),
}
impl Reply {
    fn send(self, result: Result<Value>) {
        match self {
            Self::Value(sender) => { let _ = sender.send(result); }
            Self::Loaded(sender) => {
                let _ = sender.send(result.and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string())));
            }
        }
    }
}
/// Reserve before mutating the in-memory CRDT. Dropping an unused permit is safe.
pub struct Permit { mode: PermitMode }
enum PermitMode {
    Remote { slot: mpsc::OwnedPermit<Job>, quota: OwnedSemaphorePermit, journal: Arc<Journal> },
    #[cfg(test)]
    Local(notemd_sumi_backend::durability::Durability),
}
impl Permit {
    pub fn enqueue_local(self, edit: LocalEdit) -> Result<()> {
        match self.mode {
            PermitMode::Remote { slot, quota, journal } => {
                let request = Request::CommitLocal(edit);
                journal.append_then(&request.clone(), || {
                    slot.send(Job { request, reply: None, _reservation: Some(quota) });
                })
            }
            #[cfg(test)]
            PermitMode::Local(worker) => worker.enqueue_local(edit),
        }
    }
    pub fn enqueue_import(self, edit: LocalEdit, observed: FilePair) -> Result<oneshot::Receiver<Result<Loaded>>> {
        match self.mode {
            PermitMode::Remote { slot, quota, journal } => {
                let (sender, receiver) = oneshot::channel();
                let request = Request::ImportLocal { edit, observed };
                journal.append_then(&request.clone(), || {
                    slot.send(Job { request, reply:Some(Reply::Loaded(sender)), _reservation:Some(quota) });
                    receiver
                })
            }
            #[cfg(test)]
            PermitMode::Local(worker) => {
                let (sender, receiver)=oneshot::channel();
                tokio::spawn(async move { let _=sender.send(worker.import_local(edit,observed).await); });
                Ok(receiver)
            }
        }
    }
    pub fn enqueue_remote(self, incoming: PendingUpdate, generation: u64, revision: u64) -> Result<oneshot::Receiver<Result<Loaded>>> {
        match self.mode {
            PermitMode::Remote { slot, quota, journal } => {
                let (sender, receiver) = oneshot::channel();
                let request = Request::CommitRemote { incoming, generation, revision };
                journal.append_then(&request.clone(), || {
                    slot.send(Job { request, reply: Some(Reply::Loaded(sender)), _reservation: Some(quota) });
                    receiver
                })
            }
            #[cfg(test)]
            PermitMode::Local(worker) => worker.enqueue_remote(incoming, generation, revision),
        }
    }
}
impl Durability {
    pub fn from_backend(backend: Backend, journal_path: PathBuf, notify: impl Fn(DurableEvent) + Send + Sync + 'static) -> Result<Self> {
        let journal = Arc::new(Journal::open(&journal_path)?);
        // Recovery precedes every newly queued request, including Load/ObservePage.
        // Failure leaves the journal intact and makes barriers fail closed.
        let pending = journal.pending()?.into_iter().map(|request| Job {
            request, reply: None, _reservation: None,
        }).collect();
        let notify: Notify = Arc::new(notify);
        let (sender, receiver) = mpsc::channel(EDIT_CAPACITY);
        tokio::spawn(run(backend, receiver, notify.clone(), journal.clone(), pending));
        Ok(Self { mode: Mode::Remote { sender, edits: Arc::new(Semaphore::new(EDIT_CAPACITY)), journal }, notify })
    }
    /// Backend event ingress; caller authenticates workspace/session/instance first.
    /// No queue or document lock is held while invoking the callback.
    pub fn notify(&self, event: DurableEvent) { (self.notify)(event); }
    #[cfg(test)]
    pub async fn open(vault: PathBuf, database: PathBuf, notify: impl Fn(DurableEvent) + Send + Sync + 'static) -> Result<Self> {
        let notify: Notify = Arc::new(notify);
        let callback = notify.clone();
        let worker = notemd_sumi_backend::durability::Durability::open(vault, database, move |event| callback(event)).await?;
        Ok(Self { mode: Mode::Local(worker), notify })
    }
    #[cfg(test)]
    pub(super) fn disconnected_for_test() -> Self {
        let (sender, receiver)=mpsc::channel(1);
        drop(receiver);
        let directory = tempfile::tempdir().unwrap();
        let journal = Arc::new(Journal::open(&directory.path().join("input.sqlite3")).unwrap());
        Self { mode:Mode::Remote { sender, edits:Arc::new(Semaphore::new(1)), journal }, notify:Arc::new(|_|{}) }
    }
    pub fn try_reserve_edit(&self) -> Result<Permit> {
        match &self.mode {
            Mode::Remote { sender, edits, journal } => {
                let quota = edits.clone().try_acquire_owned().map_err(|_| "后台保存队列已满，请等待保存恢复后继续输入".to_owned())?;
                let slot = sender.clone().try_reserve_owned().map_err(|_| "后台保存队列繁忙或已停止，请稍后重试".to_owned())?;
                Ok(Permit { mode: PermitMode::Remote { slot, quota, journal: journal.clone() } })
            }
            #[cfg(test)]
            Mode::Local(worker) => Ok(Permit { mode: PermitMode::Local(worker.clone()) }),
        }
    }
    pub fn enqueue_local(&self, edit: LocalEdit) -> Result<()> { self.try_reserve_edit()?.enqueue_local(edit) }
    pub fn enqueue_remote(&self, incoming: PendingUpdate, generation: u64, revision: u64) -> Result<oneshot::Receiver<Result<Loaded>>> {
        self.try_reserve_edit()?.enqueue_remote(incoming, generation, revision)
    }
    async fn request<T: DeserializeOwned>(&self, request: Request) -> Result<T> {
        let value = match &self.mode {
            Mode::Remote { sender, edits, journal } => {
                let reservation = if replayable(&request) { Some(edits.clone().acquire_owned().await.map_err(|_| "保存队列已关闭".to_owned())?) } else { None };
                let (reply, receive) = oneshot::channel();
                let slot = sender.reserve().await.map_err(|_| "保存后台已停止".to_owned())?;
                let job = Job { request, reply: Some(Reply::Value(reply)), _reservation: reservation };
                if replayable(&job.request) {
                    journal.append_then(&job.request.clone(), || { slot.send(job); })?;
                } else { slot.send(job); }
                receive.await.map_err(|_| "保存后台已停止".to_owned())??
            }
            #[cfg(test)]
            Mode::Local(worker) => match request {
                Request::ImportLocal { edit, observed } => serde_json::to_value(worker.import_local(edit,observed).await?).map_err(|e|e.to_string())?,
                other => notemd_sumi_backend::durability_rpc::dispatch(worker,other).await?,
            },
        };
        serde_json::from_value(value).map_err(|e| e.to_string())
    }
    pub async fn create(&self, request: Create) -> Result<Loaded> { self.request(Request::Create(request)).await }
    pub async fn load(&self, page_id: String) -> Result<Loaded> { self.request(Request::Load { page_id }).await }
    pub async fn observe_page(&self, page_id: String) -> Result<PageObservation> { self.request(Request::ObservePage { page_id }).await }
    pub async fn flush(&self) -> Result<()> { self.request(Request::Flush).await }
    pub async fn list(&self) -> Result<Vec<Entry>> { self.request(Request::List).await }
    pub async fn excerpts(&self) -> Result<std::collections::HashMap<String, String>> { self.request(Request::Excerpts).await }
    pub async fn set_deleted(&self, page_id: String, deleted: bool) -> Result<Entry> { self.request(Request::SetDeleted { page_id, deleted }).await }
    pub async fn preferences(&self, key: String) -> Result<Option<Value>> { self.request(Request::Preferences { key }).await }
    pub async fn set_preferences(&self, key: String, value: Value) -> Result<()> { self.request(Request::SetPreferences { key, value }).await }
    pub async fn save_header(&self, page_id: String, expected_revision: u64, header: serde_yaml::Mapping) -> Result<Loaded> { self.request(Request::SaveHeader { page_id, expected_revision, header }).await }
    pub async fn read_baseline(&self, page_id: String) -> Result<Option<PublishedBaseline>> { self.request(Request::ReadBaseline { page_id }).await }
    pub async fn accept_imported_baseline(&self, page_id: String, observed: FilePair) -> Result<()> { self.request(Request::AcceptImportedBaseline { page_id, observed }).await }
    pub async fn import_local(&self, edit: LocalEdit, observed: FilePair) -> Result<Loaded> { self.request(Request::ImportLocal { edit, observed }).await }
    pub async fn import_projection_extensions(&self, page_id: String, generation: u64, expected_revision: u64, observed: FilePair) -> Result<Loaded> { self.request(Request::ImportProjectionExtensions { page_id, generation, expected_revision, observed }).await }
    pub async fn restore_projection(&self, page_id: String, generation: u64) -> Result<(Loaded, PathBuf)> { self.request(Request::RestoreProjection { page_id, generation }).await }
    pub async fn outbox(&self) -> Result<Vec<Outgoing>> { self.request(Request::Outbox).await }
    pub async fn outbox_count(&self) -> Result<u64> { self.request(Request::OutboxCount).await }
    pub async fn directory_outbox(&self) -> Result<Vec<DirectoryOperation>> { self.request(Request::DirectoryOutbox).await }
    pub async fn ack(&self, op_id: String) -> Result<()> { self.request(Request::Ack { op_id }).await }
    pub async fn acknowledge_directory(&self, op_id: String) -> Result<()> { self.request(Request::AcknowledgeDirectory { op_id }).await }
    pub async fn apply_directory(&self, entry: Entry) -> Result<Vec<Entry>> { self.request(Request::ApplyDirectory { entry }).await }
    pub async fn record_inbox(&self, incoming: PendingUpdate, generation: u64) -> Result<bool> { self.request(Request::RecordInbox { incoming, generation }).await }
    pub async fn has_document(&self, page_id: String) -> Result<bool> { self.request(Request::HasDocument { page_id }).await }
    pub async fn applied_incoming(&self, receipts: Vec<IncomingReceipt>) -> Result<std::collections::HashSet<String>> { self.request(Request::AppliedIncoming { receipts }).await }
    pub async fn pending_inbox(&self, page_id: String) -> Result<Vec<RecordedIncoming>> { self.request(Request::PendingInbox { page_id }).await }
    pub async fn receive_remote(&self, incoming: PendingUpdate, generation: u64) -> Result<Loaded> { self.request(Request::ReceiveRemote { incoming, generation }).await }
}

fn edit_identity(request: &Request) -> Option<(&str, u64)> {
    match request {
        Request::CommitLocal(edit) | Request::ImportLocal { edit, .. } => Some((&edit.page_id, edit.revision)),
        Request::CommitRemote { incoming, revision, .. } => Some((&incoming.page_id, *revision)),
        _ => None,
    }
}
fn replayable(request: &Request) -> bool {
    matches!(request, Request::CommitLocal(_) | Request::CommitRemote { .. } | Request::ImportLocal { .. })
}
async fn call<T: DeserializeOwned>(backend: &Backend, request: &Request) -> Result<T> {
    let params = serde_json::to_value(request).map_err(|e| e.to_string())?;
    tokio::time::timeout(CALL_TIMEOUT, backend.call("durability", params)).await
        .map_err(|_| "后台保存超时，未确认修改仍保留待重试".to_owned())?
}
fn validate_receipt(request: &Request, receipt: &CommitReceipt) -> Result<()> {
    if journal::receipt(request)? != *receipt { return Err("后台保存回执与待确认修改不一致".into()); }
    Ok(())
}
async fn execute(backend: &Backend, request: &Request, notify: &Notify, journal: &Journal) -> Result<Value> {
    if matches!(request, Request::ImportLocal { .. }) {
        let imported: sumi_protocol::durability::CommittedImport = call(backend,request).await?;
        validate_receipt(request,&imported.receipt)?;
        if imported.loaded.entry.id != imported.receipt.page_id || imported.loaded.entry.epoch != imported.receipt.epoch
            || imported.loaded.revision < imported.receipt.revision { return Err("导入回执与持久快照不一致".into()); }
        journal.acknowledge(request, &imported.receipt)?;
        notify(DurableEvent::Committed { page_id:imported.receipt.page_id, revision:imported.receipt.revision });
        return serde_json::to_value(imported.loaded).map_err(|e|e.to_string());
    }
    if matches!(request, Request::CommitLocal(_) | Request::CommitRemote { .. }) {
        let receipt: CommitReceipt = call(backend, request).await?;
        validate_receipt(request, &receipt)?;
        journal.acknowledge(request, &receipt)?;
        notify(DurableEvent::Committed { page_id:receipt.page_id.clone(), revision:receipt.revision });
        if matches!(request, Request::CommitRemote { .. }) {
            return call(backend, &Request::Load { page_id:receipt.page_id }).await;
        }
        return serde_json::to_value(receipt).map_err(|e| e.to_string());
    }
    call(backend, request).await
}
async fn run(backend: Backend, mut receiver: mpsc::Receiver<Job>, notify: Notify, journal: Arc<Journal>, mut pending: VecDeque<Job>) {
    let mut failure: Option<(String,tokio::time::Instant)> = None;
    loop {
        if let Some((error,retry_at)) = &failure {
            // Keep the failed edit and its capacity reservation. Barriers fail
            // promptly rather than waiting forever behind an unavailable disk/process.
            tokio::select! {
                _ = tokio::time::sleep_until(*retry_at) => { failure = None; }
                job = receiver.recv() => match job {
                    Some(mut job) if !replayable(&job.request) => {
                        if let Some(reply) = job.reply.take() { reply.send(Err(error.clone())); }
                    }
                    Some(job) => { pending.push_back(job); }
                    None => {
                        // All owners released the proxy. Normal close must have
                        // completed its barrier. Unacknowledged edits remain on disk
                        // for the next host even when this retry task is released.
                        for job in &pending { if let Some((page_id,revision))=edit_identity(&job.request) {
                            notify(DurableEvent::Failed {page_id:page_id.into(),revision,error:"保存代理已关闭，未确认修改未获持久回执".into()});
                        }}
                        return;
                    }
                }
            }
            if failure.is_some() { continue; }
        }
        let Some(mut job) = pending.pop_front().or_else(|| receiver.try_recv().ok()) else {
            match receiver.recv().await { Some(job) => { pending.push_back(job); continue; }, None => break }
        };
        match execute(&backend, &job.request, &notify, &journal).await {
            Ok(value) => { if let Some(reply) = job.reply.take() { reply.send(Ok(value)); } }
            Err(error) => {
                if let Some((page_id, revision)) = edit_identity(&job.request) {
                    notify(DurableEvent::Failed { page_id:page_id.into(), revision, error:error.clone() });
                }
                if let Some(reply) = job.reply.take() { reply.send(Err(error.clone())); }
                if replayable(&job.request) { pending.push_front(job); failure = Some((error,tokio::time::Instant::now()+RETRY_DELAY)); }
            }
        }
    }
}
