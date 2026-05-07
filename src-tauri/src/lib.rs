#[cfg(debug_assertions)]
use std::fs::OpenOptions;
#[cfg(debug_assertions)]
use std::io::Write;
use tauri::image::Image;
use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

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

/// Quit the application. Called from the frontend after the close-window
/// dirty-tab confirmation loop completes successfully. macOS does NOT quit
/// the app on its own when the last NSWindow is closed (unlike Windows / Linux),
/// so we trigger it explicitly.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    dlog("=== M↓ start ===");
    dlog(&format!("argv: {:?}", std::env::args().collect::<Vec<_>>()));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            dlog(&format!("single_instance argv: {:?}", argv));
            for arg in argv.iter().skip(1) {
                emit_open_file_delayed(app, arg);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![quit_app])
        .setup(|app| {
            let menu = build_menu(&app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu-event", event.id().0.as_str());
            });

            // Persistent menu-bar tray icon. White circle with M↓ cutout —
            // template-style mark fits both light and dark menu bars.
            // Left-click toggles main window visibility; right-click shows menu.
            let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
            let show_item = MenuItem::with_id(app, "tray-show", "Show M↓", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "Quit M↓", true, None::<&str>)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(false)
                .tooltip("M↓")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id().0.as_str() {
                        "tray-show" => show_main_window(app),
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
        .build(tauri::generate_context!())
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
            RunEvent::Reopen { has_visible_windows, .. } => {
                dlog(&format!("RunEvent::Reopen has_visible_windows={}", has_visible_windows));
            }
            RunEvent::WindowEvent { ref label, event: ref e, .. } => {
                if matches!(e, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
                    dlog(&format!("WindowEvent {:?} on {}", e, label));
                }
            }
            RunEvent::Exit => dlog("RunEvent::Exit"),
            _ => {}
        }
    });
}

fn emit_open_file_delayed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &str) {
    let app = app.clone();
    let path = path.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        dlog(&format!("emit open-file → {}", path));
        let _ = app.emit("open-file", path);
    });
}

fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_meta = AboutMetadata {
        name: Some("M↓".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        ..Default::default()
    };

    let app_menu: Submenu<R> = SubmenuBuilder::new(app, "M↓")
        .item(&PredefinedMenuItem::about(app, Some("About M↓"), Some(app_meta))?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("preferences", "Preferences…")
                .accelerator("Cmd+,")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_menu: Submenu<R> = SubmenuBuilder::new(app, "File")
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
        )
        .build()?;

    let edit_menu: Submenu<R> = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let view_menu: Submenu<R> = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle-mode", "Toggle Source / Rich")
                .accelerator("Cmd+/")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let window_menu: Submenu<R> = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;

    let help_menu: Submenu<R> = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("docs", "Documentation").build(app)?)
        .build()?;

    // Suppress unused warning when WindowEvent isn't matched in run loop above
    let _ = std::any::type_name::<WindowEvent>();

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()
}
