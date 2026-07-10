//! AGENTS.md first-class support: watch the vault root, mirror AGENTS.md to
//! CLAUDE.md on any change, and prompt when CLAUDE.md diverges on its own.
//! Lifecycle is independent of vault_sync's git loop — active whenever a
//! vault path is configured. See
//! docs/superpowers/specs/2026-07-10-agents-md-sync-design.md.

pub mod baseline;
pub mod logic;
pub mod watcher;

use logic::{PairState, SyncAction};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tauri::Manager;

pub const TEMPLATE: &str = include_str!("../../templates/AGENTS.md");

pub struct AgentsSyncState {
    /// Bumped on every (re)start; stale watcher threads exit when they notice.
    generation: AtomicU64,
    /// True while the conflict dialog is on screen (suppresses re-prompts).
    prompting: AtomicBool,
}

impl AgentsSyncState {
    fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            prompting: AtomicBool::new(false),
        }
    }
}

fn vault_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mgr = app.state::<Arc<crate::vault_sync::VaultSyncManager>>();
    let guard = mgr.repo_path.lock().unwrap();
    guard.as_deref().map(PathBuf::from)
}

fn baseline_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("agents_sync.json"))
}

fn hash_of(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| crate::sotvault::logic::sha256_hex(&b))
}

fn current_state(root: &Path) -> PairState {
    PairState {
        agents_hash: hash_of(&root.join(watcher::AGENTS_FILE)),
        claude_hash: hash_of(&root.join(watcher::CLAUDE_FILE)),
    }
}

/// Call once at app setup, after vault_sync::init.
pub fn init(app: &tauri::AppHandle) {
    app.manage(AgentsSyncState::new());
    if let Some(root) = vault_root(app) {
        start(app, &root);
    }
}

/// Call when the vault folder changes (tray picker).
pub fn restart(app: &tauri::AppHandle, root: &str) {
    start(app, Path::new(root));
}

fn start(app: &tauri::AppHandle, root: &Path) {
    let state = app.state::<AgentsSyncState>();
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel::<()>();
    let root = root.to_path_buf();
    let app = app.clone();
    std::thread::spawn(move || {
        // The watcher lives in this thread; dropping it on exit stops events.
        let _watcher = match watcher::start(&root, tx) {
            Ok(w) => w,
            Err(_) => return,
        };
        // Startup check catches divergence that happened while the app was
        // closed (baseline is persisted).
        run_check(&app, &root);
        loop {
            let stale = || {
                app.state::<AgentsSyncState>().generation.load(Ordering::SeqCst) != my_gen
            };
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(()) => {
                    // Debounce: swallow the burst, then act once.
                    while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
                    if stale() {
                        return;
                    }
                    run_check(&app, &root);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if stale() {
                        return;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

fn run_check(app: &tauri::AppHandle, root: &Path) {
    let state = app.state::<AgentsSyncState>();
    if state.prompting.load(Ordering::SeqCst) {
        return;
    }
    let Some(bp) = baseline_path(app) else { return };
    let current = current_state(root);
    let base = baseline::load(&bp);
    match logic::decide(&current, &base) {
        SyncAction::None => {}
        SyncAction::RefreshBaseline => baseline::save(&bp, &current),
        SyncAction::MirrorToClaude => {
            let ok = std::fs::copy(
                root.join(watcher::AGENTS_FILE),
                root.join(watcher::CLAUDE_FILE),
            )
            .is_ok();
            if ok {
                // Re-hash after the write so baseline == on-disk state; the
                // watcher event for our own write then decides to None.
                baseline::save(&bp, &current_state(root));
            }
        }
        SyncAction::PromptConflict => prompt_conflict(app, root),
    }
}

fn prompt_conflict(app: &tauri::AppHandle, root: &Path) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let state = app.state::<AgentsSyncState>();
    if state.prompting.swap(true, Ordering::SeqCst) {
        return;
    }
    let locale = crate::read_saved_locale(app);
    let (msg, merge_label, overwrite_label) = match locale.as_str() {
        "zh" => (
            "CLAUDE.md 已被修改，与 AGENTS.md 不一致。",
            "合回 AGENTS.md",
            "用 AGENTS.md 覆盖",
        ),
        "ja" => (
            "CLAUDE.md が変更され、AGENTS.md と一致しません。",
            "AGENTS.md に取り込む",
            "AGENTS.md で上書き",
        ),
        _ => (
            "CLAUDE.md has been modified and no longer matches AGENTS.md.",
            "Merge into AGENTS.md",
            "Overwrite with AGENTS.md",
        ),
    };
    let app = app.clone();
    let root = root.to_path_buf();
    app.clone()
        .dialog()
        .message(msg)
        .title("AGENTS.md")
        .buttons(MessageDialogButtons::OkCancelCustom(
            merge_label.into(),
            overwrite_label.into(),
        ))
        .show(move |merge_back| {
            // Whole-file copy either way; no text merge (spec).
            let (from, to) = if merge_back {
                (root.join(watcher::CLAUDE_FILE), root.join(watcher::AGENTS_FILE))
            } else {
                (root.join(watcher::AGENTS_FILE), root.join(watcher::CLAUDE_FILE))
            };
            let _ = std::fs::copy(&from, &to);
            if let Some(bp) = baseline_path(&app) {
                baseline::save(&bp, &current_state(&root));
            }
            let state = app.state::<AgentsSyncState>();
            state.prompting.store(false, Ordering::SeqCst);
        });
}

/// Tray entry point: ensure AGENTS.md exists (template on first use), sync,
/// and open it in the main window.
pub fn edit_agents_md(app: &tauri::AppHandle) {
    if let Some(root) = vault_root(app) {
        open_agents_in_editor(app, &root);
    } else {
        // No vault yet: reuse the folder picker, then open. The picker's
        // shared path (pick_sync_folder_inner) also calls restart() for us.
        let app = app.clone();
        crate::pick_sync_folder_inner(&app.clone(), move |path| {
            open_agents_in_editor(&app, Path::new(&path));
        });
    }
}

fn open_agents_in_editor(app: &tauri::AppHandle, root: &Path) {
    let agents = root.join(watcher::AGENTS_FILE);
    if !agents.exists() {
        let _ = std::fs::write(&agents, TEMPLATE);
    }
    // Mirrors CLAUDE.md (or prompts if a foreign CLAUDE.md already diverges —
    // safer than clobbering it with the fresh template).
    run_check(app, root);
    crate::show_main_window(app);
    if let Some(p) = agents.to_str() {
        crate::emit_open_file_delayed(app, p);
    }
}
