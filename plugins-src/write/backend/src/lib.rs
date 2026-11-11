//! Sumi background persistence; no Tauri or native-editor dependency.
pub mod durability;
pub mod durability_rpc;
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String { e.to_string() }

fn parse_header(raw: &str, page: &str, epoch: u32) -> Result<(serde_yaml::Mapping, String)> {
    let rest = raw
        .strip_prefix("---\n")
        .ok_or("写作身份头已移除，请保留草稿后明确选择转换为普通 Markdown")?;
    let split = rest.find("\n---\n").ok_or("写作身份头不完整")?;
    if split > 128 * 1024 {
        return Err("写作身份头超出容量限制".into());
    }
    let header: serde_yaml::Mapping = serde_yaml::from_str(&rest[..split]).map_err(err)?;
    let get = |k: &str| header.get(serde_yaml::Value::String(k.into()));
    if get("type").and_then(|v| v.as_str()) != Some("Writing Page")
        || get("page_id").and_then(|v| v.as_str()) != Some(page)
        || get("write_epoch").and_then(|v| v.as_u64()) != Some(epoch as u64)
        || get("write_schema").and_then(|v| v.as_u64()) != Some(1)
        || get("write_metadata").and_then(|v| v.as_str()) != Some("sidecar-v1")
    {
        return Err("写作身份、类型或协议已改变；同步已暂停，草稿保留".into());
    }
    Ok((header, rest[split + 5..].to_owned()))
}

mod external {
// Known-page files are projections; preserve host validation semantics.
use super::{err, parse_header, Result};
use std::{fs, path::Path};
use write_core::{
    projection::Baseline,
    storage::{self, FilePair, Sidecar},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Observed {
    pub markdown: Option<Vec<u8>>,
    pub metadata: Option<Vec<u8>>,
}
impl Observed {
    pub fn read(md: &Path, meta: &Path) -> Result<Self> {
        fn read(path: &Path) -> Result<Option<Vec<u8>>> {
            match fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(err(e)),
                Ok(info)
                    if !info.is_file()
                        || info.file_type().is_symlink()
                        || info.len() > 64 * 1024 * 1024 =>
                {
                    Err("写作投影必须是受限大小的普通文件，不能跟随符号链接".into())
                }
                Ok(_) => fs::read(path).map(Some).map_err(err),
            }
        }
        Ok(Self {
            markdown: read(md)?,
            metadata: read(meta)?,
        })
    }
    pub fn hashes(&self) -> Baseline {
        Baseline {
            markdown_sha256: self.markdown.as_ref().map(|b| storage::sha256(b)),
            metadata_sha256: self.metadata.as_ref().map(|b| storage::sha256(b)),
        }
    }
    pub fn pair(&self) -> Result<FilePair> {
        let md = self.markdown.as_ref().ok_or("写作正文文件已被外部移除；纸页仍保存在本机。请使用“修复本机文件”恢复原路径，或通过恢复入口处理移动后的文件")?;
        let meta = self.metadata.as_ref().ok_or("写作时间文件缺失；外部正文已保留。请使用“修复本机文件”从本机历史恢复，或将外部稿恢复为新页")?;
        Ok(FilePair {
            markdown: String::from_utf8(md.clone())
                .map_err(|_| "外部正文不是 UTF-8；原文件保留，请使用恢复入口".to_string())?,
            metadata: String::from_utf8(meta.clone())
                .map_err(|_| "时间文件不是 UTF-8；原文件保留，请使用“修复本机文件”".to_string())?,
        })
    }
}

/// Ignore only extension fields. Even coherent old time tables must not roll back
/// the published baseline's protected identity, body digest or line history.
fn protected(sidecar: &Sidecar) -> serde_json::Value {
    let mut value = sidecar.clone();
    value.extra.clear();
    for line in &mut value.lines {
        line.extra.clear();
    }
    serde_json::to_value(value).expect("Sidecar contains only serializable data")
}
pub(super) fn validate(
    pair: &FilePair,
    baseline: &FilePair,
    id: &str,
    epoch: u32,
) -> Result<String> {
    let (_, body) = parse_header(&pair.markdown, id, epoch)?;
    let old = storage::parse_pair(&baseline.markdown, &baseline.metadata).map_err(err)?;
    let sidecar: Sidecar = serde_json::from_str(&pair.metadata).map_err(|_| {
        "写作时间文件损坏或版本不受支持；原文件保留，请使用“修复本机文件”从本机历史恢复".to_string()
    })?;
    if protected(&sidecar) != protected(&old.sidecar) {
        return Err("写作时间文件与可信投影基线不同（可能迟到、被修改或不完整）；不会回滚行时间。请使用“修复本机文件”，原件会保留".into());
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pair() -> FilePair {
        let mut doc =
            write_core::Document::new("8f30fb79-ae3c-4cc9-a01d-1b68b89ed333", 1, 7).unwrap();
        doc.replace(0, 0, 0, "old", 100).unwrap();
        storage::serialize_pair(&doc.snapshot().unwrap(), None, None).unwrap()
    }
    #[test]
    fn external_body_and_unknown_fields_are_allowed_but_history_is_not() {
        let base = pair();
        let id = "8f30fb79-ae3c-4cc9-a01d-1b68b89ed333";
        let mut observed = FilePair {
            markdown: base.markdown.clone(),
            metadata: base.metadata.clone(),
        };
        observed.markdown = observed
            .markdown
            .replacen("type:", "custom: kept\ntype:", 1)
            .replace("old", "new");
        let mut side: serde_json::Value = serde_json::from_str(&observed.metadata).unwrap();
        side["custom"] = serde_json::json!({"retained":true});
        side["lines"][0]["extension"] = serde_json::json!(3);
        observed.metadata = side.to_string();
        assert_eq!(validate(&observed, &base, id, 1).unwrap(), "new");
        side["lines"][0]["first_written_at"] = serde_json::json!("1970-01-01T00:00:00Z");
        observed.metadata = side.to_string();
        assert!(validate(&observed, &base, id, 1)
            .unwrap_err()
            .contains("不会回滚"));
        observed.metadata = "bad".into();
        assert!(validate(&observed, &base, id, 1)
            .unwrap_err()
            .contains("原文件保留"));
    }
    #[test]
    fn missing_metadata_and_deleted_markdown_are_explicit_repair_states() {
        let base = pair();
        let observed = Observed {
            markdown: Some(base.markdown.into_bytes()),
            metadata: None,
        };
        assert!(observed.pair().unwrap_err().contains("时间文件缺失"));
        assert!(Observed {
            markdown: None,
            metadata: Some(base.metadata.into_bytes())
        }
        .pair()
        .unwrap_err()
        .contains("正文文件已被外部移除"));
    }
}

}

pub mod fonts;


#[cfg(test)]
extern crate self as notemd_sumi_backend;

/// Compiles the actual production host FIFO against a fault-injecting typed RPC
/// adapter. Root integration separately exercises the executable stdio boundary.
#[cfg(test)]
mod host_proxy_harness {
    mod service {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        use serde::{de::DeserializeOwned};
        use serde_json::Value;
        #[derive(Clone)]
        pub struct Backend {
            pub worker: crate::durability::Durability,
            pub lose_committed_reply: Arc<AtomicBool>,
            pub unavailable: Arc<AtomicBool>,
            pub corrupt_import_receipt: Arc<AtomicBool>,
        }
        impl Backend {
            pub async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T, String> {
                assert_eq!(method, "durability");
                if self.unavailable.load(Ordering::SeqCst) { return Err("test transport unavailable".into()); }
                let request: sumi_protocol::durability::Request = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let commit = matches!(request, sumi_protocol::durability::Request::CommitLocal(_) | sumi_protocol::durability::Request::CommitRemote {..});
                let import = matches!(request, sumi_protocol::durability::Request::ImportLocal { .. });
                let mut result = crate::durability_rpc::dispatch(&self.worker, request).await?;
                if import && self.corrupt_import_receipt.swap(false, Ordering::SeqCst) {
                    result["receipt"]["op_id"] = Value::String("wrong-operation".into());
                }
                if commit && self.lose_committed_reply.swap(false, Ordering::SeqCst) {
                    return Err("test committed reply lost".into());
                }
                serde_json::from_value(result).map_err(|e| e.to_string())
            }
        }
    }
    #[allow(dead_code, unused_imports)]
    mod durability {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../src-tauri/src/sumi/durability.rs"));
    }
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    use std::time::Duration;
    use tokio::sync::mpsc;
    use durability::{Create, LocalEdit, DurableEvent};
    async fn fixture() -> (tempfile::TempDir, service::Backend, String, write_core::Document) {
        let temp = tempfile::tempdir().unwrap();
        let worker = crate::durability::Durability::open(temp.path().into(), temp.path().join("state.sqlite3"), |_| {}).await.unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let doc = write_core::Document::new(&id,1,7).unwrap();
        worker.create(Create { page_id:id.clone(), epoch:1, full_state:doc.encode_full(), revision:0, after_id:None,
            first_write_date:None, frontmatter:None, preserved_pair:None }).await.unwrap();
        let backend = service::Backend { worker, lose_committed_reply:Arc::new(AtomicBool::new(false)), unavailable:Arc::new(AtomicBool::new(false)),corrupt_import_receipt:Arc::new(AtomicBool::new(false)) };
        (temp,backend,id,doc)
    }
    fn local(id: &str, doc: &mut write_core::Document, text: &str) -> LocalEdit {
        let update = doc.replace(doc.revision(),doc.body().encode_utf16().count() as u32,0,text,99).unwrap();
        LocalEdit { page_id:id.into(), epoch:1, generation:0, revision:doc.revision(), op_id:uuid::Uuid::new_v4().to_string(),update,first_write_date:Some("2026-11-08".into()) }
    }
    #[tokio::test]
    async fn lost_commit_reply_fails_barrier_then_replays_same_operation() {
        let (_temp,backend,id,mut doc) = fixture().await;
        backend.lose_committed_reply.store(true, Ordering::SeqCst);
        let (events,mut received) = mpsc::unbounded_channel();
        let proxy = durability::Durability::from_backend(backend.clone(), _temp.path().join("host-journal.sqlite3"), move |event| { let _=events.send(event); }).unwrap();
        let permit = proxy.try_reserve_edit().unwrap();
        let edit = local(&id,&mut doc,"只写一次");
        permit.enqueue_local(edit.clone()).unwrap();
        assert!(matches!(received.recv().await.unwrap(),DurableEvent::Failed { .. }));
        assert!(tokio::time::timeout(Duration::from_millis(200), proxy.flush()).await.unwrap().is_err());
        assert_eq!(backend.worker.load(id.clone()).await.unwrap().revision,1);
        assert!(matches!(tokio::time::timeout(Duration::from_secs(2),received.recv()).await.unwrap().unwrap(), DurableEvent::Committed { revision:1,.. }));
        proxy.flush().await.unwrap();
        assert!(proxy.load(id).await.unwrap().raw_markdown.ends_with("只写一次"));
        assert_eq!(backend.worker.outbox().await.unwrap().iter().filter(|v|v.update.op_id==edit.op_id).count(),1);
    }
    #[tokio::test]
    async fn legacy_local_echo_journal_replays_before_appearance_preferences() {
        use sumi_protocol::durability::Request;
        let (temp, backend, id, mut doc) = fixture().await;
        let local = local(&id, &mut doc, "cloud echo must not block appearance");
        let original = backend.worker.commit_local(local.clone()).await.unwrap();
        backend.worker.flush().await.unwrap();
        backend.worker.ack(local.op_id.clone()).await.unwrap();
        drop(backend);
        // Simulate the already-shipped schema: the local receipt survives ACK,
        // while the original host accepted the returned cloud echo at revision+1.
        let database = rusqlite::Connection::open(temp.path().join("state.sqlite3")).unwrap();
        database.execute("DELETE FROM sumi_local_update_identity", []).unwrap();
        drop(database);
        let incoming = write_core::storage::PendingUpdate { op_id:local.op_id.clone(), page_id:id.clone(), epoch:1, update:local.update.clone() };
        let request = Request::CommitRemote { incoming:incoming.clone(), generation:0, revision:local.revision+1 };
        let mut echoed = local.clone(); echoed.revision += 1; echoed.first_write_date = None;
        let receipt = sumi_protocol::durability::edit_receipt(&echoed, true, None).unwrap();
        let payload = serde_json::to_vec(&request).unwrap();
        let journal_path = temp.path().join("host-journal.sqlite3");
        let journal = rusqlite::Connection::open(&journal_path).unwrap();
        journal.execute_batch("CREATE TABLE host_input_journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT,op_id TEXT NOT NULL UNIQUE,payload BLOB NOT NULL,payload_sha256 TEXT NOT NULL,receipt BLOB NOT NULL); PRAGMA user_version=1;").unwrap();
        journal.execute("INSERT INTO host_input_journal(op_id,payload,payload_sha256,receipt) VALUES(?1,?2,?3,?4)",
            rusqlite::params![local.op_id, payload, write_core::storage::sha256(&payload), serde_json::to_vec(&receipt).unwrap()]).unwrap();
        drop(journal);
        let worker = crate::durability::Durability::open(temp.path().into(), temp.path().join("state.sqlite3"), |_| {}).await.unwrap();
        let backend = service::Backend { worker:worker.clone(), lose_committed_reply:Arc::new(AtomicBool::new(false)),
            unavailable:Arc::new(AtomicBool::new(false)), corrupt_import_receipt:Arc::new(AtomicBool::new(false)) };
        let proxy = durability::Durability::from_backend(backend, journal_path.clone(), |_| {}).unwrap();
        let appearance = serde_json::json!({"fontFamily":"Sumi Zhaohua","fontSize":50});
        tokio::time::timeout(Duration::from_secs(2), proxy.set_preferences("appearance".into(), appearance.clone())).await.unwrap().unwrap();
        assert_eq!(proxy.preferences("appearance".into()).await.unwrap(), Some(appearance));
        let loaded = proxy.load(id).await.unwrap();
        assert_eq!(loaded.revision, echoed.revision);
        assert!(loaded.raw_markdown.ends_with("cloud echo must not block appearance"));
        assert_eq!(worker.commit_local(local).await.unwrap(), original);
        assert_eq!(worker.commit_remote(incoming, 0, echoed.revision).await.unwrap(), receipt);
        let journal = rusqlite::Connection::open(journal_path).unwrap();
        assert_eq!(journal.query_row("SELECT COUNT(*) FROM host_input_journal", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
    }

    #[tokio::test]
    async fn permits_bound_pending_edits_and_reserve_before_native_mutation() {
        let (_temp,backend,_id,_doc) = fixture().await;
        let proxy=durability::Durability::from_backend(backend, _temp.path().join("host-journal.sqlite3"), |_|{}).unwrap();
        let permits=(0..256).map(|_|proxy.try_reserve_edit().unwrap()).collect::<Vec<_>>();
        assert!(proxy.try_reserve_edit().is_err());
        drop(permits);
        assert!(proxy.try_reserve_edit().is_ok());
    }
    #[tokio::test]
    async fn unavailable_worker_retains_local_remote_order_and_flush_is_prompt() {
        let (_temp,backend,id,mut doc)=fixture().await;
        backend.unavailable.store(true,Ordering::SeqCst);
        let (events,mut received)=mpsc::unbounded_channel();
        let proxy=durability::Durability::from_backend(backend.clone(), _temp.path().join("host-journal.sqlite3"), move|event|{let _=events.send(event);}).unwrap();
        let first=proxy.try_reserve_edit().unwrap();
        first.enqueue_local(local(&id,&mut doc,"A")).unwrap();
        assert!(matches!(received.recv().await.unwrap(),DurableEvent::Failed {..}));
        let second=proxy.try_reserve_edit().unwrap();
        let remote=local(&id,&mut doc,"中");
        let remote_result=second.enqueue_remote(write_core::storage::PendingUpdate {op_id:remote.op_id,page_id:remote.page_id,epoch:remote.epoch,update:remote.update},0,remote.revision).unwrap();
        let third=proxy.try_reserve_edit().unwrap();
        third.enqueue_local(local(&id,&mut doc,"B")).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(200),proxy.flush()).await.unwrap().is_err());
        backend.unavailable.store(false,Ordering::SeqCst);
        let loaded=tokio::time::timeout(Duration::from_secs(2),remote_result).await.unwrap().unwrap().unwrap();
        assert_eq!(loaded.revision,2);
        proxy.flush().await.unwrap();
        let final_doc=proxy.load(id).await.unwrap();
        assert_eq!(final_doc.revision,3);
        assert!(final_doc.raw_markdown.ends_with("A中B"));
    }
    #[tokio::test]
    async fn continuous_polling_does_not_postpone_the_retry_deadline() {
        let (_temp,backend,id,mut doc)=fixture().await;
        backend.lose_committed_reply.store(true,Ordering::SeqCst);
        let (events,mut received)=mpsc::unbounded_channel();
        let proxy=durability::Durability::from_backend(backend, _temp.path().join("host-journal.sqlite3"), move|event|{let _=events.send(event);}).unwrap();
        proxy.try_reserve_edit().unwrap().enqueue_local(local(&id,&mut doc,"poll")).unwrap();
        assert!(matches!(received.recv().await.unwrap(),DurableEvent::Failed{..}));
        tokio::time::timeout(Duration::from_millis(1500),async {
            loop {
                tokio::select! {
                    event=received.recv()=>if matches!(event,Some(DurableEvent::Committed{..})){break;},
                    _=tokio::time::sleep(Duration::from_millis(20))=>{let _=proxy.list().await;}
                }
            }
        }).await.expect("frequent reads postponed the fixed retry deadline");
        proxy.flush().await.unwrap();
    }
    #[tokio::test]
    async fn reserved_import_rejects_wrong_receipt_and_replays_without_duplicate_apply() {
        let (temp,backend,id,mut doc)=fixture().await;
        backend.worker.commit_local(local(&id,&mut doc,"seed")).await.unwrap();
        backend.worker.flush().await.unwrap();
        let baseline=backend.worker.read_baseline(id.clone()).await.unwrap().unwrap();
        let mut observed=baseline.pair;
        observed.markdown=observed.markdown.replace("seed","seed imported");
        let (md,meta)=write_core::projection::paths(temp.path(),&baseline.filename).unwrap();
        std::fs::write(&md,&observed.markdown).unwrap();std::fs::write(&meta,&observed.metadata).unwrap();
        backend.corrupt_import_receipt.store(true,Ordering::SeqCst);
        let (events,mut received)=mpsc::unbounded_channel();
        let proxy=durability::Durability::from_backend(backend.clone(), temp.path().join("host-journal.sqlite3"), move|event|{let _=events.send(event);}).unwrap();
        let permit=proxy.try_reserve_edit().unwrap();
        let edit=local(&id,&mut doc," imported");
        let op_id=edit.op_id.clone();
        let receiver=permit.enqueue_import(edit,observed).unwrap();
        assert!(receiver.await.unwrap().unwrap_err().contains("回执"));
        assert!(matches!(received.recv().await.unwrap(),DurableEvent::Failed{..}));
        assert!(matches!(tokio::time::timeout(Duration::from_secs(2),received.recv()).await.unwrap().unwrap(),DurableEvent::Committed{revision:2,..}));
        proxy.flush().await.unwrap();
        let loaded=proxy.load(id).await.unwrap();assert_eq!(loaded.revision,2);assert!(loaded.raw_markdown.ends_with("seed imported"));
        assert_eq!(backend.worker.outbox().await.unwrap().iter().filter(|entry|entry.update.op_id==op_id).count(),1);
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct ImportCrashManifest {
        edit: LocalEdit,
        observed: write_core::storage::FilePair,
        expected: write_core::storage::FilePair,
    }
    #[tokio::test]
    #[ignore = "only launched by the isolated journaled-import crash test"]
    async fn journaled_import_crash_child() {
        let directory = std::path::PathBuf::from(std::env::var_os("SUMI_IMPORT_CRASH_DIRECTORY").unwrap());
        let worker = crate::durability::Durability::open(directory.clone(), directory.join("state.sqlite3"), |_| {}).await.unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut doc = write_core::Document::new(&id, 1, 7).unwrap();
        doc.replace(0, 0, 0, "seed", 99).unwrap();
        worker.create(Create { page_id:id.clone(), epoch:1, full_state:doc.encode_full(), revision:1,
            after_id:None, first_write_date:Some("2026-11-09".into()), frontmatter:None, preserved_pair:None }).await.unwrap();
        let baseline = worker.read_baseline(id.clone()).await.unwrap().unwrap();
        let mut observed = baseline.pair.clone();
        observed.markdown = observed.markdown.replace("seed", "seed imported").replacen("type:", "custom: captured\ntype:", 1);
        let mut sidecar: serde_json::Value = serde_json::from_str(&observed.metadata).unwrap();
        sidecar["custom"] = serde_json::json!("captured-extension");
        observed.metadata = sidecar.to_string();
        let (md, meta) = write_core::projection::paths(&directory, &baseline.filename).unwrap();
        std::fs::write(&md, &observed.markdown).unwrap();
        std::fs::write(&meta, &observed.metadata).unwrap();
        let update = match write_core::import::import_external(&mut doc, &baseline.full_state, "seed imported", 300).unwrap() {
            write_core::import::ImportOutcome::Applied { update } => update,
            _ => panic!("expected accepted import"),
        };
        let edit = LocalEdit { page_id:id, epoch:1, generation:0, revision:doc.revision(),
            op_id:uuid::Uuid::new_v4().to_string(), update, first_write_date:Some("2026-11-09".into()) };
        let expected = write_core::storage::serialize_pair(&doc.snapshot().unwrap(), None, None).unwrap();
        let backend = service::Backend { worker, lose_committed_reply:Arc::new(AtomicBool::new(false)),
            unavailable:Arc::new(AtomicBool::new(true)), corrupt_import_receipt:Arc::new(AtomicBool::new(false)) };
        let proxy = durability::Durability::from_backend(backend, directory.join("host-journal.sqlite3"), |_| {}).unwrap();
        let received = proxy.try_reserve_edit().unwrap().enqueue_import(edit.clone(), observed.clone()).unwrap();
        assert!(received.await.unwrap().unwrap_err().contains("transport unavailable"));
        // The operation is already accepted into the durable host journal.
        // A different writer changes both files before backend replay.
        std::fs::write(&md, baseline.pair.markdown.replace("seed", "newer external draft")).unwrap();
        std::fs::write(&meta, b"newer external metadata").unwrap();
        std::fs::write(directory.join("accepted.tmp"), serde_json::to_vec(&ImportCrashManifest { edit, observed, expected }).unwrap()).unwrap();
        std::fs::rename(directory.join("accepted.tmp"), directory.join("accepted.json")).unwrap();
        std::future::pending::<()>().await;
    }
    #[tokio::test]
    async fn journaled_import_survives_host_crash_and_new_external_files_without_blocking_load() {
        let temp = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["host_proxy_harness::journaled_import_crash_child", "--exact", "--ignored", "--nocapture", "--test-threads=1"])
            .env("SUMI_IMPORT_CRASH_DIRECTORY", temp.path()).stdout(std::process::Stdio::null()).spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !temp.path().join("accepted.json").exists() {
            if child.try_wait().unwrap().is_some() { panic!("import crash child exited before journaling"); }
            if std::time::Instant::now() >= deadline { let _=child.kill(); let _=child.wait(); panic!("import child timed out"); }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        child.kill().unwrap(); assert!(!child.wait().unwrap().success());
        let manifest: ImportCrashManifest = serde_json::from_slice(&std::fs::read(temp.path().join("accepted.json")).unwrap()).unwrap();
        let worker = crate::durability::Durability::open(temp.path().into(), temp.path().join("state.sqlite3"), |_| {}).await.unwrap();
        let baseline = worker.read_baseline(manifest.edit.page_id.clone()).await.unwrap().unwrap();
        let (md, meta) = write_core::projection::paths(temp.path(), &baseline.filename).unwrap();
        let external_md = std::fs::read(&md).unwrap(); let external_meta = std::fs::read(&meta).unwrap();
        let backend = service::Backend { worker:worker.clone(), lose_committed_reply:Arc::new(AtomicBool::new(false)),
            unavailable:Arc::new(AtomicBool::new(false)), corrupt_import_receipt:Arc::new(AtomicBool::new(false)) };
        let journal_path = temp.path().join("host-journal.sqlite3");
        let proxy = durability::Durability::from_backend(backend, journal_path.clone(), |_| {}).unwrap();
        // The first normal load automatically follows replay; no manual repair.
        let loaded = tokio::time::timeout(Duration::from_secs(3), proxy.load(manifest.edit.page_id.clone())).await.unwrap().unwrap();
        assert_eq!(loaded.revision, manifest.edit.revision);
        assert!(loaded.raw_markdown.ends_with("seed imported"));
        assert!(loaded.raw_markdown.contains("custom: captured"));
        assert_eq!(loaded.sidecar.extra["custom"], serde_json::json!("captured-extension"));
        let expected = write_core::storage::parse_pair(&manifest.expected.markdown, &manifest.expected.metadata).unwrap();
        assert_eq!(serde_json::to_value(&loaded.sidecar.lines).unwrap(), serde_json::to_value(&expected.sidecar.lines).unwrap());
        let observed = proxy.observe_page(manifest.edit.page_id.clone()).await.unwrap();
        assert!(matches!(observed.files, sumi_protocol::durability::ObservedFiles::External { .. }));
        assert_eq!(std::fs::read(&md).unwrap(), external_md); assert_eq!(std::fs::read(&meta).unwrap(), external_meta);
        let receipt = sumi_protocol::durability::edit_receipt(&manifest.edit, false, Some(&manifest.observed)).unwrap();
        let replay = worker.commit_import(manifest.edit.clone(), manifest.observed.clone()).await.unwrap();
        assert_eq!(replay.receipt, receipt);
        assert_eq!(worker.outbox().await.unwrap().iter().filter(|item| item.update.op_id == manifest.edit.op_id).count(), 1);
        let database = rusqlite::Connection::open(journal_path).unwrap();
        let count: i64 = database.query_row("SELECT COUNT(*) FROM host_input_journal", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0, "exact original import receipt must release the journal head");
        // Ordinary continued typing also remains durable and cannot cover the external draft.
        let mut current = write_core::Document::restore(&manifest.edit.page_id, 1, 987, &loaded.full_state, loaded.revision).unwrap();
        proxy.enqueue_local(local(&manifest.edit.page_id, &mut current, " continued")).unwrap();
        assert!(proxy.load(manifest.edit.page_id.clone()).await.unwrap().raw_markdown.ends_with("seed imported continued"));
        assert!(proxy.flush().await.is_err(), "foreign projection remains blocked independently of durability");
        assert!(proxy.load(manifest.edit.page_id).await.unwrap().raw_markdown.ends_with("seed imported continued"));
        assert_eq!(std::fs::read(md).unwrap(), external_md); assert_eq!(std::fs::read(meta).unwrap(), external_meta);
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct CrashManifest { page: String, op_ids: Vec<String>, body: String }
    #[tokio::test]
    #[ignore = "only launched by isolated host crash recovery tests"]
    async fn durable_proxy_crash_child() {
        let directory = std::path::PathBuf::from(std::env::var_os("SUMI_PROXY_CRASH_DIRECTORY").unwrap());
        let after_commit = std::env::var("SUMI_PROXY_CRASH_AFTER_COMMIT").unwrap() == "1";
        let worker = crate::durability::Durability::open(directory.clone(), directory.join("state.sqlite3"), |_| {}).await.unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut doc = write_core::Document::new(&id, 1, 7).unwrap();
        worker.create(Create { page_id:id.clone(), epoch:1, full_state:doc.encode_full(), revision:0,
            after_id:None, first_write_date:None, frontmatter:None, preserved_pair:None }).await.unwrap();
        let backend = service::Backend { worker, lose_committed_reply:Arc::new(AtomicBool::new(after_commit)),
            unavailable:Arc::new(AtomicBool::new(!after_commit)), corrupt_import_receipt:Arc::new(AtomicBool::new(false)) };
        let (events, mut received) = mpsc::unbounded_channel();
        let proxy = durability::Durability::from_backend(backend, directory.join("host-journal.sqlite3"), move |event| { let _=events.send(event); }).unwrap();
        let edit = local(&id, &mut doc, "宿主强制终止前的输入\n离线也必须保存。");
        let mut op_ids = vec![edit.op_id.clone()];
        proxy.try_reserve_edit().unwrap().enqueue_local(edit).unwrap();
        // A failure in after_commit mode proves the backend committed and its
        // typed receipt was lost, while the host journal remains unacknowledged.
        assert!(matches!(received.recv().await.unwrap(), DurableEvent::Failed { .. }));
        if !after_commit {
            let edit = local(&id, &mut doc, "还未发往后台的第二次输入。");
            op_ids.push(edit.op_id.clone());
            proxy.try_reserve_edit().unwrap().enqueue_local(edit).unwrap();
        }
        let manifest = CrashManifest { page:id, op_ids, body:doc.body() };
        std::fs::write(directory.join("accepted.tmp"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        std::fs::rename(directory.join("accepted.tmp"), directory.join("accepted.json")).unwrap();
        std::future::pending::<()>().await;
    }
    async fn kill_and_recover(after_commit: bool) {
        let temp = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["host_proxy_harness::durable_proxy_crash_child", "--exact", "--ignored", "--nocapture", "--test-threads=1"])
            .env("SUMI_PROXY_CRASH_DIRECTORY", temp.path())
            .env("SUMI_PROXY_CRASH_AFTER_COMMIT", if after_commit { "1" } else { "0" })
            .stdout(std::process::Stdio::null()).spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !temp.path().join("accepted.json").exists() {
            if child.try_wait().unwrap().is_some() { panic!("host crash child exited before acceptance"); }
            if std::time::Instant::now() >= deadline { let _=child.kill(); let _=child.wait(); panic!("host crash child timed out"); }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        child.kill().unwrap(); assert!(!child.wait().unwrap().success());
        let manifest: CrashManifest = serde_json::from_slice(&std::fs::read(temp.path().join("accepted.json")).unwrap()).unwrap();
        let worker = crate::durability::Durability::open(temp.path().into(), temp.path().join("state.sqlite3"), |_| {}).await.unwrap();
        let backend = service::Backend { worker:worker.clone(), lose_committed_reply:Arc::new(AtomicBool::new(false)),
            unavailable:Arc::new(AtomicBool::new(false)), corrupt_import_receipt:Arc::new(AtomicBool::new(false)) };
        let journal_path = temp.path().join("host-journal.sqlite3");
        let proxy = durability::Durability::from_backend(backend, journal_path.clone(), |_| {}).unwrap();
        // No manual flush/recovery call: the first load must be behind replay.
        let recovered = tokio::time::timeout(Duration::from_secs(10), proxy.load(manifest.page)).await.unwrap().unwrap();
        assert_eq!(recovered.revision, manifest.op_ids.len() as u64);
        assert!(recovered.raw_markdown.ends_with(&manifest.body));
        let outbox = worker.outbox().await.unwrap();
        for op_id in &manifest.op_ids { assert_eq!(outbox.iter().filter(|entry| &entry.update.op_id == op_id).count(), 1); }
        let database = rusqlite::Connection::open(journal_path).unwrap();
        let remaining: i64 = database.query_row("SELECT COUNT(*) FROM host_input_journal", [], |r| r.get(0)).unwrap();
        assert_eq!(remaining, 0, "only exact backend durable receipts reclaim the journal");
    }
    #[tokio::test]
    async fn host_sigkill_before_backend_commit_recovers_accepted_input_on_first_load() { kill_and_recover(false).await; }
    #[tokio::test]
    async fn host_sigkill_after_backend_commit_before_ack_replays_exactly_once() { kill_and_recover(true).await; }

}

pub mod sync;
pub mod coordinator;
pub mod network;

pub mod runtime;

pub mod sound;
