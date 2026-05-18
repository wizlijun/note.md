# M↓ OpenClaw Chat — Remote Mode + Relay Bridge + Web Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the OpenClaw Chat surface for **remote devices** and for **web-mode** (no local vault) operation. Adds: (1) the host-side **relay bridge** that fans channel traffic out to mdrelay; (2) the remote-side **WSS client** that reaches the host through mdrelay; (3) full **pairing UX** in M↓ (host's "Add device" wizard + remote's onboarding); (4) **Devices** settings page; (5) **web-mode vault link** behavior (`user.request_file` round-trip, `user.push_file`, attachment upload).

**Architecture:** Reuses Plan 2's chat UI verbatim; the difference is purely transport. A new `RelayClient` Rust module (host) opens a WSS to mdrelay using `device_token` and pumps frames between mdrelay and the local UDS. A new `RemoteClient` Rust module (remote) opens a WSS to mdrelay and exposes the same `tx_to_server` / `event_rx` interface as `uds_client::UdsClient`, so the chat UI layer is unchanged. Pairing uses two new Tauri commands (`openclaw_pair_create`, `openclaw_pair_claim`). Devices settings live alongside the openclaw settings tab from Plan 2.

**Tech Stack:** Same Rust + tokio stack; adds `tokio-tungstenite` (or `tungstenite` over `tokio::net::TcpStream`) for WSS client. Existing `tauri-plugin-http` provides a vetted reqwest for the HTTP pair endpoints. Svelte 5 runes for UI.

**Spec:** `mdeditor/docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md` (commit `9f31934`). Sections 1.1 (remote branch), 3 (mdrelay protocol — consumer), 4.4 (web mode), 4.5 (attachments), 5.1-5.4 (Devices, sessions).

**Depends on:** Plan 1 (host UDS), Plan 2 (chat UI + host mode shell), Plan 3 (mdrelay worker). All three must be runnable end-to-end before this plan's last task.

---

## File Structure

All paths relative to `/Users/bruce/git/mdeditor/`:

| Path | Responsibility |
|---|---|
| `src-tauri/Cargo.toml` | Add `tokio-tungstenite`, `tokio-rustls`, `reqwest` deps |
| `src-tauri/src/openclaw/relay_client.rs` | WSS client core; same event/send interface as `uds_client` |
| `src-tauri/src/openclaw/relay_bridge.rs` | Host-side: fans UDS frames out to mdrelay WS as host role + back |
| `src-tauri/src/openclaw/pair.rs` | HTTP calls to mdrelay `/pair/create`, `/pair/claim`, `/device/revoke`, `/device/pending-claims` |
| `src-tauri/src/openclaw/devices.rs` | Persistent device list (settings.json key `openclaw.devices`) |
| `src-tauri/src/openclaw/commands.rs` | Modify: add `openclaw_pair_create`, `openclaw_pair_claim`, `openclaw_revoke_device`, `openclaw_list_devices`, `openclaw_request_file`, `openclaw_push_file`, `openclaw_upload_attachment` |
| `src-tauri/src/openclaw/state.rs` | Modify: hold either `UdsClient` (host) **or** `RelayClient` (remote); pending-claims poller task |
| `src/lib/openclaw/client.svelte.ts` | Modify: emit `agent.file_content` to a per-session "read-only tab" channel |
| `src/lib/openclaw/links.ts` | Modify: web-mode path opens via host file request |
| `src/lib/openclaw/devices.svelte.ts` | Reactive device list state |
| `src/lib/openclaw/pair.ts` | TS wrappers for pair commands |
| `src/components/chat/PairingDialog.svelte` | Host: shows QR + code; Remote: input field |
| `src/components/chat/PendingClaimToast.svelte` | Host: "new device wants to connect — allow / reject" |
| `src/components/chat/AttachmentUpload.svelte` | Web-mode attachment picker (and used by host too) |
| `src/components/chat/Composer.svelte` | Modify: integrate attachment upload |
| `src/components/OpenClawDevicesTab.svelte` | Devices list + Add / Revoke / Forget buttons |
| `src/components/SettingsDialog.svelte` | Modify: add Devices sub-tab under OpenClaw |
| `tests/svelte/PairingDialog.test.ts` | Component test |

---

## Task 1: Add WSS client deps

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml` `[dependencies]`:

```toml
tokio-tungstenite = { version = "0.24", default-features = false, features = ["rustls-tls-webpki-roots", "connect"] }
futures-util = "0.3"
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json"] }
url = "2"
qrcode = { version = "0.14", default-features = false, features = ["svg"] }
```

> `reqwest` is already transitively included via `tauri-plugin-http`, but declaring directly with the features we need keeps the dep graph predictable.

- [ ] **Step 2: Compile**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo check
```
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri/Cargo.toml && git commit -m "feat(chat): add wss + http deps for remote mode"
```

---

## Task 2: HTTP pairing module

**Files:**
- Create: `src-tauri/src/openclaw/pair.rs`

- [ ] **Step 1: Write failing test**

```rust
// src-tauri/src/openclaw/pair.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_pair_parses_response() {
        // We don't hit the real worker here; instead unit-test parsing.
        let payload = r#"{"code":"abc-def-012-345-678-9ab","pairingId":"p-deadbeefcafebabe","expiresAt":1234567}"#;
        let parsed: PairCreateResponse = serde_json::from_str(payload).unwrap();
        assert_eq!(parsed.code, "abc-def-012-345-678-9ab");
        assert!(parsed.pairing_id.starts_with("p-"));
    }
}
```

- [ ] **Step 2: Implement `pair.rs`**

```rust
// src-tauri/src/openclaw/pair.rs
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct PairCreateResponse {
    pub code: String,
    #[serde(rename = "pairingId")]
    pub pairing_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

#[derive(Debug, Deserialize)]
pub struct PairClaimResponse {
    #[serde(rename = "device_token")]
    pub device_token: String,
    #[serde(rename = "pairingId")]
    pub pairing_id: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
pub struct HostBootstrapResponse {
    #[serde(rename = "device_token")]
    pub device_token: String,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct PendingClaim {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub hostname: String,
    pub at: u64,
}

pub async fn pair_create(relay_url: &str) -> Result<PairCreateResponse, String> {
    let url = format!("{}/pair/create", relay_url.trim_end_matches('/'));
    let resp = Client::new().post(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("status {}", resp.status())); }
    resp.json::<PairCreateResponse>().await.map_err(|e| e.to_string())
}

pub async fn pair_claim(relay_url: &str, code: &str, hostname: &str) -> Result<PairClaimResponse, String> {
    let url = format!("{}/pair/claim", relay_url.trim_end_matches('/'));
    let resp = Client::new()
        .post(&url)
        .json(&serde_json::json!({ "code": code, "hostname": hostname }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("status {}", resp.status())); }
    resp.json::<PairClaimResponse>().await.map_err(|e| e.to_string())
}

pub async fn host_bootstrap(relay_url: &str, pairing_id: &str) -> Result<HostBootstrapResponse, String> {
    let url = format!("{}/pair/host-bootstrap", relay_url.trim_end_matches('/'));
    let resp = Client::new()
        .post(&url)
        .json(&serde_json::json!({ "pairingId": pairing_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("status {}", resp.status())); }
    resp.json::<HostBootstrapResponse>().await.map_err(|e| e.to_string())
}

pub async fn revoke_device(relay_url: &str, host_token: &str, device_id: &str) -> Result<(), String> {
    let url = format!("{}/device/revoke", relay_url.trim_end_matches('/'));
    let resp = Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {}", host_token))
        .json(&serde_json::json!({ "deviceId": device_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() { Ok(()) } else { Err(format!("status {}", resp.status())) }
}

pub async fn pending_claims(relay_url: &str, host_token: &str) -> Result<Vec<PendingClaim>, String> {
    let url = format!("{}/device/pending-claims", relay_url.trim_end_matches('/'));
    let resp = Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", host_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("status {}", resp.status())); }
    resp.json::<Vec<PendingClaim>>().await.map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register module**

In `src-tauri/src/openclaw/mod.rs`, add:
```rust
pub mod pair;
pub mod relay_client;     // Task 3
pub mod relay_bridge;     // Task 4
pub mod devices;          // Task 6
```

(Comment out modules not yet created; uncomment as you go.)

- [ ] **Step 4: Run unit test**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo test openclaw::pair
```
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri && git commit -m "feat(chat): http pairing module"
```

---

## Task 3: Relay WSS client (shared by host bridge + remote)

**Files:**
- Create: `src-tauri/src/openclaw/relay_client.rs`

- [ ] **Step 1: Implement WSS client core**

```rust
// src-tauri/src/openclaw/relay_client.rs
use std::sync::Arc;
use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use super::protocol::Frame;

/// Envelope as understood by mdrelay (Plan 3 wire spec).
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct Envelope {
    pub to: String,    // "host" | "remote:<id>" | "broadcast"
    pub from: String,  // "host" | "remote:<id>"
    #[serde(flatten)]
    pub frame: Frame,
}

#[derive(Debug, Clone)]
pub enum RelayEvent {
    Connecting,
    Connected,
    Disconnected(String),
    Envelope(Envelope),
    Error(String),
}

pub struct RelayClient {
    pub tx_send: mpsc::Sender<Envelope>,
    pub event_rx: Arc<Mutex<mpsc::Receiver<RelayEvent>>>,
}

pub fn spawn(relay_url: String, role: &'static str, device_token: String) -> RelayClient {
    let (tx_send, mut rx_send) = mpsc::channel::<Envelope>(32);
    let (event_tx, event_rx) = mpsc::channel::<RelayEvent>(64);

    tokio::spawn(async move {
        let mut delay = Duration::from_millis(500);
        loop {
            let _ = event_tx.send(RelayEvent::Connecting).await;
            let ws_url = format!("{}/ws/{}?token={}",
                relay_url.trim_end_matches('/').replace("http://", "ws://").replace("https://", "wss://"),
                role,
                urlencoding::encode(&device_token));
            let url = match Url::parse(&ws_url) {
                Ok(u) => u,
                Err(e) => { let _ = event_tx.send(RelayEvent::Error(e.to_string())).await; tokio::time::sleep(delay).await; continue; }
            };

            match connect_async(url.as_str()).await {
                Ok((mut socket, _resp)) => {
                    delay = Duration::from_millis(500);
                    let _ = event_tx.send(RelayEvent::Connected).await;

                    loop {
                        tokio::select! {
                            outgoing = rx_send.recv() => {
                                match outgoing {
                                    Some(env) => {
                                        let s = match serde_json::to_string(&env) {
                                            Ok(s) => s,
                                            Err(e) => { let _ = event_tx.send(RelayEvent::Error(e.to_string())).await; continue; }
                                        };
                                        if socket.send(Message::Text(s)).await.is_err() { break; }
                                    }
                                    None => return, // channel closed; client shutting down
                                }
                            }
                            incoming = socket.next() => {
                                match incoming {
                                    Some(Ok(Message::Text(t))) => {
                                        match serde_json::from_str::<Envelope>(&t) {
                                            Ok(env) => { let _ = event_tx.send(RelayEvent::Envelope(env)).await; }
                                            Err(e) => { let _ = event_tx.send(RelayEvent::Error(format!("envelope parse: {}", e))).await; }
                                        }
                                    }
                                    Some(Ok(Message::Close(_))) | None => break,
                                    Some(Ok(_)) => { /* ignore other types */ }
                                    Some(Err(e)) => { let _ = event_tx.send(RelayEvent::Error(e.to_string())).await; break; }
                                }
                            }
                        }
                    }

                    let _ = event_tx.send(RelayEvent::Disconnected("eof".into())).await;
                }
                Err(e) => {
                    let _ = event_tx.send(RelayEvent::Error(format!("connect: {}", e))).await;
                }
            }

            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(60));
        }
    });

    RelayClient { tx_send, event_rx: Arc::new(Mutex::new(event_rx)) }
}
```

- [ ] **Step 2: Add `urlencoding` dep**

```toml
urlencoding = "2"
```

- [ ] **Step 3: Compile**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo check
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri && git commit -m "feat(chat): wss relay client with reconnect"
```

---

## Task 4: Host-side relay bridge

**Files:**
- Create: `src-tauri/src/openclaw/relay_bridge.rs`

- [ ] **Step 1: Implement the bridge**

```rust
// src-tauri/src/openclaw/relay_bridge.rs
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::protocol::Frame;
use super::relay_client::{spawn as spawn_relay, RelayClient, RelayEvent, Envelope};
use super::uds_client::UdsClient;

/// On the host machine: takes the existing UDS client and an mdrelay endpoint,
/// pumps:
///   - frames from UDS → wrap as Envelope { to: "broadcast", from: "host" } → relay
///   - envelopes from relay → unwrap → push into UDS as if a local message
pub struct RelayBridge {
    pub client: Arc<RelayClient>,
}

pub fn spawn(app: AppHandle, uds: Arc<UdsClient>, relay_url: String, host_token: String) -> RelayBridge {
    let client = Arc::new(spawn_relay(relay_url, "host", host_token));

    // Pipe: UDS frames (events) → relay envelopes broadcast.
    let uds_for_outbound = uds.clone();
    let relay_for_outbound = client.clone();
    tokio::spawn(async move {
        loop {
            let mut rx = uds_for_outbound.event_rx.lock().await;
            match rx.recv().await {
                Some(crate::openclaw::uds_client::UdsEvent::Frame(f)) => {
                    let env = Envelope { to: "broadcast".into(), from: "host".into(), frame: f };
                    let _ = relay_for_outbound.tx_send.send(env).await;
                }
                Some(_) => {}
                None => break,
            }
        }
    });

    // Pipe: relay envelopes (incoming from remote) → UDS frames.
    let uds_for_inbound = uds.clone();
    let app_for_inbound = app.clone();
    let event_rx = client.event_rx.clone();
    tokio::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(RelayEvent::Envelope(env)) => {
                    // Only forward envelopes addressed to host (or broadcast).
                    if env.to == "host" || env.to == "broadcast" {
                        let _ = uds_for_inbound.tx_to_server.send(env.frame).await;
                    }
                }
                Some(RelayEvent::Connected) => { let _ = app_for_inbound.emit("openclaw://relay-status", "connected"); }
                Some(RelayEvent::Connecting) => { let _ = app_for_inbound.emit("openclaw://relay-status", "connecting"); }
                Some(RelayEvent::Disconnected(r)) => { let _ = app_for_inbound.emit("openclaw://relay-status", format!("disconnected:{}", r)); }
                Some(RelayEvent::Error(e)) => { let _ = app_for_inbound.emit("openclaw://relay-error", e); }
                None => break,
            }
        }
    });

    RelayBridge { client }
}
```

- [ ] **Step 2: Wire bridge startup into `state.rs` / `commands.rs`**

In `commands.rs`, after host UDS is up (`openclaw_connect` host branch), additionally:

```rust
// If user has configured a relay and stored a host_token, spawn the bridge.
let cfg = state.config.lock().await.clone();
if let (Some(relay_url), Some(host_tok)) = (cfg.relay_url.clone(), cfg.host_token.clone()) {
    let bridge = crate::openclaw::relay_bridge::spawn(app.clone(), Arc::new(client.clone()), relay_url, host_tok);
    *state.bridge.lock().await = Some(bridge);
}
```

> `UdsClient` needs to be `Clone` so both the bridge and `Backend::Host` can hold a handle. `event_rx` is already `Arc<Mutex<...>>` and `tx_to_server` is `mpsc::Sender` (both cheaply cloneable). Add to `uds_client.rs`:
>
> ```rust
> impl Clone for UdsClient {
>     fn clone(&self) -> Self {
>         Self {
>             tx_to_server: self.tx_to_server.clone(),
>             event_rx: self.event_rx.clone(),
>         }
>     }
> }
> ```
>
> Likewise add `impl Clone for RelayClient { ... }` mirroring this in `relay_client.rs`.

And add `host_token: Option<String>` and `relay_url: Option<String>` to `OpenClawConfig` (`config.rs`); read from settings `openclaw.hostToken` / already-have `openclaw.relayUrl`.

Also extend `OpenClawState` with `bridge: Mutex<Option<RelayBridge>>`.

- [ ] **Step 3: Compile**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo check
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri && git commit -m "feat(chat): host-side relay bridge wiring uds<->mdrelay"
```

---

## Task 5: Remote mode connect path

**Files:**
- Modify: `src-tauri/src/openclaw/commands.rs`
- Modify: `src-tauri/src/openclaw/state.rs`

- [ ] **Step 1: Add a `RemoteClient` shim that mimics `UdsClient`'s shape**

In `state.rs`, change the `uds` field to a union-like enum:

```rust
pub enum Backend {
    None,
    Host(UdsClient),
    Remote(RelayClient),
}

pub struct OpenClawState {
    pub config: Mutex<OpenClawConfig>,
    pub backend: Mutex<Backend>,
    pub bridge: Mutex<Option<RelayBridge>>,
    pub claim_poller: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
```

- [ ] **Step 2: Extend `openclaw_connect` to handle remote mode**

In `commands.rs`:

```rust
#[tauri::command]
pub async fn openclaw_connect(app: AppHandle) -> Result<String, String> {
    use crate::openclaw::config::ConnectMode;
    let state = app.state::<Arc<OpenClawState>>();
    let cfg = state.config.lock().await.clone();
    let mode = match cfg.mode {
        ConnectMode::Auto => if cfg.socket_path.exists() { ConnectMode::Host } else { ConnectMode::Remote },
        m => m,
    };

    match mode {
        ConnectMode::Host => {
            let token = cfg.access_token.clone().ok_or("no access token")?;
            let client = crate::openclaw::uds_client::spawn(cfg.socket_path.clone(), token);
            forward_uds_events(app.clone(), client.clone());
            *state.backend.lock().await = Backend::Host(client.clone());
            if let (Some(url), Some(tok)) = (cfg.relay_url.clone(), cfg.host_token.clone()) {
                let bridge = crate::openclaw::relay_bridge::spawn(app.clone(), Arc::new(client), url, tok);
                *state.bridge.lock().await = Some(bridge);
            }
            Ok("host".into())
        }
        ConnectMode::Remote => {
            let url = cfg.relay_url.clone().ok_or("no relay URL")?;
            let token = cfg.device_token.clone().ok_or("not paired — open Devices to pair")?;
            let client = crate::openclaw::relay_client::spawn(url, "remote", token);
            forward_relay_events(app.clone(), client.clone());
            *state.backend.lock().await = Backend::Remote(client);
            Ok("remote".into())
        }
        _ => Err("auto resolved to unknown".into()),
    }
}
```

Forwarders:

```rust
fn forward_uds_events(app: AppHandle, client: UdsClient) {
    let event_rx = client.event_rx.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(UdsEvent::Connected) => { let _ = app.emit("openclaw://status", "connected"); }
                Some(UdsEvent::Connecting) => { let _ = app.emit("openclaw://status", "connecting"); }
                Some(UdsEvent::Disconnected(r)) => { let _ = app.emit("openclaw://status", format!("disconnected:{}", r)); }
                Some(UdsEvent::Error(e)) => { let _ = app.emit("openclaw://error", e); }
                Some(UdsEvent::Frame(f)) => { let _ = app.emit("openclaw://frame", f); }
                None => break,
            }
        }
    });
}

fn forward_relay_events(app: AppHandle, client: RelayClient) {
    let event_rx = client.event_rx.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(RelayEvent::Connected) => { let _ = app.emit("openclaw://status", "connected"); }
                Some(RelayEvent::Connecting) => { let _ = app.emit("openclaw://status", "connecting"); }
                Some(RelayEvent::Disconnected(r)) => { let _ = app.emit("openclaw://status", format!("disconnected:{}", r)); }
                Some(RelayEvent::Error(e)) => { let _ = app.emit("openclaw://error", e); }
                Some(RelayEvent::Envelope(env)) => {
                    if env.to == "remote" || env.to.starts_with("remote:") || env.to == "broadcast" {
                        let _ = app.emit("openclaw://frame", env.frame);
                    }
                }
                None => break,
            }
        }
    });
}
```

- [ ] **Step 3: Update `openclaw_send` to dispatch correctly**

```rust
#[tauri::command]
pub async fn openclaw_send(app: AppHandle, frame: Frame) -> Result<(), String> {
    let state = app.state::<Arc<OpenClawState>>();
    let guard = state.backend.lock().await;
    match &*guard {
        Backend::Host(c) => c.tx_to_server.send(frame).await.map_err(|e| e.to_string()),
        Backend::Remote(c) => {
            let env = Envelope { to: "host".into(), from: format!("remote:self"), frame };
            c.tx_send.send(env).await.map_err(|e| e.to_string())
        }
        Backend::None => Err("not connected".into()),
    }
}
```

Add `device_token: Option<String>` to `OpenClawConfig`; read from `openclaw.deviceToken`.

- [ ] **Step 4: Compile**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo check
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri && git commit -m "feat(chat): unified host/remote backend with single send command"
```

---

## Task 6: Devices module + persistence

**Files:**
- Create: `src-tauri/src/openclaw/devices.rs`

- [ ] **Step 1: Implement device list storage**

```rust
// src-tauri/src/openclaw/devices.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub device_id: String,
    pub hostname: String,
    pub status: DeviceStatus,
    pub last_seen: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus { Active, Revoked }

pub fn read_all(app: &tauri::AppHandle) -> Vec<Device> {
    use tauri_plugin_store::StoreExt;
    let store = match app.store("settings.json") { Ok(s) => s, Err(_) => return vec![] };
    store.get("openclaw.devices")
        .and_then(|v| serde_json::from_value::<Vec<Device>>(v).ok())
        .unwrap_or_default()
}

pub fn write_all(app: &tauri::AppHandle, devices: &[Device]) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set("openclaw.devices".to_string(), serde_json::to_value(devices).map_err(|e| e.to_string())?);
    Ok(())
}

pub fn upsert(app: &tauri::AppHandle, d: Device) -> Result<(), String> {
    let mut all = read_all(app);
    if let Some(existing) = all.iter_mut().find(|x| x.device_id == d.device_id) {
        *existing = d;
    } else {
        all.push(d);
    }
    write_all(app, &all)
}

pub fn set_status(app: &tauri::AppHandle, device_id: &str, status: DeviceStatus) -> Result<(), String> {
    let mut all = read_all(app);
    if let Some(d) = all.iter_mut().find(|x| x.device_id == device_id) {
        d.status = status;
    }
    write_all(app, &all)
}

pub fn forget(app: &tauri::AppHandle, device_id: &str) -> Result<(), String> {
    let mut all = read_all(app);
    all.retain(|d| d.device_id != device_id);
    write_all(app, &all)
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri && git commit -m "feat(chat): devices module with persistence"
```

---

## Task 7: Pairing commands + pending-claim poller

**Files:**
- Modify: `src-tauri/src/openclaw/commands.rs`

- [ ] **Step 1: Add pairing commands**

```rust
use crate::openclaw::devices::{Device, DeviceStatus};

#[derive(serde::Serialize)]
pub struct PairCreateOut {
    pub code: String,
    pub pairing_id: String,
    pub expires_at: u64,
    pub qr_svg: String,
}

#[tauri::command]
pub async fn openclaw_pair_create(app: AppHandle) -> Result<PairCreateOut, String> {
    use qrcode::QrCode;
    let cfg = {
        let state = app.state::<Arc<OpenClawState>>();
        state.config.lock().await.clone()
    };
    let url = cfg.relay_url.ok_or("relay URL not configured")?;
    let create = crate::openclaw::pair::pair_create(&url).await?;
    // Also bootstrap host token + persist.
    let host = crate::openclaw::pair::host_bootstrap(&url, &create.pairing_id).await?;
    persist_setting(&app, "openclaw.hostToken", &host.device_token)?;
    persist_setting(&app, "openclaw.pairingId", &create.pairing_id)?;
    let qr = QrCode::new(create.code.as_bytes()).map_err(|e| e.to_string())?;
    let qr_svg = qr.render::<qrcode::render::svg::Color>().build();
    Ok(PairCreateOut { code: create.code, pairing_id: create.pairing_id, expires_at: create.expires_at, qr_svg })
}

#[derive(serde::Serialize)]
pub struct PairClaimOut {
    pub pairing_id: String,
    pub device_id: String,
}

#[tauri::command]
pub async fn openclaw_pair_claim(app: AppHandle, code: String, hostname: Option<String>) -> Result<PairClaimOut, String> {
    let cfg = {
        let state = app.state::<Arc<OpenClawState>>();
        state.config.lock().await.clone()
    };
    let url = cfg.relay_url.ok_or("relay URL not configured")?;
    let host_name = hostname.unwrap_or_else(|| {
        gethostname::gethostname().to_string_lossy().to_string()
    });
    let claim = crate::openclaw::pair::pair_claim(&url, &code, &host_name).await?;
    persist_setting(&app, "openclaw.deviceToken", &claim.device_token)?;
    persist_setting(&app, "openclaw.pairingId", &claim.pairing_id)?;
    persist_setting(&app, "openclaw.deviceId", &claim.device_id)?;
    Ok(PairClaimOut { pairing_id: claim.pairing_id, device_id: claim.device_id })
}

#[tauri::command]
pub async fn openclaw_revoke_device(app: AppHandle, device_id: String) -> Result<(), String> {
    let cfg = {
        let state = app.state::<Arc<OpenClawState>>();
        state.config.lock().await.clone()
    };
    let url = cfg.relay_url.ok_or("relay URL not configured")?;
    let host_tok = cfg.host_token.ok_or("not the host")?;
    crate::openclaw::pair::revoke_device(&url, &host_tok, &device_id).await?;
    crate::openclaw::devices::set_status(&app, &device_id, DeviceStatus::Revoked)?;
    Ok(())
}

#[tauri::command]
pub async fn openclaw_forget_device(app: AppHandle, device_id: String) -> Result<(), String> {
    crate::openclaw::devices::forget(&app, &device_id)
}

#[tauri::command]
pub async fn openclaw_list_devices(app: AppHandle) -> Vec<Device> {
    crate::openclaw::devices::read_all(&app)
}

#[tauri::command]
pub async fn openclaw_approve_pending(app: AppHandle, device_id: String, hostname: String) -> Result<(), String> {
    crate::openclaw::devices::upsert(&app, Device {
        device_id,
        hostname,
        status: DeviceStatus::Active,
        last_seen: None,
    })
}

#[tauri::command]
pub async fn openclaw_reject_pending(app: AppHandle, device_id: String) -> Result<(), String> {
    openclaw_revoke_device(app, device_id).await
}

fn persist_setting(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set(key.to_string(), serde_json::Value::String(value.to_string()));
    Ok(())
}
```

Add `gethostname = "0.5"` to `Cargo.toml`.

- [ ] **Step 2: Add pending-claim poller**

In `state.rs` add:

```rust
pub fn spawn_claim_poller(app: tauri::AppHandle, state: Arc<OpenClawState>) {
    tauri::async_runtime::spawn(async move {
        let mut handle = state.claim_poller.lock().await;
        if handle.is_some() { return; }
        let task = tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                let cfg = state.config.lock().await.clone();
                let url = match &cfg.relay_url { Some(u) => u.clone(), None => continue };
                let tok = match &cfg.host_token { Some(t) => t.clone(), None => continue };
                if let Ok(claims) = crate::openclaw::pair::pending_claims(&url, &tok).await {
                    for c in claims {
                        let _ = app.emit("openclaw://pending-claim", c);
                    }
                }
            }
        });
        *handle = Some(task);
    });
}
```

Call `spawn_claim_poller` after host connect in `openclaw_connect`.

- [ ] **Step 3: Register all new commands in `lib.rs` generate_handler!**

Append:
```rust
crate::openclaw::commands::openclaw_pair_create,
crate::openclaw::commands::openclaw_pair_claim,
crate::openclaw::commands::openclaw_revoke_device,
crate::openclaw::commands::openclaw_forget_device,
crate::openclaw::commands::openclaw_list_devices,
crate::openclaw::commands::openclaw_approve_pending,
crate::openclaw::commands::openclaw_reject_pending,
```

- [ ] **Step 4: Compile**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo check
```

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src-tauri && git commit -m "feat(chat): pairing commands + pending claim poller"
```

---

## Task 8: TS wrappers for pairing & devices

**Files:**
- Create: `src/lib/openclaw/pair.ts`
- Create: `src/lib/openclaw/devices.svelte.ts`

- [ ] **Step 1: Write `pair.ts`**

```typescript
// src/lib/openclaw/pair.ts
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnsubscribeFn } from '@tauri-apps/api/event'

export interface PairCreateOut { code: string; pairing_id: string; expires_at: number; qr_svg: string }
export interface PairClaimOut { pairing_id: string; device_id: string }
export interface PendingClaim { device_id: string; hostname: string; at: number }

export const pairCreate = (): Promise<PairCreateOut> => invoke('openclaw_pair_create')
export const pairClaim  = (code: string, hostname?: string): Promise<PairClaimOut> => invoke('openclaw_pair_claim', { code, hostname })
export const revokeDevice = (deviceId: string): Promise<void> => invoke('openclaw_revoke_device', { deviceId })
export const forgetDevice = (deviceId: string): Promise<void> => invoke('openclaw_forget_device', { deviceId })
export const approveClaim = (deviceId: string, hostname: string): Promise<void> => invoke('openclaw_approve_pending', { deviceId, hostname })
export const rejectClaim  = (deviceId: string): Promise<void> => invoke('openclaw_reject_pending', { deviceId })

export const onPendingClaim = (cb: (c: PendingClaim) => void): Promise<UnsubscribeFn> =>
  listen<PendingClaim>('openclaw://pending-claim', (e) => cb(e.payload))
```

- [ ] **Step 2: Write `devices.svelte.ts`**

```typescript
// src/lib/openclaw/devices.svelte.ts
import { invoke } from '@tauri-apps/api/core'

export interface Device {
  device_id: string
  hostname: string
  status: 'active' | 'revoked'
  last_seen: number | null
}

export const devicesState = $state({
  list: [] as Device[],
  loading: false,
})

export async function refresh(): Promise<void> {
  devicesState.loading = true
  try {
    devicesState.list = await invoke<Device[]>('openclaw_list_devices')
  } finally {
    devicesState.loading = false
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src/lib/openclaw && git commit -m "feat(chat): ts wrappers for pair + device list"
```

---

## Task 9: PairingDialog component (host side)

**Files:**
- Create: `src/components/chat/PairingDialog.svelte`

- [ ] **Step 1: Write component**

```svelte
<!-- src/components/chat/PairingDialog.svelte -->
<script lang="ts">
  import { pairCreate, type PairCreateOut } from '../../lib/openclaw/pair'

  let { onClose }: { onClose: () => void } = $props()
  let data: PairCreateOut | null = $state(null)
  let err: string | null = $state(null)
  let remaining = $state(120)
  let timer: ReturnType<typeof setInterval> | null = null

  async function create() {
    try {
      data = await pairCreate()
      remaining = Math.max(0, Math.floor((data.expires_at - Date.now()) / 1000))
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        remaining = Math.max(0, remaining - 1)
        if (remaining === 0 && timer) clearInterval(timer)
      }, 1000)
    } catch (e) { err = String(e) }
  }

  $effect(() => { create(); return () => { if (timer) clearInterval(timer) } })
</script>

<div class="overlay" onclick={onClose}>
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    <h2>Add a new device</h2>
    {#if err}
      <p class="err">{err}</p>
      <button onclick={create}>Retry</button>
    {:else if !data}
      <p>Generating pairing code…</p>
    {:else}
      <div class="qr">{@html data.qr_svg}</div>
      <p class="code">{data.code}</p>
      <p class="hint">Expires in {String(Math.floor(remaining/60)).padStart(2,'0')}:{String(remaining%60).padStart(2,'0')}</p>
    {/if}
    <button onclick={onClose}>Cancel</button>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
  .dialog { background: white; padding: 1.5rem; border-radius: 8px; min-width: 340px; max-width: 460px; text-align: center; }
  .qr :global(svg) { width: 220px; height: 220px; }
  .code { font-family: ui-monospace, monospace; font-size: 1.25rem; letter-spacing: 0.05em; margin: 0.5rem 0; }
  .hint { color: #777; font-size: 0.85rem; }
  .err { color: #b91c1c; }
  button { margin-top: 1rem; padding: 0.4rem 0.8rem; border: 1px solid #d1d5db; background: white; border-radius: 6px; cursor: pointer; }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src/components && git commit -m "feat(chat): pairing dialog component"
```

---

## Task 10: PendingClaimToast (host side)

**Files:**
- Create: `src/components/chat/PendingClaimToast.svelte`
- Modify: `src/chat-app.svelte` (mount the toast listener)

- [ ] **Step 1: Write component**

```svelte
<!-- src/components/chat/PendingClaimToast.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { onPendingClaim, approveClaim, rejectClaim, type PendingClaim } from '../../lib/openclaw/pair'
  import { refresh } from '../../lib/openclaw/devices.svelte'

  let pending = $state<PendingClaim[]>([])

  onMount(() => {
    let unsub: (() => void) | null = null
    onPendingClaim((c) => { pending = [...pending, c] }).then((u) => unsub = u)
    return () => { unsub?.() }
  })

  async function allow(c: PendingClaim) {
    await approveClaim(c.device_id, c.hostname)
    await refresh()
    pending = pending.filter((p) => p.device_id !== c.device_id)
  }
  async function reject(c: PendingClaim) {
    await rejectClaim(c.device_id)
    await refresh()
    pending = pending.filter((p) => p.device_id !== c.device_id)
  }
</script>

{#each pending as c (c.device_id)}
  <div class="toast">
    <div>New device wants to connect: <b>{c.hostname}</b></div>
    <div class="actions">
      <button onclick={() => allow(c)}>Allow</button>
      <button onclick={() => reject(c)}>Reject</button>
    </div>
  </div>
{/each}

<style>
  .toast { position: fixed; right: 1rem; top: 1rem; background: #fff; padding: 0.75rem 1rem; border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); z-index: 900; }
  .actions { margin-top: 0.5rem; display: flex; gap: 0.5rem; justify-content: flex-end; }
  button { padding: 0.25rem 0.75rem; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; }
</style>
```

- [ ] **Step 2: Mount it in `chat-app.svelte`**

Add to the chat app top-level:
```svelte
<PendingClaimToast />
```

with the import.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src && git commit -m "feat(chat): pending claim toast"
```

---

## Task 11: Remote onboarding flow

**Files:**
- Create: `src/components/chat/RemoteOnboarding.svelte`
- Modify: `src/chat-app.svelte`

- [ ] **Step 1: Build the onboarding card**

```svelte
<!-- src/components/chat/RemoteOnboarding.svelte -->
<script lang="ts">
  import { pairClaim } from '../../lib/openclaw/pair'

  let { onComplete }: { onComplete: () => void } = $props()
  let code = $state('')
  let hostname = $state('')
  let busy = $state(false)
  let err: string | null = $state(null)

  async function submit() {
    busy = true; err = null
    try {
      await pairClaim(code, hostname || undefined)
      onComplete()
    } catch (e) {
      err = String(e)
    } finally { busy = false }
  }
</script>

<section class="onboard">
  <h2>Connect to your OpenClaw</h2>
  <p>Enter the pairing code shown on your host machine's M↓ settings.</p>
  <label>Pairing code
    <input bind:value={code} placeholder="abc-def-012-345-678-9ab" />
  </label>
  <label>Device name (optional)
    <input bind:value={hostname} placeholder="my-laptop" />
  </label>
  {#if err}<p class="err">{err}</p>{/if}
  <button disabled={busy || code.length < 23} onclick={submit}>{busy ? 'Connecting…' : 'Pair'}</button>
</section>

<style>
  .onboard { max-width: 360px; margin: 4rem auto; padding: 1.5rem; border: 1px solid #e5e7eb; border-radius: 8px; }
  label { display: block; margin: 0.75rem 0; }
  input { width: 100%; padding: 0.4rem; }
  .err { color: #b91c1c; }
  button { width: 100%; padding: 0.5rem; background: #2563eb; color: white; border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { background: #9ca3af; }
</style>
```

- [ ] **Step 2: Show onboarding when no device_token persisted**

In `chat-app.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte'
  import { start, stop, state as oc } from './lib/openclaw/client.svelte'
  import { invoke } from '@tauri-apps/api/core'
  import RemoteOnboarding from './components/chat/RemoteOnboarding.svelte'
  // ... existing imports ...

  let mode = $state<'detecting' | 'host' | 'remote' | 'needs-pairing'>('detecting')

  async function init() {
    try {
      const m = await start()  // start now returns the resolved mode string
      mode = m === 'host' ? 'host' : 'remote'
    } catch (e: any) {
      if (String(e).includes('not paired')) mode = 'needs-pairing'
      else mode = 'remote'
    }
  }

  onMount(() => { init(); return () => stop() })
</script>

{#if mode === 'detecting'}
  <p>Detecting…</p>
{:else if mode === 'needs-pairing'}
  <RemoteOnboarding onComplete={() => init()} />
{:else}
  <SessionPicker />
  <MessageList />
  <Composer />
  <PendingClaimToast />
{/if}
```

Update `start()` in `client.svelte.ts` to return the result of `connect()` instead of `void`.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src && git commit -m "feat(chat): remote onboarding flow"
```

---

## Task 12: Devices settings tab

**Files:**
- Create: `src/components/OpenClawDevicesTab.svelte`
- Modify: `src/components/SettingsDialog.svelte`

- [ ] **Step 1: Build the tab**

```svelte
<!-- src/components/OpenClawDevicesTab.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { devicesState, refresh } from '../lib/openclaw/devices.svelte'
  import { revokeDevice, forgetDevice } from '../lib/openclaw/pair'

  let showAdd = $state(false)

  onMount(() => { refresh() })

  function fmtLastSeen(ts: number | null): string {
    if (!ts) return 'never'
    const d = Date.now() - ts
    if (d < 60_000) return 'just now'
    if (d < 3_600_000) return Math.floor(d / 60_000) + 'm ago'
    if (d < 86_400_000) return Math.floor(d / 3_600_000) + 'h ago'
    return Math.floor(d / 86_400_000) + 'd ago'
  }
</script>

<section>
  <h3>Devices</h3>
  <table>
    <thead>
      <tr><th></th><th>Hostname</th><th>Last seen</th><th></th></tr>
    </thead>
    <tbody>
      {#each devicesState.list as d (d.device_id)}
        <tr>
          <td>{d.status === 'active' ? '●' : '○'}</td>
          <td>{d.hostname}</td>
          <td>{fmtLastSeen(d.last_seen)}</td>
          <td>
            {#if d.status === 'active'}
              <button onclick={async () => { await revokeDevice(d.device_id); await refresh() }}>Revoke</button>
            {:else}
              <button onclick={async () => { await forgetDevice(d.device_id); await refresh() }}>Forget</button>
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="4" class="empty">No paired devices yet.</td></tr>
      {/each}
    </tbody>
  </table>

  <button class="primary" onclick={() => showAdd = true}>+ Add device</button>
</section>

{#if showAdd}
  {#await import('./chat/PairingDialog.svelte') then mod}
    <svelte:component this={mod.default} onClose={() => { showAdd = false; refresh() }} />
  {/await}
{/if}

<style>
  section { padding: 1rem; max-width: 560px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.5rem; border-bottom: 1px solid #eee; text-align: left; }
  .empty { color: #777; text-align: center; padding: 1rem; }
  button { padding: 0.25rem 0.75rem; border: 1px solid #d1d5db; background: white; border-radius: 4px; cursor: pointer; }
  .primary { background: #2563eb; color: white; border: 0; padding: 0.4rem 1rem; margin-top: 1rem; }
</style>
```

- [ ] **Step 2: Wire into `SettingsDialog.svelte`**

Add a "Devices" sub-tab under OpenClaw, importing `OpenClawDevicesTab`.

- [ ] **Step 3: Smoke test**

Open settings → OpenClaw → Devices. Confirm:
- Empty state shows
- "Add device" opens PairingDialog
- After mocking a claim, the entry appears with hostname and "just now"

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src && git commit -m "feat(chat): devices settings tab"
```

---

## Task 13: Web-mode vault file request/push

**Files:**
- Modify: `src/lib/openclaw/client.svelte.ts`
- Modify: `src/lib/openclaw/links.ts`

- [ ] **Step 1: Handle `agent.file_content` in `client.svelte.ts`**

Replace the `case 'agent.file_content'` (currently empty in Plan 2) with:

```typescript
case 'agent.file_content': {
  // Pop the file open in the editor main window as a "[remote] foo.md" untitled tab.
  void openRemoteFile(f.path, f.content)
  break
}
```

Add a helper:

```typescript
import { invoke } from '@tauri-apps/api/core'

async function openRemoteFile(path: string, content: string): Promise<void> {
  await invoke('editor_open_remote_buffer', { remotePath: path, content })
}
```

- [ ] **Step 2: Add `editor_open_remote_buffer` Tauri command**

In `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
async fn editor_open_remote_buffer(app: tauri::AppHandle, remote_path: String, content: String) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("editor://open-remote-buffer", &serde_json::json!({
            "remote_path": remote_path,
            "content": content
        }));
    }
    Ok(())
}
```

Register in the handler list. In the editor `App.svelte`, listen for `editor://open-remote-buffer` and create an untitled tab with title `[remote] <basename>`, body = content, and mark the tab `readOnly = true` until the user clicks "Push back to host".

- [ ] **Step 3: Update `links.ts` web-mode branch**

(Already wired in Plan 2 to send `user.request_file`. Confirm.) Add a fallback for the case where no current session exists — auto-create one first.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src src-tauri && git commit -m "feat(chat): web-mode vault file request + remote buffer tab"
```

---

## Task 14: Attachment upload (composer wire-up)

**Files:**
- Create: `src/components/chat/AttachmentUpload.svelte`
- Modify: `src/components/chat/Composer.svelte`
- Modify: `src-tauri/src/openclaw/commands.rs`

- [ ] **Step 1: Add `openclaw_upload_attachment` command (host or remote)**

In `commands.rs`:

```rust
#[tauri::command]
pub async fn openclaw_upload_attachment(
    app: AppHandle,
    session: String,
    filename: String,
    bytes_b64: String,
) -> Result<(), String> {
    let frame = Frame::UserAttachUpload {
        session,
        blob_id: format!("b-{}", uuid_like()),
        filename,
        bytes_b64,
    };
    openclaw_send(app, frame).await
}

fn uuid_like() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..12).map(|_| format!("{:x}", rng.gen_range(0..16))).collect()
}
```

Add `Frame::UserAttachUpload` variant to `protocol.rs`:

```rust
#[serde(rename = "user.attach.upload")]
UserAttachUpload { session: String, blob_id: String, filename: String, bytes_b64: String },
```

`rand` is already a transitive dep via mdshare; add to mdeditor's `Cargo.toml` if not present.

- [ ] **Step 2: Build the UI**

```svelte
<!-- src/components/chat/AttachmentUpload.svelte -->
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { state } from '../../lib/openclaw/client.svelte'

  let busy = $state(false)

  async function onChange(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !state.currentSessionId) return
    busy = true
    try {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      const b64 = btoa(String.fromCharCode(...bytes))
      await invoke('openclaw_upload_attachment', { session: state.currentSessionId, filename: file.name, bytesB64: b64 })
    } finally { busy = false; input.value = '' }
  }
</script>

<label class="attach" class:busy>
  <input type="file" onchange={onChange} disabled={busy} hidden />
  📎
</label>

<style>
  .attach { cursor: pointer; padding: 0 0.5rem; font-size: 1.25rem; display: inline-flex; align-items: center; }
  .attach.busy { opacity: 0.5; cursor: progress; }
</style>
```

> Note: this naive base64 path is fine for files up to ~3 MB. Larger files should be chunked per the spec — leave a `TODO` for now if you need it, or add a 5 MB hard cap.

- [ ] **Step 3: Wire into `Composer.svelte`**

```svelte
<script lang="ts">
  import AttachmentUpload from './AttachmentUpload.svelte'
  // ... existing ...
</script>

<form class="composer" onsubmit={submit}>
  <AttachmentUpload />
  <textarea ...></textarea>
  <button type="submit" ...>Send</button>
</form>
```

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add src src-tauri && git commit -m "feat(chat): attachment upload via channel"
```

---

## Task 15: End-to-end manual test (host + remote + relay)

This is the final cross-plan integration test.

- [ ] **Step 1: Verify all three pieces are running**

```bash
# Plan 1 plugin
ls -la ~/.openclaw/mdeditor.sock
node ~/git/openclaw/openclaw.mjs status

# Plan 3 worker
cd /Users/bruce/git/mdeditor/mdrelay && pnpm dev &
sleep 2 && curl http://127.0.0.1:8787/health
```

In M↓ settings → OpenClaw → Relay URL: `ws://127.0.0.1:8787` (or `http://`; the code normalises).

- [ ] **Step 2: Host machine — pair a new device**

In M↓ chat → Settings → Devices → "+ Add device". Take the code that appears.

- [ ] **Step 3: Second device — claim the code**

On the second machine (or a second M↓ instance via `MDEDITOR_DATA_DIR=…`), launch chat. The onboarding card appears (because no UDS sock, no device_token).

Enter the code. Optional hostname "second-laptop". Click Pair.

- [ ] **Step 4: Host machine — approve**

The pending-claim toast pops up. Click Allow.

- [ ] **Step 5: Cross-device message round-trip**

Send a message on the remote → it appears in the host's chat → host sends a reply → it appears on the remote.

- [ ] **Step 6: Vault link (bound mode if local vault configured; web mode otherwise)**

Ask the agent to link to a real file. Click it:
- **Bound**: editor main window opens with that file
- **Web**: editor main window opens with `[remote] <basename>` untitled tab

- [ ] **Step 7: Revoke + verify**

In host settings → Devices → Revoke the remote. The remote's WS should close within ~1s; reconnect attempts now get 403.

- [ ] **Step 8: Network drop**

On the remote, disable Wi-Fi for 30 s. Verify the chat shows "disconnected" and reconnects when Wi-Fi returns.

- [ ] **Step 9: Commit any uncovered fixes**

```bash
cd /Users/bruce/git/mdeditor && git add . && git commit -m "fix(chat): e2e cross-machine integration"
```

---

## Done criteria

- [ ] Two M↓ instances on different machines can pair via mdrelay (or a single machine with two data dirs for simulation)
- [ ] Host can send messages that the remote sees and vice versa, with streaming intact
- [ ] Devices settings page lists active + revoked devices and supports Revoke / Forget
- [ ] Host's pending-claim toast appears when a remote claims a code; Allow / Reject both work
- [ ] Web-mode `[note](./README.md)` click correctly fetches the file from the host and opens a `[remote] README.md` tab
- [ ] Attachment upload reaches the host; host writes it to the configured inbox path (or surfaces it to the agent)
- [ ] Revoking a remote token forces an immediate disconnect; reconnect attempts return 403
- [ ] Network interruption triggers reconnect with exponential backoff (no crashes, no message loss within buffer limits)
- [ ] No public listen sockets on either machine other than (a) the existing M↓ webview + (b) `wrangler dev` (the production Cloudflare deployment is the only "public" endpoint)
- [ ] All work committed in atomic `feat(chat): …` / `test(chat): …` / `fix(chat): …` / `docs(chat): …` commits
