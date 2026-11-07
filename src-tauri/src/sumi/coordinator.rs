//! One reconnecting transport loop per Vault. HTTP/WS acknowledge durable operation IDs;
//! only the host session coordinator decides when an incoming edit can touch a native view.
use super::{credentials, durability, sync, Result, Workspace};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tauri::Runtime;
use tokio::sync::{mpsc, oneshot};
use write_core::{
    catalog::Entry,
    storage::{self, PendingUpdate},
};

#[derive(Clone)]
pub struct Handle {
    sender: mpsc::Sender<Command>,
    status: Arc<Mutex<Value>>,
    requested: Arc<Mutex<Option<String>>>,
}
enum Command {
    Pair(String, sync::Invitation, oneshot::Sender<Result<()>>),
    Prepare(String, oneshot::Sender<Result<()>>),
    Invite(oneshot::Sender<Result<sync::Invitation>>),
}
impl Handle {
    pub async fn prepare_page(&self, page: String) -> Result<()> {
        self.prepare_page_for(page, std::time::Duration::from_secs(360)).await
    }
    async fn prepare_page_for(&self, page: String, timeout: std::time::Duration) -> Result<()> {
        *self.requested.lock().map_err(super::err)? = Some(page.clone());
        let result = tokio::time::timeout(timeout, async {
            let (send, receive) = oneshot::channel();
            self.sender.send(Command::Prepare(page.clone(), send)).await.map_err(|_| "同步任务已停止")?;
            receive.await.map_err(|_| "同步任务已停止")?
        }).await.map_err(|_| "纸页同步超时，原稿已保留；连接恢复后可继续打开".to_owned()).and_then(|r| r);
        if let Ok(mut requested) = self.requested.lock() {
            if requested.as_deref() == Some(page.as_str()) { *requested = None; }
        }
        result
    }

    pub fn status(&self) -> Value {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| json!({"connected":false,"message":"同步状态不可用"}))
    }
    pub async fn pair(&self, server: String, invitation: sync::Invitation) -> Result<()> {
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Command::Pair(server, invitation, send))
            .await
            .map_err(|_| "同步任务已停止")?;
        receive.await.map_err(|_| "同步任务已停止")?
    }
    pub async fn invite(&self) -> Result<sync::Invitation> {
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Command::Invite(send))
            .await
            .map_err(|_| "同步任务已停止")?;
        receive.await.map_err(|_| "同步任务已停止")?
    }
}
/// Return whether the public state changed; release the lock before publishing.
fn status(handle: &Handle, connected: bool, message: &str) -> bool {
    let next = json!({"connected":connected,"message":message});
    let Ok(mut state) = handle.status.lock() else { return false; };
    if *state == next { return false; }
    *state = next;
    true
}
async fn publish_status<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Workspace,
    handle: &Handle,
    connected: bool,
    message: &str,
) {
    if !status(handle, connected, message) || super::current(app, ws).is_err() {
        return;
    }
    // No status/paper mutex is held across the durable queue reads. A Vault
    // switch must not receive the previous Vault's asynchronous status event.
    if let Ok(mut state) = super::state_value(ws).await {
        if super::current(app, ws).is_err() { return; }
        // start() may run before Workspace.network's OnceLock is installed.
        // Keep the coherent pending count while using this actual transport.
        let pending = state["sync"]["pending"].clone();
        state["sync"] = handle.status();
        state["sync"]["pending"] = pending;
        super::push(app, &json!({"type":"sumi-state","state":state}));
    }
}
pub(super) fn start<R: Runtime>(app: tauri::AppHandle<R>, workspace: Arc<Workspace>) -> Handle {
    let (sender, receiver) = mpsc::channel(16);
    let handle = Handle {
        sender,
        requested: Arc::new(Mutex::new(None)),
        status: Arc::new(Mutex::new(
            json!({"connected":false,"message":"尚未连接同步服务"}),
        )),
    };
    let h = handle.clone();
    tauri::async_runtime::spawn(async move {
        run(app, workspace, h, receiver).await;
    });
    handle
}
fn entry(page: sync::RemotePage) -> Result<Entry> {
    Ok(Entry {
        id: page.id,
        epoch: u32::try_from(page.epoch).map_err(|_| "invalid epoch")?,
        generation: page.generation,
        deleted: page.deleted != 0,
        local_date: page.local_date,
        sequence: page
            .sequence
            .map(u32::try_from)
            .transpose()
            .map_err(|_| "invalid sequence")?,
        after_id: page.after_id,
        registered: true,
    })
}
async fn directory<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    page: sync::RemotePage,
) -> Result<()> {
    super::directory_changed(app, ws, vec![entry(page)?]).await
}
async fn pull_directory<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    client: &mut sync::SyncClient,
) -> Result<()> {
    let mut cursor = ws
        .durable
        .preferences("directoryCursor".into())
        .await?
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    loop {
        let batch = client.list_pages(cursor).await.map_err(super::err)?;
        for change in batch.changes {
            directory(app, ws, change.page).await?;
        }
        cursor = batch.cursor;
        ws.durable
            .set_preferences("directoryCursor".into(), json!(cursor))
            .await?;
        if !batch.has_more {
            return Ok(());
        }
    }
}
async fn send_one<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    client: &mut sync::SyncClient,
    op: &durability::Outgoing,
) -> Result<()> {
    let u = &op.update;
    // HTTP accepts large pastes and uses the same durable op ID as WebSocket. Small
    // edits also use HTTP here, leaving the subscribed socket free to receive peers.
    let ack = client
        .send_update(
            &u.op_id,
            &u.page_id,
            u.epoch as u64,
            op.generation,
            &u.update,
            op.first_write_date.as_deref(),
        )
        .await
        .map_err(super::err)?;
    ws.durable.ack(ack.op_id).await?;
    let current = ws
        .durable
        .list()
        .await?
        .into_iter()
        .find(|p| p.id == u.page_id)
        .ok_or("missing local page")?;
    let remote = sync::RemotePage {
        id: current.id,
        epoch: ack.epoch,
        generation: ack.generation,
        deleted: 0,
        local_date: ack.local_date,
        sequence: ack.sequence,
        after_id: current.after_id,
        version: ack.version,
    };
    directory(app, ws, remote).await
}
async fn send_pending<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    client: &mut sync::SyncClient,
    socket: Option<&sync::WsSession>,
) -> Result<()> {
    let directory_ops = ws.durable.directory_outbox().await?;
    for op in directory_ops.iter().filter(|o| o.kind == "create") {
        if socket.is_some_and(|s| s.is_expired()) { return Ok(()); }
        let page = client
            .create_page(
                &op.op_id,
                &op.page_id,
                op.payload["localDate"].as_str(),
                op.payload["afterId"].as_str(),
            )
            .await
            .map_err(super::err)?;
        ws.durable.acknowledge_directory(op.op_id.clone()).await?;
        directory(app, ws, page).await?;
    }
    let updates = ws.durable.outbox().await?;
    // Preserve edits made before delete/restore. Advancing lifecycle first would
    // make their older generation impossible to acknowledge or restore later.
    let mut sent = std::collections::HashSet::new();
    for op in directory_ops.iter().filter(|o| o.kind != "create") {
        let generation = op.payload["generation"]
            .as_u64()
            .ok_or("invalid lifecycle generation")?;
        for update in updates
            .iter()
            .filter(|u| u.update.page_id == op.page_id && u.generation == generation)
        {
            if socket.is_some_and(|s| s.is_expired()) { return Ok(()); }
            send_one(app, ws, client, update).await?;
            sent.insert(update.update.op_id.clone());
        }
        if socket.is_some_and(|s| s.is_expired()) { return Ok(()); }
        let page = client
            .set_deleted(&op.op_id, &op.page_id, generation, op.kind == "delete")
            .await
            .map_err(super::err)?;
        ws.durable.acknowledge_directory(op.op_id.clone()).await?;
        directory(app, ws, page).await?;
    }
    for update in updates.iter().filter(|u| !sent.contains(&u.update.op_id)) {
        if socket.is_some_and(|s| s.is_expired()) { return Ok(()); }
        send_one(app, ws, client, update).await?;
    }
    Ok(())
}
const MAX_SUBSCRIPTIONS: usize = 8;
type PageVersions = HashMap<String, (u32, u64)>;
fn versions(entry: &Entry) -> (u32, u64) { (entry.epoch, entry.generation) }

/// Priority pages are live; bootstrap unseen pages once, then retain stable slots.
fn select_pages(entries: &[Entry], priority: &[String], subscribed: &PageVersions, completed: &PageVersions) -> Vec<Entry> {
    let live: Vec<_> = entries.iter().filter(|p| !p.deleted).collect();
    let mut seen = HashSet::new();
    let mut selected = Vec::new();
    let candidates = priority.iter().filter_map(|id| live.iter().copied().find(|p| &p.id == id))
        .chain(live.iter().copied().filter(|p| completed.get(&p.id) != Some(&versions(p))))
        .chain(live.iter().copied().filter(|p| subscribed.get(&p.id) == Some(&versions(p))))
        .chain(live.iter().copied());
    for page in candidates {
        if seen.insert(page.id.clone()) { selected.push(page.clone()); }
        if selected.len() == MAX_SUBSCRIPTIONS { break; }
    }
    selected
}
async fn wanted_pages(ws: &Workspace, handle: &Handle, subscribed: &PageVersions, completed: &PageVersions) -> Result<Vec<Entry>> {
    let mut priority = handle.requested.lock().map_err(super::err)?.clone().into_iter().collect::<Vec<_>>();
    if let Some(active) = ws.active.lock().map_err(super::err)?.clone() { priority.push(active); }
    let mut owned = ws.papers.lock().map_err(super::err)?.iter().filter_map(|(id,p)| p.owner.as_ref().map(|o| (o.surface.is_none(),id.clone()))).collect::<Vec<_>>();
    owned.sort();
    priority.extend(owned.into_iter().map(|(_,id)|id));
    Ok(select_pages(&ws.durable.list().await?, &priority, subscribed, completed))
}
async fn subscription(ws: &Workspace, page: &Entry) -> Result<sync::Subscription> {
    let vector = match ws.durable.load(page.id.clone()).await {
        Ok(l) => write_core::Document::restore(&page.id, page.epoch, super::client(), &l.full_state, l.revision).map_err(super::err)?.state_vector(),
        Err(_) => vec![0],
    };
    Ok(sync::Subscription { page_id: page.id.clone(), epoch: page.epoch as u64, state_vector: vector })
}
fn subscription_changes(selected: &[Entry], subscribed: &PageVersions) -> (Vec<String>, Vec<Entry>) {
    let wanted: PageVersions = selected.iter().map(|p|(p.id.clone(),versions(p))).collect();
    let removed = subscribed.iter().filter(|(id,version)| wanted.get(*id) != Some(*version)).map(|(id,_)|id.clone()).collect::<Vec<_>>();
    let added = selected.iter().filter(|p| subscribed.get(&p.id) != Some(&versions(p))).cloned().collect();
    (removed, added)
}
async fn reconcile_subscriptions(ws: &Workspace, socket: &mut sync::WsSession, selected: &[Entry], subscribed: &mut PageVersions) -> Result<()> {
    let (removed, added) = subscription_changes(selected,subscribed);
    // Free slots before adding replacements, including same-ID epoch/generation changes.
    for id in removed {
        if socket.is_expired() { return Ok(()); }
        socket.unsubscribe(&id).await.map_err(super::err)?; subscribed.remove(&id);
    }
    for page in added {
        if socket.is_expired() { return Ok(()); }
        socket.subscribe(&subscription(ws,&page).await?).await.map_err(super::err)?;
        subscribed.insert(page.id.clone(),versions(&page));
    }
    Ok(())
}
async fn incoming<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    event: sync::ServerEvent,
) -> Result<()> {
    match event {
        sync::ServerEvent::Directory(change) => directory(app, ws, change.page).await,
        sync::ServerEvent::Page(page) => directory(app, ws, page).await,
        sync::ServerEvent::Update {
            page_id,
            epoch,
            generation,
            op_id,
            update,
            ..
        } => {
            super::integrate_remote(
                app,
                ws,
                PendingUpdate {
                    op_id,
                    page_id,
                    epoch: u32::try_from(epoch).map_err(|_| "invalid epoch")?,
                    update,
                },
                generation,
            )
            .await
        }
        sync::ServerEvent::Snapshot(snapshot) => {
            let page = snapshot.page.clone();
            directory(app, ws, page.clone()).await?;
            let id = format!(
                "snapshot:{}:{}:{}",
                page.id,
                page.generation,
                storage::sha256(&snapshot.update)
            );
            super::integrate_remote(
                app,
                ws,
                PendingUpdate {
                    op_id: id,
                    page_id: page.id,
                    epoch: u32::try_from(page.epoch).map_err(|_| "invalid epoch")?,
                    update: snapshot.update,
                },
                page.generation,
            )
            .await
        }
        sync::ServerEvent::ResyncRequired { page, reason, .. } => {
            directory(app, ws, page).await?;
            Err(format!(
                "远端更新被隔离，已保留本机草稿；需要从已验证日志重新恢复：{reason}"
            ))
        }
        sync::ServerEvent::Ack(ack) => ws.durable.ack(ack.op_id).await,
        sync::ServerEvent::Hello { .. } | sync::ServerEvent::Pong => Ok(()),
    }
}
async fn command<R: Runtime>(app: &tauri::AppHandle<R>, ws: &Arc<Workspace>, profile: &str, client: &mut Option<sync::SyncClient>, command: Command) -> bool {
    match command {
        Command::Prepare(page, reply) => {
            if reply.is_closed() { return false; }
            let result = async {
                let c = client.as_mut().ok_or("此页尚未下载，请先连接同步服务")?;
                send_pending(app, ws, c, None).await?;
                let entry = ws.durable.list().await?.into_iter().find(|p| p.id == page && !p.deleted).ok_or("纸页不存在或已删除")?;
                let snapshot = c.snapshot(&page, entry.epoch as u64, &[0]).await.map_err(super::err)?;
                incoming(app, ws, sync::ServerEvent::Snapshot(snapshot)).await?;
                ws.durable.load(page).await?;
                Ok(())
            }.await;
            let _ = reply.send(result);
            false
        }
        Command::Pair(server, invitation, reply) => {
            if client.as_ref().is_some_and(|c| {
                c.credentials().space_id != invitation.space_id
                    || c.credentials().server_url.trim_end_matches('/')
                        != server.trim_end_matches('/')
            }) {
                let _=reply.send(Err("当前 Vault 已连接另一写作空间，请在独立 Vault 中连接新空间，避免跨账号混合正文".into()));
                return false;
            }
            let outcome = async {
                let next = sync::SyncClient::redeem(&server, &invitation)
                    .await
                    .map_err(super::err)?;
                let credential = next.credentials().clone();
                let key = profile.to_owned();
                tauri::async_runtime::spawn_blocking(move || credentials::save(&key, &credential))
                    .await
                    .map_err(super::err)??;
                *client = Some(next);
                Ok(())
            }
            .await;
            let success = outcome.is_ok();
            let _ = reply.send(outcome);
            success
        }
        Command::Invite(reply) => {
            let result = match client.as_mut() {
                Some(c) => c.invite().await.map_err(super::err),
                None => Err("请先连接同步服务".into()),
            };
            let _ = reply.send(result);
            false
        }
    }
}
async fn run<R: Runtime>(
    app: tauri::AppHandle<R>,
    ws: Arc<Workspace>,
    handle: Handle,
    mut receiver: mpsc::Receiver<Command>,
) {
    let profile = storage::sha256(ws.root.to_string_lossy().as_bytes());
    let key = profile.clone();
    let mut client =
        match tauri::async_runtime::spawn_blocking(move || credentials::load(&key)).await {
            Ok(Ok(Some(c))) => sync::SyncClient::new(c).ok(),
            Ok(Ok(None)) => None,
            _ => {
                publish_status(&app, &ws, &handle, false, "无法读取同步凭据，文字保存在本机").await;
                None
            }
        };
    let mut retry = std::time::Duration::from_secs(1);
    let mut deferred_command = None;
    loop {
        if let Some(cmd) = deferred_command.take() {
            if command(&app,&ws,&profile,&mut client,cmd).await {
                publish_status(&app,&ws,&handle,false,"配对完成，正在连接同步服务").await;
            }
        }
        if client.is_none() {
            match receiver.recv().await {
                Some(c) => {
                    if command(&app, &ws, &profile, &mut client, c).await {
                        publish_status(&app, &ws, &handle, false, "配对完成，正在连接同步服务").await;
                    }
                }
                None => return,
            }
            continue;
        }
        let result=async {
            let c=client.as_mut().unwrap();
            // Offline creates must exist before pulling their remote directory and subscribing.
            send_pending(&app,&ws,c,None).await?;pull_directory(&app,&ws,c).await?;
            let mut completed = PageVersions::new();
            let selected = wanted_pages(&ws,&handle,&PageVersions::new(),&completed).await?;
            let mut initial = Vec::new();
            for page in &selected { initial.push(subscription(&ws,page).await?); }
            let mut subscribed: PageVersions = selected.iter().map(|p|(p.id.clone(),versions(p))).collect();
            let mut socket=c.reconnect(&initial).await.map_err(super::err)?;
            publish_status(&app,&ws,&handle,true,"").await;retry=std::time::Duration::from_secs(1);
            let mut tick=tokio::time::interval(std::time::Duration::from_millis(100));tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut heartbeat=tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                let active = match socket.phase().map_err(super::err)? {
                    sync::SocketPhase::Active => true,
                    sync::SocketPhase::Draining => {
                        publish_status(&app,&ws,&handle,true,"正在接收完整纸页，新的修改已保存在本机").await;
                        false
                    },
                    sync::SocketPhase::Refresh => {
                        publish_status(&app,&ws,&handle,false,"正在更新同步连接").await;
                        let _=tokio::time::timeout(std::time::Duration::from_secs(5),socket.close()).await;
                        return Ok(());
                    }
                };
                tokio::select! {
                event=socket.recv()=>{
                    let event=event.map_err(super::err)?;
                    let ready=match &event { sync::ServerEvent::Snapshot(s)=>Some((s.page.id.clone(),(u32::try_from(s.page.epoch).map_err(super::err)?,s.page.generation))), _=>None };
                    incoming(&app,&ws,event).await?;
                    if let Some((id,version))=ready { completed.insert(id,version); }
                },
                _=tick.tick()=>{
                    // An expired stream is receive-only until every accepted
                    // transfer is verified (or closed/timed out). Local edits
                    // remain durable in the outbox; do not provoke server close
                    // with a fresh ping, subscribe, or HTTP update broadcast.
                    if socket.phase().map_err(super::err)? != sync::SocketPhase::Active { continue; }
                    send_pending(&app,&ws,client.as_mut().unwrap(),Some(&socket)).await?;
                    if socket.phase().map_err(super::err)? != sync::SocketPhase::Active { continue; }
                    let selected=wanted_pages(&ws,&handle,&subscribed,&completed).await?;
                    reconcile_subscriptions(&ws,&mut socket,&selected,&mut subscribed).await?;
                },
                _=heartbeat.tick(), if active=>{
                    if socket.phase().map_err(super::err)? != sync::SocketPhase::Active { continue; }
                    socket.ping().await.map_err(super::err)?;pull_directory(&app,&ws,client.as_mut().unwrap()).await?;
                },
                command_input=receiver.recv(), if active=>{let Some(cmd)=command_input else{return Ok::<(),String>(())};if socket.phase().map_err(super::err)? != sync::SocketPhase::Active {deferred_command=Some(cmd);continue;}let changed=command(&app,&ws,&profile,&mut client,cmd).await;if changed{publish_status(&app,&ws,&handle,false,"配对完成，正在连接同步服务").await;let _=socket.close().await;return Ok(())}},
            }}
        }.await;
        if result.is_ok() { continue; } // completed drain: refresh immediately, no error backoff
        if let Err(error) = result {
            publish_status(&app, &ws, &handle, false, &format!("离线保存中：{error}")).await;
        }
        if deferred_command.is_some() { continue; }
        tokio::select! {_=tokio::time::sleep(retry)=>{},cmd=receiver.recv()=>{let Some(cmd)=cmd else{return};if command(&app,&ws,&profile,&mut client,cmd).await {publish_status(&app,&ws,&handle,false,"配对完成，正在连接同步服务").await;}}}
        retry = (retry * 2).min(std::time::Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle() -> Handle {
        let (sender, _) = mpsc::channel(1);
        Handle { sender, requested: Arc::new(Mutex::new(None)), status: Arc::new(Mutex::new(json!({"connected":false,"message":"尚未连接同步服务"}))) }
    }

    fn pages(count: usize) -> Vec<Entry> {
        (0..count).map(|i|Entry { id:format!("page-{i}"), epoch:1, generation:0, deleted:false, local_date:None,sequence:None,after_id:None,registered:true }).collect()
    }
    #[test]
    fn twelve_pages_fit_the_limit_and_prioritize_target_active_and_owner() {
        let entries=pages(12);
        let selected=select_pages(&entries,&["page-11".into(),"page-10".into(),"page-9".into()],&PageVersions::new(),&PageVersions::new());
        assert_eq!(selected.len(),8);
        assert_eq!(selected.iter().take(3).map(|p|p.id.as_str()).collect::<Vec<_>>(),vec!["page-11","page-10","page-9"]);
        let mut completed=PageVersions::new();
        let mut subscribed=PageVersions::new();
        for _ in 0..3 {
            let selected=select_pages(&entries,&["page-11".into()],&subscribed,&completed);
            assert!(selected.len()<=8);
            subscribed=selected.iter().map(|p|(p.id.clone(),versions(p))).collect();
            completed.extend(subscribed.clone());
        }
        assert_eq!(completed.len(),12,"background slots must bootstrap every page");
        let stable=select_pages(&entries,&["page-11".into()],&subscribed,&completed);
        assert!(subscription_changes(&stable,&subscribed).0.is_empty());
        assert!(subscription_changes(&stable,&subscribed).1.is_empty());
    }
    #[test]
    fn subscription_swap_frees_slots_and_replaces_lifecycle_versions() {
        let mut entries=pages(12);
        let subscribed:PageVersions=entries[..8].iter().map(|p|(p.id.clone(),versions(p))).collect();
        let completed=subscribed.clone();
        entries[0].deleted=true;
        entries[1].generation=2;
        let selected=select_pages(&entries,&["page-11".into(),"page-1".into()],&subscribed,&completed);
        let (removed,added)=subscription_changes(&selected,&subscribed);
        assert!(removed.contains(&"page-0".into()));
        assert!(removed.contains(&"page-1".into()));
        assert!(added.iter().any(|p|p.id=="page-1" && p.generation==2));
        let mut live=subscribed;
        for id in removed {live.remove(&id);}
        for page in added {live.insert(page.id.clone(),versions(&page));assert!(live.len()<=8);}
        assert_eq!(live.len(),selected.len());
    }
    #[tokio::test]
    async fn first_snapshot_waits_for_ready_and_propagates_failure_without_connection_claim() {
        let (sender,mut receiver)=mpsc::channel(2);
        let handle=Handle {sender,requested:Arc::new(Mutex::new(None)),status:Arc::new(Mutex::new(json!({"connected":false,"message":""})))};
        let task=tokio::spawn({let handle=handle.clone();async move{handle.prepare_page("target".into()).await}});
        let Some(Command::Prepare(page,reply))=receiver.recv().await else{panic!("missing prepare request")};
        assert_eq!(page,"target");assert!(!task.is_finished());
        assert_eq!(handle.requested.lock().unwrap().as_deref(),Some("target"));
        reply.send(Ok(())).unwrap();task.await.unwrap().unwrap();
        assert!(handle.requested.lock().unwrap().is_none());
        let task=tokio::spawn({let handle=handle.clone();async move{handle.prepare_page("missing".into()).await}});
        let Some(Command::Prepare(_,reply))=receiver.recv().await else{panic!("missing request")};
        reply.send(Err("network unavailable".into())).unwrap();
        assert_eq!(task.await.unwrap().unwrap_err(),"network unavailable");
        assert!(handle.requested.lock().unwrap().is_none());
        assert_eq!(handle.status()["connected"],false);
    }

    #[tokio::test]
    async fn first_snapshot_timeout_clears_priority_and_cannot_claim_a_ready_page() {
        let (sender,mut receiver)=mpsc::channel(1);
        let handle=Handle {sender,requested:Arc::new(Mutex::new(None)),status:Arc::new(Mutex::new(json!({"connected":false,"message":""})))};
        let task=tokio::spawn({let handle=handle.clone();async move{handle.prepare_page_for("target".into(),std::time::Duration::from_millis(10)).await}});
        let Some(Command::Prepare(_,reply))=receiver.recv().await else{panic!("missing request")};
        assert!(task.await.unwrap().unwrap_err().contains("同步超时"));
        assert!(reply.is_closed());
        assert!(handle.requested.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn preparing_a_missing_page_leaves_lifecycle_free_for_its_first_snapshot() {
        let (_temp,ws,old)=super::super::tests::fixture().await;
        let (sender,mut receiver)=mpsc::channel(1);
        let handle=Handle {sender,requested:Arc::new(Mutex::new(None)),status:Arc::new(Mutex::new(json!({"connected":false,"message":""})))};
        assert!(ws.network.set(handle).is_ok());
        let id=uuid::Uuid::new_v4().to_string();
        let task=tokio::spawn({let ws=ws.clone();let id=id.clone();async move{super::super::prepare_page(&ws,&id).await}});
        let Some(Command::Prepare(page,reply))=receiver.recv().await else{panic!("missing request")};
        assert_eq!(page,id);assert!(!task.is_finished());
        let lease=ws.lifecycle.try_lock().expect("network wait held the lifecycle gate");
        assert_eq!(ws.active.lock().unwrap().as_deref(),Some(old.as_str()));
        let doc=write_core::Document::new(&id,1,123).unwrap();
        ws.durable.create(durability::Create {page_id:id.clone(),epoch:1,full_state:doc.encode_full(),revision:0,after_id:None,first_write_date:None,frontmatter:None,preserved_pair:None}).await.unwrap();
        drop(lease);
        reply.send(Ok(())).unwrap();task.await.unwrap().unwrap();
        assert_eq!(ws.active.lock().unwrap().as_deref(),Some(old.as_str()));
        super::super::ensure(&ws,&id).await.unwrap();
        assert!(ws.papers.lock().unwrap().contains_key(&id));
    }

    #[test]
    fn connection_changes_publish_once_and_failure_becomes_offline() {
        let handle = handle();
        let mut events = Vec::new();
        for (connected, message) in [
            (false, "尚未连接同步服务"),
            (true, ""), (true, ""),
            (false, "离线保存中：连接关闭"), (false, "离线保存中：连接关闭"),
            (true, ""),
        ] {
            if status(&handle, connected, message) {
                // This is the publication boundary: reading the state cannot
                // deadlock on the mutation lock and duplicate ticks don't emit.
                assert!(handle.status.try_lock().is_ok());
                events.push(handle.status());
            }
        }
        assert_eq!(events, vec![
            json!({"connected":true,"message":""}),
            json!({"connected":false,"message":"离线保存中：连接关闭"}),
            json!({"connected":true,"message":""}),
        ]);
    }

    #[test]
    fn offline_reason_changes_are_visible_without_claiming_connection() {
        let handle = handle();
        assert!(!handle.status()["connected"].as_bool().unwrap());
        assert!(status(&handle, false, "无法读取同步凭据，文字保存在本机"));
        assert_eq!(handle.status()["connected"], false);
        assert!(!status(&handle, false, "无法读取同步凭据，文字保存在本机"));
        assert!(status(&handle, false, "离线保存中：网络不可用"));
        assert_eq!(handle.status()["message"], "离线保存中：网络不可用");
    }
}
