//! Verified public downloads and durable guest delivery. Credentials stay in app-data Store.
mod archive;
mod reader;
mod store;
use serde::Deserialize;
use std::path::Path;
type Result<T> = std::result::Result<T, String>;
const MAX_SOURCE: usize = 25 * 1024 * 1024;
const MAX_ZIP: usize = 32 * 1024 * 1024;
static GUEST_IO: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn valid_slug(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 12
        || b.get(4) != Some(&b'-')
        || b.get(7) != Some(&b'-')
        || b.get(10) != Some(&b'-')
        || !b[..4]
            .iter()
            .chain(&b[5..7])
            .chain(&b[8..10])
            .all(u8::is_ascii_digit)
    {
        return false;
    }
    let body = &s[11..];
    let lower = |v: &str| {
        !v.is_empty()
            && v.len() <= 50
            && v.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    };
    lower(body)
        || body.rsplit_once('-').is_some_and(|(a, z)| {
            lower(a) && (2..=4).contains(&z.len()) && z.bytes().all(|c| c.is_ascii_alphanumeric())
        })
}
fn checked_link(origin: &str, slug: &str, share_url: &str, dev: bool) -> Result<url::Url> {
    let url = url::Url::parse(origin).map_err(|_| "invalid guest origin")?;
    let loopback = ["localhost", "127.0.0.1", "[::1]"].contains(&url.host_str().unwrap_or(""));
    if origin != url.origin().ascii_serialization()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || (dev && url.scheme() == "http" && loopback))
        || !valid_slug(slug)
        || share_url != format!("{origin}/{slug}")
    {
        return Err("invalid guest link".into());
    }
    Ok(url)
}
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    schema_version: u32,
    #[serde(rename = "project_id")]
    project_id: String,
    snapshot_id: String,
    archive_ready: bool,
}
impl Version {
    fn parse(bytes: &[u8]) -> Result<Self> {
        let v: Self = serde_json::from_value(reader::unique_json(bytes)?)
            .map_err(|_| "invalid public version")?;
        if v.schema_version != 1
            || !reader::valid_id(&v.project_id)
            || !reader::valid_id(&v.snapshot_id)
            || !v.archive_ready
        {
            return Err("share archive is not ready".into());
        }
        Ok(v)
    }
}
async fn bounded_get(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "share download failed")?;
    if response.status().is_redirection() {
        return Err("share redirects are not allowed".into());
    }
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            409 => "share archive is not ready",
            410 => "share is stopped or expired",
            _ => "share download failed",
        }
        .into());
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("share download exceeds limit".into());
    }
    let mut bytes = vec![];
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "share download interrupted")?
    {
        if chunk.len() > limit - bytes.len() {
            return Err("share download exceeds limit".into());
        }
        bytes.extend_from_slice(&chunk)
    }
    Ok(bytes)
}
async fn download(origin: &str, slug: &str, share_url: &str) -> Result<reader::Snapshot> {
    checked_link(origin, slug, share_url, cfg!(debug_assertions))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "cannot create share download client")?;
    let version_url = format!("{origin}/project/{slug}/version");
    let before = Version::parse(&bounded_get(&client, &version_url, 64 * 1024).await?)?;
    let snapshot =
        reader::extract_public_snapshot(&bounded_get(&client, share_url, MAX_SOURCE).await?)?;
    if snapshot.manifest.project_id != before.project_id
        || snapshot.manifest.snapshot_id != before.snapshot_id
    {
        return Err("share reader identity mismatch".into());
    }
    let zip = bounded_get(
        &client,
        &format!("{origin}/project/{slug}/download"),
        MAX_ZIP,
    )
    .await?;
    archive::validate(&zip, &snapshot)?;
    let after = Version::parse(&bounded_get(&client, &version_url, 64 * 1024).await?)?;
    if before != after {
        return Err("share version changed; check again".into());
    }
    Ok(snapshot)
}
#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
enum Request {
    #[serde(rename = "open")]
    Open {
        origin: String,
        slug: String,
        #[serde(rename = "shareUrl")]
        share_url: String,
    },
    #[serde(rename = "list")]
    List,
    #[serde(rename = "read-work")]
    ReadWork { root: String },
    #[serde(rename = "check-version")]
    CheckVersion { root: String },
    #[serde(rename = "queue")]
    Queue {
        root: String,
        #[serde(rename = "submissionId")]
        submission_id: String,
        body: String,
    },
    #[serde(rename = "deliver")]
    Deliver {
        root: String,
        #[serde(rename = "submissionId")]
        submission_id: String,
    },
    #[serde(rename = "receipts")]
    Receipts {
        root: String,
        #[serde(rename = "submissionIds")]
        submission_ids: Vec<String>,
    },
    #[serde(rename = "inspect")]
    Inspect { root: String },
    #[serde(rename = "read-base")]
    ReadBase {
        root: String,
        path: String,
        #[serde(rename = "snapshotId")]
        snapshot_id: String,
    },
}
fn credential(app: &tauri::AppHandle, info: &store::GuestInfo) -> Result<String> {
    use tauri_plugin_store::StoreExt;
    let db = app
        .store("share_db.json")
        .map_err(|_| "guest credential unavailable")?;
    db.get(format!("guest:{}:{}", info.origin, info.project_id))
        .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(str::to_owned))
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "GUEST_READ_ONLY".into())
}
fn guest_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "guest network unavailable".into())
}
async fn send_pending(info: &store::GuestInfo, id: &str, token: &str) -> Result<String> {
    let pending = info
        .outbox
        .iter()
        .find(|p| p.submission_id == id)
        .ok_or("pending submission missing")?;
    let response = guest_client()?
        .post(format!("{}/feedback/{}", info.origin, info.slug))
        .header("X-Feedback-Token", token)
        .header("Content-Type", "application/json")
        .body(pending.body.clone())
        .send()
        .await
        .map_err(|_| "GUEST_NETWORK".to_string())?;
    if !response.status().is_success() {
        return Err(format!("GUEST_HTTP_{}", response.status().as_u16()));
    }
    Ok(pending.body.clone())
}
fn valid_receipt(value: &serde_json::Value, info: &store::GuestInfo, id: &str) -> bool {
    let keys = |value: &serde_json::Value, allowed: &[&str]| {
        value
            .as_object()
            .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
    };
    let count = |v: &serde_json::Value| v.as_u64().filter(|n| *n <= 9_007_199_254_740_991);
    let outcome = |v: &serde_json::Value, superseded: bool| {
        v.as_str().is_some_and(|s| {
            ["accepted", "partial", "rejected", "forwarded"].contains(&s)
                || superseded && s == "superseded"
        })
    };
    keys(
        value,
        &[
            "schemaVersion",
            "project_id",
            "submissionId",
            "decidedAt",
            "outcome",
            "files",
            "annotations",
            "reply",
            "includedInSnapshotId",
        ],
    ) && value["schemaVersion"] == 1
        && value["project_id"] == info.project_id
        && value["submissionId"] == id
        && value["decidedAt"]
            .as_str()
            .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        && outcome(&value["outcome"], true)
        && value["files"].as_array().is_some_and(|files| {
            files.iter().all(|f| {
                keys(f, &["path", "outcome", "accepted", "total"])
                    && f["path"]
                        .as_str()
                        .is_some_and(|p| reader::valid_path(p).is_ok())
                    && outcome(&f["outcome"], false)
                    && count(&f["accepted"])
                        .zip(count(&f["total"]))
                        .is_some_and(|(a, t)| a <= t)
            })
        })
        && keys(&value["annotations"], &["promoted", "total"])
        && count(&value["annotations"]["promoted"])
            .zip(count(&value["annotations"]["total"]))
            .is_some_and(|(a, t)| a <= t)
        && value
            .get("reply")
            .is_none_or(|v| v.as_str().is_some_and(|s| s.encode_utf16().count() <= 2000))
        && value
            .get("includedInSnapshotId")
            .is_none_or(|v| v.as_str().is_some_and(reader::valid_id))
}
async fn read_receipts(
    info: &store::GuestInfo,
    ids: &[String],
    token: &str,
) -> Result<serde_json::Value> {
    if ids.len() > 20 || ids.iter().any(|id| !info.submitted.contains(id)) {
        return Err("invalid receipt ids".into());
    }
    let client = guest_client()?;
    let mut results = vec![];
    // Serial reads keep concurrency at one, within the four-request ceiling.
    for id in ids {
        let response = client
            .get(format!(
                "{}/feedback/{}/receipt/{}",
                info.origin, info.slug, id
            ))
            .header("X-Feedback-Token", token)
            .send()
            .await;
        let Ok(mut response) = response else {
            results.push(serde_json::json!({"submissionId":id,"status":0}));
            continue;
        };
        let status = response.status().as_u16();
        if status != 200 {
            results.push(serde_json::json!({"submissionId":id,"status":status}));
            continue;
        }
        let mut bytes = vec![];
        while let Some(chunk) = response.chunk().await.map_err(|_| "GUEST_NETWORK")? {
            if chunk.len() > 64 * 1024 - bytes.len() {
                return Err("invalid receipt size".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let receipt = reader::unique_json(&bytes)?;
        if !valid_receipt(&receipt, info, id) {
            return Err("invalid receipt identity".into());
        }
        results.push(serde_json::json!({"submissionId":id,"status":200,"receipt":receipt}));
    }
    Ok(results.into())
}
#[tauri::command]
pub async fn share_guest(
    app: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    let request: Request = serde_json::from_value(request).map_err(|_| "invalid guest request")?;
    let vault = crate::sotvault::resolve_vault_root(&app).ok_or("Vault not configured")?;
    match &request {
        Request::Deliver {
            root,
            submission_id,
        } => {
            let info = {
                let _guard = GUEST_IO.lock().map_err(|_| "guest store unavailable")?;
                store::GuestStore::new(vault.clone())?.inspect(Path::new(root))?
            };
            let token = credential(&app, &info)?;
            let body = send_pending(&info, submission_id, &token).await?;
            let _guard = GUEST_IO.lock().map_err(|_| "guest store unavailable")?;
            if crate::sotvault::resolve_vault_root(&app).as_ref() != Some(&vault) {
                return Err("active Vault changed".into());
            }
            return serde_json::to_value(store::GuestStore::new(vault)?.delivered(
                Path::new(root),
                submission_id,
                &body,
            )?)
            .map_err(|_| "invalid guest result".into());
        }
        Request::Receipts {
            root,
            submission_ids,
        } => {
            let info = store::GuestStore::new(vault.clone())?.inspect(Path::new(root))?;
            return read_receipts(&info, submission_ids, &credential(&app, &info)?).await;
        }
        Request::CheckVersion { root } => {
            let info = store::GuestStore::new(vault.clone())?.inspect(Path::new(root))?;
            let version = Version::parse(
                &bounded_get(
                    &guest_client()?,
                    &format!("{}/project/{}/version", info.origin, info.slug),
                    64 * 1024,
                )
                .await?,
            )?;
            if version.project_id != info.project_id {
                return Err("share version identity mismatch".into());
            }
            return Ok(
                serde_json::json!({"snapshotId":version.snapshot_id,"changed": version.snapshot_id != info.snapshot_id}),
            );
        }
        Request::Queue { root, .. } => {
            credential(
                &app,
                &store::GuestStore::new(vault.clone())?.inspect(Path::new(root))?,
            )?;
        }
        _ => {}
    }
    let snapshot = if let Request::Open {
        origin,
        slug,
        share_url,
    } = &request
    {
        Some(download(origin, slug, share_url).await?)
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GUEST_IO.lock().map_err(|_| "guest store unavailable")?;
        // Recheck the active Vault after network work; a switch cannot redirect this download.
        if crate::sotvault::resolve_vault_root(&app).as_ref() != Some(&vault) {
            return Err("active Vault changed".into());
        }
        let store = store::GuestStore::new(vault)?;
        match request {
            Request::Open {
                origin,
                slug,
                share_url,
            } => serde_json::to_value(store.install(
                &origin,
                &slug,
                &share_url,
                &snapshot.ok_or("missing verified snapshot")?,
            )?)
            .map_err(|_| "invalid guest result".into()),
            Request::List => {
                serde_json::to_value(store.list()?).map_err(|_| "invalid guest result".into())
            }
            Request::ReadWork { root } => store.read_work(Path::new(&root)),
            Request::Queue {
                root,
                submission_id,
                body,
            } => serde_json::to_value(store.queue(Path::new(&root), &submission_id, &body)?)
                .map_err(|_| "invalid guest result".into()),
            Request::Deliver { .. } | Request::Receipts { .. } | Request::CheckVersion { .. } => {
                Err("invalid guest operation".into())
            }
            Request::Inspect { root } => serde_json::to_value(store.inspect(Path::new(&root))?)
                .map_err(|_| "invalid guest result".into()),
            Request::ReadBase {
                root,
                path,
                snapshot_id,
            } => store.read_base(Path::new(&root), &path, &snapshot_id),
        }
    })
    .await
    .map_err(|_| "guest operation failed")?
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    fn submission_server(statuses: Vec<u16>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut bodies = vec![];
            for status in statuses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut headers = vec![];
                let mut one = [0u8; 1];
                while !headers.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut one).unwrap();
                    headers.push(one[0]);
                }
                let header = String::from_utf8(headers).unwrap();
                let len: usize = header
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .unwrap()
                    .parse()
                    .unwrap();
                let mut bytes = vec![0; len];
                stream.read_exact(&mut bytes).unwrap();
                bodies.push(String::from_utf8(bytes).unwrap());
                assert!(header
                    .to_lowercase()
                    .contains("x-feedback-token: fixture_token"));
                stream.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
            }
            bodies
        });
        (origin, thread)
    }
    #[tokio::test]
    async fn actual_http_restart_replays_durable_bytes_after_503_409_and_failed_ack() {
        let (origin, server) = submission_server(vec![503, 409, 200, 200]);
        let t = tempfile::tempdir().unwrap();
        let store = store::GuestStore::new(t.path().into()).unwrap();
        let snapshot = reader::extract_public_snapshot(&reader::tests::html(1)).unwrap();
        let info = store
            .install(
                &origin,
                "2026-10-14-test",
                &format!("{origin}/2026-10-14-test"),
                &snapshot,
            )
            .unwrap();
        let root = Path::new(&info.root);
        let wire=serde_json::json!({"schemaVersion":2,"project_id":info.project_id,"snapshotId":info.snapshot_id,"submissionId":"request1","client":{"kind":"notemd","version":"6.1013.2"},"edits":[],"annotations":[]}).to_string();
        let queued = store.queue(root, "request1", &wire).unwrap();
        let before = std::fs::read(root.join(".notemd/base/sid/0.md")).unwrap();
        assert_eq!(
            send_pending(&queued, "request1", "FIXTURE_TOKEN")
                .await
                .unwrap_err(),
            "GUEST_HTTP_503"
        );
        std::fs::write(root.join("0.md"), "later draft").unwrap();
        let restarted = store::GuestStore::new(t.path().into()).unwrap();
        let pending = restarted.inspect(root).unwrap();
        assert_eq!(
            send_pending(&pending, "request1", "FIXTURE_TOKEN")
                .await
                .unwrap_err(),
            "GUEST_HTTP_409"
        );
        let body = send_pending(&pending, "request1", "FIXTURE_TOKEN")
            .await
            .unwrap();
        // Successful POST followed by failed local acknowledgement must leave pending durable.
        let metadata = root.join(".notemd/guest.json");
        let permissions = std::fs::metadata(&metadata).unwrap().permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&metadata, readonly).unwrap();
        assert_eq!(
            restarted.delivered(root, "request1", &body).unwrap_err(),
            "cannot save guest metadata"
        );
        std::fs::set_permissions(&metadata, permissions).unwrap();
        let restart2 = store::GuestStore::new(t.path().into()).unwrap();
        assert_eq!(restart2.inspect(root).unwrap().outbox[0].body, body);
        send_pending(
            &restart2.inspect(root).unwrap(),
            "request1",
            "FIXTURE_TOKEN",
        )
        .await
        .unwrap();
        restart2.delivered(root, "request1", &body).unwrap();
        assert_eq!(server.join().unwrap(), vec![wire.clone(); 4]);
        assert_eq!(
            std::fs::read_to_string(root.join("0.md")).unwrap(),
            "later draft"
        );
        assert_eq!(
            std::fs::read(root.join(".notemd/base/sid/0.md")).unwrap(),
            before
        );
    }
    #[tokio::test]
    async fn actual_p2_receipt_http_and_statuses_keep_pending() {
        let wire = include_bytes!("share_guest/fixtures/desktop-receipt.json");
        let receipt: serde_json::Value = serde_json::from_slice(wire).unwrap();
        let id = receipt["submissionId"].as_str().unwrap().to_string();
        let mut responses = vec![response(wire)];
        for status in [404, 403, 410] {
            responses.push(
                format!(
                    "HTTP/1.1 {status} Result\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .into_bytes(),
            );
        }
        let (origin, server) = serve(responses);
        let t = tempfile::tempdir().unwrap();
        let store = store::GuestStore::new(t.path().into()).unwrap();
        let snapshot = reader::extract_public_snapshot(&reader::tests::html(1)).unwrap();
        let mut info = store
            .install(
                &origin,
                "2026-10-14-test",
                &format!("{origin}/2026-10-14-test"),
                &snapshot,
            )
            .unwrap();
        info.submitted = vec![id.clone()];
        for status in [200, 404, 403, 410] {
            let rows = read_receipts(&info, &[id.clone()], "FIXTURE_TOKEN")
                .await
                .unwrap();
            assert_eq!(rows[0]["status"], status);
            if status == 200 {
                assert_eq!(rows[0]["receipt"], receipt);
            }
        }
        assert_eq!(server.join().unwrap().len(), 4);
        assert!(read_receipts(&info, &vec![id.clone(); 21], "FIXTURE_TOKEN")
            .await
            .is_err());
        assert!(read_receipts(&info, &["foreign".into()], "FIXTURE_TOKEN")
            .await
            .is_err());
        // Server is closed: network errors become a local row, not a fake receipt.
        assert_eq!(
            read_receipts(&info, &[id], "FIXTURE_TOKEN").await.unwrap()[0]["status"],
            0
        );
        let mut malicious = receipt.clone();
        malicious["body"] = "SECRET_BODY".into();
        assert!(!valid_receipt(
            &malicious,
            &info,
            receipt["submissionId"].as_str().unwrap()
        ));
        assert!(store
            .inspect(Path::new(&info.root))
            .unwrap()
            .outbox
            .is_empty());
    }
    fn serve(responses: Vec<Vec<u8>>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = vec![];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = vec![];
                let mut b = [0u8; 1];
                while stream.read(&mut b).unwrap_or(0) > 0 {
                    request.push(b[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(String::from_utf8(request).unwrap());
                let _ = stream.write_all(&response);
            }
            requests
        });
        (origin, handle)
    }
    fn response(body: &[u8]) -> Vec<u8> {
        let mut result = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        result.extend_from_slice(body);
        result
    }
    fn version(sid: &str) -> Vec<u8> {
        response(serde_json::json!({"schemaVersion":1,"project_id":"pid","snapshotId":sid,"archiveReady":true}).to_string().as_bytes())
    }
    #[test]
    fn link_parity_and_request_token_rejection() {
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            let origin = format!("http://{host}:8787");
            assert!(checked_link(
                &origin,
                "2026-10-14-test",
                &format!("{origin}/2026-10-14-test"),
                true
            )
            .is_ok());
            assert!(checked_link(
                &origin,
                "2026-10-14-test",
                &format!("{origin}/2026-10-14-test"),
                false
            )
            .is_err());
        }
        for origin in [
            "http://127.1",
            "https://u:secret@host",
            "https://host/path",
            "https://host?token=secret",
        ] {
            assert!(checked_link(
                origin,
                "2026-10-14-test",
                &format!("{origin}/2026-10-14-test"),
                true
            )
            .is_err())
        }
        assert!(serde_json::from_value::<Request>(serde_json::json!({"op":"open","origin":"https://host","slug":"2026-10-14-test","shareUrl":"https://host/2026-10-14-test","token":"FIXTURE_TOKEN"})).is_err());
    }
    #[tokio::test]
    async fn network_version_race_identity_status_truncation_zero_writes() {
        let (_, zip) = archive::tests::pair();
        let html = reader::tests::html(1);
        for scenario in [
            "race",
            "identity",
            "409",
            "410",
            "redirect",
            "truncated",
            "v1-truncated",
            "zip-truncated",
            "zip-invalid",
            "v2-410",
            "v2-truncated",
            "unready",
            "bad-schema",
            "success",
        ] {
            let sequence = match scenario {
                "race" => vec![
                    version("sid"),
                    response(&html),
                    response(&zip),
                    version("next"),
                ],
                "v1-truncated" => vec![b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort".to_vec()],
                "zip-truncated" => vec![version("sid"),response(&html),b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort".to_vec()],
                "zip-invalid" => vec![version("sid"),response(&html),response(b"invalid archive")],
                "v2-410" => vec![version("sid"),response(&html),response(&zip),b"HTTP/1.1 410 Gone\r\nContent-Length: 0\r\n\r\n".to_vec()],
                "v2-truncated" => vec![version("sid"),response(&html),response(&zip),b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort".to_vec()],
                "unready" => vec![response(br#"{"schemaVersion":1,"project_id":"pid","snapshotId":"sid","archiveReady":false}"#)],
                "bad-schema" => vec![response(br#"{"schemaVersion":2,"project_id":"pid","snapshotId":"sid","archiveReady":true}"#)],
                "identity" => vec![version("other"), response(&html)],
                "409" => vec![b"HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n".to_vec()],
                "410" => vec![b"HTTP/1.1 410 Gone\r\nContent-Length: 0\r\n\r\n".to_vec()],
                "redirect" => vec![
                    b"HTTP/1.1 302 Found\r\nLocation: /other\r\nContent-Length: 0\r\n\r\n".to_vec(),
                ],
                "truncated" => vec![
                    version("sid"),
                    b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort".to_vec(),
                ],
                _ => vec![
                    version("sid"),
                    response(&html),
                    response(&zip),
                    version("sid"),
                ],
            };
            let (origin, thread) = serve(sequence);
            let vault = tempfile::tempdir().unwrap();
            let store = store::GuestStore::new(vault.path().into()).unwrap();
            let url = format!("{origin}/2026-10-14-test");
            let result = download(&origin, "2026-10-14-test", &url).await;
            if scenario == "success" {
                let info = store
                    .install(&origin, "2026-10-14-test", &url, &result.unwrap())
                    .unwrap();
                assert_eq!(
                    std::fs::read(Path::new(&info.root).join("0.md")).unwrap(),
                    "\u{feff}<正文\r\n".as_bytes()
                );
            } else {
                assert!(result.is_err(), "{scenario}");
                assert_eq!(std::fs::read_dir(vault.path()).unwrap().count(), 0);
            }
            let requests = thread.join().unwrap();
            assert!(requests
                .iter()
                .all(|r| !r.contains("FIXTURE_TOKEN")
                    && !r.to_lowercase().contains("authorization:")));
            if scenario == "success" {
                assert!(requests[0].starts_with("GET /project/2026-10-14-test/version "));
                assert!(requests[1].starts_with("GET /2026-10-14-test "));
                assert!(requests[2].starts_with("GET /project/2026-10-14-test/download "));
                assert_eq!(requests[0], requests[3]);
            }
        }
    }
    #[tokio::test]
    async fn production_download_caps_accept_exact_and_reject_next_byte() {
        for cap in [MAX_SOURCE, MAX_ZIP] {
            for size in [cap, cap + 1] {
                let mut body = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
                body.resize(body.len() + size, b'x');
                let (origin, thread) = serve(vec![body]);
                let result = bounded_get(&reqwest::Client::new(), &origin, cap).await;
                if size == cap {
                    assert_eq!(result.unwrap().len(), cap);
                } else {
                    assert!(result.unwrap_err().contains("limit"));
                }
                thread.join().unwrap();
            }
        }
    }
    #[tokio::test]
    async fn streaming_limit_without_content_length() {
        let mut body = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        body.extend_from_slice(&[b'x'; 65]);
        let (origin, thread) = serve(vec![body]);
        let client = reqwest::Client::new();
        assert!(bounded_get(&client, &origin, 64)
            .await
            .unwrap_err()
            .contains("limit"));
        thread.join().unwrap();
    }
}
