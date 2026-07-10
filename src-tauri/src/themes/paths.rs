use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

/// Absolute path to the user's themes directory:
/// `~/Library/Application Support/com.laobu.mdeditor/themes/` on macOS.
/// Created on demand by callers.
pub fn themes_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("themes"))
}

/// Subdirectory holding the compiled (scoped) CSS. Users do not edit these
/// directly; note.md overwrites them on every compile.
pub fn compiled_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(themes_dir(app)?.join(".compiled"))
}

/// Path to the source CSS for theme id `id` (no validation here — caller
/// must have already validated `id`).
pub fn source_path<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    Ok(themes_dir(app)?.join(format!("{id}.css")))
}

/// Path to the compiled CSS for theme id `id`.
pub fn compiled_path<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    Ok(compiled_dir(app)?.join(format!("{id}.css")))
}

/// Path to the optional same-named asset folder for theme id `id`.
pub fn asset_dir<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    Ok(themes_dir(app)?.join(id))
}

/// Ensure `themes/` and `themes/.compiled/` exist (creates them if missing).
pub fn ensure_dirs<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    std::fs::create_dir_all(themes_dir(app)?).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(compiled_dir(app)?).map_err(|e| e.to_string())?;
    Ok(())
}
