//! Sumi device credentials. Only the platform secret store contains the secret.
//! Do not return `Credentials` through IPC or persist it in preferences/Vault files.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SERVICE: &str = "com.notemd.sumi.credentials.v1";
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub server_url: String,
    pub space_id: String,
    pub device_id: String,
    device_secret: String,
}
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("space_id", &self.space_id)
            .field("device_id", &self.device_id)
            .field("device_secret", &"[REDACTED]")
            .finish()
    }
}
impl Credentials {
    pub fn new(
        server_url: String,
        space_id: String,
        device_id: String,
        device_secret: String,
    ) -> Result<Self, String> {
        uuid::Uuid::parse_str(&space_id).map_err(|_| "invalid Sumi space identity")?;
        uuid::Uuid::parse_str(&device_id).map_err(|_| "invalid Sumi device identity")?;
        if device_secret.len() != 88 || device_secret.chars().any(char::is_whitespace) {
            return Err("invalid Sumi device credential".into());
        }
        Ok(Self {
            server_url,
            space_id,
            device_id,
            device_secret,
        })
    }
    pub(crate) fn secret(&self) -> &str {
        &self.device_secret
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    server_url: String,
    space_id: String,
    device_id: String,
    device_secret: String,
}
fn account(profile: &str) -> Result<String, String> {
    if profile.is_empty() || profile.len() > 4096 {
        return Err("invalid Sumi credential profile".into());
    }
    Ok(format!("{:x}", Sha256::digest(profile.as_bytes())))
}
/// Blocking Keychain APIs: callers should use spawn_blocking rather than the editor main thread.
#[cfg(target_os = "macos")]
pub fn save(profile: &str, credential: &Credentials) -> Result<(), String> {
    let data = serde_json::to_vec(&StoredCredential {
        server_url: credential.server_url.clone(),
        space_id: credential.space_id.clone(),
        device_id: credential.device_id.clone(),
        device_secret: credential.device_secret.clone(),
    })
    .map_err(|_| "cannot encode Sumi credential")?;
    security_framework::passwords::set_generic_password(SERVICE, &account(profile)?, &data)
        .map_err(|e| format!("Sumi Keychain write failed ({})", e.code()))
}
#[cfg(target_os = "macos")]
pub fn load(profile: &str) -> Result<Option<Credentials>, String> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    let bytes = match generic_password(PasswordOptions::new_generic_password(
        SERVICE,
        &account(profile)?,
    )) {
        Ok(bytes) => bytes,
        Err(e) if e.code() == -25300 => return Ok(None), // errSecItemNotFound
        Err(e) => return Err(format!("Sumi Keychain read failed ({})", e.code())),
    };
    let stored: StoredCredential =
        serde_json::from_slice(&bytes).map_err(|_| "invalid Sumi Keychain record")?;
    Credentials::new(
        stored.server_url,
        stored.space_id,
        stored.device_id,
        stored.device_secret,
    )
    .map(Some)
}
#[cfg(target_os = "macos")]
pub fn remove(profile: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, &account(profile)?) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == -25300 => Ok(()),
        Err(e) => Err(format!("Sumi Keychain delete failed ({})", e.code())),
    }
}
#[cfg(target_os = "linux")]
#[path = "credentials_linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{load, remove, save};

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn save(_: &str, _: &Credentials) -> Result<(), String> {
    Err("Sumi secure credential storage is not implemented on this platform".into())
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn load(_: &str) -> Result<Option<Credentials>, String> {
    Err("Sumi secure credential storage is not implemented on this platform".into())
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn remove(_: &str) -> Result<(), String> {
    Err("Sumi secure credential storage is not implemented on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debug_does_not_leak_device_secret() {
        let secret = "x".repeat(88);
        let credential = Credentials::new(
            "https://example.test".into(),
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            secret.clone(),
        )
        .unwrap();
        assert!(!format!("{credential:?}").contains(&secret));
        assert_ne!(account("vault-a").unwrap(), account("vault-b").unwrap());
    }
    #[test]
    #[ignore = "writes a unique disposable credential; on Linux run scripts/sumi/test-linux-credentials.sh --private-keyring"]
    fn isolated_keychain_roundtrip() {
        let profile = format!("sumi-test-{}", uuid::Uuid::new_v4());
        let credential = Credentials::new(
            "https://example.test".into(),
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            "x".repeat(88),
        )
        .unwrap();
        save(&profile, &credential).unwrap();
        let result = load(&profile);
        let removed = remove(&profile);
        assert_eq!(result.unwrap().unwrap().secret(), credential.secret());
        removed.unwrap();
        assert!(load(&profile).unwrap().is_none());
    }
}
