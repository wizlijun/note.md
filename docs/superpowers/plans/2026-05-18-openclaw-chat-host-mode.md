# M↓ OpenClaw Chat — Host Mode MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the minimum viable M↓ chat experience for **host machines** — i.e. the machine that also runs OpenClaw with the `mdeditor` channel plugin (Plan 1). When done, a user on the host can open a tray menu item "OpenClaw", get a separate chat window that talks to the local OpenClaw via UDS, send/receive messages with streaming, and click relative-path markdown links to open them in the existing editor.

**Architecture:** Single Tauri binary; multi-window via Vite multi-entry (existing `index.html` + new `chat.html`) and `tauri::WebviewWindowBuilder`. Mode detection (host vs remote) happens at startup in Rust; this plan implements only the host branch (UDS client). A new `openclaw` module in `src-tauri/` owns the UDS client lifecycle and exposes Tauri commands the Svelte chat UI calls. Vault-link resolution piggybacks on the existing `vault_sync_now` command. Settings reuse `tauri-plugin-store`. Tray entry is added to the existing menu in `lib.rs`.

**Tech Stack:** Rust + tokio (already in `Cargo.toml`; uses existing `time, process, io-util, macros, rt-multi-thread, sync` features — UDS support is in `tokio::net::UnixStream`/`UnixListener`, no new deps). Svelte 5 with runes (matching the existing codebase). Vite 5 multi-entry. Tauri v2.

**Spec:** `mdeditor/docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md` (commit `9f31934`). Sections 1.1-1.3, 2 (UDS protocol — consumes the wire format defined in Plan 1), 4.1-4.3, 4.6-4.7, 5.

**Depends on:** Plan 1 (OpenClaw `mdeditor` channel plugin) must produce a working UDS endpoint at `~/.openclaw/mdeditor.sock`. During development you can stub this with a `socat` listener or the e2e test fixture from Plan 1.

---

## File Structure

All paths relative to `/Users/bruce/git/mdeditor/`:

| Path | Responsibility |
|---|---|
| `chat.html` | Second Vite entry (HTML shell mirroring `index.html` minus the editor scripts) |
| `vite.config.ts` | Modified: add `rollupOptions.input` map for `index` + `chat` |
| `src/chat-main.ts` | Mounts the chat Svelte root |
| `src/chat-app.svelte` | Top-level chat component |
| `src/lib/openclaw/protocol.ts` | TypeScript frame types matching Plan 1's wire format |
| `src/lib/openclaw/client.svelte.ts` | Reactive state store (sessions, messages, connection status) |
| `src/lib/openclaw/commands.ts` | Wrappers around Tauri `invoke()` for openclaw_* commands |
| `src/lib/openclaw/links.ts` | Relative-path → vault path resolution (bound mode) |
| `src/components/chat/MessageList.svelte` | Renders the scroll-back |
| `src/components/chat/MessageBubble.svelte` | One message (user or agent), markdown-rendered |
| `src/components/chat/Composer.svelte` | Input box + send button + attachment placeholder |
| `src/components/chat/SessionPicker.svelte` | Sidebar / dropdown listing sessions |
| `src-tauri/src/openclaw/mod.rs` | Module root |
| `src-tauri/src/openclaw/config.rs` | Settings reader/writer (`openclaw.mode`, `openclaw.socketPath`, etc.) |
| `src-tauri/src/openclaw/protocol.rs` | Rust mirror of TS Frame types + line-delimited JSON + HMAC envelope |
| `src-tauri/src/openclaw/uds_client.rs` | UDS client task (connect, send, receive, auto-reconnect with backoff) |
| `src-tauri/src/openclaw/state.rs` | Shared `Arc<OpenClawState>` holding the active client handle + channel for emitting events |
| `src-tauri/src/openclaw/commands.rs` | `#[tauri::command]` wrappers + `tauri::Emitter` events |
| `src-tauri/src/lib.rs` | Modified: register tray "OpenClaw" item, register openclaw commands, init module |
| `src-tauri/tauri.conf.json` | Modified: declare `chat` webview window definition |

---

## Task 1: Vite multi-entry + empty chat window

**Files:**
- Create: `chat.html`
- Create: `src/chat-main.ts`
- Create: `src/chat-app.svelte`
- Modify: `vite.config.ts`

- [ ] **Step 1: Create `chat.html` (copy `index.html`, swap script)**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenClaw</title>
  </head>
  <body>
    <div id="chat-app"></div>
    <script type="module" src="/src/chat-main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/chat-main.ts`**

```typescript
import { mount } from 'svelte'
import ChatApp from './chat-app.svelte'

const target = document.getElementById('chat-app')
if (!target) throw new Error('chat-app root missing')
mount(ChatApp, { target })
```

- [ ] **Step 3: Create `src/chat-app.svelte` (placeholder)**

```svelte
<script lang="ts">
  let status = $state('Connecting...')
</script>

<main style="padding:1rem;font-family:system-ui">
  <h1>OpenClaw</h1>
  <p>Status: {status}</p>
</main>
```

- [ ] **Step 4: Modify `vite.config.ts` for multi-entry**

Replace the `build` block:
```typescript
build: {
  target: 'safari15',
  minify: 'esbuild',
  sourcemap: false,
  rollupOptions: {
    input: {
      index: 'index.html',
      chat: 'chat.html',
    },
  },
},
```

And update the `optimizeDeps.entries`:
```typescript
optimizeDeps: {
  entries: ['index.html', 'chat.html'],
},
```

- [ ] **Step 5: Run dev server, verify both routes load**

```bash
cd /Users/bruce/git/mdeditor && pnpm dev
```

Open http://localhost:1420/index.html and http://localhost:1420/chat.html in a browser; first should be the editor, second should be "OpenClaw Status: Connecting...".

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add chat.html src/chat-main.ts src/chat-app.svelte vite.config.ts && git commit -m "feat(chat): vite multi-entry with empty chat window"
```

---

## Task 2: Tauri chat window definition + tray entry

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Read existing chat window config from tauri.conf.json**

```bash
grep -n -A 30 '"windows"' /Users/bruce/git/mdeditor/src-tauri/tauri.conf.json | head -50
```

Note the existing primary-window definition (label, url, decorations, etc.).

- [ ] **Step 2: Add a second window definition for chat**

In `src-tauri/tauri.conf.json`, append to the `app.windows` array (alongside the existing window):

```jsonc
{
  "label": "chat",
  "url": "chat.html",
  "title": "OpenClaw",
  "width": 480,
  "height": 720,
  "minWidth": 360,
  "minHeight": 480,
  "resizable": true,
  "visible": false,
  "decorations": true
}
```

- [ ] **Step 3: Add a tray menu item — locate the existing menu**

Read `src-tauri/src/lib.rs` lines 600-650 (where the tray menu is built per spec section 1.3). Identify the existing item `show_item` and insert a new `openclaw_item` directly under it.

- [ ] **Step 4: Modify `src-tauri/src/lib.rs` tray menu builder**

In the block that builds `tray_menu` (search for `let show_item = MenuItem::with_id(app, "tray-show"`), add after it:

```rust
let openclaw_item = MenuItem::with_id(app, "tray-openclaw", "OpenClaw", true, None::<&str>)?;
```

And in the `MenuBuilder::new(app)` chain (which currently looks like `.item(&show_item).separator().item(&sync_repo_item)...`), insert `.item(&openclaw_item).separator()` right after `.item(&show_item).separator()`.

- [ ] **Step 5: Add the click handler**

In the `on_menu_event` match (search for `"tray-show" => show_main_window(app)`), add a new arm:

```rust
"tray-openclaw" => show_chat_window(app),
```

- [ ] **Step 6: Implement `show_chat_window`**

Add near `show_main_window` in `lib.rs`:

```rust
fn show_chat_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("chat") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.unminimize();
    }
}
```

- [ ] **Step 7: Build and smoke-test**

```bash
cd /Users/bruce/git/mdeditor && pnpm tauri dev
```

Once the dev build is up, click the tray icon's "OpenClaw" menu item. Expected: the OpenClaw window appears with "OpenClaw / Status: Connecting...".

- [ ] **Step 8: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri/tauri.conf.json src-tauri/src/lib.rs && git commit -m "feat(chat): tray entry + chat window definition"
```

---

## Task 3: Rust protocol module (mirror of Plan 1's wire format)

**Files:**
- Create: `src-tauri/src/openclaw/mod.rs`
- Create: `src-tauri/src/openclaw/protocol.rs`
- Modify: `src-tauri/src/lib.rs` to declare `mod openclaw;`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/lib.rs`, near the other `mod` declarations (look around lines 1-20), add:
```rust
mod openclaw;
```

- [ ] **Step 2: Create `src-tauri/src/openclaw/mod.rs`**

```rust
pub mod config;
pub mod protocol;
pub mod uds_client;
pub mod state;
pub mod commands;

pub use state::{OpenClawState, init_state};
```

> If `config.rs` etc. don't exist yet, this compile will fail temporarily — fine, we'll add them as we go. To unblock, comment out the `pub mod`s you haven't created yet and uncomment as you progress.

- [ ] **Step 3: Write failing test in `src-tauri/src/openclaw/protocol.rs`**

```rust
// src-tauri/src/openclaw/protocol.rs

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_user_message_frame() {
        let frame = Frame::UserMessage {
            session: "s1".to_string(),
            text: "hello".to_string(),
            attachments: vec![],
        };
        let token = "t".repeat(64);
        let line = wrap_for_wire(&frame, &token).unwrap();
        let parsed = unwrap_from_wire(&line, &token).unwrap();
        match parsed {
            Frame::UserMessage { session, text, .. } => {
                assert_eq!(session, "s1");
                assert_eq!(text, "hello");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn rejects_tampered_mac() {
        let frame = Frame::UserMessage { session: "s".into(), text: "x".into(), attachments: vec![] };
        let line = wrap_for_wire(&frame, "k").unwrap();
        let mut bad = line.clone();
        // flip a byte inside the JSON body but keep mac field
        if let Some(idx) = bad.find("hello") {
            bad.replace_range(idx..idx+1, "H");
        } else if let Some(idx) = bad.find('x') {
            bad.replace_range(idx..idx+1, "y");
        }
        assert!(unwrap_from_wire(&bad, "k").is_err());
    }
}
```

- [ ] **Step 4: Implement `Frame` enum + wrap/unwrap**

Above the tests in `protocol.rs`:

```rust
use hmac::{Hmac, Mac};
use sha2::Sha256;
use serde::{Deserialize, Serialize};
use serde_json::Value;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum Frame {
    #[serde(rename = "hello")]
    Hello { token: String, device: String },
    #[serde(rename = "welcome")]
    Welcome { channel_caps: Vec<String> },
    #[serde(rename = "user.message")]
    UserMessage { session: String, text: String, #[serde(default)] attachments: Vec<Value> },
    #[serde(rename = "user.cancel")]
    UserCancel { session: String, msg_id: String },
    #[serde(rename = "user.request_file")]
    UserRequestFile { session: String, path: String },
    #[serde(rename = "agent.message.delta")]
    AgentDelta { session: String, msg_id: String, text: String },
    #[serde(rename = "agent.message.end")]
    AgentEnd { session: String, msg_id: String, text: String, #[serde(default)] stop_reason: Option<String> },
    #[serde(rename = "agent.file_content")]
    AgentFileContent { session: String, path: String, content: String, #[serde(default)] media_type: Option<String> },
    #[serde(rename = "session.list")]
    SessionList,
    #[serde(rename = "session.list.result")]
    SessionListResult { sessions: Vec<Value>, #[serde(default)] focus: Option<String> },
    #[serde(rename = "session.new")]
    SessionNew { #[serde(default)] title: Option<String> },
    #[serde(rename = "session.open")]
    SessionOpen { id: String },
    #[serde(rename = "session.replay")]
    SessionReplay { id: String, #[serde(default)] after_msg_id: Option<String> },
    #[serde(other)]
    Other,
}

#[derive(Debug, Serialize)]
struct WireOut<'a> {
    #[serde(flatten)]
    body: &'a Value,
    mac: String,
}

pub fn wrap_for_wire(frame: &Frame, token: &str) -> Result<String, String> {
    let mut v = serde_json::to_value(frame).map_err(|e| e.to_string())?;
    if let Value::Object(ref mut map) = v {
        map.insert("v".into(), Value::from(1));
    }
    let body = serde_json::to_string(&v).map_err(|e| e.to_string())?;
    let mac = compute_mac(&body, token);
    if let Value::Object(ref mut map) = v {
        map.insert("mac".into(), Value::String(mac));
    }
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

pub fn unwrap_from_wire(line: &str, token: &str) -> Result<Frame, String> {
    let mut v: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let mac = v
        .as_object_mut()
        .and_then(|m| m.remove("mac"))
        .and_then(|m| m.as_str().map(|s| s.to_string()))
        .ok_or_else(|| "missing mac".to_string())?;
    let body = serde_json::to_string(&v).map_err(|e| e.to_string())?;
    let expected = compute_mac(&body, token);
    if !constant_time_eq(expected.as_bytes(), mac.as_bytes()) {
        return Err("mac verification failed".into());
    }
    serde_json::from_value::<Frame>(v).map_err(|e| e.to_string())
}

fn compute_mac(body: &str, token: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).expect("key");
    mac.update(body.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut diff = 0u8;
    for i in 0..a.len() { diff |= a[i] ^ b[i]; }
    diff == 0
}
```

- [ ] **Step 5: Add dependencies to `src-tauri/Cargo.toml`**

Under `[dependencies]`, add:
```toml
hmac = "0.12"
sha2 = "0.10"
hex = "0.4"
```

- [ ] **Step 6: Run tests**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo test openclaw::protocol
```
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri/src/openclaw src-tauri/src/lib.rs src-tauri/Cargo.toml && git commit -m "feat(chat): rust protocol module + hmac wire framing"
```

---

## Task 4: UDS client (connect, send, receive, reconnect)

**Files:**
- Create: `src-tauri/src/openclaw/uds_client.rs`
- Create: `src-tauri/src/openclaw/config.rs`

- [ ] **Step 1: Implement `src-tauri/src/openclaw/config.rs`**

```rust
// src-tauri/src/openclaw/config.rs
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenClawConfig {
    pub mode: ConnectMode,
    pub socket_path: PathBuf,
    pub access_token: Option<String>,
    pub relay_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectMode {
    Auto,
    Host,
    Remote,
}

impl Default for OpenClawConfig {
    fn default() -> Self {
        let home = dirs::home_dir().expect("home dir");
        Self {
            mode: ConnectMode::Auto,
            socket_path: home.join(".openclaw").join("mdeditor.sock"),
            access_token: None,
            relay_url: Some("wss://mdrelay.example.com".into()),
        }
    }
}

pub fn read(app: &tauri::AppHandle) -> OpenClawConfig {
    use tauri_plugin_store::StoreExt;
    let store = match app.store("settings.json") { Ok(s) => s, Err(_) => return OpenClawConfig::default() };
    let mode = store.get("openclaw.mode")
        .and_then(|v| v.as_str().map(|s| match s {
            "host" => ConnectMode::Host,
            "remote" => ConnectMode::Remote,
            _ => ConnectMode::Auto,
        }))
        .unwrap_or(ConnectMode::Auto);
    let socket_path = store.get("openclaw.socketPath")
        .and_then(|v| v.as_str().map(|s| {
            if s.starts_with("~/") {
                dirs::home_dir().map(|h| h.join(&s[2..])).unwrap_or_else(|| PathBuf::from(s))
            } else { PathBuf::from(s) }
        }))
        .unwrap_or_else(|| OpenClawConfig::default().socket_path);
    let access_token = store.get("openclaw.accessToken").and_then(|v| v.as_str().map(String::from));
    let relay_url = store.get("openclaw.relayUrl").and_then(|v| v.as_str().map(String::from))
        .or_else(|| OpenClawConfig::default().relay_url);
    OpenClawConfig { mode, socket_path, access_token, relay_url }
}
```

- [ ] **Step 2: Implement UDS client task with backoff**

`src-tauri/src/openclaw/uds_client.rs`:

```rust
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, Mutex};

use super::protocol::{wrap_for_wire, unwrap_from_wire, Frame};

#[derive(Debug, Clone)]
pub enum UdsEvent {
    Connecting,
    Connected,
    Disconnected(String),
    Frame(Frame),
    Error(String),
}

pub struct UdsClient {
    pub tx_to_server: mpsc::Sender<Frame>,
    pub event_rx: Arc<Mutex<mpsc::Receiver<UdsEvent>>>,
}

pub fn spawn(socket_path: PathBuf, access_token: String) -> UdsClient {
    let (tx_to_server, mut rx_to_server) = mpsc::channel::<Frame>(32);
    let (event_tx, event_rx) = mpsc::channel::<UdsEvent>(64);

    tokio::spawn(async move {
        let mut delay = Duration::from_millis(500);
        loop {
            let _ = event_tx.send(UdsEvent::Connecting).await;
            match UnixStream::connect(&socket_path).await {
                Ok(stream) => {
                    delay = Duration::from_millis(500);
                    let (read_half, mut write_half) = stream.into_split();
                    let _ = event_tx.send(UdsEvent::Connected).await;

                    // Handshake: send hello.
                    let hello = Frame::Hello { token: access_token.clone(), device: "host-local".into() };
                    if let Ok(line) = wrap_for_wire(&hello, &access_token) {
                        let _ = write_half.write_all(line.as_bytes()).await;
                        let _ = write_half.write_all(b"\n").await;
                    }

                    let reader_token = access_token.clone();
                    let reader_event_tx = event_tx.clone();
                    let reader_task = tokio::spawn(async move {
                        let mut buf = BufReader::new(read_half);
                        let mut line = String::new();
                        loop {
                            line.clear();
                            match buf.read_line(&mut line).await {
                                Ok(0) => break,
                                Ok(_) => {
                                    let trimmed = line.trim_end();
                                    if trimmed.is_empty() { continue; }
                                    match unwrap_from_wire(trimmed, &reader_token) {
                                        Ok(f) => { let _ = reader_event_tx.send(UdsEvent::Frame(f)).await; }
                                        Err(e) => { let _ = reader_event_tx.send(UdsEvent::Error(e)).await; }
                                    }
                                }
                                Err(e) => {
                                    let _ = reader_event_tx.send(UdsEvent::Error(e.to_string())).await;
                                    break;
                                }
                            }
                        }
                    });

                    // Writer pump: drain outgoing frames.
                    while let Some(frame) = rx_to_server.recv().await {
                        match wrap_for_wire(&frame, &access_token) {
                            Ok(line) => {
                                if write_half.write_all(line.as_bytes()).await.is_err() { break; }
                                if write_half.write_all(b"\n").await.is_err() { break; }
                            }
                            Err(e) => {
                                let _ = event_tx.send(UdsEvent::Error(e)).await;
                            }
                        }
                    }

                    let _ = reader_task.await;
                    let _ = event_tx.send(UdsEvent::Disconnected("eof".into())).await;
                }
                Err(e) => {
                    let _ = event_tx.send(UdsEvent::Error(format!("connect failed: {}", e))).await;
                }
            }

            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(60));
        }
    });

    UdsClient { tx_to_server, event_rx: Arc::new(Mutex::new(event_rx)) }
}
```

- [ ] **Step 3: Compile, fix any warnings**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo check
```
Expected: clean compile (warnings allowed; errors not allowed).

- [ ] **Step 4: Write a connection smoke test using a temp UDS server**

Append to `src-tauri/src/openclaw/uds_client.rs` (inside `#[cfg(test)]`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::net::UnixListener;
    use tokio::time::timeout;

    #[tokio::test]
    async fn connects_and_sends_hello() {
        let dir = tempdir().unwrap();
        let sock = dir.path().join("test.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        // Accept one connection and read one line.
        let sock_path = sock.clone();
        let accept_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut buf = BufReader::new(stream);
            let mut line = String::new();
            buf.read_line(&mut line).await.unwrap();
            line
        });

        let token = "t".repeat(64);
        let _client = spawn(sock_path, token.clone());
        let line = timeout(Duration::from_secs(2), accept_task).await.unwrap().unwrap();
        assert!(line.contains("hello"));
        assert!(line.contains("\"mac\""));
    }
}
```

- [ ] **Step 5: Add `tempfile` to `[dev-dependencies]`**

Already present in `src-tauri/Cargo.toml` (`tempfile = "3"`). Confirm.

- [ ] **Step 6: Run test**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo test openclaw::uds_client
```
Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri/src/openclaw && git commit -m "feat(chat): UDS client with reconnect + tokio task"
```

---

## Task 5: Shared state + Tauri commands + event emission

**Files:**
- Create: `src-tauri/src/openclaw/state.rs`
- Create: `src-tauri/src/openclaw/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write `state.rs`**

```rust
// src-tauri/src/openclaw/state.rs
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::openclaw::uds_client::UdsClient;
use crate::openclaw::config::OpenClawConfig;

pub struct OpenClawState {
    pub config: Mutex<OpenClawConfig>,
    pub uds: Mutex<Option<UdsClient>>,
}

pub fn init_state(app: &tauri::AppHandle) -> Arc<OpenClawState> {
    let cfg = crate::openclaw::config::read(app);
    Arc::new(OpenClawState {
        config: Mutex::new(cfg),
        uds: Mutex::new(None),
    })
}
```

- [ ] **Step 2: Write `commands.rs`**

```rust
// src-tauri/src/openclaw/commands.rs
use std::sync::Arc;
use tauri::{AppHandle, Manager, Emitter};
use tokio::task;
use crate::openclaw::protocol::Frame;
use crate::openclaw::state::OpenClawState;
use crate::openclaw::uds_client::{spawn, UdsEvent};
use crate::openclaw::config::ConnectMode;

#[tauri::command]
pub async fn openclaw_connect(app: AppHandle) -> Result<String, String> {
    let state = app.state::<Arc<OpenClawState>>();
    let cfg = state.config.lock().await.clone();

    let mode = match cfg.mode {
        ConnectMode::Auto => {
            if cfg.socket_path.exists() { ConnectMode::Host } else { ConnectMode::Remote }
        }
        m => m,
    };

    if mode != ConnectMode::Host {
        return Err("remote mode not implemented in this plan".into());
    }

    let token = cfg.access_token.clone()
        .ok_or_else(|| "access token not configured — run OpenClaw once to auto-generate".to_string())?;
    let client = spawn(cfg.socket_path.clone(), token);

    // Forward events to webview.
    let event_rx = client.event_rx.clone();
    let app_for_events = app.clone();
    task::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(UdsEvent::Connected) => { let _ = app_for_events.emit("openclaw://status", "connected"); }
                Some(UdsEvent::Connecting) => { let _ = app_for_events.emit("openclaw://status", "connecting"); }
                Some(UdsEvent::Disconnected(r)) => { let _ = app_for_events.emit("openclaw://status", format!("disconnected:{}", r)); }
                Some(UdsEvent::Error(e)) => { let _ = app_for_events.emit("openclaw://error", e); }
                Some(UdsEvent::Frame(f)) => { let _ = app_for_events.emit("openclaw://frame", f); }
                None => break,
            }
        }
    });

    *state.uds.lock().await = Some(client);
    Ok("host".into())
}

#[tauri::command]
pub async fn openclaw_send(app: AppHandle, frame: Frame) -> Result<(), String> {
    let state = app.state::<Arc<OpenClawState>>();
    let guard = state.uds.lock().await;
    let client = guard.as_ref().ok_or_else(|| "not connected".to_string())?;
    client.tx_to_server.send(frame).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn openclaw_disconnect(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<OpenClawState>>();
    *state.uds.lock().await = None;
    Ok(())
}
```

- [ ] **Step 3: Register state + commands in `src-tauri/src/lib.rs`**

In the existing setup chain, after the existing `manage(...)` calls, add:

```rust
let openclaw_state = crate::openclaw::init_state(&app.handle());
app.manage(openclaw_state);
```

In the `tauri::generate_handler![...]` macro invocation around line 552, append:
```rust
crate::openclaw::commands::openclaw_connect,
crate::openclaw::commands::openclaw_send,
crate::openclaw::commands::openclaw_disconnect,
```

- [ ] **Step 4: Compile**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo check
```
Expected: clean compile.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri && git commit -m "feat(chat): openclaw state + tauri commands + event bridge"
```

---

## Task 6: TypeScript client wrappers + reactive store

**Files:**
- Create: `src/lib/openclaw/protocol.ts`
- Create: `src/lib/openclaw/commands.ts`
- Create: `src/lib/openclaw/client.svelte.ts`

- [ ] **Step 1: Write `protocol.ts` (mirror Rust types)**

```typescript
// src/lib/openclaw/protocol.ts
export interface PoolSession { id: string; title?: string; createdAt?: number; updatedAt?: number }

export type Frame =
  | { type: 'hello'; token: string; device: string }
  | { type: 'welcome'; channel_caps: string[] }
  | { type: 'user.message'; session: string; text: string; attachments?: unknown[] }
  | { type: 'user.cancel'; session: string; msg_id: string }
  | { type: 'user.request_file'; session: string; path: string }
  | { type: 'agent.message.delta'; session: string; msg_id: string; text: string }
  | { type: 'agent.message.end'; session: string; msg_id: string; text: string; stop_reason?: string }
  | { type: 'agent.file_content'; session: string; path: string; content: string; media_type?: string }
  | { type: 'session.list' }
  | { type: 'session.list.result'; sessions: PoolSession[]; focus?: string }
  | { type: 'session.new'; title?: string }
  | { type: 'session.open'; id: string }
  | { type: 'session.replay'; id: string; after_msg_id?: string }

export interface Message {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  streaming?: boolean
}
```

- [ ] **Step 2: Write `commands.ts`**

```typescript
// src/lib/openclaw/commands.ts
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnsubscribeFn } from '@tauri-apps/api/event'
import type { Frame } from './protocol'

export async function connect(): Promise<string> {
  return invoke('openclaw_connect')
}

export async function disconnect(): Promise<void> {
  return invoke('openclaw_disconnect')
}

export async function send(frame: Frame): Promise<void> {
  return invoke('openclaw_send', { frame })
}

export async function onFrame(cb: (f: Frame) => void): Promise<UnsubscribeFn> {
  return listen<Frame>('openclaw://frame', (e) => cb(e.payload))
}

export async function onStatus(cb: (s: string) => void): Promise<UnsubscribeFn> {
  return listen<string>('openclaw://status', (e) => cb(e.payload))
}

export async function onError(cb: (s: string) => void): Promise<UnsubscribeFn> {
  return listen<string>('openclaw://error', (e) => cb(e.payload))
}
```

- [ ] **Step 3: Write `client.svelte.ts` (reactive store)**

```typescript
// src/lib/openclaw/client.svelte.ts
import { connect, disconnect, send, onFrame, onStatus, onError } from './commands'
import type { Frame, Message, PoolSession } from './protocol'

export const state = $state({
  status: 'idle' as 'idle' | 'connecting' | 'connected' | 'disconnected',
  sessions: [] as PoolSession[],
  currentSessionId: null as string | null,
  messagesBySession: {} as Record<string, Message[]>,
  error: null as string | null,
})

let unsubFrame: (() => void) | null = null
let unsubStatus: (() => void) | null = null
let unsubError: (() => void) | null = null

export async function start(): Promise<void> {
  unsubFrame = await onFrame(handleFrame)
  unsubStatus = await onStatus((s) => { state.status = (s.startsWith('disconnected') ? 'disconnected' : (s as typeof state.status)) })
  unsubError = await onError((e) => { state.error = e })
  await connect()
  await send({ type: 'session.list' })
}

export async function stop(): Promise<void> {
  await disconnect()
  unsubFrame?.(); unsubStatus?.(); unsubError?.()
}

function ensureBucket(sid: string): Message[] {
  if (!state.messagesBySession[sid]) state.messagesBySession[sid] = []
  return state.messagesBySession[sid]
}

function handleFrame(f: Frame): void {
  switch (f.type) {
    case 'session.list.result':
      state.sessions = f.sessions
      if (f.focus) state.currentSessionId = f.focus
      else if (!state.currentSessionId && f.sessions[0]) state.currentSessionId = f.sessions[0].id
      break
    case 'agent.message.delta': {
      const bucket = ensureBucket(f.session)
      let m = bucket.find((x) => x.id === f.msg_id)
      if (!m) { m = { id: f.msg_id, role: 'agent', text: '', streaming: true }; bucket.push(m) }
      m.text += f.text
      m.streaming = true
      break
    }
    case 'agent.message.end': {
      const bucket = ensureBucket(f.session)
      let m = bucket.find((x) => x.id === f.msg_id)
      if (!m) { m = { id: f.msg_id, role: 'agent', text: f.text, streaming: false }; bucket.push(m) }
      else { m.text = f.text || m.text; m.streaming = false }
      break
    }
    case 'agent.file_content':
      // Handled by link-handling module; ignored here.
      break
  }
}

export async function sendUserMessage(text: string): Promise<void> {
  let sid = state.currentSessionId
  if (!sid) {
    await send({ type: 'session.new', title: text.slice(0, 40) })
    return
  }
  const msgId = 'm-' + Math.random().toString(36).slice(2, 10)
  ensureBucket(sid).push({ id: msgId, role: 'user', text, streaming: false })
  await send({ type: 'user.message', session: sid, text })
}

export async function newSession(title?: string): Promise<void> {
  await send({ type: 'session.new', title })
}

export async function openSession(id: string): Promise<void> {
  state.currentSessionId = id
  await send({ type: 'session.replay', id })
}
```

- [ ] **Step 4: Compile-check (svelte-check)**

```bash
cd /Users/bruce/git/mdeditor && pnpm svelte-check --threshold error 2>&1 | head -30
```
Expected: no errors in new files. (If the project doesn't run svelte-check, run `pnpm build` instead and ensure no TS errors.)

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src/lib/openclaw && git commit -m "feat(chat): typescript client + reactive store"
```

---

## Task 7: Minimal chat UI components

**Files:**
- Create: `src/components/chat/MessageList.svelte`
- Create: `src/components/chat/MessageBubble.svelte`
- Create: `src/components/chat/Composer.svelte`
- Create: `src/components/chat/SessionPicker.svelte`
- Replace: `src/chat-app.svelte` (now wire to store + components)

- [ ] **Step 1: `MessageBubble.svelte`**

```svelte
<!-- src/components/chat/MessageBubble.svelte -->
<script lang="ts">
  import type { Message } from '../../lib/openclaw/protocol'

  let { message }: { message: Message } = $props()
</script>

<div class="bubble" class:user={message.role === 'user'} class:agent={message.role === 'agent'}>
  <div class="role">{message.role}</div>
  <div class="text">{message.text}{#if message.streaming}<span class="cursor">▍</span>{/if}</div>
</div>

<style>
  .bubble { padding: 0.5rem 0.75rem; margin: 0.25rem 0; border-radius: 8px; }
  .bubble.user { background: #2563eb; color: white; align-self: flex-end; max-width: 80%; margin-left: auto; }
  .bubble.agent { background: #f3f4f6; color: #111; max-width: 80%; }
  .role { font-size: 0.7rem; opacity: 0.6; text-transform: uppercase; }
  .text { white-space: pre-wrap; word-break: break-word; }
  .cursor { animation: blink 1s steps(1) infinite; opacity: 0.5; }
  @keyframes blink { 50% { opacity: 0; } }
</style>
```

- [ ] **Step 2: `MessageList.svelte`**

```svelte
<!-- src/components/chat/MessageList.svelte -->
<script lang="ts">
  import { state } from '../../lib/openclaw/client.svelte'
  import MessageBubble from './MessageBubble.svelte'

  const messages = $derived(state.currentSessionId ? (state.messagesBySession[state.currentSessionId] ?? []) : [])
</script>

<div class="list">
  {#each messages as m (m.id)}
    <MessageBubble message={m} />
  {/each}
  {#if messages.length === 0}
    <p class="empty">No messages yet. Say hi.</p>
  {/if}
</div>

<style>
  .list { display: flex; flex-direction: column; padding: 0.75rem; overflow-y: auto; flex: 1; }
  .empty { color: #777; text-align: center; margin-top: 2rem; }
</style>
```

- [ ] **Step 3: `Composer.svelte`**

```svelte
<!-- src/components/chat/Composer.svelte -->
<script lang="ts">
  import { sendUserMessage } from '../../lib/openclaw/client.svelte'

  let text = $state('')
  let sending = $state(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!text.trim() || sending) return
    sending = true
    const payload = text
    text = ''
    try { await sendUserMessage(payload) } finally { sending = false }
  }
</script>

<form class="composer" onsubmit={submit}>
  <textarea
    bind:value={text}
    placeholder="Type to OpenClaw…"
    rows="2"
    onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(new SubmitEvent('submit')) }}
  ></textarea>
  <button type="submit" disabled={!text.trim() || sending}>Send</button>
</form>

<style>
  .composer { display: flex; gap: 0.5rem; padding: 0.5rem; border-top: 1px solid #e5e7eb; }
  textarea { flex: 1; resize: none; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
  button { padding: 0 1rem; border: 0; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; }
  button:disabled { background: #9ca3af; cursor: not-allowed; }
</style>
```

- [ ] **Step 4: `SessionPicker.svelte`**

```svelte
<!-- src/components/chat/SessionPicker.svelte -->
<script lang="ts">
  import { state, newSession, openSession } from '../../lib/openclaw/client.svelte'
</script>

<header class="picker">
  <select
    value={state.currentSessionId ?? ''}
    onchange={(e) => openSession((e.target as HTMLSelectElement).value)}
  >
    {#each state.sessions as s (s.id)}
      <option value={s.id}>{s.title ?? s.id}</option>
    {/each}
  </select>
  <button onclick={() => newSession()}>+ New</button>
  <span class="status" data-status={state.status}>{state.status}</span>
</header>

<style>
  .picker { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; border-bottom: 1px solid #e5e7eb; }
  select { flex: 1; padding: 0.25rem; }
  .status { font-size: 0.75rem; padding: 0.125rem 0.5rem; border-radius: 4px; background: #fef3c7; color: #92400e; }
  .status[data-status="connected"] { background: #d1fae5; color: #065f46; }
  .status[data-status="disconnected"] { background: #fee2e2; color: #991b1b; }
</style>
```

- [ ] **Step 5: Replace `src/chat-app.svelte`**

```svelte
<!-- src/chat-app.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { start, stop } from './lib/openclaw/client.svelte'
  import SessionPicker from './components/chat/SessionPicker.svelte'
  import MessageList from './components/chat/MessageList.svelte'
  import Composer from './components/chat/Composer.svelte'

  onMount(() => {
    start()
    return () => { stop() }
  })
</script>

<main>
  <SessionPicker />
  <MessageList />
  <Composer />
</main>

<style>
  :global(body) { margin: 0; font-family: -apple-system, system-ui, sans-serif; }
  main { display: flex; flex-direction: column; height: 100vh; }
</style>
```

- [ ] **Step 6: Run dev, smoke-test**

```bash
cd /Users/bruce/git/mdeditor && pnpm tauri dev
```

Click tray → OpenClaw. The chat window should show "connecting…" status; if Plan 1's plugin is running, status switches to "connected", and you can send a message. If Plan 1 isn't ready, use `socat UNIX-LISTEN:~/.openclaw/mdeditor.sock,fork -` to manually capture the hello frame.

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src && git commit -m "feat(chat): minimal chat UI wired to UDS client"
```

---

## Task 8: Vault link resolution (bound mode) + editor-window awakening

**Files:**
- Create: `src/lib/openclaw/links.ts`
- Modify: `src-tauri/src/lib.rs` (add `editor_show_and_open_path` command)
- Modify: `src/components/chat/MessageBubble.svelte` (wire link clicks)

- [ ] **Step 1: Add Tauri command `editor_show_and_open_path`**

In `src-tauri/src/lib.rs`, near `show_main_window`:

```rust
#[tauri::command]
async fn editor_show_and_open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.unminimize();
        // Defer to existing frontend "open file" event so the editor can decide tabs.
        let _ = win.emit("editor://open-path", &path);
    } else {
        // Main window isn't built; emit a global event the next startup will drain.
        let _ = app.emit("editor://pending-open", &path);
    }
    Ok(())
}
```

Add `editor_show_and_open_path` to the `tauri::generate_handler!` list.

- [ ] **Step 2: Verify the editor's `App.svelte` already listens to `editor://open-path`**

```bash
grep -rn 'editor://open-path\|drain_pending_files' /Users/bruce/git/mdeditor/src 2>&1 | head -10
```

If there is an existing "drain pending files" mechanism (the spec history mentions one for Finder integration), wire the new command to it instead. Otherwise add a listener at the top of `App.svelte`:

```typescript
import { listen } from '@tauri-apps/api/event'
import { onMount } from 'svelte'
// inside the script:
onMount(() => {
  const unsub = listen<string>('editor://open-path', (e) => {
    openFileByPath(e.payload)  // reuse existing tab-opening helper
  })
  return () => { unsub.then(f => f()) }
})
```

Use the actual existing tab-opening helper name (look at `src/lib/tabs.svelte.ts` for the entry point).

- [ ] **Step 3: Write `src/lib/openclaw/links.ts`**

```typescript
// src/lib/openclaw/links.ts
import { invoke } from '@tauri-apps/api/core'
import { send } from './commands'
import { state } from './client.svelte'

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const VAULT_TOKEN = '{{vault}}'

export interface ResolveOpts {
  vaultRoot: string | null
  isBoundMode: boolean
  currentSession: string | null
  autoSync: boolean
}

export function isVaultLink(href: string): boolean {
  if (SCHEME_RE.test(href)) return false
  if (href.startsWith('/')) return false
  if (href.startsWith(VAULT_TOKEN)) return true
  return href.endsWith('.md') || href.includes('/')
}

/**
 * Open a relative-path md link. In bound mode: resolve against local vault,
 * optionally sync first if missing. In web mode (no local vault): ask the
 * host for the file content via the channel.
 */
export async function openVaultLink(href: string, opts: ResolveOpts): Promise<void> {
  if (!opts.isBoundMode) {
    // Web mode: defer to host.
    if (!opts.currentSession) throw new Error('no active session')
    await send({ type: 'user.request_file', session: opts.currentSession, path: href })
    return
  }
  if (!opts.vaultRoot) throw new Error('vault root not configured')

  let rel = href
  if (rel.startsWith(VAULT_TOKEN)) rel = rel.slice(VAULT_TOKEN.length).replace(/^[/]+/, '')
  rel = rel.replace(/^\.\//, '')
  const fullPath = `${opts.vaultRoot.replace(/\/$/, '')}/${rel}`

  let exists = await invoke<boolean>('file_exists', { path: fullPath })
  if (!exists && opts.autoSync) {
    await invoke('vault_sync_now')
    exists = await invoke<boolean>('file_exists', { path: fullPath })
  }
  if (!exists) {
    state.error = `not found in local vault: ${href}`
    return
  }
  await invoke('editor_show_and_open_path', { path: fullPath })
}
```

- [ ] **Step 4: Confirm `file_exists` Tauri command exists or add it**

```bash
grep -rn "file_exists\|file_path_exists" /Users/bruce/git/mdeditor/src-tauri/src 2>&1 | head -5
```

If absent, add to `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}
```

…and register in the handler list. If similar already exists under another name, use that name in `links.ts` instead.

- [ ] **Step 5: Wire link-click in `MessageBubble.svelte`**

Replace the `.text` div with markdown-rendered HTML and intercept link clicks. For MVP keep markdown simple (use the existing `markdown-it` or whatever the editor uses; if not readily importable, just render plain text and parse `[label](href)` patterns manually):

```svelte
<script lang="ts">
  import type { Message } from '../../lib/openclaw/protocol'
  import { openVaultLink } from '../../lib/openclaw/links'
  import { state } from '../../lib/openclaw/client.svelte'
  import { settings } from '../../lib/settings.svelte'

  let { message }: { message: Message } = $props()

  function renderText(t: string): { html: string } {
    const escaped = t.replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'} as Record<string,string>)[c])
    const linked = escaped.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, label, href) => `<a href="${href}" data-link>${label}</a>`
    )
    return { html: linked.replace(/\n/g, '<br>') }
  }

  function onClick(e: MouseEvent) {
    const target = e.target as HTMLElement
    const a = target.closest('a[data-link]') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    openVaultLink(href, {
      vaultRoot: settings.vault_sync?.repo_path ?? null,
      isBoundMode: !!settings.vault_sync?.repo_path,
      currentSession: state.currentSessionId,
      autoSync: settings.openclaw?.autoSyncBeforeResolve ?? true,
    })
  }
</script>

<div class="bubble" class:user={message.role === 'user'} class:agent={message.role === 'agent'} onclick={onClick}>
  <div class="role">{message.role}</div>
  <div class="text">{@html renderText(message.text).html}{#if message.streaming}<span class="cursor">▍</span>{/if}</div>
</div>
```

> Adjust the import for `settings` to whatever path your project uses (`./lib/settings.svelte`). If there is no openclaw-namespaced settings object yet, fall back to a constant `autoSync = true` until Task 9 adds settings UI.

- [ ] **Step 6: Smoke test**

Run dev. Open a chat session. Manually send a message; manually trigger the plugin (or a mock) to reply with `[note](./README.md)`. Click the link. Expected: main editor window pops up with `README.md` opened.

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src src-tauri && git commit -m "feat(chat): bound-mode vault link resolution + editor wake-up"
```

---

## Task 9: Settings UI (mode + paths + auto-sync)

**Files:**
- Create: `src/components/OpenClawSettingsTab.svelte`
- Modify: `src/components/SettingsDialog.svelte` (add the tab)
- Modify: `src/lib/settings.svelte.ts` (declare `openclaw` namespace)

- [ ] **Step 1: Inspect existing settings shape**

```bash
grep -n "vault_sync\|export const settings" /Users/bruce/git/mdeditor/src/lib/settings.svelte.ts | head -10
```

- [ ] **Step 2: Extend the settings type**

Add to `src/lib/settings.svelte.ts` (in the matching shape):

```typescript
// inside the settings store interface/object:
openclaw: {
  mode: 'auto' as 'auto' | 'host' | 'remote',
  socketPath: '' as string,
  accessToken: '' as string,
  relayUrl: '' as string,
  autoSyncBeforeResolve: true as boolean,
}
```

Match the existing persistence pattern (`tauri-plugin-store`).

- [ ] **Step 3: Create the settings tab component**

```svelte
<!-- src/components/OpenClawSettingsTab.svelte -->
<script lang="ts">
  import { settings, persist } from '../lib/settings.svelte'
</script>

<section>
  <h3>OpenClaw</h3>

  <label>
    Connect mode
    <select bind:value={settings.openclaw.mode} onchange={() => persist('openclaw.mode')}>
      <option value="auto">Auto-detect</option>
      <option value="host">Host (local UDS)</option>
      <option value="remote">Remote (via mdrelay)</option>
    </select>
  </label>

  <label>
    UDS socket path (host mode)
    <input bind:value={settings.openclaw.socketPath} onblur={() => persist('openclaw.socketPath')} placeholder="~/.openclaw/mdeditor.sock" />
  </label>

  <label>
    Access token (auto-generated by OpenClaw)
    <input type="password" bind:value={settings.openclaw.accessToken} onblur={() => persist('openclaw.accessToken')} />
  </label>

  <label>
    Relay URL (remote mode)
    <input bind:value={settings.openclaw.relayUrl} onblur={() => persist('openclaw.relayUrl')} placeholder="wss://mdrelay.example.com" />
  </label>

  <label>
    <input type="checkbox" bind:checked={settings.openclaw.autoSyncBeforeResolve} onchange={() => persist('openclaw.autoSyncBeforeResolve')} />
    Auto-sync before resolving chat links
  </label>
</section>

<style>
  section { padding: 1rem; max-width: 480px; }
  label { display: block; margin: 0.75rem 0; }
  input, select { width: 100%; padding: 0.25rem; margin-top: 0.25rem; }
</style>
```

> `persist(key)` mirrors however the existing settings tabs save (look at `VaultSettingsTab.svelte` for the pattern). Use that exact pattern.

- [ ] **Step 4: Add the tab to `SettingsDialog.svelte`**

Look at how existing tabs are wired (search for `VaultSettingsTab`). Add an "OpenClaw" tab next to "Vault" using the same mechanism.

- [ ] **Step 5: Smoke test**

Run dev → Cmd+, → click OpenClaw tab → change mode → restart app → verify mode is persisted.

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src && git commit -m "feat(chat): openclaw settings tab"
```

---

## Task 10: Single-instance + window persistence

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Verify single-instance plugin is registered**

```bash
grep -n "tauri-plugin-single-instance" /Users/bruce/git/mdeditor/src-tauri/src/lib.rs | head -5
```

If yes (it already is, per Cargo.toml), the second invocation of the app should focus the existing window. Confirm tray → OpenClaw with the app already running just focuses, doesn't spawn a duplicate.

- [ ] **Step 2: Persist chat window size**

Inspect existing windows for size persistence (the editor already does this — look for `tauri-plugin-window-state` or hand-rolled storage). If absent, install `tauri-plugin-window-state`:

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo add tauri-plugin-window-state
```

Then in `lib.rs`:
```rust
.plugin(tauri_plugin_window_state::Builder::default().build())
```

Confirm both windows now restore size/position on relaunch.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri && git commit -m "feat(chat): persist chat window size + single-instance focus"
```

---

## Task 11: End-to-end manual test against Plan 1's plugin

- [ ] **Step 1: Verify Plan 1 plugin is running**

```bash
cd ~/git/openclaw && node openclaw.mjs channels list 2>&1 | grep mdeditor
ls -la ~/.openclaw/mdeditor.sock
```

Expected: channel listed, socket file exists with mode 0600.

- [ ] **Step 2: Read access token from OpenClaw config**

```bash
cat ~/.openclaw/openclaw.json | grep -A 5 accounts
```

Copy `accessToken` value. Paste into M↓ settings → OpenClaw → Access token. Save.

- [ ] **Step 3: Launch M↓ chat**

Click tray → OpenClaw. Expected: status flips to "connected" within ~1s.

- [ ] **Step 4: Send a message**

Type "hello, what model are you?" → Send.

Expected:
- User bubble appears immediately
- Agent bubble appears with streaming delta dots (or whole reply if streaming not yet implemented in OpenClaw runtime call — see Plan 1 Task 9)
- No errors in DevTools console
- `lsof -p $(pgrep -f openclaw)` shows the UDS, no listen TCP socket

- [ ] **Step 5: Create a new session and switch back**

Click "+ New" → type something → switch back via dropdown to the first session → verify both buckets render their own message history.

- [ ] **Step 6: Test relative-path link**

Have the agent reply with a markdown link to an existing vault file (e.g. ask "Show me a link to README.md"). Click it.

Expected: editor main window opens (or focuses if already open) with that file.

- [ ] **Step 7: Test reconnect**

Kill OpenClaw (`pkill -f openclaw`). Expected: status flips to "disconnected" → "connecting…" loop.
Restart OpenClaw. Expected: status flips back to "connected" within a few seconds without restarting M↓.

- [ ] **Step 8: Commit any fixes uncovered**

```bash
cd /Users/bruce/git/mdeditor && git add . && git commit -m "fix(chat): e2e test against live openclaw plugin"
```

(only if fixes needed; otherwise skip.)

---

## Done criteria

- [ ] All `cargo test openclaw::` tests pass
- [ ] Tray menu shows "OpenClaw" between "Show M↓" and "Vault Sync"
- [ ] Clicking the tray entry opens a separate 480×720 window with the chat UI
- [ ] Chat window status flips to "connected" within 1 s when OpenClaw is running with the `mdeditor` channel plugin (Plan 1)
- [ ] Sending a message and receiving a reply (streaming or non-streaming) works end-to-end via UDS
- [ ] Relative-path md links open in the editor main window; "auto-sync before resolving" toggle works
- [ ] Killing & restarting OpenClaw triggers auto-reconnect without restarting M↓
- [ ] Closing the chat window does not affect the editor main window and vice-versa
- [ ] Settings → OpenClaw → mode change persists across restart
- [ ] No listen TCP/HTTP/WS sockets opened by M↓ in host mode (`lsof -p $(pgrep mdeditor)`)
- [ ] All work committed in atomic `feat(chat): …` / `test(chat): …` / `fix(chat): …` commits
