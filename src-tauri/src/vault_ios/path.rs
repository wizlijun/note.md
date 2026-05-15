use std::path::{Path, PathBuf};

/// Append "Vault" subdir to the given base. Pure function for testability.
pub fn resolve_vault_path(base: &Path) -> PathBuf {
    base.join("Vault")
}

/// Production helper: read iOS document directory from the app handle.
#[cfg(any(target_os = "ios", target_os = "macos"))]
pub fn vault_path(app: &tauri::AppHandle) -> Result<PathBuf, super::VaultError> {
    use tauri::Manager;
    let doc = app.path().document_dir()
        .map_err(|e| super::VaultError::FsError(format!("document_dir: {e}")))?;
    Ok(resolve_vault_path(&doc))
}
