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
