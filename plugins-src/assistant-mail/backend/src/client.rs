use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, AUTHORIZATION};
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RAW_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ChangesPage {
    pub changes: Vec<Value>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

pub struct WorkerClient {
    base: String,
    key: String,
    http: Client,
}

impl WorkerClient {
    pub fn new(worker_url: &str, key: String) -> Result<Self, String> {
        let base = validate_worker_url(worker_url)?;
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("note.md-assistant-mail/0.1")
            .build()
            .map_err(|_| "could not initialize secure HTTP client".to_string())?;
        Ok(Self { base, key, http })
    }

    pub fn whoami(&self) -> Result<Value, String> {
        self.get_json("/v1/whoami")
    }
    pub fn status(&self) -> Result<Value, String> {
        self.get_json("/v1/status")
    }

    pub fn changes(&self, after: Option<&str>, limit: usize) -> Result<ChangesPage, String> {
        let mut url = url::Url::parse(&format!("{}/v1/changes", self.base))
            .map_err(|_| "invalid Worker URL".to_string())?;
        {
            let mut query = url.query_pairs_mut();
            if let Some(cursor) = after.filter(|v| !v.is_empty()) {
                query.append_pair("after", cursor);
            }
            query.append_pair("limit", &limit.to_string());
        }
        let data = self.send_json(self.http.get(url))?;
        let changes = data
            .get("changes")
            .and_then(Value::as_array)
            .cloned()
            .ok_or("Worker returned invalid changes data")?;
        Ok(ChangesPage {
            changes,
            next_cursor: data
                .get("next_cursor")
                .and_then(Value::as_str)
                .map(str::to_string),
            has_more: data
                .get("has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    pub fn source(&self, source_id: &str) -> Result<Option<Value>, String> {
        let url = format!(
            "{}/v1/sources/{}",
            self.base,
            urlencoding::encode(source_id)
        );
        let response = self
            .authorize(self.http.get(url).header(ACCEPT, "application/json"))
            .send()
            .map_err(network_error)?;
        // A deletion can race the change-page snapshot. Treat 410 as an
        // immediate local tombstone so an older upsert cannot resurrect it.
        if response.status().as_u16() == 410 {
            return Ok(None);
        }
        parse_json_response(response).map(Some)
    }

    pub fn raw(&self, source_id: &str) -> Result<Option<Vec<u8>>, String> {
        let url = format!(
            "{}/v1/sources/{}/raw",
            self.base,
            urlencoding::encode(source_id)
        );
        let response = self
            .authorize(self.http.get(url).header(ACCEPT, "message/rfc822"))
            .send()
            .map_err(network_error)?;
        if matches!(response.status().as_u16(), 403 | 404 | 409) {
            return Ok(None);
        }
        if response.status().as_u16() == 410 {
            return Err(
                "Worker source was deleted during sync; retry to apply its tombstone".into(),
            );
        }
        if !response.status().is_success() {
            return Err(response_error(response));
        }
        if response.content_length().is_some_and(|n| n > MAX_RAW_BYTES) {
            return Err("Worker raw message exceeds the 32 MiB local safety limit".into());
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_RAW_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(network_error)?;
        if bytes.len() as u64 > MAX_RAW_BYTES {
            return Err("Worker raw message exceeds the 32 MiB local safety limit".into());
        }
        Ok(Some(bytes))
    }

    pub fn create_deletion_plan(&self, source_ids: &[String]) -> Result<Value, String> {
        self.post_json("/v1/deletion-plans", &json!({"source_ids": source_ids}))
    }

    pub fn deletion_plan(&self, plan_id: &str) -> Result<Value, String> {
        self.get_json(&format!(
            "/v1/deletion-plans/{}",
            urlencoding::encode(plan_id)
        ))
    }

    pub fn execute_deletion_plan(&self, plan_id: &str, plan_hash: &str) -> Result<Value, String> {
        self.post_json(
            &format!(
                "/v1/deletion-plans/{}/execute",
                urlencoding::encode(plan_id)
            ),
            &json!({"plan_hash": plan_hash, "confirmation": "DELETE"}),
        )
    }

    pub fn deletion_job(&self, job_id: &str) -> Result<Value, String> {
        self.get_json(&format!(
            "/v1/deletion-jobs/{}",
            urlencoding::encode(job_id)
        ))
    }

    fn get_json(&self, path: &str) -> Result<Value, String> {
        self.send_json(self.http.get(format!("{}{}", self.base, path)))
    }

    fn post_json(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.send_json(self.http.post(format!("{}{}", self.base, path)).json(body))
    }

    fn authorize(
        &self,
        builder: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        builder.header(AUTHORIZATION, format!("Bearer {}", self.key))
    }

    fn send_json(&self, builder: reqwest::blocking::RequestBuilder) -> Result<Value, String> {
        let response = self
            .authorize(builder.header(ACCEPT, "application/json"))
            .send()
            .map_err(network_error)?;
        parse_json_response(response)
    }
}

fn parse_json_response(mut response: Response) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(response_error(response));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_JSON_BYTES)
    {
        return Err("Worker JSON response exceeds the 8 MiB safety limit".into());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_JSON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(network_error)?;
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Err("Worker JSON response exceeds the 8 MiB safety limit".into());
    }
    let envelope: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Worker returned invalid JSON".to_string())?;
    envelope
        .get("data")
        .cloned()
        .ok_or("Worker response has no data envelope".into())
}

pub fn validate_worker_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    let parsed = url::Url::parse(value).map_err(|_| "Worker URL is invalid".to_string())?;
    let localhost = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && localhost) {
        return Err("Worker URL must use HTTPS (HTTP is allowed only for localhost)".into());
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Worker URL must not contain credentials, query or fragment".into());
    }
    if parsed.path() != "/" && !parsed.path().is_empty() {
        return Err("Worker URL must be an origin without a path".into());
    }
    Ok(value.trim_end_matches('/').to_string())
}

fn network_error(_: impl std::fmt::Display) -> String {
    // Intentionally exclude reqwest's full error chain: it can contain the
    // request URL. The Authorization header is never rendered anywhere.
    "Assistant Mail Worker request failed".to_string()
}

fn response_error(mut response: Response) -> String {
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    let _ = response.by_ref().take(16 * 1024).read_to_end(&mut bytes);
    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
        if let Some(error) = value.get("error") {
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("worker_error");
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("request rejected");
            return format!("Worker {status} {code}: {}", bounded(message, 240));
        }
    }
    format!("Worker request failed with HTTP {status}")
}

fn bounded(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;

    #[test]
    fn worker_url_requires_a_clean_https_origin() {
        assert_eq!(
            validate_worker_url("https://mail.example.com/").unwrap(),
            "https://mail.example.com"
        );
        assert!(validate_worker_url("http://mail.example.com").is_err());
        assert!(validate_worker_url("https://user:secret@mail.example.com").is_err());
        assert!(validate_worker_url("https://mail.example.com/api").is_err());
        assert!(validate_worker_url("http://127.0.0.1:8787").is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn client_uses_bearer_and_unwraps_worker_data_inside_plugin_runtime() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /v1/whoami HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer test-key-abcdefghijklmnopqrstuvwxyz"));
            let body = r#"{"data":{"actor":"plugin-instance"}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        tokio::task::block_in_place(|| {
            let client = WorkerClient::new(
                &format!("http://{address}"),
                "test-key-abcdefghijklmnopqrstuvwxyz".into(),
            )
            .unwrap();
            assert_eq!(client.whoami().unwrap()["actor"], "plugin-instance");
        });
        server.join().unwrap();
    }
}
