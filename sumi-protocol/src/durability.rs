//! Shared durable-worker wire types. No worker, network, or RPC transport here.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use write_core::{catalog::Entry, projection::Baseline, storage::{self, FilePair, PendingUpdate}};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Loaded {
    pub entry: Entry,
    pub full_state: Vec<u8>,
    pub revision: u64,
    pub raw_markdown: String,
    pub frontmatter: serde_yaml::Mapping,
    pub sidecar: storage::Sidecar,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalEdit {
    pub page_id: String,
    pub epoch: u32,
    pub generation: u64,
    pub revision: u64,
    pub op_id: String,
    pub update: Vec<u8>,
    pub first_write_date: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outgoing {
    pub update: PendingUpdate,
    pub generation: u64,
    pub first_write_date: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublishedBaseline {
    pub filename: String,
    pub pair: FilePair,
    pub full_state: Vec<u8>,
    pub revision: u64,
    pub hashes: Baseline,
}
/// Captured in one SQLite/projection owner job. Never combine its baseline with
/// a later filesystem read: the worker may publish another revision immediately.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageObservation {
    pub loaded: Loaded,
    pub baseline: Option<PublishedBaseline>,
    pub files: ObservedFiles,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ObservedFiles {
    Unwritten,
    Published { pair: FilePair },
    /// Each file exactly matches the durable pending job's prior or next bytes.
    /// This can be an interrupted two-file write; it is not an external import.
    Pending,
    External { pair: FilePair },
    Unavailable { error: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectionIdentity {
    pub path: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordedIncoming {
    pub update: PendingUpdate,
    pub generation: u64,
}
/// A bounded identity-only query: never copy a potentially large inbox blob.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncomingReceipt {
    pub op_id: String,
    pub page_id: String,
    pub epoch: u32,
    pub generation: u64,
}

/// Every operation is scoped to an authenticated workspace by the service envelope.
/// Only CommitLocal/CommitRemote/ImportLocal carry durable replay identities.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Create(Create),
    Load { page_id: String },
    ObservePage { page_id: String },
    CommitLocal(LocalEdit),
    CommitRemote { incoming: PendingUpdate, generation: u64, revision: u64 },
    Flush,
    List,
    Excerpts,
    SetDeleted { page_id: String, deleted: bool },
    Preferences { key: String },
    SetPreferences { key: String, value: Value },
    SaveHeader { page_id: String, expected_revision: u64, header: serde_yaml::Mapping },
    ReadBaseline { page_id: String },
    AcceptImportedBaseline { page_id: String, observed: FilePair },
    ImportLocal { edit: LocalEdit, observed: FilePair },
    ImportProjectionExtensions { page_id: String, generation: u64, expected_revision: u64, observed: FilePair },
    RestoreProjection { page_id: String, generation: u64 },
    Outbox,
    OutboxCount,
    DirectoryOutbox,
    Ack { op_id: String },
    AcknowledgeDirectory { op_id: String },
    ApplyDirectory { entry: Entry },
    RecordInbox { incoming: PendingUpdate, generation: u64 },
    HasDocument { page_id: String },
    AppliedIncoming { receipts: Vec<IncomingReceipt> },
    PendingInbox { page_id: String },
    ReceiveRemote { incoming: PendingUpdate, generation: u64 },
}

/// Proves this exact operation committed, even if a later edit is already durable.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitReceipt {
    pub op_id: String,
    pub page_id: String,
    pub epoch: u32,
    pub generation: u64,
    pub revision: u64,
    pub digest: String,
}

/// Versioned digest shared by the producer and SQLite receipt writer.
/// Changing this wire identity requires a protocol migration, not a silent retry.
pub fn edit_receipt(edit: &LocalEdit, remote: bool, imported: Option<&FilePair>) -> Result<CommitReceipt, String> {
    if edit.op_id.is_empty() || edit.op_id.len() > 512 { return Err("invalid operation ID".into()); }
    let payload = serde_json::to_vec(&(1u8, remote, edit, imported)).map_err(|e| e.to_string())?;
    Ok(CommitReceipt { op_id: edit.op_id.clone(), page_id: edit.page_id.clone(), epoch: edit.epoch,
        generation: edit.generation, revision: edit.revision, digest: storage::sha256(&payload) })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommittedImport {
    pub receipt: CommitReceipt,
    pub loaded: Loaded,
}
