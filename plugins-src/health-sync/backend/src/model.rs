use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A normalized Apple export element. Original units, writers and metadata stay intact.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthRecord {
    pub schema_version: u32,
    pub ingest_source: String,
    pub kind: String,
    pub day: String,
    pub metric: String,
    pub attributes: BTreeMap<String, String>,
    pub children: Vec<XmlNode>,
    pub text: String,
    /// Present only for mixed XML content: text before, between and after children.
    /// There is exactly one more segment than child nodes; `text` is their concatenation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_segments: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct XmlNode {
    pub name: String,
    pub attributes: BTreeMap<String, String>,
    pub children: Vec<XmlNode>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_segments: Option<Vec<String>>,
}
