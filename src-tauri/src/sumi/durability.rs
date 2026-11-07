//! One owner thread for SQLite, CRDT persistence and recoverable Markdown projection.
//! UI callers enqueue updates; a Saved event is emitted only after SQLite commit.
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use uuid::Uuid;
use write_core::{
    catalog::{self, DirectoryOperation, Entry},
    projection::{self, Baseline},
    storage::{self, FilePair, PendingUpdate, Store},
    Document,
};

type Result<T> = std::result::Result<T, String>;
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn db(e: rusqlite::Error) -> write_core::Error {
    write_core::Error::Invalid(format!("durability: {e}"))
}
fn sql_u64(value: u64) -> write_core::Result<i64> {
    i64::try_from(value)
        .map_err(|_| write_core::Error::Invalid("SQLite integer out of range".into()))
}
fn read_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(e),
        )
    })
}
fn client_id() -> u64 {
    Uuid::new_v4().as_u128() as u32 as u64
}

#[derive(Clone)]
pub struct Loaded {
    pub entry: Entry,
    pub full_state: Vec<u8>,
    pub revision: u64,
    pub raw_markdown: String,
    pub frontmatter: serde_yaml::Mapping,
    pub sidecar: storage::Sidecar,
}
pub struct Create {
    pub page_id: String,
    pub epoch: u32,
    pub full_state: Vec<u8>,
    pub revision: u64,
    pub after_id: Option<String>,
    pub first_write_date: Option<String>,
    pub frontmatter: Option<serde_yaml::Mapping>,
    /// Optional existing validated file pair, to preserve extension metadata on import.
    pub preserved_pair: Option<FilePair>,
}
#[derive(Clone)]
pub struct LocalEdit {
    pub page_id: String,
    pub epoch: u32,
    pub generation: u64,
    pub revision: u64,
    pub op_id: String,
    pub update: Vec<u8>,
    pub first_write_date: Option<String>,
}
#[derive(Clone)]
pub struct Outgoing {
    pub update: PendingUpdate,
    pub generation: u64,
    pub first_write_date: Option<String>,
}
#[derive(Clone)]
pub struct PublishedBaseline {
    pub filename: String,
    pub pair: FilePair,
    pub full_state: Vec<u8>,
    pub revision: u64,
    pub hashes: Baseline,
}
#[derive(Clone, Debug, serde::Serialize)]
pub struct ProjectionIdentity {
    pub path: String,
    pub sha256: String,
}
#[derive(Clone, Debug)]
pub enum DurableEvent {
    Committed {
        page_id: String,
        revision: u64,
    },
    Saved {
        page_id: String,
        revision: u64,
        projected: bool,
        projection_error: Option<String>,
        raw_markdown: String,
        projection_identity: Option<ProjectionIdentity>,
    },
    Failed {
        page_id: String,
        revision: u64,
        error: String,
    },
}
#[derive(Clone)]
pub struct RecordedIncoming {
    pub update: PendingUpdate,
    pub generation: u64,
}
struct Queued {
    edit: LocalEdit,
    remote: bool,
    reply: Option<oneshot::Sender<Result<Loaded>>>,
    applied: bool,
    imported: Option<FilePair>,
}
type Job = Box<dyn FnOnce(&mut Worker) + Send>;
#[derive(Clone)]
pub struct Durability {
    sender: mpsc::Sender<Job>,
}
impl Durability {
    pub async fn open(
        vault: PathBuf,
        database: PathBuf,
        notify: impl Fn(DurableEvent) + Send + Sync + 'static,
    ) -> Result<Self> {
        let (sender, receiver) = mpsc::channel::<Job>();
        let (ready, opened) = oneshot::channel();
        std::thread::Builder::new()
            .name("sumi-durability".into())
            .spawn(move || {
                let mut worker = match Worker::open(vault, database, Arc::new(notify)) {
                    Ok(worker) => {
                        let _ = ready.send(Ok(()));
                        worker
                    }
                    Err(e) => {
                        let _ = ready.send(Err(e));
                        return;
                    }
                };
                loop {
                    match receiver.recv_timeout(Duration::from_millis(250)) {
                        Ok(job) => job(&mut worker),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            let _ = worker.checkpoint_dirty();
                            break;
                        }
                    }
                    if worker.checkpoint_due() {
                        if let Err(error) = worker.checkpoint_dirty() {
                            worker.report_failure(error);
                            worker.dirty_since = Some(Instant::now());
                            worker.last_edit = Instant::now();
                        }
                    }
                }
            })
            .map_err(error)?;
        opened
            .await
            .map_err(|_| "durability worker stopped".to_string())??;
        Ok(Self { sender })
    }
    async fn request<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Worker) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Box::new(move |w| {
                let _ = send.send(f(w));
            }))
            .map_err(|_| "durability worker stopped".to_string())?;
        receive
            .await
            .map_err(|_| "durability worker stopped".to_string())?
    }
    /// Successful return means queued, not saved. Observe DurableEvent or await flush.
    pub fn enqueue_local(&self, edit: LocalEdit) -> Result<()> {
        self.sender
            .send(Box::new(move |w| {
                w.pending.push_back(Queued {
                    remote: false,
                    reply: None,
                    edit,
                    applied: false,
                    imported: None,
                });
                if let Err(e) = w.drain() {
                    w.report_failure(e);
                }
            }))
            .map_err(|_| "durability worker stopped".to_string())
    }
    pub async fn create(&self, request: Create) -> Result<Loaded> {
        self.request(move |w| w.create(request)).await
    }
    pub async fn load(&self, page_id: String) -> Result<Loaded> {
        self.request(move |w| {
            w.drain()?;
            w.loaded(&page_id)
        })
        .await
    }
    pub async fn flush(&self) -> Result<()> {
        self.request(|w| {
            w.drain()?;
            w.checkpoint_dirty()?;
            w.recover_projections()
        })
        .await
    }
    pub async fn list(&self) -> Result<Vec<Entry>> {
        self.request(|w| w.store.transaction(catalog::list).map_err(error))
            .await
    }

    /// Small catalog previews survive restart without decoding every CRDT history.
    pub async fn excerpts(&self) -> Result<std::collections::HashMap<String, String>> {
        self.request(|worker| {
            worker.store.transaction(|tx| {
                let mut statement = tx.prepare("SELECT page_id, substr(markdown, instr(markdown, char(10)||'---'||char(10)) + 5, 512) FROM projections").map_err(db)?;
                let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(db)?;
                rows.collect::<std::result::Result<std::collections::HashMap<_, _>, _>>().map_err(db)
            }).map_err(error)
        }).await
    }
    pub async fn set_deleted(&self, page_id: String, deleted: bool) -> Result<Entry> {
        self.request(move |w| {
            w.drain()?;
            w.store
                .transaction(|tx| catalog::set_deleted(tx, &page_id, deleted))
                .map_err(error)
        })
        .await
    }
    pub async fn preferences(&self, key: String) -> Result<Option<Value>> {
        self.request(move |w| {
            w.store
                .transaction(|tx| catalog::recall(tx, &key))
                .map_err(error)
        })
        .await
    }
    pub async fn set_preferences(&self, key: String, value: Value) -> Result<()> {
        self.request(move |w| {
            w.store
                .transaction(|tx| catalog::remember(tx, &key, &value))
                .map_err(error)
        })
        .await
    }
    /// Header-only edits retain CRDT revision and unknown sidecar fields.
    pub async fn save_header(
        &self,
        page_id: String,
        expected_revision: u64,
        header: serde_yaml::Mapping,
    ) -> Result<Loaded> {
        self.request(move |w| {
            w.drain()?;
            let entry = w.entry(&page_id)?;
            if entry.deleted {
                return Err("page is deleted".into());
            }
            w.ensure_document(&page_id)?;
            let doc = &w.docs[&page_id];
            if doc.revision() != expected_revision {
                return Err("header revision mismatch".into());
            }
            let snapshot = doc.snapshot().map_err(error)?;
            let state = doc.encode_full();
            let prior = w.previous_pair(&page_id)?.ok_or("missing projection")?;
            let parsed = storage::parse_pair(&prior.markdown, &prior.metadata).map_err(error)?;
            let pair = storage::serialize_pair(&snapshot, Some(&header), Some(&parsed.sidecar))
                .map_err(error)?;
            w.store
                .checkpoint_with(&w.docs[&page_id], &pair, |tx| {
                    record_projection(tx, &entry, &state, expected_revision)
                })
                .map_err(error)?;
            w.emit_saved(&page_id, expected_revision, pair.markdown);
            w.loaded(&page_id)
        })
        .await
    }
    pub async fn read_baseline(&self, page_id: String) -> Result<Option<PublishedBaseline>> {
        self.request(move |w| w.baseline(&page_id)).await
    }
    /// After explicit three-way import, permit replacing these exact observed external bytes.
    /// This does not claim they are a coherent CRDT baseline; the old baseline fullstate stays intact.
    pub async fn accept_imported_baseline(
        &self,
        page_id: String,
        observed: FilePair,
    ) -> Result<()> {
        self.request(move |w| w.accept_imported(&page_id, observed))
            .await
    }
    /// Commit a resolved three-way import and its observed disk baseline as one operation.
    /// This can supersede a blocked old projection only after checking the captured disk bytes.
    pub async fn import_local(&self, edit: LocalEdit, observed: FilePair) -> Result<Loaded> {
        self.request(move |w| {
            if !w.pending.is_empty() {
                return Err("flush retained edits before importing".into());
            }
            let id = edit.page_id.clone();
            w.pending.push_back(Queued {
                remote: false,
                reply: None,
                edit,
                applied: false,
                imported: Some(observed),
            });
            w.drain()?;
            w.publish_page(&id)?;
            w.loaded(&id)
        })
        .await
    }
    /// Accept only extension/header changes against a checked published pair.
    pub async fn import_projection_extensions(
        &self,
        page_id: String,
        generation: u64,
        expected_revision: u64,
        observed: FilePair,
    ) -> Result<Loaded> {
        self.request(move |w| {
            w.import_projection_extensions(&page_id, generation, expected_revision, observed)
        })
        .await
    }
    /// Explicit DB-authoritative repair; preserves every extant original before replacing it.
    pub async fn restore_projection(
        &self,
        page_id: String,
        generation: u64,
    ) -> Result<(Loaded, PathBuf)> {
        self.request(move |w| w.restore_projection(&page_id, generation))
            .await
    }
    pub async fn outbox(&self) -> Result<Vec<Outgoing>> {
        self.request(|w| w.outbox()).await
    }
    pub async fn outbox_count(&self) -> Result<u64> {
        self.request(|w| {
            w.store
                .transaction(|tx| {
                    tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| read_u64(row, 0))
                        .map_err(db)
                })
                .map_err(error)
        })
        .await
    }
    pub async fn directory_outbox(&self) -> Result<Vec<DirectoryOperation>> {
        self.request(|w| w.store.transaction(catalog::pending).map_err(error))
            .await
    }
    pub async fn ack(&self, op_id: String) -> Result<()> {
        self.request(move |w| {
            w.store
                .transaction(|tx| {
                    tx.execute("DELETE FROM outbox WHERE op_id=?1", [&op_id])
                        .map_err(db)?;
                    tx.execute(
                        "DELETE FROM sumi_outbox_generation WHERE op_id=?1",
                        [&op_id],
                    )
                    .map_err(db)?;
                    Ok(())
                })
                .map_err(error)
        })
        .await
    }
    pub async fn acknowledge_directory(&self, op_id: String) -> Result<()> {
        self.request(move |w| {
            w.store
                .transaction(|tx| catalog::acknowledge(tx, &op_id))
                .map_err(error)
        })
        .await
    }
    pub async fn apply_directory(&self, entry: Entry) -> Result<Vec<Entry>> {
        self.request(move |w| w.apply_directory(entry)).await
    }
    pub async fn record_inbox(&self, incoming: PendingUpdate, generation: u64) -> Result<bool> {
        self.request(move |w| w.record_incoming(&incoming, generation))
            .await
    }
    pub async fn pending_inbox(&self, page_id: String) -> Result<Vec<RecordedIncoming>> {
        self.request(move |w| w.incoming(&page_id)).await
    }
    /// Enqueue only AFTER the native/core candidate has been committed, while still
    /// holding that transaction lock. Await the receipt outside it. Raw network
    /// packets must use record_inbox/receive_remote; this FIFO is already confirmed.
    pub fn enqueue_remote(
        &self,
        incoming: PendingUpdate,
        generation: u64,
        revision: u64,
    ) -> Result<oneshot::Receiver<Result<Loaded>>> {
        let (reply, receipt) = oneshot::channel();
        self.sender
            .send(Box::new(move |w| {
                w.pending.push_back(Queued {
                    edit: LocalEdit {
                        page_id: incoming.page_id,
                        epoch: incoming.epoch,
                        generation,
                        revision,
                        op_id: incoming.op_id,
                        update: incoming.update,
                        first_write_date: None,
                    },
                    remote: true,
                    reply: Some(reply),
                    applied: false,
                    imported: None,
                });
                if let Err(e) = w.drain() {
                    w.report_failure(e)
                }
            }))
            .map_err(|_| "durability worker stopped".to_string())?;
        Ok(receipt)
    }
    /// Bytes are persisted in the inbox before applying to the worker replica.
    /// The returned state may be integrated into the editor after composition ends.
    pub async fn receive_remote(&self, incoming: PendingUpdate, generation: u64) -> Result<Loaded> {
        self.request(move |w| w.receive(incoming, generation)).await
    }
}

struct Worker {
    vault: PathBuf,
    store: Store,
    docs: HashMap<String, Document>,
    pending: VecDeque<Queued>,
    notify: Arc<dyn Fn(DurableEvent) + Send + Sync>,
    dirty_since: Option<Instant>,
    last_edit: Instant,
}
impl Worker {
    fn open(
        vault: PathBuf,
        database: PathBuf,
        notify: Arc<dyn Fn(DurableEvent) + Send + Sync>,
    ) -> Result<Self> {
        if !vault.is_dir() {
            return Err("Vault must be an existing directory".into());
        }
        if let Some(parent) = database.parent() {
            std::fs::create_dir_all(parent).map_err(error)?;
        }
        let mut store = Store::open(database).map_err(error)?;
        store.transaction(|tx| {
            catalog::initialize(tx)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS sumi_outbox_generation(op_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,first_write_date TEXT);
                CREATE TABLE IF NOT EXISTS sumi_inbox_generation(op_id TEXT PRIMARY KEY,generation INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS sumi_projection_queue(job_id INTEGER PRIMARY KEY AUTOINCREMENT,page_id TEXT NOT NULL,filename TEXT NOT NULL,full_state BLOB NOT NULL,revision INTEGER NOT NULL,baseline TEXT NOT NULL,markdown TEXT NOT NULL,metadata TEXT NOT NULL,attempted INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS sumi_baselines(page_id TEXT PRIMARY KEY,filename TEXT NOT NULL,markdown TEXT NOT NULL,metadata TEXT NOT NULL,full_state BLOB NOT NULL,revision INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS sumi_import_permissions(page_id TEXT PRIMARY KEY,baseline TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sumi_dirty_projection(page_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);").map_err(db)
        }).map_err(error)?;
        let mut worker = Self {
            vault,
            store,
            docs: HashMap::new(),
            pending: VecDeque::new(),
            notify,
            dirty_since: None,
            last_edit: Instant::now(),
        };
        // A conflict does not make the Vault unreadable. The durable pending pair remains for retry/import.
        if let Err(e) = worker.recover_projections() {
            (worker.notify)(DurableEvent::Failed {
                page_id: String::new(),
                revision: 0,
                error: e,
            });
        }
        if let Err(error) = worker.checkpoint_dirty() {
            (worker.notify)(DurableEvent::Failed {
                page_id: String::new(),
                revision: 0,
                error,
            });
        }
        Ok(worker)
    }
    fn report_failure(&self, error: String) {
        if let Some(next) = self.pending.front() {
            (self.notify)(DurableEvent::Failed {
                page_id: next.edit.page_id.clone(),
                revision: next.edit.revision,
                error,
            });
        }
    }
    fn committed(&mut self, id: &str, revision: u64) {
        let now = Instant::now();
        self.dirty_since.get_or_insert(now);
        self.last_edit = now;
        (self.notify)(DurableEvent::Committed {
            page_id: id.into(),
            revision,
        });
    }
    fn checkpoint_due(&self) -> bool {
        self.dirty_since.is_some_and(|since| {
            since.elapsed() >= Duration::from_secs(2)
                || self.last_edit.elapsed() >= Duration::from_millis(250)
        })
    }
    fn checkpoint_dirty(&mut self) -> Result<()> {
        self.drain()?;
        let ids = self
            .store
            .transaction(|tx| {
                let mut statement = tx
                    .prepare("SELECT page_id FROM sumi_dirty_projection ORDER BY page_id")
                    .map_err(db)?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(db)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(db)?;
                Ok(rows)
            })
            .map_err(error)?;
        let mut first_error = None;
        for id in ids {
            if let Err(error) = self.checkpoint_page(&id) {
                let revision = self.docs.get(&id).map_or(0, Document::revision);
                (self.notify)(DurableEvent::Failed {
                    page_id: id,
                    revision,
                    error: error.clone(),
                });
                first_error.get_or_insert(error);
            }
        }
        if first_error.is_none() {
            self.dirty_since = None;
        }
        first_error.map_or(Ok(()), Err)
    }
    fn checkpoint_page(&mut self, id: &str) -> Result<()> {
        self.ensure_document(id)?;
        let entry = self.entry(id)?;
        let snapshot = self.docs[id].snapshot().map_err(error)?;
        let pair = self.pair_for(id, &snapshot)?;
        let doc = &self.docs[id];
        let state = doc.encode_full();
        self.store
            .checkpoint_with(doc, &pair, |tx| {
                record_projection(tx, &entry, &state, snapshot.revision)?;
                tx.execute(
                    "DELETE FROM sumi_dirty_projection WHERE page_id=?1 AND revision<=?2",
                    params![id, sql_u64(snapshot.revision)?],
                )
                .map_err(db)?;
                Ok(())
            })
            .map_err(error)?;
        self.emit_saved(id, snapshot.revision, pair.markdown);
        Ok(())
    }
    fn entry(&mut self, id: &str) -> Result<Entry> {
        self.store
            .transaction(|tx| {
                catalog::get(tx, id)?
                    .ok_or_else(|| write_core::Error::Invalid("missing page".into()))
            })
            .map_err(error)
    }
    fn ensure_document(&mut self, id: &str) -> Result<()> {
        if !self.docs.contains_key(id) {
            self.docs
                .insert(id.into(), self.store.load(id, client_id()).map_err(error)?);
        }
        Ok(())
    }
    fn loaded(&mut self, id: &str) -> Result<Loaded> {
        let entry = self.entry(id)?;
        self.ensure_document(id)?;
        let doc = &self.docs[id];
        let full_state = doc.encode_full();
        let revision = doc.revision();
        let snapshot = doc.snapshot().map_err(error)?;
        let pair = self.pair_for(id, &snapshot)?;
        let parsed = storage::parse_pair(&pair.markdown, &pair.metadata).map_err(error)?;
        Ok(Loaded {
            entry,
            full_state,
            revision,
            raw_markdown: pair.markdown,
            frontmatter: parsed.frontmatter,
            sidecar: parsed.sidecar,
        })
    }
    fn previous_pair(&mut self, id: &str) -> Result<Option<FilePair>> {
        self.store
            .transaction(|tx| {
                tx.query_row(
                    "SELECT markdown,metadata FROM projections WHERE page_id=?1",
                    [id],
                    |r| {
                        Ok(FilePair {
                            markdown: r.get(0)?,
                            metadata: r.get(1)?,
                        })
                    },
                )
                .optional()
                .map_err(db)
            })
            .map_err(error)
    }
    fn pair_for(&mut self, id: &str, snapshot: &write_core::Snapshot) -> Result<FilePair> {
        let prior = self
            .previous_pair(id)?
            .map(|p| storage::parse_pair(&p.markdown, &p.metadata))
            .transpose()
            .map_err(error)?;
        storage::serialize_pair(
            snapshot,
            prior.as_ref().map(|p| &p.frontmatter),
            prior.as_ref().map(|p| &p.sidecar),
        )
        .map_err(error)
    }
    fn create(&mut self, request: Create) -> Result<Loaded> {
        self.drain()?;
        let doc = Document::restore(
            &request.page_id,
            request.epoch,
            client_id(),
            &request.full_state,
            request.revision,
        )
        .map_err(error)?;
        if request.epoch != 1 {
            return Err("new page epoch must be one".into());
        }
        let snapshot = doc.snapshot().map_err(error)?;
        let prior = request
            .preserved_pair
            .map(|p| storage::parse_pair(&p.markdown, &p.metadata))
            .transpose()
            .map_err(error)?;
        let pair = storage::serialize_pair(
            &snapshot,
            request
                .frontmatter
                .as_ref()
                .or_else(|| prior.as_ref().map(|p| &p.frontmatter)),
            prior.as_ref().map(|p| &p.sidecar),
        )
        .map_err(error)?;
        let date = if snapshot.body.is_empty() {
            None
        } else {
            Some(
                request
                    .first_write_date
                    .ok_or("first writing date missing")?,
            )
        };
        let op_id = Uuid::new_v4().to_string();
        let full = doc.encode_full();
        self.store
            .commit_local_with(&doc, &op_id, &full, &pair, |tx| {
                let mut entry = catalog::create(tx, &request.page_id, request.after_id.as_deref())?;
                if let Some(date) = &date {
                    entry = catalog::first_write(tx, &request.page_id, date)?;
                }
                record_local(tx, &entry, &op_id, &full, request.revision)
            })
            .map_err(error)?;
        self.docs.insert(request.page_id.clone(), doc);
        self.emit_saved(&request.page_id, request.revision, pair.markdown);
        self.loaded(&request.page_id)
    }
    fn drain(&mut self) -> Result<()> {
        while let Some(mut queued) = self.pending.pop_front() {
            let result = if queued.remote {
                self.persist_remote(&mut queued).map(Some)
            } else {
                self.persist_edit(&mut queued).map(|_| None)
            };
            match result {
                Ok(loaded) => {
                    if let Some(reply) = queued.reply.take() {
                        let _ = reply.send(loaded.ok_or("missing remote result".into()));
                    }
                }
                Err(e) => {
                    if let Some(reply) = queued.reply.take() {
                        let _ = reply.send(Err(e.clone()));
                    }
                    // Receipts must not hang behind a failed earlier edit. Keep all actions for retry.
                    for later in &mut self.pending {
                        if let Some(reply) = later.reply.take() {
                            let _ = reply.send(Err(e.clone()));
                        }
                    }
                    self.pending.push_front(queued);
                    return Err(e);
                }
            }
        }
        Ok(())
    }
    fn persist_edit(&mut self, queued: &mut Queued) -> Result<()> {
        let e = &queued.edit;
        if let Some(observed) = &queued.imported {
            self.check_observed(&e.page_id, observed)?;
            let baseline = self
                .baseline(&e.page_id)?
                .ok_or("missing published baseline")?;
            super::external::validate(observed, &baseline.pair, &e.page_id, e.epoch)?;
        } // Projection failures do not prevent further durable CRDT commits.
        let entry = self.entry(&e.page_id)?;
        if entry.deleted || entry.generation != e.generation || entry.epoch != e.epoch {
            return Err("stale/deleted page generation; draft retained".into());
        }
        let snapshot = self.confirmed_snapshot(queued)?;
        let e = &queued.edit;
        let nonempty = !snapshot.body.is_empty();
        if queued.imported.is_none() {
            self.store
                .commit_local_delta_with(
                    &e.page_id,
                    e.epoch,
                    e.revision,
                    &e.op_id,
                    &e.update,
                    |tx| {
                        let mut entry = catalog::get(tx, &e.page_id)?
                            .ok_or_else(|| write_core::Error::Invalid("missing page".into()))?;
                        if nonempty && entry.local_date.is_none() {
                            entry = catalog::first_write(
                                tx,
                                &e.page_id,
                                e.first_write_date.as_deref().ok_or_else(|| {
                                    write_core::Error::Invalid("first writing date missing".into())
                                })?,
                            )?;
                        }
                        tx.execute(
                            "INSERT INTO sumi_outbox_generation VALUES(?1,?2,?3)",
                            params![e.op_id, sql_u64(entry.generation)?, entry.local_date],
                        )
                        .map_err(db)?;
                        mark_projection_dirty(tx, &e.page_id, e.revision)
                    },
                )
                .map_err(error)?;
            self.committed(&e.page_id, e.revision);
            return Ok(());
        }
        let pair = if let Some(observed) = &queued.imported {
            let (header, sidecar) = import_extensions(observed, &e.page_id, e.epoch)?;
            storage::serialize_pair(&snapshot, Some(&header), Some(&sidecar)).map_err(error)?
        } else {
            self.pair_for(&e.page_id, &snapshot)?
        };
        let doc = &self.docs[&e.page_id];
        let full = doc.encode_full();
        self.store
            .commit_local_with(doc, &e.op_id, &e.update, &pair, |tx| {
                let mut entry = catalog::get(tx, &e.page_id)?
                    .ok_or_else(|| write_core::Error::Invalid("missing page".into()))?;
                if nonempty && entry.local_date.is_none() {
                    entry = catalog::first_write(
                        tx,
                        &e.page_id,
                        e.first_write_date.as_deref().ok_or_else(|| {
                            write_core::Error::Invalid("first writing date missing".into())
                        })?,
                    )?;
                }
                if let Some(observed) = &queued.imported {
                    record_permission(tx, &e.page_id, observed)?;
                }
                record_local(tx, &entry, &e.op_id, &full, e.revision)
            })
            .map_err(error)?;
        self.emit_saved(&e.page_id, e.revision, pair.markdown);
        Ok(())
    }
    /// Only same-process, already-confirmed UI/import transactions enter this FIFO.
    /// Unconfirmed network/bootstrap bytes use `receive` and isolated validation.
    fn confirmed_snapshot(&mut self, queued: &mut Queued) -> Result<write_core::Snapshot> {
        let e = &queued.edit;
        self.ensure_document(&e.page_id)?;
        if queued.applied {
            let doc = &self.docs[&e.page_id];
            if doc.revision() != e.revision {
                return Err("durability revision mismatch after apply".into());
            }
            return doc.snapshot().map_err(error);
        }
        // Validation can mutate this disposable replica before returning an error.
        // Remove first; on failure the retry reloads the untouched SQLite checkpoint.
        let mut doc = self.docs.remove(&e.page_id).unwrap();
        let snapshot = doc
            .apply_confirmed_update(e.revision, &e.update)
            .map_err(error)?;
        self.docs.insert(e.page_id.clone(), doc);
        queued.applied = true;
        Ok(snapshot)
    }
    fn emit_saved(&mut self, id: &str, revision: u64, raw_markdown: String) {
        let result = self.publish_page(id);
        // Identify only the exact bytes successfully published by this worker. A later
        // filesystem stat could observe an external edit and incorrectly label it ours.
        let projection_identity = if result.is_ok() {
            self.published_files(id)
                .ok()
                .flatten()
                .filter(|(_, pair, saved_revision)| {
                    *saved_revision == revision && pair.markdown == raw_markdown
                })
                .and_then(|(filename, pair, _)| {
                    let (path, _) = projection::paths(&self.vault, &filename).ok()?;
                    Some(ProjectionIdentity {
                        path: path.to_string_lossy().into_owned(),
                        sha256: storage::sha256(pair.markdown.as_bytes()),
                    })
                })
        } else {
            None
        };
        (self.notify)(DurableEvent::Saved {
            page_id: id.into(),
            revision,
            projected: result.is_ok(),
            projection_error: result.err(),
            raw_markdown,
            projection_identity,
        });
    }
    fn published_files(&mut self, id: &str) -> Result<Option<(String, FilePair, u64)>> {
        self.store.transaction(|tx| tx.query_row("SELECT filename,markdown,metadata,revision FROM sumi_baselines WHERE page_id=?1", [id], |r| {
            Ok((r.get(0)?, FilePair { markdown: r.get(1)?, metadata: r.get(2)? }, read_u64(r,3)?))
        }).optional().map_err(db)).map_err(error)
    }
    fn baseline(&mut self, id: &str) -> Result<Option<PublishedBaseline>> {
        self.store.transaction(|tx|tx.query_row("SELECT filename,markdown,metadata,full_state,revision FROM sumi_baselines WHERE page_id=?1",[id],|r| {
            let markdown:String=r.get(1)?; let metadata:String=r.get(2)?;
            Ok(PublishedBaseline { filename:r.get(0)?,hashes:Baseline{markdown_sha256:Some(storage::sha256(markdown.as_bytes())),metadata_sha256:Some(storage::sha256(metadata.as_bytes()))},pair:FilePair{markdown,metadata},full_state:r.get(3)?,revision:read_u64(r,4)? })
        }).optional().map_err(db)).map_err(error)
    }
    fn publish_page(&mut self, id: &str) -> Result<()> {
        loop {
            let pending=self.store.transaction(|tx|tx.query_row("SELECT job_id,filename,full_state,revision,baseline,markdown,metadata FROM sumi_projection_queue WHERE page_id=?1 ORDER BY job_id LIMIT 1",[id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,Vec<u8>>(2)?,read_u64(r,3)?,r.get::<_,String>(4)?,FilePair{markdown:r.get(5)?,metadata:r.get(6)?}))).optional().map_err(db)).map_err(error)?;
            let Some((job_id, filename, state, revision, baseline, pair)) = pending else {
                return Ok(());
            };
            self.store.transaction(|tx| {tx.execute("UPDATE sumi_projection_queue SET attempted=1 WHERE job_id=?1 AND attempted=0",[job_id]).map_err(db)?;Ok(())}).map_err(error)?;
            let baseline: Baseline = serde_json::from_str(&baseline).map_err(error)?;
            projection::publish(&self.vault, &filename, &pair, &baseline).map_err(error)?;
            if let Some((old_filename, old_pair, _)) = self.published_files(id)? {
                if old_filename != filename {
                    let (old_md, old_meta) =
                        projection::paths(&self.vault, &old_filename).map_err(error)?;
                    // Remove only this page's exact prior portable files; external edits are retained.
                    for (path, bytes) in [
                        (old_md, old_pair.markdown.as_bytes()),
                        (old_meta, old_pair.metadata.as_bytes()),
                    ] {
                        if let Ok(meta) = std::fs::symlink_metadata(&path) {
                            if !meta.is_file() || meta.file_type().is_symlink() {
                                return Err("old projection is not a regular file".into());
                            }
                        }
                        match std::fs::read(&path) {
                            Ok(current) if current == bytes => {
                                std::fs::remove_file(&path).map_err(error)?;
                                #[cfg(unix)]
                                std::fs::File::open(path.parent().unwrap())
                                    .and_then(|dir| dir.sync_all())
                                    .map_err(error)?;
                            }
                            Ok(_) => return Err(
                                "old filename contains external changes; rename requires import"
                                    .into(),
                            ),
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                            Err(e) => return Err(error(e)),
                        }
                    }
                }
            }
            self.store.transaction(|tx| {
            tx.execute("INSERT INTO sumi_baselines VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(page_id) DO UPDATE SET filename=excluded.filename,markdown=excluded.markdown,metadata=excluded.metadata,full_state=excluded.full_state,revision=excluded.revision",params![id,filename,pair.markdown,pair.metadata,state,sql_u64(revision)?]).map_err(db)?;
            tx.execute("DELETE FROM sumi_projection_queue WHERE job_id=?1",[job_id]).map_err(db)?;
            tx.execute("UPDATE projections SET complete=NOT EXISTS(SELECT 1 FROM sumi_projection_queue WHERE page_id=?1) WHERE page_id=?1",[id]).map_err(db)?;
            tx.execute("DELETE FROM sumi_import_permissions WHERE page_id=?1",[id]).map_err(db)?; Ok(())
        }).map_err(error)?;
        }
    }
    fn recover_projections(&mut self) -> Result<()> {
        let ids = self
            .store
            .transaction(|tx| {
                let mut s = tx
                    .prepare("SELECT page_id FROM sumi_projection_queue GROUP BY page_id ORDER BY MIN(job_id)")
                    .map_err(db)?;
                let rows = s
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(db)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(db)?;
                Ok(rows)
            })
            .map_err(error)?;
        let mut first = None;
        for id in ids {
            if let Err(e) = self.publish_page(&id) {
                if first.is_none() {
                    first = Some(e);
                }
            }
        }
        first.map_or(Ok(()), Err)
    }
    fn accept_imported(&mut self, id: &str, observed: FilePair) -> Result<()> {
        self.check_observed(id, &observed)?;
        let entry = self.entry(id)?;
        import_extensions(&observed, id, entry.epoch)?;
        self.store
            .transaction(|tx| {
                let pending: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sumi_projection_queue WHERE page_id=?1)",
                        [id],
                        |r| r.get(0),
                    )
                    .map_err(db)?;
                if pending {
                    return Err(write_core::Error::Invalid(
                        "use import_local to resolve a pending projection".into(),
                    ));
                }
                record_permission(tx, id, &observed)
            })
            .map_err(error)
    }
    fn import_projection_extensions(
        &mut self,
        id: &str,
        generation: u64,
        revision: u64,
        observed: FilePair,
    ) -> Result<Loaded> {
        self.drain()?;
        self.check_observed(id, &observed)?;
        let entry = self.entry(id)?;
        if entry.deleted || entry.generation != generation {
            return Err("stale/deleted page generation".into());
        }
        self.ensure_document(id)?;
        if self.docs[id].revision() != revision {
            return Err("extension import revision changed".into());
        }
        let baseline = self.baseline(id)?.ok_or("missing published baseline")?;
        let body = super::external::validate(&observed, &baseline.pair, id, entry.epoch)?;
        let baseline_body = storage::parse_pair(&baseline.pair.markdown, &baseline.pair.metadata)
            .map_err(error)?
            .body;
        if body != baseline_body && body != self.docs[id].body() {
            return Err("body changes require three-way import".into());
        }
        let (header, sidecar) = import_extensions(&observed, id, entry.epoch)?;
        let snapshot = self.docs[id].snapshot().map_err(error)?;
        let state = self.docs[id].encode_full();
        let pair =
            storage::serialize_pair(&snapshot, Some(&header), Some(&sidecar)).map_err(error)?;
        self.store
            .checkpoint_with(&self.docs[id], &pair, |tx| {
                record_permission(tx, id, &observed)?;
                record_projection(tx, &entry, &state, revision)
            })
            .map_err(error)?;
        self.emit_saved(id, revision, pair.markdown);
        self.publish_page(id)?;
        self.loaded(id)
    }
    fn restore_projection(&mut self, id: &str, generation: u64) -> Result<(Loaded, PathBuf)> {
        let entry = self.entry(id)?;
        if entry.deleted || entry.generation != generation {
            return Err("stale/deleted page generation".into());
        }
        let filename = entry
            .filename()
            .ok_or("blank page has no files to repair")?;
        let (md, meta) = projection::paths(&self.vault, &filename).map_err(error)?;
        let observed = super::external::Observed::read(&md, &meta)?;
        self.ensure_document(id)?;
        let recovery = preserve_originals(
            md.parent().unwrap(),
            &filename,
            &observed,
            id,
            self.docs[id].revision(),
        )?;
        // A previously accepted UI import may be retained because disk changed
        // again before commit. Explicit repair preserves those new disk bytes,
        // then commits the already accepted CRDT transaction without granting its
        // obsolete file replacement permission.
        for queued in &mut self.pending {
            if queued.edit.page_id == id && queued.imported.is_some() {
                queued.imported = None;
            }
        }
        self.drain()?;
        let snapshot = self.docs[id].snapshot().map_err(error)?;
        let state = self.docs[id].encode_full();
        let revision = self.docs[id].revision();
        let mut pair = self.pair_for(id, &snapshot)?;
        // Retain legal external YAML extension fields, never external time records.
        if let Some(raw) = observed
            .markdown
            .as_ref()
            .and_then(|b| std::str::from_utf8(b).ok())
        {
            if let Ok((header, _)) = super::parse_header(raw, id, entry.epoch) {
                let prior = storage::parse_pair(&pair.markdown, &pair.metadata).map_err(error)?;
                pair = storage::serialize_pair(&snapshot, Some(&header), Some(&prior.sidecar))
                    .map_err(error)?;
            }
        }
        if super::external::Observed::read(&md, &meta)? != observed {
            return Err(format!(
                "external files changed during repair; originals retained at {}",
                recovery.display()
            ));
        }
        let permitted = serde_json::to_string(&observed.hashes()).map_err(error)?;
        self.store.checkpoint_with(&self.docs[id], &pair, |tx| {
            tx.execute("INSERT INTO sumi_import_permissions VALUES(?1,?2) ON CONFLICT(page_id) DO UPDATE SET baseline=excluded.baseline",params![id, permitted]).map_err(db)?;
            record_projection(tx, &entry, &state, revision)
        }).map_err(error)?;
        self.emit_saved(id, revision, pair.markdown);
        self.publish_page(id)
            .map_err(|e| format!("{e}; originals retained at {}", recovery.display()))?;
        Ok((self.loaded(id)?, recovery))
    }
    fn check_observed(&mut self, id: &str, observed: &FilePair) -> Result<()> {
        let entry = self.entry(id)?;
        let filename = entry.filename().ok_or("page has no projected filename")?;
        let (md, meta) = projection::paths(&self.vault, &filename).map_err(error)?;
        for path in [&md, &meta] {
            let metadata = std::fs::symlink_metadata(path).map_err(error)?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > 64 * 1024 * 1024
            {
                return Err("import target must be a bounded regular file".into());
            }
        }
        if std::fs::read(&md).map_err(error)? != observed.markdown.as_bytes()
            || std::fs::read(&meta).map_err(error)? != observed.metadata.as_bytes()
        {
            return Err("external files changed during import".into());
        }
        Ok(())
    }
    fn outbox(&mut self) -> Result<Vec<Outgoing>> {
        let updates = self.store.outbox().map_err(error)?;
        updates.into_iter().map(|update| {
            let (generation,first_write_date)=self.store.transaction(|tx|tx.query_row("SELECT generation,first_write_date FROM sumi_outbox_generation WHERE op_id=?1",[&update.op_id],|r|Ok((read_u64(r,0)?,r.get(1)?))).map_err(db)).map_err(error)?;
            Ok(Outgoing {update,generation,first_write_date})
        }).collect()
    }
    fn incoming(&mut self, id: &str) -> Result<Vec<RecordedIncoming>> {
        let pending = self.store.pending_inbox(id).map_err(error)?;
        pending
            .into_iter()
            .map(|update| {
                let generation = self
                    .store
                    .transaction(|tx| {
                        tx.query_row(
                            "SELECT generation FROM sumi_inbox_generation WHERE op_id=?1",
                            [&update.op_id],
                            |r| read_u64(r, 0),
                        )
                        .map_err(db)
                    })
                    .map_err(error)?;
                Ok(RecordedIncoming { update, generation })
            })
            .collect()
    }
    fn record_incoming(&mut self, p: &PendingUpdate, generation: u64) -> Result<bool> {
        let entry = self.entry(&p.page_id)?;
        if entry.deleted || entry.generation != generation || entry.epoch != p.epoch {
            return Err("remote page generation mismatch".into());
        }
        self.store.transaction(|tx| {
            let old=tx.query_row("SELECT page_id,epoch,update_blob,applied FROM inbox WHERE op_id=?1",[&p.op_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,Vec<u8>>(2)?,r.get::<_,bool>(3)?))).optional().map_err(db)?;
            if let Some((page,epoch,bytes,_))=&old {if page!=&p.page_id || epoch!=&p.epoch || bytes!=&p.update {return Err(write_core::Error::Invalid("remote operation ID reused".into()))}}
            let prior_generation=tx.query_row("SELECT generation FROM sumi_inbox_generation WHERE op_id=?1",[&p.op_id],|r|read_u64(r,0)).optional().map_err(db)?;
            if prior_generation.is_some_and(|g|g!=generation){return Err(write_core::Error::Invalid("remote operation generation changed".into()))}
            tx.execute("INSERT OR IGNORE INTO inbox(op_id,page_id,epoch,update_blob) VALUES(?1,?2,?3,?4)",params![p.op_id,p.page_id,p.epoch,p.update]).map_err(db)?;
            tx.execute("INSERT OR IGNORE INTO sumi_inbox_generation VALUES(?1,?2)",params![p.op_id,sql_u64(generation)?]).map_err(db)?;
            Ok(old.is_none_or(|old|!old.3))
        }).map_err(error)
    }
    fn persist_remote(&mut self, queued: &mut Queued) -> Result<Loaded> {
        let edit = &queued.edit;
        let incoming = PendingUpdate {
            op_id: edit.op_id.clone(),
            page_id: edit.page_id.clone(),
            epoch: edit.epoch,
            update: edit.update.clone(),
        };
        if !self.record_incoming(&incoming, edit.generation)? {
            return self.loaded(&edit.page_id);
        }
        let entry = self.entry(&edit.page_id)?;
        let snapshot = self.confirmed_snapshot(queued)?;
        let edit = &queued.edit;
        self.store
            .commit_remote_delta_with(
                &edit.page_id,
                edit.epoch,
                snapshot.revision,
                &edit.op_id,
                &edit.update,
                |tx| mark_projection_dirty(tx, &entry.id, edit.revision),
            )
            .map_err(error)?;
        self.committed(&edit.page_id, edit.revision);
        self.loaded(&edit.page_id)
    }
    fn receive(&mut self, incoming: PendingUpdate, generation: u64) -> Result<Loaded> {
        self.drain()?;
        let entry = self.entry(&incoming.page_id)?;
        if entry.deleted || entry.generation != generation || entry.epoch != incoming.epoch {
            return Err("remote page generation mismatch".into());
        }
        self.record_incoming(&incoming, generation)?;
        let pending = self
            .incoming(&incoming.page_id)?
            .into_iter()
            .filter(|item| item.generation == generation)
            .map(|item| item.update)
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return self.loaded(&incoming.page_id);
        }
        // Restore from durable state so retry after commit failure cannot increment revision twice.
        let exists = self
            .store
            .transaction(|tx| {
                tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM documents WHERE page_id=?1)",
                    [&incoming.page_id],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(db)
            })
            .map_err(error)?;
        let doc = if exists {
            let mut doc = self
                .store
                .load(&incoming.page_id, client_id())
                .map_err(error)?;
            for update in &pending {
                doc.apply_remote(&update.update).map_err(error)?;
            }
            doc
        } else {
            let merged = write_core::merge_wire_updates(
                &pending.iter().map(|p| p.update.clone()).collect::<Vec<_>>(),
            )
            .map_err(error)?;
            Document::load(&incoming.page_id, incoming.epoch, client_id(), &merged)
                .map_err(error)?
        };
        let revision = doc.revision();
        let full = doc.encode_full();
        let pair = self.pair_for(&incoming.page_id, &doc.snapshot().map_err(error)?)?;
        self.store
            .commit_remote_with(
                &doc,
                &pending.iter().map(|p| p.op_id.clone()).collect::<Vec<_>>(),
                &pair,
                |tx| record_projection(tx, &entry, &full, revision),
            )
            .map_err(error)?;
        self.docs.insert(incoming.page_id.clone(), doc);
        self.emit_saved(&incoming.page_id, revision, pair.markdown);
        self.loaded(&incoming.page_id)
    }
    fn apply_directory(&mut self, remote: Entry) -> Result<Vec<Entry>> {
        self.drain()?;
        self.checkpoint_dirty()?;
        self.recover_projections()?;
        let changed = self
            .store
            .transaction(|tx| {
                let changed = catalog::apply_remote(tx, &remote)?;
                for entry in &changed {
                    let state = tx
                        .query_row(
                            "SELECT state,revision FROM documents WHERE page_id=?1",
                            [&entry.id],
                            |r| Ok((r.get::<_, Vec<u8>>(0)?, read_u64(r, 1)?)),
                        )
                        .optional()
                        .map_err(db)?;
                    if let Some((state, revision)) = state {
                        record_projection(tx, entry, &state, revision)?;
                    }
                }
                Ok(changed)
            })
            .map_err(error)?;
        for entry in &changed {
            if let Err(error) = self.publish_page(&entry.id) {
                // The directory transaction already committed. Returning Err here
                // would let the UI continue editing with its obsolete generation.
                let revision = self
                    .store
                    .load(&entry.id, client_id())
                    .map(|d| d.revision())
                    .unwrap_or(0);
                (self.notify)(DurableEvent::Failed {
                    page_id: entry.id.clone(),
                    revision,
                    error,
                });
            }
        }
        Ok(changed)
    }
}
fn record_local(
    tx: &Transaction<'_>,
    entry: &Entry,
    op_id: &str,
    state: &[u8],
    revision: u64,
) -> write_core::Result<()> {
    tx.execute(
        "INSERT INTO sumi_outbox_generation VALUES(?1,?2,?3)",
        params![op_id, sql_u64(entry.generation)?, entry.local_date],
    )
    .map_err(db)?;
    record_projection(tx, entry, state, revision)
}
fn record_projection(
    tx: &Transaction<'_>,
    entry: &Entry,
    state: &[u8],
    revision: u64,
) -> write_core::Result<()> {
    tx.execute(
        "DELETE FROM sumi_dirty_projection WHERE page_id=?1 AND revision<=?2",
        params![entry.id, sql_u64(revision)?],
    )
    .map_err(db)?;
    let Some(filename) = entry.filename() else {
        tx.execute(
            "UPDATE projections SET complete=1 WHERE page_id=?1",
            [&entry.id],
        )
        .map_err(db)?;
        return Ok(());
    };
    // An unattempted tail has never touched the filesystem and may be replaced by
    // the latest durable revision. Retain the attempted head exactly for crash replay.
    tx.execute(
        "DELETE FROM sumi_projection_queue WHERE page_id=?1 AND attempted=0",
        [&entry.id],
    )
    .map_err(db)?;
    let imported = tx
        .query_row(
            "SELECT baseline FROM sumi_import_permissions WHERE page_id=?1",
            [&entry.id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(db)?;
    let baseline = if let Some(b) = imported {
        // Explicit resolved import supersedes blocked projections, never ordinary crash replay.
        tx.execute(
            "DELETE FROM sumi_projection_queue WHERE page_id=?1",
            [&entry.id],
        )
        .map_err(db)?;
        tx.execute(
            "DELETE FROM sumi_import_permissions WHERE page_id=?1",
            [&entry.id],
        )
        .map_err(db)?;
        b
    } else {
        let prior = tx
            .query_row(
                "SELECT markdown,metadata FROM (SELECT markdown,metadata,job_id AS ordering FROM sumi_projection_queue WHERE page_id=?1 AND filename=?2 UNION ALL SELECT markdown,metadata,-1 AS ordering FROM sumi_baselines WHERE page_id=?1 AND filename=?2) ORDER BY ordering DESC LIMIT 1",
                params![entry.id, filename],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(db)?;
        let b = prior
            .map(|(md, meta)| Baseline {
                markdown_sha256: Some(storage::sha256(md.as_bytes())),
                metadata_sha256: Some(storage::sha256(meta.as_bytes())),
            })
            .unwrap_or_default();
        serde_json::to_string(&b)?
    };
    tx.execute("INSERT INTO sumi_projection_queue(page_id,filename,full_state,revision,baseline,markdown,metadata,attempted) SELECT ?1,?2,?3,?4,?5,markdown,metadata,NOT EXISTS(SELECT 1 FROM sumi_projection_queue WHERE page_id=?1) FROM projections WHERE page_id=?1",params![entry.id,filename,state,sql_u64(revision)?,baseline]).map_err(db)?;
    Ok(())
}
fn mark_projection_dirty(tx: &Transaction<'_>, id: &str, revision: u64) -> write_core::Result<()> {
    tx.execute("INSERT INTO sumi_dirty_projection VALUES(?1,?2) ON CONFLICT(page_id) DO UPDATE SET revision=excluded.revision", params![id, sql_u64(revision)?]).map_err(db)?;
    Ok(())
}
fn record_permission(
    tx: &Transaction<'_>,
    id: &str,
    observed: &FilePair,
) -> write_core::Result<()> {
    let baseline = Baseline {
        markdown_sha256: Some(storage::sha256(observed.markdown.as_bytes())),
        metadata_sha256: Some(storage::sha256(observed.metadata.as_bytes())),
    };
    tx.execute("INSERT INTO sumi_import_permissions VALUES(?1,?2) ON CONFLICT(page_id) DO UPDATE SET baseline=excluded.baseline",params![id,serde_json::to_string(&baseline)?]).map_err(db)?;
    Ok(())
}
fn preserve_originals(
    parent: &std::path::Path,
    filename: &str,
    observed: &super::external::Observed,
    id: &str,
    revision: u64,
) -> Result<PathBuf> {
    use std::io::Write;
    let root = parent.join(".sumi-recovery");
    match std::fs::symlink_metadata(&root) {
        Ok(m) if !m.is_dir() || m.file_type().is_symlink() => {
            return Err("recovery directory must not be a symlink".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&root).map_err(error)?
        }
        Err(e) => return Err(error(e)),
    }
    let folder = root.join(Uuid::new_v4().to_string());
    std::fs::create_dir(&folder).map_err(error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).map_err(error)?;
    }
    let write = |name: &str, bytes: &[u8]| -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(folder.join(name)).map_err(error)?;
        output
            .write_all(bytes)
            .and_then(|_| output.sync_all())
            .map_err(error)
    };
    if let Some(bytes) = &observed.markdown {
        write(filename, bytes)?;
    }
    if let Some(bytes) = &observed.metadata {
        write(
            &format!("{}.meta.json", filename.strip_suffix(".md").unwrap()),
            bytes,
        )?;
    }
    write("recovery.json", &serde_json::to_vec_pretty(&serde_json::json!({"page_id":id,"revision":revision,"reason":"explicit_db_projection_repair","original_hashes":observed.hashes()})).map_err(error)?)?;
    #[cfg(unix)]
    {
        std::fs::File::open(&folder)
            .and_then(|f| f.sync_all())
            .map_err(error)?;
        std::fs::File::open(&root)
            .and_then(|f| f.sync_all())
            .map_err(error)?;
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(error)?;
    }
    Ok(folder)
}

fn import_extensions(
    pair: &FilePair,
    id: &str,
    epoch: u32,
) -> Result<(serde_yaml::Mapping, storage::Sidecar)> {
    if !pair.markdown.starts_with("---\n") {
        return Err("import frontmatter missing".into());
    }
    let end = pair.markdown[4..]
        .find("\n---\n")
        .ok_or("import frontmatter incomplete")?
        + 4;
    if end > 128 * 1024 || pair.metadata.len() > 64 * 1024 * 1024 {
        return Err("import metadata exceeds capacity".into());
    }
    let header: serde_yaml::Mapping =
        serde_yaml::from_str(&pair.markdown[4..end]).map_err(error)?;
    let sidecar: storage::Sidecar = serde_json::from_str(&pair.metadata).map_err(error)?;
    if sidecar.page_id != id
        || sidecar.epoch != epoch
        || header
            .get(serde_yaml::Value::String("page_id".into()))
            .and_then(|v| v.as_str())
            != Some(id)
    {
        return Err("import identity mismatch".into());
    }
    Ok((header, sidecar))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[tokio::test]
    async fn catalog_previews_survive_restart_without_exposing_the_internal_header() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        std::fs::create_dir(&vault).unwrap();
        let db = temp.path().join("sumi.sqlite3");
        let durable = Durability::open(vault.clone(), db.clone(), |_| {}).await.unwrap();
        let id = Uuid::new_v4().to_string();
        let mut document = Document::new(&id, 1, 1).unwrap();
        document.replace(0, 0, 0, &"中文第一页😀\n".repeat(200), 123).unwrap();
        let body = document.body();
        durable.create(Create {
            page_id: id.clone(), epoch: 1, full_state: document.encode_full(), revision: document.revision(),
            after_id: None, first_write_date: Some("2026-11-07".into()), frontmatter: None, preserved_pair: None,
        }).await.unwrap();
        durable.flush().await.unwrap();
        drop(durable);
        let reopened = Durability::open(vault, db, |_| {}).await.unwrap();
        let previews = reopened.excerpts().await.unwrap();
        assert_eq!(previews[&id], body.chars().take(512).collect::<String>());
        assert!(!previews[&id].contains("page_id"));
    }
    struct Fixture {
        temp: tempfile::TempDir,
        db: PathBuf,
        events: Arc<Mutex<Vec<DurableEvent>>>,
        worker: Worker,
    }
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("private/sumi.sqlite");
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let worker = Worker::open(
            temp.path().into(),
            db.clone(),
            Arc::new(move |e| capture.lock().unwrap().push(e)),
        )
        .unwrap();
        Fixture {
            temp,
            db,
            events,
            worker,
        }
    }
    fn page(worker: &mut Worker, text: &str) -> (String, Document) {
        let id = Uuid::new_v4().to_string();
        let mut doc = Document::new(&id, 1, 17).unwrap();
        if !text.is_empty() {
            doc.replace(0, 0, 0, text, 100).unwrap();
        }
        worker
            .create(Create {
                page_id: id.clone(),
                epoch: 1,
                full_state: doc.encode_full(),
                revision: doc.revision(),
                after_id: None,
                first_write_date: Some("2026-11-07".into()),
                frontmatter: Some(
                    serde_yaml::from_str("author: human\ncustom: preserved\n").unwrap(),
                ),
                preserved_pair: None,
            })
            .unwrap();
        (id, doc)
    }
    fn edit(id: &str, doc: &mut Document, text: &str) -> Queued {
        let update = doc
            .replace(
                doc.revision(),
                doc.body().encode_utf16().count() as u32,
                0,
                text,
                200,
            )
            .unwrap();
        Queued {
            remote: false,
            reply: None,
            edit: LocalEdit {
                page_id: id.into(),
                epoch: 1,
                generation: 0,
                revision: doc.revision(),
                op_id: Uuid::new_v4().to_string(),
                update,
                first_write_date: Some("2026-11-08".into()),
            },
            applied: false,
            imported: None,
        }
    }
    #[test]
    fn first_write_date_catalog_outbox_revision_and_unknown_header_are_durable() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "");
        assert!(f.worker.entry(&id).unwrap().filename().is_none());
        assert!(f.worker.baseline(&id).unwrap().is_none());
        f.worker.pending.push_back(edit(&id, &mut doc, "文字"));
        f.worker.drain().unwrap();
        assert!(matches!(
            f.events.lock().unwrap().last(),
            Some(DurableEvent::Committed { revision: 1, .. })
        ));
        assert!(f.worker.baseline(&id).unwrap().is_none());
        f.worker.checkpoint_dirty().unwrap();
        let loaded = f.worker.loaded(&id).unwrap();
        assert_eq!(loaded.entry.local_date.as_deref(), Some("2026-11-08"));
        assert_eq!(loaded.revision, 1);
        assert_eq!(
            loaded.frontmatter[serde_yaml::Value::String("author".into())].as_str(),
            Some("human")
        );
        let out = f.worker.outbox().unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].first_write_date.as_deref(), Some("2026-11-08"));
        let baseline = f.worker.baseline(&id).unwrap().unwrap();
        let identity = match f.events.lock().unwrap().last().unwrap() {
            DurableEvent::Saved {
                projection_identity: Some(identity),
                ..
            } => identity.clone(),
            _ => panic!("successful published bytes must carry their identity"),
        };
        let (published_path, _) = projection::paths(f.temp.path(), &baseline.filename).unwrap();
        assert_eq!(identity.path, published_path.to_string_lossy());
        assert_eq!(
            identity.sha256,
            storage::sha256(baseline.pair.markdown.as_bytes())
        );
        // An external overwrite cannot mutate the identity already delivered to the watcher.
        std::fs::write(&published_path, "external after publish").unwrap();
        assert_ne!(
            identity.sha256,
            storage::sha256(&std::fs::read(&published_path).unwrap())
        );
        std::fs::write(&published_path, &baseline.pair.markdown).unwrap();
        assert_eq!(
            storage::parse_pair(&baseline.pair.markdown, &baseline.pair.metadata)
                .unwrap()
                .body,
            "文字"
        );
        let mut reopened = Worker::open(f.temp.path().into(), f.db, Arc::new(|_| {})).unwrap();
        assert_eq!(reopened.loaded(&id).unwrap().revision, 1);
    }
    #[test]
    fn sqlite_failure_rolls_back_everything_retains_draft_and_retry_does_not_apply_twice() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "");
        f.worker.store.transaction(|tx|tx.execute_batch("CREATE TRIGGER reject_edit BEFORE INSERT ON sumi_outbox_generation BEGIN SELECT RAISE(ABORT,'test disk failure'); END;").map_err(db)).unwrap();
        f.worker.pending.push_back(edit(&id, &mut doc, "保留"));
        assert!(f.worker.drain().is_err());
        assert_eq!(f.worker.pending.len(), 1);
        assert_eq!(f.worker.docs[&id].body(), "保留");
        assert_eq!(f.worker.store.load(&id, 99).unwrap().body(), "");
        assert!(f.worker.entry(&id).unwrap().filename().is_none());
        assert_eq!(f.worker.outbox().unwrap().len(), 1);
        assert_eq!(
            f.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| matches!(e, DurableEvent::Saved { revision: 1, .. }))
                .count(),
            0
        );
        f.worker
            .store
            .transaction(|tx| tx.execute_batch("DROP TRIGGER reject_edit").map_err(db))
            .unwrap();
        f.worker.drain().unwrap();
        assert_eq!(f.worker.store.load(&id, 99).unwrap().body(), "保留");
        assert_eq!(f.worker.store.load(&id, 99).unwrap().revision(), 1);
    }
    #[test]
    fn failed_confirmed_apply_discards_replica_and_retains_durable_checkpoint() {
        let mut f = fixture();
        let (id, mut ui) = page(&mut f.worker, "safe");
        let mut queued = edit(&id, &mut ui, " next");
        let valid = queued.edit.update.clone();
        queued.edit.update = vec![255];
        f.worker.pending.push_back(queued);
        assert!(f.worker.drain().is_err());
        assert!(!f.worker.docs.contains_key(&id));
        assert!(!f.worker.pending.front().unwrap().applied);
        assert_eq!(f.worker.store.load(&id, 99).unwrap().body(), "safe");
        assert_eq!(f.worker.pending.len(), 1);
        f.worker.pending.front_mut().unwrap().edit.update = valid;
        f.worker.drain().unwrap();
        assert_eq!(f.worker.store.load(&id, 99).unwrap().body(), "safe next");
        assert_eq!(
            f.worker.store.load(&id, 99).unwrap().revision(),
            ui.revision()
        );
    }
    #[test]
    fn committed_deltas_survive_restart_before_coalesced_projection() {
        let mut f = fixture();
        let (id, mut ui) = page(&mut f.worker, "base");
        let baseline = f.worker.baseline(&id).unwrap().unwrap();
        let (md, _) = projection::paths(f.temp.path(), &baseline.filename).unwrap();
        for text in [" one", " two", " three"] {
            f.worker.pending.push_back(edit(&id, &mut ui, text));
            f.worker.drain().unwrap();
        }
        assert_eq!(f.worker.store.load(&id, 99).unwrap().body(), ui.body());
        assert_eq!(
            std::fs::read_to_string(&md).unwrap(),
            baseline.pair.markdown
        );
        assert_eq!(
            f.events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, DurableEvent::Committed { .. }))
                .count(),
            3
        );
        assert_eq!(
            f.events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, DurableEvent::Saved { .. }))
                .count(),
            1
        );
        // A process restart reconstructs the delta log, then publishes the latest exact pair.
        let mut restarted = Worker::open(f.temp.path().into(), f.db, Arc::new(|_| {})).unwrap();
        assert_eq!(restarted.loaded(&id).unwrap().revision, ui.revision());
        assert_eq!(
            restarted.baseline(&id).unwrap().unwrap().revision,
            ui.revision()
        );
        assert!(std::fs::read_to_string(md)
            .unwrap()
            .ends_with("base one two three"));
        assert_eq!(restarted.outbox().unwrap().len(), 4);
    }
    #[tokio::test]
    async fn idle_worker_coalesces_full_projection_and_emits_small_per_edit_receipts() {
        let temp = tempfile::tempdir().unwrap();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let output = events.clone();
        let worker = Durability::open(temp.path().into(), temp.path().join("db"), move |event| {
            output.lock().unwrap().push(event)
        })
        .await
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut ui = Document::new(&id, 1, 876).unwrap();
        worker
            .create(Create {
                page_id: id.clone(),
                epoch: 1,
                full_state: ui.encode_full(),
                revision: 0,
                after_id: None,
                first_write_date: None,
                frontmatter: None,
                preserved_pair: None,
            })
            .await
            .unwrap();
        for _ in 0..5 {
            worker.enqueue_local(edit(&id, &mut ui, "字").edit).unwrap();
        }
        assert_eq!(worker.outbox_count().await.unwrap(), 6);
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, DurableEvent::Committed { .. }))
                .count(),
            5
        );
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if worker
                    .read_baseline(id.clone())
                    .await
                    .unwrap()
                    .is_some_and(|b| b.revision == 5)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, DurableEvent::Saved { .. }))
                .count(),
            2
        );
    }
    fn leave_pending(f: &mut Fixture, id: &str, doc: &mut Document) -> FilePair {
        let update = doc
            .replace(
                doc.revision(),
                doc.body().encode_utf16().count() as u32,
                0,
                " next",
                200,
            )
            .unwrap();
        let pair = storage::serialize_pair(&doc.snapshot().unwrap(), None, None).unwrap();
        let entry = f.worker.entry(id).unwrap();
        let state = doc.encode_full();
        let revision = doc.revision();
        let op = Uuid::new_v4().to_string();
        f.worker
            .store
            .commit_local_with(doc, &op, &update, &pair, |tx| {
                record_local(tx, &entry, &op, &state, revision)
            })
            .unwrap();
        pair
    }
    #[test]
    fn restart_after_only_markdown_replace_replays_exact_pair_and_baseline_state() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "old");
        let pair = leave_pending(&mut f, &id, &mut doc);
        let entry = f.worker.entry(&id).unwrap();
        let (md, _) = projection::paths(f.temp.path(), &entry.filename().unwrap()).unwrap();
        std::fs::write(&md, &pair.markdown).unwrap();
        let mut reopened = Worker::open(f.temp.path().into(), f.db, Arc::new(|_| {})).unwrap();
        let baseline = reopened.baseline(&id).unwrap().unwrap();
        assert_eq!(baseline.pair.metadata, pair.metadata);
        assert_eq!(baseline.revision, 2);
        assert_eq!(
            Document::load(&id, 1, 99, &baseline.full_state)
                .unwrap()
                .body(),
            "old next"
        );
    }
    #[test]
    fn restart_never_overwrites_external_content_with_pending_projection() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "old");
        leave_pending(&mut f, &id, &mut doc);
        let filename = f.worker.entry(&id).unwrap().filename().unwrap();
        let (md, _) = projection::paths(f.temp.path(), &filename).unwrap();
        std::fs::write(&md, "external intact").unwrap();
        let mut reopened = Worker::open(f.temp.path().into(), f.db, Arc::new(|_| {})).unwrap();
        assert!(reopened.recover_projections().is_err());
        assert_eq!(std::fs::read_to_string(&md).unwrap(), "external intact");
        assert_eq!(reopened.baseline(&id).unwrap().unwrap().revision, 1);
    }
    #[test]
    fn deleted_generation_cannot_replay_predelete_edits() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "old");
        let queued = edit(&id, &mut doc, " stale");
        f.worker
            .store
            .transaction(|tx| {
                catalog::set_deleted(tx, &id, true)?;
                catalog::set_deleted(tx, &id, false)
            })
            .unwrap();
        f.worker.pending.push_back(queued);
        assert!(f.worker.drain().unwrap_err().contains("generation"));
        assert_eq!(f.worker.store.load(&id, 99).unwrap().body(), "old");
        assert_eq!(f.worker.entry(&id).unwrap().generation, 2);
    }
    #[test]
    fn remote_inbox_recovers_on_load_and_duplicate_does_not_change_revision() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "old");
        let queued = edit(&id, &mut doc, " remote");
        let incoming = PendingUpdate {
            op_id: queued.edit.op_id,
            page_id: id.clone(),
            epoch: 1,
            update: queued.edit.update,
        };
        f.worker.record_incoming(&incoming, 0).unwrap();
        let mut reopened = Worker::open(f.temp.path().into(), f.db, Arc::new(|_| {})).unwrap();
        let first = reopened.receive(incoming.clone(), 0).unwrap();
        assert_eq!(first.revision, 2);
        assert!(first.raw_markdown.ends_with("old remote"));
        let again = reopened.receive(incoming, 0).unwrap();
        assert_eq!(again.revision, 2);
        assert_eq!(reopened.outbox().unwrap().len(), 1);
    }
    #[test]
    fn remote_first_page_uses_received_identity_and_creates_no_local_outbox() {
        let mut f = fixture();
        let id = Uuid::new_v4().to_string();
        let mut doc = Document::new(&id, 1, 66).unwrap();
        doc.replace(0, 0, 0, "remote", 100).unwrap();
        f.worker
            .apply_directory(Entry {
                id: id.clone(),
                epoch: 1,
                generation: 0,
                deleted: false,
                local_date: Some("2026-11-07".into()),
                sequence: Some(1),
                after_id: None,
                registered: true,
            })
            .unwrap();
        let result = f
            .worker
            .receive(
                PendingUpdate {
                    op_id: Uuid::new_v4().to_string(),
                    page_id: id,
                    epoch: 1,
                    update: doc.encode_full(),
                },
                0,
            )
            .unwrap();
        assert!(result.raw_markdown.ends_with("remote"));
        assert!(f.worker.outbox().unwrap().is_empty());
    }
    #[test]
    fn explicit_import_checks_observed_bytes_and_preserves_extensions() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "old");
        let baseline = f.worker.baseline(&id).unwrap().unwrap();
        let (md, meta) = projection::paths(f.temp.path(), &baseline.filename).unwrap();
        let observed = FilePair {
            markdown: baseline
                .pair
                .markdown
                .replace("custom: preserved", "custom: imported")
                .replace("old", "external"),
            metadata: baseline.pair.metadata.clone(),
        };
        std::fs::write(&md, &observed.markdown).unwrap();
        assert!(f
            .worker
            .accept_imported(&id, baseline.pair.clone())
            .is_err());
        let update = match write_core::import::import_external(
            &mut doc,
            &baseline.full_state,
            "external",
            300,
        )
        .unwrap()
        {
            write_core::import::ImportOutcome::Applied { update } => update,
            _ => panic!("expected import"),
        };
        f.worker.pending.push_back(Queued {
            remote: false,
            reply: None,
            edit: LocalEdit {
                page_id: id.clone(),
                epoch: 1,
                generation: 0,
                revision: doc.revision(),
                op_id: Uuid::new_v4().to_string(),
                update,
                first_write_date: None,
            },
            applied: false,
            imported: Some(observed),
        });
        f.worker.drain().unwrap();
        let loaded = f.worker.loaded(&id).unwrap();
        assert!(loaded.raw_markdown.contains("custom: imported"));
        assert_eq!(
            storage::parse_pair(
                &std::fs::read_to_string(md).unwrap(),
                &std::fs::read_to_string(meta).unwrap()
            )
            .unwrap()
            .body,
            "external"
        );
    }
    #[test]
    fn explicit_repair_recovers_a_retained_import_without_losing_new_external_bytes() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "old");
        let baseline = f.worker.baseline(&id).unwrap().unwrap();
        let (md, meta) = projection::paths(f.temp.path(), &baseline.filename).unwrap();
        let observed = FilePair {
            markdown: baseline.pair.markdown.replace("old", "accepted import"),
            metadata: baseline.pair.metadata.clone(),
        };
        let update = match write_core::import::import_external(
            &mut doc,
            &baseline.full_state,
            "accepted import",
            300,
        )
        .unwrap()
        {
            write_core::import::ImportOutcome::Applied { update } => update,
            _ => panic!("import"),
        };
        let newer = baseline
            .pair
            .markdown
            .replace("old", "newer external draft");
        std::fs::write(&md, &newer).unwrap();
        std::fs::write(&meta, b"broken newer meta").unwrap();
        f.worker.pending.push_back(Queued {
            remote: false,
            reply: None,
            edit: LocalEdit {
                page_id: id.clone(),
                epoch: 1,
                generation: 0,
                revision: doc.revision(),
                op_id: Uuid::new_v4().to_string(),
                update,
                first_write_date: None,
            },
            applied: false,
            imported: Some(observed),
        });
        assert!(f.worker.drain().is_err());
        assert_eq!(f.worker.pending.len(), 1);
        let (loaded, backup) = f.worker.restore_projection(&id, 0).unwrap();
        assert!(f.worker.pending.is_empty());
        assert!(loaded.raw_markdown.ends_with("accepted import"));
        assert_eq!(
            std::fs::read_to_string(backup.join(&baseline.filename)).unwrap(),
            newer
        );
        assert_eq!(
            std::fs::read(backup.join(meta.file_name().unwrap())).unwrap(),
            b"broken newer meta"
        );
        assert!(std::fs::read_to_string(&md)
            .unwrap()
            .ends_with("accepted import"));
        let mut restarted =
            Worker::open(f.temp.path().into(), f.db.clone(), Arc::new(|_| {})).unwrap();
        assert!(restarted
            .loaded(&id)
            .unwrap()
            .raw_markdown
            .ends_with("accepted import"));
    }
    #[tokio::test]
    async fn public_api_owns_io_on_a_dedicated_thread() {
        let temp = tempfile::tempdir().unwrap();
        let caller = std::thread::current().id();
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let worker = Durability::open(temp.path().into(), temp.path().join("db"), move |_| {
            capture.lock().unwrap().push(std::thread::current().id())
        })
        .await
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut doc = Document::new(&id, 1, 99).unwrap();
        worker
            .create(Create {
                page_id: id.clone(),
                epoch: 1,
                full_state: doc.encode_full(),
                revision: 0,
                after_id: None,
                first_write_date: None,
                frontmatter: None,
                preserved_pair: None,
            })
            .await
            .unwrap();
        worker
            .enqueue_local(edit(&id, &mut doc, "background").edit)
            .unwrap();
        worker.flush().await.unwrap();
        assert_eq!(worker.load(id.clone()).await.unwrap().revision, 1);
        let header = serde_yaml::from_str("author: human\ncustom: source-edit\n").unwrap();
        let updated = worker.save_header(id.clone(), 1, header).await.unwrap();
        assert_eq!(updated.revision, 1);
        assert!(updated.raw_markdown.contains("custom: source-edit"));
        assert_eq!(worker.outbox().await.unwrap().len(), 2);
        assert!(worker
            .save_header(id, 0, serde_yaml::Mapping::new())
            .await
            .is_err());
        assert!(events.lock().unwrap().iter().all(|id| *id != caller));
    }
    #[test]
    fn blocked_projection_keeps_saving_and_only_coalesces_unattempted_tail() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "old");
        let baseline = f.worker.baseline(&id).unwrap().unwrap();
        let (md, meta) = projection::paths(f.temp.path(), &baseline.filename).unwrap();
        std::fs::write(&md, "externally changed").unwrap();
        for _ in 0..10 {
            f.worker.pending.push_back(edit(&id, &mut doc, "+"));
            f.worker.drain().unwrap();
            f.worker.checkpoint_dirty().unwrap();
        }
        assert_eq!(
            f.worker.store.load(&id, 99).unwrap().body(),
            "old++++++++++"
        );
        assert_eq!(f.worker.outbox().unwrap().len(), 11);
        let count = f
            .worker
            .store
            .transaction(|tx| {
                tx.query_row("SELECT COUNT(*) FROM sumi_projection_queue", [], |r| {
                    r.get::<_, u32>(0)
                })
                .map_err(db)
            })
            .unwrap();
        assert_eq!(count, 2);
        assert!(matches!(
            f.events.lock().unwrap().last().unwrap(),
            DurableEvent::Saved {
                revision: 11,
                projected: false,
                projection_identity: None,
                ..
            }
        ));
        std::fs::write(&md, &baseline.pair.markdown).unwrap();
        // Recovery must write the first attempted pair, then the coalesced latest pair.
        let mut reopened = Worker::open(f.temp.path().into(), f.db, Arc::new(|_| {})).unwrap();
        assert_eq!(reopened.baseline(&id).unwrap().unwrap().revision, 11);
        assert_eq!(
            storage::parse_pair(
                &std::fs::read_to_string(md).unwrap(),
                &std::fs::read_to_string(meta).unwrap()
            )
            .unwrap()
            .body,
            "old++++++++++"
        );
    }
    #[test]
    fn explicit_import_can_resolve_blocked_pending_projection_without_losing_local_text() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "one\ntwo");
        let baseline = f.worker.baseline(&id).unwrap().unwrap();
        let (md, _) = projection::paths(f.temp.path(), &baseline.filename).unwrap();
        let observed = FilePair {
            markdown: baseline.pair.markdown.replace("one\ntwo", "external\ntwo"),
            metadata: baseline.pair.metadata.clone(),
        };
        std::fs::write(&md, &observed.markdown).unwrap();
        f.worker.pending.push_back(edit(&id, &mut doc, " local"));
        f.worker.drain().unwrap();
        f.worker.checkpoint_dirty().unwrap();
        let update = match write_core::import::import_external(
            &mut doc,
            &baseline.full_state,
            "external\ntwo",
            300,
        )
        .unwrap()
        {
            write_core::import::ImportOutcome::Applied { update } => update,
            other => panic!("expected merge: {other:?}"),
        };
        f.worker.pending.push_back(Queued {
            remote: false,
            reply: None,
            edit: LocalEdit {
                page_id: id.clone(),
                epoch: 1,
                generation: 0,
                revision: doc.revision(),
                op_id: Uuid::new_v4().to_string(),
                update,
                first_write_date: None,
            },
            applied: false,
            imported: Some(observed),
        });
        f.worker.drain().unwrap();
        assert_eq!(
            f.worker.store.load(&id, 99).unwrap().body(),
            "external\ntwo local"
        );
        assert_eq!(f.worker.baseline(&id).unwrap().unwrap().revision, 3);
        assert!(std::fs::read_to_string(md)
            .unwrap()
            .ends_with("external\ntwo local"));
    }
    #[test]
    fn server_sequence_collision_moves_only_owned_projection_before_remote_arrives() {
        let mut f = fixture();
        let (local, _) = page(&mut f.worker, "local");
        let remote = Uuid::new_v4().to_string();
        let changed = f
            .worker
            .apply_directory(Entry {
                id: remote.clone(),
                epoch: 1,
                generation: 0,
                deleted: false,
                local_date: Some("2026-11-07".into()),
                sequence: Some(1),
                after_id: None,
                registered: true,
            })
            .unwrap();
        assert_eq!(changed.len(), 2);
        assert_eq!(f.worker.entry(&local).unwrap().sequence, Some(2));
        let (old, _) = projection::paths(f.temp.path(), "2026-11-07-01.writing.md").unwrap();
        assert!(!old.exists());
        let mut doc = Document::new(&remote, 1, 88).unwrap();
        doc.replace(0, 0, 0, "remote", 100).unwrap();
        f.worker
            .receive(
                PendingUpdate {
                    op_id: Uuid::new_v4().to_string(),
                    page_id: remote,
                    epoch: 1,
                    update: doc.encode_full(),
                },
                0,
            )
            .unwrap();
        assert!(std::fs::read_to_string(old).unwrap().ends_with("remote"));
        assert_eq!(
            f.worker.baseline(&local).unwrap().unwrap().filename,
            "2026-11-07-02.writing.md"
        );
    }
    #[tokio::test]
    async fn two_phase_remote_preserves_ui_order_and_does_not_consume_future_inbox() {
        let temp = tempfile::tempdir().unwrap();
        let worker = Durability::open(temp.path().into(), temp.path().join("db"), |_| {})
            .await
            .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut ui = Document::new(&id, 1, 12).unwrap();
        worker
            .create(Create {
                page_id: id.clone(),
                epoch: 1,
                full_state: ui.encode_full(),
                revision: 0,
                after_id: None,
                first_write_date: None,
                frontmatter: None,
                preserved_pair: None,
            })
            .await
            .unwrap();
        let mut remote = Document::load(&id, 1, 13, &ui.encode_full()).unwrap();
        let first = PendingUpdate {
            op_id: Uuid::new_v4().to_string(),
            page_id: id.clone(),
            epoch: 1,
            update: remote
                .replace(remote.revision(), 0, 0, "remote", 100)
                .unwrap(),
        };
        let second = PendingUpdate {
            op_id: Uuid::new_v4().to_string(),
            page_id: id.clone(),
            epoch: 1,
            update: remote
                .replace(remote.revision(), 6, 0, " second", 200)
                .unwrap(),
        };
        assert!(worker.record_inbox(first.clone(), 0).await.unwrap());
        assert!(worker.record_inbox(second.clone(), 0).await.unwrap());
        assert_eq!(worker.load(id.clone()).await.unwrap().revision, 0);
        ui.apply_remote(&first.update).unwrap();
        let receipt = worker
            .enqueue_remote(first.clone(), 0, ui.revision())
            .unwrap();
        worker
            .enqueue_local(edit(&id, &mut ui, " local").edit)
            .unwrap();
        assert_eq!(receipt.await.unwrap().unwrap().revision, 1);
        worker.flush().await.unwrap();
        let loaded = worker.load(id.clone()).await.unwrap();
        assert_eq!(loaded.revision, 2);
        assert!(loaded.raw_markdown.ends_with("remote local"));
        assert!(!worker.record_inbox(first, 0).await.unwrap());
        let pending = worker.pending_inbox(id.clone()).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].update.op_id, second.op_id);
        ui.apply_remote(&second.update).unwrap();
        let result = worker
            .enqueue_remote(second, 0, ui.revision())
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.revision, 3);
        assert_eq!(
            Document::load(&id, 1, 14, &result.full_state)
                .unwrap()
                .body(),
            ui.body()
        );
    }
    #[tokio::test]
    async fn failed_remote_commit_retries_before_the_following_local_edit() {
        let temp = tempfile::tempdir().unwrap();
        let worker = Durability::open(temp.path().into(), temp.path().join("db"), |_| {})
            .await
            .unwrap();
        let id = Uuid::new_v4().to_string();
        let mut ui = Document::new(&id, 1, 21).unwrap();
        worker
            .create(Create {
                page_id: id.clone(),
                epoch: 1,
                full_state: ui.encode_full(),
                revision: 0,
                after_id: None,
                first_write_date: None,
                frontmatter: None,
                preserved_pair: None,
            })
            .await
            .unwrap();
        let mut remote = Document::load(&id, 1, 22, &ui.encode_full()).unwrap();
        let incoming = PendingUpdate {
            op_id: Uuid::new_v4().to_string(),
            page_id: id.clone(),
            epoch: 1,
            update: remote
                .replace(remote.revision(), 0, 0, "remote", 100)
                .unwrap(),
        };
        worker.record_inbox(incoming.clone(), 0).await.unwrap();
        worker.request(|w|w.store.transaction(|tx|tx.execute_batch("CREATE TRIGGER fail_remote BEFORE UPDATE OF applied ON inbox BEGIN SELECT RAISE(ABORT,'test failed commit'); END").map_err(db)).map_err(error)).await.unwrap();
        ui.apply_remote(&incoming.update).unwrap();
        assert!(worker
            .enqueue_remote(incoming, 0, 1)
            .unwrap()
            .await
            .unwrap()
            .is_err());
        worker
            .enqueue_local(edit(&id, &mut ui, " local").edit)
            .unwrap();
        assert!(worker.flush().await.is_err());
        worker
            .request(|w| {
                w.store
                    .transaction(|tx| tx.execute_batch("DROP TRIGGER fail_remote").map_err(db))
                    .map_err(error)
            })
            .await
            .unwrap();
        worker.flush().await.unwrap();
        let final_state = worker.load(id).await.unwrap();
        assert_eq!(final_state.revision, 2);
        assert!(final_state.raw_markdown.ends_with("remote local"));
    }
    #[test]
    fn directory_commit_remains_observable_when_later_projection_fails() {
        let mut f = fixture();
        let (id, _) = page(&mut f.worker, "old");
        let mut entry = f.worker.entry(&id).unwrap();
        let (md, _) = projection::paths(f.temp.path(), &entry.filename().unwrap()).unwrap();
        std::fs::write(&md, "external preserved").unwrap();
        entry.generation = 1;
        entry.deleted = true;
        entry.registered = true;
        let changed = f.worker.apply_directory(entry).unwrap();
        assert_eq!(changed[0].generation, 1);
        assert!(changed[0].deleted);
        assert_eq!(f.worker.entry(&id).unwrap().generation, 1);
        assert_eq!(std::fs::read_to_string(md).unwrap(), "external preserved");
        assert!(matches!(
            f.events.lock().unwrap().last(),
            Some(DurableEvent::Failed { .. })
        ));
    }
    #[test]
    fn failed_existing_state_load_is_never_treated_as_an_empty_remote_page() {
        let mut f = fixture();
        let (id, mut doc) = page(&mut f.worker, "local draft");
        let update = doc.replace(doc.revision(), 11, 0, " remote", 200).unwrap();
        f.worker
            .store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE documents SET state=?1 WHERE page_id=?2",
                    params![vec![255u8], id],
                )
                .map_err(db)?;
                Ok(())
            })
            .unwrap();
        assert!(f
            .worker
            .receive(
                PendingUpdate {
                    op_id: Uuid::new_v4().to_string(),
                    page_id: id.clone(),
                    epoch: 1,
                    update
                },
                0
            )
            .is_err());
        let raw = f
            .worker
            .store
            .transaction(|tx| {
                tx.query_row("SELECT state FROM documents WHERE page_id=?1", [&id], |r| {
                    r.get::<_, Vec<u8>>(0)
                })
                .map_err(db)
            })
            .unwrap();
        assert_eq!(raw, [255]);
    }
}
