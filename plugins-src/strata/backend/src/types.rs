use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DateRange {
    pub from: String,
    pub to: String,
}
impl DateRange {
    pub fn validate(&self) -> Result<(), String> {
        for date in [&self.from, &self.to] {
            let parsed = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map_err(|_| "日期必须为 YYYY-MM-DD")?;
            if parsed.format("%Y-%m-%d").to_string() != *date {
                return Err("日期必须为 YYYY-MM-DD".into());
            }
        }
        if self.from > self.to {
            return Err("开始日期不能晚于结束日期".into());
        }
        Ok(())
    }
    pub fn contains(&self, date: &str) -> bool {
        date >= self.from.as_str() && date <= self.to.as_str()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub file_key: String,
    pub path: String,
    pub content_hash: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub concept_type: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub doc_date: Option<String>,
    #[serde(default)]
    pub date_inferred: bool,
    pub index_origin: String,
    #[serde(default)]
    pub human_verified: bool,
    #[serde(default)]
    pub attention_minutes: f64,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub file_priority: f64,
    #[serde(default)]
    pub priority_basis: Option<Value>,
    #[serde(default)]
    pub confidentiality: Confidentiality,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub kind: String,
    pub target: String,
    #[serde(default)]
    pub line: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Confidentiality {
    Confidential,
    ExplicitlyPublic,
    #[default]
    Unknown,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OwnerSpecificity {
    OwnerSpecific,
    General,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    pub file_key: String,
    pub content_hash: String,
    pub block_key: String,
    pub line_start: u32,
    pub line_end: u32,
    pub text: String,
    #[serde(default)]
    pub breadcrumb: String,
    pub level: String,
    #[serde(default)]
    pub is_annotation: bool,
    #[serde(default)]
    pub agent_by: Option<String>,
    pub priority: f64,
    #[serde(default)]
    pub priority_factors: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub id: String,
    pub source_id: String,
    pub path: String,
    pub content_hash: String,
    pub block_key: String,
    pub line_start: u32,
    pub line_end: u32,
    pub quote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSupport {
    pub group_id: String,
    pub group_version: String,
    pub priority: f64,
    pub dates: Vec<String>,
    pub canonical_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub title: String,
    pub kind: String,
    /// "verified" means schema and exact quotation checked, not proven true.
    pub state: String,
    pub features: Vec<String>,
    pub links: Vec<String>,
    pub owner_specificity: OwnerSpecificity,
    pub confidentiality: Confidentiality,
    pub classification_reason: String,
    pub epistemic: String,
    pub speaker: Option<String>,
    pub conditions: Vec<String>,
    pub limits: Vec<String>,
    pub source_groups: Vec<SourceSupport>,
    pub evidence: Vec<Evidence>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub id: String,
    pub source: String,
    pub target: String,
    pub r#type: String,
    pub title: String,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub indexed: usize,
    pub selected: usize,
    pub processed: usize,
    pub candidate: usize,
    pub excluded: usize,
    pub stale: usize,
    pub date_inferred: usize,
    pub confidential: usize,
    pub unknown_confidentiality: usize,
    pub proof_deferred: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema: &'static str,
    pub vault_key: String,
    pub snapshot_id: String,
    pub config_hash: String,
    pub as_of: String,
    pub range: DateRange,
    pub files: Vec<File>,
    pub nodes: Vec<Node>,
    pub relations: Vec<Relation>,
    pub coverage: Coverage,
    pub job: Option<Job>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    #[serde(default = "default_files")]
    pub max_files: usize,
    #[serde(default = "default_bytes")]
    pub max_bytes: usize,
    #[serde(default = "default_seconds")]
    pub max_seconds: u64,
}
fn default_files() -> usize {
    120
}
fn default_bytes() -> usize {
    2 * 1024 * 1024
}
fn default_seconds() -> u64 {
    1800
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            max_files: default_files(),
            max_bytes: default_bytes(),
            max_seconds: default_seconds(),
        }
    }
}
impl Budget {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=500).contains(&self.max_files)
            || !(256..=8 * 1024 * 1024).contains(&self.max_bytes)
            || !(10..=3600).contains(&self.max_seconds)
        {
            return Err("预算范围：1–500 篇、256 B–8 MiB、10–3600 秒".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractRequest {
    pub from: String,
    pub to: String,
    pub harness: String,
    #[serde(default)]
    pub budget: Budget,
    #[serde(default)]
    pub include_confidential: bool,
}
impl ExtractRequest {
    pub fn range(&self) -> DateRange {
        DateRange {
            from: self.from.clone(),
            to: self.to.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub state: String,
    pub range: DateRange,
    pub harness: String,
    pub model: Option<String>,
    pub budget: Budget,
    pub include_confidential: bool,
    pub selected: usize,
    pub processed: usize,
    pub reused: usize,
    pub skipped: usize,
    pub failed: usize,
    pub input_bytes: usize,
    pub nodes: usize,
    pub stop_requested: bool,
    #[serde(default)]
    pub can_dismiss_recovery: bool,
    pub run_id: Option<String>,
    pub invocation_id: Option<String>,
    pub message: String,
    pub error: Option<String>,
    pub started_at: String,
    pub updated_at: String,
}
impl Job {
    pub fn running(&self) -> bool {
        matches!(self.state.as_str(), "running" | "stopping" | "recovering")
    }
}
