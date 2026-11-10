//! API keys for the optional model services, and the Jev connection test.
//!
//! Keys live in the app-data store (`smart_lookup_keys.json`), never in the
//! vault or in settings. No command here returns a key; errors are fixed
//! strings and nothing logs one.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

use super::{check_config, enhance_client, EnhanceStatus, Missing};
use crate::smart_model::{
    endpoint_host, score_noul, AuthMode, JevConfig, NoulQuestion,
};

pub(crate) const KEY_STORE: &str = "smart_lookup_keys.json";
const MAX_KEY_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyKind {
    Jev,
    Chat,
}

impl KeyKind {
    fn slot(self) -> &'static str {
        match self {
            KeyKind::Jev => "jevKey",
            KeyKind::Chat => "chatKey",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub jev: bool,
    pub chat: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JevTestConfig {
    pub url: String,
    pub model: String,
    pub auth_mode: AuthMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub status: EnhanceStatus,
    pub missing: Option<Missing>,
    pub endpoint_host: Option<String>,
    pub status_class: Option<String>,
    pub elapsed_ms: u64,
}

/// Trim; 1..=4096 bytes; no whitespace or control characters. The error
/// never contains the input.
pub(crate) fn normalize_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("key is empty".into());
    }
    if key.len() > MAX_KEY_BYTES {
        return Err("key is too long".into());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("key contains whitespace or control characters".into());
    }
    Ok(key.to_string())
}

pub(crate) fn read_key(app: &tauri::AppHandle, kind: KeyKind) -> Option<String> {
    let store = app.store(KEY_STORE).ok()?;
    store
        .get(kind.slot())
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|k| !k.is_empty())
}

const UNAVAILABLE: &str = "key store unavailable";

#[tauri::command]
pub fn smart_lookup_key_set(app: tauri::AppHandle, kind: KeyKind, key: String) -> Result<(), String> {
    let key = normalize_key(&key)?;
    let store = app.store(KEY_STORE).map_err(|_| UNAVAILABLE.to_string())?;
    store.set(kind.slot(), serde_json::Value::String(key));
    store.save().map_err(|_| UNAVAILABLE.to_string())
}

#[tauri::command]
pub fn smart_lookup_key_clear(app: tauri::AppHandle, kind: KeyKind) -> Result<(), String> {
    let store = app.store(KEY_STORE).map_err(|_| UNAVAILABLE.to_string())?;
    store.delete(kind.slot());
    store.save().map_err(|_| UNAVAILABLE.to_string())
}

#[tauri::command]
pub fn smart_lookup_key_status(app: tauri::AppHandle) -> Result<KeyStatus, String> {
    Ok(KeyStatus {
        jev: read_key(&app, KeyKind::Jev).is_some(),
        chat: read_key(&app, KeyKind::Chat).is_some(),
    })
}

fn synthetic_question() -> NoulQuestion {
    NoulQuestion {
        id: "c1".into(),
        instructions: serde_json::json!({"passage": "这是一段用于连接测试的文字。"}),
        criteria_true: "这段文字用于测试。".into(),
        criteria_false: "这段文字不是用于测试。".into(),
    }
}

/// Testable core: synthetic text only, no consent needed, no Vault access.
/// Waits at most `timeout` (`enhance.timeoutMs` in the app).
pub(crate) async fn run_jev_test(
    client: &reqwest::Client,
    config: &JevTestConfig,
    key: Option<&str>,
    timeout: Duration,
) -> ConnectionTest {
    let started = Instant::now();
    let done = |status, missing, host, class| ConnectionTest {
        status,
        missing,
        endpoint_host: host,
        status_class: class,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    let jev = match check_config(&config.url, &config.model, config.auth_mode, key) {
        Ok(jev) => jev,
        Err(missing) => return done(EnhanceStatus::NotConfigured, Some(missing), None, None),
    };
    let host = crate::smart_model::jev_endpoint(&jev.url)
        .and_then(|e| endpoint_host(&e))
        .ok();
    let jev: JevConfig = jev;
    match score_noul(client, &jev, key, "连接测试", &[synthetic_question()], timeout).await {
        Ok(_) => done(EnhanceStatus::Ok, None, host, None),
        Err(e) => {
            let (status, class) = super::status_for(&e);
            done(status, None, host, class)
        }
    }
}

#[tauri::command]
pub async fn smart_lookup_test_jev(
    app: tauri::AppHandle,
    config: JevTestConfig,
) -> Result<ConnectionTest, String> {
    let timeout = crate::lookup_params::for_app(&app)?.enhance.timeout();
    let key = match config.auth_mode {
        AuthMode::Bearer => read_key(&app, KeyKind::Jev),
        AuthMode::None => None,
    };
    let client = enhance_client()?;
    Ok(run_jev_test(&client, &config, key.as_deref(), timeout).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart_model::test_support::serve_once;

    const WAIT: Duration = Duration::from_secs(3);

    #[test]
    fn keys_are_trimmed_bounded_and_errors_never_echo_them() {
        assert_eq!(normalize_key("  sk-abc123  ").unwrap(), "sk-abc123");
        for bad in ["", "   ", "sk-a b", "sk-\u{7}x"] {
            assert!(normalize_key(bad).is_err(), "{bad:?}");
        }
        assert!(normalize_key(&"x".repeat(4_097)).is_err());
        assert!(!normalize_key("sk-secret b").unwrap_err().contains("sk-secret"));
    }

    fn cfg(url: &str, auth_mode: AuthMode) -> JevTestConfig {
        JevTestConfig { url: url.into(), model: "m".into(), auth_mode }
    }

    #[tokio::test]
    async fn the_connection_test_sends_synthetic_text_and_reports_without_the_key() {
        let client = enhance_client().unwrap();
        let body = r#"{"answers":{"c1":{"type":"noul","noul":0.9}}}"#;

        let (base, request, _) = serve_once(200, body, Duration::ZERO).await;
        let ok = run_jev_test(&client, &cfg(&base, AuthMode::Bearer), Some("sk-secret"), WAIT).await;
        assert_eq!(ok.status, EnhanceStatus::Ok);
        assert!(ok.endpoint_host.unwrap().starts_with("127.0.0.1:"));
        let request = request.await.unwrap();
        assert!(request.contains("连接测试"), "{request}");
        assert!(request.contains("authorization: bearer sk-secret"));

        // authMode none never sends a stored key
        let (base, request, _) = serve_once(200, body, Duration::ZERO).await;
        run_jev_test(&client, &cfg(&base, AuthMode::None), Some("sk-secret"), WAIT).await;
        assert!(!request.await.unwrap().contains("sk-secret"));

        let (base, _r, _) = serve_once(401, "{}", Duration::ZERO).await;
        let denied = run_jev_test(&client, &cfg(&base, AuthMode::Bearer), Some("sk-secret"), WAIT).await;
        assert_eq!(denied.status, EnhanceStatus::KeyInvalid);
        assert_eq!(denied.status_class.as_deref(), Some("4xx"));
        assert!(!format!("{denied:?}").contains("sk-secret"));

        let none = run_jev_test(&client, &cfg("https://a.example/v1", AuthMode::Bearer), None, WAIT).await;
        assert_eq!((none.status, none.missing), (EnhanceStatus::NotConfigured, Some(Missing::Key)));
        let insecure = run_jev_test(&client, &cfg("http://a.example/v1", AuthMode::Bearer), Some("k"), WAIT).await;
        assert_eq!(insecure.missing, Some(Missing::Insecure));
    }
}
