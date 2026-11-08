//! Host UI/session facade. Network scheduling and transport live in the plugin.
use super::{service::Backend, sync, Result};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
#[derive(Clone)]
pub struct Handle { backend: Option<Backend>, status: Arc<Mutex<Value>>,
    #[cfg(test)] prepare: Option<TestPrepare>,
    #[cfg(test)] lifecycle: Option<TestLifecycle>,
}
#[cfg(test)]
type TestLifecycle = Arc<dyn Fn(bool) -> std::pin::Pin<Box<dyn std::future::Future<Output=Result<()>> + Send>> + Send + Sync>;
#[cfg(test)]
type TestPrepare = Arc<dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output=Result<()>> + Send>> + Send + Sync>;
impl Handle {
    #[cfg(test)]
    pub(super) fn for_test(prepare: TestPrepare) -> Self {
        Self { backend:None, status:Arc::new(Mutex::new(Value::Null)), prepare:Some(prepare), lifecycle:None }
    }
    #[cfg(test)]
    pub(super) fn lifecycle_for_test(lifecycle: TestLifecycle) -> Self {
        Self {backend:None,status:Arc::new(Mutex::new(Value::Null)),prepare:None,lifecycle:Some(lifecycle)}
    }
    fn backend(&self) -> Result<&Backend> { self.backend.as_ref().ok_or("Sumi后台尚未就绪".into()) }
    pub async fn stop(&self) -> Result<()> {
        #[cfg(test)] if let Some(callback)=&self.lifecycle { return callback(false).await; }
        self.backend()?.stop_network().await
    }
    pub async fn resume(&self) -> Result<()> {
        #[cfg(test)] if let Some(callback)=&self.lifecycle { return callback(true).await; }
        self.backend()?.start_network().await
    }
    pub fn status(&self) -> Value { self.status.lock().map(|s|s.clone()).unwrap_or_else(|_|json!({"connected":false,"message":"同步状态不可用"})) }
    pub fn set_status(&self, status: Value) -> bool {
        let Ok(mut old)=self.status.lock() else { return false; };
        if *old==status { return false; } *old=status; true
    }
    pub async fn prepare_page(&self, page: String) -> Result<()> {
        #[cfg(test)]
        if let Some(prepare)=&self.prepare { return prepare(page).await; }
        self.backend()?.call("network",json!({"operation":"prepare","page":page})).await
    }
    pub async fn pair(&self, server: String, invitation: sync::Invitation) -> Result<()> {
        self.backend()?.call("network",json!({"operation":"pair","server":server,"invitation":invitation})).await
    }
    pub async fn invite(&self) -> Result<sync::Invitation> {
        self.backend()?.call("network",json!({"operation":"invite"})).await
    }
}
pub(super) fn start(backend: Backend) -> Handle {
    let handle=Handle { backend:Some(backend), #[cfg(test)] prepare:None, #[cfg(test)] lifecycle:None, status:Arc::new(Mutex::new(json!({"connected":false,"message":"正在启动Sumi后台"}))) };
    let h=handle.clone();
    let startup=handle.backend().expect("production backend").start_network();
    tauri::async_runtime::spawn(async move {
        if let Err(error)=startup.await {
            h.set_status(json!({"connected":false,"message":error}));
        }
    });
    handle
}
