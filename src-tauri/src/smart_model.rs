//! Direct model client for Smart Lookup: the Jev Noul protocol.
//!
//! The host talks to a Jev-compatible decision service over plain HTTP — the
//! official service, OpenRouter's Decisions endpoint or a self-hosted one —
//! instead of starting a headless Agent. The endpoint, the model name and the
//! authentication mode are user configuration; nothing here names a vendor.
//! Feasibility spec §5.7; plan Task 5.
//!
//! One call sends one request: there are no retries, and a caller-supplied
//! time limit bounds the wait. The key is passed in by the caller and is
//! never read from, or written to, the vault.
//!
//! SKELETON: types, signatures and tests are final; the bodies are not
//! written yet. Nothing in the product calls this module so far.

#![allow(dead_code)]

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How the service authenticates a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// `Authorization: Bearer <key>`.
    Bearer,
    /// No credentials at all — a self-hosted service without authentication.
    /// A stored key is never sent in this mode.
    None,
}

/// The user-configurable Jev access point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JevConfig {
    /// Base URL or complete endpoint; see [`jev_endpoint`].
    pub url: String,
    /// Sent verbatim as the request's `model`.
    pub model: String,
    pub auth_mode: AuthMode,
}

/// Resolve the request URL from the configured one.
///
/// A path ending in `/systemone` or `/decisions` is a complete endpoint and
/// is used as is (minus a trailing slash); anything else gets `/systemone`
/// appended. Query parameters are preserved. So `https://api.typesafe.ai/v1`,
/// `https://openrouter.ai/api/alpha/decisions` and `http://localhost:8000/v1`
/// can all be entered directly.
pub fn jev_endpoint(url: &str) -> Result<String, String> {
    let _ = url;
    todo!("plan Task 5 Step 3")
}

/// Reject a configuration that cannot be used safely.
///
/// Errors: an empty or unparseable `url`, an empty `model`, and a bearer key
/// over plain `http` to a host that is not loopback (`localhost`,
/// `127.0.0.0/8`, `::1`) — that would send the key in clear text. The last
/// error mentions `http`.
pub fn validate_jev_config(config: &JevConfig) -> Result<(), String> {
    let _ = config;
    todo!("plan Task 5 Step 3")
}

/// One yes/no question. All questions of a request share one `state` and are
/// answered independently.
#[derive(Debug, Clone, PartialEq)]
pub struct NoulQuestion {
    /// Chosen by the caller; the answer comes back under the same id.
    pub id: String,
    pub instructions: serde_json::Value,
    pub criteria_true: String,
    pub criteria_false: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NoulOutcome {
    /// `(id, noul)` in the order the questions were given; `noul` is in
    /// `[0, 1]`. Near 0.5 means "undecided", not "half relevant".
    pub scores: Vec<(String, f64)>,
    /// `None` when the service reports no usage (a self-hosted one may not).
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ModelError {
    /// The time limit passed before a complete response arrived.
    Timeout,
    /// A non-2xx status.
    Http(u16),
    /// The request could not be sent or the connection failed.
    Transport(String),
    /// The request was not sendable, or a 2xx body broke the contract.
    Invalid(String),
}

/// Ask every question against one shared `state` in a single request.
///
/// Request body:
/// `{"model": …, "state": …, "questions": {"<id>": {"type": "noul",
/// "instructions": …, "criteria": {"true": …, "false": …}}}}`, posted to
/// `jev_endpoint(&config.url)`.
///
/// - `Bearer` with a key sends `Authorization: Bearer <key>`; `Bearer`
///   without a key sends nothing and returns `Invalid`; `None` never sends
///   an `Authorization` header, even when a key is supplied.
/// - A 2xx body is `Invalid` when it is not JSON, has no `answers` object,
///   answers a different number of questions, misses an id, carries a type
///   other than `noul`, or a `noul` that is not a number in `[0, 1]`.
/// - `usage` is optional.
/// - Exactly one request is sent whatever the outcome.
pub async fn score_noul(
    client: &reqwest::Client,
    config: &JevConfig,
    key: Option<&str>,
    state: &str,
    questions: &[NoulQuestion],
    timeout: Duration,
) -> Result<NoulOutcome, ModelError> {
    let _ = (client, config, key, state, questions, timeout);
    todo!("plan Task 5 Step 3")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const OK_BODY: &str = r#"{"answers":{"c1":{"type":"noul","noul":0.93}}}"#;

    /// A local stand-in for the service. Every connection gets the same
    /// canned reply after `delay`. Returns the base URL (`…/v1`), the first
    /// request as received (lower-cased, headers and body) and the number of
    /// connections accepted so far.
    async fn serve_once(
        status: u16,
        body: &'static str,
        delay: Duration,
    ) -> (String, tokio::sync::oneshot::Receiver<String>, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            let mut request_tx = Some(request_tx);
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut received = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    received.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&received).to_lowercase();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .and_then(|value| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if received.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                if let Some(sender) = request_tx.take() {
                    let _ = sender.send(String::from_utf8_lossy(&received).to_lowercase());
                }
                tokio::time::sleep(delay).await;
                let reason = if status == 200 { "OK" } else { "Error" };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        (base, request_rx, accepted)
    }

    fn config(url: &str, auth_mode: AuthMode) -> JevConfig {
        JevConfig {
            url: url.into(),
            model: "jev-latest".into(),
            auth_mode,
        }
    }

    fn one_question() -> Vec<NoulQuestion> {
        vec![NoulQuestion {
            id: "c1".into(),
            instructions: serde_json::json!({"question": "Is this a test?", "passage": "It is."}),
            criteria_true: "It is a test.".into(),
            criteria_false: "It is not a test.".into(),
        }]
    }

    const LIMIT: Duration = Duration::from_secs(3);

    #[test]
    fn endpoint_follows_the_documented_rule() {
        for (input, expected) in [
            ("https://api.typesafe.ai/v1", "https://api.typesafe.ai/v1/systemone"),
            ("https://api.typesafe.ai/v1/", "https://api.typesafe.ai/v1/systemone"),
            (
                "https://api.typesafe.ai/v1/systemone",
                "https://api.typesafe.ai/v1/systemone",
            ),
            (
                "https://openrouter.ai/api/alpha/decisions",
                "https://openrouter.ai/api/alpha/decisions",
            ),
            (
                "http://localhost:8000/decisions/?route=local",
                "http://localhost:8000/decisions?route=local",
            ),
            (
                "http://localhost:8000/v1?route=local",
                "http://localhost:8000/v1/systemone?route=local",
            ),
        ] {
            assert_eq!(jev_endpoint(input).unwrap(), expected, "{input}");
        }
        assert!(jev_endpoint("not a url").is_err());
    }

    #[test]
    fn config_refuses_a_bearer_key_over_plain_http_to_a_remote_host() {
        let refused =
            validate_jev_config(&config("http://192.168.1.5:8000/v1", AuthMode::Bearer)).unwrap_err();
        assert!(refused.contains("http"), "{refused}");
        assert!(validate_jev_config(&config("http://192.168.1.5:8000/v1", AuthMode::None)).is_ok());
        assert!(validate_jev_config(&config("http://localhost:8000/v1", AuthMode::Bearer)).is_ok());
        assert!(validate_jev_config(&config("http://127.0.0.1:8000/v1", AuthMode::Bearer)).is_ok());
        assert!(validate_jev_config(&config("https://api.typesafe.ai/v1", AuthMode::Bearer)).is_ok());
        assert!(validate_jev_config(&config("", AuthMode::None)).is_err());
        assert!(validate_jev_config(&JevConfig {
            model: String::new(),
            ..config("https://api.typesafe.ai/v1", AuthMode::Bearer)
        })
        .is_err());
    }

    #[tokio::test]
    async fn bearer_sends_the_key_and_none_never_does() {
        let client = reqwest::Client::new();

        let (base, request, accepted) = serve_once(200, OK_BODY, Duration::ZERO).await;
        score_noul(&client, &config(&base, AuthMode::Bearer), Some("k1"), "state", &one_question(), LIMIT)
            .await
            .unwrap();
        let request = request.await.unwrap();
        assert!(request.starts_with("post /v1/systemone "), "{request}");
        assert!(request.contains("authorization: bearer k1"), "{request}");
        assert!(request.contains(r#""model":"jev-latest""#), "{request}");
        assert!(request.contains(r#""type":"noul""#), "{request}");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);

        let (base, request, _) = serve_once(200, OK_BODY, Duration::ZERO).await;
        score_noul(&client, &config(&base, AuthMode::None), Some("stale"), "state", &one_question(), LIMIT)
            .await
            .unwrap();
        let request = request.await.unwrap();
        assert!(!request.contains("authorization"), "{request}");
        assert!(!request.contains("stale"), "{request}");

        let (base, _request, accepted) = serve_once(200, OK_BODY, Duration::ZERO).await;
        let missing_key =
            score_noul(&client, &config(&base, AuthMode::Bearer), None, "state", &one_question(), LIMIT).await;
        assert!(matches!(missing_key, Err(ModelError::Invalid(_))), "{missing_key:?}");
        assert_eq!(accepted.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn rejects_malformed_success_bodies_without_panicking() {
        let client = reqwest::Client::new();
        for body in [
            "<html>502 Bad Gateway</html>",
            r#"{"answers":{}}"#,
            r#"{"answers":{"c1":{"type":"noul","noul":1.2}}}"#,
            r#"{"answers":{"c1":{"type":"choice","choice":"a"}}}"#,
            r#"{"answers":{"other":{"type":"noul","noul":0.5}}}"#,
        ] {
            let (base, _request, _accepted) = serve_once(200, body, Duration::ZERO).await;
            let result =
                score_noul(&client, &config(&base, AuthMode::None), None, "state", &one_question(), LIMIT).await;
            assert!(matches!(result, Err(ModelError::Invalid(_))), "{body}: {result:?}");
        }
    }

    #[tokio::test]
    async fn accepts_a_response_without_usage_and_reads_usage_when_present() {
        let client = reqwest::Client::new();

        let (base, _request, _accepted) = serve_once(200, OK_BODY, Duration::ZERO).await;
        let outcome = score_noul(&client, &config(&base, AuthMode::None), None, "state", &one_question(), LIMIT)
            .await
            .unwrap();
        assert_eq!(outcome.scores, vec![("c1".to_string(), 0.93)]);
        assert_eq!(outcome.usage, None);

        let with_usage =
            r#"{"answers":{"c1":{"type":"noul","noul":0.93}},"usage":{"input_tokens":360,"output_tokens":39}}"#;
        let (base, _request, _accepted) = serve_once(200, with_usage, Duration::ZERO).await;
        let outcome = score_noul(&client, &config(&base, AuthMode::None), None, "state", &one_question(), LIMIT)
            .await
            .unwrap();
        assert_eq!(
            outcome.usage,
            Some(Usage {
                input_tokens: 360,
                output_tokens: 39
            })
        );
    }

    #[tokio::test]
    async fn a_slow_server_times_out_and_http_errors_are_reported_once() {
        let client = reqwest::Client::new();

        let (base, _request, accepted) = serve_once(200, OK_BODY, Duration::from_millis(300)).await;
        let slow = score_noul(
            &client,
            &config(&base, AuthMode::None),
            None,
            "state",
            &one_question(),
            Duration::from_millis(50),
        )
        .await;
        assert_eq!(slow, Err(ModelError::Timeout));
        // Long enough for a retry to have arrived, had one been sent.
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);

        let (base, _request, accepted) = serve_once(429, r#"{"error":"rate limited"}"#, Duration::ZERO).await;
        let limited =
            score_noul(&client, &config(&base, AuthMode::None), None, "state", &one_question(), LIMIT).await;
        assert_eq!(limited, Err(ModelError::Http(429)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    /// Measures round-trip latency against a real endpoint with synthetic
    /// text only; no vault content is sent.
    ///
    /// ```text
    /// NOTEMD_EVAL_JEV_URL=… NOTEMD_EVAL_JEV_MODEL=… NOTEMD_EVAL_JEV_AUTH=bearer|none NOTEMD_EVAL_JEV_KEY=… \
    ///   cargo test --manifest-path src-tauri/Cargo.toml jev_latency_probe -- --ignored --nocapture
    /// ```
    ///
    /// For K = 10 and K = 30 it sends 20 requests each, one after another,
    /// with a 3 second limit, and prints successes, timeouts, P50 / P95 of
    /// the successes and the mean `input_tokens` when usage is reported.
    #[tokio::test]
    #[ignore = "calls a real Jev endpoint; run by hand with NOTEMD_EVAL_JEV_* set"]
    async fn jev_latency_probe() {
        todo!("plan Task 5 Step 5")
    }
}
