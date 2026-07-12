//! Backing store + commands for the single tabbed native "preview" window used
//! by the git-history plugin. The main window computes each view's content
//! (a unified diff, or self-contained themed rich HTML) and calls
//! `open_preview_tab`, which stashes the payload keyed by a tab id and ensures
//! the one `preview` window exists. That window drains pending tabs via
//! `drain_preview_tabs` on mount and whenever it receives a `preview-add-tab`
//! event, upserting them into its tab bar.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The single preview window's label.
const PREVIEW_LABEL: &str = "preview";

/// A tab's content. `kind` is "diff" or "rich"; `content` is the unified diff
/// text (diff) or a self-contained themed HTML document (rich).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewPayload {
    pub title: String,
    pub kind: String,
    pub content: String,
}

/// A tab handed to the window: its id plus payload fields (flattened).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewTab {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub content: String,
}

/// Managed state: tabId -> pending payload (unconsumed = a tab to open).
#[derive(Default)]
pub struct PreviewStore(pub Mutex<HashMap<String, PreviewPayload>>);

/// Insert/overwrite the payload for `id`.
pub fn stash(map: &mut HashMap<String, PreviewPayload>, id: String, payload: PreviewPayload) {
    map.insert(id, payload);
}

/// Remove and return ALL pending tabs, clearing the map.
pub fn drain(map: &mut HashMap<String, PreviewPayload>) -> Vec<PreviewTab> {
    let mut out: Vec<PreviewTab> = map
        .drain()
        .map(|(id, p)| PreviewTab { id, title: p.title, kind: p.kind, content: p.content })
        .collect();
    // Deterministic order (HashMap drain order is arbitrary): sort by id.
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// `Emitter` is required for `window.emit(...)`; `Manager` for `app.state()` /
// `app.get_webview_window()`.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Stash a tab's payload and ensure the single preview window exists (focus it
/// and emit `preview-add-tab` if already open, so it re-drains).
#[tauri::command]
pub fn open_preview_tab(
    app: AppHandle,
    tab_id: String,
    title: String,
    kind: String,
    content: String,
) -> Result<(), String> {
    {
        let store = app.state::<PreviewStore>();
        let mut map = store.0.lock().map_err(|e| e.to_string())?;
        stash(&mut map, tab_id, PreviewPayload { title, kind, content });
    }

    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = w.emit("preview-add-tab", ());
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(&app, PREVIEW_LABEL, WebviewUrl::App("preview.html".into()))
        .title("Preview")
        .inner_size(760.0, 680.0)
        .min_inner_size(420.0, 320.0)
        .resizable(true)
        .decorations(true)
        .visible(false)
        .build()
        .map_err(|e| format!("preview window build: {e}"))?;
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Drain (and clear) all pending tabs. Called by the preview window on mount and
/// on each `preview-add-tab` event.
#[tauri::command]
pub fn drain_preview_tabs(app: AppHandle) -> Result<Vec<PreviewTab>, String> {
    let store = app.state::<PreviewStore>();
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    Ok(drain(&mut map))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(c: &str) -> PreviewPayload {
        PreviewPayload { title: "t".into(), kind: "diff".into(), content: c.into() }
    }

    #[test]
    fn drain_returns_all_and_clears() {
        let mut m = HashMap::new();
        stash(&mut m, "diff-a".into(), payload("da"));
        stash(&mut m, "rich-b".into(), payload("rb"));
        let tabs = drain(&mut m);
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0].id, "diff-a");
        assert_eq!(tabs[1].id, "rich-b");
        assert_eq!(tabs[0].content, "da");
        assert!(drain(&mut m).is_empty());
    }

    #[test]
    fn stash_overwrites_same_id() {
        let mut m = HashMap::new();
        stash(&mut m, "diff-a".into(), payload("v1"));
        stash(&mut m, "diff-a".into(), payload("v2"));
        let tabs = drain(&mut m);
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].content, "v2");
    }

    #[test]
    fn drain_empty_is_empty() {
        let mut m = HashMap::new();
        assert!(drain(&mut m).is_empty());
    }
}
