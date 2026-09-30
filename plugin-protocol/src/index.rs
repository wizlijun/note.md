//! Read-only, capability-gated index wire contract. Dates are inclusive indexed
//! document dates; omitted range creates a metadata-only atlas snapshot.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexRange {
    pub from: String,
    pub to: String,
    pub date_kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexSnapshotParams {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<IndexRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_size: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexBlocksParams {
    pub version: u32,
    pub snapshot_id: String,
    pub file_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct IndexWeights {
    pub human: f64,
    pub derived: f64,
    pub source: f64,
    pub unlabeled: f64,
    pub attention: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct IndexPriorityFactors {
    pub structural: f64,
    pub annotation: f64,
    pub verified: f64,
    pub origin: f64,
    pub attention: f64,
    pub agent: f64,
    pub freshness: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexPriorityBasis {
    pub aggregation: String,
    pub block_key: String,
    pub factors: IndexPriorityFactors,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct IndexLink {
    pub kind: String,
    pub target: String,
    pub line: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexFile {
    pub file_key: String,
    pub path: String,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concept_type: Option<String>,
    pub tags: Vec<String>,
    pub doc_date: Option<String>,
    pub date_inferred: bool,
    pub index_origin: String,
    pub human_verified: bool,
    pub confidentiality: String,
    pub attention_minutes: f64,
    pub links: Vec<IndexLink>,
    pub file_priority: f64,
    pub priority_basis: Option<IndexPriorityBasis>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct IndexCoverage {
    pub indexed: usize,
    pub selected: usize,
    pub stale: usize,
    pub excluded: usize,
    pub undated: usize,
    pub skipped: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexSnapshotResult {
    pub snapshot_id: String,
    pub config_hash: String,
    pub as_of: String,
    pub index_generation: String,
    pub policy_version: String,
    pub mode: String,
    pub effective_weights: IndexWeights,
    pub files: Vec<IndexFile>,
    pub coverage: IndexCoverage,
    pub freshness: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexUnit {
    pub file_key: String,
    pub content_hash: String,
    pub block_key: String,
    pub line_start: u32,
    pub line_end: u32,
    pub breadcrumb: String,
    pub text: String,
    pub level: String,
    pub is_annotation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_by: Option<String>,
    pub priority: f64,
    pub priority_factors: IndexPriorityFactors,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexConflict {
    pub file_key: String,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexBlocksResult {
    pub snapshot_id: String,
    pub units: Vec<IndexUnit>,
    pub conflicts: Vec<IndexConflict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexStatusParams {
    pub version: u32,
    pub snapshot_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusResult {
    pub snapshot_id: String,
    pub freshness: String,
    pub valid: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
