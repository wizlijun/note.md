use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_V1: &str = "vault-knowledge-structure/1";
pub const SCHEMA: &str = "vault-knowledge-structure/2";
pub const SNAPSHOT_PATH: &str = ".notemd/habitat/knowledge-structure.jsonl.zst";
pub const ALGORITHM_VERSION: &str = "habitat-focus/4";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub meta: Meta,
    pub sources: Vec<Source>,
    pub nodes: Vec<Node>,
    pub evidence: Vec<Evidence>,
    pub edges: Vec<Edge>,
    pub memberships: Vec<Membership>,
    pub lineage: Vec<Lineage>,
    pub layout: Vec<Layout>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attention: Vec<Attention>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attention_observations: Vec<AttentionObservation>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Meta {
    pub schema: String,
    pub snapshot_id: String,
    pub state_hash: String,
    pub parents: Vec<String>,
    pub generated_at: String,
    pub vault_id: String,
    pub algorithm: Algorithm,
    pub scope_hash: String,
    pub manifest_hash: String,
    pub structure_hash: String,
    pub evidence_hash: String,
    pub layout_hash: String,
    pub coverage: Coverage,
    pub change_cause: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<FocusContext>,
}

/// Observation context is data, not an algorithm parameter. Advancing this date
/// must not turn the same ranking method into a different algorithm version.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FocusContext {
    pub as_of: String,
    pub window_days: u32,
    /// Fixed offset used to map event timestamps to local calendar dates.
    pub utc_offset_minutes: i32,
}

/// Heuristic attention estimate supported by dated personal observations.
/// Score is normalized within one snapshot; changes are not measures of
/// knowledge growth or a clinical/cognitive assessment of the person.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attention {
    pub node: String,
    pub score: f64,
    pub last_observed_at: String,
    pub active_days: u32,
    pub events: u32,
    pub evidence: Vec<String>,
    /// Candidate classification: a specific concept or broader context.
    pub category: String,
}

/// One date attribution per precisely located evidence unit. The source's
/// existing family identity remains the authority for source deduplication.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionObservation {
    pub evidence: String,
    pub date: String,
    pub event_id: String,
    pub signal: String,
    pub date_basis: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Algorithm {
    pub version: String,
    pub parser_version: String,
    pub tokenizer_version: String,
    pub effective_params: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Coverage {
    pub indexed: usize,
    pub parsed: usize,
    pub unavailable: usize,
    pub excluded: usize,
    pub knowledge_datasets: usize,
    pub imported_records: usize,
    pub knowledge_records: usize,
    pub isolated_records: usize,
    pub unprojected_records: usize,
    pub diagnostic_count: usize,
    pub unassigned_sources: usize,
    pub unresolved_links: usize,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagnostic {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub id: String,
    pub path: String,
    pub hash: String,
    pub role: String,
    pub status: String,
    pub family: String,
    pub family_status: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub id: String,
    /// Stable scoped matching key, not a display label or current content hash.
    pub key: String,
    pub node_type: String,
    pub label: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_status: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Locator {
    pub start: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json_pointer: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub id: String,
    pub source: String,
    /// Source manifest owns the content hash; no duplicate raw text is stored.
    pub locator: Locator,
    pub role: String,
    pub authorship: String,
    pub granularity: String,
    pub verification: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Participant {
    pub node: String,
    pub role: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edge {
    pub id: String,
    pub edge_type: String,
    pub status: String,
    pub participants: Vec<Participant>,
    pub evidence: Vec<String>,
    pub verified_families: usize,
    pub provisional_families: usize,
    pub unresolved_lineage: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Membership {
    pub id: String,
    pub node: String,
    pub topic: String,
    pub role: String,
    pub score: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lineage {
    pub id: String,
    pub change: String,
    pub from: Vec<String>,
    pub to: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub zone: String,
    pub pinned: bool,
}

/// Input fields are supplied by the authorized capture adapter. Raw contents
/// never travel to the UI or enter the Git snapshot.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    pub path: String,
    pub hash: String,
    #[serde(default)]
    pub origin: String,
}

#[derive(Debug, Clone, Default)]
pub struct Extraction {
    pub sources: Vec<Source>,
    pub nodes: Vec<Node>,
    pub evidence: Vec<Evidence>,
    pub edges: Vec<Edge>,
    pub coverage: Coverage,
    /// Sparse non-persisted context terms for organization, keyed by node ID.
    pub features: BTreeMap<String, Vec<String>>,
    pub focus: Option<FocusContext>,
    pub attention_observations: Vec<AttentionObservation>,
    pub attention: Vec<Attention>,
    /// Matched current observations protect learned vocabulary from the
    /// background keyword budget; these are normalized lexical identities.
    pub retained_keywords: std::collections::BTreeSet<String>,
    pub statistical_weights: BTreeMap<String, f64>,
}
