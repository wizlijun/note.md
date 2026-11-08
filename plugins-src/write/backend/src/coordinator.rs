//! One reconnecting transport loop per Vault. HTTP/WS acknowledge durable operation IDs;
//! only the host session coordinator decides when an incoming edit can touch a native view.
use super::{durability, sync, Result};
use crate::network::{EditorState, Workspace, Identity};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};
use write_core::{
    catalog::Entry,
    storage::{self, PendingUpdate},
};

#[derive(Clone)]
pub struct Handle {
    sender: mpsc::Sender<Command>,
    status: Arc<Mutex<Value>>,
    requested: Arc<Mutex<Option<String>>>,
    control: Arc<TaskControl>,
}
#[derive(Default)]
struct Tasks {
    runner: Option<tokio::task::JoinHandle<()>>,
    bootstraps: Vec<tokio::task::JoinHandle<()>>,
    stopping: bool,
}
struct TaskControl { tasks: Mutex<Tasks>, done: tokio::sync::watch::Sender<bool> }
impl Default for TaskControl {
    fn default() -> Self { Self { tasks: Mutex::new(Tasks::default()), done: tokio::sync::watch::channel(false).0 } }
}
enum Command {
    Pair(String, sync::Invitation, oneshot::Sender<Result<()>>),
    Prepare(String, oneshot::Sender<Result<()>>),
    Invite(oneshot::Sender<Result<sync::Invitation>>),
}
impl Handle {
    /// Cleanup owns its join handles, so cancelling a caller cannot strand a Vault lock.
    pub fn stop(&self) {
        let runner = {
            let mut tasks = self.control.tasks.lock().unwrap_or_else(|e| e.into_inner());
            if tasks.stopping { return; }
            tasks.stopping = true;
            if let Some(task) = tasks.runner.as_ref() { task.abort(); }
            for task in &tasks.bootstraps { task.abort(); }
            tasks.runner.take()
        };
        let control = self.control.clone();
        tokio::spawn(async move {
            if let Some(task) = runner { let _ = task.await; }
            // The runner cannot create another bootstrap after this join.
            let children = {
                let mut tasks = control.tasks.lock().unwrap_or_else(|e| e.into_inner());
                std::mem::take(&mut tasks.bootstraps)
            };
            for task in children { task.abort(); let _ = task.await; }
            control.done.send_replace(true);
        });
    }
    pub async fn shutdown(&self) -> Result<()> {
        self.stop();
        let mut done = self.control.done.subscribe();
        while !*done.borrow_and_update() {
            done.changed().await.map_err(|_| "同步停止状态不可用")?;
        }
        Ok(())
    }
    pub async fn prepare_page(&self, page: String) -> Result<()> {
        self.prepare_page_for(page, std::time::Duration::from_secs(360)).await
    }
    async fn prepare_page_for(&self, page: String, timeout: std::time::Duration) -> Result<()> {
        *self.requested.lock().map_err(super::err)? = Some(page.clone());
        let result = tokio::time::timeout(timeout, async {
            let (send, receive) = oneshot::channel();
            self.sender.send(Command::Prepare(page.clone(), send)).await.map_err(|_| "同步任务已停止")?;
            receive.await.map_err(|_| "同步任务已停止")?
        }).await.map_err(|_| "纸页同步超时，原稿已保留；连接恢复后可继续打开".to_owned()).and_then(|r| r);
        if let Ok(mut requested) = self.requested.lock() {
            if requested.as_deref() == Some(page.as_str()) { *requested = None; }
        }
        result
    }

    pub fn status(&self) -> Value {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| json!({"connected":false,"message":"同步状态不可用"}))
    }
    pub async fn pair(&self, server: String, invitation: sync::Invitation) -> Result<()> {
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Command::Pair(server, invitation, send))
            .await
            .map_err(|_| "同步任务已停止")?;
        receive.await.map_err(|_| "同步任务已停止")?
    }
    pub async fn invite(&self) -> Result<sync::Invitation> {
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Command::Invite(send))
            .await
            .map_err(|_| "同步任务已停止")?;
        receive.await.map_err(|_| "同步任务已停止")?
    }
}
/// Return whether the public state changed; release the lock before publishing.
fn status(handle: &Handle, connected: bool, message: &str) -> bool {
    let next = json!({"connected":connected,"message":message});
    let Ok(mut state) = handle.status.lock() else { return false; };
    if *state == next { return false; }
    *state = next;
    true
}
async fn publish_status(
    ws: &Workspace,
    handle: &Handle,
    connected: bool,
    message: &str,
) {
    if !status(handle, connected, message) || ws.current().await.is_err() { return; }
    // Host joins its current pending count, never a stale backend snapshot.
    let _ = ws.status(handle.status()).await;
}
pub fn start(workspace: Arc<Workspace>) -> Handle {
    let (sender, receiver) = mpsc::channel(16);
    let handle = Handle {
        sender,
        control: Arc::new(TaskControl::default()),
        requested: Arc::new(Mutex::new(None)),
        status: Arc::new(Mutex::new(json!({"connected":false,"message":"尚未连接同步服务"}))),
    };
    let h = handle.clone();
    let task = tokio::spawn(async move { run(workspace, h, receiver).await; });
    handle.control.tasks.lock().unwrap().runner = Some(task);
    handle
}
fn entry(page: sync::RemotePage) -> Result<Entry> {
    Ok(Entry {
        id: page.id,
        epoch: u32::try_from(page.epoch).map_err(|_| "invalid epoch")?,
        generation: page.generation,
        deleted: page.deleted != 0,
        local_date: page.local_date,
        sequence: page
            .sequence
            .map(u32::try_from)
            .transpose()
            .map_err(|_| "invalid sequence")?,
        after_id: page.after_id,
        registered: true,
    })
}
async fn directory(
    ws: &Arc<Workspace>,
    page: sync::RemotePage,
) -> Result<()> {
    ws.directory(vec![entry(page)?]).await
}
async fn pull_directory(
    ws: &Arc<Workspace>,
    client: &mut sync::SyncClient,
) -> Result<()> {
    let mut cursor = ws
        .durable
        .preferences("directoryCursor".into())
        .await?
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    loop {
        let batch = client.list_pages(cursor).await.map_err(super::err)?;
        for change in batch.changes {
            directory(ws, change.page).await?;
        }
        cursor = batch.cursor;
        ws.durable
            .set_preferences("directoryCursor".into(), json!(cursor))
            .await?;
        if !batch.has_more {
            return Ok(());
        }
    }
}
async fn send_one(
    ws: &Arc<Workspace>,
    client: &mut sync::SyncClient,
    op: &durability::Outgoing,
) -> Result<()> {
    let u = &op.update;
    // HTTP accepts large pastes and uses the same durable op ID as WebSocket. Small
    // edits also use HTTP here, leaving the subscribed socket free to receive peers.
    let ack = client
        .send_update(
            &u.op_id,
            &u.page_id,
            u.epoch as u64,
            op.generation,
            &u.update,
            op.first_write_date.as_deref(),
        )
        .await
        .map_err(super::err)?;
    ws.durable.ack(ack.op_id).await?;
    let current = ws
        .durable
        .list()
        .await?
        .into_iter()
        .find(|p| p.id == u.page_id)
        .ok_or("missing local page")?;
    let remote = sync::RemotePage {
        id: current.id,
        epoch: ack.epoch,
        generation: ack.generation,
        deleted: 0,
        local_date: ack.local_date,
        sequence: ack.sequence,
        after_id: current.after_id,
        version: ack.version,
    };
    directory(ws, remote).await
}
async fn send_pending(
    ws: &Arc<Workspace>,
    client: &mut sync::SyncClient,
    socket: Option<&sync::WsSession>,
    blocked: &HashMap<String,(u64,u64)>,
) -> Result<()> {
    let directory_ops = ws.durable.directory_outbox().await?;
    for op in directory_ops.iter().filter(|o| o.kind == "create" && !blocked.contains_key(&o.page_id)) {
        if socket.is_some_and(|s| s.is_expired()) { return Ok(()); }
        let page = client
            .create_page(
                &op.op_id,
                &op.page_id,
                op.payload["localDate"].as_str(),
                op.payload["afterId"].as_str(),
            )
            .await
            .map_err(super::err)?;
        ws.durable.acknowledge_directory(op.op_id.clone()).await?;
        directory(ws, page).await?;
    }
    let updates = ws.durable.outbox().await?;
    // Preserve edits made before delete/restore. Advancing lifecycle first would
    // make their older generation impossible to acknowledge or restore later.
    let mut sent = std::collections::HashSet::new();
    for op in directory_ops.iter().filter(|o| o.kind != "create" && !blocked.contains_key(&o.page_id)) {
        let generation = op.payload["generation"]
            .as_u64()
            .ok_or("invalid lifecycle generation")?;
        for update in updates
            .iter()
            .filter(|u| u.update.page_id == op.page_id && u.generation == generation)
        {
            if socket.is_some_and(|s| s.is_expired()) { return Ok(()); }
            send_one(ws, client, update).await?;
            sent.insert(update.update.op_id.clone());
        }
        if socket.is_some_and(|s| s.is_expired()) { return Ok(()); }
        let page = client
            .set_deleted(&op.op_id, &op.page_id, generation, op.kind == "delete")
            .await
            .map_err(super::err)?;
        ws.durable.acknowledge_directory(op.op_id.clone()).await?;
        directory(ws, page).await?;
    }
    for update in updates.iter().filter(|u| !sent.contains(&u.update.op_id) && !blocked.contains_key(&u.update.page_id)) {
        if socket.is_some_and(|s| s.is_expired()) { return Ok(()); }
        send_one(ws, client, update).await?;
    }
    Ok(())
}
const MAX_SUBSCRIPTIONS: usize = 8;
type PageVersions = HashMap<String, (u32, u64)>;
fn versions(entry: &Entry) -> (u32, u64) { (entry.epoch, entry.generation) }

/// Priority pages are live; bootstrap unseen pages once, then retain stable slots.
fn select_pages(entries: &[Entry], priority: &[String], subscribed: &PageVersions, completed: &PageVersions) -> Vec<Entry> {
    let live: Vec<_> = entries.iter().filter(|p| !p.deleted).collect();
    let mut seen = HashSet::new();
    let mut selected = Vec::new();
    let candidates = priority.iter().filter_map(|id| live.iter().copied().find(|p| &p.id == id))
        .chain(live.iter().copied().filter(|p| completed.get(&p.id) != Some(&versions(p))))
        .chain(live.iter().copied().filter(|p| subscribed.get(&p.id) == Some(&versions(p))))
        .chain(live.iter().copied());
    for page in candidates {
        if seen.insert(page.id.clone()) { selected.push(page.clone()); }
        if selected.len() == MAX_SUBSCRIPTIONS { break; }
    }
    selected
}
async fn wanted_pages(ws: &Workspace, handle: &Handle, subscribed: &PageVersions, completed: &PageVersions) -> Result<Vec<Entry>> {
    let mut priority = handle.requested.lock().map_err(super::err)?.clone().into_iter().collect::<Vec<_>>();
    let editor = ws.editor_state().await?;
    if let Some(active) = editor.active { priority.push(active); }
    let mut owned = editor.owned.into_iter().map(|p| (!p.has_surface, p.page_id)).collect::<Vec<_>>();
    owned.sort();
    priority.extend(owned.into_iter().map(|(_,id)|id));
    Ok(select_pages(&ws.durable.list().await?, &priority, subscribed, completed))
}
fn subscription(editor: &EditorState, page: &Entry, after: &sync::JournalWatermark) -> Result<sync::Subscription> {
    let vector=editor.vectors.iter().find(|p|p.page_id==page.id).map(|p|p.state_vector.clone()).unwrap_or_else(||vec![0]);
    Ok(sync::Subscription { page_id: page.id.clone(), epoch: page.epoch as u64, state_vector: vector, after:Some(after.clone()) })
}
fn subscription_changes(selected: &[Entry], subscribed: &PageVersions) -> (Vec<String>, Vec<Entry>) {
    let wanted: PageVersions = selected.iter().map(|p|(p.id.clone(),versions(p))).collect();
    let removed = subscribed.iter().filter(|(id,version)| wanted.get(*id) != Some(*version)).map(|(id,_)|id.clone()).collect::<Vec<_>>();
    let added = selected.iter().filter(|p| subscribed.get(&p.id) != Some(&versions(p))).cloned().collect();
    (removed, added)
}
async fn reconcile_subscriptions(ws: &Workspace, socket: &mut sync::WsSession, selected: &[Entry], subscribed: &mut PageVersions, prefixes: &AppliedPrefixes) -> Result<()> {
    let (removed, added) = subscription_changes(selected,subscribed);
    // Free slots before adding replacements, including same-ID epoch/generation changes.
    for id in removed {
        if socket.is_expired() { return Ok(()); }
        socket.unsubscribe(&id).await.map_err(super::err)?; subscribed.remove(&id);
    }
    if added.is_empty() { return Ok(()); }
    let editor = ws.editor_state().await?;
    for page in added {
        if socket.is_expired() { return Ok(()); }
        let after=prefixes.ready.get(&page.id).ok_or("missing applied journal prefix")?;
        socket.subscribe(&subscription(&editor,&page,after)?).await.map_err(super::err)?;
        subscribed.insert(page.id.clone(),versions(&page));
    }
    Ok(())
}
async fn incoming(
    ws: &Arc<Workspace>,
    event: sync::ServerEvent,
) -> Result<()> {
    match event {
        sync::ServerEvent::Directory(change) => directory(ws, change.page).await,
        sync::ServerEvent::Page(page) => directory(ws, page).await,
        sync::ServerEvent::Update {
            page_id,
            epoch,
            generation,
            op_id,
            update,
            ..
        } => {
            ws.remote(
                PendingUpdate {
                    op_id,
                    page_id,
                    epoch: u32::try_from(epoch).map_err(|_| "invalid epoch")?,
                    update,
                },
                generation,
            )
            .await
        }
        sync::ServerEvent::Snapshot(snapshot) => {
            let page = snapshot.page.clone();
            directory(ws, page.clone()).await?;
            let id = snapshot_op(&snapshot);
            ws.remote(
                PendingUpdate {
                    op_id: id,
                    page_id: page.id,
                    epoch: u32::try_from(page.epoch).map_err(|_| "invalid epoch")?,
                    update: snapshot.update,
                },
                page.generation,
            )
            .await
        }
        sync::ServerEvent::ResyncRequired { page, reason, .. } => {
            directory(ws, page).await?;
            Err(format!(
                "远端更新被隔离，已保留本机草稿；需要从已验证日志重新恢复：{reason}"
            ))
        }
        sync::ServerEvent::Ack(ack) => ws.durable.ack(ack.op_id).await,
        sync::ServerEvent::Hello { .. } | sync::ServerEvent::Pong => Ok(()),
    }
}
#[derive(Clone)]
struct PrefixProof {
    receipt: durability::IncomingReceipt,
    watermark: sync::JournalWatermark,
    // None proves the complete history. Some(N) proves only the suffix after N.
    after: Option<u64>,
}
#[derive(Default)]
struct AppliedPrefixes {
    ready: HashMap<String, sync::JournalWatermark>,
    pending: Vec<PrefixProof>,
    blocked: HashMap<String, (u64, u64)>,
}
fn same_fence(a: &sync::JournalWatermark, b: &sync::JournalWatermark) -> bool {
    a.space_id == b.space_id && a.page_id == b.page_id && a.epoch == b.epoch
        && a.generation == b.generation && a.quarantine_revision == b.quarantine_revision
}
fn snapshot_op(snapshot: &sync::Snapshot) -> String {
    format!("snapshot:{}:{}:{}",snapshot.page.id,snapshot.page.generation,storage::sha256(&snapshot.update))
}
impl AppliedPrefixes {
    fn forget(&mut self, page: &str) {
        self.ready.remove(page);self.pending.retain(|p|p.watermark.page_id!=page);
    }
    fn block(&mut self, page: &str, epoch: u64, generation: u64) { self.forget(page);self.blocked.insert(page.into(),(epoch,generation)); }
    fn prune(&mut self, space: &str, entries: &[Entry]) {
        let valid=|w:&sync::JournalWatermark|w.space_id==space && entries.iter().any(|p|p.id==w.page_id && !p.deleted && p.epoch as u64==w.epoch && p.generation==w.generation);
        self.ready.retain(|_,w|valid(w));self.pending.retain(|p|valid(&p.watermark));
        self.blocked.retain(|id,fence|entries.iter().any(|p|p.id==*id && !p.deleted && (p.epoch as u64,p.generation)==*fence));
    }
    fn pending_page(&self, page: &str) -> bool { self.pending.iter().any(|p|p.watermark.page_id==page) }
    fn observe(&mut self, proof: Option<PrefixProof>) {
        let Some(proof)=proof else{return};
        if self.blocked.contains_key(&proof.watermark.page_id) {return;}
        if proof.after.is_none() {self.pending.retain(|p|p.watermark.page_id!=proof.watermark.page_id);}
        // Losing a cache hint only makes the next journal resume conservative;
        // received text remains in the durable inbox. Never grow without bound.
        if self.pending.len()<4096 && !self.pending.iter().any(|p|p.receipt.op_id==proof.receipt.op_id && p.watermark==proof.watermark) {self.pending.push(proof);}
    }
    fn promote(&mut self, applied: &HashSet<String>) {
        self.pending.sort_by_key(|p|p.watermark.version);
        let mut kept=Vec::new();
        for proof in self.pending.drain(..) {
            if !applied.contains(&proof.receipt.op_id) {kept.push(proof);continue;}
            let old=self.ready.get(&proof.watermark.page_id);
            let compatible=old.is_none_or(|old|same_fence(old,&proof.watermark));
            let extends=match proof.after {None=>true,Some(after)=>old.is_some_and(|old|old.version>=after)};
            if compatible && extends {
                if old.is_none_or(|old|old.version<proof.watermark.version) {self.ready.insert(proof.watermark.page_id.clone(),proof.watermark);}
            } else {kept.push(proof);}
        }
        self.pending=kept;
    }
    async fn refresh(&mut self, ws: &Workspace) -> Result<()> {
        if self.pending.is_empty() {return Ok(());}
        let receipts=self.pending.iter().map(|p|p.receipt.clone()).collect();
        let applied=ws.durable.applied_incoming(receipts).await?;self.promote(&applied);Ok(())
    }
    fn proof(&self, space: &str, event: &sync::ServerEvent) -> Option<PrefixProof> {
        let (page,epoch,generation,version,op,after,q)=match event {
            sync::ServerEvent::Snapshot(s)=>{
                let after=if s.complete_journal {s.journal_after} else {Some(s.page.version.checked_sub(1)?)};
                let q=if s.complete_journal {s.quarantine_revision} else {self.ready.get(&s.page.id)?.quarantine_revision};
                (s.page.id.clone(),s.page.epoch,s.page.generation,s.page.version,snapshot_op(s),after,q)
            }
            sync::ServerEvent::Update{page_id,epoch,generation,version,op_id,..}=>{
                let old=self.ready.get(page_id)?;
                (page_id.clone(),*epoch,*generation,*version,op_id.clone(),Some(version.checked_sub(1)?),old.quarantine_revision)
            }
            _=>return None,
        };
        Some(PrefixProof {receipt:durability::IncomingReceipt {op_id:op,page_id:page.clone(),epoch:u32::try_from(epoch).ok()?,generation},watermark:sync::JournalWatermark {space_id:space.into(),page_id:page,epoch,generation,version,quarantine_revision:q},after})
    }
}
struct Bootstrap {
    page: Entry,
    space: String,
    server: String,
    task: oneshot::Receiver<std::result::Result<sync::Snapshot,sync::SyncError>>,
    abort: tokio::task::AbortHandle,
}
impl Bootstrap {
    fn new(page: Entry, space: String, server: String, handle: &Handle,
        future: impl std::future::Future<Output=std::result::Result<sync::Snapshot,sync::SyncError>> + Send + 'static) -> Self {
        let (send, task) = oneshot::channel();
        let child = tokio::spawn(async move { let _ = send.send(future.await); });
        let abort = child.abort_handle();
        let mut tasks = handle.control.tasks.lock().unwrap_or_else(|e| e.into_inner());
        tasks.bootstraps.retain(|t| !t.is_finished());
        if tasks.stopping { child.abort(); }
        tasks.bootstraps.push(child);
        Self { page, space, server, task, abort }
    }
}
impl Drop for Bootstrap {fn drop(&mut self){self.abort.abort();}}
fn recovery_required(error: &sync::SyncError) -> bool {
    matches!(error,sync::SyncError::Api{code,..} if code=="journal_changed" || code=="invalid_journal_cursor")
}

async fn command(ws: &Arc<Workspace>, client: &mut Option<sync::SyncClient>, command: Command) -> bool {
    match command {
        Command::Prepare(_, reply) => {
            let _ = reply.send(Err("此页尚未下载，请先连接同步服务".into()));
            false
        }
        Command::Pair(server, invitation, reply) => {
            if client.as_ref().is_some_and(|c| {
                c.identity().space_id != invitation.space_id
                    || c.identity().server_url.trim_end_matches('/') != server.trim_end_matches('/')
            }) {
                let _=reply.send(Err("当前 Vault 已连接另一写作空间，请在独立 Vault 中连接新空间，避免跨账号混合正文".into()));
                return false;
            }
            let outcome = async {
                ws.current().await?;
                let identity = ws.auth_pair(&server, &invitation).await?;
                ws.current().await?;
                *client = Some(sync::SyncClient::new(identity, ws.token_provider()).map_err(super::err)?);
                Ok(())
            }.await;
            let success = outcome.is_ok();
            let _ = reply.send(outcome);
            success
        }
        Command::Invite(reply) => {
            let result = match client.as_mut() {
                Some(c) => c.invite().await.map_err(super::err),
                None => Err("请先连接同步服务".into()),
            };
            let _ = reply.send(result);
            false
        }
    }
}
const RECOVERY_MESSAGE: &str = "远端日志已隔离或重写，已保留本机草稿；请从恢复入口建立已验证的新纸页";
#[derive(Default)]
struct Preparations {
    waiting: HashMap<String, Vec<oneshot::Sender<Result<()>>>>,
}
impl Preparations {
    fn add(&mut self, page: String, reply: oneshot::Sender<Result<()>>) {
        self.waiting.values_mut().for_each(|v|v.retain(|r|!r.is_closed()));
        self.waiting.retain(|_,v|!v.is_empty());
        if !reply.is_closed() { self.waiting.entry(page).or_default().push(reply); }
    }
    fn finish(&mut self, page: &str, result: Result<()>) {
        for reply in self.waiting.remove(page).unwrap_or_default() {let _=reply.send(result.clone());}
    }
    fn resolve(&mut self, prefixes: &AppliedPrefixes, entries: &[Entry]) {
        for page in self.waiting.keys().cloned().collect::<Vec<_>>() {
            if prefixes.blocked.contains_key(&page) {self.finish(&page,Err(RECOVERY_MESSAGE.into()));}
            else if !entries.iter().any(|p|p.id==page && !p.deleted) {self.finish(&page,Err("纸页不存在或已删除".into()));}
            else if prefixes.ready.contains_key(&page) {self.finish(&page,Ok(()));}
        }
    }
}
fn queue_preparation(preparations: &mut Preparations, bootstrap: &mut Option<Bootstrap>, page: String, reply: oneshot::Sender<Result<()>>) {
    if reply.is_closed() {return;}
    // Foreground work joins its existing task. Only an unrelated unobserved
    // background transfer is cancelled; at most one HTTP transfer can exist.
    if bootstrap.as_ref().is_some_and(|b|b.page.id!=page && !preparations.waiting.get(&b.page.id).is_some_and(|v|v.iter().any(|r|!r.is_closed()))) {*bootstrap=None;}
    preparations.add(page,reply);
}
fn bootstrap_matches(bootstrap: &Bootstrap, credentials: &Identity, entries: &[Entry]) -> bool {
    bootstrap.space==credentials.space_id && bootstrap.server==credentials.server_url
        && entries.iter().any(|p|p.id==bootstrap.page.id && !p.deleted && versions(p)==versions(&bootstrap.page))
}
async fn accept_event(ws: &Arc<Workspace>, space: &str, prefixes: &mut AppliedPrefixes, event: sync::ServerEvent) -> Result<()> {
    ws.current().await?;
    if let sync::ServerEvent::ResyncRequired{page,..}=&event {
        prefixes.block(&page.id,page.epoch,page.generation);
    }
    if let sync::ServerEvent::Snapshot(snapshot)=&event {
        if prefixes.blocked.contains_key(&snapshot.page.id) {return Err(RECOVERY_MESSAGE.into());}
        if snapshot.complete_journal {
            let old=prefixes.ready.get(&snapshot.page.id);
            let changed=old.is_some_and(|p|p.quarantine_revision!=snapshot.quarantine_revision);
            // With no in-process proof, an already persisted document may
            // contain quarantined operations. Never merge a cleaned full into it.
            let unproven=old.is_none() && snapshot.quarantine_revision>0
                && ws.durable.has_document(snapshot.page.id.clone()).await?;
            if changed || unproven {prefixes.block(&snapshot.page.id,snapshot.page.epoch,snapshot.page.generation);return Err(RECOVERY_MESSAGE.into());}
        }
    }
    if let sync::ServerEvent::Update{page_id,..}=&event {
        if prefixes.blocked.contains_key(page_id) {return Err(RECOVERY_MESSAGE.into());}
    }
    let proof=prefixes.proof(space,&event);
    incoming(ws,event).await?;
    prefixes.observe(proof);
    Ok(())
}
async fn prepare_bootstrap(ws:&Workspace,client:&sync::SyncClient,handle:&Handle,prefixes:&mut AppliedPrefixes,preparations:&mut Preparations,bootstrap:&mut Option<Bootstrap>,subscribed:&PageVersions)->Result<Vec<Entry>> {
    ws.current().await?;
    let entries=ws.durable.list().await?;
    prefixes.prune(&client.identity().space_id,&entries);
    prefixes.refresh(ws).await?;
    preparations.resolve(prefixes,&entries);
    if bootstrap.as_ref().is_some_and(|b|!bootstrap_matches(b,client.identity(),&entries)) {*bootstrap=None;}
    let completed=prefixes.ready.iter().map(|(id,w)|(id.clone(),(w.epoch as u32,w.generation))).collect();
    let selected=wanted_pages(ws,handle,subscribed,&completed).await?;
    if bootstrap.is_none() {
        if let Some(page)=selected.iter().find(|p|!prefixes.ready.contains_key(&p.id) && !prefixes.pending_page(&p.id) && !prefixes.blocked.contains_key(&p.id)) {
            let credential=client.identity().clone();
            let mut download_client=client.fork();
            let space=credential.space_id.clone();let server=credential.server_url.clone();let page=page.clone();let target=page.clone();
            *bootstrap=Some(Bootstrap::new(page,space,server,handle,async move {
                tokio::time::timeout(std::time::Duration::from_secs(360),download_client.snapshot(&target.id,target.epoch as u64,&[0])).await.map_err(|_|sync::SyncError::Timeout)?
            }));
        }
    }
    Ok(selected.into_iter().filter(|p|prefixes.ready.contains_key(&p.id) && !prefixes.blocked.contains_key(&p.id)).collect())
}

const CREDENTIAL_READING: &str = "正在读取系统钥匙串，文字保存在本机";
const CREDENTIAL_WAITING: &str = "正在等待系统钥匙串授权，请查看系统授权窗口；文字保存在本机";

// A blocking Keychain read may be waiting for system authorization. A status
// deadline must not cancel/restart it or create additional authorization prompts.
async fn credential_read_with_status<F, N, S, T>(read: F, delay: std::time::Duration, mut waiting: N) -> T
where
    F: std::future::Future<Output = T>,
    N: FnMut() -> S,
    S: std::future::Future<Output = ()>,
{
    tokio::pin!(read);
    tokio::select! {
        biased;
        result = &mut read => result,
        _ = tokio::time::sleep(delay) => { waiting().await; read.await }
    }
}
fn stored_client(stored: Result<Option<Identity>>, provider: Arc<dyn sync::TokenProvider>) -> Result<Option<sync::SyncClient>> {
    stored?.map(|identity| sync::SyncClient::new(identity, provider)).transpose().map_err(super::err)
}

async fn run(ws: Arc<Workspace>, handle: Handle, mut receiver: mpsc::Receiver<Command>) {
    if ws.current().await.is_err() { return; }
    publish_status(&ws,&handle,false,CREDENTIAL_READING).await;
    let read = ws.auth_load();
    let stored = credential_read_with_status(read,std::time::Duration::from_secs(8),|| {
        publish_status(&ws,&handle,false,CREDENTIAL_WAITING)
    }).await;
    let mut client=match stored_client(stored, ws.token_provider()) {
        Ok(Some(client))=>Some(client),
        Ok(None)=>{publish_status(&ws,&handle,false,"尚未连接同步服务").await;None},
        Err(error)=>{publish_status(&ws,&handle,false,&format!("无法恢复同步连接：{error}；文字保存在本机")).await;None}
    };
    let mut retry=std::time::Duration::from_secs(1);
    let mut deferred_command=None;
    let mut prefixes=AppliedPrefixes::default();
    let mut preparations=Preparations::default();
    let mut bootstrap:Option<Bootstrap>=None;
    let mut namespace=None;
    let mut blocked_space=false;
    loop {
        if ws.current().await.is_err() { return; }
        if let Some(cmd)=deferred_command.take() {
            match cmd {
                Command::Prepare(page,reply) if client.is_some()=>queue_preparation(&mut preparations,&mut bootstrap,page,reply),
                cmd=>{if command(&ws,&mut client,cmd).await {publish_status(&ws,&handle,false,"配对完成，正在连接同步服务").await;}}
            }
        }
        if client.is_none() {
            let Some(cmd)=receiver.recv().await else{return};
            if command(&ws,&mut client,cmd).await {publish_status(&ws,&handle,false,"配对完成，正在连接同步服务").await;}
            continue;
        }
        let credentials=client.as_ref().unwrap().identity();
        let next_namespace=(credentials.server_url.clone(),credentials.space_id.clone());
        if namespace.as_ref()!=Some(&next_namespace) {
            bootstrap=None;prefixes=AppliedPrefixes::default();blocked_space=false;namespace=Some(next_namespace);
        }
        if blocked_space {
            for page in preparations.waiting.keys().cloned().collect::<Vec<_>>() {preparations.finish(&page,Err(RECOVERY_MESSAGE.into()));}
            publish_status(&ws,&handle,false,RECOVERY_MESSAGE).await;
            let Some(cmd)=receiver.recv().await else{return};
            match cmd {Command::Prepare(_,reply)=>{let _=reply.send(Err(RECOVERY_MESSAGE.into()));},cmd=>{command(&ws,&mut client,cmd).await;}}
            continue;
        }
        let result=async {
            ws.current().await?;
            let c=client.as_mut().unwrap();
            send_pending(&ws,c,None,&prefixes.blocked).await?;pull_directory(&ws,c).await?;
            let selected=prepare_bootstrap(&ws,c,&handle,&mut prefixes,&mut preparations,&mut bootstrap,&PageVersions::new()).await?;
            let mut initial=Vec::with_capacity(selected.len());
            if !selected.is_empty() {
                let editor=ws.editor_state().await?;
                for page in &selected { initial.push(subscription(&editor,page,&prefixes.ready[&page.id])?); }
            }
            let mut subscribed:PageVersions=selected.iter().map(|p|(p.id.clone(),versions(p))).collect();
            let mut socket=c.reconnect(&initial).await.map_err(super::err)?;
            publish_status(&ws,&handle,true,if prefixes.blocked.is_empty(){""}else{RECOVERY_MESSAGE}).await;retry=std::time::Duration::from_secs(1);
            let mut tick=tokio::time::interval(std::time::Duration::from_millis(100));tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut heartbeat=tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                let active=match socket.phase().map_err(super::err)? {
                    sync::SocketPhase::Active=>true,
                    sync::SocketPhase::Draining=>{publish_status(&ws,&handle,true,"正在接收完整纸页，新的修改已保存在本机").await;false},
                    sync::SocketPhase::Refresh=>{publish_status(&ws,&handle,false,"正在更新同步连接").await;let _=tokio::time::timeout(std::time::Duration::from_secs(5),socket.close()).await;return Ok(())}
                };
                tokio::select! {
                    event=socket.recv()=>{
                        let event=match event {Ok(event)=>event,Err(error)=>{
                            if recovery_required(&error) {blocked_space=true;bootstrap=None;}
                            return Err(if blocked_space {RECOVERY_MESSAGE.into()} else {super::err(error)});
                        }};
                        let space=client.as_ref().unwrap().identity().space_id.clone();
                        accept_event(&ws,&space,&mut prefixes,event).await?;
                    },
                    outcome=async {match bootstrap.as_mut(){Some(b)=>(&mut b.task).await,None=>std::future::pending().await}}=>{
                        let finished=bootstrap.take().unwrap();
                        ws.current().await?;
                        let entries=ws.durable.list().await?;
                        if !bootstrap_matches(&finished,client.as_ref().unwrap().identity(),&entries) {
                            preparations.finish(&finished.page.id,Err("纸页或写作空间已改变，旧同步结果已丢弃".into()));continue;
                        }
                        let outcome=match outcome {
                            Ok(Ok(snapshot))=>{
                                if snapshot.page.id!=finished.page.id || snapshot.page.epoch!=finished.page.epoch as u64 || snapshot.page.generation!=finished.page.generation || snapshot.page.deleted!=0 {
                                    Err("下载期间纸页生命周期已改变，旧同步结果已丢弃".into())
                                } else {accept_event(&ws,&finished.space,&mut prefixes,sync::ServerEvent::Snapshot(snapshot)).await}
                            },
                            Ok(Err(error))=>{if recovery_required(&error){prefixes.block(&finished.page.id,finished.page.epoch as u64,finished.page.generation);}Err(if recovery_required(&error){RECOVERY_MESSAGE.into()}else{super::err(error)})},
                            Err(error)=>Err(super::err(error)),
                        };
                        if let Err(error)=outcome {
                            preparations.finish(&finished.page.id,Err(error.clone()));return Err(error);
                        }
                        prefixes.refresh(&ws).await?;
                        preparations.resolve(&prefixes,&entries);
                    },
                    _=tick.tick()=>{
                        if socket.phase().map_err(super::err)?!=sync::SocketPhase::Active {continue;}
                        send_pending(&ws,client.as_mut().unwrap(),Some(&socket),&prefixes.blocked).await?;
                        if socket.phase().map_err(super::err)?!=sync::SocketPhase::Active {continue;}
                        let selected=prepare_bootstrap(&ws,client.as_ref().unwrap(),&handle,&mut prefixes,&mut preparations,&mut bootstrap,&subscribed).await?;
                        reconcile_subscriptions(&ws,&mut socket,&selected,&mut subscribed,&prefixes).await?;
                    },
                    _=heartbeat.tick(),if active=>{
                        if socket.phase().map_err(super::err)?!=sync::SocketPhase::Active {continue;}
                        socket.ping().await.map_err(super::err)?;pull_directory(&ws,client.as_mut().unwrap()).await?;
                    },
                    command_input=receiver.recv(),if active=>{
                        let Some(cmd)=command_input else{return Ok::<(),String>(())};
                        if socket.phase().map_err(super::err)?!=sync::SocketPhase::Active {deferred_command=Some(cmd);continue;}
                        if let Command::Prepare(page,reply)=cmd {
                            queue_preparation(&mut preparations,&mut bootstrap,page,reply);continue;
                        }
                        if command(&ws,&mut client,cmd).await {
                            publish_status(&ws,&handle,false,"配对完成，正在连接同步服务").await;
                            let _=tokio::time::timeout(std::time::Duration::from_secs(5),socket.close()).await;return Ok(())
                        }
                    },
                }
            }
        }.await;
        if result.is_ok(){continue;}
        if let Err(error)=result {publish_status(&ws,&handle,false,&format!("离线保存中：{error}")).await;}
        if deferred_command.is_some(){continue;}
        tokio::select!{_=tokio::time::sleep(retry)=>{},cmd=receiver.recv()=>{
            let Some(cmd)=cmd else{return};
            match cmd {Command::Prepare(page,reply)=>queue_preparation(&mut preparations,&mut bootstrap,page,reply),cmd=>{if command(&ws,&mut client,cmd).await {publish_status(&ws,&handle,false,"配对完成，正在连接同步服务").await;}}}
        }}
        retry=(retry*2).min(std::time::Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity(server: &str) -> Identity {
        Identity { server_url: server.into(), space_id: uuid::Uuid::new_v4().to_string(), device_id: uuid::Uuid::new_v4().to_string() }
    }
    struct NoToken;
    impl sync::TokenProvider for NoToken {
        fn token(&self, _: Identity) -> std::pin::Pin<Box<dyn std::future::Future<Output=std::result::Result<sync::AccessToken,sync::SyncError>> + Send>> {
            Box::pin(async { Err(sync::SyncError::Transport) })
        }
    }


    #[tokio::test]
    async fn delayed_keychain_read_reports_wait_once_and_keeps_the_same_task() {
        let (send, receive) = oneshot::channel();
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let notices = std::sync::atomic::AtomicUsize::new(0);
        let read = async {
            reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            receive.await.unwrap()
        };
        let wait = credential_read_with_status(read,std::time::Duration::from_millis(5),|| async {
            notices.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
        });
        tokio::pin!(wait);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(25),&mut wait).await.is_err());
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst),1);
        assert_eq!(notices.load(std::sync::atomic::Ordering::SeqCst),1);
        send.send("original credential result").unwrap();
        assert_eq!(wait.await,"original credential result");
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst),1);
        assert_eq!(notices.load(std::sync::atomic::Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn immediate_keychain_result_does_not_report_an_authorization_wait() {
        for result in [Ok(Some(1)),Ok(None),Err("read denied")] {
            let expected=result;
            let actual=credential_read_with_status(async {result},std::time::Duration::from_secs(1),|| async {
                panic!("completed read must not report authorization wait");
            }).await;
            assert_eq!(actual,expected);
        }
    }
    #[test]
    fn stored_credentials_keep_absence_read_failure_and_client_failure_distinct() {
        assert!(stored_client(Ok(None), Arc::new(NoToken)).unwrap().is_none());
        assert!(matches!(stored_client(Err("Keychain read failed (-25293)".into()), Arc::new(NoToken)),Err(error) if error.contains("-25293")));
        let credential=identity("http://insecure.example");
        assert!(matches!(stored_client(Ok(Some(credential)), Arc::new(NoToken)),Err(error) if error.contains("HTTPS")));
    }

    fn proof(version:u64,after:Option<u64>)->PrefixProof {
        PrefixProof {receipt:durability::IncomingReceipt {op_id:format!("op-{version}"),page_id:"page-0".into(),epoch:1,generation:0},watermark:sync::JournalWatermark {space_id:"space".into(),page_id:"page-0".into(),epoch:1,generation:0,version,quarantine_revision:0},after}
    }
    #[test]
    fn applied_prefix_waits_for_commit_and_does_not_jump_a_gap() {
        let mut prefixes=AppliedPrefixes::default();
        prefixes.observe(Some(proof(10,None)));
        prefixes.promote(&HashSet::new());
        assert!(prefixes.ready.is_empty());assert!(prefixes.pending_page("page-0"));
        prefixes.promote(&HashSet::from(["op-10".into()]));
        assert_eq!(prefixes.ready["page-0"].version,10);
        prefixes.observe(Some(proof(12,Some(11))));
        prefixes.promote(&HashSet::from(["op-12".into()]));
        assert_eq!(prefixes.ready["page-0"].version,10);
        prefixes.observe(Some(proof(11,Some(10))));
        prefixes.promote(&HashSet::from(["op-11".into(),"op-12".into()]));
        assert_eq!(prefixes.ready["page-0"].version,12);assert!(prefixes.pending.is_empty());
        prefixes.observe(Some(proof(11,Some(10))));prefixes.promote(&HashSet::from(["op-11".into()]));
        assert_eq!(prefixes.ready["page-0"].version,12);
    }
    #[test]
    fn complete_suffix_requires_its_applied_baseline_and_fence() {
        let mut prefixes=AppliedPrefixes::default();
        prefixes.observe(Some(proof(30,Some(10))));prefixes.promote(&HashSet::from(["op-30".into()]));
        assert!(prefixes.ready.is_empty(),"suffix must not masquerade as complete history");
        prefixes.observe(Some(proof(10,None)));prefixes.promote(&HashSet::from(["op-10".into()]));
        for change in 0..4 {
            let mut foreign=proof(30,Some(10));
            match change {0=>foreign.watermark.space_id="other".into(),1=>foreign.watermark.epoch=2,2=>foreign.watermark.generation=1,_=>foreign.watermark.quarantine_revision=1}
            prefixes.observe(Some(foreign));prefixes.promote(&HashSet::from(["op-30".into()]));
            assert_eq!(prefixes.ready["page-0"].version,10);
        }
        prefixes.observe(Some(proof(30,Some(10))));prefixes.promote(&HashSet::from(["op-30".into()]));
        assert_eq!(prefixes.ready["page-0"].version,30);
    }
    #[test]
    fn lifecycle_and_space_changes_invalidate_cached_prefixes() {
        let mut prefixes=AppliedPrefixes::default();prefixes.observe(Some(proof(10,None)));
        prefixes.promote(&HashSet::from(["op-10".into()]));
        prefixes.prune("other",&pages(1));assert!(prefixes.ready.is_empty());
        prefixes.observe(Some(proof(11,Some(10))));
        let mut entries=pages(1);entries[0].generation=1;
        prefixes.prune("space",&entries);assert!(prefixes.pending.is_empty());
        prefixes.block("page-0",1,1);prefixes.prune("space",&entries);assert!(prefixes.blocked.contains_key("page-0"));
        entries[0].generation=2;prefixes.prune("space",&entries);assert!(prefixes.blocked.is_empty());
    }
    #[tokio::test]
    async fn same_page_preparations_share_pending_completion_without_early_success() {
        let mut preparations=Preparations::default();let mut prefixes=AppliedPrefixes::default();
        let (a,mut ar)=oneshot::channel();let (b,mut br)=oneshot::channel();
        let mut bootstrap=Some(Bootstrap::new(pages(1).remove(0),"space".into(),"https://sync.example.com".into(),&handle(),std::future::pending()));
        queue_preparation(&mut preparations,&mut bootstrap,"page-0".into(),a);
        queue_preparation(&mut preparations,&mut bootstrap,"page-0".into(),b);
        assert_eq!(bootstrap.as_ref().unwrap().page.id,"page-0");
        assert_eq!(preparations.waiting.len(),1);
        prefixes.observe(Some(proof(10,None)));preparations.resolve(&prefixes,&pages(1));
        assert!(ar.try_recv().is_err());assert!(br.try_recv().is_err());
        prefixes.promote(&HashSet::from(["op-10".into()]));preparations.resolve(&prefixes,&pages(1));
        ar.await.unwrap().unwrap();br.await.unwrap().unwrap();assert!(preparations.waiting.is_empty());
        let (other,_receive)=oneshot::channel();
        queue_preparation(&mut preparations,&mut bootstrap,"page-1".into(),other);
        assert!(bootstrap.is_none(),"unrelated unobserved transfer must yield to a foreground page");
    }
    #[tokio::test]
    async fn completed_bootstrap_must_still_match_space_server_and_page_lifecycle() {
        let entries=pages(1);
        let credential=identity("https://sync.example.com/");
        let b=Bootstrap::new(entries[0].clone(),credential.space_id.clone(),credential.server_url.clone(),&handle(),std::future::pending());
        assert!(bootstrap_matches(&b,&credential,&entries));
        let mut altered=credential.clone();altered.space_id=uuid::Uuid::new_v4().to_string();assert!(!bootstrap_matches(&b,&altered,&entries));
        let mut altered=credential.clone();altered.server_url="https://different.example.com".into();assert!(!bootstrap_matches(&b,&altered,&entries));
        let mut changed=entries.clone();changed[0].generation+=1;assert!(!bootstrap_matches(&b,&credential,&changed));
        let mut changed=entries.clone();changed[0].epoch+=1;assert!(!bootstrap_matches(&b,&credential,&changed));
        let mut changed=entries.clone();changed[0].deleted=true;assert!(!bootstrap_matches(&b,&credential,&changed));
    }
    #[test]
    fn quarantine_errors_require_recovery_including_unattributed_ws_errors() {
        for status in [0,409] {assert!(recovery_required(&sync::SyncError::Api{status,code:"journal_changed".into()}));}
        assert!(recovery_required(&sync::SyncError::Api{status:409,code:"invalid_journal_cursor".into()}));
        assert!(!recovery_required(&sync::SyncError::Timeout));
    }

    fn handle() -> Handle {
        let (sender, _) = mpsc::channel(1);
        Handle { sender, control:Arc::new(TaskControl::default()), requested: Arc::new(Mutex::new(None)), status: Arc::new(Mutex::new(json!({"connected":false,"message":"尚未连接同步服务"}))) }
    }

    fn pages(count: usize) -> Vec<Entry> {
        (0..count).map(|i|Entry { id:format!("page-{i}"), epoch:1, generation:0, deleted:false, local_date:None,sequence:None,after_id:None,registered:true }).collect()
    }
    #[test]
    fn twelve_pages_fit_the_limit_and_prioritize_target_active_and_owner() {
        let entries=pages(12);
        let selected=select_pages(&entries,&["page-11".into(),"page-10".into(),"page-9".into()],&PageVersions::new(),&PageVersions::new());
        assert_eq!(selected.len(),8);
        assert_eq!(selected.iter().take(3).map(|p|p.id.as_str()).collect::<Vec<_>>(),vec!["page-11","page-10","page-9"]);
        let mut completed=PageVersions::new();
        let mut subscribed=PageVersions::new();
        for _ in 0..3 {
            let selected=select_pages(&entries,&["page-11".into()],&subscribed,&completed);
            assert!(selected.len()<=8);
            subscribed=selected.iter().map(|p|(p.id.clone(),versions(p))).collect();
            completed.extend(subscribed.clone());
        }
        assert_eq!(completed.len(),12,"background slots must bootstrap every page");
        let stable=select_pages(&entries,&["page-11".into()],&subscribed,&completed);
        assert!(subscription_changes(&stable,&subscribed).0.is_empty());
        assert!(subscription_changes(&stable,&subscribed).1.is_empty());
    }
    #[test]
    fn subscription_swap_frees_slots_and_replaces_lifecycle_versions() {
        let mut entries=pages(12);
        let subscribed:PageVersions=entries[..8].iter().map(|p|(p.id.clone(),versions(p))).collect();
        let completed=subscribed.clone();
        entries[0].deleted=true;
        entries[1].generation=2;
        let selected=select_pages(&entries,&["page-11".into(),"page-1".into()],&subscribed,&completed);
        let (removed,added)=subscription_changes(&selected,&subscribed);
        assert!(removed.contains(&"page-0".into()));
        assert!(removed.contains(&"page-1".into()));
        assert!(added.iter().any(|p|p.id=="page-1" && p.generation==2));
        let mut live=subscribed;
        for id in removed {live.remove(&id);}
        for page in added {live.insert(page.id.clone(),versions(&page));assert!(live.len()<=8);}
        assert_eq!(live.len(),selected.len());
    }
    #[tokio::test]
    async fn first_snapshot_waits_for_ready_and_propagates_failure_without_connection_claim() {
        let (sender,mut receiver)=mpsc::channel(2);
        let handle=Handle {sender,control:Arc::new(TaskControl::default()),requested:Arc::new(Mutex::new(None)),status:Arc::new(Mutex::new(json!({"connected":false,"message":""})))};
        let task=tokio::spawn({let handle=handle.clone();async move{handle.prepare_page("target".into()).await}});
        let Some(Command::Prepare(page,reply))=receiver.recv().await else{panic!("missing prepare request")};
        assert_eq!(page,"target");assert!(!task.is_finished());
        assert_eq!(handle.requested.lock().unwrap().as_deref(),Some("target"));
        reply.send(Ok(())).unwrap();task.await.unwrap().unwrap();
        assert!(handle.requested.lock().unwrap().is_none());
        let task=tokio::spawn({let handle=handle.clone();async move{handle.prepare_page("missing".into()).await}});
        let Some(Command::Prepare(_,reply))=receiver.recv().await else{panic!("missing request")};
        reply.send(Err("network unavailable".into())).unwrap();
        assert_eq!(task.await.unwrap().unwrap_err(),"network unavailable");
        assert!(handle.requested.lock().unwrap().is_none());
        assert_eq!(handle.status()["connected"],false);
    }

    #[tokio::test]
    async fn first_snapshot_timeout_clears_priority_and_cannot_claim_a_ready_page() {
        let (sender,mut receiver)=mpsc::channel(1);
        let handle=Handle {sender,control:Arc::new(TaskControl::default()),requested:Arc::new(Mutex::new(None)),status:Arc::new(Mutex::new(json!({"connected":false,"message":""})))};
        let task=tokio::spawn({let handle=handle.clone();async move{handle.prepare_page_for("target".into(),std::time::Duration::from_millis(10)).await}});
        let Some(Command::Prepare(_,reply))=receiver.recv().await else{panic!("missing request")};
        assert!(task.await.unwrap().unwrap_err().contains("同步超时"));
        assert!(reply.is_closed());
        assert!(handle.requested.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn shutdown_joins_blocked_runner_and_bootstrap_then_releases_the_database_owner() {
        use crate::network::HostBridge;
        use std::{future::Future, pin::Pin, sync::atomic::{AtomicUsize, Ordering}};
        struct PendingHost(Arc<AtomicUsize>);
        impl HostBridge for PendingHost {
            fn call(&self, method: &'static str, _: Value) -> Pin<Box<dyn Future<Output=Result<Value>>+Send>> {
                let calls=self.0.clone();
                Box::pin(async move {
                    match method {
                        "current"=>Ok(json!({"current":true})),
                        "status"=>Ok(Value::Null),
                        "auth_load"=>{calls.fetch_add(1,Ordering::SeqCst);std::future::pending().await},
                        _=>panic!("unexpected callback"),
                    }
                })
            }
        }
        let temp=tempfile::tempdir().unwrap();let database=temp.path().join("shutdown.sqlite3");
        let calls=Arc::new(AtomicUsize::new(0));
        let ws=Arc::new(Workspace {root:temp.path().into(),durable:durability::Durability::open(temp.path().into(),database.clone(), |_| {}).await.unwrap(),bridge:Arc::new(PendingHost(calls.clone()))});
        let weak=Arc::downgrade(&ws);let handle=start(ws.clone());
        let child_ws=ws.clone();
        let bootstrap=Bootstrap::new(pages(1).remove(0),"space".into(),"https://sync.example.com/".into(),&handle,async move {
            let _owner=child_ws;
            std::future::pending().await
        });
        drop(ws);
        tokio::time::timeout(std::time::Duration::from_secs(1),async {while calls.load(Ordering::SeqCst)==0 {tokio::task::yield_now().await;}}).await.unwrap();
        handle.stop();
        let abandoned=tokio::spawn({let h=handle.clone();async move {h.shutdown().await}});abandoned.abort();
        tokio::time::timeout(std::time::Duration::from_secs(2),async {
            let (a,b)=tokio::join!(handle.shutdown(),handle.shutdown());a.unwrap();b.unwrap();
        }).await.unwrap();
        assert!(weak.upgrade().is_none(),"network retained its Workspace/Durability after shutdown");
        assert!(bootstrap.abort.is_finished());
        let reopened=durability::Durability::open(temp.path().into(),database, |_| {}).await.expect("writer lock remained held after network shutdown");
        reopened.flush().await.unwrap();
    }

    #[test]
    fn connection_changes_publish_once_and_failure_becomes_offline() {
        let handle = handle();
        let mut events = Vec::new();
        for (connected, message) in [
            (false, "尚未连接同步服务"),
            (true, ""), (true, ""),
            (false, "离线保存中：连接关闭"), (false, "离线保存中：连接关闭"),
            (true, ""),
        ] {
            if status(&handle, connected, message) {
                // This is the publication boundary: reading the state cannot
                // deadlock on the mutation lock and duplicate ticks don't emit.
                assert!(handle.status.try_lock().is_ok());
                events.push(handle.status());
            }
        }
        assert_eq!(events, vec![
            json!({"connected":true,"message":""}),
            json!({"connected":false,"message":"离线保存中：连接关闭"}),
            json!({"connected":true,"message":""}),
        ]);
    }

    #[test]
    fn offline_reason_changes_are_visible_without_claiming_connection() {
        let handle = handle();
        assert!(!handle.status()["connected"].as_bool().unwrap());
        assert!(status(&handle, false, "无法读取同步凭据，文字保存在本机"));
        assert_eq!(handle.status()["connected"], false);
        assert!(!status(&handle, false, "无法读取同步凭据，文字保存在本机"));
        assert!(status(&handle, false, "离线保存中：网络不可用"));
        assert_eq!(handle.status()["message"], "离线保存中：网络不可用");
    }
}
