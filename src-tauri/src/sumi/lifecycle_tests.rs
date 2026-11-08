//! Host lifecycle regressions retained when the transport coordinator moves out of process.
use super::*;
use tokio::sync::{mpsc, oneshot};

fn pending_network() -> (coordinator::Handle, mpsc::Receiver<(String, oneshot::Sender<Result<()>>)>) {
    let (sender, receiver) = mpsc::channel(1);
    let handle = coordinator::Handle::for_test(Arc::new(move |page| {
        let sender = sender.clone();
        Box::pin(async move {
            let (reply, result) = oneshot::channel();
            sender.send((page, reply)).await.map_err(|_| "test network stopped")?;
            result.await.map_err(|_| "test reply dropped")?
        })
    }));
    (handle, receiver)
}

#[tokio::test]
async fn preparing_a_missing_page_leaves_lifecycle_free_for_its_first_snapshot() {
    let (_temp, ws, old) = super::tests::fixture().await;
    let (handle, mut receiver) = pending_network();
    assert!(ws.network.set(handle).is_ok());
    let id = Uuid::new_v4().to_string();
    let task = tokio::spawn({ let ws = ws.clone(); let id = id.clone(); async move { prepare_page(&ws, &id).await } });
    let (page, reply) = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv()).await.unwrap().unwrap();
    assert_eq!(page, id);
    assert!(!task.is_finished());
    let lease = ws.lifecycle.try_lock().expect("network wait held the lifecycle gate");
    assert_eq!(ws.active.lock().unwrap().as_deref(), Some(old.as_str()));
    let doc = Document::new(&id, 1, 123).unwrap();
    ws.durable.create(durability::Create {
        page_id: id.clone(), epoch: 1, full_state: doc.encode_full(), revision: 0,
        after_id: None, first_write_date: None, frontmatter: None, preserved_pair: None,
    }).await.unwrap();
    drop(lease);
    reply.send(Ok(())).unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(ws.active.lock().unwrap().as_deref(), Some(old.as_str()));
    ensure(&ws, &id).await.unwrap();
    assert!(ws.papers.lock().unwrap().contains_key(&id));
}

#[tokio::test]
async fn failed_prepare_keeps_current_owner_and_does_not_create_a_ready_page() {
    let (_temp, ws, old) = super::tests::fixture().await;
    let (handle, mut receiver) = pending_network();
    assert!(ws.network.set(handle).is_ok());
    // Existing local papers remain usable without asking the network service.
    prepare_page(&ws, &old).await.unwrap();
    assert!(receiver.try_recv().is_err());
    let id = Uuid::new_v4().to_string();
    let task = tokio::spawn({ let ws = ws.clone(); let id = id.clone(); async move { prepare_page(&ws, &id).await } });
    let (_, reply) = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv()).await.unwrap().unwrap();
    assert!(ws.lifecycle.try_lock().is_ok());
    reply.send(Err("backend unavailable".into())).unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), "backend unavailable");
    assert_eq!(ws.active.lock().unwrap().as_deref(), Some(old.as_str()));
    assert!(ws.papers.lock().unwrap()[&old].owner.is_some());
    assert!(!ws.papers.lock().unwrap().contains_key(&id));
    assert!(ws.durable.load(id).await.is_err());
}


#[tokio::test]
async fn stopped_cleanup_uses_exact_final_snapshot_without_a_backend() {
    let (_temp, mut ws, id)=super::tests::fixture().await;
    {
        let mut papers=ws.papers.lock().unwrap();
        let p=papers.get_mut(&id).unwrap();
        let update=p.doc.replace(0,0,0,"final 中文",1).unwrap();
        queue(&ws,p,update).unwrap();
        let o=p.owner.as_mut().unwrap();
        o.surface=Some(Surface{surface_id:"frozen-surface".into(),generation:9});
        o.suspended=true;
    }
    ws.phase.store(QUIESCING,Ordering::Release);
    { let _lease=ws.lifecycle.lock().await; freeze_workspace(&ws).await.unwrap(); }
    assert_eq!(ws.phase.load(Ordering::Acquire),QUIESCED);
    let saved=flush(&ws,"main","test",&id,Some(("frozen-surface",9))).await.unwrap();
    assert!(saved.raw.contains("final 中文"));
    assert_eq!(saved.revision,1);
    // Drop the SQLite owner. Every accidental backend operation now fails immediately.
    Arc::get_mut(&mut ws).unwrap().durable=Durability::disconnected_for_test();
    assert!(ws.durable.load(id.clone()).await.is_err());
    freeze_workspace(&ws).await.unwrap(); // enable's pre-cleanup is idempotent
    assert_eq!(flush(&ws,"main","test",&id,Some(("frozen-surface",9))).await.unwrap().raw,saved.raw);
    assert!(flush(&ws,"other-window","test",&id,None).await.is_err());
    assert!(flush(&ws,"main","other-tab",&id,None).await.is_err());
    assert!(flush(&ws,"main","test",&id,Some(("frozen-surface",10))).await.is_err());
    assert!(close_owner(&ws,"main","test",&id).await.is_err()); // still attached
    let detached=finish_frozen_detach(&ws,&id,"main","test","frozen-surface",9).unwrap();
    assert_eq!(detached.raw,saved.raw);
    assert_eq!(finish_frozen_detach(&ws,&id,"main","test","frozen-surface",9).unwrap().raw,saved.raw); // lost detach reply
    assert!(source_save(&ws,"main","test",&id,1,&saved.raw).await.is_err());
    assert!(reconcile_known_files(&ws,&id).await.is_err());
    assert!(save_appearance(&ws,Preferences::default(),false).await.is_err());
    close_owner(&ws,"main","test",&id).await.unwrap();
    assert!(ws.papers.lock().unwrap()[&id].owner.is_none());
}

#[tokio::test]
async fn frozen_cleanup_rejects_changed_revision_and_owner_generation() {
    let (_temp,ws,id)=super::tests::fixture().await;
    ws.phase.store(QUIESCING,Ordering::Release);
    freeze_workspace(&ws).await.unwrap();
    {
        let mut papers=ws.papers.lock().unwrap();let p=papers.get_mut(&id).unwrap();
        p.owner.as_mut().unwrap().generation+=1;
    }
    assert!(flush(&ws,"main","test",&id,None).await.err().unwrap().contains("身份或版本"));
    {
        let mut papers=ws.papers.lock().unwrap();let p=papers.get_mut(&id).unwrap();
        p.owner.as_mut().unwrap().generation-=1;
        p.doc.replace(0,0,0,"unexpected",1).unwrap();
    }
    assert!(flush(&ws,"main","test",&id,None).await.err().unwrap().contains("身份或版本"));
}

#[tokio::test]
async fn reenable_verifies_saved_state_and_resumes_existing_network_once() {
    let (_temp,ws,id)=super::tests::fixture().await;
    let calls=Arc::new(AtomicU64::new(0));
    let network=coordinator::Handle::lifecycle_for_test({let calls=calls.clone();Arc::new(move|start|{
        let calls=calls.clone();Box::pin(async move { if start {calls.fetch_add(1,Ordering::SeqCst);} Ok(()) })
    })});
    assert!(ws.network.set(network).is_ok());
    ws.phase.store(QUIESCING,Ordering::Release);
    freeze_workspace(&ws).await.unwrap();
    assert!(ws.writable().is_err());
    assert_eq!(resume_workspace(&ws).await.unwrap(),vec!["main"]);
    assert!(ws.writable().is_ok());
    assert_eq!(calls.load(Ordering::SeqCst),1);
    resume_workspace(&ws).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst),1);
    assert!(ws.papers.lock().unwrap()[&id].cleanup_snapshot.is_some());
    let snapshot=flush(&ws,"main","test",&id,None).await.unwrap();
    source_save(&ws,"main","test",&id,snapshot.revision,&snapshot.raw).await.unwrap();
}

#[tokio::test]
async fn failed_resume_keeps_frozen_cleanup_available_and_retryable() {
    let (_temp,mut ws,id)=super::tests::fixture().await;
    ws.phase.store(QUIESCING,Ordering::Release);freeze_workspace(&ws).await.unwrap();
    let durable=ws.durable.clone();
    Arc::get_mut(&mut ws).unwrap().durable=Durability::disconnected_for_test();
    assert!(resume_workspace(&ws).await.is_err());
    assert_eq!(ws.phase.load(Ordering::Acquire),QUIESCED);
    flush(&ws,"main","test",&id,None).await.unwrap();
    Arc::get_mut(&mut ws).unwrap().durable=durable;
    let calls=Arc::new(AtomicU64::new(0));
    assert!(ws.network.set(coordinator::Handle::lifecycle_for_test({let calls=calls.clone();Arc::new(move |_|{
        let calls=calls.clone();Box::pin(async move { if calls.fetch_add(1,Ordering::SeqCst)==0 {Err("start failed".into())}else{Ok(())} })
    })})).is_ok());
    assert!(resume_workspace(&ws).await.is_err());
    assert_eq!(ws.phase.load(Ordering::Acquire),QUIESCED);
    flush(&ws,"main","test",&id,None).await.unwrap();
    resume_workspace(&ws).await.unwrap();
    assert_eq!(ws.phase.load(Ordering::Acquire),ACTIVE);
}


#[tokio::test]
async fn quiesce_preserves_external_file_conflict_and_freezes_durable_body() {
    let (_temp,mut ws,id)=super::tests::fixture().await;
    {
        let mut papers=ws.papers.lock().unwrap();let p=papers.get_mut(&id).unwrap();
        let update=p.doc.replace(0,0,0,"first",1).unwrap();queue(&ws,p,update).unwrap();
    }
    ws.durable.flush().await.unwrap();
    let baseline=ws.durable.read_baseline(id.clone()).await.unwrap().unwrap();
    let (md,_)=write_core::projection::paths(&ws.root,&baseline.filename).unwrap();
    let external=baseline.pair.markdown.replace("first","external draft");
    std::fs::write(&md,&external).unwrap();
    {
        let mut papers=ws.papers.lock().unwrap();let p=papers.get_mut(&id).unwrap();
        let update=p.doc.replace(1,5,0," local",2).unwrap();queue(&ws,p,update).unwrap();
    }
    assert!(ws.durable.flush().await.is_err());
    assert_eq!(ws.durable.load(id.clone()).await.unwrap().revision,2);
    ws.phase.store(QUIESCING,Ordering::Release);
    freeze_workspace(&ws).await.unwrap();
    let snapshot=flush(&ws,"main","test",&id,None).await.unwrap();
    assert_eq!(snapshot.revision,2);assert!(!snapshot.projected);
    assert!(snapshot.raw.contains("first local"));
    assert_eq!(std::fs::read_to_string(&md).unwrap(),external);
    Arc::get_mut(&mut ws).unwrap().durable=Durability::disconnected_for_test();
    assert_eq!(flush(&ws,"main","test",&id,None).await.unwrap().raw,snapshot.raw);
    close_owner(&ws,"main","test",&id).await.unwrap();
}
