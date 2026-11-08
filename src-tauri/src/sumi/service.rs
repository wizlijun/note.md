//! Private host ↔ installed Sumi backend transport. Never a WebView RPC entry.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, future::Future, path::PathBuf, pin::Pin, sync::{Arc, LazyLock, Weak, atomic::{AtomicBool, Ordering}}};
use tauri::Manager;
use crate::plugin_runtime::{commands, lifecycle::Trigger, process::PluginProcess};
type Result<T> = std::result::Result<T, String>;
pub type ConnectFuture = Pin<Box<dyn Future<Output = Result<Arc<PluginProcess>>> + Send>>;
pub type Connector = Arc<dyn Fn() -> ConnectFuture + Send + Sync>;
const VERSION: u32 = 1;

/// Only document-mutating callbacks participate. Authentication can wait for a
/// system prompt and must never hold this exit/drain barrier.
#[derive(Default)]
struct MutationGate {
    state: std::sync::Mutex<MutationState>,
    inflight: Arc<tokio::sync::RwLock<()>>,
}
#[derive(Default)]
struct MutationState { generation: u64, accepting: bool }
impl MutationGate {
    fn ticket(&self) -> Result<u64> { Ok(self.state.lock().map_err(super::err)?.generation) }
    fn close(&self) -> Result<()> {
        let mut state=self.state.lock().map_err(super::err)?;
        state.accepting=false;
        state.generation=state.generation.checked_add(1).ok_or("Sumi callback generation exhausted")?;
        Ok(())
    }
    async fn open_if_current(&self, ticket:u64) -> Result<bool> {
        let _exclusive=self.inflight.write().await;
        let mut state=self.state.lock().map_err(super::err)?;
        if state.generation!=ticket { return Ok(false); }
        state.accepting=true;
        Ok(true)
    }
    async fn enter(&self) -> Result<tokio::sync::OwnedRwLockReadGuard<()>> {
        let ticket={
            let state=self.state.lock().map_err(super::err)?;
            if !state.accepting { return Err("Sumi background mutations are paused".into()); }
            state.generation
        };
        let guard=self.inflight.clone().read_owned().await;
        {
            let state=self.state.lock().map_err(super::err)?;
            if !state.accepting || state.generation!=ticket { return Err("Sumi callback belongs to a stopped synchronization run".into()); }
        }
        Ok(guard)
    }
    async fn drain(&self) { let _exclusive=self.inflight.write().await; }
}

static SESSIONS: LazyLock<std::sync::Mutex<HashMap<String, Weak<Inner>>>> = LazyLock::new(Default::default);

pub fn connector<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Connector {
    let app = app.clone();
    Arc::new(move || {
        let app = app.clone();
        Box::pin(async move {
            super::authorize(super::PLUGIN)?;
            let runtime = commands::get_or_register(&app, super::PLUGIN)
                .map_err(|e| format!("Sumi 后台不可用，请更新插件：{e}"))?;
            runtime.ensure_active(&Trigger::Command("open".into())).await
        })
    })
}

#[derive(Clone)]
pub struct Backend { inner: Arc<Inner> }
struct Inner {
    session: String,
    root: PathBuf,
    database: PathBuf,
    fonts: PathBuf,
    connect: Connector,
    binding: tokio::sync::Mutex<Option<Binding>>,
    network_started: AtomicBool,
    network_control: tokio::sync::Mutex<()>,
    mutations: MutationGate,
}
#[derive(Clone)]
struct Binding { instance: String, process: Arc<PluginProcess> }
#[derive(Deserialize)]
struct Hello { version: u32, instance: String }
#[derive(Serialize, Deserialize)]
struct Callback { session: String, instance: String, method: String, #[serde(default)] params: Value }

async fn raw<T: DeserializeOwned>(process: &PluginProcess, method: &str, params: Value) -> Result<T> {
    let value = process.request("service.request", json!({"method":method,"params":params})).await?;
    serde_json::from_value(value).map_err(|_| "Sumi 后台返回了不兼容的数据".into())
}

impl Backend {
    pub async fn open<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: PathBuf, database: PathBuf) -> Result<Self> {
        Self::connect(root, database,
            app.path().app_local_data_dir().map_err(super::err)?.join("sumi/fonts/v1"),
            connector(app)).await
    }
    async fn connect(root:PathBuf, database:PathBuf, fonts:PathBuf, connect:Connector) -> Result<Self> {
        let inner = Arc::new(Inner {
            session: uuid::Uuid::new_v4().to_string(), root, database, fonts,
            connect, binding: tokio::sync::Mutex::new(None),
            network_started: AtomicBool::new(false),
            network_control: tokio::sync::Mutex::new(()), mutations:MutationGate::default(),
        });
        SESSIONS.lock().map_err(super::err)?.insert(inner.session.clone(), Arc::downgrade(&inner));
        let backend = Self { inner };
        backend.binding().await?;
        Ok(backend)
    }
    async fn binding(&self) -> Result<Binding> {
        let process = (self.inner.connect)().await?;
        let mut slot = self.inner.binding.lock().await;
        if let Some(binding) = slot.as_ref().filter(|b| Arc::ptr_eq(&b.process, &process)) {
            return Ok(binding.clone());
        }
        let hello: Hello = raw(&process, "hello", json!({"version":VERSION})).await?;
        if hello.version != VERSION || uuid::Uuid::parse_str(&hello.instance).is_err() {
            return Err("Sumi 后台协议不兼容，请同时更新宿主和插件".into());
        }
        let binding = Binding { instance: hello.instance, process };
        let result: Result<Value> = raw(&binding.process, "open", json!({
            "version":VERSION,"instance":binding.instance,"session":self.inner.session,
            "vault":self.inner.root,"database":self.inner.database,"fontCache":self.inner.fonts,
        })).await;
        result?;
        *slot = Some(binding.clone());
        if self.inner.network_started.load(Ordering::SeqCst) {
            let result: Result<Value> = raw(&binding.process, "network", json!({
                "instance":binding.instance,"session":self.inner.session,
                "payload":{"operation":"start"}
            })).await;
            if let Err(error) = result { *slot = None; return Err(error); }
        }
        Ok(binding)
    }
    /// Capture the startup ticket synchronously, before the caller spawns it.
    /// A subsequent stop invalidates this future even if it has never been polled.
    pub fn start_network(&self) -> impl Future<Output=Result<()>> + Send + 'static {
        let backend=self.clone();
        let ticket=self.inner.mutations.ticket();
        async move {
            let _control=backend.inner.network_control.lock().await;
            if !backend.inner.mutations.open_if_current(ticket?).await? { return Ok(()); }
            backend.inner.network_started.store(true,Ordering::SeqCst);
            backend.call("network",json!({"operation":"start"})).await
        }
    }
    pub async fn stop_network(&self) -> Result<()> {
        // Close intake before awaiting the backend. Existing host callbacks may
        // outlive cancellation of the plugin's Host::request future.
        self.inner.mutations.close()?;
        self.inner.network_started.store(false,Ordering::SeqCst);
        let _control=self.inner.network_control.lock().await;
        // An already-running startup may have updated intent before yielding.
        self.inner.network_started.store(false,Ordering::SeqCst);
        let stopped=self.call("network",json!({"operation":"stop"})).await;
        self.inner.mutations.drain().await;
        stopped
    }
    /// A transport failure is deliberately not retried here: only the durable
    /// FIFO may replay operations with proven durable idempotency identities.
    pub async fn call<T: DeserializeOwned>(&self, method: &str, payload: Value) -> Result<T> {
        let binding = self.binding().await?;
        raw(&binding.process, method, json!({"instance":binding.instance,"session":self.inner.session,"payload":payload})).await
    }
}
impl Drop for Inner {
    fn drop(&mut self) { if let Ok(mut sessions) = SESSIONS.lock() { sessions.remove(&self.session); } }
}

/// Process-origin callback. This is not registered in the shared UI capability map.
pub async fn callback<R: tauri::Runtime>(app: &tauri::AppHandle<R>, plugin: &str, value: Value) -> Result<Value> {
    super::authorize(plugin)?;
    let message: Callback = serde_json::from_value(value).map_err(|_| "无效的Sumi后台事件")?;
    let inner = SESSIONS.lock().map_err(super::err)?.get(&message.session).and_then(Weak::upgrade)
        .ok_or("Sumi后台会话已失效")?;
    let binding = inner.binding.lock().await.clone().ok_or("Sumi后台会话尚未就绪")?;
    if binding.instance != message.instance { return Err("Sumi后台事件来自旧进程".into()); }
    let _mutation = if matches!(message.method.as_str(),"remote"|"directory") {
        Some(inner.mutations.enter().await?)
    } else { None };
    // Entering the gate can suspend while a replacement process binds. Reject
    // that stale event before accepting its transaction; release binding before
    // background_request because it can re-enter this backend's durable RPC.
    let current_instance=inner.binding.lock().await.as_ref().map(|binding|binding.instance.clone());
    if current_instance.as_deref()!=Some(message.instance.as_str()) {
        return Err("Sumi后台事件在等待期间已失效".into());
    }
    super::background_request(app, &inner.root, &message.method, message.params).await
}

pub async fn font_call<T: DeserializeOwned>(connect: &Connector, cache: &std::path::Path, payload: Value) -> Result<T> {
    let process = connect().await?;
    raw(&process, "fonts", json!({"version":VERSION,"cache":cache,"payload":payload})).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_runtime::process::{initialize_and_activate, HostSink};
    use super::super::durability::{Durability, Create, LocalEdit};
    #[tokio::test]
    async fn stopped_mutation_intake_drains_existing_callbacks_before_flush() {
        let gate=Arc::new(MutationGate::default());
        assert!(gate.enter().await.is_err());
        assert!(gate.open_if_current(gate.ticket().unwrap()).await.unwrap());
        let entered=gate.enter().await.unwrap();
        gate.close().unwrap();
        assert!(gate.enter().await.is_err());
        let draining={let gate=gate.clone();tokio::spawn(async move {gate.drain().await})};
        tokio::task::yield_now().await;
        assert!(!draining.is_finished(),"stop may not overtake an accepted host mutation");
        drop(entered);
        tokio::time::timeout(std::time::Duration::from_secs(1),draining).await.unwrap().unwrap();
        assert!(gate.enter().await.is_err());
        assert!(gate.open_if_current(gate.ticket().unwrap()).await.unwrap());
        assert!(gate.enter().await.is_ok());
    }
    #[tokio::test]
    async fn stop_invalidates_unpolled_start_and_start_waiting_for_inflight_work() {
        let gate=Arc::new(MutationGate::default());
        let unpolled=gate.ticket().unwrap();
        gate.close().unwrap();
        assert!(!gate.open_if_current(unpolled).await.unwrap());
        assert!(gate.open_if_current(gate.ticket().unwrap()).await.unwrap());
        let entered=gate.enter().await.unwrap();
        let ticket=gate.ticket().unwrap();
        let startup={let gate=gate.clone();tokio::spawn(async move {gate.open_if_current(ticket).await})};
        gate.close().unwrap();
        drop(entered);
        assert!(!tokio::time::timeout(std::time::Duration::from_secs(1),startup).await.unwrap().unwrap().unwrap());
        assert!(gate.enter().await.is_err());
    }
    #[tokio::test]
    #[ignore = "requires explicit SUMI_TEST_BACKEND path to the built native executable"]
    async fn actual_host_proxy_saves_rebinds_and_flushes_native_process() {
        let binary=PathBuf::from(std::env::var_os("SUMI_TEST_BACKEND").expect("explicit test executable"));
        let temp=tempfile::tempdir().unwrap();
        let root=temp.path().join("vault"); std::fs::create_dir(&root).unwrap();
        let active=Arc::new(tokio::sync::Mutex::new(None::<Arc<PluginProcess>>));
        let connector:Connector={
            let active=active.clone(); let logs=temp.path().join("logs");
            Arc::new(move || {
                let active=active.clone();let binary=binary.clone();let logs=logs.clone();
                Box::pin(async move {
                    let mut slot=active.lock().await;
                    if let Some(process)=slot.as_ref() { if process.has_exited().await.is_none() {return Ok(process.clone());} }
                    let sink:HostSink=Arc::new(|request| {
                        assert_eq!(request.method,"host.sumi.service");
                        assert_eq!(request.params["method"],"durable", "opening storage must not start authentication");
                        Some(plugin_protocol::RpcResponse {jsonrpc:"2.0".into(),id:request.id?,result:Some(Value::Null),error:None})
                    });
                    let process=PluginProcess::spawn(&binary,super::super::PLUGIN,&logs,30,sink).await?;
                    initialize_and_activate(&process,&plugin_protocol::InitializeParams {
                        protocol_version:2,host_version:"6.1108.5".into(),locale:"zh".into(),theme:"light".into(),
                        plugin_root:logs.to_string_lossy().into(),data_dir:logs.to_string_lossy().into(),
                    },"onCommand:open").await?;
                    *slot=Some(process.clone());Ok(process)
                })
            })
        };
        let backend=Backend::connect(root.clone(),temp.path().join("private/sumi.sqlite3"),temp.path().join("fonts"),connector).await.unwrap();
        let first_instance=backend.binding().await.unwrap().instance;
        let durable=Durability::from_backend(backend.clone(), |_|{});
        let page=uuid::Uuid::new_v4().to_string();
        let mut doc=write_core::Document::new(&page,1,17).unwrap();
        durable.create(Create {page_id:page.clone(),epoch:1,full_state:doc.encode_full(),revision:0,after_id:None,first_write_date:None,frontmatter:None,preserved_pair:None}).await.unwrap();
        let original_pending=durable.outbox_count().await.unwrap();
        for (revision,text) in [(0,"宿主代理 "),(1,"重启后续写")] {
            let permit=durable.try_reserve_edit().unwrap();
            let update=doc.replace(revision,doc.body().encode_utf16().count() as u32,0,text,100+revision as i64).unwrap();
            permit.enqueue_local(LocalEdit {page_id:page.clone(),epoch:1,generation:0,revision:doc.revision(),op_id:uuid::Uuid::new_v4().to_string(),update,first_write_date:Some("2026-11-08".into())}).unwrap();
            durable.flush().await.unwrap();
            assert!(durable.load(page.clone()).await.unwrap().raw_markdown.ends_with(&doc.body()));
            if revision==0 {
                let process=active.lock().await.clone().unwrap();
                assert!(process.shutdown().await);
            }
        }
        assert_ne!(backend.binding().await.unwrap().instance,first_instance);
        assert_eq!(durable.outbox_count().await.unwrap(),original_pending+2);
        assert!(active.lock().await.as_ref().unwrap().shutdown().await);
    }
}
