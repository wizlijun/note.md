//! Plugin system v2 wire contract. THE single source of truth:
//! `gen-schema` emits JSON Schemas (protocol/schema/), from which the TS
//! types (src/lib/plugins/v2/protocol.gen.ts) are generated.
//! Release preflight (pnpm check:protocol) diffs both.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 2;

// ── Manifest v2 (spec §2) ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ManifestV2 {
    pub manifest_version: u32,              // 必须 == 2
    pub id: String,                         // publisher.name
    pub name: String,
    pub version: String,                    // semver
    pub kind: PluginKind,                   // 本期仅 native
    pub engines: Engines,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub binary: std::collections::BTreeMap<String, String>, // target triple → 包内相对路径
    #[serde(default)]
    pub ui: Option<String>,                 // ②期使用；本期仅透传
    pub activation: Activation,
    #[serde(default)]
    pub contributes: Contributes,
    pub capabilities: Vec<String>,          // 见 host_api::method_capability
    #[serde(default)]
    pub request_timeout_seconds: Option<u64>, // 默认 30，上限 300
    #[serde(default)]
    pub idle_shutdown_seconds: Option<u64>,
    #[serde(default)]
    pub i18n: Option<serde_json::Value>,    // 结构同 v1 PluginI18n，宿主透传不解释
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind { Native, Wasm }       // wasm 仅保留字面量（spec §15）

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Engines { pub notemd: String }  // semver range，如 ">=6.717.0"

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Activation { pub events: Vec<String> }
// 合法事件（spec §4.3）：`*`、`onStartupFinished`、`onCommand:<c>`、`onCli:<sub>`、`onFileType:<ext>`

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Contributes {
    pub menus: Vec<serde_json::Value>,          // 语义同 v1 MenuEntry；宿主经 adapter 透传
    pub context_menus: Vec<serde_json::Value>,  // 语义同 v1 ContextMenuEntry
    pub windows: Vec<WindowContribution>,       // ②期消费；窗口贡献
    pub custom_editors: Vec<serde_json::Value>, // ④期消费
    pub settings: Option<serde_json::Value>,    // 语义同 v1 settings
    pub cli: Vec<serde_json::Value>,            // 语义同 v1 CliEntry
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WindowContribution {
    pub id: String,                 // 窗口 id（label = plugin-<sanitized plugin id>-<id>）
    pub entry: String,              // ui/ 内相对路径，如 "index.html"
    #[serde(default)]
    pub title: Option<String>,      // 缺省用插件 name
    pub width: f64,
    pub height: f64,
    #[serde(default)] pub min_width: Option<f64>,
    #[serde(default)] pub min_height: Option<f64>,
    #[serde(default = "default_true")] pub singleton: bool,
    /// contributes.menus 中命中此 command 的菜单项 = 打开本窗口（不走 command.execute）。
    #[serde(default)] pub open_command: Option<String>,
}

fn default_true() -> bool { true }

// ── JSON-RPC 2.0 信封（NDJSON，一行一条）────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcRequest {
    pub jsonrpc: String,                    // "2.0"
    pub id: Option<u64>,                    // None ⇒ notification
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcError { pub code: i64, pub message: String }

pub const ERR_CAPABILITY_DENIED: i64 = -32001;
pub const ERR_METHOD_NOT_FOUND: i64 = -32601;
/// Host-side execution failure (IO / dialog / vault). Message carries a
/// `"<kind>: <detail>"` prefix (e.g. `"vault_required: …"`).
pub const ERR_INTERNAL: i64 = -32000;

// ── 宿主→插件方法负载（spec §4.4）───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InitializeParams {
    pub protocol_version: u32,
    pub host_version: String,
    pub locale: String,
    pub theme: String,
    pub plugin_root: String,                // 插件安装目录（current/）
    pub data_dir: String,                   // <app_data>/plugin_data/<id>/
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActivateParams { pub event: String }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExecuteCommandParams {
    pub command: String,
    pub context: serde_json::Value,         // 形状与 v1 PluginRequest.context 一致（含 tab / rendered_html / output_path；宿主在前端解析 CLI flags 后注入，插件无需自行解析命令行参数）
}

// ── 插件→宿主方法（host.*；capability 映射见 host_api）──────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToastParams {
    pub level: String,                      // success|info|warn|error
    pub message: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LogParams { pub message: String }

// ── Manifest 校验 ───────────────────────────────────────────────────────

pub fn validate_manifest(m: &ManifestV2, host_version: &str) -> Result<(), String> {
    if m.manifest_version != 2 { return Err(format!("manifest_version {} != 2", m.manifest_version)); }
    let id_re_ok = {
        let parts: Vec<&str> = m.id.split('.').collect();
        parts.len() == 2 && parts.iter().all(|p| !p.is_empty()
            && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
    };
    if !id_re_ok { return Err(format!("id '{}' must be publisher.name ([a-z0-9-])", m.id)); }
    semver::Version::parse(&m.version).map_err(|e| format!("version: {e}"))?;
    let req = semver::VersionReq::parse(&m.engines.notemd).map_err(|e| format!("engines.notemd: {e}"))?;
    let host = semver::Version::parse(host_version).map_err(|e| format!("host version: {e}"))?;
    if !req.matches(&host) { return Err(format!("requires notemd {}, host is {host}", m.engines.notemd)); }
    if m.kind == PluginKind::Wasm { return Err("kind 'wasm' is reserved, not yet supported".into()); }
    if m.binary.is_empty() && m.ui.is_none() {
        return Err("plugin must provide binary and/or ui".into());
    }
    if !m.contributes.windows.is_empty() && m.ui.is_none() {
        return Err("contributes.windows requires ui to be set".into());
    }
    let win_id_ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    for w in &m.contributes.windows {
        if w.entry.contains("..") {
            return Err(format!("window '{}': entry must not contain '..'", w.id));
        }
        if !win_id_ok(&w.id) {
            return Err(format!("window id '{}' must match [a-z0-9-]+", w.id));
        }
    }
    for ev in &m.activation.events {
        let ok = ev == "*" || ev == "onStartupFinished"
            || ev.strip_prefix("onCommand:").map_or(false, |s| !s.is_empty())
            || ev.strip_prefix("onCli:").map_or(false, |s| !s.is_empty())
            || ev.strip_prefix("onFileType:").map_or(false, |s| !s.is_empty());
        if !ok { return Err(format!("unknown activation event '{ev}'")); }
    }
    Ok(())
}

// ── Unit tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The canonical md2pdf manifest sample (from Task 11 Step 3).
    fn md2pdf_manifest_json() -> serde_json::Value {
        json!({
            "manifest_version": 2,
            "id": "notemd.md2pdf",
            "name": "Export to PDF",
            "version": "1.0.0",
            "kind": "native",
            "engines": { "notemd": ">=6.716.7" },
            "description": "Export the current Markdown or HTML tab to a typographically-clean A4 PDF",
            "binary": { "aarch64-apple-darwin": "bin/md2pdf-v2", "x86_64-apple-darwin": "bin/md2pdf-v2" },
            "activation": { "events": ["onCommand:export", "onCli:pdf2"] },
            "contributes": {
                "menus": [{ "location": "file", "label": "Export to PDF (v2)…", "command": "export",
                            "enabled_when": "currentTab.kind == 'markdown' || currentTab.kind == 'html'",
                            "prompt": { "kind": "save-dialog", "default_filename": "{stem}.pdf",
                                        "filters": [{ "name": "PDF", "extensions": ["pdf"] }] } }],
                "cli": [{ "subcommand": "pdf2", "command": "export",
                          "summary": "Export Markdown or HTML file to PDF (v2 runtime)",
                          "args": [{ "name": "file", "type": "path", "required": true, "help": "File to export" }],
                          "flags": [{ "long": "--output", "short": "-o", "type": "string", "help": "Output PDF path" }],
                          "requires_tab_context": true }]
            },
            "capabilities": ["renderer.html", "toast"],
            "request_timeout_seconds": 60,
            "idle_shutdown_seconds": 120
        })
    }

    fn sample_manifest() -> ManifestV2 {
        serde_json::from_value(md2pdf_manifest_json()).expect("sample manifest should deserialize")
    }

    // ── validate_manifest: ACCEPT ──────────────────────────────────────

    #[test]
    fn validate_accepts_md2pdf_sample() {
        let m = sample_manifest();
        assert_eq!(validate_manifest(&m, "6.716.7"), Ok(()));
        // host version satisfying >= range also passes
        assert_eq!(validate_manifest(&m, "7.0.0"), Ok(()));
    }

    // ── validate_manifest: REJECT ──────────────────────────────────────

    #[test]
    fn validate_rejects_manifest_version_1() {
        let mut m = sample_manifest();
        m.manifest_version = 1;
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert!(err.contains("manifest_version"), "got: {err}");
    }

    #[test]
    fn validate_rejects_id_without_dot() {
        let mut m = sample_manifest();
        m.id = "md2pdf".to_string();
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert!(err.contains("publisher.name"), "got: {err}");
    }

    #[test]
    fn validate_rejects_id_uppercase() {
        let mut m = sample_manifest();
        m.id = "Notemd.md2pdf".to_string();
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert!(err.contains("publisher.name"), "got: {err}");
    }

    #[test]
    fn validate_rejects_engines_not_satisfied() {
        let mut m = sample_manifest();
        m.engines.notemd = ">=99.0.0".to_string();
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert!(err.contains("requires notemd"), "got: {err}");
    }

    #[test]
    fn validate_rejects_kind_wasm() {
        let mut m = sample_manifest();
        m.kind = PluginKind::Wasm;
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert!(err.contains("wasm"), "got: {err}");
    }

    #[test]
    fn validate_rejects_unknown_activation_event() {
        let mut m = sample_manifest();
        m.activation.events = vec!["onSave".to_string()];
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert!(err.contains("onSave"), "got: {err}");
    }

    // ── RpcRequest serde round-trip ────────────────────────────────────

    #[test]
    fn rpc_request_with_id_round_trip() {
        let req = RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(42),
            method: "$activate".to_string(),
            params: json!({"event": "onStartupFinished"}),
        };
        let json_str = serde_json::to_string(&req).unwrap();
        let decoded: RpcRequest = serde_json::from_str(&json_str).unwrap();
        assert_eq!(decoded.id, Some(42));
        assert_eq!(decoded.method, "$activate");
        assert_eq!(decoded.params["event"], "onStartupFinished");
    }

    #[test]
    fn rpc_request_notification_no_id() {
        // notification: id is None, should serialize as null or absent
        let req = RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: "host.toast".to_string(),
            params: json!({"level": "info", "message": "hello"}),
        };
        let json_str = serde_json::to_string(&req).unwrap();
        let decoded: RpcRequest = serde_json::from_str(&json_str).unwrap();
        assert_eq!(decoded.id, None);
        assert_eq!(decoded.method, "host.toast");
    }

    #[test]
    fn rpc_response_with_result_round_trip() {
        let resp = RpcResponse {
            jsonrpc: "2.0".to_string(),
            id: 1,
            result: Some(json!({"ok": true})),
            error: None,
        };
        let json_str = serde_json::to_string(&resp).unwrap();
        // error should be absent (skip_serializing_if)
        assert!(!json_str.contains("\"error\""), "error should not appear in json: {json_str}");
        let decoded: RpcResponse = serde_json::from_str(&json_str).unwrap();
        assert_eq!(decoded.id, 1);
        assert_eq!(decoded.result, Some(json!({"ok": true})));
        assert!(decoded.error.is_none());
    }

    #[test]
    fn rpc_response_with_error_round_trip() {
        let resp = RpcResponse {
            jsonrpc: "2.0".to_string(),
            id: 2,
            result: None,
            error: Some(RpcError { code: ERR_CAPABILITY_DENIED, message: "denied".to_string() }),
        };
        let json_str = serde_json::to_string(&resp).unwrap();
        // result should be absent
        assert!(!json_str.contains("\"result\""), "result should not appear: {json_str}");
        let decoded: RpcResponse = serde_json::from_str(&json_str).unwrap();
        assert_eq!(decoded.id, 2);
        assert!(decoded.result.is_none());
        let err = decoded.error.unwrap();
        assert_eq!(err.code, ERR_CAPABILITY_DENIED);
        assert_eq!(err.message, "denied");
    }

    // ── JSON Schema validation using jsonschema crate ──────────────────

    #[test]
    fn schema_validates_valid_manifest() {
        use jsonschema::JSONSchema;
        use schemars::schema_for;

        let schema_value = serde_json::to_value(schema_for!(ManifestV2)).unwrap();
        let compiled = JSONSchema::compile(&schema_value).expect("schema should compile");

        let instance = md2pdf_manifest_json();
        let result = compiled.validate(&instance);
        assert!(result.is_ok(), "valid manifest should pass schema validation: {:?}",
            result.err().map(|e| e.collect::<Vec<_>>()));
    }

    #[test]
    fn schema_rejects_manifest_missing_id() {
        use jsonschema::JSONSchema;
        use schemars::schema_for;

        let schema_value = serde_json::to_value(schema_for!(ManifestV2)).unwrap();
        let compiled = JSONSchema::compile(&schema_value).expect("schema should compile");

        let mut instance = md2pdf_manifest_json();
        instance.as_object_mut().unwrap().remove("id");
        let result = compiled.validate(&instance);
        assert!(result.is_err(), "manifest missing 'id' should fail schema validation");
    }

    // ── binary optional / ui-only rules ───────────────────────────────

    #[test]
    fn validate_rejects_neither_binary_nor_ui() {
        let mut m = sample_manifest();
        m.binary.clear();
        m.ui = None;
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert_eq!(err, "plugin must provide binary and/or ui", "got: {err}");
    }

    #[test]
    fn validate_accepts_ui_only_manifest_with_window() {
        let json = json!({
            "manifest_version": 2,
            "id": "notemd.roam-import",
            "name": "Roam Import",
            "version": "2.0.0",
            "kind": "native",
            "engines": { "notemd": ">=6.716.7" },
            "ui": "ui/",
            "activation": { "events": ["onCommand:open"] },
            "contributes": {
                "windows": [{
                    "id": "main",
                    "entry": "index.html",
                    "width": 800.0,
                    "height": 600.0,
                    "open_command": "open"
                }]
            },
            "capabilities": ["dialog", "vault.read", "vault.write"]
        });
        let m: ManifestV2 = serde_json::from_value(json).expect("should deserialize");
        assert_eq!(validate_manifest(&m, "7.0.0"), Ok(()));
    }

    #[test]
    fn validate_rejects_windows_without_ui() {
        let mut m = sample_manifest();
        // binary is set, ui is None
        m.ui = None;
        m.contributes.windows = vec![WindowContribution {
            id: "main".to_string(),
            entry: "index.html".to_string(),
            title: None,
            width: 800.0,
            height: 600.0,
            min_width: None,
            min_height: None,
            singleton: true,
            open_command: None,
        }];
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert!(err.contains("windows requires ui"), "got: {err}");
    }

    #[test]
    fn validate_rejects_window_entry_with_dotdot() {
        let json = json!({
            "manifest_version": 2,
            "id": "notemd.test",
            "name": "Test",
            "version": "1.0.0",
            "kind": "native",
            "engines": { "notemd": ">=6.716.7" },
            "ui": "ui/",
            "activation": { "events": ["*"] },
            "contributes": {
                "windows": [{
                    "id": "main",
                    "entry": "../../../etc/passwd",
                    "width": 800.0,
                    "height": 600.0
                }]
            },
            "capabilities": []
        });
        let m: ManifestV2 = serde_json::from_value(json).expect("should deserialize");
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert!(err.contains(".."), "got: {err}");
    }

    #[test]
    fn validate_rejects_window_id_uppercase() {
        let json = json!({
            "manifest_version": 2,
            "id": "notemd.test",
            "name": "Test",
            "version": "1.0.0",
            "kind": "native",
            "engines": { "notemd": ">=6.716.7" },
            "ui": "ui/",
            "activation": { "events": ["*"] },
            "contributes": {
                "windows": [{
                    "id": "Main",
                    "entry": "index.html",
                    "width": 800.0,
                    "height": 600.0
                }]
            },
            "capabilities": []
        });
        let m: ManifestV2 = serde_json::from_value(json).expect("should deserialize");
        let err = validate_manifest(&m, "7.0.0").unwrap_err();
        assert!(err.contains("[a-z0-9-]"), "got: {err}");
    }

    #[test]
    fn validate_accepts_binary_and_ui_together() {
        let json = json!({
            "manifest_version": 2,
            "id": "notemd.hybrid",
            "name": "Hybrid",
            "version": "1.0.0",
            "kind": "native",
            "engines": { "notemd": ">=6.716.7" },
            "binary": { "aarch64-apple-darwin": "bin/hybrid" },
            "ui": "ui/",
            "activation": { "events": ["*"] },
            "contributes": {},
            "capabilities": []
        });
        let m: ManifestV2 = serde_json::from_value(json).expect("should deserialize");
        assert_eq!(validate_manifest(&m, "7.0.0"), Ok(()));
    }
}
