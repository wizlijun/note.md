//! Verified public downloads. Credentials never cross this command boundary.
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
#[tauri::command]
pub async fn share_guest(
    app: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    let request: Request = serde_json::from_value(request).map_err(|_| "invalid guest request")?;
    let vault = crate::sotvault::resolve_vault_root(&app).ok_or("Vault not configured")?;
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
