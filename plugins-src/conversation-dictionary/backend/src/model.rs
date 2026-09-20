use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const DICTIONARY_SCHEMA: &str = "notemd.conversation-dictionary.v1";
pub const SETTINGS_SCHEMA: &str = "notemd.conversation-dictionary-settings.v1";
pub const DATASET_SCHEMA: &str = "notemd.conversation-dictionary-dataset.v1";
pub const DEFAULT_DICTIONARY_PATH: &str = "ssot/meetings/conversation-dictionary.yml";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    pub schema: String,
    pub dictionary_path: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema: SETTINGS_SCHEMA.into(),
            dictionary_path: DEFAULT_DICTIONARY_PATH.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Dictionary {
    pub schema: String,
    pub dictionary_id: String,
    pub revision: u64,
    pub updated_at: String,
    pub subject_id: String,
    pub scope: String,
    #[serde(default)]
    pub domains: Vec<Domain>,
    #[serde(default)]
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Domain {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub kind: EntryKind,
    pub label: String,
    pub forms: Vec<String>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Person,
    Product,
    Organization,
    Project,
    Acronym,
    TechnicalTerm,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub domain_id: String,
    pub observed: String,
    pub action: RuleAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<RuleTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<RuleApplication>,
    pub enabled: bool,
    pub confirmed_by: String,
    pub confirmed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleAction {
    Replace,
    Preserve,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleTarget {
    pub entry_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleApplication {
    Suggest,
    Automatic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceContext {
    pub subject_id: String,
    pub communication: CommunicationContext,
    #[serde(default)]
    pub source: Option<SourceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommunicationContext {
    pub kind: CommunicationKind,
    pub user_relation: UserRelation,
    pub basis: ScopeBasis,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommunicationKind {
    Meeting,
    Call,
    VoiceMessage,
    Conversation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UserRelation {
    Participant,
    DirectRecipient,
    Consumer,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScopeBasis {
    #[serde(rename = "type")]
    pub kind: ScopeBasisKind,
    pub detail: String,
    #[serde(default)]
    pub resource: Option<String>,
    #[serde(default)]
    pub resource_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScopeBasisKind {
    UserStatement,
    SourceMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceRef {
    #[serde(default)]
    pub resource: Option<String>,
    pub content_kind: ContentKind,
    pub content_sha256: String,
    pub span: TextSpan,
    #[serde(default)]
    pub distribution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContentKind {
    AsrTranscript,
    DerivedText,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TextSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolveRequest {
    pub context: SourceContext,
    pub domain_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolveResult {
    pub schema: String,
    pub status: String,
    pub original: String,
    pub preview: String,
    pub dictionary_revision: u64,
    #[serde(default)]
    pub applied: Vec<ResolvedMatch>,
    #[serde(default)]
    pub suggestions: Vec<ResolvedMatch>,
    #[serde(default)]
    pub conflicts: Vec<ResolveConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedMatch {
    pub rule_id: String,
    pub span: TextSpan,
    pub observed: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolveConflict {
    pub span: TextSpan,
    pub observed: String,
    pub rule_ids: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalInput {
    pub schema: String,
    pub observed: String,
    pub domain_id: String,
    pub context: SourceContext,
    #[serde(default)]
    pub source: Option<CandidateSource>,
    #[serde(default)]
    pub candidates: Vec<CandidateSuggestion>,
    pub proposed_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CandidateSuggestion {
    pub output: String,
    pub kind: EntryKind,
    #[serde(default)]
    pub existing_entry_id: Option<String>,
    pub confidence: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CandidateSource {
    #[serde(default)]
    pub resource: Option<String>,
    pub content_kind: ContentKind,
    pub content_sha256: String,
    pub span: TextSpan,
    pub excerpt: String,
    pub excerpt_span: TextSpan,
    #[serde(default)]
    pub distribution: Option<String>,
    #[serde(default)]
    pub locator: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CandidateRecord {
    pub id: String,
    pub hash: String,
    pub status: CandidateStatus,
    pub received_at: String,
    #[serde(flatten)]
    pub proposal: ProposalInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CandidateStatus {
    Pending,
    ScopePending,
    AcceptedWithRule,
    Dismissed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Dataset {
    pub schema: String,
    pub run_id: String,
    pub subject_id: String,
    pub state: DatasetState,
    pub base_dictionary: DatasetBase,
    pub coverage: Coverage,
    pub evidence_file: EvidenceFile,
    #[serde(default)]
    pub sources: Vec<DatasetSource>,
    #[serde(default)]
    pub proposals: Vec<DatasetProposal>,
    #[serde(default)]
    pub conflicts: Vec<Value>,
    #[serde(default)]
    pub unresolved: Vec<Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvidenceFile {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatasetState {
    Completed,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatasetBase {
    pub state: String,
    #[serde(default)]
    pub dictionary_id: Option<String>,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Coverage {
    pub discovered: u64,
    pub processed: u64,
    pub excluded: u64,
    pub unknown_scope: u64,
    pub failed: u64,
    #[serde(default)]
    pub pending: u64,
    pub chunks_planned: u64,
    pub chunks_processed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatasetSource {
    pub id: String,
    pub canonical_source_id: String,
    pub resource: String,
    pub content_sha256: String,
    pub status: String,
    #[serde(default)]
    pub eligible_ranges: Vec<[usize; 2]>,
    #[serde(default)]
    pub processed_ranges: Vec<[usize; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DatasetProposal {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub value: Value,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Baseline {
    pub dictionary_id: String,
    pub revision: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewBatch {
    pub run_id: String,
    pub dataset_sha256: String,
    pub imported_at: String,
    pub dataset: Dataset,
    #[serde(default)]
    pub proposal_states: BTreeMap<String, ProposalReview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalReview {
    pub revision: u64,
    pub status: ProposalReviewStatus,
    #[serde(default)]
    pub permanent_id: Option<String>,
    #[serde(default)]
    pub edited_value: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalReviewStatus {
    Pending,
    Accepted,
    Dismissed,
}

impl Default for ProposalReview {
    fn default() -> Self {
        Self {
            revision: 1,
            status: ProposalReviewStatus::Pending,
            permanent_id: None,
            edited_value: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ControlState {
    #[serde(default)]
    pub baseline: Option<Baseline>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_dictionary: Option<String>,
    #[serde(default)]
    pub candidates: Vec<CandidateRecord>,
    #[serde(default)]
    pub batches: Vec<ReviewBatch>,
    #[serde(default)]
    pub transactions: BTreeMap<String, TransactionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransactionRecord {
    pub plan_hash: String,
    pub completed_at: String,
    pub revision: u64,
    pub result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BatchCommitRequest {
    pub run_id: String,
    pub dataset_sha256: String,
    pub transaction_id: String,
    pub expected_dictionary_revision: u64,
    pub expected_dictionary_sha256: String,
    pub selected: Vec<SelectedProposal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SelectedProposal {
    pub id: String,
    pub review_revision: u64,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NormalizeFormalNamesRequest {
    pub transaction_id: String,
    pub expected_revision: u64,
    pub expected_sha256: String,
    pub formal_names: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SaveCorrectionEntryRequest {
    pub transaction_id: String,
    pub expected_revision: u64,
    pub expected_sha256: String,
    #[serde(default)]
    pub domain_id: Option<String>,
    pub domain_name: String,
    #[serde(default)]
    pub entry_id: Option<String>,
    pub kind: EntryKind,
    pub formal_name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub mistaken_forms: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeleteCorrectionEntryRequest {
    pub transaction_id: String,
    pub expected_revision: u64,
    pub expected_sha256: String,
    pub domain_id: String,
    pub entry_id: String,
    #[serde(default)]
    pub delete_globally: bool,
}
