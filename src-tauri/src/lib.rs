#[cfg(debug_assertions)]
use std::fs::OpenOptions;
#[cfg(debug_assertions)]
use std::io::Write;
use std::sync::Mutex;
#[cfg(not(target_os = "ios"))]
use tauri::image::Image;
#[cfg(not(target_os = "ios"))]
use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuItem, MenuItemBuilder, MenuItemKind, PredefinedMenuItem,
    Submenu, SubmenuBuilder,
};
#[cfg(not(target_os = "ios"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

pub mod openclaw;

#[cfg(not(target_os = "ios"))]
pub mod cli;
#[cfg(not(target_os = "ios"))]
pub mod plugin_host;
#[cfg(target_os = "ios")]
#[path = "plugin_host_ios.rs"]
pub mod plugin_host;
#[cfg(not(target_os = "ios"))]
pub mod themes;
#[cfg(not(target_os = "ios"))]
pub mod vault_sync;

#[cfg(any(target_os = "ios", test))]
pub mod vault_ios;

pub struct PendingFiles(Mutex<Vec<String>>);
#[cfg(not(target_os = "ios"))]
pub struct TrayRepoItem(Mutex<Option<MenuItem<tauri::Wry>>>);

#[tauri::command]
fn drain_pending_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    state.0.lock().unwrap().drain(..).collect()
}

/// Append a diagnostic line to /tmp/mdeditor.log in debug builds (best-effort).
/// Compiled out in release — kept as a no-op so call sites need no `cfg` gates.
#[allow(unused_variables)]
fn dlog(msg: &str) {
    #[cfg(debug_assertions)]
    {
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/mdeditor.log")
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = writeln!(f, "{} {}", ts, msg);
        }
    }
}

// ── File helpers ─────────────────────────────────────────────────────────────

fn sanitize_io_err(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound         => "File not found".to_string(),
        std::io::ErrorKind::PermissionDenied => "Permission denied".to_string(),
        std::io::ErrorKind::AlreadyExists    => "File already exists".to_string(),
        _                                    => "Operation failed".to_string(),
    }
}

/// Validate that the path resolves under the user home, /tmp, /var, or /private.
/// Walks up ancestor dirs to handle not-yet-existing files.
fn safe_path(path: &str) -> Result<std::path::PathBuf, String> {
    use std::path::Path;
    if path.is_empty() {
        return Err("Path must not be empty".to_string());
    }
    if !path.starts_with('/') {
        return Err("Path must be absolute".to_string());
    }
    let p = Path::new(path);
    let canonical = std::fs::canonicalize(p).or_else(|_| {
        let mut parts: Vec<std::ffi::OsString> = Vec::new();
        if let Some(fname) = p.file_name() { parts.push(fname.to_owned()); }
        let mut ancestor = p.parent();
        loop {
            match ancestor {
                Some(dir) if dir.as_os_str().is_empty() => break,
                Some(dir) if dir.exists() => {
                    let mut base = std::fs::canonicalize(dir)
                        .map_err(|e| e.to_string())?;
                    for part in parts.iter().rev() { base.push(part); }
                    // Guard against ".." components in the reconstructed path
                    if base.components().any(|c| c == std::path::Component::ParentDir) {
                        return Err("Path traversal detected".to_string());
                    }
                    return Ok(base);
                }
                Some(dir) => {
                    if let Some(n) = dir.file_name() { parts.push(n.to_owned()); }
                    ancestor = dir.parent();
                }
                None => break,
            }
        }
        Err("Cannot resolve path".to_string())
    })?;

    let home = dirs::home_dir().ok_or("Cannot determine home dir")?;
    if canonical.starts_with(&home) { return Ok(canonical); }
    for prefix in &["/tmp", "/var", "/private"] {
        if canonical.starts_with(prefix) { return Ok(canonical); }
    }
    Err("Path outside allowed directories".to_string())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input = input.as_bytes();
    let mut buf: Vec<u8> = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in input {
        if matches!(b, b'\n' | b'\r' | b' ') { continue; }
        if b == b'=' { break; }
        let val = TABLE.iter().position(|&c| c == b)
            .ok_or_else(|| "Invalid base64".to_string())? as u32;
        acc = (acc << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(buf)
}

/// Write base64-encoded binary data to a file. Creates parent directories.
/// Strips optional `data:...;base64,` prefix automatically.
#[tauri::command]
fn write_file_binary(path: String, base64_data: String) -> Result<(), String> {
    use std::io::Write;
    let dest = safe_path(&path)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(sanitize_io_err)?;
    }
    let raw = if let Some(i) = base64_data.find(";base64,") {
        &base64_data[i + 8..]
    } else {
        base64_data.as_str()
    };
    let bytes = base64_decode(raw)?;
    let mut f = std::fs::File::create(&dest).map_err(sanitize_io_err)?;
    f.write_all(&bytes).map_err(sanitize_io_err)
}

/// Move a file from old_path to new_path. Creates parent directories of new_path.
/// Silently succeeds if old_path does not exist (already migrated).
#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let src = safe_path(&old_path)?;
    if !src.exists() { return Ok(()); }
    let dst = safe_path(&new_path)?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(sanitize_io_err)?;
    }
    std::fs::rename(&src, &dst).map_err(sanitize_io_err)
}

/// Quit the application. Called from the frontend after the close-window
/// dirty-tab confirmation loop completes successfully. macOS does NOT quit
/// the app on its own when the last NSWindow is closed (unlike Windows / Linux),
/// so we trigger it explicitly.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Set the enabled state of a plugin-contributed menu item by id.
/// IDs follow the `plugin:<plugin-id>:<command>` convention.
/// Walks the entire menu tree (top-level + submenus) so it finds items
/// regardless of which submenu they were appended to.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn set_plugin_menu_item_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    fn walk<R: tauri::Runtime>(items: Vec<MenuItemKind<R>>, id: &str, enabled: bool) -> bool {
        for item in items {
            match item {
                MenuItemKind::MenuItem(mi) => {
                    if mi.id().0.as_str() == id {
                        let _ = mi.set_enabled(enabled);
                        return true;
                    }
                }
                MenuItemKind::Submenu(sm) => {
                    if let Ok(child) = sm.items() {
                        if walk(child, id, enabled) {
                            return true;
                        }
                    }
                }
                _ => {}
            }
        }
        false
    }
    let menu = app.menu().ok_or_else(|| "no menu set".to_string())?;
    let items = menu.items().map_err(|e| e.to_string())?;
    if walk(items, &id, enabled) {
        Ok(())
    } else {
        Err(format!("menu item not found: {id}"))
    }
}

#[derive(serde::Serialize)]
struct ExtResult {
    ext: String,
    uti: Option<String>,
    ok: bool,
    error: Option<String>,
}

#[cfg(target_os = "macos")]
mod macos_defaults {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    // LaunchServices APIs: deprecated in macOS 12+ in favor of NSWorkspace's
    // async setDefaultApplicationAtURL:toOpenContentType:, but still functional
    // and synchronous (which is much easier to call from Rust FFI).
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
            in_handler_bundle_id: CFStringRef,
        ) -> i32;

        fn UTTypeCreatePreferredIdentifierForTag(
            in_tag_class: CFStringRef,
            in_tag: CFStringRef,
            in_conforming_to_uti: CFStringRef,
        ) -> CFStringRef;
    }

    const K_LS_ROLES_ALL: u32 = 0xFFFFFFFF;

    /// Resolve the canonical UTI for a filename extension (e.g. "py" → "public.python-script").
    /// Returns None when the system can't determine a UTI.
    pub fn resolve_uti(ext: &str) -> Option<String> {
        let tag_class = CFString::new("public.filename-extension");
        let ext_cf = CFString::new(ext);
        let uti_ref = unsafe {
            UTTypeCreatePreferredIdentifierForTag(
                tag_class.as_concrete_TypeRef(),
                ext_cf.as_concrete_TypeRef(),
                std::ptr::null(),
            )
        };
        if uti_ref.is_null() {
            return None;
        }
        let uti = unsafe { CFString::wrap_under_create_rule(uti_ref) };
        Some(uti.to_string())
    }

    /// Set `bundle_id` as the default handler for the given UTI across all roles.
    /// Returns `Ok(())` on success or `Err(OSStatus)` on failure.
    pub fn set_handler(uti: &str, bundle_id: &str) -> Result<(), i32> {
        let uti_cf = CFString::new(uti);
        let bundle_cf = CFString::new(bundle_id);
        let status = unsafe {
            LSSetDefaultRoleHandlerForContentType(
                uti_cf.as_concrete_TypeRef(),
                K_LS_ROLES_ALL,
                bundle_cf.as_concrete_TypeRef(),
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(status)
        }
    }
}

/// Set this app as the macOS default handler for each given file extension.
/// For each extension we resolve the UTI and call LaunchServices to register
/// the bundle as the default handler across all roles. Returns a per-extension
/// result so the frontend can report partial success.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn set_default_app_for_extensions(app: tauri::AppHandle, exts: Vec<String>) -> Vec<ExtResult> {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = app.config().identifier.clone();
        exts.into_iter()
            .map(|ext| match macos_defaults::resolve_uti(&ext) {
                None => ExtResult {
                    ext,
                    uti: None,
                    ok: false,
                    error: Some("no UTI registered for this extension".into()),
                },
                Some(uti) => match macos_defaults::set_handler(&uti, &bundle_id) {
                    Ok(()) => ExtResult { ext, uti: Some(uti), ok: true, error: None },
                    Err(status) => ExtResult {
                        ext,
                        uti: Some(uti),
                        ok: false,
                        error: Some(format!("LaunchServices OSStatus {}", status)),
                    },
                },
            })
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        exts.into_iter()
            .map(|ext| ExtResult {
                ext,
                uti: None,
                ok: false,
                error: Some("only supported on macOS".into()),
            })
            .collect()
    }
}

#[cfg(not(target_os = "ios"))]
fn show_chat_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("chat") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else {
        // Window might have been destroyed, recreate it
        let _ = tauri::WebviewWindowBuilder::new(
            app,
            "main",
            tauri::WebviewUrl::default(),
        )
        .title("M\u{2193}")
        .inner_size(1000.0, 700.0)
        .min_inner_size(600.0, 400.0)
        .build();
    }
}

#[cfg(not(target_os = "ios"))]
fn open_sync_log_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let mgr = app.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
    let entries = mgr.logs.entries();

    let log_path = std::env::temp_dir().join("vault-sync.log");
    let content: String = entries.iter().map(|e| {
        format!("[{}] [{}] {}\n", e.timestamp, e.level, e.message)
    }).collect();
    let _ = std::fs::write(&log_path, &content);

    show_main_window(app);
    if let Some(path_str) = log_path.to_str() {
        emit_open_file_delayed(app, path_str);
    }
}

#[cfg(not(target_os = "ios"))]
fn pick_repo_and_start(app: &tauri::AppHandle) {
    let mgr = app.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
    let has_repo = mgr.repo_path.lock().unwrap().is_some();

    if has_repo {
        let _ = vault_sync::vault_sync_start(app.clone());
        save_sync_enabled(app, true);
        update_tray_icon(app, true);
        return;
    }

    let app_clone = app.clone();
    pick_sync_folder_inner(app, move |_path_str| {
        let _ = vault_sync::vault_sync_start(app_clone.clone());
        save_sync_enabled(&app_clone, true);
        update_tray_icon(&app_clone, true);
    });
}

#[cfg(not(target_os = "ios"))]
fn pick_sync_folder(app: &tauri::AppHandle) {
    pick_sync_folder_inner(app, move |_| {});
}

#[cfg(not(target_os = "ios"))]
fn pick_sync_folder_inner(app: &tauri::AppHandle, on_done: impl FnOnce(String) + Send + 'static) {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_store::StoreExt;

    let app_clone = app.clone();
    app.dialog()
        .file()
        .set_title("Select Vault Git Repository")
        .pick_folder(move |folder| {
            if let Some(path) = folder {
                let path_str = path.to_string();
                let mgr = app_clone.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
                *mgr.repo_path.lock().unwrap() = Some(path_str.clone());

                if let Ok(s) = app_clone.store("settings.json") {
                    let _ = s.set("vault_sync.repo_path", serde_json::json!(&path_str));
                    let _ = s.set("vault_sync.auto_start", serde_json::json!(true));
                    let _ = s.save();
                }

                update_tray_repo_label(&app_clone, &path_str);
                on_done(path_str);
            }
        });
}

#[cfg(not(target_os = "ios"))]
fn update_tray_repo_label(app: &tauri::AppHandle, path: &str) {
    if let Some(state) = app.try_state::<TrayRepoItem>() {
        if let Some(item) = state.0.lock().unwrap().as_ref() {
            let _ = item.set_text(&format!("Vault: {}", abbreviate_path(path)));
        }
    }
}

#[cfg(not(target_os = "ios"))]
fn abbreviate_path(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && path.starts_with(&home) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_string()
    }
}

#[cfg(not(target_os = "ios"))]
fn save_sync_enabled(app: &tauri::AppHandle, enabled: bool) {
    use tauri_plugin_store::StoreExt;
    if let Ok(s) = app.store("settings.json") {
        let _ = s.set("vault_sync.auto_start", serde_json::json!(enabled));
        let _ = s.save();
    }
}

#[cfg(not(target_os = "ios"))]
pub fn update_tray_icon(app: &tauri::AppHandle, active: bool) {
    if let Some(tray) = app.tray_by_id("main") {
        let icon = if active {
            Image::from_bytes(include_bytes!("../icons/tray-icon-active.png"))
        } else {
            Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        };
        if let Ok(img) = icon {
            let _ = tray.set_icon(Some(img));
        }
    }
}

/// Build the Tauri runtime `Context` from the embedded tauri.conf.json.
///
/// `tauri::generate_context!()` is a proc-macro that emits a `_EMBED_INFO_PLIST`
/// static at its call-site. Calling it from two places in the same crate gives
/// a duplicate-symbol link error. Funneling every consumer through this single
/// helper guarantees one expansion. Both the GUI `run()` and the headless CLI
/// runner use it.
pub fn tauri_context() -> tauri::Context {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dlog("=== M↓ start ===");
    dlog(&format!("argv: {:?}", std::env::args().collect::<Vec<_>>()));

    // rustls 0.23 no longer auto-selects a crypto provider; install ring as
    // the default so reqwest::Client::new() doesn't panic with "No provider
    // set" on first HTTPS use (tauri-plugin-http, tauri-plugin-updater, etc).
    // Safe to ignore Err: it only fires if already installed (e.g. in tests).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default()
        .manage(PendingFiles(Mutex::new(Vec::new())));
    #[cfg(not(target_os = "ios"))]
    let builder = builder.manage(TrayRepoItem(Mutex::new(None)));
    #[cfg(not(target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        dlog(&format!("single_instance argv: {:?}", argv));
        for arg in argv.iter().skip(1) {
            emit_open_file_delayed(app, arg);
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init());
    #[cfg(not(target_os = "ios"))]
    let app = app
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    let app = app
        .invoke_handler({
            #[cfg(not(target_os = "ios"))]
            { tauri::generate_handler![
                quit_app,
                drain_pending_files,
                set_default_app_for_extensions,
                set_plugin_menu_item_enabled,
                plugin_host::get_plugin_manifests,
                plugin_host::get_all_plugin_manifests,
                plugin_host::invoke_plugin,
                cli::state::cli_payload,
                cli::state::cli_finish,
                cli::install::cli_install_status,
                cli::install::cli_install,
                cli::install::cli_uninstall,
                cli::install::cli_install_candidates,
                themes::commands::theme_list,
                themes::commands::theme_reveal,
                themes::commands::theme_load_compiled,
                themes::commands::theme_recompile,
                themes::commands::theme_recompile_all,
                themes::commands::theme_restore_builtins,
                themes::commands::theme_import,
                themes::commands::theme_install,
                themes::commands::theme_cancel_import,
                vault_sync::vault_sync_start,
                vault_sync::vault_sync_stop,
                vault_sync::vault_sync_now,
                vault_sync::vault_sync_status,
                vault_sync::vault_sync_logs,
                write_file_binary,
                rename_file,
                crate::openclaw::commands::openclaw_connect,
                crate::openclaw::commands::openclaw_send,
                crate::openclaw::commands::openclaw_disconnect,
            ] }
            #[cfg(target_os = "ios")]
            { tauri::generate_handler![
                drain_pending_files,
                plugin_host::get_plugin_manifests,
                plugin_host::get_all_plugin_manifests,
                plugin_host::invoke_plugin,
                vault_ios::vault_status,
                vault_ios::list_dir::vault_list_dir,
                vault_ios::vault_configure,
                vault_ios::vault_sync_now,
                vault_ios::vault_disconnect,
                write_file_binary,
                rename_file,
                crate::openclaw::commands::openclaw_connect,
                crate::openclaw::commands::openclaw_send,
                crate::openclaw::commands::openclaw_disconnect,
            ] }
        })
        .setup(|app| {
            #[cfg(not(target_os = "ios"))]
            {
                let vault_mgr = std::sync::Arc::new(vault_sync::VaultSyncManager::new());
                app.manage(vault_mgr);
                vault_sync::init(&app.handle());
            }

            let openclaw_state = crate::openclaw::init_state(&app.handle());
            app.manage(openclaw_state);

            plugin_host::init(&app.handle());

            #[cfg(target_os = "ios")]
            vault_ios::init(&app.handle());

            #[cfg(not(target_os = "ios"))]
            {
                // Bootstrap themes: ensure dirs exist, copy any missing built-ins,
                // and (re)compile every theme into .compiled/ so the frontend can
                // load fresh CSS without waiting on a separate compile pass.
                if let Err(e) = bootstrap_themes(&app.handle()) {
                    eprintln!("[themes] bootstrap failed: {e}");
                }

                let plugin_items = plugin_host::collect_top_menu_items();
                let menu = build_menu(&app.handle(), &plugin_items)?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().0.as_str() == "hide-app" {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        return;
                    }
                    let _ = app.emit("menu-event", event.id().0.as_str());
                });

                // Persistent menu-bar tray icon. White circle with M↓ cutout —
                // template-style mark fits both light and dark menu bars.
                // Left-click toggles main window visibility; right-click shows menu.
                let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
                let show_item = MenuItem::with_id(app, "tray-show", "Show M\u{2193}", true, None::<&str>)?;
                let openclaw_item = MenuItem::with_id(app, "tray-openclaw", "OpenClaw", true, None::<&str>)?;
                let sync_repo_label = {
                    let mgr = app.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
                    let guard = mgr.repo_path.lock().unwrap();
                    match guard.as_deref() {
                        Some(p) => format!("Vault: {}", abbreviate_path(p)),
                        None => "Vault: Set Folder\u{2026}".to_string(),
                    }
                };
                let sync_repo_item = MenuItem::with_id(app, "tray-sync-repo", &sync_repo_label, true, None::<&str>)?;
                {
                    let tray_item_state = app.state::<TrayRepoItem>();
                    *tray_item_state.0.lock().unwrap() = Some(sync_repo_item.clone());
                }
                let sync_start_item = MenuItem::with_id(app, "tray-sync-start", "Start Sync", true, None::<&str>)?;
                let sync_stop_item = MenuItem::with_id(app, "tray-sync-stop", "Stop Sync", true, None::<&str>)?;
                let sync_now_item = MenuItem::with_id(app, "tray-sync-now", "Sync Now", true, None::<&str>)?;
                let sync_log_item = MenuItem::with_id(app, "tray-sync-log", "View Log\u{2026}", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "tray-quit", "Quit M\u{2193}", true, None::<&str>)?;
                let tray_menu = MenuBuilder::new(app)
                    .item(&show_item)
                    .separator()
                    .item(&openclaw_item)
                    .separator()
                    .item(&sync_repo_item)
                    .item(&sync_start_item)
                    .item(&sync_stop_item)
                    .item(&sync_now_item)
                    .item(&sync_log_item)
                    .separator()
                    .item(&quit_item)
                    .build()?;
                let _tray = TrayIconBuilder::with_id("main")
                    .icon(tray_icon)
                    .icon_as_template(false)
                    .tooltip("M↓")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| {
                        match event.id().0.as_str() {
                            "tray-show" => show_main_window(app),
                            "tray-openclaw" => show_chat_window(app),
                            "tray-sync-repo" => { pick_sync_folder(app); }
                            "tray-sync-start" => { pick_repo_and_start(app); }
                            "tray-sync-stop" => {
                                let _ = vault_sync::vault_sync_stop(app.clone());
                                save_sync_enabled(app, false);
                                update_tray_icon(app, false);
                            }
                            "tray-sync-now" => { let _ = vault_sync::vault_sync_now(app.clone()); }
                            "tray-sync-log" => { open_sync_log_window(app); }
                            "tray-quit" => app.exit(0),
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            // Initial CLI argv (Linux / Windows / macOS-when-launched-from-shell).
            // macOS Finder double-click does NOT arrive via argv — uses Apple Events
            // captured via `RunEvent::Opened` (handled in app.run() below) AND via
            // `tauri-plugin-deep-link`'s `on_open_url` (frontend-side belt-and-braces).
            let handle = app.handle();
            for arg in std::env::args().skip(1) {
                emit_open_file_delayed(handle, &arg);
            }

            Ok(())
        })
        .build(tauri_context())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            RunEvent::Ready => {
                dlog("RunEvent::Ready");
            }
            RunEvent::Opened { urls } => {
                dlog(&format!("RunEvent::Opened {} urls: {:?}",
                    urls.len(),
                    urls.iter().map(|u| u.to_string()).collect::<Vec<_>>()));
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if let Some(p) = path.to_str() {
                            dlog(&format!("  emit open-file: {}", p));
                            emit_open_file_delayed(app_handle, p);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "ios"))]
            RunEvent::Reopen { has_visible_windows, .. } => {
                dlog(&format!("RunEvent::Reopen has_visible_windows={}", has_visible_windows));
                if !has_visible_windows {
                    show_main_window(app_handle);
                }
            }
            RunEvent::WindowEvent { ref label, event: ref e, .. } => {
                match e {
                    WindowEvent::CloseRequested { api, .. } => {
                        dlog(&format!("WindowEvent CloseRequested on {}", label));
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window(label) {
                            let _ = w.hide();
                        }
                    }
                    WindowEvent::Destroyed => {
                        dlog(&format!("WindowEvent Destroyed on {}", label));
                    }
                    _ => {}
                }
            }
            RunEvent::ExitRequested { api, .. } => {
                api.prevent_exit();
            }
            RunEvent::Exit => dlog("RunEvent::Exit"),
            _ => {}
        }
    });
}

#[cfg(not(target_os = "ios"))]
fn bootstrap_themes(app: &tauri::AppHandle) -> Result<(), String> {
    use themes::paths::{themes_dir, ensure_dirs};
    use themes::commands::BUILT_IN_THEME_IDS;

    ensure_dirs(app)?;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources").join("themes");
    let themes = themes_dir(app)?;
    themes::migration::copy_built_ins_if_missing(&res_dir, &themes, BUILT_IN_THEME_IDS)?;
    let _ = themes::commands::theme_recompile_all(app.clone());
    Ok(())
}

fn emit_open_file_delayed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &str) {
    if let Some(state) = app.try_state::<PendingFiles>() {
        state.0.lock().unwrap().push(path.to_string());
    }
    let app = app.clone();
    let path = path.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        dlog(&format!("emit open-file → {}", path));
        #[cfg(not(target_os = "ios"))]
        show_main_window(&app);
        let _ = app.emit("open-file", path);
    });
}

#[cfg(not(target_os = "ios"))]
fn build_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_items: &[plugin_host::LocatedMenuItem],
) -> tauri::Result<Menu<R>> {
    let app_meta = AboutMetadata {
        name: Some("M↓".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        ..Default::default()
    };

    let app_menu: Submenu<R> = SubmenuBuilder::new(app, "M↓")
        .item(&PredefinedMenuItem::about(app, Some("About M↓"), Some(app_meta))?)
        .item(
            &MenuItemBuilder::with_id("check-for-updates", "Check for Updates…")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("preferences", "Preferences…")
                .accelerator("Cmd+,")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("hide-app", "Hide mdeditor").accelerator("Cmd+Shift+H").build(app)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let mut file_b = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("new", "New").accelerator("Cmd+N").build(app)?)
        .item(&MenuItemBuilder::with_id("open", "Open…").accelerator("Cmd+O").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("close-tab", "Close Tab")
                .accelerator("Cmd+W")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("save", "Save").accelerator("Cmd+S").build(app)?)
        .item(
            &MenuItemBuilder::with_id("save-as", "Save As…")
                .accelerator("Cmd+Shift+S")
                .build(app)?,
        );
    for it in plugin_items.iter().filter(|p| p.location == "file") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        file_b = file_b.item(&b.build(app)?);
    }
    let file_menu: Submenu<R> = file_b.build()?;

    let mut edit_b = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("find", "Find…").accelerator("Cmd+F").build(app)?)
        .item(&MenuItemBuilder::with_id("find-replace", "Find and Replace…").build(app)?);
    for it in plugin_items.iter().filter(|p| p.location == "edit") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        edit_b = edit_b.item(&b.build(app)?);
    }
    let edit_menu: Submenu<R> = edit_b.build()?;

    let mut view_b = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle-mode", "Toggle Source / Rich")
                .accelerator("Cmd+/")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::fullscreen(app, None)?);
    for it in plugin_items.iter().filter(|p| p.location == "view") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        view_b = view_b.item(&b.build(app)?);
    }
    let view_menu: Submenu<R> = view_b.build()?;

    let mut window_b = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("zoom-in", "Zoom In").accelerator("Cmd+=").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom-out", "Zoom Out").accelerator("Cmd+-").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom-reset", "Actual Size").accelerator("Cmd+0").build(app)?);
    for it in plugin_items.iter().filter(|p| p.location == "window") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        window_b = window_b.item(&b.build(app)?);
    }
    let window_menu: Submenu<R> = window_b.build()?;

    let mut help_b = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("docs", "Documentation").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("cli-install", "Install 'mdedit' Command in PATH…").build(app)?)
        .item(&MenuItemBuilder::with_id("cli-uninstall", "Uninstall 'mdedit' Command").build(app)?);
    for it in plugin_items.iter().filter(|p| p.location == "help") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        help_b = help_b.item(&b.build(app)?);
    }
    let help_menu: Submenu<R> = help_b.build()?;

    let plugins_in_plugins: Vec<_> = plugin_items.iter().filter(|p| p.location == "plugins").collect();
    let plugins_menu: Option<Submenu<R>> = if !plugins_in_plugins.is_empty() {
        let mut b = SubmenuBuilder::new(app, "Plugins");
        for it in plugins_in_plugins {
            let mut mb = MenuItemBuilder::with_id(&it.id, &it.label);
            if let Some(s) = &it.shortcut { mb = mb.accelerator(s); }
            b = b.item(&mb.build(app)?);
        }
        Some(b.build()?)
    } else {
        None
    };

    // Suppress unused warning when WindowEvent isn't matched in run loop above
    let _ = std::any::type_name::<WindowEvent>();

    let mut top = MenuBuilder::new(app);
    top = top.items(&[&app_menu, &file_menu, &edit_menu, &view_menu]);
    if let Some(pm) = &plugins_menu { top = top.item(pm); }
    top.items(&[&window_menu, &help_menu]).build()
}
