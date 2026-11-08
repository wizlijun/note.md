//! Private Sumi network identity/auth contracts. Long-lived device keys never cross this boundary.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub server_url: String,
    pub space_id: String,
    pub device_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    pub space_id: String,
    pub code: String,
    pub expires_at: u64,
}
impl std::fmt::Debug for Invitation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Invitation").field("space_id", &self.space_id).field("code", &"[REDACTED]").finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessToken {
    #[serde(alias = "accessToken")]
    pub access_token: String,
    #[serde(alias = "expiresAt")]
    pub expires_at: u64,
}
impl std::fmt::Debug for AccessToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccessToken").field("access_token", &"[REDACTED]").field("expires_at", &self.expires_at).finish()
    }
}
