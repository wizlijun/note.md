use crate::themes::compiler::compile_theme_css;
use crate::themes::import::{prepare_import, install_prepared, cleanup_staging, ImportReport};
use crate::themes::paths::{compiled_path, compiled_dir, ensure_dirs, source_path, themes_dir, asset_dir};
use crate::themes::registry::{scan_themes_dir, ThemeMeta};
use tauri::{Emitter, Manager};

/// Ids of the themes we ship with the app. Used for the `built_in` flag and
/// the "Restore built-in themes" affordance.
pub const BUILT_IN_THEME_IDS: &[&str] = &["default", "effie"];

#[tauri::command]
pub fn theme_list(app: tauri::AppHandle) -> Result<Vec<ThemeMeta>, String> {
    ensure_dirs(&app)?;
    let dir = themes_dir(&app)?;
    scan_themes_dir(&dir, BUILT_IN_THEME_IDS)
}

#[tauri::command]
pub fn theme_reveal(app: tauri::AppHandle) -> Result<(), String> {
    ensure_dirs(&app)?;
    let dir = themes_dir(&app)?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = dir; Err("not supported on this platform".into()) }
}

/// Read the compiled CSS for theme `id` from disk and return it. Used by the
/// frontend theme-loader to populate <style> slots without needing
/// tauri-plugin-fs scope permission for the app-data directory.
#[tauri::command]
pub fn theme_load_compiled(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let path = compiled_path(&app, &id)?;
    std::fs::read_to_string(&path).map_err(|e| format!("read {path:?}: {e}"))
}

#[tauri::command]
pub fn theme_recompile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    ensure_dirs(&app)?;
    let source = source_path(&app, &id)?;
    let compiled = compiled_path(&app, &id)?;
    let assets = asset_dir(&app, &id)?;
    let src = std::fs::read_to_string(&source).map_err(|e| e.to_string())?;
    let out = compile_theme_css(&src, &id, assets.to_str().unwrap_or(""))?;
    std::fs::write(&compiled, out).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn theme_recompile_all(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    ensure_dirs(&app)?;
    let list = theme_list(app.clone())?;
    let mut errs: Vec<String> = Vec::new();
    for meta in list {
        if let Err(e) = theme_recompile(app.clone(), meta.id.clone()) {
            errs.push(format!("{}: {e}", meta.id));
        }
    }
    Ok(errs)
}

#[tauri::command]
pub fn theme_restore_builtins(app: tauri::AppHandle) -> Result<usize, String> {
    use crate::themes::migration::force_copy_built_ins;
    ensure_dirs(&app)?;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources").join("themes");
    let themes = themes_dir(&app)?;
    let n = force_copy_built_ins(&res_dir, &themes, BUILT_IN_THEME_IDS)?;
    // Recompile so the .compiled/ cache reflects the restored sources.
    let _ = theme_recompile_all(app.clone());
    Ok(n)
}

#[tauri::command]
pub fn theme_import(app: tauri::AppHandle, zip_path: String) -> Result<ImportReport, String> {
    let existing: Vec<String> = theme_list(app)?.into_iter().map(|m| m.id).collect();
    prepare_import(std::path::Path::new(&zip_path), &existing)
}

#[tauri::command]
pub fn theme_install(app: tauri::AppHandle, report: ImportReport, overwrite: bool) -> Result<usize, String> {
    let dir = themes_dir(&app)?;
    let n = install_prepared(&report, &dir, overwrite)?;
    let _ = app.emit("themes-updated", ());
    Ok(n)
}

#[tauri::command]
pub fn theme_cancel_import(_app: tauri::AppHandle, staging_dir: String) {
    cleanup_staging(std::path::Path::new(&staging_dir));
}
