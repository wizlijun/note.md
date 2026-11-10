//! Optional model-assisted enhancements to smart lookup: shared types here,
//! pure routing/selection/rerank functions in [`candidates`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::smart_model::{
    consent_matches, endpoint_host, jev_endpoint, sends_key_in_clear_text, validate_jev_config, AuthMode, JevConfig,
    ModelError,
};

pub(crate) mod candidates;
pub(crate) mod feedback;
pub(crate) mod judge;
pub(crate) mod keys;
pub(crate) mod pipeline;
pub(crate) mod repair;
pub(crate) mod sag;

/// Named by `search::smart_lookup_search_groups`.
pub use repair::TermGroup;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum EnhanceStatus {
    Ok,
    #[default]
    Skipped,
    NotConfigured,
    NoConsent,
    Timeout,
    KeyInvalid,
    Unreachable,
    Invalid,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    ZeroHits,
    Pinned,
    FewTerms,
    Repaired,
    NoCandidates,
    AutoBudgetUsed,
    /// The index was busy (a rebuild), missing or for another vault, so
    /// confidentiality could not be read and nothing was judged.
    IndexUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Missing {
    Url,
    Model,
    Key,
    Insecure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    Auto,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    Fit,
    Unsure,
    Unfit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JevRequestConfig {
    pub url: String,
    pub model: String,
    pub auth_mode: AuthMode,
    pub consent_host: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRequestConfig {
    pub url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDto {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Why a Jev call may not go ahead.
pub(crate) enum Gate {
    NotConfigured(Missing),
    NoConsent { endpoint_host: String },
}

/// Configuration check shared by the gate and the connection test (no
/// consent). Returns a config ready for `score_noul`.
pub(crate) fn check_config(
    url: &str,
    model: &str,
    auth_mode: AuthMode,
    key: Option<&str>,
) -> Result<JevConfig, Missing> {
    if url.trim().is_empty() {
        return Err(Missing::Url);
    }
    if model.trim().is_empty() {
        return Err(Missing::Model);
    }
    let Ok(parsed) = reqwest::Url::parse(url.trim()) else {
        return Err(Missing::Url);
    };
    // Userinfo (`user:pass@`) would be sent as clear-text Basic auth.
    if jev_endpoint(url).is_err() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Missing::Url);
    }
    if sends_key_in_clear_text(&parsed, auth_mode) {
        return Err(Missing::Insecure);
    }
    let config = JevConfig { url: url.to_string(), model: model.to_string(), auth_mode };
    // Every rule it applies was checked above; kept as the final word.
    if validate_jev_config(&config).is_err() {
        return Err(Missing::Url);
    }
    if auth_mode == AuthMode::Bearer && key.map_or(true, str::is_empty) {
        return Err(Missing::Key);
    }
    Ok(config)
}

/// url empty -> Url; model empty -> Model; unparseable, not http(s), no host
/// or carrying userinfo -> Url; plain http + bearer to a non-loopback host ->
/// Insecure; bearer without key -> Key; consent for a different host ->
/// NoConsent.
pub(crate) fn gate_jev(config: &JevRequestConfig, key: Option<&str>) -> Result<JevConfig, Gate> {
    let jev = check_config(&config.url, &config.model, config.auth_mode, key).map_err(Gate::NotConfigured)?;
    if !consent_matches(&config.url, &config.consent_host) {
        let host = jev_endpoint(&config.url)
            .and_then(|e| endpoint_host(&e))
            .unwrap_or_default();
        return Err(Gate::NoConsent { endpoint_host: host });
    }
    Ok(jev)
}

/// Wakes waiters when a lookup run is cancelled, also if the cancel came first.
pub(crate) struct CancelFlag {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl CancelFlag {
    fn new() -> Self {
        Self { cancelled: AtomicBool::new(false), notify: tokio::sync::Notify::new() }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    pub async fn cancelled(&self) {
        // Created before the check so a cancel in between is not missed.
        let notified = self.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

const FLAG_TTL: Duration = Duration::from_secs(10 * 60);
static CANCEL_FLAGS: OnceLock<Mutex<HashMap<String, (Instant, Arc<CancelFlag>)>>> = OnceLock::new();

fn cancel_flags() -> MutexGuard<'static, HashMap<String, (Instant, Arc<CancelFlag>)>> {
    let mut flags = CANCEL_FLAGS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    flags.retain(|_, (created, _)| now.duration_since(*created) <= FLAG_TTL);
    flags
}

/// One per lookup run; dropped ten minutes after it was made.
pub(crate) fn cancel_flag(run_id: &str) -> Arc<CancelFlag> {
    cancel_flags()
        .entry(run_id.to_string())
        .or_insert_with(|| (Instant::now(), Arc::new(CancelFlag::new())))
        .1
        .clone()
}

/// The flag a new call on `run_id` waits on. A flag that was already
/// cancelled is replaced, so a retry after 「停止」 is not cancelled at once;
/// one still live is shared, so a later stop reaches every call in flight.
pub(crate) fn fresh_cancel_flag(run_id: &str) -> Arc<CancelFlag> {
    let mut flags = cancel_flags();
    let entry = flags
        .entry(run_id.to_string())
        .or_insert_with(|| (Instant::now(), Arc::new(CancelFlag::new())));
    if entry.1.is_cancelled() {
        *entry = (Instant::now(), Arc::new(CancelFlag::new()));
    }
    entry.1.clone()
}

/// The flag a judge or repair call waits on. Only the user's own retry needs
/// a fresh one (a retry after 「停止」); an automatic call keeps the run's
/// existing flag, so a 停止 or supersede that reached the host before the
/// call registered still cancels it (§5.6). Each Enter has its own run id.
pub(crate) fn cancel_flag_for(trigger: Trigger, run_id: &str) -> Arc<CancelFlag> {
    match trigger {
        Trigger::User => fresh_cancel_flag(run_id),
        Trigger::Auto => cancel_flag(run_id),
    }
}

static CLAIM_SEQ: AtomicU64 = AtomicU64::new(0);

/// Proof that this caller took a lookup run's one automatic request. Keep it
/// (drop it) once the request went out; hand it to [`release_auto_request`]
/// when nothing was sent.
pub(crate) struct AutoClaim {
    run_id: String,
    window_label: String,
    id: u64,
}

/// Test-and-set of the run's automatic-request slot, shared by every
/// automatic model request (judge, repair). `None`: the slot was already used
/// — by an earlier automatic request, or because the run is a repair.
pub(crate) fn claim_auto_request(run_id: &str, window_label: &str) -> Result<Option<AutoClaim>, String> {
    let id = CLAIM_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let mut taken = false;
    crate::smart_lookup::update_run(run_id, window_label, |run| {
        if !run.auto_request_used {
            run.auto_request_used = true;
            run.auto_claim = Some(id);
            taken = true;
        }
    })?;
    Ok(taken.then(|| AutoClaim { run_id: run_id.to_string(), window_label: window_label.to_string(), id }))
}

/// Gives the slot back after nothing was sent. Only undoes this claim: if
/// the slot is now held by anything else it stays used. An expired run is
/// left alone.
pub(crate) fn release_auto_request(claim: AutoClaim) {
    let _ = crate::smart_lookup::update_run(&claim.run_id, &claim.window_label, |run| {
        if run.auto_claim == Some(claim.id) {
            run.auto_request_used = false;
            run.auto_claim = None;
        }
    });
}

#[tauri::command]
pub fn smart_lookup_cancel(lookup_run_id: String) {
    cancel_flag(&lookup_run_id).cancel();
}

/// No redirects (a redirect could carry the key elsewhere); no global
/// timeout: callers bound the wait with `enhance.timeoutMs` (`LookupParams`).
pub(crate) fn enhance_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "network unavailable".to_string())
}

/// Map a model error to a status and a coarse status class. Never carries
/// error detail (it may contain secrets).
pub(crate) fn status_for(error: &ModelError) -> (EnhanceStatus, Option<String>) {
    match error {
        ModelError::Timeout => (EnhanceStatus::Timeout, None),
        ModelError::Http(401) | ModelError::Http(403) => {
            (EnhanceStatus::KeyInvalid, Some("4xx".to_string()))
        }
        ModelError::Http(n) => (EnhanceStatus::Unreachable, Some(format!("{}xx", n / 100))),
        ModelError::Transport(_) => (EnhanceStatus::Unreachable, None),
        ModelError::Invalid(_) => (EnhanceStatus::Invalid, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_names_what_is_missing_and_binds_consent_to_the_host() {
        let c = |url: &str, model: &str, auth: AuthMode, host: &str| JevRequestConfig { url: url.into(), model: model.into(), auth_mode: auth, consent_host: host.into() };
        assert!(matches!(gate_jev(&c("", "m", AuthMode::Bearer, ""), Some("k")), Err(Gate::NotConfigured(Missing::Url))));
        assert!(matches!(gate_jev(&c("https://a.example/v1", "", AuthMode::Bearer, "a.example"), Some("k")), Err(Gate::NotConfigured(Missing::Model))));
        assert!(matches!(gate_jev(&c("http://a.example/v1", "m", AuthMode::Bearer, "a.example"), Some("k")), Err(Gate::NotConfigured(Missing::Insecure))));
        assert!(matches!(gate_jev(&c("https://a.example/v1", "m", AuthMode::Bearer, "a.example"), None), Err(Gate::NotConfigured(Missing::Key))));
        assert!(matches!(gate_jev(&c("https://b.example/v1", "m", AuthMode::Bearer, "a.example"), Some("k")),
            Err(Gate::NoConsent { endpoint_host }) if endpoint_host == "b.example"));
        assert!(gate_jev(&c("http://localhost:8000/v1", "m", AuthMode::None, "localhost:8000"), None).is_ok());
    }

    #[test]
    fn check_config_rejects_userinfo_bad_schemes_and_clear_text_bearer() {
        let check = |url: &str, auth: AuthMode| check_config(url, "m", auth, Some("k")).map(|_| ());
        // userinfo would go out as clear-text Basic auth
        assert_eq!(check("https://user:pass@a.example/v1", AuthMode::Bearer), Err(Missing::Url));
        assert_eq!(check("https://user@a.example/v1", AuthMode::None), Err(Missing::Url));
        assert_eq!(check("http://user:pass@localhost:8000/v1", AuthMode::None), Err(Missing::Url));
        // not http(s), or not a URL at all
        assert_eq!(check("ftp://a.example/v1", AuthMode::Bearer), Err(Missing::Url));
        assert_eq!(check("ftp://a.example/v1", AuthMode::None), Err(Missing::Url));
        assert_eq!(check("not a url", AuthMode::None), Err(Missing::Url));
        assert_eq!(check("http://", AuthMode::None), Err(Missing::Url));
        // clear-text bearer only for plain http to a non-loopback host
        assert_eq!(check("http://192.168.1.5:8000/v1", AuthMode::Bearer), Err(Missing::Insecure));
        assert_eq!(check("http://a.example/v1", AuthMode::Bearer), Err(Missing::Insecure));
        assert_eq!(check("http://192.168.1.5:8000/v1", AuthMode::None), Ok(()));
        assert_eq!(check("http://localhost:8000/v1", AuthMode::Bearer), Ok(()));
        assert_eq!(check("http://127.0.0.1:8000/v1", AuthMode::Bearer), Ok(()));
        assert_eq!(check("http://[::1]:8000/v1", AuthMode::Bearer), Ok(()));
        assert_eq!(check("http://localhost:8000/v1", AuthMode::None), Ok(()));
        assert_eq!(check("https://a.example/v1", AuthMode::Bearer), Ok(()));
    }

    #[tokio::test]
    async fn a_cancel_before_waiting_still_wakes_the_waiter() {
        let flag = cancel_flag("run-a");
        flag.cancel();
        tokio::time::timeout(Duration::from_millis(100), flag.cancelled()).await.unwrap();
        assert!(!cancel_flag("run-b").is_cancelled());
    }

    #[test]
    fn model_errors_map_to_statuses_without_detail() {
        assert_eq!(status_for(&ModelError::Http(401)), (EnhanceStatus::KeyInvalid, Some("4xx".into())));
        assert_eq!(status_for(&ModelError::Http(403)), (EnhanceStatus::KeyInvalid, Some("4xx".into())));
        assert_eq!(status_for(&ModelError::Http(429)), (EnhanceStatus::Unreachable, Some("4xx".into())));
        assert_eq!(status_for(&ModelError::Http(502)), (EnhanceStatus::Unreachable, Some("5xx".into())));
        assert_eq!(status_for(&ModelError::Transport("dns sk-secret".into())), (EnhanceStatus::Unreachable, None));
        assert_eq!(status_for(&ModelError::Timeout), (EnhanceStatus::Timeout, None));
        assert_eq!(status_for(&ModelError::Invalid("x".into())), (EnhanceStatus::Invalid, None));
    }
}
