//! Provider adapters retain source documents. Only completed collections can
//! replace members of a requested daily window in the authoritative manifest.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderRecord {
    pub source: String,
    pub collection: String,
    pub day: String,
    pub id: Option<String>,
    pub data: Value,
}
#[derive(Clone, Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Value,
}
pub trait Transport {
    fn get_json(&mut self, path: &str, query: &[(&str, String)]) -> Result<HttpResponse, String>;
    fn get_bytes(&mut self, path: &str, query: &[(&str, String)])
        -> Result<(u16, Vec<u8>), String>;
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CollectionResult {
    pub collection: String,
    pub status: String,
    pub records: u64,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FetchReport {
    pub source: String,
    pub since: String,
    pub until: String,
    pub collections: Vec<CollectionResult>,
}
