//! Private stdio service runtime. The WebView interface deliberately stays closed.
use crate::{coordinator, durability::Durability, durability_rpc, fonts, network, Result};
use notemd_plugin_sdk::{Host, NotemdPlugin, ServiceFuture, ExecuteCommandParams, InitializeParams, plugin_protocol::ActivateParams};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, future::Future, path::{Path, PathBuf}, pin::Pin, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use tokio::sync::Mutex;
use sumi_protocol::{durability::Request, fonts::{FontRequest, FontResponse}};
const VERSION: u32 = 1;

pub struct Plugin { state: Arc<State>, context: Option<InitializeParams> }
struct State {
    instance: String,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    fonts: Mutex<Option<(PathBuf, fonts::Manager)>>,
    closing: Arc<AtomicBool>,
    sound: Arc<std::sync::Mutex<crate::sound::Manager>>,
}
struct Session {
    vault: PathBuf,
    database: PathBuf,
    font_cache: PathBuf,
    durable: Durability,
    bridge: Arc<PrivateHostBridge>,
    network: Mutex<Option<coordinator::Handle>>,
    events: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(task) = self.events.get_mut() { if let Some(task) = task.take() { task.abort(); } }
    }
}
struct PrivateHostBridge { host: Host, session: String, instance: String }
impl network::HostBridge for PrivateHostBridge {
    fn call(&self, method: &'static str, params: Value) -> Pin<Box<dyn Future<Output = Result<Value>> + Send>> {
        let host = self.host.clone();
        let envelope = json!({"session":self.session,"instance":self.instance,"method":method,"params":params});
        Box::pin(async move {
            // A system Keychain prompt can outlive an ordinary RPC deadline.
            // The coordinator retains this single request and cancels on shutdown.
            if matches!(method, "auth_load" | "auth_pair") {
                return host.request("host.sumi.service", envelope).await;
            }
            tokio::time::timeout(std::time::Duration::from_secs(30), host.request("host.sumi.service", envelope)).await
                .map_err(|_| "private host callback timed out".to_owned())?
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello { version: u32 }
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Open { version:u32, instance:String, session:String, vault:PathBuf, database:PathBuf, font_cache:PathBuf }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope { instance:String, session:String, payload:Value }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FontEnvelope { version:u32, cache:PathBuf, payload:FontRequest }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NetworkRequest { operation:String, page:Option<String>, server:Option<String>, invitation:Option<crate::sync::Invitation> }
fn decode<T: serde::de::DeserializeOwned>(value:Value) -> Result<T> {
    serde_json::from_value(value).map_err(|e| format!("invalid service request: {e}"))
}
fn version(value:u32) -> Result<()> { if value==VERSION {Ok(())} else {Err("unsupported Sumi Write service version".into())} }
fn private_directory(path:&Path) -> Result<PathBuf> {
    if !path.is_absolute() { return Err("service paths must be absolute".into()); }
    std::fs::create_dir_all(path).map_err(crate::err)?;
    path.canonicalize().map_err(crate::err)
}
fn database_path(path:&Path) -> Result<PathBuf> {
    if !path.is_absolute() { return Err("database path must be absolute".into()); }
    if path.symlink_metadata().is_ok_and(|meta| meta.file_type().is_symlink() || !meta.is_file()) {
        return Err("database must be a regular private file".into());
    }
    let parent=private_directory(path.parent().ok_or("database parent missing")?)?;
    Ok(parent.join(path.file_name().ok_or("database filename missing")?))
}
impl Default for Plugin { fn default()->Self {Self::new()} }
impl Plugin {
    pub fn new()->Self {
        Self { state:Arc::new(State { instance:uuid::Uuid::new_v4().to_string(), sessions:Mutex::new(HashMap::new()), fonts:Mutex::new(None), closing:Arc::new(AtomicBool::new(false)), sound:Arc::new(std::sync::Mutex::new(crate::sound::Manager::default())) }), context:None }
    }
}
impl NotemdPlugin for Plugin {
    fn initialize(&mut self,_:&Host,params:&InitializeParams) {self.context=Some(params.clone());}
    fn activate(&mut self,_:&Host,_:&ActivateParams)->Result<()> {Ok(())}
    fn execute_command(&mut self,_:&Host,params:&ExecuteCommandParams)->Result<Value> {
        match params.command.as_str() {"open"|"read-writing"=>Ok(Value::Null),_=>Err("unknown Sumi Write command".into())}
    }
    fn deactivate(&mut self,_:&Host) {
        let state=self.state.clone();
        if let Err(_error)=tokio::runtime::Handle::current().block_on(state.shutdown()) {
            // No document bytes or private authentication values in process logs.
            eprintln!("Sumi Write shutdown left recoverable work; prior host flush is required");
        }
    }
    fn on_service_request(&mut self,host:Host,method:String,params:Value)->ServiceFuture {
        let state=self.state.clone();
        Box::pin(async move {state.call(host,&method,params).await})
    }
}
impl State {
    async fn session(&self,envelope:&Envelope)->Result<Arc<Session>> {
        if envelope.instance!=self.instance {return Err("stale backend instance".into());}
        self.sessions.lock().await.get(&envelope.session).cloned().ok_or("unknown workspace session".into())
    }
    async fn open(&self,host:Host,request:Open)->Result<Value> {
        version(request.version)?;
        if request.instance!=self.instance {return Err("stale backend instance".into());}
        uuid::Uuid::parse_str(&request.session).map_err(|_|"invalid workspace session")?;
        if !request.vault.is_absolute() {return Err("Vault path must be absolute".into());}
        let vault=request.vault.canonicalize().map_err(crate::err)?;
        if !vault.is_dir() {return Err("Vault must be an existing directory".into());}
        let database=database_path(&request.database)?;
        let font_cache=private_directory(&request.font_cache)?;
        // Hold only the registry gate during open; worker callbacks are queued,
        // never awaited here. Later service calls clone then release this gate.
        let mut sessions=self.sessions.lock().await;
        if let Some(existing)=sessions.get(&request.session) {
            if existing.vault!=vault || existing.database!=database || existing.font_cache!=font_cache {
                return Err("workspace session paths changed".into());
            }
            return Ok(json!({"version":VERSION,"instance":self.instance,"session":request.session}));
        }
        if sessions.values().any(|s|s.vault==vault || s.database==database) {return Err("workspace already bound to another session".into());}
        let bridge=Arc::new(PrivateHostBridge {host,session:request.session.clone(),instance:self.instance.clone()});
        let (sender,mut events)=tokio::sync::mpsc::unbounded_channel();
        let durable=Durability::open(vault.clone(),database.clone(),move|event|{let _=sender.send(event);}).await?;
        let event_bridge=bridge.clone();
        let event_task=tokio::spawn(async move {
            use network::HostBridge;
            while let Some(event)=events.recv().await {
                if let Ok(value)=serde_json::to_value(event) {let _=event_bridge.call("durable",value).await;}
            }
        });
        sessions.insert(request.session.clone(),Arc::new(Session {vault,database,font_cache,durable,bridge,
            network:Mutex::new(None),events:std::sync::Mutex::new(Some(event_task))}));
        Ok(json!({"version":VERSION,"instance":self.instance,"session":request.session}))
    }
    async fn font_request(&self,envelope:FontEnvelope)->Result<Value> {
        version(envelope.version)?;
        let cache=private_directory(&envelope.cache)?;
        let manager={
            let mut fonts=self.fonts.lock().await;
            if let Some((configured,manager))=fonts.as_ref() {
                if configured!=&cache {return Err("font cache cannot change in a live backend".into());}
                manager.clone()
            } else {
                let manager=fonts::Manager::new(cache.clone());
                *fonts=Some((cache,manager.clone()));manager
            }
        };
        let result=match envelope.payload {
            FontRequest::Download {family} => {manager.start_download(&family)?;FontResponse::Downloaded}
            other=>manager.request(other).await?,
        };
        serde_json::to_value(result).map_err(crate::err)
    }
    async fn network_request(&self,session:Arc<Session>,request:NetworkRequest)->Result<Value> {
        if request.operation=="start" {
            let mut slot=session.network.lock().await;
            if slot.is_none() {
                *slot=Some(coordinator::start(Arc::new(network::Workspace {root:session.vault.clone(),durable:session.durable.clone(),bridge:session.bridge.clone()})));
            }
            return Ok(Value::Null);
        }
        if request.operation=="stop" {
            let handle=session.network.lock().await.take();
            if let Some(handle)=handle {handle.shutdown().await?;}
            return Ok(Value::Null);
        }
        let handle=session.network.lock().await.clone();
        if request.operation=="status" {return Ok(handle.map(|h|h.status()).unwrap_or_else(||json!({"connected":false,"message":"同步尚未启动"})));}
        let handle=handle.ok_or("network has not started")?;
        // Do not hold session/registry/durable locks across host callbacks.
        match request.operation.as_str() {
            "prepare"=>{handle.prepare_page(request.page.ok_or("missing page")?).await?;Ok(Value::Null)}
            "pair"=>{handle.pair(request.server.ok_or("missing server")?,request.invitation.ok_or("missing invitation")?).await?;Ok(Value::Null)}
            "invite"=>serde_json::to_value(handle.invite().await?).map_err(crate::err),
            _=>Err("unknown network operation".into()),
        }
    }
    async fn call(&self,host:Host,method:&str,params:Value)->Result<Value> {
        if self.closing.load(Ordering::SeqCst) {return Err("backend is shutting down".into());}
        match method {
            "hello"=>{version(decode::<Hello>(params)?.version)?;Ok(json!({"version":VERSION,"instance":self.instance,"capabilities":[sumi_protocol::service::OBSERVE_PAGE]}))}
            "open"=>self.open(host,decode(params)?).await,
            "fonts"=>self.font_request(decode(params)?).await,
            "durability"|"network"|"sound"=>{
                let envelope:Envelope=decode(params)?;
                let session=self.session(&envelope).await?;
                if method=="durability" {durability_rpc::dispatch(&session.durable,decode::<Request>(envelope.payload)?).await}
                else if method=="sound" {
                    let request=decode(envelope.payload)?;
                    let sound=self.sound.clone();let closing=self.closing.clone();
                    // Audio device setup/file decoding never occupies a Tokio I/O worker.
                    tokio::task::spawn_blocking(move || {
                        let mut sound=sound.lock().map_err(crate::err)?;
                        // Shutdown may win while session lookup yields; never restart audio afterwards.
                        if closing.load(Ordering::SeqCst) { return Err("backend is shutting down".into()); }
                        serde_json::to_value(sound.request(&envelope.session,request)?).map_err(crate::err)
                    }).await.map_err(crate::err)?
                } else {self.network_request(session,decode(envelope.payload)?).await}
            }
            _=>Err("unknown private Sumi Write service".into()),
        }
    }
    async fn shutdown(&self)->Result<()> {
        self.closing.store(true,Ordering::SeqCst);
        let sound=self.sound.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {sound.lock().map_err(crate::err)?.shutdown();Ok(())}).await.map_err(crate::err)??;
        let sessions=self.sessions.lock().await.drain().map(|(_,s)|s).collect::<Vec<_>>();
        let mut failure=None;
        for session in sessions {
            let handle=session.network.lock().await.take();
            if let Some(handle)=handle {if let Err(error)=handle.shutdown().await {failure.get_or_insert(error);}}
            if let Err(error)=session.durable.flush().await {failure.get_or_insert(error);}
        }
        failure.map_or(Ok(()),Err)
    }
}
