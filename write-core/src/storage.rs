//! Durable document state is committed before either portable file is projected.
use crate::{Document, Error, Result, Snapshot};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
use uuid::Uuid;
use yrs::updates::decoder::Decode;

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineMeta {
    pub id: String,
    pub text_sha256: String,
    pub first_written_at: Option<String>,
    pub last_written_at: Option<String>,
    pub time_source: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sidecar {
    pub schema: u32,
    pub page_id: String,
    pub epoch: u32,
    pub projection_id: String,
    pub body_sha256: String,
    pub root_line_id: String,
    pub lines: Vec<LineMeta>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePair {
    pub markdown: String,
    pub metadata: String,
}
#[derive(Debug, Clone)]
pub struct ParsedPair {
    pub body: String,
    pub sidecar: Sidecar,
    pub frontmatter: serde_yaml::Mapping,
}
fn timestamp(ms: Option<i64>) -> Result<Option<String>> {
    ms.map(|t| {
        DateTime::<Utc>::from_timestamp_millis(t)
            .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
            .ok_or_else(|| Error::Invalid("timestamp range".into()))
    })
    .transpose()
}
pub fn serialize_pair(
    snapshot: &Snapshot,
    frontmatter: Option<&serde_yaml::Mapping>,
    prior: Option<&Sidecar>,
) -> Result<FilePair> {
    let mut header = frontmatter.cloned().unwrap_or_default();
    for (key, value) in [
        ("type", serde_yaml::Value::String("Writing Page".into())),
        ("write_schema", serde_yaml::Value::Number(1.into())),
        ("page_id", snapshot.page_id.clone().into()),
        (
            "write_epoch",
            serde_yaml::Value::Number(snapshot.epoch.into()),
        ),
        ("write_metadata", "sidecar-v1".into()),
    ] {
        header.insert(key.into(), value);
    }
    let markdown = format!(
        "---\n{}---\n{}",
        serde_yaml::to_string(&header).map_err(|e| Error::Invalid(e.to_string()))?,
        snapshot.body
    );
    let prior_lines: std::collections::HashMap<_, _> = prior
        .into_iter()
        .flat_map(|p| &p.lines)
        .map(|l| (l.id.as_str(), l))
        .collect();
    let mut lines = Vec::new();
    for line in &snapshot.lines {
        lines.push(LineMeta {
            id: line.id.clone(),
            text_sha256: sha256(line.text.as_bytes()),
            first_written_at: timestamp(line.first_ms)?,
            last_written_at: timestamp(line.last_ms)?,
            time_source: line.time_source.clone(),
            extra: prior_lines
                .get(line.id.as_str())
                .map(|l| l.extra.clone())
                .unwrap_or_default(),
        });
    }
    if prior.is_some_and(|p| p.page_id != snapshot.page_id || p.epoch != snapshot.epoch) {
        return Err(Error::Invalid("prior metadata identity mismatch".into()));
    }
    let metadata = Sidecar {
        schema: 1,
        page_id: snapshot.page_id.clone(),
        epoch: snapshot.epoch,
        projection_id: Uuid::new_v4().to_string(),
        body_sha256: sha256(snapshot.body.as_bytes()),
        root_line_id: snapshot.root_line_id.clone(),
        lines,
        extra: prior.map(|p| p.extra.clone()).unwrap_or_default(),
    };
    Ok(FilePair {
        markdown,
        metadata: serde_json::to_string_pretty(&metadata)?,
    })
}
pub fn parse_pair(markdown: &str, metadata: &str) -> Result<ParsedPair> {
    if !markdown.starts_with("---\n") {
        return Err(Error::Invalid("frontmatter missing".into()));
    }
    let end = markdown[4..]
        .find("\n---\n")
        .ok_or_else(|| Error::Invalid("frontmatter incomplete".into()))?
        + 4;
    let header: serde_yaml::Mapping =
        serde_yaml::from_str(&markdown[4..end]).map_err(|e| Error::Invalid(e.to_string()))?;
    let body = &markdown[end + 5..];
    if body.encode_utf16().count() > crate::MAX_BODY_UTF16 as usize {
        return Err(Error::Capacity);
    }
    if body.contains('\r') {
        return Err(Error::Invalid(
            "CRLF requires explicit import normalization".into(),
        ));
    }
    if end > 128 * 1024 || metadata.len() > 64 * 1024 * 1024 {
        return Err(Error::Capacity);
    }
    let sidecar: Sidecar = serde_json::from_str(metadata)?;
    let field = |k: &str| header.get(serde_yaml::Value::String(k.into()));
    if field("type").and_then(|v| v.as_str()) != Some("Writing Page")
        || field("write_metadata").and_then(|v| v.as_str()) != Some("sidecar-v1")
        || field("write_schema").and_then(|v| v.as_u64()) != Some(1)
        || sidecar.schema != 1
        || field("page_id").and_then(|v| v.as_str()) != Some(&sidecar.page_id)
        || field("write_epoch").and_then(|v| v.as_u64()) != Some(sidecar.epoch as u64)
        || sidecar.epoch == 0
    {
        return Err(Error::Invalid("identity/schema mismatch".into()));
    }
    if sha256(body.as_bytes()) != sidecar.body_sha256 {
        return Err(Error::Invalid(
            "body hash mismatch; external import required".into(),
        ));
    }
    let actual: Vec<_> = body.split('\n').collect();
    if actual.len() != sidecar.lines.len()
        || sidecar.lines.first().map(|l| &l.id) != Some(&sidecar.root_line_id)
    {
        return Err(Error::Invalid("line count/root mismatch".into()));
    }
    let mut ids = std::collections::HashSet::new();
    for (text, line) in actual.into_iter().zip(&sidecar.lines) {
        if Uuid::parse_str(&line.id).is_err()
            || !ids.insert(&line.id)
            || sha256(text.as_bytes()) != line.text_sha256
        {
            return Err(Error::Invalid("line identity/hash mismatch".into()));
        }
        for t in [&line.first_written_at, &line.last_written_at]
            .into_iter()
            .flatten()
        {
            DateTime::parse_from_rfc3339(t).map_err(|_| Error::Invalid("invalid time".into()))?;
        }
    }
    Ok(ParsedPair {
        body: body.into(),
        sidecar,
        frontmatter: header,
    })
}

/// Restore the verified portable pair into a new page identity, never into the
/// original epoch whose causal history is absent from these two files.
pub fn fork_pair(pair: &FilePair, new_page_id: &str, client_id: u64) -> Result<Document> {
    let parsed = parse_pair(&pair.markdown, &pair.metadata)?;
    let parse_time = |s: &Option<String>| {
        s.as_ref()
            .map(|s| {
                DateTime::parse_from_rfc3339(s)
                    .map(|t| t.timestamp_millis())
                    .map_err(|_| Error::Invalid("invalid time".into()))
            })
            .transpose()
    };
    let lines = parsed
        .body
        .split('\n')
        .zip(&parsed.sidecar.lines)
        .map(|(text, meta)| {
            Ok(crate::LineSnapshot {
                id: meta.id.clone(),
                text: text.into(),
                first_ms: parse_time(&meta.first_written_at)?,
                last_ms: parse_time(&meta.last_written_at)?,
                time_source: meta.time_source.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Document::fork_snapshot(
        &Snapshot {
            page_id: parsed.sidecar.page_id,
            epoch: parsed.sidecar.epoch,
            revision: 0,
            body: parsed.body,
            root_line_id: parsed.sidecar.root_line_id,
            lines,
        },
        new_page_id,
        client_id,
    )
}

fn validate_projection(snapshot: &Snapshot, pair: &FilePair) -> Result<()> {
    let parsed = parse_pair(&pair.markdown, &pair.metadata)?;
    if parsed.body != snapshot.body
        || parsed.sidecar.page_id != snapshot.page_id
        || parsed.sidecar.epoch != snapshot.epoch
        || parsed.sidecar.root_line_id != snapshot.root_line_id
        || parsed.sidecar.lines.len() != snapshot.lines.len()
    {
        return Err(Error::Invalid(
            "projection differs from committed state".into(),
        ));
    }
    for (saved, live) in parsed.sidecar.lines.iter().zip(&snapshot.lines) {
        if saved.id != live.id
            || saved.first_written_at != timestamp(live.first_ms)?
            || saved.last_written_at != timestamp(live.last_ms)?
            || saved.time_source != live.time_source
        {
            return Err(Error::Invalid(
                "projection metadata differs from committed state".into(),
            ));
        }
    }
    Ok(())
}

pub struct Store {
    connection: Connection,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingUpdate {
    pub op_id: String,
    pub page_id: String,
    pub epoch: u32,
    pub update: Vec<u8>,
}
impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path).map_err(db)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(db)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(db)?;
        // A backend receipt lets the host retire its input journal. On macOS,
        // flush the device cache too, not only the OS buffers, before that ACK.
        connection.pragma_update(None, "fullfsync", true).map_err(db)?;
        connection.pragma_update(None, "checkpoint_fullfsync", true).map_err(db)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS documents(page_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,state BLOB NOT NULL,revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS outbox(op_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,epoch INTEGER NOT NULL,update_blob BLOB NOT NULL); CREATE TABLE IF NOT EXISTS inbox(op_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,epoch INTEGER NOT NULL,update_blob BLOB NOT NULL,applied INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS projections(page_id TEXT PRIMARY KEY,markdown TEXT NOT NULL,metadata TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0);").map_err(db)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS document_deltas(page_id TEXT NOT NULL,epoch INTEGER NOT NULL,revision INTEGER NOT NULL,op_id TEXT NOT NULL UNIQUE,update_blob BLOB NOT NULL,PRIMARY KEY(page_id,revision)) WITHOUT ROWID;").map_err(db)?;
        Ok(Self { connection })
    }
    pub fn commit_local(
        &mut self,
        doc: &Document,
        op_id: &str,
        update: &[u8],
        pair: &FilePair,
    ) -> Result<()> {
        self.commit_local_with(doc, op_id, update, pair, |_| Ok(()))
    }
    /// Host catalog mutations participate in the same durable transaction as the document/outbox.
    pub fn commit_local_with<F>(
        &mut self,
        doc: &Document,
        op_id: &str,
        update: &[u8],
        pair: &FilePair,
        extra: F,
    ) -> Result<()>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<()>,
    {
        let snapshot = doc.snapshot()?;
        validate_projection(&snapshot, pair)?;
        let txn = self.connection.transaction().map_err(db)?;
        write_checkpoint(&txn, &snapshot, &doc.encode_full(), pair)?;
        txn.execute(
            "INSERT INTO outbox VALUES(?1,?2,?3,?4)",
            params![op_id, snapshot.page_id, snapshot.epoch, update],
        )
        .map_err(db)?;
        extra(&txn)?;
        txn.commit().map_err(db)
    }
    pub fn transaction<T, F>(&mut self, f: F) -> Result<T>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<T>,
    {
        let txn = self.connection.transaction().map_err(db)?;
        let result = f(&txn)?;
        txn.commit().map_err(db)?;
        Ok(result)
    }
    /// Read a checkpoint and its complete delta tail under one SQLite snapshot.
    /// Deltas were accepted by the live core before commit, but replay still
    /// validates combined semantics and fails closed on gaps or corruption.
    pub fn load(&self, page_id: &str, client_id: u64) -> Result<Document> {
        let txn = self.connection.unchecked_transaction().map_err(db)?;
        let (epoch, bytes, revision): (u32, Vec<u8>, i64) = txn
            .query_row(
                "SELECT epoch,state,revision FROM documents WHERE page_id=?1",
                [page_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(db)?;
        let mut doc = Document::restore(
            page_id,
            epoch,
            client_id,
            &bytes,
            u64::try_from(revision).map_err(|_| Error::Invalid("negative revision".into()))?,
        )?;
        {
            let mut statement = txn.prepare("SELECT epoch,revision,update_blob FROM document_deltas WHERE page_id=?1 ORDER BY revision").map_err(db)?;
            let mut rows = statement.query([page_id]).map_err(db)?;
            while let Some(row) = rows.next().map_err(db)? {
                let delta_epoch: u32 = row.get(0).map_err(db)?;
                let revision: i64 = row.get(1).map_err(db)?;
                let bytes: Vec<u8> = row.get(2).map_err(db)?;
                if delta_epoch != epoch {
                    return Err(Error::Invalid("delta epoch mismatch".into()));
                }
                let update =
                    yrs::Update::decode_v1(&bytes).map_err(|e| Error::Invalid(e.to_string()))?;
                if crate::document::update_actors(&update).contains_key(&client_id) {
                    return Err(Error::Invalid(
                        "client ID already exists in durable delta state".into(),
                    ));
                }
                doc.apply_confirmed_update(
                    u64::try_from(revision)
                        .map_err(|_| Error::Invalid("negative revision".into()))?,
                    &bytes,
                )?;
            }
        }
        txn.commit().map_err(db)?;
        Ok(doc)
    }
    /// Commit an already-validated local transaction without encoding any full
    /// state or projection. Host generation/dirty markers belong in `extra`.
    pub fn commit_local_delta_with<F>(
        &mut self,
        page_id: &str,
        epoch: u32,
        revision: u64,
        op_id: &str,
        update: &[u8],
        extra: F,
    ) -> Result<()>
    where
        F: FnOnce(&Transaction<'_>) -> Result<()>,
    {
        let txn = self.connection.transaction().map_err(db)?;
        append_delta(&txn, page_id, epoch, revision, op_id, update)?;
        txn.execute(
            "INSERT INTO outbox VALUES(?1,?2,?3,?4)",
            params![op_id, page_id, epoch, update],
        )
        .map_err(db)?;
        extra(&txn)?;
        txn.commit().map_err(db)
    }
    /// Commit a previously received and live-core-validated remote transaction.
    pub fn commit_remote_delta_with<F>(
        &mut self,
        page_id: &str,
        epoch: u32,
        revision: u64,
        op_id: &str,
        update: &[u8],
        extra: F,
    ) -> Result<()>
    where
        F: FnOnce(&Transaction<'_>) -> Result<()>,
    {
        let txn = self.connection.transaction().map_err(db)?;
        append_delta(&txn, page_id, epoch, revision, op_id, update)?;
        let changed = txn.execute("UPDATE inbox SET applied=1 WHERE op_id=?1 AND page_id=?2 AND epoch=?3 AND update_blob=?4 AND applied=0",
            params![op_id,page_id,epoch,update]).map_err(db)?;
        if changed != 1 {
            return Err(Error::Invalid(
                "remote delta was not received exactly once".into(),
            ));
        }
        extra(&txn)?;
        txn.commit().map_err(db)
    }
    /// Replace the exact current durable head with a full checkpoint and portable
    /// pair, atomically pruning only its covered deltas. No inbox/outbox changes.
    pub fn checkpoint_with<F>(&mut self, doc: &Document, pair: &FilePair, extra: F) -> Result<()>
    where
        F: FnOnce(&Transaction<'_>) -> Result<()>,
    {
        let snapshot = doc.snapshot()?;
        validate_projection(&snapshot, pair)?;
        let state = doc.encode_full();
        let txn = self.connection.transaction().map_err(db)?;
        if durable_head(&txn, &snapshot.page_id)?
            != Some((snapshot.epoch, sql_revision(snapshot.revision)?))
        {
            return Err(Error::StaleRevision);
        }
        write_checkpoint(&txn, &snapshot, &state, pair)?;
        extra(&txn)?;
        txn.commit().map_err(db)
    }
    pub fn outbox(&self) -> Result<Vec<PendingUpdate>> {
        let mut stmt = self
            .connection
            .prepare("SELECT op_id,page_id,epoch,update_blob FROM outbox ORDER BY rowid")
            .map_err(db)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PendingUpdate {
                    op_id: r.get(0)?,
                    page_id: r.get(1)?,
                    epoch: r.get(2)?,
                    update: r.get(3)?,
                })
            })
            .map_err(db)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(db)
    }
    pub fn ack(&self, op_id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM outbox WHERE op_id=?1", [op_id])
            .map_err(db)?;
        Ok(())
    }
    /// Incoming bytes survive IME composition before they are integrated into the active view.
    pub fn receive(&self, p: &PendingUpdate) -> Result<()> {
        if let Ok((page, epoch, bytes)) = self.connection.query_row(
            "SELECT page_id,epoch,update_blob FROM inbox WHERE op_id=?1",
            [&p.op_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            },
        ) {
            if page != p.page_id || epoch != p.epoch || bytes != p.update {
                return Err(Error::Invalid("operation ID reused".into()));
            }
            return Ok(());
        }
        self.connection
            .execute(
                "INSERT INTO inbox(op_id,page_id,epoch,update_blob) VALUES(?1,?2,?3,?4)",
                params![p.op_id, p.page_id, p.epoch, p.update],
            )
            .map_err(db)?;
        Ok(())
    }
    pub fn pending_inbox(&self, page_id: &str) -> Result<Vec<PendingUpdate>> {
        let mut s=self.connection.prepare("SELECT op_id,page_id,epoch,update_blob FROM inbox WHERE applied=0 AND page_id=?1 ORDER BY rowid").map_err(db)?;
        let rows = s
            .query_map([page_id], |r| {
                Ok(PendingUpdate {
                    op_id: r.get(0)?,
                    page_id: r.get(1)?,
                    epoch: r.get(2)?,
                    update: r.get(3)?,
                })
            })
            .map_err(db)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(db)
    }
    pub fn commit_remote(
        &mut self,
        doc: &Document,
        op_ids: &[String],
        pair: &FilePair,
    ) -> Result<()> {
        self.commit_remote_with(doc, op_ids, pair, |_| Ok(()))
    }
    pub fn commit_remote_with<F>(
        &mut self,
        doc: &Document,
        op_ids: &[String],
        pair: &FilePair,
        extra: F,
    ) -> Result<()>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<()>,
    {
        let snapshot = doc.snapshot()?;
        validate_projection(&snapshot, pair)?;
        let txn = self.connection.transaction().map_err(db)?;
        write_checkpoint(&txn, &snapshot, &doc.encode_full(), pair)?;
        for id in op_ids {
            let n = txn
                .execute(
                    "UPDATE inbox SET applied=1 WHERE op_id=?1 AND page_id=?2 AND epoch=?3",
                    params![id, snapshot.page_id, snapshot.epoch],
                )
                .map_err(db)?;
            if n != 1 {
                return Err(Error::Invalid("remote operation not received".into()));
            }
        }
        extra(&txn)?;
        txn.commit().map_err(db)
    }
}
fn db(e: rusqlite::Error) -> Error {
    Error::Invalid(format!("storage: {e}"))
}

fn sql_revision(revision: u64) -> Result<i64> {
    i64::try_from(revision).map_err(|_| Error::Invalid("revision overflow".into()))
}
fn durable_head(txn: &Transaction<'_>, page_id: &str) -> Result<Option<(u32, i64)>> {
    txn.query_row("SELECT epoch,MAX(revision,COALESCE((SELECT MAX(revision) FROM document_deltas WHERE page_id=documents.page_id),revision)) FROM documents WHERE page_id=?1",
        [page_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(db)
}
fn append_delta(
    txn: &Transaction<'_>,
    page_id: &str,
    epoch: u32,
    revision: u64,
    op_id: &str,
    update: &[u8],
) -> Result<()> {
    let revision = sql_revision(revision)?;
    let (saved_epoch, head) = durable_head(txn, page_id)?
        .ok_or_else(|| Error::Invalid("delta requires initial checkpoint".into()))?;
    if saved_epoch != epoch || head.checked_add(1) != Some(revision) {
        return Err(Error::StaleRevision);
    }
    txn.execute(
        "INSERT INTO document_deltas VALUES(?1,?2,?3,?4,?5)",
        params![page_id, epoch, revision, op_id, update],
    )
    .map_err(db)?;
    Ok(())
}
fn write_checkpoint(
    txn: &Transaction<'_>,
    snapshot: &Snapshot,
    state: &[u8],
    pair: &FilePair,
) -> Result<()> {
    let revision = sql_revision(snapshot.revision)?;
    if durable_head(txn, &snapshot.page_id)?
        .is_some_and(|(epoch, head)| epoch != snapshot.epoch || head > revision)
    {
        return Err(Error::StaleRevision);
    }
    txn.execute("INSERT INTO documents VALUES(?1,?2,?3,?4) ON CONFLICT(page_id) DO UPDATE SET epoch=excluded.epoch,state=excluded.state,revision=excluded.revision",
        params![snapshot.page_id,snapshot.epoch,state,revision]).map_err(db)?;
    txn.execute(
        "DELETE FROM document_deltas WHERE page_id=?1 AND revision<=?2",
        params![snapshot.page_id, revision],
    )
    .map_err(db)?;
    txn.execute("INSERT INTO projections VALUES(?1,?2,?3,0) ON CONFLICT(page_id) DO UPDATE SET markdown=excluded.markdown,metadata=excluded.metadata,complete=0",
        params![snapshot.page_id,pair.markdown,pair.metadata]).map_err(db)?;
    Ok(())
}
