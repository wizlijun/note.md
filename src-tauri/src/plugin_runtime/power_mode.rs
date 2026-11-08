//! `host.power_mode.*` —— Power Mode 的配置读写通道。
//!
//! 为什么需要它:特效引擎跑在宿主里(主窗口编辑器 + 下发给插件窗口的 Editor
//! Kit),而配置由 power-mode 插件的窗口编辑。插件窗口是隔离 webview,既没有
//! Tauri IPC 也够不到 settings.json,只能经这两条 RPC 走。
//!
//! 读侧返回的是**生效后**的值:插件没装/被停用就直接 `null`,所以不需要在卸载
//! 路径上补「清理残留配置」的钩子 —— 卸了就不炸。

use serde_json::{json, Value};

/// 本插件的 id。settings.json 里的键、生效面清单的排除项都用它。
pub const PLUGIN_ID: &str = "notemd.power-mode";

/// 一个已加载插件的最小画像,只取判定生效面需要的字段。
#[derive(Debug, Clone)]
pub struct PluginBrief {
    pub id: String,
    pub name: String,
    pub capabilities: Vec<String>,
    /// manifest 的 `i18n` 原样透传(形如 `{"zh": {"name": "…"}}`)。
    pub i18n: Option<Value>,
}

/// 从 settings.json 的整份 JSON 里取出 `plugins.<PLUGIN_ID>.config`。
pub fn config_from_settings(settings: &Value) -> Option<Value> {
    settings.get("plugins")?.get(PLUGIN_ID)?.get("config").cloned()
}

/// 生效后的配置。
///
/// - 插件没装/停用 → `null`(前端据此整体关闭)
/// - 装了但从没配过 → `{}`(前端用默认值:Idea Spark 开、主窗口关)
pub fn effective(installed: bool, settings: &Value) -> Value {
    if !installed {
        return Value::Null;
    }
    config_from_settings(settings).unwrap_or_else(|| json!({}))
}

/// 可作为生效面的插件:已加载、声明了 `editor.kit`、且不是 power-mode 自己
/// (它自己的窗口是实操区,不受生效面开关管)。
///
/// `names` 是 manifest `i18n.<locale>.name` 的映射;插件 UI 按自己的 locale 挑。
pub fn surfaces(plugins: &[PluginBrief]) -> Vec<Value> {
    let mut out: Vec<Value> = plugins
        .iter()
        .filter(|p| p.id != PLUGIN_ID)
        .filter(|p| p.capabilities.iter().any(|c| c == "editor.kit"))
        .map(|p| {
            let mut names = serde_json::Map::new();
            if let Some(Value::Object(map)) = p.i18n.as_ref() {
                for (locale, entry) in map {
                    if let Some(Value::String(n)) = entry.get("name") {
                        names.insert(locale.clone(), Value::String(n.clone()));
                    }
                }
            }
            json!({ "id": p.id, "name": p.name, "names": Value::Object(names) })
        })
        .collect();
    out.sort_by(|a, b| a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or("")));
    out
}

/// Only these inert, signed-package GIFs may cross the plugin resource boundary.
pub const ASSET_PREFIX: &str = "/__power_mode__/";
pub fn asset_paths() -> Vec<String> {
    [("particle", 8), ("lightning", 3), ("coin", 1), ("confetti", 1)]
        .into_iter().flat_map(|(preset, count)| (1..=count).map(move |n| format!("{preset}/{n}.gif"))).collect()
}

pub fn read_asset(ui_root: &std::path::Path, relative: &str) -> Option<Vec<u8>> {
    if !asset_paths().iter().any(|p| p == relative) { return None; }
    let root = ui_root.canonicalize().ok()?;
    let path = root.join("assets/power-mode").join(relative).canonicalize().ok()?;
    if !path.starts_with(&root) { return None; }
    let size = std::fs::metadata(&path).ok()?.len();
    if !(6..=1024 * 1024).contains(&size) { return None; }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 != size || !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) { return None; }
    Some(bytes)
}

pub fn asset_descriptor(ui_root: Option<&std::path::Path>, base: &str) -> Value {
    let Some(root) = ui_root else { return json!({"status":"disabled", "base":null}); };
    if asset_paths().iter().all(|p| read_asset(root, p).is_some()) {
        json!({"status":"ready", "base":base})
    } else {
        json!({"status":"missing", "base":null})
    }
}

pub fn installed_assets(base: &str) -> Value {
    let root = super::STATE.read().ok().and_then(|state| {
        let (manifest, install_dir) = state.plugins.get(PLUGIN_ID)?;
        Some(install_dir.join(manifest.ui.as_ref()?))
    });
    asset_descriptor(root.as_deref(), base)
}

/// The main WebView can load these inert images through the existing plugin
/// protocol; no file-system scopes or cross-plugin script origins are opened.
#[tauri::command]
pub fn plugin_v2_power_mode_assets(window: tauri::WebviewWindow) -> Result<Value, String> {
    if window.label() != "main" { return Err("main window required".into()); }
    Ok(installed_assets("plugin://notemd.power-mode/__power_mode__/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for name in asset_paths() {
            let path = dir.path().join("assets/power-mode").join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"GIF89a-test-fixture").unwrap();
        }
        dir
    }

    #[test]
    fn asset_catalog_requires_all_thirteen_gifs_and_never_falls_back_to_host() {
        let dir = asset_fixture();
        assert_eq!(asset_paths().len(), 13);
        assert_eq!(asset_descriptor(None, ASSET_PREFIX)["status"], "disabled");
        assert_eq!(asset_descriptor(Some(dir.path()), ASSET_PREFIX)["status"], "ready");
        std::fs::remove_file(dir.path().join("assets/power-mode/coin/1.gif")).unwrap();
        let missing = asset_descriptor(Some(dir.path()), ASSET_PREFIX);
        assert_eq!(missing["status"], "missing");
        assert!(missing["base"].is_null());
    }

    #[test]
    fn assets_reject_other_paths_non_gifs_and_symlink_escape() {
        let dir = asset_fixture();
        for name in ["../index.html", "%2e%2e/index.html", "particle/9.gif", "coin/1.gif.js", "coin/01.gif", "coin\\1.gif"] {
            assert!(read_asset(dir.path(), name).is_none(), "{name}");
        }
        let path = dir.path().join("assets/power-mode/coin/1.gif");
        std::fs::write(&path, b"<script>bad()</script>").unwrap();
        assert!(read_asset(dir.path(), "coin/1.gif").is_none());
        #[cfg(unix)] {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("other.gif"), b"GIF89a-outside").unwrap();
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(outside.path().join("other.gif"), &path).unwrap();
            assert!(read_asset(dir.path(), "coin/1.gif").is_none());
        }
    }

    fn brief(id: &str, caps: &[&str], i18n: Option<Value>) -> PluginBrief {
        PluginBrief {
            id: id.into(),
            name: id.into(),
            capabilities: caps.iter().map(|s| s.to_string()).collect(),
            i18n,
        }
    }

    #[test]
    fn effective_is_null_when_the_plugin_is_not_loaded() {
        let settings = json!({ "plugins": { PLUGIN_ID: { "config": { "surfaces": { "main": true } } } } });
        assert_eq!(effective(false, &settings), Value::Null);
    }

    #[test]
    fn effective_is_empty_object_when_installed_but_never_configured() {
        assert_eq!(effective(true, &json!({})), json!({}));
        assert_eq!(effective(true, &json!({ "plugins": {} })), json!({}));
    }

    #[test]
    fn effective_returns_the_stored_config_verbatim() {
        let settings = json!({ "plugins": { PLUGIN_ID: { "config": { "surfaces": { "main": true } } } } });
        assert_eq!(effective(true, &settings), json!({ "surfaces": { "main": true } }));
    }

    #[test]
    fn surfaces_keeps_only_editor_kit_plugins_and_drops_power_mode_itself() {
        let list = vec![
            brief("notemd.idea-spark", &["editor.kit", "vault.read"], None),
            brief("notemd.roam-import", &["vault.read"], None),
            brief(PLUGIN_ID, &["editor.kit", "power-mode"], None),
        ];
        let out = surfaces(&list);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], "notemd.idea-spark");
    }

    #[test]
    fn surfaces_carries_the_localized_names() {
        let list = vec![brief(
            "notemd.idea-spark",
            &["editor.kit"],
            Some(json!({ "zh": { "name": "奇思妙想" }, "ja": { "name": "アイデアスパーク" } })),
        )];
        let out = surfaces(&list);
        assert_eq!(out[0]["names"]["zh"], "奇思妙想");
        assert_eq!(out[0]["names"]["ja"], "アイデアスパーク");
        assert_eq!(out[0]["name"], "notemd.idea-spark");
    }

    #[test]
    fn surfaces_is_sorted_by_id_for_a_stable_ui_order() {
        let list = vec![
            brief("notemd.zeta", &["editor.kit"], None),
            brief("notemd.alpha", &["editor.kit"], None),
        ];
        let out = surfaces(&list);
        assert_eq!(out[0]["id"], "notemd.alpha");
        assert_eq!(out[1]["id"], "notemd.zeta");
    }
}
