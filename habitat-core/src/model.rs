use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA: &str = "vault-knowledge-structure/1";
pub const SNAPSHOT_PATH: &str = ".notemd/habitat/knowledge-structure.jsonl.zst";
pub const ALGORITHM_VERSION: &str = "habitat-keyword/2";

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
}
