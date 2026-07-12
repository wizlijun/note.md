//! Backing store + commands for the generic native "preview" window used by the
//! git-history plugin. The main window computes a content string (a unified
//! diff, or self-contained rich HTML) and calls `open_preview_window`, which
//! stashes the payload keyed by the window label and creates/focuses the window.
//! The preview window fetches its payload via `take_preview_payload` on mount
//! (and again whenever it receives a `preview-updated` event).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One preview's data. `kind` is "diff" or "rich"; `content` is the unified
/// diff text (diff) or a self-contained HTML document (rich).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewPayload {
    pub title: String,
    pub kind: String,
    pub content: String,
}

/// Managed state: label -> pending payload.
#[derive(Default)]
pub struct PreviewStore(pub Mutex<HashMap<String, PreviewPayload>>);

/// Insert/overwrite the payload for `label`.
pub fn stash(map: &mut HashMap<String, PreviewPayload>, label: String, payload: PreviewPayload) {
    map.insert(label, payload);
}

/// Remove and return the payload for `label` (None if absent).
pub fn take(map: &mut HashMap<String, PreviewPayload>, label: &str) -> Option<PreviewPayload> {
    map.remove(label)
}

// `Emitter` is required for `window.emit(...)` in Tauri v2; `Manager` for
// `app.state()` / `app.get_webview_window()`.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Create (or focus + refresh) the preview window `label`, stashing `payload`
/// for the window to fetch. Reusing a label focuses the existing window and
/// emits `preview-updated` so it re-fetches.
#[tauri::command]
pub fn open_preview_window(
    app: AppHandle,
    label: String,
    title: String,
    kind: String,
    content: String,
) -> Result<(), String> {
    let payload = PreviewPayload { title: title.clone(), kind, content };
    {
        let store = app.state::<PreviewStore>();
        let mut map = store.0.lock().map_err(|e| e.to_string())?;
        stash(&mut map, label.clone(), payload);
    }

    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.emit("preview-updated", ());
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("preview.html".into()))
        .title(title)
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

/// Fetch (and clear) the pending payload for `label`. Called by the preview
/// window on mount and on each `preview-updated` event.
#[tauri::command]
pub fn take_preview_payload(
    app: AppHandle,
    label: String,
) -> Result<Option<PreviewPayload>, String> {
    let store = app.state::<PreviewStore>();
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    Ok(take(&mut map, &label))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(c: &str) -> PreviewPayload {
        PreviewPayload { title: "t".into(), kind: "diff".into(), content: c.into() }
    }

    #[test]
    fn take_returns_and_removes_stashed_payload() {
        let mut m = HashMap::new();
        stash(&mut m, "preview-diff-abc".into(), payload("hello"));
        let got = take(&mut m, "preview-diff-abc");
        assert_eq!(got, Some(payload("hello")));
        assert_eq!(take(&mut m, "preview-diff-abc"), None);
    }

    #[test]
    fn stash_overwrites_same_label() {
        let mut m = HashMap::new();
        stash(&mut m, "l".into(), payload("v1"));
        stash(&mut m, "l".into(), payload("v2"));
        assert_eq!(take(&mut m, "l").unwrap().content, "v2");
    }

    #[test]
    fn take_absent_label_is_none() {
        let mut m = HashMap::new();
        assert_eq!(take(&mut m, "nope"), None);
    }
}
