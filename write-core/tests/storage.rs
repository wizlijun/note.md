use write_core::storage::*;
use write_core::{Document, Error};
const PAGE: &str = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
#[test]
fn portable_pair_preserves_bytes_and_rejects_stale() {
    for text in [
        "",
        "a\n",
        "a\n\n",
        "a  \nb",
        "```\n<!--user-->\n```",
        "中😀\t ",
    ] {
        let mut d = Document::new(PAGE, 1, 1).unwrap();
        d.replace(d.revision(), 0, 0, text, 1).unwrap();
        let pair = serialize_pair(&d.snapshot().unwrap(), None, None).unwrap();
        assert_eq!(
            parse_pair(&pair.markdown, &pair.metadata).unwrap().body,
            text
        );
        assert!(parse_pair(&(pair.markdown + "x"), &pair.metadata).is_err());
    }
}
#[test]
fn durable_outbox_and_catalog_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    let u = d.replace(d.revision(), 0, 0, "saved\ntext", 10).unwrap();
    let pair = serialize_pair(&d.snapshot().unwrap(), None, None).unwrap();
    let mut store = Store::open(&path).unwrap();
    store
        .transaction(|t| {
            t.execute_batch("CREATE TABLE catalog(id TEXT PRIMARY KEY)")
                .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(store
        .commit_local_with(&d, "failure", &u, &pair, |t| {
            t.execute("INSERT INTO catalog VALUES(?1)", [PAGE]).unwrap();
            Err(Error::Invalid("injected".into()))
        })
        .is_err());
    assert!(store.load(PAGE, 2).is_err());
    assert!(store.outbox().unwrap().is_empty());
    store
        .transaction(|t| {
            assert_eq!(
                t.query_row("SELECT count(*) FROM catalog", [], |r| r.get::<_, u32>(0))
                    .unwrap(),
                0
            );
            Ok(())
        })
        .unwrap();
    store
        .commit_local_with(&d, "operation", &u, &pair, |t| {
            t.execute("INSERT INTO catalog VALUES(?1)", [PAGE]).unwrap();
            Ok(())
        })
        .unwrap();
    drop(store);
    let mut store = Store::open(path).unwrap();
    assert_eq!(store.load(PAGE, 2).unwrap().revision(), d.revision());
    assert_eq!(
        store.load(PAGE, 2).unwrap().snapshot().unwrap().lines,
        d.snapshot().unwrap().lines
    );
    assert_eq!(store.outbox().unwrap().len(), 1);
    store
        .transaction(|t| {
            assert_eq!(
                t.query_row("PRAGMA synchronous", [], |r| r.get::<_, u32>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                t.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "wal"
            );
            Ok(())
        })
        .unwrap();
    store.ack("operation").unwrap();
    assert!(store.outbox().unwrap().is_empty());
}
#[test]
fn inbox_survives_reopen_and_id_reuse_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let store = Store::open(&path).unwrap();
    let mut p = PendingUpdate {
        op_id: "op".into(),
        page_id: PAGE.into(),
        epoch: 1,
        update: vec![0, 0],
    };
    store.receive(&p).unwrap();
    store.receive(&p).unwrap();
    drop(store);
    let store = Store::open(path).unwrap();
    assert_eq!(store.pending_inbox(PAGE).unwrap().len(), 1);
    p.update.push(1);
    assert!(store.receive(&p).is_err());
}
#[test]
fn committed_projection_rejects_forged_line_time() {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    let update = d.replace(d.revision(), 0, 0, "text", 10).unwrap();
    let mut pair = serialize_pair(&d.snapshot().unwrap(), None, None).unwrap();
    let mut meta: Sidecar = serde_json::from_str(&pair.metadata).unwrap();
    meta.lines[0].first_written_at = Some("1970-01-01T00:00:00.011Z".into());
    pair.metadata = serde_json::to_string(&meta).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("state.db")).unwrap();
    assert!(store.commit_local(&d, "wrong", &update, &pair).is_err());
    assert!(store.load(PAGE, 2).is_err());
    assert!(store.outbox().unwrap().is_empty());
}

#[test]
fn portable_recovery_requires_fork_and_preserves_metadata() {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "recover\n", 42).unwrap();
    let pair = serialize_pair(&d.snapshot().unwrap(), None, None).unwrap();
    assert!(fork_pair(&pair, PAGE, 3).is_err());
    let restored = fork_pair(&pair, "80560b45-622d-47e2-a34e-38f9fa0d6b49", 3).unwrap();
    assert_eq!(
        restored.snapshot().unwrap().lines,
        d.snapshot().unwrap().lines
    );
}

fn seeded_store(path: &std::path::Path) -> (Store, Document) {
    let mut store = Store::open(path).unwrap();
    let mut doc = Document::new(PAGE, 1, 1).unwrap();
    let update = doc.replace(doc.revision(), 0, 0, "safe", 10).unwrap();
    let pair = serialize_pair(&doc.snapshot().unwrap(), None, None).unwrap();
    store.commit_local(&doc, "seed", &update, &pair).unwrap();
    (store, doc)
}
#[test]
fn delta_commit_is_atomic_and_reopens_without_projection_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("delta.db");
    let (mut store, mut doc) = seeded_store(&path);
    store
        .transaction(|tx| {
            tx.execute_batch("CREATE TABLE marker(value TEXT)").unwrap();
            Ok(())
        })
        .unwrap();
    let update = doc.replace(doc.revision(), 4, 0, "!", 20).unwrap();
    assert!(store
        .commit_local_delta_with(PAGE, 1, doc.revision(), "delta", &update, |tx| {
            tx.execute("INSERT INTO marker VALUES('rollback')", [])
                .unwrap();
            Err(Error::Invalid("injected".into()))
        })
        .is_err());
    assert_eq!(store.load(PAGE, 2).unwrap().body(), "safe");
    assert_eq!(store.outbox().unwrap().len(), 1);
    store
        .transaction(|tx| {
            assert_eq!(
                tx.query_row("SELECT count(*) FROM marker", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            Ok(())
        })
        .unwrap();
    store
        .commit_local_delta_with(PAGE, 1, doc.revision(), "delta", &update, |_| Ok(()))
        .unwrap();
    assert!(store
        .commit_local_delta_with(PAGE, 1, doc.revision(), "duplicate", &update, |_| Ok(()))
        .is_err());
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let loaded = store.load(PAGE, 2).unwrap();
    assert_eq!(loaded.snapshot().unwrap(), doc.snapshot().unwrap());
    assert_eq!(store.outbox().unwrap().len(), 2);
    store
        .transaction(|tx| {
            assert_eq!(
                tx.query_row("SELECT revision FROM documents", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        })
        .unwrap();
}
#[test]
fn remote_delta_requires_exact_received_bytes_and_rolls_back_applied_flag() {
    let dir = tempfile::tempdir().unwrap();
    let (mut store, mut doc) = seeded_store(&dir.path().join("delta.db"));
    let mut peer = Document::load(PAGE, 1, 2, &doc.encode_full()).unwrap();
    let update = peer.replace(peer.revision(), 0, 0, "REMOTE", 20).unwrap();
    doc.apply_remote(&update).unwrap();
    let incoming = PendingUpdate {
        op_id: "remote".into(),
        page_id: PAGE.into(),
        epoch: 1,
        update: update.clone(),
    };
    store.receive(&incoming).unwrap();
    assert!(store
        .commit_remote_delta_with(PAGE, 1, doc.revision(), "remote", &[0, 0], |_| Ok(()))
        .is_err());
    assert!(store
        .commit_remote_delta_with(PAGE, 1, doc.revision(), "remote", &update, |_| Err(
            Error::Invalid("injected".into())
        ))
        .is_err());
    assert_eq!(store.pending_inbox(PAGE).unwrap().len(), 1);
    assert_eq!(store.load(PAGE, 3).unwrap().body(), "safe");
    store
        .commit_remote_delta_with(PAGE, 1, doc.revision(), "remote", &update, |_| Ok(()))
        .unwrap();
    assert!(store.pending_inbox(PAGE).unwrap().is_empty());
    assert_eq!(
        store.load(PAGE, 3).unwrap().snapshot().unwrap(),
        doc.snapshot().unwrap()
    );
    assert!(
        store.load(PAGE, 2).is_err(),
        "actor in delta tail must not be reused"
    );
}
#[test]
fn checkpoint_prunes_only_atomically_and_full_commit_covers_prior_deltas() {
    let dir = tempfile::tempdir().unwrap();
    let (mut store, mut doc) = seeded_store(&dir.path().join("delta.db"));
    let stale = Document::restore(PAGE, 1, 2, &doc.encode_full(), doc.revision()).unwrap();
    let update = doc.replace(doc.revision(), 4, 0, "!", 20).unwrap();
    store
        .commit_local_delta_with(PAGE, 1, doc.revision(), "delta", &update, |_| Ok(()))
        .unwrap();
    let pair = serialize_pair(&doc.snapshot().unwrap(), None, None).unwrap();
    assert!(store
        .checkpoint_with(&doc, &pair, |_| Err(Error::Invalid("injected".into())))
        .is_err());
    store
        .transaction(|tx| {
            assert_eq!(
                tx.query_row("SELECT count(*) FROM document_deltas", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        })
        .unwrap();
    let oldpair = serialize_pair(&stale.snapshot().unwrap(), None, None).unwrap();
    assert!(store.checkpoint_with(&stale, &oldpair, |_| Ok(())).is_err());
    store.checkpoint_with(&doc, &pair, |_| Ok(())).unwrap();
    store
        .transaction(|tx| {
            assert_eq!(
                tx.query_row("SELECT count(*) FROM document_deltas", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(store.outbox().unwrap().len(), 2);
    let update = doc.replace(doc.revision(), 5, 0, "A", 30).unwrap();
    store
        .commit_local_delta_with(PAGE, 1, doc.revision(), "more", &update, |_| Ok(()))
        .unwrap();
    let update = doc.replace(doc.revision(), 6, 0, "B", 40).unwrap();
    let pair = serialize_pair(&doc.snapshot().unwrap(), None, None).unwrap();
    store.commit_local(&doc, "full", &update, &pair).unwrap();
    assert_eq!(
        store.load(PAGE, 3).unwrap().snapshot().unwrap(),
        doc.snapshot().unwrap()
    );
    store
        .transaction(|tx| {
            assert_eq!(
                tx.query_row("SELECT count(*) FROM document_deltas", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            Ok(())
        })
        .unwrap();
}
#[test]
fn malformed_or_missing_durable_tail_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let (mut store, mut doc) = seeded_store(&dir.path().join("delta.db"));
    for (i, text) in ["A", "B"].into_iter().enumerate() {
        let update = doc
            .replace(doc.revision(), 4, 0, text, 20 + i as i64)
            .unwrap();
        store
            .commit_local_delta_with(PAGE, 1, doc.revision(), text, &update, |_| Ok(()))
            .unwrap();
    }
    store
        .transaction(|tx| {
            tx.execute("DELETE FROM document_deltas WHERE revision=2", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(store.load(PAGE, 2).is_err());
    store
        .transaction(|tx| {
            tx.execute(
                "UPDATE document_deltas SET revision=2,update_blob=x'ff'",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(store.load(PAGE, 2).is_err());
}
#[test]
fn delta_crash_child() {
    let Ok(path) = std::env::var("SUMI_DELTA_CRASH_DB") else {
        return;
    };
    let (mut store, mut doc) = seeded_store(std::path::Path::new(&path));
    store
        .transaction(|tx| {
            tx.execute_batch("CREATE TABLE marker(value TEXT)").unwrap();
            Ok(())
        })
        .unwrap();
    let update = doc.replace(doc.revision(), 4, 0, "!", 20).unwrap();
    store
        .commit_local_delta_with(PAGE, 1, doc.revision(), "delta", &update, |tx| {
            tx.execute("INSERT INTO marker VALUES('committed')", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    if std::env::var("SUMI_DELTA_CRASH_MODE").unwrap() == "checkpoint" {
        let pair = serialize_pair(&doc.snapshot().unwrap(), None, None).unwrap();
        store
            .checkpoint_with(&doc, &pair, |tx| {
                tx.execute("INSERT INTO marker VALUES('uncommitted')", [])
                    .unwrap();
                std::process::exit(17)
            })
            .unwrap();
    }
    // Process exit deliberately skips Store/Connection destructors and normal
    // WAL close/checkpoint. The parent must recover durable journal entries.
    std::process::exit(17)
}
#[test]
fn abrupt_process_exit_recovers_committed_delta_and_rolls_back_partial_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    for mode in ["delta", "checkpoint"] {
        let path = dir.path().join(format!("{mode}.db"));
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "delta_crash_child", "--nocapture"])
            .env("SUMI_DELTA_CRASH_DB", &path)
            .env("SUMI_DELTA_CRASH_MODE", mode)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(17));
        let mut store = Store::open(&path).unwrap();
        let loaded = store.load(PAGE, 2).unwrap();
        assert_eq!(loaded.body(), "safe!");
        assert_eq!(loaded.revision(), 2);
        assert_eq!(loaded.snapshot().unwrap().lines[0].first_ms, Some(10));
        assert_eq!(loaded.snapshot().unwrap().lines[0].last_ms, Some(20));
        assert_eq!(store.outbox().unwrap().len(), 2);
        store
            .transaction(|tx| {
                assert_eq!(
                    tx.query_row("SELECT count(*) FROM marker", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    1
                );
                assert_eq!(
                    tx.query_row("SELECT revision FROM documents", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    1
                );
                Ok(())
            })
            .unwrap();
    }
}
