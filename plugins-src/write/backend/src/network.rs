//! Host-session callbacks for the network worker. No Tauri or keychain linkage.
//! The service transport binds root/session/instance; `root` is a consistency fence, never a file permission grant.
use crate::{durability::Durability, sync, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};
use write_core::{catalog::Entry, storage::PendingUpdate};
pub use sumi_protocol::sync::{AccessToken, Identity, Invitation};

pub trait HostBridge: Send + Sync {
    fn call(&self, method: &'static str, params: Value) -> Pin<Box<dyn Future<Output = Result<Value>> + Send>>;
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorState {
    pub active: Option<String>,
    pub owned: Vec<OwnedPage>,
    pub vectors: Vec<PageVector>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnedPage { pub page_id: String, pub has_surface: bool }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageVector { pub page_id: String, pub state_vector: Vec<u8> }

pub struct Workspace {
    pub root: PathBuf,
    pub durable: Durability,
    pub bridge: Arc<dyn HostBridge>,
}
impl Workspace {
    pub async fn current(&self) -> Result<()> {
        let reply = self.bridge.call("current", json!({"root": self.root})).await?;
        if reply.get("current").and_then(Value::as_bool) == Some(true) { Ok(()) }
        else { Err("写作空间已切换，旧同步结果已丢弃".into()) }
    }
    pub async fn editor_state(&self) -> Result<EditorState> {
        let reply = self.bridge.call("editor_state", json!({"root": self.root})).await?;
        serde_json::from_value(reply).map_err(|_| "invalid host editor state".into())
    }
    pub async fn directory(&self, entries: Vec<Entry>) -> Result<()> {
        // Host first quiesces native input; its existing durability proxy then
        // re-enters this service's FIFO worker. Never apply the directory early.
        self.bridge.call("directory", json!({"root": self.root, "entries": entries})).await?;
        Ok(())
    }
    pub async fn remote(&self, update: PendingUpdate, generation: u64) -> Result<()> {
        // Keep inbox acceptance + candidate/native ordering in the host bridge.
        self.bridge.call("remote", json!({"root": self.root, "update": update, "generation": generation})).await?;
        Ok(())
    }
    pub async fn status(&self, status: Value) -> Result<()> {
        self.bridge.call("status", json!({"root": self.root, "status": status})).await?;
        Ok(())
    }
    pub async fn auth_load(&self) -> Result<Option<Identity>> {
        let reply = self.bridge.call("auth_load", json!({"root": self.root})).await?;
        serde_json::from_value(reply).map_err(|_| "invalid host identity".into())
    }
    pub async fn auth_pair(&self, server: &str, invitation: &Invitation) -> Result<Identity> {
        let server = sync::server_origin(server).map_err(crate::err)?;
        let reply = self.bridge.call("auth_pair", json!({"root": self.root, "server": server, "invitation": invitation})).await?;
        let identity: Identity = serde_json::from_value(reply).map_err(|_| "invalid host identity")?;
        if identity.space_id != invitation.space_id || sync::server_origin(&identity.server_url).map_err(crate::err)? != server {
            return Err("配对身份与请求的写作空间不一致".into());
        }
        Ok(identity)
    }
    pub fn token_provider(&self) -> Arc<dyn sync::TokenProvider> {
        Arc::new(BridgeTokens { root: self.root.clone(), bridge: self.bridge.clone() })
    }
}
struct BridgeTokens { root: PathBuf, bridge: Arc<dyn HostBridge> }
impl sync::TokenProvider for BridgeTokens {
    fn token(&self, identity: Identity) -> Pin<Box<dyn Future<Output = std::result::Result<AccessToken, sync::SyncError>> + Send>> {
        let root = self.root.clone(); let bridge = self.bridge.clone();
        Box::pin(async move {
            // Never surface opaque host errors, which may contain private auth context.
            let reply = bridge.call("auth_token", json!({"root": root, "identity": identity})).await
                .map_err(|_| sync::SyncError::Transport)?;
            serde_json::from_value(reply).map_err(|_| sync::SyncError::Protocol("invalid host access token"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    type Reply = Pin<Box<dyn Future<Output = Result<Value>> + Send>>;
    struct Bridge(Arc<dyn Fn(&'static str, Value) -> Reply + Send + Sync>);
    impl HostBridge for Bridge { fn call(&self, method: &'static str, params: Value) -> Reply { (self.0)(method, params) } }
    fn identity() -> Identity {
        Identity { server_url:"https://sync.example.com/".into(), space_id:uuid::Uuid::new_v4().to_string(), device_id:uuid::Uuid::new_v4().to_string() }
    }
    async fn durable(root: &std::path::Path) -> Durability {
        Durability::open(root.to_path_buf(),root.join("network-test.sqlite3"), |_| {}).await.unwrap()
    }

    #[tokio::test]
    async fn auth_bridge_transmits_identity_and_short_token_only_and_rejects_secret_bundles() {
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let id = identity(); let response_id = id.clone(); let recorded = calls.clone();
        let bridge = Arc::new(Bridge(Arc::new(move |method, params| {
            recorded.lock().unwrap().push((method, params));
            let id = response_id.clone();
            Box::pin(async move { Ok(match method {
                "auth_load" | "auth_pair" => serde_json::to_value(id).unwrap(),
                "auth_token" => json!({"access_token":"short-lived-test-token", "expires_at":4_000_000_000u64}),
                "current" => json!({"current":true}),
                _ => panic!("unexpected callback {method}"),
            }) })
        })));
        let ws = Workspace { root:dir.path().into(), durable:durable(dir.path()).await, bridge };
        ws.current().await.unwrap(); assert_eq!(ws.auth_load().await.unwrap(),Some(id.clone()));
        let invitation = Invitation { space_id:id.space_id.clone(), code:"test-invitation".into(), expires_at:4_000_000_000 };
        assert_eq!(ws.auth_pair("https://sync.example.com", &invitation).await.unwrap(),id);
        let mut client=sync::SyncClient::new(id,ws.token_provider()).unwrap();
        assert_eq!(client.refresh().await.unwrap(),4_000_000_000);
        let calls=calls.lock().unwrap();
        assert_eq!(calls.iter().map(|(m,_)|*m).collect::<Vec<_>>(),vec!["current","auth_load","auth_pair","auth_token"]);
        for (_,params) in calls.iter() {
            assert_eq!(params["root"],dir.path().to_string_lossy().as_ref());
            let wire=params.to_string(); assert!(!wire.contains("deviceSecret")); assert!(!wire.contains("short-lived-test-token"));
        }
        let leaked=json!({"serverUrl":"https://sync.example.com/","spaceId":"x","deviceId":"x","deviceSecret":"must-not-pass"});
        assert!(serde_json::from_value::<Identity>(leaked).is_err());
        assert!(!format!("{:?}",AccessToken {access_token:"private".into(),expires_at:1}).contains("private"));
    }

    #[tokio::test]
    async fn inactive_workspace_and_insecure_pairing_fail_without_durable_or_auth_side_effects() {
        let dir=tempfile::tempdir().unwrap();
        let calls=Arc::new(Mutex::new(Vec::new()));let recorded=calls.clone();
        let ws=Workspace { root:dir.path().into(),durable:durable(dir.path()).await,
            bridge:Arc::new(Bridge(Arc::new(move|method,_| {recorded.lock().unwrap().push(method);Box::pin(async {Ok(json!({"current":false}))})}))) };
        assert!(ws.current().await.is_err());
        assert!(ws.auth_pair("http://insecure.example",&Invitation {space_id:uuid::Uuid::new_v4().to_string(),code:"test".into(),expires_at:1}).await.unwrap_err().contains("HTTPS"));
        assert_eq!(*calls.lock().unwrap(),vec!["current"]);
        assert!(ws.durable.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn host_callbacks_can_reenter_the_same_durable_fifo_without_network_lock_deadlock() {
        let dir=tempfile::tempdir().unwrap();let store=durable(dir.path()).await;let worker=store.clone();
        let order=Arc::new(Mutex::new(Vec::new()));let recorded=order.clone();
        let bridge=Arc::new(Bridge(Arc::new(move|method,params| {
            let worker=worker.clone();let recorded=recorded.clone();
            Box::pin(async move {
                recorded.lock().unwrap().push(method);
                match method {
                    "directory" => {for entry in serde_json::from_value::<Vec<Entry>>(params["entries"].clone()).unwrap() {worker.apply_directory(entry).await?;}},
                    "remote" => {
                        let update:PendingUpdate=serde_json::from_value(params["update"].clone()).unwrap();
                        let generation=params["generation"].as_u64().unwrap();
                        if worker.record_inbox(update.clone(),generation).await? {worker.receive_remote(update,generation).await?;}
                    },
                    _=>panic!("unexpected method"),
                }
                Ok(Value::Null)
            })
        })));
        let ws=Workspace {root:dir.path().into(),durable:store,bridge};
        let id=uuid::Uuid::new_v4().to_string();
        let entry=Entry {id:id.clone(),epoch:1,generation:0,deleted:false,local_date:None,sequence:None,after_id:None,registered:true};
        let mut doc=write_core::Document::new(&id,1,73).unwrap();doc.replace(0,0,0,"bridge 字",100).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2),async {
            ws.directory(vec![entry]).await.unwrap();
            ws.remote(PendingUpdate {op_id:uuid::Uuid::new_v4().to_string(),page_id:id.clone(),epoch:1,update:doc.encode_full()},0).await.unwrap();
        }).await.expect("host callback blocked the backend durability queue");
        let loaded=ws.durable.load(id.clone()).await.unwrap();
        assert!(loaded.raw_markdown.contains("bridge 字"));
        assert_eq!(*order.lock().unwrap(),vec!["directory","remote"]);
        assert!(ws.durable.has_document(id).await.unwrap());
    }

    #[tokio::test]
    async fn editor_state_uses_explicit_surface_priority_and_binary_vectors() {
        let dir=tempfile::tempdir().unwrap();
        let bridge=Arc::new(Bridge(Arc::new(|method,_|Box::pin(async move {
            assert_eq!(method,"editor_state");
            Ok(json!({"active":"page-a","owned":[{"pageId":"page-b","hasSurface":false},{"pageId":"page-a","hasSurface":true}],"vectors":[{"pageId":"page-a","stateVector":[0]}]}))
        }))));
        let ws=Workspace {root:dir.path().into(),durable:durable(dir.path()).await,bridge};
        let state=ws.editor_state().await.unwrap();
        assert_eq!(state.active.as_deref(),Some("page-a"));assert!(!state.owned[0].has_surface);assert_eq!(state.vectors[0].state_vector,vec![0]);
    }
}
