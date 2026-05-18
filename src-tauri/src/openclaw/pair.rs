use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct PairCreateResponse {
    pub code: String,
    #[serde(rename = "pairingId")]
    pub pairing_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

#[derive(Debug, Deserialize)]
pub struct PairClaimResponse {
    #[serde(rename = "device_token")]
    pub device_token: String,
    #[serde(rename = "pairingId")]
    pub pairing_id: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
pub struct HostBootstrapResponse {
    #[serde(rename = "device_token")]
    pub device_token: String,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct PendingClaim {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub hostname: String,
    pub at: u64,
}

pub async fn pair_create(relay_url: &str) -> Result<PairCreateResponse, String> {
    let url = format!("{}/pair/create", relay_url.trim_end_matches('/'));
    let resp = Client::new().post(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("status {}", resp.status())); }
    resp.json::<PairCreateResponse>().await.map_err(|e| e.to_string())
}

pub async fn pair_claim(relay_url: &str, code: &str, hostname: &str) -> Result<PairClaimResponse, String> {
    let url = format!("{}/pair/claim", relay_url.trim_end_matches('/'));
    let resp = Client::new()
        .post(&url)
        .json(&serde_json::json!({ "code": code, "hostname": hostname }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("status {}", resp.status())); }
    resp.json::<PairClaimResponse>().await.map_err(|e| e.to_string())
}

pub async fn host_bootstrap(relay_url: &str, pairing_id: &str) -> Result<HostBootstrapResponse, String> {
    let url = format!("{}/pair/host-bootstrap", relay_url.trim_end_matches('/'));
    let resp = Client::new()
        .post(&url)
        .json(&serde_json::json!({ "pairingId": pairing_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("status {}", resp.status())); }
    resp.json::<HostBootstrapResponse>().await.map_err(|e| e.to_string())
}

pub async fn revoke_device(relay_url: &str, host_token: &str, device_id: &str) -> Result<(), String> {
    let url = format!("{}/device/revoke", relay_url.trim_end_matches('/'));
    let resp = Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {}", host_token))
        .json(&serde_json::json!({ "deviceId": device_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() { Ok(()) } else { Err(format!("status {}", resp.status())) }
}

pub async fn pending_claims(relay_url: &str, host_token: &str) -> Result<Vec<PendingClaim>, String> {
    let url = format!("{}/device/pending-claims", relay_url.trim_end_matches('/'));
    let resp = Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", host_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("status {}", resp.status())); }
    resp.json::<Vec<PendingClaim>>().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_pair_parses_response() {
        let payload = r#"{"code":"abc-def-012-345-678-9ab","pairingId":"p-deadbeefcafebabe","expiresAt":1234567}"#;
        let parsed: PairCreateResponse = serde_json::from_str(payload).unwrap();
        assert_eq!(parsed.code, "abc-def-012-345-678-9ab");
        assert!(parsed.pairing_id.starts_with("p-"));
    }
}
