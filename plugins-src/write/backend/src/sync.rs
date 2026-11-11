//! Transport only. Host owns durable outbox/inbox, CRDT application and UI session ordering.
//! Never delete an outbox item until its matching durable acknowledgement is persisted.
pub use sumi_protocol::sync::{AccessToken, Identity, Invitation};
use std::{future::Future, pin::Pin, sync::Arc};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client as HttpClient, Method};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{Message, WebSocketConfig},
    },
    MaybeTlsStream, WebSocketStream,
};
use url::Url;

const MAX_UPDATE: usize = 16_000_000;
pub const MAX_WEBSOCKET_UPDATE: usize = 256_000;
const MAX_SNAPSHOT: usize = 65_000_000;
const MAX_HTTP: usize = 24_000_000;
const MAX_FRAME: usize = 400_000;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    Configuration(&'static str),
    Transport,
    Timeout,
    Api { status: u16, code: String },
    Protocol(&'static str),
    Closed,
}
impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for SyncError {}
type Result<T> = std::result::Result<T, SyncError>;
fn http_error(error: reqwest::Error) -> SyncError {
    if error.is_timeout() {
        SyncError::Timeout
    } else {
        SyncError::Transport
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn endpoint(server: &str, allow_local: bool) -> Result<Url> {
    let mut url = Url::parse(server).map_err(|_| SyncError::Configuration("invalid server URL"))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(allow_local && local && url.scheme() == "http") {
        return Err(SyncError::Configuration("Sumi Write requires HTTPS"));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(SyncError::Configuration(
            "server must be an origin without credentials, path, query or fragment",
        ));
    }
    url.set_path("/");
    Ok(url)
}
pub fn server_origin(server: &str) -> Result<String> { endpoint(server, false).map(|url| url.to_string()) }
fn http_client() -> Result<HttpClient> {
    HttpClient::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| SyncError::Transport)
}
fn request_timeout(path: &str, body: Option<&Value>) -> Duration {
    // Initial history can be 16 MB raw / 21 MB base64. Budget its wire upload
    // at 64 KiB/s plus the normal response allowance; ordinary calls stay short.
    if path.ends_with("/sync") {
        // Receive a full base64 journal page even on a 32 KiB/s downlink.
        let bytes = 1_024_000usize.div_ceil(3) * 4;
        return Duration::from_secs(25 + bytes.div_ceil(32_768) as u64);
    }
    let bytes = if path.ends_with("/update") {
        body.and_then(|b| b.get("update"))
            .and_then(Value::as_str)
            .map_or(0, str::len)
    } else {
        0
    };
    Duration::from_secs((25 + bytes.div_ceil(65_536) as u64).min(360))
}
fn uuid(value: &str) -> Result<()> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| SyncError::Protocol("invalid UUID"))
}
fn decode(value: &str, max: usize) -> Result<Vec<u8>> {
    if value.len() > max.div_ceil(3) * 4 {
        return Err(SyncError::Protocol("encoded payload exceeds limit"));
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| SyncError::Protocol("invalid base64"))?;
    if bytes.len() > max {
        return Err(SyncError::Protocol("payload exceeds limit"));
    }
    Ok(bytes)
}
async fn response<T: DeserializeOwned>(mut reply: reqwest::Response) -> Result<T> {
    let status = reply.status();
    if reply.content_length().is_some_and(|n| n > MAX_HTTP as u64) {
        return Err(SyncError::Protocol("HTTP response exceeds limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = reply.chunk().await.map_err(http_error)? {
        if bytes.len() + chunk.len() > MAX_HTTP {
            return Err(SyncError::Protocol("HTTP response exceeds limit"));
        }
        bytes.extend_from_slice(&chunk)
    }
    if !status.is_success() {
        let code = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
            .filter(|s| s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
            .unwrap_or_else(|| "request_failed".into());
        return Err(SyncError::Api {
            status: status.as_u16(),
            code,
        });
    }
    serde_json::from_slice(&bytes).map_err(|_| SyncError::Protocol("invalid HTTP response"))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemotePage {
    pub id: String,
    pub epoch: u64,
    pub generation: u64,
    pub deleted: u8,
    pub local_date: Option<String>,
    pub sequence: Option<u64>,
    pub after_id: Option<String>,
    pub version: u64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct DirectoryChange {
    pub cursor: u64,
    pub page: RemotePage,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryBatch {
    pub changes: Vec<DirectoryChange>,
    pub cursor: u64,
    pub has_more: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAck {
    #[serde(rename = "type")]
    pub kind: String,
    pub op_id: String,
    pub page_id: String,
    pub epoch: u64,
    pub generation: u64,
    pub version: u64,
    pub local_date: Option<String>,
    pub sequence: Option<u64>,
}
type Token = AccessToken;

pub trait TokenProvider: Send + Sync {
    fn token(&self, identity: Identity) -> Pin<Box<dyn Future<Output = Result<AccessToken>> + Send>>;
}

#[derive(Deserialize)]
struct PageEnvelope {
    page: RemotePage,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotWire {
    page: RemotePage,
    state_vector: String,
    sha256: String,
    chunks: Vec<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    cursor: Option<JournalCursor>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    through_version: Option<u64>,
    #[serde(default)]
    quarantine_revision: u64,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct JournalCursor {
    version: u64,
    offset: u64,
}
pub struct Snapshot {
    pub page: RemotePage,
    pub state_vector: Vec<u8>,
    pub update: Vec<u8>,
    pub complete_journal: bool,
    pub quarantine_revision: u64,
    /// For a complete journal response: None is all history; Some(N) is only
    /// the complete log after N and requires the caller's retained baseline.
    pub journal_after: Option<u64>,
}
/// Caller-owned durable prefix. Never create/advance it merely from a network
/// receipt: retain the corresponding baseline/inbox before using this fence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalWatermark {
    pub space_id: String,
    pub page_id: String,
    pub epoch: u64,
    pub generation: u64,
    pub version: u64,
    pub quarantine_revision: u64,
}
impl JournalWatermark {
    fn request(&self, space: &str, page: &str, epoch: u64, body: &mut Value) -> Result<()> {
        const MAX_SAFE: u64 = 9_007_199_254_740_991;
        if self.space_id != space
            || self.page_id != page
            || self.epoch != epoch
            || epoch == 0
            || epoch > MAX_SAFE
            || self.version >= MAX_SAFE
            || self.generation > MAX_SAFE
            || self.quarantine_revision > MAX_SAFE
        {
            return Err(SyncError::Protocol("invalid journal watermark"));
        }
        body["cursor"] = json!({"version":self.version + 1,"offset":0});
        body["generation"] = json!(self.generation);
        body["quarantineRevision"] = json!(self.quarantine_revision);
        // Do not pin throughVersion to the old watermark. The server must fill
        // the gap up to its current version before subsequent live broadcasts.
        Ok(())
    }
    fn response(&self, page: &RemotePage, quarantine: u64) -> Result<()> {
        if page.id != self.page_id {
            return Err(SyncError::Protocol("journal watermark identity mismatch"));
        }
        let code = if page.epoch != self.epoch {
            Some("epoch_mismatch")
        } else if page.deleted != 0 {
            Some("page_deleted")
        } else if page.generation != self.generation {
            Some("generation_mismatch")
        } else if quarantine != self.quarantine_revision {
            Some("journal_changed")
        } else if page.version < self.version {
            Some("invalid_journal_cursor")
        } else {
            None
        };
        if let Some(code) = code {
            return Err(SyncError::Api {
                status: 409,
                code: code.into(),
            });
        }
        Ok(())
    }
}
fn snapshot(wire: SnapshotWire) -> Result<Snapshot> {
    if wire.chunks.len() > 1000 {
        return Err(SyncError::Protocol("too many snapshot chunks"));
    }
    let mut update = Vec::new();
    for chunk in wire.chunks {
        let part = decode(&chunk, 64_000)?;
        if update.len() + part.len() > MAX_SNAPSHOT {
            return Err(SyncError::Protocol("snapshot exceeds limit"));
        }
        update.extend(part)
    }
    if format!("{:x}", Sha256::digest(&update)) != wire.sha256 {
        return Err(SyncError::Protocol("snapshot checksum mismatch"));
    }
    Ok(Snapshot {
        page: wire.page,
        state_vector: decode(&wire.state_vector, 32_000)?,
        update: if wire.format.as_deref() == Some("journal-v1") {
            merge_journal(&update)?
        } else {
            update
        },
        complete_journal: wire.format.as_deref() == Some("journal-v1"),
        quarantine_revision: wire.quarantine_revision,
        journal_after: None,
    })
}
fn merge_journal(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut offset = 0;
    let mut records = Vec::new();
    while offset < bytes.len() {
        if bytes.len() - offset < 4 {
            return Err(SyncError::Protocol("truncated journal header"));
        }
        let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        if !(2..=MAX_UPDATE).contains(&length) || length > bytes.len() - offset {
            return Err(SyncError::Protocol("invalid journal record"));
        }
        records.push(bytes[offset..offset + length].to_vec());
        offset += length;
        if records.len() > 200_000 {
            return Err(SyncError::Protocol("too many journal records"));
        }
    }
    if records.is_empty() {
        return Ok(vec![0, 0]);
    }
    write_core::merge_wire_updates(&records)
        .map_err(|_| SyncError::Protocol("invalid CRDT journal"))
}
pub struct SyncClient {
    base: Url,
    http: HttpClient,
    identity: Identity,
    token_provider: Arc<dyn TokenProvider>,
    token: Option<Token>,
}
impl SyncClient {
    pub fn new(identity: Identity, token_provider: Arc<dyn TokenProvider>) -> Result<Self> {
        Self::with_endpoint(identity, token_provider, false)
    }
    fn with_endpoint(identity: Identity, token_provider: Arc<dyn TokenProvider>, allow_local: bool) -> Result<Self> {
        let base = endpoint(&identity.server_url, allow_local)?;
        uuid(&identity.space_id)?; uuid(&identity.device_id)?;
        let identity = Identity { server_url: base.to_string(), ..identity };
        Ok(Self { base, http: http_client()?, identity, token_provider, token: None })
    }
    pub fn identity(&self) -> &Identity { &self.identity }
    /// A bootstrap owns an independent token lifetime without copying a device key.
    pub fn fork(&self) -> Self {
        Self { base: self.base.clone(), http: self.http.clone(), identity: self.identity.clone(), token_provider: self.token_provider.clone(), token: None }
    }
    pub async fn refresh(&mut self) -> Result<u64> {
        let token = self.token_provider.token(self.identity.clone()).await?;
        let expiry = token.expires_at;
        if expiry <= now() || token.access_token.is_empty() || token.access_token.len() > 2048
            || token.access_token.bytes().any(|b| b <= 32 || b == 127) {
            return Err(SyncError::Protocol("invalid access token"));
        }
        self.token = Some(token);
        Ok(expiry)
    }
    async fn token(&mut self) -> Result<String> {
        if self
            .token
            .as_ref()
            .is_none_or(|t| t.expires_at <= now() + 30)
        {
            self.refresh().await?;
        }
        Ok(self.token.as_ref().unwrap().access_token.clone())
    }
    async fn request<T: DeserializeOwned>(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        let timeout = request_timeout(path, body.as_ref());
        for attempt in 0..3 {
            // Authentication is checked after the DO has read the request body.
            // Do not start a slow upload with a token that can expire mid-flight.
            if self
                .token
                .as_ref()
                .is_some_and(|t| t.expires_at <= now() + timeout.as_secs() + 30)
            {
                self.token = None;
            }
            let token = self.token().await?;
            let mut req = self
                .http
                .request(
                    method.clone(),
                    self.base
                        .join(path)
                        .map_err(|_| SyncError::Protocol("invalid API path"))?,
                )
                .bearer_auth(token)
                .timeout(timeout);
            if let Some(body) = &body {
                req = req.json(body)
            }
            let result = match req.send().await {
                Ok(reply) => response(reply).await,
                Err(error) => Err(http_error(error)),
            };
            if matches!(result, Err(SyncError::Api { status: 401, .. })) && attempt == 0 {
                self.token = None;
                continue;
            }
            if path.ends_with("/sync")
                && method == Method::POST
                && attempt < 2
                && matches!(result, Err(SyncError::Transport | SyncError::Timeout))
            {
                // A page is read-only and pinned by the caller's cursor/version.
                // Discard a truncated response and retry that exact page, never
                // expose partial bytes or restart the already verified history.
                tokio::time::sleep(Duration::from_millis(200 * (attempt + 1))).await;
                continue;
            }
            return result;
        }
        Err(SyncError::Transport)
    }
    pub async fn invite(&mut self) -> Result<Invitation> {
        self.request(Method::POST, "v1/pair", Some(json!({}))).await
    }
    pub async fn list_pages(&mut self, cursor: u64) -> Result<DirectoryBatch> {
        self.request(Method::GET, &format!("v1/pages?cursor={cursor}"), None)
            .await
    }
    pub async fn get_page(&mut self, page_id: &str) -> Result<RemotePage> {
        uuid(page_id)?;
        Ok(self
            .request::<PageEnvelope>(Method::GET, &format!("v1/pages/{page_id}"), None)
            .await?
            .page)
    }
    pub async fn create_page(
        &mut self,
        op_id: &str,
        page_id: &str,
        local_date: Option<&str>,
        after_id: Option<&str>,
    ) -> Result<RemotePage> {
        uuid(op_id)?;
        uuid(page_id)?;
        if let Some(id) = after_id {
            uuid(id)?
        }
        Ok(self.request::<PageEnvelope>(Method::POST,"v1/pages",Some(json!({"opId":op_id,"pageId":page_id,"localDate":local_date,"afterId":after_id}))).await?.page)
    }
    pub async fn set_deleted(
        &mut self,
        op_id: &str,
        page_id: &str,
        generation: u64,
        deleted: bool,
    ) -> Result<RemotePage> {
        uuid(op_id)?;
        uuid(page_id)?;
        let (method, path) = if deleted {
            (Method::DELETE, format!("v1/pages/{page_id}"))
        } else {
            (Method::POST, format!("v1/pages/{page_id}/restore"))
        };
        Ok(self
            .request::<PageEnvelope>(
                method,
                &path,
                Some(json!({"opId":op_id,"generation":generation})),
            )
            .await?
            .page)
    }
    pub async fn send_update(
        &mut self,
        op_id: &str,
        page_id: &str,
        epoch: u64,
        generation: u64,
        update: &[u8],
        first_write_date: Option<&str>,
    ) -> Result<UpdateAck> {
        let body = update_body(op_id, page_id, epoch, generation, update, first_write_date)?;
        let ack: UpdateAck = self
            .request(
                Method::POST,
                &format!("v1/pages/{page_id}/update"),
                Some(body),
            )
            .await?;
        if ack.kind != "ack"
            || ack.op_id != op_id
            || ack.page_id != page_id
            || ack.epoch != epoch
            || ack.generation != generation
        {
            return Err(SyncError::Protocol("acknowledgement mismatch"));
        }
        Ok(ack)
    }
    pub async fn snapshot(
        &mut self,
        page_id: &str,
        epoch: u64,
        state_vector: &[u8],
    ) -> Result<Snapshot> {
        self.snapshot_since(page_id, epoch, state_vector, None)
            .await
    }
    pub async fn snapshot_since(
        &mut self,
        page_id: &str,
        epoch: u64,
        state_vector: &[u8],
        after: Option<&JournalWatermark>,
    ) -> Result<Snapshot> {
        uuid(page_id)?;
        if state_vector.len() > 32_000 {
            return Err(SyncError::Protocol("state vector exceeds limit"));
        }
        let mut request = json!({"epoch":epoch,"stateVector":STANDARD.encode(state_vector)});
        if let Some(after) = after {
            after.request(&self.identity.space_id, page_id, epoch, &mut request)?;
        }
        let mut packed = Vec::new();
        let mut prior_cursor = after.map(|a| JournalCursor {
            version: a.version + 1,
            offset: 0,
        });
        let mut through = None;
        let mut generation = None;
        let mut quarantine = None;
        let mut batches = 0;
        loop {
            batches += 1;
            if batches > 1024 {
                return Err(SyncError::Protocol("too many journal pages"));
            }
            let mut wire: SnapshotWire = self
                .request(
                    Method::POST,
                    &format!("v1/pages/{page_id}/sync"),
                    Some(request.clone()),
                )
                .await?;
            if wire.page.id != page_id || wire.page.epoch != epoch {
                return Err(SyncError::Protocol("snapshot identity mismatch"));
            }
            if let Some(after) = after {
                after.response(&wire.page, wire.quarantine_revision)?;
            }
            if wire.format.as_deref() != Some("journal-v1") {
                if after.is_some() {
                    return Err(SyncError::Protocol("resume requires journal format"));
                }
                return snapshot(wire);
            }
            if wire.through_version != Some(wire.page.version) {
                return Err(SyncError::Protocol("invalid journal through version"));
            }
            if through.is_some_and(|v| wire.through_version != Some(v))
                || generation.is_some_and(|g| wire.page.generation != g)
                || quarantine.is_some_and(|q| wire.quarantine_revision != q)
            {
                return Err(SyncError::Protocol("journal changed during transfer"));
            }
            through = wire.through_version;
            generation = Some(wire.page.generation);
            quarantine = Some(wire.quarantine_revision);
            let has_more = wire.has_more;
            let cursor = wire
                .cursor
                .clone()
                .ok_or(SyncError::Protocol("missing journal cursor"))?;
            let page = wire.page.clone();
            let revision = wire.quarantine_revision;
            wire.format = None;
            let batch = snapshot(wire)?;
            if cursor.version > page.version.saturating_add(1)
                || (cursor.version == page.version.saturating_add(1) && cursor.offset != 0)
                || (cursor.version == 0 && cursor.offset != 0)
                || prior_cursor
                    .as_ref()
                    .is_some_and(|old| (cursor.version, cursor.offset) < (old.version, old.offset))
            {
                return Err(SyncError::Protocol("invalid journal cursor progress"));
            }
            if has_more && (batch.update.is_empty() || prior_cursor.as_ref() == Some(&cursor)) {
                return Err(SyncError::Protocol("journal cursor did not advance"));
            }
            // Lifecycle changes advance the page version without journal rows.
            // hasMore=false covers the pinned throughVersion; the cursor only
            // names the end of the last body record, which may precede it.
            if !has_more && cursor.offset != 0 {
                return Err(SyncError::Protocol("incomplete terminal journal cursor"));
            }
            if packed.len() + batch.update.len() > MAX_SNAPSHOT {
                return Err(SyncError::Protocol("journal exceeds limit"));
            }
            packed.extend(batch.update);
            if !has_more {
                return Ok(Snapshot {
                    page,
                    state_vector: vec![0],
                    update: merge_journal(&packed)?,
                    complete_journal: true,
                    quarantine_revision: revision,
                    journal_after: after.map(|a| a.version),
                });
            }
            prior_cursor = Some(cursor.clone());
            request = json!({"epoch":epoch,"stateVector":STANDARD.encode(state_vector),"cursor":cursor,"throughVersion":through,"generation":generation,"quarantineRevision":quarantine});
        }
    }

    /// Reconnect by resubscribing with the LAST DURABLY APPLIED state vectors. Caller then replays
    /// its persisted outbox with unchanged operation IDs; this transport never discards it.
    pub async fn reconnect(&mut self, subscriptions: &[Subscription]) -> Result<WsSession> {
        if subscriptions.len() > 8 {
            return Err(SyncError::Protocol("too many subscriptions"));
        }
        // A cold journal replay may take minutes. Start each new socket with a
        // full access-token lifetime instead of inheriting a nearly spent HTTP token.
        self.refresh().await?;
        let token = self.token().await?;
        let mut url = self.base.join("v1/ws").unwrap();
        url.set_scheme(if self.base.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| SyncError::Configuration("invalid websocket scheme"))?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| SyncError::Protocol("invalid websocket request"))?;
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {token}")
                .parse()
                .map_err(|_| SyncError::Protocol("invalid access token"))?,
        );
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME))
            .max_frame_size(Some(MAX_FRAME));
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(15),
            connect_async_with_config(request, Some(config), true),
        )
        .await
        .map_err(|_| SyncError::Transport)?
        .map_err(|_| SyncError::Transport)?;
        let mut session = WsSession {
            socket,
            transfers: HashMap::new(),
            pending_sync: HashSet::new(),
            subscriptions: HashMap::new(),
            space_id: self.identity.space_id.clone(),
            receive_budget: ReceiveBudget::new(Instant::now()),
            expires_at: self.token.as_ref().unwrap().expires_at,
        };
        session.send(json!({"type":"hello","protocol":1})).await?;
        match session.recv().await? {
            ServerEvent::Hello {
                space_id,
                device_id,
            } if space_id == self.identity.space_id
                && device_id == self.identity.device_id => {}
            _ => return Err(SyncError::Protocol("websocket identity mismatch")),
        }
        for subscription in subscriptions {
            session.subscribe(subscription).await?
        }
        Ok(session)
    }
}
#[derive(Clone)]
pub struct Subscription {
    pub page_id: String,
    pub epoch: u64,
    pub state_vector: Vec<u8>,
    pub after: Option<JournalWatermark>,
}
fn update_body(
    op_id: &str,
    page_id: &str,
    epoch: u64,
    generation: u64,
    update: &[u8],
    first_date: Option<&str>,
) -> Result<Value> {
    uuid(op_id)?;
    uuid(page_id)?;
    if update.len() > MAX_UPDATE {
        return Err(SyncError::Protocol("update exceeds limit"));
    }
    let mut body = json!({"opId":op_id,"epoch":epoch,"generation":generation,"update":STANDARD.encode(update)});
    if let Some(date) = first_date {
        body["firstWriteDate"] = json!(date)
    }
    Ok(body)
}

pub enum ServerEvent {
    Hello {
        space_id: String,
        device_id: String,
    },
    Directory(DirectoryChange),
    Page(RemotePage),
    Ack(UpdateAck),
    Update {
        page_id: String,
        epoch: u64,
        generation: u64,
        op_id: String,
        device_id: String,
        version: u64,
        update: Vec<u8>,
    },
    Snapshot(Snapshot),
    ResyncRequired {
        page: RemotePage,
        reason: String,
        quarantine_revision: u64,
    },
    Pong,
}
struct Transfer {
    page: RemotePage,
    state_vector: String,
    sha256: String,
    count: usize,
    chunks: Vec<String>,
    bytes: usize,
    journal: Option<Vec<u8>>,
    journal_pages: u64,
    quarantine_revision: u64,
    journal_after: Option<u64>,
}
const RECEIVE_IDLE: Duration = Duration::from_secs(60);
// Bound only reading a transfer accepted under the old token. This grants no
// authority to send new requests and does not change server expiry/revocation.
const EXPIRED_DRAIN_LIMIT: Duration = Duration::from_secs(20 * 60);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketPhase { Active, Draining, Refresh }
struct ReceiveBudget {
    last_frame: Instant,
    drain_started: Option<Instant>,
}
impl ReceiveBudget {
    fn new(at: Instant) -> Self { Self { last_frame: at, drain_started: None } }
    fn idle_deadline(&self) -> Instant { self.last_frame + RECEIVE_IDLE }
    fn received(&mut self, at: Instant) { self.last_frame = at; }
    fn phase(&mut self, expired: bool, unfinished: bool, at: Instant) -> Result<SocketPhase> {
        if !expired && self.drain_started.is_none() { return Ok(SocketPhase::Active); }
        if !unfinished { return Ok(SocketPhase::Refresh); }
        let started = *self.drain_started.get_or_insert(at);
        if at.saturating_duration_since(started) >= EXPIRED_DRAIN_LIMIT { return Err(SyncError::Timeout); }
        Ok(SocketPhase::Draining)
    }
}
fn complete_subscription(pending: &mut HashSet<String>, event: &ServerEvent) {
    // Large live updates also use chunked Snapshot events. Only a complete
    // journal reply satisfies a pending subscribe on the current service.
    if let ServerEvent::Snapshot(snapshot) = event {
        if snapshot.complete_journal { pending.remove(&snapshot.page.id); }
    }
}
pub struct WsSession {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    transfers: HashMap<String, Transfer>,
    // A subscribe may be queued before sync_begin reaches us. Keep that
    // accepted request pending until its complete verified snapshot arrives.
    pending_sync: HashSet<String>,
    subscriptions: HashMap<String, Subscription>,
    space_id: String,
    receive_budget: ReceiveBudget,
    pub expires_at: u64,
}
impl WsSession {
    pub fn has_inflight_transfer(&self) -> bool { !self.transfers.is_empty() || !self.pending_sync.is_empty() }
    pub fn is_expired(&self) -> bool { now() >= self.expires_at || self.receive_budget.drain_started.is_some() }
    pub fn phase(&mut self) -> Result<SocketPhase> {
        let unfinished = self.has_inflight_transfer();
        let expired = self.is_expired();
        self.receive_budget.phase(expired, unfinished, Instant::now())
    }
    async fn send(&mut self, value: Value) -> Result<()> {
        let text = serde_json::to_string(&value)
            .map_err(|_| SyncError::Protocol("invalid outgoing message"))?;
        if text.len() > MAX_FRAME {
            return Err(SyncError::Protocol("message exceeds limit"));
        }
        self.socket
            .send(Message::Text(text.into()))
            .await
            .map_err(|_| SyncError::Transport)
    }
    pub async fn subscribe(&mut self, subscription: &Subscription) -> Result<()> {
        uuid(&subscription.page_id)?;
        if subscription.state_vector.len() > 32_000 {
            return Err(SyncError::Protocol("state vector exceeds limit"));
        }
        let mut body = json!({"type":"subscribe","pageId":subscription.page_id,"epoch":subscription.epoch,"stateVector":STANDARD.encode(&subscription.state_vector)});
        if let Some(after) = &subscription.after {
            after.request(
                &self.space_id,
                &subscription.page_id,
                subscription.epoch,
                &mut body,
            )?;
        }
        self.send(body).await?;
        self.pending_sync.insert(subscription.page_id.clone());
        self.subscriptions
            .insert(subscription.page_id.clone(), subscription.clone());
        Ok(())
    }
    pub async fn unsubscribe(&mut self, page_id: &str) -> Result<()> {
        uuid(page_id)?;
        self.send(json!({"type":"unsubscribe","pageId":page_id}))
            .await?;
        self.pending_sync.remove(page_id);
        self.subscriptions.remove(page_id);
        Ok(())
    }
    pub async fn send_update(
        &mut self,
        op_id: &str,
        page_id: &str,
        epoch: u64,
        generation: u64,
        update: &[u8],
        first_date: Option<&str>,
    ) -> Result<()> {
        if update.len() > MAX_WEBSOCKET_UPDATE {
            return Err(SyncError::Protocol(
                "large updates require SyncClient HTTP transport",
            ));
        }
        let mut body = update_body(op_id, page_id, epoch, generation, update, first_date)?;
        body["type"] = json!("update");
        body["pageId"] = json!(page_id);
        self.send(body).await
    }
    pub async fn ping(&mut self) -> Result<()> {
        self.send(json!({"type":"ping"})).await
    }
    pub async fn close(&mut self) -> Result<()> {
        self.socket
            .close(None)
            .await
            .map_err(|_| SyncError::Transport)
    }
    /// No acknowledgement is treated as a persistence decision here. The host must durably
    /// store received updates before applying/advancing state vectors or deleting outbox rows.
    pub async fn recv(&mut self) -> Result<ServerEvent> {
        loop {
            if self.phase()? == SocketPhase::Refresh {
                return Err(SyncError::Closed);
            }
            // The deadline belongs to the session, not this cancellable recv
            // future. Coordinator ticks must not reset the inactivity budget.
            // Drain already-buffered frames first, even after a long HTTP task.
            let deadline = tokio::time::Instant::from_std(self.receive_budget.idle_deadline());
            let message = tokio::select! {
                biased;
                message = self.socket.next() => message,
                _ = tokio::time::sleep_until(deadline) => return Err(SyncError::Timeout),
            }
            .ok_or(SyncError::Closed)?
            .map_err(|_| SyncError::Transport)?;
            self.receive_budget.received(Instant::now());
            let text = match message {
                Message::Text(text) => text,
                Message::Ping(data) => {
                    self.socket
                        .send(Message::Pong(data))
                        .await
                        .map_err(|_| SyncError::Transport)?;
                    continue;
                }
                Message::Pong(_) => continue,
                Message::Close(_) => return Err(SyncError::Closed),
                _ => return Err(SyncError::Protocol("unexpected binary websocket message")),
            };
            let value: Value = serde_json::from_str(&text)
                .map_err(|_| SyncError::Protocol("invalid websocket JSON"))?;
            if let Some(event) = receive_subscribed(
                &mut self.transfers,
                &self.subscriptions,
                &self.pending_sync,
                value,
            )? {
                complete_subscription(&mut self.pending_sync, &event);
                return Ok(event);
            }
        }
    }
}
fn string(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(SyncError::Protocol("missing string field"))
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or(SyncError::Protocol("missing integer field"))
}
fn parse<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| SyncError::Protocol("invalid message shape"))
}
fn receive_subscribed(
    transfers: &mut HashMap<String, Transfer>,
    subscriptions: &HashMap<String, Subscription>,
    pending: &HashSet<String>,
    value: Value,
) -> Result<Option<ServerEvent>> {
    if value["type"] == "sync_begin" && value["format"] == "journal-v1" {
        let page: RemotePage = parse(value["page"].clone())?;
        let requested = subscriptions
            .get(&page.id)
            .filter(|_| pending.contains(&page.id))
            .ok_or(SyncError::Protocol("unsolicited journal response"))?;
        if requested.epoch != page.epoch || page.deleted != 0 {
            return Err(SyncError::Protocol(
                "journal subscription identity mismatch",
            ));
        }
        if let Some(after) = &requested.after {
            after.response(&page, number(&value, "quarantineRevision")?)?;
        }
        let id = string(&value, "transferId")?;
        let event = receive(transfers, value)?;
        transfers
            .get_mut(&id)
            .ok_or(SyncError::Protocol("missing journal transfer"))?
            .journal_after = requested.after.as_ref().map(|a| a.version);
        return Ok(event);
    }
    receive(transfers, value)
}
fn receive(transfers: &mut HashMap<String, Transfer>, value: Value) -> Result<Option<ServerEvent>> {
    let kind = string(&value, "type")?;
    let event = match kind.as_str() {
        "hello" => {
            if number(&value, "protocol")? != 1 {
                return Err(SyncError::Protocol("unsupported protocol"));
            }
            ServerEvent::Hello {
                space_id: string(&value, "spaceId")?,
                device_id: string(&value, "deviceId")?,
            }
        }
        "pong" => ServerEvent::Pong,
        "resync_required" => ServerEvent::ResyncRequired {
            page: parse(value["page"].clone())?,
            reason: string(&value, "reason")?,
            quarantine_revision: number(&value, "quarantineRevision")?,
        },
        "directory" => ServerEvent::Directory(parse(value)?),
        "page" => ServerEvent::Page(parse(
            value
                .get("page")
                .cloned()
                .ok_or(SyncError::Protocol("missing page"))?,
        )?),
        "ack" => ServerEvent::Ack(parse(value)?),
        "error" => {
            let code = string(&value, "error")?;
            return Err(SyncError::Api {
                status: 0,
                code: if code.len() <= 64
                    && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                {
                    code
                } else {
                    "request_failed".into()
                },
            });
        }
        "update" => ServerEvent::Update {
            page_id: string(&value, "pageId")?,
            epoch: number(&value, "epoch")?,
            generation: number(&value, "generation")?,
            op_id: string(&value, "opId")?,
            device_id: string(&value, "deviceId")?,
            version: number(&value, "version")?,
            update: decode(&string(&value, "update")?, MAX_UPDATE)?,
        },
        "sync_begin" => {
            let id = string(&value, "transferId")?;
            uuid(&id)?;
            let journal = value.get("format").and_then(Value::as_str) == Some("journal-v1");
            let count = if journal {
                0
            } else {
                number(&value, "chunks")? as usize
            };
            if transfers.len() >= 8
                || transfers.contains_key(&id)
                || (!journal && (count == 0 || count > 250))
            {
                return Err(SyncError::Protocol("invalid snapshot transfer"));
            }
            let page: RemotePage = parse(value["page"].clone())?;
            uuid(&page.id)?;
            let state_vector = string(&value, "stateVector")?;
            decode(&state_vector, 32_000)?;
            transfers.insert(
                id,
                Transfer {
                    page,
                    state_vector,
                    sha256: string(&value, "sha256")?,
                    count,
                    chunks: Vec::with_capacity(count),
                    bytes: 0,
                    journal: journal.then(Vec::new),
                    journal_pages: 0,
                    quarantine_revision: value
                        .get("quarantineRevision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    journal_after: None,
                },
            );
            return Ok(None);
        }
        "journal_page" => {
            let id = string(&value, "transferId")?;
            let transfer = transfers
                .get_mut(&id)
                .ok_or(SyncError::Protocol("unknown journal transfer"))?;
            if number(&value, "index")? != transfer.journal_pages {
                return Err(SyncError::Protocol("journal page out of order"));
            }
            let chunks: Vec<String> = parse(value["chunks"].clone())?;
            if chunks.len() > 3 {
                return Err(SyncError::Protocol("journal page exceeds limit"));
            }
            let batch = snapshot(SnapshotWire {
                page: transfer.page.clone(),
                state_vector: "AA==".into(),
                sha256: string(&value, "sha256")?,
                chunks,
                format: None,
                cursor: None,
                has_more: false,
                through_version: None,
                quarantine_revision: 0,
            })?;
            let journal = transfer
                .journal
                .as_mut()
                .ok_or(SyncError::Protocol("unexpected journal page"))?;
            if journal.len() + batch.update.len() > MAX_SNAPSHOT {
                return Err(SyncError::Protocol("journal exceeds limit"));
            }
            journal.extend(batch.update);
            transfer.journal_pages += 1;
            if transfer.journal_pages > 1024 {
                return Err(SyncError::Protocol("too many journal pages"));
            }
            return Ok(None);
        }
        "sync_chunk" => {
            let id = string(&value, "transferId")?;
            let transfer = transfers
                .get_mut(&id)
                .ok_or(SyncError::Protocol("unknown snapshot transfer"))?;
            if number(&value, "index")? as usize != transfer.chunks.len()
                || transfer.chunks.len() >= transfer.count
            {
                return Err(SyncError::Protocol("snapshot chunk out of order"));
            }
            let data = string(&value, "data")?;
            transfer.bytes += decode(&data, 64_000)?.len();
            if transfer.bytes > MAX_SNAPSHOT {
                return Err(SyncError::Protocol("snapshot exceeds limit"));
            }
            transfer.chunks.push(data);
            return Ok(None);
        }
        "sync_end" => {
            let id = string(&value, "transferId")?;
            let transfer = transfers
                .remove(&id)
                .ok_or(SyncError::Protocol("unknown snapshot transfer"))?;
            if let Some(journal) = transfer.journal {
                if number(&value, "pages")? != transfer.journal_pages || transfer.journal_pages == 0
                {
                    return Err(SyncError::Protocol("incomplete journal"));
                }
                return Ok(Some(ServerEvent::Snapshot(Snapshot {
                    page: transfer.page,
                    state_vector: vec![0],
                    update: merge_journal(&journal)?,
                    complete_journal: true,
                    quarantine_revision: transfer.quarantine_revision,
                    journal_after: transfer.journal_after,
                })));
            }
            if transfer.chunks.len() != transfer.count {
                return Err(SyncError::Protocol("incomplete snapshot"));
            }
            ServerEvent::Snapshot(snapshot(SnapshotWire {
                page: transfer.page,
                state_vector: transfer.state_vector,
                sha256: transfer.sha256,
                chunks: transfer.chunks,
                format: None,
                cursor: None,
                has_more: false,
                through_version: None,
                quarantine_revision: 0,
            })?)
        }
        _ => return Err(SyncError::Protocol("unknown server message")),
    };
    Ok(Some(event))
}

#[cfg(test)]
#[derive(Clone)]
struct Credentials { server_url: String, space_id: String, device_id: String, secret: String }
#[cfg(test)]
impl Credentials {
    fn new(server_url: String, space_id: String, device_id: String, secret: String) -> std::result::Result<Self, String> {
        uuid(&space_id).map_err(|e| e.to_string())?; uuid(&device_id).map_err(|e| e.to_string())?;
        Ok(Self { server_url, space_id, device_id, secret })
    }
    fn identity(&self) -> Identity { Identity { server_url: self.server_url.clone(), space_id: self.space_id.clone(), device_id: self.device_id.clone() } }
}
#[cfg(test)]
impl TokenProvider for Credentials {
    fn token(&self, identity: Identity) -> Pin<Box<dyn Future<Output = Result<AccessToken>> + Send>> {
        let secret = self.secret.clone();
        Box::pin(async move {
            let base = endpoint(&identity.server_url, true)?;
            response(http_client()?.post(base.join("v1/token").unwrap())
                .json(&json!({"spaceId":identity.space_id,"deviceId":identity.device_id,"deviceSecret":secret}))
                .send().await.map_err(http_error)?).await
        })
    }
}
#[cfg(test)]
impl SyncClient {
    fn new_local(credentials: Credentials) -> Result<Self> {
        Self::with_endpoint(credentials.identity(), Arc::new(credentials), true)
    }
    async fn redeem_local(server: &str, invitation: &Invitation) -> Result<Self> {
        let base = endpoint(server, true)?;
        uuid(&invitation.space_id)?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Redeemed { space_id: String, device_id: String, device_secret: String, access_token: String, expires_at: u64 }
        let data: Redeemed = response(http_client()?.post(base.join("v1/pair/redeem").unwrap())
            .json(invitation).send().await.map_err(http_error)?).await?;
        if data.space_id != invitation.space_id { return Err(SyncError::Protocol("pairing space mismatch")); }
        let credentials = Credentials::new(base.to_string(), data.space_id, data.device_id, data.device_secret)
            .map_err(|_| SyncError::Protocol("invalid credential bundle"))?;
        let mut client = Self::new_local(credentials)?;
        client.token = Some(Token { access_token: data.access_token, expires_at: data.expires_at });
        Ok(client)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn watermark(page: &RemotePage) -> JournalWatermark {
        JournalWatermark {
            space_id: uuid::Uuid::new_v4().to_string(),
            page_id: page.id.clone(),
            epoch: page.epoch,
            generation: page.generation,
            version: page.version,
            quarantine_revision: 3,
        }
    }
    fn one_http_reply(reply: Value) -> (String, std::thread::JoinHandle<Value>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 1024];
            let body = loop {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let len: usize = headers
                        .lines()
                        .find_map(|s| s.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + len {
                        break serde_json::from_slice(&bytes[end + 4..end + 4 + len]).unwrap();
                    }
                }
            };
            let response = reply.to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
            body
        });
        (origin, task)
    }
    struct InjectedToken {
        value: AccessToken,
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl TokenProvider for InjectedToken {
        fn token(&self, _: Identity) -> Pin<Box<dyn Future<Output=Result<AccessToken>>+Send>> {
            self.calls.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
            let value=self.value.clone();Box::pin(async move {Ok(value)})
        }
    }
    fn test_identity(server: &str) -> Identity {
        Identity {server_url:server.into(),space_id:uuid::Uuid::new_v4().to_string(),device_id:uuid::Uuid::new_v4().to_string()}
    }
    #[tokio::test]
    async fn injected_token_provider_is_the_only_production_auth_source_and_forks_refresh_independently() {
        let calls=Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let provider=Arc::new(InjectedToken {value:AccessToken {access_token:"host-short-token".into(),expires_at:now()+1000},calls:calls.clone()});
        let mut client=SyncClient::new(test_identity("https://sync.example.com"),provider).unwrap();
        assert_eq!(client.token().await.unwrap(),"host-short-token");
        assert_eq!(client.token().await.unwrap(),"host-short-token");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst),1);
        let mut bootstrap=client.fork();
        assert_eq!(bootstrap.identity(),client.identity());
        assert_eq!(bootstrap.token().await.unwrap(),"host-short-token");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst),2);
    }
    #[tokio::test]
    async fn invalid_host_tokens_and_insecure_identity_are_rejected_before_transport() {
        for (token,expiry) in [("",now()+1000),("expired",now()),("header\r\ninjection",now()+1000)] {
            let provider=Arc::new(InjectedToken {value:AccessToken {access_token:token.into(),expires_at:expiry},calls:Default::default()});
            let mut client=SyncClient::new(test_identity("https://sync.example.com/"),provider).unwrap();
            assert_eq!(client.refresh().await.unwrap_err(),SyncError::Protocol("invalid access token"));
        }
        let calls=Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let provider=Arc::new(InjectedToken {value:AccessToken {access_token:"unused".into(),expires_at:now()+1000},calls:calls.clone()});
        assert!(SyncClient::new(test_identity("http://insecure.example"),provider).is_err());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst),0);
    }
    #[tokio::test]
    async fn injected_token_http_call_sends_no_device_secret_or_token_exchange() {
        let (origin,server)=one_http_reply(json!({"ok":true}));
        let calls=Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let provider=Arc::new(InjectedToken {value:AccessToken {access_token:"host-injected-test-token".into(),expires_at:now()+1000},calls:calls.clone()});
        let mut client=SyncClient::with_endpoint(test_identity(&origin),provider,true).unwrap();
        let payload=json!({"operation":"safe"});
        let reply:Value=client.request(Method::POST,"v1/pages",Some(payload.clone())).await.unwrap();
        assert_eq!(reply,json!({"ok":true}));
        assert_eq!(server.join().unwrap(),payload);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst),1);
    }

    #[tokio::test]
    async fn http_cursor_response_is_pinned_and_empty_gap_remains_a_delta() {
        for failure in [None, Some("quarantine"), Some("terminal")] {
            let mut page = page();
            page.version = 7;
            let mark = watermark(&page);
            let reply = json!({"page":page,"format":"journal-v1","stateVector":"AA==","chunks":[],"sha256":format!("{:x}",Sha256::digest([])),"cursor":{"version":8,"offset":0},"hasMore":false,"throughVersion":if failure==Some("terminal"){8}else{7},"quarantineRevision":if failure==Some("quarantine"){4}else{3}});
            let mut reply = reply;
            if failure == Some("terminal") {
                reply["page"]["version"] = json!(8);
                reply["cursor"]["offset"] = json!(1);
            }
            let (origin, server) = one_http_reply(reply);
            let credentials = Credentials::new(
                origin,
                mark.space_id.clone(),
                uuid::Uuid::new_v4().to_string(),
                "x".repeat(88),
            )
            .unwrap();
            let mut client = SyncClient::new_local(credentials).unwrap();
            client.token = Some(Token {
                access_token: "test-only".into(),
                expires_at: now() + 1000,
            });
            let result = client
                .snapshot_since(&page.id, page.epoch, &[0], Some(&mark))
                .await;
            if failure == Some("quarantine") {
                assert_eq!(
                    result.err(),
                    Some(SyncError::Api {
                        status: 409,
                        code: "journal_changed".into()
                    })
                );
            } else if failure == Some("terminal") {
                assert_eq!(result.err(), Some(SyncError::Protocol("incomplete terminal journal cursor")));
            } else {
                let s = result.unwrap();
                assert_eq!(s.journal_after, Some(7));
                assert_eq!(s.update, [0, 0]);
                assert!(s.complete_journal);
            }
            let request = server.join().unwrap();
            assert_eq!(request["cursor"], json!({"version":8,"offset":0}));
            assert_eq!(request["generation"], page.generation);
            assert_eq!(request["quarantineRevision"], 3);
            assert!(request.get("throughVersion").is_none());
        }
    }
    #[tokio::test]
    async fn full_journal_accepts_lifecycle_version_gaps_but_rejects_truncated_records() {
        for truncated in [false, true] {
            let mut page = page();
            page.version = 4; // Body entries ended at 2, then delete and restore.
            page.generation = 2;
            let mut doc = write_core::Document::new(&page.id, 1, 11).unwrap();
            doc.replace(0, 0, 0, "restored body", 100).unwrap();
            let update = doc.encode_full();
            let mut record = (update.len() as u32).to_le_bytes().to_vec();
            record.extend(update);
            if truncated { record.pop(); }
            // A matching transport hash cannot make a truncated CRDT record complete.
            let reply = json!({"page":page,"format":"journal-v1","stateVector":"AA==","chunks":[STANDARD.encode(&record)],"sha256":format!("{:x}",Sha256::digest(&record)),"cursor":{"version":3,"offset":0},"hasMore":false,"throughVersion":4,"quarantineRevision":0});
            let (origin, server) = one_http_reply(reply);
            let credentials = Credentials::new(origin, uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string(), "x".repeat(88)).unwrap();
            let mut client = SyncClient::new_local(credentials).unwrap();
            client.token = Some(Token { access_token: "test-only".into(), expires_at: now() + 1000 });
            let result = client.snapshot(&page.id, page.epoch, &[0]).await;
            if truncated {
                assert!(matches!(result, Err(SyncError::Protocol(_))));
            } else {
                let snapshot = result.unwrap();
                assert!(snapshot.complete_journal);
                assert_eq!(snapshot.journal_after, None);
                assert_eq!(snapshot.page.version, 4);
                assert_eq!(snapshot.page.generation, 2);
                let restored = write_core::Document::load(&page.id, 1, 12, &snapshot.update).unwrap();
                assert_eq!(restored.body(), "restored body");
                restored.snapshot().unwrap();
            }
            let request = server.join().unwrap();
            assert!(request.get("cursor").is_none());
            assert!(request.get("throughVersion").is_none());
        }
    }
    #[test]
    fn watermark_requests_fill_the_gap_without_freezing_the_old_upper_bound() {
        let mut page = page();
        page.version = 7;
        let mark = watermark(&page);
        let mut body = json!({"epoch":page.epoch,"stateVector":"AA=="});
        mark.request(&mark.space_id, &page.id, page.epoch, &mut body)
            .unwrap();
        assert_eq!(body["cursor"], json!({"version":8,"offset":0}));
        assert_eq!(body["generation"], page.generation);
        assert_eq!(body["quarantineRevision"], 3);
        assert!(body.get("throughVersion").is_none());
        assert!(mark
            .request(
                &uuid::Uuid::new_v4().to_string(),
                &page.id,
                page.epoch,
                &mut body
            )
            .is_err());
        assert!(mark
            .request(
                &mark.space_id,
                &uuid::Uuid::new_v4().to_string(),
                page.epoch,
                &mut body
            )
            .is_err());
        assert!(mark
            .request(&mark.space_id, &page.id, page.epoch + 1, &mut body)
            .is_err());
        let mut overflow = mark.clone();
        overflow.version = u64::MAX;
        assert!(overflow
            .request(&mark.space_id, &page.id, page.epoch, &mut body)
            .is_err());
    }
    #[test]
    fn watermark_fences_fail_closed_instead_of_merging_another_history() {
        let mut page = page();
        page.version = 7;
        let mark = watermark(&page);
        page.version = 9;
        mark.response(&page, 3).unwrap();
        for (field, code) in [
            ("epoch", "epoch_mismatch"),
            ("generation", "generation_mismatch"),
            ("deleted", "page_deleted"),
            ("version", "invalid_journal_cursor"),
        ] {
            let mut changed = page.clone();
            match field {
                "epoch" => changed.epoch += 1,
                "generation" => changed.generation += 1,
                "deleted" => changed.deleted = 1,
                _ => changed.version = 6,
            };
            assert_eq!(
                mark.response(&changed, 3),
                Err(SyncError::Api {
                    status: 409,
                    code: code.into()
                })
            );
        }
        assert_eq!(
            mark.response(&page, 4),
            Err(SyncError::Api {
                status: 409,
                code: "journal_changed".into()
            })
        );
        page.id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            mark.response(&page, 3),
            Err(SyncError::Protocol(_))
        ));
    }
    #[test]
    fn subscribed_empty_delta_is_complete_only_after_the_terminal_frame() {
        let mut page = page();
        page.version = 7;
        let mark = watermark(&page);
        let subscriptions = HashMap::from([(
            page.id.clone(),
            Subscription {
                page_id: page.id.clone(),
                epoch: page.epoch,
                state_vector: vec![0],
                after: Some(mark),
            },
        )]);
        let pending = HashSet::from([page.id.clone()]);
        let mut transfers = HashMap::new();
        let id = uuid::Uuid::new_v4().to_string();
        let begin = json!({"type":"sync_begin","transferId":id,"page":page,"format":"journal-v1","stateVector":"AA==","sha256":"","quarantineRevision":3});
        assert!(
            receive_subscribed(&mut transfers, &subscriptions, &pending, begin.clone())
                .unwrap()
                .is_none()
        );
        let data = json!({"type":"journal_page","transferId":id,"index":0,"chunks":[],"sha256":format!("{:x}",Sha256::digest([]))});
        assert!(
            receive_subscribed(&mut transfers, &subscriptions, &pending, data)
                .unwrap()
                .is_none()
        );
        match receive_subscribed(
            &mut transfers,
            &subscriptions,
            &pending,
            json!({"type":"sync_end","transferId":id,"pages":1}),
        )
        .unwrap()
        .unwrap()
        {
            ServerEvent::Snapshot(s) => {
                assert_eq!(s.update, [0, 0]);
                assert!(s.complete_journal);
                assert_eq!(s.journal_after, Some(7));
                assert_eq!(s.quarantine_revision, 3)
            }
            _ => panic!("not a complete snapshot"),
        }
        assert!(receive_subscribed(
            &mut transfers,
            &subscriptions,
            &HashSet::new(),
            begin.clone()
        )
        .is_err());
        let mut wrong = begin;
        wrong["quarantineRevision"] = json!(4);
        assert_eq!(
            receive_subscribed(&mut transfers, &subscriptions, &pending, wrong).err(),
            Some(SyncError::Api {
                status: 409,
                code: "journal_changed".into()
            })
        );
        assert!(transfers.is_empty());
    }
    #[test]
    fn cursor_gap_stream_rejects_truncation_and_wrong_subscription_identity() {
        let mut page = page();
        page.version = 8;
        let mut mark = watermark(&page);
        mark.version = 7;
        let subscriptions = HashMap::from([(
            page.id.clone(),
            Subscription {
                page_id: page.id.clone(),
                epoch: page.epoch,
                state_vector: vec![0],
                after: Some(mark),
            },
        )]);
        let pending = HashSet::from([page.id.clone()]);
        let mut transfers = HashMap::new();
        let id = uuid::Uuid::new_v4().to_string();
        let begin = json!({"type":"sync_begin","transferId":id,"page":page,"format":"journal-v1","stateVector":"AA==","sha256":"","quarantineRevision":3});
        let mut wrong = begin.clone();
        wrong["page"]["epoch"] = json!(2);
        assert!(receive_subscribed(&mut transfers, &subscriptions, &pending, wrong).is_err());
        assert!(transfers.is_empty());
        receive_subscribed(&mut transfers, &subscriptions, &pending, begin.clone()).unwrap();
        let partial = [2, 0, 0];
        assert!(receive_subscribed(&mut transfers,&subscriptions,&pending,json!({"type":"journal_page","transferId":id,"index":0,"chunks":[STANDARD.encode(partial)],"sha256":format!("{:x}",Sha256::digest(partial))})).unwrap().is_none());
        assert!(receive_subscribed(
            &mut transfers,
            &subscriptions,
            &pending,
            json!({"type":"sync_end","transferId":id,"pages":1})
        )
        .is_err());
        assert!(transfers.is_empty());
        receive_subscribed(&mut transfers, &subscriptions, &pending, begin).unwrap();
        let record = [2, 0, 0, 0, 0, 0];
        receive_subscribed(&mut transfers,&subscriptions,&pending,json!({"type":"journal_page","transferId":id,"index":0,"chunks":[STANDARD.encode(record)],"sha256":format!("{:x}",Sha256::digest(record))})).unwrap();
        match receive_subscribed(
            &mut transfers,
            &subscriptions,
            &pending,
            json!({"type":"sync_end","transferId":id,"pages":1}),
        )
        .unwrap()
        .unwrap()
        {
            ServerEvent::Snapshot(s) => {
                assert_eq!(s.journal_after, Some(7));
                assert_eq!(s.page.version, 8);
                assert_eq!(s.update, [0, 0])
            }
            _ => panic!("missing gap"),
        };
    }
    fn page() -> RemotePage {
        RemotePage {
            id: uuid::Uuid::new_v4().to_string(),
            epoch: 1,
            generation: 0,
            deleted: 0,
            local_date: None,
            sequence: None,
            after_id: None,
            version: 0,
        }
    }
    #[test]
    fn endpoints_reject_credential_leaks_and_insecure_servers() {
        for url in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/?token=x",
            "https://example.com/#x",
            "https://example.com/api",
        ] {
            assert!(endpoint(url, false).is_err())
        }
        assert!(endpoint("https://example.com", false).is_ok());
        assert!(endpoint("http://127.0.0.1:8787", true).is_ok());
        assert!(endpoint("http://evil.test:8787", true).is_err())
    }
    #[test]
    fn snapshot_chunks_are_decoded_separately_and_hash_checked() {
        let bytes = b"abcdefg";
        let make = || SnapshotWire {
            format: None,
            cursor: None,
            has_more: false,
            through_version: None,
            quarantine_revision: 0,
            page: page(),
            state_vector: STANDARD.encode([0]),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            chunks: vec![STANDARD.encode(&bytes[..2]), STANDARD.encode(&bytes[2..])],
        };
        assert_eq!(snapshot(make()).unwrap().update, bytes);
        let mut corrupt = make();
        corrupt.chunks[1] = STANDARD.encode(b"bad");
        assert!(snapshot(corrupt).is_err());
    }
    #[test]
    fn large_live_update_does_not_finish_a_pending_journal_subscription() {
        let target=page();
        let mut pending=HashSet::from([target.id.clone()]);
        let event=|page:RemotePage,journal|ServerEvent::Snapshot(Snapshot {page,state_vector:vec![0],update:vec![0,0],complete_journal:journal,quarantine_revision:0,journal_after:None});
        complete_subscription(&mut pending,&event(target.clone(),false));
        assert!(pending.contains(&target.id));
        complete_subscription(&mut pending,&event(page(),true));
        assert!(pending.contains(&target.id));
        complete_subscription(&mut pending,&event(target.clone(),true));
        assert!(pending.is_empty());
    }
    #[test]
    fn idle_deadline_survives_cancelled_polls_and_only_frames_advance_it() {
        let start=Instant::now();
        let mut budget=ReceiveBudget::new(start);
        // Simulate 100ms coordinator polls for 61 seconds without a frame.
        for tick in 0..610 {
            assert_eq!(budget.phase(false,false,start+Duration::from_millis(tick*100)).unwrap(),SocketPhase::Active);
            assert_eq!(budget.idle_deadline(),start+Duration::from_secs(60));
        }
        let frame=start+Duration::from_secs(61);
        budget.received(frame);
        assert_eq!(budget.idle_deadline(),frame+Duration::from_secs(60));
    }
    #[test]
    fn expired_authorized_transfer_drains_then_refreshes_with_a_fixed_total_bound() {
        let start=Instant::now();
        let mut budget=ReceiveBudget::new(start);
        assert_eq!(budget.phase(false,true,start+Duration::from_secs(899)).unwrap(),SocketPhase::Active);
        assert_eq!(budget.phase(true,true,start+Duration::from_secs(900)).unwrap(),SocketPhase::Draining);
        budget.received(start+Duration::from_secs(989));
        assert_eq!(budget.phase(true,true,start+Duration::from_secs(989)).unwrap(),SocketPhase::Draining);
        // Wall-clock correction cannot re-authorize an expired connection.
        assert_eq!(budget.phase(false,true,start+Duration::from_secs(990)).unwrap(),SocketPhase::Draining);
        assert_eq!(budget.phase(true,false,start+Duration::from_secs(991)).unwrap(),SocketPhase::Refresh);
        let mut stalled=ReceiveBudget::new(start);
        stalled.phase(true,true,start).unwrap();
        stalled.received(start+EXPIRED_DRAIN_LIMIT);
        assert_eq!(stalled.phase(true,true,start+EXPIRED_DRAIN_LIMIT),Err(SyncError::Timeout));
    }
    #[test]
    fn expired_receive_budget_never_exposes_an_unfinished_snapshot() {
        let start=Instant::now();
        let mut budget=ReceiveBudget::new(start);
        let mut transfers=HashMap::new();
        let id=uuid::Uuid::new_v4().to_string();
        let bytes=[0,0];
        let begin=json!({"type":"sync_begin","transferId":id,"page":page(),"stateVector":"AA==","sha256":format!("{:x}",Sha256::digest(bytes)),"chunks":2});
        assert!(receive(&mut transfers,begin).unwrap().is_none());
        assert!(receive(&mut transfers,json!({"type":"sync_chunk","transferId":id,"index":0,"data":"AA=="})).unwrap().is_none());
        assert_eq!(budget.phase(true,!transfers.is_empty(),start).unwrap(),SocketPhase::Draining);
        assert!(receive(&mut transfers,json!({"type":"sync_chunk","transferId":id,"index":1,"data":"AA=="})).unwrap().is_none());
        let completed=receive(&mut transfers,json!({"type":"sync_end","transferId":id})).unwrap();
        assert!(matches!(completed,Some(ServerEvent::Snapshot(_))));
        assert_eq!(budget.phase(true,!transfers.is_empty(),start+Duration::from_secs(90)).unwrap(),SocketPhase::Refresh);
    }
    #[test]
    fn websocket_snapshot_is_never_exposed_before_complete_and_verified() {
        let mut transfers = HashMap::new();
        let id = uuid::Uuid::new_v4().to_string();
        let bytes = [0, 0];
        let begin = json!({"type":"sync_begin","transferId":id,"page":page(),"stateVector":STANDARD.encode([0]),"sha256":format!("{:x}",Sha256::digest(bytes)),"chunks":2});
        assert!(receive(&mut transfers, begin).unwrap().is_none());
        assert!(receive(
            &mut transfers,
            json!({"type":"sync_chunk","transferId":id,"index":0,"data":STANDARD.encode([0])})
        )
        .unwrap()
        .is_none());
        assert!(receive(&mut transfers, json!({"type":"sync_end","transferId":id})).is_err());
    }
    #[test]
    fn journal_pages_allow_split_records_but_never_expose_partial_replay() {
        let bytes = [2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0];
        let mut transfers = HashMap::new();
        let id = uuid::Uuid::new_v4().to_string();
        let begin = json!({"type":"sync_begin","transferId":id,"page":page(),"stateVector":"AA==","sha256":"","format":"journal-v1","chunks":null,"quarantineRevision":0});
        let part = |index: u64, bytes: &[u8]| json!({"type":"journal_page","transferId":id,"index":index,"sha256":format!("{:x}",Sha256::digest(bytes)),"chunks":[STANDARD.encode(bytes)]});
        assert!(receive(&mut transfers, begin.clone()).unwrap().is_none());
        assert!(receive(&mut transfers, part(0, &bytes[..5]))
            .unwrap()
            .is_none());
        assert!(receive(
            &mut transfers,
            json!({"type":"sync_end","transferId":id,"pages":2})
        )
        .is_err());
        receive(&mut transfers, begin).unwrap();
        receive(&mut transfers, part(0, &bytes[..5])).unwrap();
        receive(&mut transfers, part(1, &bytes[5..])).unwrap();
        let result = receive(
            &mut transfers,
            json!({"type":"sync_end","transferId":id,"pages":2}),
        )
        .unwrap();
        match result {
            Some(ServerEvent::Snapshot(snapshot)) => {
                assert!(snapshot.complete_journal);
                assert_eq!(snapshot.update, [0, 0]);
            }
            _ => panic!("missing completed replay"),
        }
    }
    #[test]
    fn large_history_has_bounded_upload_budget_without_slowing_normal_requests() {
        let body = json!({"update":"x".repeat(17_678_140)});
        assert_eq!(
            request_timeout("v1/pages/a/update", Some(&body)),
            Duration::from_secs(295)
        );
        assert_eq!(
            request_timeout("v1/pages/a/sync", Some(&body)),
            Duration::from_secs(67)
        );
        assert_eq!(
            request_timeout("v1/pages/a/update", Some(&json!({"update":"AA=="}))),
            Duration::from_secs(26)
        );
        assert_eq!(request_timeout("v1/pages", None), Duration::from_secs(25));
    }
    #[tokio::test]
    // tungstenite fixes this callback's ErrorResponse type; the test cannot box it.
    #[allow(clippy::result_large_err)]
    async fn new_websocket_refreshes_the_token_before_handshake() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let space = uuid::Uuid::new_v4().to_string();
        let device = uuid::Uuid::new_v4().to_string();
        let server_space = space.clone();
        let server_device = device.clone();
        let expiry = now() + 900;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    assert!(headers.starts_with("post /v1/token "));
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let body = json!({"accessToken":"renewed-test-token","expiresAt":expiry}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            drop(stream);
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                stream,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(
                        request.headers()["authorization"],
                        "Bearer renewed-test-token"
                    );
                    Ok(response)
                },
            )
            .await
            .unwrap();
            assert!(ws.next().await.unwrap().unwrap().is_text());
            ws.send(Message::Text(json!({"type":"hello","spaceId":server_space,"deviceId":server_device,"protocol":1}).to_string().into())).await.unwrap();
        });
        let credentials =
            Credentials::new(format!("http://{address}"), space, device, "x".repeat(88)).unwrap();
        let mut client = SyncClient::new_local(credentials).unwrap();
        client.token = Some(Token {
            access_token: "old-test-token".into(),
            expires_at: now() + 200,
        });
        let session = client.reconnect(&[]).await.unwrap();
        assert_eq!(session.expires_at, expiry);
        server.await.unwrap();
    }
    #[tokio::test]
    async fn truncated_journal_response_retries_the_exact_pinned_page() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 1024];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            bodies.push(bytes[end + 4..end + 4 + length].to_vec());
                            break;
                        }
                    }
                }
                if attempt == 0 {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\n{",
                        )
                        .unwrap();
                } else {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();
                }
            }
            bodies
        });
        let credentials = Credentials::new(
            format!("http://{address}"),
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            "x".repeat(88),
        )
        .unwrap();
        let mut client = SyncClient::new_local(credentials).unwrap();
        client.token = Some(Token {
            access_token: "test-only-access".into(),
            expires_at: now() + 1000,
        });
        let body = json!({"epoch":1,"cursor":{"version":1,"offset":1024},"throughVersion":2,"generation":0,"quarantineRevision":0});
        let result: Value = client
            .request(Method::POST, "v1/pages/test/sync", Some(body.clone()))
            .await
            .unwrap();
        assert_eq!(result, json!({"ok":true}));
        let bodies = server.join().unwrap();
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0], bodies[1]);
        assert_eq!(serde_json::from_slice::<Value>(&bodies[0]).unwrap(), body);
    }
    #[test]
    fn first_write_date_is_omitted_when_absent_to_preserve_operation_fingerprint() {
        let body = update_body(
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
            1,
            0,
            &[0, 0],
            None,
        )
        .unwrap();
        assert!(body.get("firstWriteDate").is_none());
    }
    #[tokio::test]
    #[ignore = "requires isolated local Sumi Worker on loopback 18787 with test-only credentials"]
    async fn local_worker_roundtrip() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let origin = "http://127.0.0.1:18787";
        let response = reqwest::Client::new()
            .post(format!("{origin}/admin/provision"))
            .bearer_auth("test-admin-secret")
            .json(&json!({}))
            .send()
            .await?;
        assert!(response.status().is_success());
        let bundle: Value = response.json().await?;
        let credentials = Credentials::new(
            origin.into(),
            bundle["spaceId"].as_str().unwrap().into(),
            bundle["deviceId"].as_str().unwrap().into(),
            bundle["deviceSecret"].as_str().unwrap().into(),
        )?;
        let mut client = SyncClient::new_local(credentials)?;
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../write-core/tests/fixtures/yrs-v1.json"
        ))?;
        let page_id = fixture["pageId"].as_str().unwrap();
        let page = client
            .create_page(&uuid::Uuid::new_v4().to_string(), page_id, None, None)
            .await?;
        assert!(page.local_date.is_none());
        let mut ws = client
            .reconnect(&[Subscription {
                after: None,
                page_id: page_id.into(),
                epoch: 1,
                state_vector: vec![0],
            }])
            .await?;
        assert!(matches!(ws.recv().await?, ServerEvent::Snapshot(_)));
        let update = STANDARD.decode(fixture["base"].as_str().unwrap())?;
        let op_id = uuid::Uuid::new_v4().to_string();
        ws.send_update(&op_id, page_id, 1, 0, &update, Some("2026-11-07"))
            .await?;
        let mut received = 0;
        while received < 3 {
            match ws.recv().await? {
                ServerEvent::Directory(change) => {
                    assert_eq!(change.page.sequence, Some(1));
                    received += 1
                }
                ServerEvent::Update { update: bytes, .. } => {
                    assert_eq!(bytes, update);
                    received += 1
                }
                ServerEvent::Ack(ack) => {
                    assert_eq!(ack.op_id, op_id);
                    received += 1
                }
                _ => panic!("unexpected event"),
            }
        }
        ws.close().await?;
        let retry = client
            .send_update(&op_id, page_id, 1, 0, &update, Some("2026-11-07"))
            .await?;
        assert_eq!(retry.version, 1);
        let invitation = client.invite().await?;
        let mut paired = SyncClient::redeem_local(origin, &invitation).await?;
        let snapshot = paired.snapshot(page_id, 1, &[0]).await?;
        assert_eq!(snapshot.page.version, 1);
        assert!(!snapshot.update.is_empty());
        let directory = paired.list_pages(0).await?;
        assert_eq!(
            directory.changes.last().unwrap().page.local_date.as_deref(),
            Some("2026-11-07")
        );
        let deleted = client
            .set_deleted(&uuid::Uuid::new_v4().to_string(), page_id, 0, true)
            .await?;
        assert_eq!(deleted.generation, 1);
        let restored = paired
            .set_deleted(&uuid::Uuid::new_v4().to_string(), page_id, 1, false)
            .await?;
        assert_eq!(restored.generation, 2);

        Ok(())
    }
}
