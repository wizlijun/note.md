use super::*;
const PAGE: &str = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
fn seed(root: &Path) -> (std::path::PathBuf, FilePair, write_core::Snapshot) {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(0, 0, 0, "first\nsecond", 10).unwrap();
    d.replace(d.revision(), 0, 1, "F", 20).unwrap();
    let snapshot = d.snapshot().unwrap();
    let mut header = serde_yaml::Mapping::new();
    header.insert("author".into(), "kept".into());
    let mut pair = storage::serialize_pair(&snapshot, Some(&header), None).unwrap();
    let mut metadata: Sidecar = serde_json::from_str(&pair.metadata).unwrap();
    metadata
        .extra
        .insert("unknown_extension".into(), serde_json::json!({"keep":true}));
    metadata.lines[0]
        .extra
        .insert("line_extension".into(), serde_json::json!(42));
    pair.metadata = serde_json::to_string(&metadata).unwrap();
    let path = root.join("original.writing.md");
    fs::write(&path, &pair.markdown).unwrap();
    fs::write(path.with_extension("meta.json"), &pair.metadata).unwrap();
    (path, pair, snapshot)
}
#[test]
fn matching_pair_forks_uuid_preserves_times_extensions_and_original_bytes() {
    let root = tempfile::tempdir().unwrap();
    let (path, pair, before) = seed(root.path());
    let p = probe(root.path(), &path).unwrap();
    assert_eq!(p.status, Status::MatchingPair);
    assert!(p.preserve_line_times);
    let id = Uuid::new_v4().to_string();
    let recovered = prepare(root.path(), &p.evidence, &id, false).unwrap();
    let snapshot = recovered.document.snapshot().unwrap();
    assert_eq!(snapshot.page_id, id);
    assert_eq!(snapshot.epoch, 1);
    assert_eq!(snapshot.lines, before.lines);
    let parsed = storage::parse_pair(&recovered.pair.markdown, &recovered.pair.metadata).unwrap();
    assert_eq!(
        parsed.frontmatter[serde_yaml::Value::String("author".into())].as_str(),
        Some("kept")
    );
    assert_eq!(
        parsed.sidecar.extra["unknown_extension"],
        serde_json::json!({"keep":true})
    );
    assert_eq!(parsed.sidecar.lines[0].extra["line_extension"], 42);
    assert!(same_operation(&parsed.frontmatter, &id, &p.evidence));
    assert_eq!(
        fs::read_to_string(path.with_extension("meta.json")).unwrap(),
        pair.metadata
    );
    assert_eq!(fs::read_to_string(path).unwrap(), pair.markdown);
    assert!(prepare(root.path(), &p.evidence, PAGE, false).is_err());
}
#[test]
fn missing_or_damaged_sidecar_recovers_body_without_invented_times() {
    for damage in [None, Some("invalid JSON"), Some("{\"schema\":9000}")] {
        let root = tempfile::tempdir().unwrap();
        let (path, _, before) = seed(root.path());
        if let Some(damage) = damage {
            fs::write(path.with_extension("meta.json"), damage).unwrap()
        } else {
            fs::remove_file(path.with_extension("meta.json")).unwrap()
        }
        let p = probe(root.path(), &path).unwrap();
        assert!(!p.preserve_line_times);
        let result = prepare(root.path(), &p.evidence, &Uuid::new_v4().to_string(), false).unwrap();
        let snapshot = result.document.snapshot().unwrap();
        assert_eq!(snapshot.body, before.body);
        assert!(snapshot
            .lines
            .iter()
            .all(|l| l.first_ms.is_none() && l.last_ms.is_none() && l.time_source == "unknown"));
    }
}
#[test]
fn stale_markdown_metadata_or_late_companion_requires_new_probe() {
    for changed in ["markdown", "metadata", "late"] {
        let root = tempfile::tempdir().unwrap();
        let (path, pair, _) = seed(root.path());
        if changed == "late" {
            fs::remove_file(path.with_extension("meta.json")).unwrap()
        }
        let p = probe(root.path(), &path).unwrap();
        match changed {
            "markdown" => fs::write(&path, format!("{} changed", pair.markdown)).unwrap(),
            "metadata" => fs::write(
                path.with_extension("meta.json"),
                format!("{} ", pair.metadata),
            )
            .unwrap(),
            _ => fs::write(path.with_extension("meta.json"), pair.metadata).unwrap(),
        }
        assert!(prepare(root.path(), &p.evidence, &Uuid::new_v4().to_string(), false).is_err());
    }
}
#[test]
fn crlf_requires_explicit_consent_and_keeps_original_files() {
    let root = tempfile::tempdir().unwrap();
    let (path, pair, before) = seed(root.path());
    let crlf = pair.markdown.replace('\n', "\r\n");
    fs::write(&path, &crlf).unwrap();
    let p = probe(root.path(), &path).unwrap();
    assert!(p.normalize_crlf);
    assert!(p.preserve_line_times);
    assert!(prepare(root.path(), &p.evidence, &Uuid::new_v4().to_string(), false).is_err());
    let result = prepare(root.path(), &p.evidence, &Uuid::new_v4().to_string(), true).unwrap();
    assert_eq!(result.document.snapshot().unwrap().lines, before.lines);
    assert_eq!(fs::read_to_string(path).unwrap(), crlf);
    assert!(!result.document.body().contains('\r'));
}
#[test]
fn moved_markdown_finds_unique_identity_matched_metadata_without_moving_it() {
    for move_directory in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let origin = root.path().join("inbox/writings");
        fs::create_dir_all(&origin).unwrap();
        let (path, pair, before) = seed(&origin);
        let destination = if move_directory {
            let dir = root.path().join("elsewhere");
            fs::create_dir(&dir).unwrap();
            dir.join("renamed.writing.md")
        } else {
            origin.join("renamed.writing.md")
        };
        fs::rename(&path, &destination).unwrap();
        let p = probe(root.path(), &destination).unwrap();
        assert!(p.preserve_line_times);
        assert_eq!(p.metadata_candidates.len(), 1);
        let result = prepare(root.path(), &p.evidence, &Uuid::new_v4().to_string(), false).unwrap();
        assert_eq!(result.document.snapshot().unwrap().lines, before.lines);
        assert_eq!(
            fs::read_to_string(path.with_extension("meta.json")).unwrap(),
            pair.metadata
        );
        assert!(destination.exists());
    }
}
#[test]
fn ambiguous_metadata_candidates_are_not_guessed() {
    let root = tempfile::tempdir().unwrap();
    let (path, pair, _) = seed(root.path());
    let renamed = root.path().join("moved.writing.md");
    fs::rename(&path, &renamed).unwrap();
    fs::write(root.path().join("copy.writing.meta.json"), pair.metadata).unwrap();
    let p = probe(root.path(), &renamed).unwrap();
    assert_eq!(p.metadata_candidates.len(), 2);
    assert_eq!(p.status, Status::DamagedMetadata);
    assert!(!p.preserve_line_times);
    let result = prepare(root.path(), &p.evidence, &Uuid::new_v4().to_string(), false).unwrap();
    assert!(result
        .document
        .snapshot()
        .unwrap()
        .lines
        .iter()
        .all(|l| l.first_ms.is_none()));
    assert!(root.path().join("copy.writing.meta.json").exists());
    assert!(path.with_extension("meta.json").exists());
}
#[test]
fn malformed_frontmatter_keeps_entire_source_and_operation_binding_is_exact() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("bad.writing.md");
    let raw = "---\n[broken:\n---\nall original text";
    fs::write(&path, raw).unwrap();
    let p = probe(root.path(), &path).unwrap();
    let id = Uuid::new_v4().to_string();
    let result = prepare(root.path(), &p.evidence, &id, false).unwrap();
    assert_eq!(result.document.body(), raw);
    let parsed = storage::parse_pair(&result.pair.markdown, &result.pair.metadata).unwrap();
    assert!(same_operation(&parsed.frontmatter, &id, &p.evidence));
    let mut changed = p.evidence.clone();
    changed.markdown_sha256 = "different".into();
    assert!(!same_operation(&parsed.frontmatter, &id, &changed));
    assert!(!same_operation(
        &parsed.frontmatter,
        &Uuid::new_v4().to_string(),
        &p.evidence
    ));
}
#[test]
fn foreign_vault_and_symlink_sources_cannot_be_recovered() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (path, _, _) = seed(outside.path());
    assert!(probe(root.path(), &path).is_err());
    let p = probe(outside.path(), &path).unwrap();
    assert!(prepare(root.path(), &p.evidence, &Uuid::new_v4().to_string(), false).is_err());
    #[cfg(unix)]
    {
        let link = root.path().join("alias.writing.md");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(probe(root.path(), &link).is_err());
    }
}

#[tokio::test]
async fn recovered_pair_and_operation_marker_survive_sqlite_reopen_without_duplicate_create() {
    use super::super::durability::{Create, Durability};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    fs::create_dir(&root).unwrap();
    let database = temp.path().join("sumi.sqlite3");
    let (path, source, expected) = seed(&root);
    let evidence = probe(&root, &path).unwrap().evidence;
    let id = Uuid::new_v4().to_string();
    let prepared = prepare(&root, &evidence, &id, false).unwrap();
    let durable = Durability::open(root.clone(), database.clone(), |_| {})
        .await
        .unwrap();
    let created = durable
        .create(Create {
            page_id: id.clone(),
            epoch: 1,
            full_state: prepared.document.encode_full(),
            revision: prepared.document.revision(),
            after_id: None,
            first_write_date: Some("2026-11-07".into()),
            frontmatter: None,
            preserved_pair: Some(prepared.pair),
        })
        .await
        .unwrap();
    assert!(same_operation(&created.frontmatter, &id, &evidence));
    let restored = Document::restore(&id, 1, 99, &created.full_state, created.revision).unwrap();
    assert_eq!(restored.snapshot().unwrap().lines, expected.lines);
    assert_eq!(durable.list().await.unwrap().len(), 1);
    let baseline = durable.read_baseline(id.clone()).await.unwrap().unwrap();
    assert_eq!(baseline.pair.markdown, created.raw_markdown);
    drop(durable);
    let reopened = Durability::open(root.clone(), database, |_| {})
        .await
        .unwrap();
    let retried = reopened.load(id.clone()).await.unwrap();
    assert!(same_operation(&retried.frontmatter, &id, &evidence));
    assert!(!same_operation(
        &retried.frontmatter,
        &Uuid::new_v4().to_string(),
        &evidence
    ));
    assert_eq!(reopened.list().await.unwrap().len(), 1);
    assert_eq!(retried.raw_markdown, created.raw_markdown);
    assert_eq!(fs::read_to_string(&path).unwrap(), source.markdown);
    assert_eq!(
        fs::read_to_string(path.with_extension("meta.json")).unwrap(),
        source.metadata
    );
}

#[tokio::test]
async fn recovered_empty_page_is_durable_without_a_fake_filename_or_time() {
    use super::super::durability::{Create, Durability};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    fs::create_dir(&root).unwrap();
    let path = root.join("empty.md");
    fs::write(&path, "").unwrap();
    let evidence = probe(&root, &path).unwrap().evidence;
    let id = Uuid::new_v4().to_string();
    let prepared = prepare(&root, &evidence, &id, false).unwrap();
    let durable = Durability::open(root, temp.path().join("sumi.sqlite3"), |_| {})
        .await
        .unwrap();
    let created = durable
        .create(Create {
            page_id: id.clone(),
            epoch: 1,
            full_state: prepared.document.encode_full(),
            revision: prepared.document.revision(),
            after_id: None,
            first_write_date: None,
            frontmatter: None,
            preserved_pair: Some(prepared.pair),
        })
        .await
        .unwrap();
    assert!(same_operation(&created.frontmatter, &id, &evidence));
    assert!(created.entry.filename().is_none());
    assert!(durable.read_baseline(id).await.unwrap().is_none());
    assert!(created
        .sidecar
        .lines
        .iter()
        .all(|line| line.first_written_at.is_none() && line.last_written_at.is_none()));
    assert_eq!(fs::read_to_string(path).unwrap(), "");
}
