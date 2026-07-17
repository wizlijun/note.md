//! `plugin://` custom URI scheme (spec §7.1, 子项目② Task 2).
//!
//! Serves plugin UI static assets (`GET plugin://<id>/<path>` from
//! `<install>/current/<ui>/`) and carries the UI→host fetch-RPC bridge
//! (`POST plugin://<id>/__rpc__`). Plugin windows are granted ZERO Tauri
//! IPC (no capability entry) — this protocol IS the only bridge, and the
//! request Origin (`plugin://<id>`) authenticates the calling plugin.
//!
//! Layering: `resolve_asset`/`mime_for`/`csp_header`/`handle_parsed` are a
//! pure, unit-testable core (no AppHandle, no global STATE); `handle` is the
//! thin shell registered on the Builder that binds them to `STATE`.

use std::path::{Path, PathBuf};

use tauri::http;

// ── Asset resolution ────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub enum AssetError {
    NotFound,
    Traversal,
}

/// GET asset resolution: URL path → absolute file path under `ui_root`.
///
/// - Percent-decodes first, so encoded traversal (`%2e%2e`) hits the same
///   guard as a literal `..`.
/// - Empty path / `/` is NOT an implicit index — the entry point is explicit
///   in the manifest. A trailing `/` on a non-empty path appends `index.html`.
/// - `..` segments are rejected before any filesystem access; containment is
///   then re-verified against the canonicalized root, which also defeats
///   symlink escapes.
pub fn resolve_asset(ui_root: &Path, url_path: &str) -> Result<PathBuf, AssetError> {
    let decoded = urlencoding::decode(url_path).map_err(|_| AssetError::NotFound)?;
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() {
        return Err(AssetError::NotFound);
    }
    let rel = if trimmed.ends_with('/') {
        format!("{trimmed}index.html")
    } else {
        trimmed.to_string()
    };
    if rel.split('/').any(|seg| seg == "..") {
        return Err(AssetError::Traversal);
    }
    let root = ui_root.canonicalize().map_err(|_| AssetError::NotFound)?;
    let resolved = root.join(&rel).canonicalize().map_err(|_| AssetError::NotFound)?;
    if !resolved.starts_with(&root) {
        return Err(AssetError::Traversal);
    }
    if !resolved.is_file() {
        return Err(AssetError::NotFound);
    }
    Ok(resolved)
}

pub fn mime_for(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html") => "text/html",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}

/// `'self'` under a `plugin://<id>` origin is this plugin only; every remote
/// load is denied (spec §7.1).
pub fn csp_header(_plugin_id: &str) -> String {
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
     img-src 'self' data:; connect-src 'self'"
        .to_string()
}

// ── Request handling (pure core) ────────────────────────────────────────

/// Minimal read view over the loaded-plugin table so `handle_parsed` is
/// testable without an AppHandle or the global STATE.
pub trait PluginView {
    /// id → (ui_root, capabilities). `None` ⇒ flag off / unknown id / no ui.
    fn lookup(&self, plugin_id: &str) -> Option<(PathBuf, Vec<String>)>;
}

const RPC_PATH: &str = "/__rpc__";

pub fn handle_parsed(
    view: &dyn PluginView,
    method: &str,
    plugin_id: &str,
    path: &str,
    origin: Option<&str>,
    _body: &[u8], // Task 3: consumed by ui_rpc::dispatch
) -> http::Response<Vec<u8>> {
    // `_capabilities` feeds ui_rpc's capability gate in Task 3.
    let Some((ui_root, _capabilities)) = view.lookup(plugin_id) else {
        return plain(http::StatusCode::NOT_FOUND, "unknown plugin");
    };
    match method {
        "POST" if path == RPC_PATH => {
            let expected = format!("plugin://{plugin_id}");
            if origin != Some(expected.as_str()) {
                return plain(http::StatusCode::FORBIDDEN, "origin mismatch");
            }
            // Task 3 replaces this skeleton with ui_rpc::dispatch.
            http::Response::builder()
                .status(http::StatusCode::NOT_IMPLEMENTED)
                .header("content-type", "application/json")
                .body(
                    br#"{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"rpc not wired yet"}}"#
                        .to_vec(),
                )
                .unwrap()
        }
        "GET" => match resolve_asset(&ui_root, path) {
            Ok(file) => {
                let Ok(bytes) = std::fs::read(&file) else {
                    return plain(http::StatusCode::NOT_FOUND, "not found");
                };
                let mime = mime_for(&file);
                let mut builder = http::Response::builder()
                    .status(http::StatusCode::OK)
                    .header("content-type", mime)
                    .header("cache-control", "no-cache");
                if mime == "text/html" {
                    builder = builder.header("content-security-policy", csp_header(plugin_id));
                }
                builder.body(bytes).unwrap()
            }
            Err(AssetError::Traversal) => plain(http::StatusCode::FORBIDDEN, "forbidden"),
            Err(AssetError::NotFound) => plain(http::StatusCode::NOT_FOUND, "not found"),
        },
        "POST" => plain(http::StatusCode::NOT_FOUND, "not found"),
        _ => plain(http::StatusCode::METHOD_NOT_ALLOWED, "method not allowed"),
    }
}

fn plain(status: http::StatusCode, msg: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

// ── AppHandle shell ─────────────────────────────────────────────────────

struct StateView;

impl PluginView for StateView {
    fn lookup(&self, plugin_id: &str) -> Option<(PathBuf, Vec<String>)> {
        let st = super::STATE.read().ok()?;
        if !st.enabled_flag {
            return None;
        }
        let (manifest, install_dir) = st.plugins.get(plugin_id)?;
        let ui = manifest.ui.as_ref()?; // e.g. "ui/"; install_dir = <install>/current
        Some((install_dir.join(ui), manifest.capabilities.clone()))
    }
}

/// Thin shell registered via `register_uri_scheme_protocol`. macOS-only URL
/// shape: requests arrive as `plugin://<id>/<path>` (id = URL host; other
/// platforms would nest it in the path, which we don't handle).
pub fn handle<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let Ok(url) = url::Url::parse(&request.uri().to_string()) else {
        return plain(http::StatusCode::NOT_FOUND, "bad url");
    };
    let Some(plugin_id) = url.host_str().map(str::to_string) else {
        return plain(http::StatusCode::NOT_FOUND, "missing plugin id");
    };
    let origin = request
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    handle_parsed(
        &StateView,
        request.method().as_str(),
        &plugin_id,
        url.path(),
        origin.as_deref(),
        request.body(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct MapView(HashMap<String, (PathBuf, Vec<String>)>);

    impl PluginView for MapView {
        fn lookup(&self, plugin_id: &str) -> Option<(PathBuf, Vec<String>)> {
            self.0.get(plugin_id).cloned()
        }
    }

    fn ui_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<html></html>").unwrap();
        std::fs::write(dir.path().join("app.js"), "console.log(1)").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/index.html"), "<html>sub</html>").unwrap();
        dir
    }

    fn view_for(dir: &Path) -> MapView {
        let mut map = HashMap::new();
        map.insert(
            "test.plugin".to_string(),
            (dir.to_path_buf(), vec!["toast".to_string()]),
        );
        MapView(map)
    }

    // ── resolve_asset ───────────────────────────────────────────────────

    #[test]
    fn resolve_happy_path() {
        let dir = ui_fixture();
        let p = resolve_asset(dir.path(), "/index.html").unwrap();
        assert_eq!(std::fs::read_to_string(p).unwrap(), "<html></html>");
    }

    #[test]
    fn resolve_trailing_slash_appends_index() {
        let dir = ui_fixture();
        let p = resolve_asset(dir.path(), "/sub/").unwrap();
        assert!(p.ends_with("sub/index.html"), "{p:?}");
    }

    #[test]
    fn resolve_root_is_not_implicit_index() {
        let dir = ui_fixture();
        assert_eq!(resolve_asset(dir.path(), "").unwrap_err(), AssetError::NotFound);
        assert_eq!(resolve_asset(dir.path(), "/").unwrap_err(), AssetError::NotFound);
    }

    #[test]
    fn resolve_rejects_plain_dotdot() {
        let dir = ui_fixture();
        assert_eq!(resolve_asset(dir.path(), "/../secret").unwrap_err(), AssetError::Traversal);
        assert_eq!(
            resolve_asset(dir.path(), "/sub/../../secret").unwrap_err(),
            AssetError::Traversal
        );
    }

    #[test]
    fn resolve_rejects_percent_encoded_dotdot() {
        let dir = ui_fixture();
        assert_eq!(
            resolve_asset(dir.path(), "/%2e%2e/secret").unwrap_err(),
            AssetError::Traversal
        );
    }

    #[test]
    fn resolve_rejects_symlink_escape() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "s3cret").unwrap();
        let dir = ui_fixture();
        if std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).is_err() {
            eprintln!("skipping: symlink creation not supported here");
            return;
        }
        assert_eq!(
            resolve_asset(dir.path(), "/link/secret.txt").unwrap_err(),
            AssetError::Traversal
        );
    }

    #[test]
    fn resolve_missing_file_not_found() {
        let dir = ui_fixture();
        assert_eq!(resolve_asset(dir.path(), "/nope.js").unwrap_err(), AssetError::NotFound);
    }

    // ── mime_for / csp_header ───────────────────────────────────────────

    #[test]
    fn mime_table_spot_checks() {
        assert_eq!(mime_for(Path::new("a.html")), "text/html");
        assert_eq!(mime_for(Path::new("a.js")), "text/javascript");
        assert_eq!(mime_for(Path::new("a.mjs")), "text/javascript");
        assert_eq!(mime_for(Path::new("a.css")), "text/css");
        assert_eq!(mime_for(Path::new("a.map")), "application/json");
        assert_eq!(mime_for(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("a.woff2")), "font/woff2");
        assert_eq!(mime_for(Path::new("a.wasm")), "application/wasm");
        assert_eq!(mime_for(Path::new("a.PNG")), "image/png");
        assert_eq!(mime_for(Path::new("a.bin")), "application/octet-stream");
        assert_eq!(mime_for(Path::new("noext")), "application/octet-stream");
    }

    #[test]
    fn csp_exact_string() {
        assert_eq!(
            csp_header("test.plugin"),
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data:; connect-src 'self'"
        );
    }

    // ── handle_parsed ───────────────────────────────────────────────────

    #[test]
    fn handle_unknown_plugin_404() {
        let dir = ui_fixture();
        let view = view_for(dir.path());
        let r = handle_parsed(&view, "GET", "other.plugin", "/index.html", None, &[]);
        assert_eq!(r.status(), 404);
    }

    #[test]
    fn handle_get_html_has_csp_and_no_cache() {
        let dir = ui_fixture();
        let view = view_for(dir.path());
        let r = handle_parsed(&view, "GET", "test.plugin", "/index.html", None, &[]);
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["content-type"], "text/html");
        assert_eq!(r.headers()["cache-control"], "no-cache");
        assert_eq!(
            r.headers()["content-security-policy"].to_str().unwrap(),
            csp_header("test.plugin")
        );
        assert_eq!(r.body(), b"<html></html>");
    }

    #[test]
    fn handle_get_js_has_no_csp() {
        let dir = ui_fixture();
        let view = view_for(dir.path());
        let r = handle_parsed(&view, "GET", "test.plugin", "/app.js", None, &[]);
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["content-type"], "text/javascript");
        assert_eq!(r.headers()["cache-control"], "no-cache");
        assert!(r.headers().get("content-security-policy").is_none());
    }

    #[test]
    fn handle_get_traversal_403() {
        let dir = ui_fixture();
        let view = view_for(dir.path());
        let r = handle_parsed(&view, "GET", "test.plugin", "/%2e%2e/secret", None, &[]);
        assert_eq!(r.status(), 403);
    }

    #[test]
    fn handle_rpc_wrong_origin_403() {
        let dir = ui_fixture();
        let view = view_for(dir.path());
        for origin in [None, Some("plugin://other.plugin"), Some("tauri://localhost")] {
            let r = handle_parsed(&view, "POST", "test.plugin", "/__rpc__", origin, b"{}");
            assert_eq!(r.status(), 403, "origin {origin:?} must be rejected");
        }
    }

    #[test]
    fn handle_rpc_right_origin_501_skeleton() {
        let dir = ui_fixture();
        let view = view_for(dir.path());
        let r = handle_parsed(
            &view,
            "POST",
            "test.plugin",
            "/__rpc__",
            Some("plugin://test.plugin"),
            b"{}",
        );
        assert_eq!(r.status(), 501);
        assert_eq!(r.headers()["content-type"], "application/json");
        let body: serde_json::Value = serde_json::from_slice(r.body()).unwrap();
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(body["error"]["code"], -32601);
        assert_eq!(body["error"]["message"], "rpc not wired yet");
    }

    #[test]
    fn handle_put_405() {
        let dir = ui_fixture();
        let view = view_for(dir.path());
        let r = handle_parsed(&view, "PUT", "test.plugin", "/index.html", None, &[]);
        assert_eq!(r.status(), 405);
    }
}
