//! A fixed-path history surface. Plugins never choose a repository or Git path.
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn check_authority(state: &super::RuntimeState, plugin: &str, method: &str) -> Result<(), String> {
    if plugin != "notemd.habitat" {
        return Err("CAPABILITY_DENIED: only HABITAT owns this history surface".into());
    }
    let (manifest, _) = state
        .plugins
        .get(plugin)
        .ok_or("CAPABILITY_DENIED: plugin is no longer active")?;
    if let Some(cap) = super::host_api::missing_knowledge_capability(method, &manifest.capabilities)
    {
        return Err(format!("CAPABILITY_DENIED: {cap} revoked"));
    }
    Ok(())
}

fn check_params(method: &str, params: &Value) -> Result<(), String> {
    let allowed: &[&str] = match method {
        "host.knowledge.load" | "host.knowledge.recover" | "host.knowledge.discard" => {
            &["vaultKey"]
        }
        "host.knowledge.history" => &["vaultKey", "limit"],
        "host.knowledge.read" => &["vaultKey", "commit"],
        "host.knowledge.save" => &["vaultKey", "indexSnapshotId", "expectedBase", "content"],
        _ => return Err("METHOD_NOT_FOUND".into()),
    };
    let object = params
        .as_object()
        .ok_or("INVALID_PARAMS: expected an object")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("INVALID_PARAMS: unknown knowledge parameter".into());
    }
    if params["vaultKey"].as_str().is_none() {
        return Err("INVALID_PARAMS: missing vaultKey".into());
    }
    if method == "host.knowledge.history"
        && object.contains_key("limit")
        && !params["limit"]
            .as_u64()
            .is_some_and(|limit| (1..=200).contains(&limit))
    {
        return Err("INVALID_PARAMS: limit must be between 1 and 200".into());
    }
    if method == "host.knowledge.save"
        && !params["expectedBase"].is_null()
        && !params["expectedBase"]
            .as_str()
            .is_some_and(habitat_core::codec::valid_hash)
    {
        return Err("INVALID_PARAMS: expectedBase must be a snapshot ID or null".into());
    }
    Ok(())
}

fn current_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    crate::sotvault::resolve_vault_root(app)
        .ok_or("请先打开 Vault")?
        .canonicalize()
        .map_err(|e| e.to_string())
}

fn check_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &Path) -> Result<(), String> {
    if current_root(app)? != root {
        return Err("Vault 已切换，请刷新知识结构".into());
    }
    Ok(())
}

pub fn dispatch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin: &str,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    check_params(method, params)?;
    {
        let state = super::STATE
            .read()
            .map_err(|_| "PLUGIN_STATE_UNAVAILABLE")?;
        check_authority(&state, plugin, method)?;
    }
    let root = current_root(app)?;
    let key = habitat_core::hash(root.to_string_lossy().as_bytes());
    if params["vaultKey"].as_str() != Some(key.as_str()) {
        return Err("Vault 已切换，请刷新知识结构".into());
    }
    let runtime = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("knowledge-structure")
        .join(&key);
    // Index validation reads STATE itself; do this before retaining a read lease.
    let bytes = if method == "host.knowledge.save" {
        Some(habitat_core::codec::transport_decode(
            params["content"].as_str().ok_or("缺少结构内容")?,
        )?)
    } else {
        None
    };
    let capture = if method == "host.knowledge.save" {
        let id = params["indexSnapshotId"]
            .as_str()
            .ok_or("缺少来源捕获标识")?;
        let snapshot = habitat_core::decode(bytes.as_deref().ok_or("缺少结构内容")?)?;
        Some(super::index_api::validate_knowledge_capture(
            app, plugin, id, &snapshot,
        )?)
    } else {
        None
    };

    // Permission writers wait for this operation; callbacks never re-enter STATE.
    // This also protects historical data without treating search exclusions as ACLs.
    let state = super::STATE
        .read()
        .map_err(|_| "PLUGIN_STATE_UNAVAILABLE")?;
    check_authority(&state, plugin, method)?;
    check_root(app, &root)?;
    let result = match method {
        "host.knowledge.load" => crate::knowledge_structure::load(&root, &runtime),
        "host.knowledge.history" => crate::knowledge_structure::history(
            &root,
            params["limit"].as_u64().unwrap_or(100) as usize,
        ),
        "host.knowledge.read" => {
            crate::knowledge_structure::read_at(&root, params["commit"].as_str().ok_or("缺少版本")?)
        }
        "host.knowledge.recover" => {
            crate::knowledge_structure::store::recover_with_guard(&root, &runtime, &|snapshot| {
                check_root(app, &root)?;
                super::index_api::validate_knowledge_recovery(app, &root, snapshot)
            })
        }
        "host.knowledge.discard" => crate::knowledge_structure::discard_pending(&root, &runtime),
        "host.knowledge.save" => {
            let capture = capture.as_ref().ok_or("缺少来源捕获标识")?;
            crate::knowledge_structure::store::save_with_guard(
                &root,
                &runtime,
                params["expectedBase"].as_str(),
                bytes.as_deref().ok_or("缺少结构内容")?,
                &|snapshot| {
                    check_root(app, &root)?;
                    capture.recheck(app, snapshot)
                },
            )
        }
        _ => unreachable!(),
    }?;
    check_root(app, &root)?;
    // Snapshots remain exact historical records. They do not promise that any
    // source body is still present; source navigation checks its current hash.
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parameters_cannot_add_hidden_filters_or_arbitrary_paths() {
        for method in ["load", "history", "read", "save", "recover", "discard"] {
            let method = format!("host.knowledge.{method}");
            for key in ["hide", "sources", "path", "root", "includeExcluded"] {
                let mut params = json!({"vaultKey":"key"});
                params[key] = json!(true);
                assert!(check_params(&method, &params).is_err());
            }
        }
        assert!(check_params(
            "host.knowledge.history",
            &json!({"vaultKey":"key","limit":201})
        )
        .is_err());
        assert!(check_params(
            "host.knowledge.save",
            &json!({"vaultKey":"key","expectedBase":false})
        )
        .is_err());
        assert!(check_params(
            "host.knowledge.save",
            &json!({"vaultKey":"key","expectedBase":null})
        )
        .is_ok());
    }

    #[test]
    fn direct_dispatch_authorization_uses_live_plugin_state() {
        let mut state = super::super::RuntimeState {
            plugins: Default::default(),
        };
        assert!(check_authority(&state, "notemd.habitat", "host.knowledge.load").is_err());
        let mut manifest: plugin_protocol::ManifestV2 = serde_json::from_str(include_str!(
            "../../../plugins-src/habitat/manifest.v2.json"
        ))
        .unwrap();
        manifest.capabilities = vec!["vault.write".into()];
        state
            .plugins
            .insert("notemd.habitat".into(), (manifest, PathBuf::new()));
        assert!(
            check_authority(&state, "notemd.habitat", "host.knowledge.save")
                .unwrap_err()
                .contains("vault.read")
        );
        state
            .plugins
            .get_mut("notemd.habitat")
            .unwrap()
            .0
            .capabilities
            .push("vault.read".into());
        assert!(check_authority(&state, "notemd.habitat", "host.knowledge.history").is_ok());
        assert!(check_authority(&state, "notemd.habitat", "host.knowledge.recover").is_ok());
        assert!(
            check_authority(&state, "notemd.habitat", "host.knowledge.save")
                .unwrap_err()
                .contains("index.read")
        );
        assert!(check_authority(&state, "other.plugin", "host.knowledge.history").is_err());
        state.plugins.clear();
        assert!(check_authority(&state, "notemd.habitat", "host.knowledge.history").is_err());
    }
}
