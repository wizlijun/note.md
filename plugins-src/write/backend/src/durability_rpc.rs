//! Typed service dispatcher. Workspace identity/ordering is enforced by the caller.
//! Never route this through an untrusted WebView's ui.request handler.
use crate::durability::Durability;
use serde_json::Value;
use sumi_protocol::durability::Request;

pub async fn dispatch(worker: &Durability, request: Request) -> Result<Value, String> {
    macro_rules! call {
        ($value:expr) => { serde_json::to_value($value.await?).map_err(|error| error.to_string()) };
    }
    match request {
        Request::Create(request) => call!(worker.create(request)),
        Request::Load { page_id } => call!(worker.load(page_id)),
        Request::CommitLocal(edit) => call!(worker.commit_local(edit)),
        Request::CommitRemote { incoming, generation, revision } => call!(worker.commit_remote(incoming, generation, revision)),
        Request::Flush => call!(worker.flush()),
        Request::List => call!(worker.list()),
        Request::Excerpts => call!(worker.excerpts()),
        Request::SetDeleted { page_id, deleted } => call!(worker.set_deleted(page_id, deleted)),
        Request::Preferences { key } => call!(worker.preferences(key)),
        Request::SetPreferences { key, value } => call!(worker.set_preferences(key, value)),
        Request::SaveHeader { page_id, expected_revision, header } => call!(worker.save_header(page_id, expected_revision, header)),
        Request::ReadBaseline { page_id } => call!(worker.read_baseline(page_id)),
        Request::AcceptImportedBaseline { page_id, observed } => call!(worker.accept_imported_baseline(page_id, observed)),
        Request::ImportLocal { edit, observed } => call!(worker.commit_import(edit, observed)),
        Request::ImportProjectionExtensions { page_id, generation, expected_revision, observed } => call!(worker.import_projection_extensions(page_id, generation, expected_revision, observed)),
        Request::RestoreProjection { page_id, generation } => call!(worker.restore_projection(page_id, generation)),
        Request::Outbox => call!(worker.outbox()),
        Request::OutboxCount => call!(worker.outbox_count()),
        Request::DirectoryOutbox => call!(worker.directory_outbox()),
        Request::Ack { op_id } => call!(worker.ack(op_id)),
        Request::AcknowledgeDirectory { op_id } => call!(worker.acknowledge_directory(op_id)),
        Request::ApplyDirectory { entry } => call!(worker.apply_directory(entry)),
        Request::RecordInbox { incoming, generation } => call!(worker.record_inbox(incoming, generation)),
        Request::HasDocument { page_id } => call!(worker.has_document(page_id)),
        Request::AppliedIncoming { receipts } => call!(worker.applied_incoming(receipts)),
        Request::PendingInbox { page_id } => call!(worker.pending_inbox(page_id)),
        Request::ReceiveRemote { incoming, generation } => call!(worker.receive_remote(incoming, generation)),
    }
}
