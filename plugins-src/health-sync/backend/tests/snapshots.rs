use notemd_health_sync::{
    cli,
    providers::{CollectionResult, FetchReport, ProviderRecord},
    store::{hash, QueryFilter, Store},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

struct Fixture {
    root: tempfile::TempDir,
    vault: PathBuf,
    state: PathBuf,
    file: PathBuf,
    store: Store,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path().join("vault");
        let state = root.path().join("state");
        let file = root.path().join("export.xml");
        fs::create_dir(&vault).unwrap();
        fs::create_dir(&state).unwrap();
        let store = Store::new(&vault, &state).unwrap();
        Self {
            root,
            vault,
            state,
            file,
            store,
        }
    }
    fn write(&self, body: &str) {
        fs::write(&self.file,format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><HealthData locale=\"zh_CN\"><ExportDate value=\"2026-10-24 12:00:00 +0900\"/>{body}</HealthData>")).unwrap();
    }
    fn import(&self) -> notemd_health_sync::store::Report {
        self.store.import(&self.file, false, &mut |_| {}).unwrap()
    }
}
fn record(day: &str, value: &str, source: &str) -> String {
    format!("<Record type=\"HKQuantityTypeIdentifierHeartRate\" sourceName=\"{source}\" unit=\"count/min\" startDate=\"{day} 23:00:00 -0700\" endDate=\"{day} 23:01:00 -0700\" value=\"{value}\"><MetadataEntry key=\"method\" value=\"sensor\"/></Record>")
}
fn tree(path: &Path) -> BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
    fn visit(root: &Path, p: &Path, out: &mut BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)>) {
        for entry in fs::read_dir(p).unwrap() {
            let p = entry.unwrap().path();
            if p.is_dir() {
                visit(root, &p, out)
            } else {
                out.insert(
                    p.strip_prefix(root).unwrap().into(),
                    (
                        fs::read(&p).unwrap(),
                        fs::metadata(&p).unwrap().modified().unwrap(),
                    ),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(path, path, &mut out);
    out
}

#[test]
fn repeated_input_changes_no_bytes_or_mtimes_and_preserves_multiplicity() {
    let f = Fixture::new();
    let row = record("2020-01-02", "60", "Watch");
    f.write(&(row.clone() + &row));
    let first = f.import();
    assert!(first.complete);
    assert_eq!(first.record_count, 2);
    let before = tree(f.root.path());
    let second = f.import();
    assert!(!second.data_changed);
    assert_eq!(tree(f.root.path()), before);
    let q = f.store.query(None, None, None, 1, 0).unwrap();
    assert!(q["has_more"].as_bool().unwrap());
    let q2 = f.store.query(None, None, None, 1, 1).unwrap();
    assert_eq!(q["records"], q2["records"]);
    assert_eq!(q2["has_more"], false);
    assert_eq!(q["records"][0]["day"], "2020-01-02");
}

#[test]
fn revisions_removals_and_order_changes_use_snapshot_membership() {
    let f = Fixture::new();
    let a = record("2020-01-01", "60", "Watch");
    let b = record("2020-01-02", "61", "Watch");
    f.write(&(a.clone() + &b));
    f.import();
    let old = f.store.manifest().unwrap().unwrap();
    f.write(&(b.clone() + &a));
    let reorder = f.import();
    assert_eq!(reorder.changed_days, 0);
    f.write(&record("2020-01-01", "62", "Watch"));
    let update = f.import();
    assert_eq!(update.changed_days, 2);
    assert_eq!(update.record_count, 1);
    let new = f.store.manifest().unwrap().unwrap();
    assert_eq!(new.days["2020-01-02"].record_count, 0);
    let old_path = f.vault.join(format!(
        "health/data/2020-01-01/{}",
        old.days["2020-01-01"].shards[0].filename()
    ));
    assert!(old_path.exists());
    assert_eq!(
        f.store.query(None, None, None, 100, 0).unwrap()["records"][0]["attributes"]["value"],
        "62"
    );
    assert!(
        fs::read_to_string(f.vault.join("health/daily/2020-01-02-health.md"))
            .unwrap()
            .contains("记录数：0")
    );
}

#[test]
fn dry_run_and_bad_exports_never_activate_or_remember() {
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    assert!(f.store.import(&f.file, true, &mut |_| {}).unwrap().dry_run);
    assert!(!f.vault.join("health").exists());
    assert_eq!(f.store.status().unwrap()["source_file"], Value::Null);
    f.import();
    let before = tree(&f.vault);
    for bad in ["<HealthData><ExportDate value=\"x\"/><Record", "<HealthData><Record/></HealthData>", "<other/>","<!DOCTYPE HealthData [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><HealthData>&x;</HealthData>"] {
        fs::write(&f.file,bad).unwrap();assert!(f.store.import(&f.file,false,&mut |_|{}).is_err());assert_eq!(tree(&f.vault),before);
    }
}

#[test]
fn manual_summaries_survive_and_pending_generation_recovers() {
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    f.import();
    let summary = f.vault.join("health/daily/2020-01-01-health.md");
    fs::write(&summary, "my handwritten note").unwrap();
    let sidecar = f.vault.join("health/daily/2020-01-01-health.note.md");
    fs::write(&sidecar, "annotation").unwrap();
    f.write(&record("2020-01-01", "65", "Watch"));
    let r = f.import();
    assert!(!r.complete);
    assert_eq!(r.summary_conflicts.len(), 1);
    assert_eq!(fs::read_to_string(&summary).unwrap(), "my handwritten note");
    assert_eq!(fs::read_to_string(sidecar).unwrap(), "annotation");
    assert_eq!(
        f.store.query(None, None, None, 10, 0).unwrap()["records"][0]["attributes"]["value"],
        "65"
    );
    fs::remove_file(&summary).unwrap();
    let retry = f.import();
    assert!(retry.complete);
    assert!(!retry.data_changed);
    assert!(fs::read_to_string(summary).unwrap().contains("65"));
}

#[test]
fn unchanged_days_and_sources_stay_separate() {
    let f = Fixture::new();
    let a = record("2020-01-01", "60", "Watch");
    let b = record("2020-01-02", "62", "Oura");
    f.write(&(a.clone() + &b));
    f.import();
    let first = f.store.manifest().unwrap().unwrap();
    let before = tree(&f.vault);
    f.write(&(a + &record("2020-01-02", "64", "Oura") + &record("2020-01-02", "65", "Watch")));
    let r = f.import();
    assert_eq!(r.changed_days, 1);
    assert_eq!(r.unchanged_days, 1);
    let after = tree(&f.vault);
    for (p, v) in &before {
        if p.to_string_lossy().contains("2020-01-01") {
            assert_eq!(after.get(p), Some(v));
        }
    }
    assert_eq!(
        f.store.manifest().unwrap().unwrap().days["2020-01-01"].sha256,
        first.days["2020-01-01"].sha256
    );
    let summary = fs::read_to_string(f.vault.join("health/daily/2020-01-02-health.md")).unwrap();
    assert!(summary.contains("| Oura |"));
    assert!(summary.contains("| Watch |"));
    let q = f
        .store
        .query(
            Some("2020-01-02"),
            Some("2020-01-02"),
            Some("HKQuantityTypeIdentifierHeartRate"),
            100,
            0,
        )
        .unwrap();
    assert_eq!(q["records"].as_array().unwrap().len(), 2);
}

#[test]
fn sync_uses_remembered_path_and_rejects_concurrent_writer() {
    use fs2::FileExt;
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    f.import();
    f.write(&record("2020-01-02", "61", "Watch"));
    assert_eq!(
        f.store.sync(None, false, &mut |_| {}).unwrap().record_count,
        1
    );
    let key = hash(f.vault.canonicalize().unwrap().to_string_lossy().as_bytes());
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.state.join(key).join("write.lock"))
        .unwrap();
    lock.try_lock_exclusive().unwrap();
    assert!(f
        .store
        .sync(None, false, &mut |_| {})
        .unwrap_err()
        .contains("busy"));
}

#[test]
fn missing_shards_are_rebuilt_corrupt_shards_fail_closed() {
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    f.import();
    let m = f.store.manifest().unwrap().unwrap();
    let path = f.vault.join(format!(
        "health/data/2020-01-01/{}",
        m.days["2020-01-01"].shards[0].filename()
    ));
    fs::remove_file(&path).unwrap();
    assert!(f.import().complete);
    assert!(path.exists());
    fs::write(&path, "corrupt").unwrap();
    assert!(f
        .store
        .import(&f.file, false, &mut |_| {})
        .unwrap_err()
        .contains("Corrupt"));
    assert!(f.store.query(None, None, None, 10, 0).is_err());
}

#[test]
fn refuses_unowned_directory_and_symlink_escape() {
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    fs::create_dir(f.vault.join("health")).unwrap();
    fs::write(f.vault.join("health/existing.md"), "mine").unwrap();
    assert!(f
        .store
        .import(&f.file, false, &mut |_| {})
        .unwrap_err()
        .contains("already contains"));
    assert_eq!(
        fs::read_to_string(f.vault.join("health/existing.md")).unwrap(),
        "mine"
    );
    #[cfg(unix)]
    {
        let f = Fixture::new();
        f.write(&record("2020-01-01", "60", "Watch"));
        let outside = f.root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, f.vault.join("health")).unwrap();
        assert!(f
            .store
            .import(&f.file, false, &mut |_| {})
            .unwrap_err()
            .contains("symlink"));
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    }
}

#[test]
fn host_command_context_calls_same_engine() {
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    let result = cli::run_with_store(
        &f.store,
        "import",
        &json!({"cli":{"args":{"file":f.file},"flags":{"dry-run":true}}}),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(result["dry_run"], true);
    assert!(!f.vault.join("health").exists());
}

#[test]
fn failed_shard_publication_leaves_previous_manifest_active() {
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    f.import();
    let manifest = fs::read(f.vault.join("health/manifest.json")).unwrap();
    let blocker = f.vault.join("health/data/2020-01-02");
    fs::write(&blocker, "unrelated file").unwrap();
    f.write(&(record("2020-01-01", "65", "Watch") + &record("2020-01-02", "70", "Watch")));
    assert!(f.store.import(&f.file, false, &mut |_| {}).is_err());
    assert_eq!(
        fs::read(f.vault.join("health/manifest.json")).unwrap(),
        manifest
    );
    assert_eq!(
        f.store.query(None, None, None, 10, 0).unwrap()["records"][0]["attributes"]["value"],
        "60"
    );
    fs::remove_file(blocker).unwrap();
    assert!(f.import().complete);
    assert_eq!(
        f.store.query(None, None, None, 10, 0).unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn equivalent_zip_reuses_xml_shards_and_empty_snapshot_retires_days() {
    use std::io::Write;
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    f.import();
    let before = tree(&f.vault);
    let zip_path = f.root.path().join("export.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
    zip.start_file(
        "apple_health_export/export.xml",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(&fs::read(&f.file).unwrap()).unwrap();
    zip.finish().unwrap();
    let r = f.store.import(&zip_path, false, &mut |_| {}).unwrap();
    assert_eq!(r.changed_days, 0);
    let after = tree(&f.vault);
    for (p, value) in before {
        if p != Path::new("health/manifest.json") {
            assert_eq!(after.get(&p), Some(&value));
        }
    }
    f.write("");
    let r = f.import();
    assert_eq!(r.record_count, 0);
    assert_eq!(
        f.store.status().unwrap()["manifest"]["first_day"],
        Value::Null
    );
    assert!(f.store.query(None, None, None, 10, 0).unwrap()["records"]
        .as_array()
        .unwrap()
        .is_empty());
}

fn supplement(source: &str, collection: &str, day: &str, value: i64) -> ProviderRecord {
    ProviderRecord {
        source: source.into(),
        collection: collection.into(),
        day: day.into(),
        id: Some(format!("{collection}-{day}")),
        data: json!({"id":format!("{collection}-{day}"),"value":value}),
    }
}
fn apply(
    f: &Fixture,
    source: &str,
    since: &str,
    until: &str,
    rows: &[ProviderRecord],
    statuses: &[(&str, &str)],
    dry: bool,
) -> Result<notemd_health_sync::store::Report, String> {
    let path = f.root.path().join("provider-staged.jsonl");
    let content: String = rows
        .iter()
        .map(|r| format!("{}\n", serde_json::to_string(r).unwrap()))
        .collect();
    fs::write(&path, content).unwrap();
    let report = FetchReport {
        source: source.into(),
        since: since.into(),
        until: until.into(),
        collections: statuses
            .iter()
            .map(|(name, status)| CollectionResult {
                collection: (*name).into(),
                status: (*status).into(),
                records: rows.iter().filter(|r| r.collection == *name).count() as u64,
                error: if *status == "complete" {
                    None
                } else {
                    Some("Synthetic provider error".into())
                },
            })
            .collect(),
    };
    f.store.apply_provider(&path, &report, dry, &mut |_| {})
}

#[test]
fn one_daily_ssot_preserves_apple_and_both_provider_memberships() {
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    f.import();
    apply(
        &f,
        "oura",
        "2020-01-01",
        "2020-01-01",
        &[supplement("oura", "daily_sleep", "2020-01-01", 987654)],
        &[("daily_sleep", "complete")],
        false,
    )
    .unwrap();
    apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &[supplement("garmin", "hrv", "2020-01-01", 123)],
        &[("hrv", "complete")],
        false,
    )
    .unwrap();
    let m = f.store.manifest().unwrap().unwrap();
    assert_eq!(m.record_count, 3);
    assert_eq!(m.days.len(), 1);
    assert_eq!(m.days["2020-01-01"].shards.len(), 3);
    let oura = m.days["2020-01-01"]
        .shards
        .iter()
        .find(|s| s.source == "oura")
        .unwrap();
    assert!(oura.filename().starts_with("oura-daily-sleep-"));
    let slug = notemd_health_sync::catalog::metric_slug(&oura.metric);
    assert!(oura
        .filename()
        .contains(&format!("-{}-", &slug[slug.len() - 12..])));
    assert_eq!(
        fs::read_dir(f.vault.join("health/daily")).unwrap().count(),
        1
    );
    let text = fs::read_to_string(f.vault.join("health/daily/2020-01-01-health.md")).unwrap();
    assert!(text.contains("oura.daily_sleep"));
    assert!(text.contains("garmin.hrv"));
    assert!(!text.contains("987654"));
    assert!(m.days["2020-01-01"]
        .shards
        .iter()
        .all(|s| s.filename().contains(&s.source) && s.filename().len() < 255));
    // An identical Apple import sees the same Apple fingerprint while retaining supplements.
    assert!(!f.import().data_changed);
    f.write(&record("2020-01-01", "70", "Watch"));
    assert_eq!(f.import().record_count, 3);
    f.write("");
    assert_eq!(f.import().record_count, 2);
    let q = f.store.query(None, None, None, 100, 0).unwrap();
    assert!(q["records"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["ingest_source"] != "apple-health"));
    assert_eq!(
        q["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["ingest_source"] == "oura")
            .unwrap()["payload"]["value"],
        987654
    );
}

#[test]
fn provider_window_revisions_preserve_other_days_and_repeat_without_writes() {
    let f = Fixture::new();
    let rows = [
        supplement("oura", "daily_sleep", "2020-01-01", 1),
        supplement("oura", "daily_sleep", "2020-01-02", 2),
    ];
    apply(
        &f,
        "oura",
        "2020-01-01",
        "2020-01-02",
        &rows,
        &[("daily_sleep", "complete")],
        false,
    )
    .unwrap();
    let before = tree(&f.vault);
    let repeated = apply(
        &f,
        "oura",
        "2020-01-01",
        "2020-01-02",
        &rows,
        &[("daily_sleep", "complete")],
        false,
    )
    .unwrap();
    assert!(!repeated.data_changed);
    assert_eq!(tree(&f.vault), before);
    let update = apply(
        &f,
        "oura",
        "2020-01-02",
        "2020-01-02",
        &[],
        &[("daily_sleep", "complete")],
        false,
    )
    .unwrap();
    assert_eq!(update.changed_days, 1);
    assert_eq!(update.record_count, 1);
    let after = tree(&f.vault);
    for (path, value) in before
        .iter()
        .filter(|(path, _)| path.to_string_lossy().contains("2020-01-01"))
    {
        assert_eq!(after.get(path), Some(value));
    }
    assert_eq!(
        f.store.manifest().unwrap().unwrap().sources["oura"].collections["daily_sleep"]
            ["2020-01-02"]
            .record_count,
        0
    );
}

#[test]
fn incomplete_collections_keep_existing_data_and_do_not_activate_partial_pages() {
    let f = Fixture::new();
    let rows = [
        supplement("garmin", "hrv", "2020-01-01", 1),
        supplement("garmin", "sleep", "2020-01-01", 2),
    ];
    apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &rows,
        &[("hrv", "complete"), ("sleep", "complete")],
        false,
    )
    .unwrap();
    let partial = [
        supplement("garmin", "hrv", "2020-01-01", 999),
        supplement("garmin", "sleep", "2020-01-01", 3),
    ];
    let result = apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &partial,
        &[("hrv", "failed"), ("sleep", "complete")],
        false,
    )
    .unwrap();
    assert!(!result.complete);
    assert_eq!(result.warnings.len(), 1);
    let q = f
        .store
        .query(None, None, Some("garmin.hrv"), 100, 0)
        .unwrap();
    assert_eq!(q["records"][0]["payload"]["value"], 1);
    assert_eq!(
        f.store
            .query(None, None, Some("garmin.sleep"), 100, 0)
            .unwrap()["records"][0]["payload"]["value"],
        3
    );
    let old = f.store.manifest().unwrap().unwrap().days["2020-01-01"]
        .sha256
        .clone();
    apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &[],
        &[("hrv", "unavailable")],
        false,
    )
    .unwrap();
    assert_eq!(
        f.store.manifest().unwrap().unwrap().days["2020-01-01"].sha256,
        old
    );
    assert_eq!(
        f.store.manifest().unwrap().unwrap().sources["garmin"].collections["hrv"]["2020-01-01"]
            .status,
        "unavailable"
    );
}

#[test]
fn provider_only_start_catalog_and_filters_keep_unknown_records_discoverable() {
    let f = Fixture::new();
    let rows = [
        supplement("oura", "daily_sleep", "2020-01-01", 1),
        supplement("oura", "unknown_future", "2020-01-01", 2),
    ];
    apply(
        &f,
        "oura",
        "2020-01-01",
        "2020-01-01",
        &rows,
        &[("daily_sleep", "complete"), ("unknown_future", "complete")],
        false,
    )
    .unwrap();
    let status = f.store.status().unwrap();
    assert_eq!(status["manifest"]["apple_imported"], false);
    assert_eq!(status["manifest"]["input_sha256"], "");
    let filtered = f
        .store
        .query_filtered(
            QueryFilter {
                category: Some("sleep"),
                source: Some("oura"),
                ..Default::default()
            },
            100,
            0,
        )
        .unwrap();
    assert_eq!(filtered["records"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["records"][0]["metric"], "oura.daily_sleep");
    let catalog = f.store.catalog().unwrap();
    assert!(catalog["categories"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["slug"] == "other" && c["record_count"] == 1));
    assert!(f
        .store
        .query_filtered(
            QueryFilter {
                category: Some("../../"),
                ..Default::default()
            },
            100,
            0
        )
        .is_err());
    f.write(&record("2020-01-01", "60", "Watch"));
    assert_eq!(f.import().record_count, 3);
    assert_eq!(
        f.store.status().unwrap()["manifest"]["apple_imported"],
        true
    );
}

#[test]
fn provider_invalid_window_source_or_count_cannot_activate_and_dry_run_is_read_only() {
    let f = Fixture::new();
    let rows = [supplement("oura", "daily_sleep", "2020-01-01", 1)];
    apply(
        &f,
        "oura",
        "2020-01-01",
        "2020-01-01",
        &rows,
        &[("daily_sleep", "complete")],
        true,
    )
    .unwrap();
    assert!(!f.vault.join("health").exists());
    for (source, since, until) in [
        ("garmin", "2020-01-01", "2020-01-01"),
        ("oura", "2020-01-02", "2020-01-02"),
        ("oura", "2020-02-02", "2020-01-01"),
    ] {
        assert!(apply(
            &f,
            source,
            since,
            until,
            &rows,
            &[("daily_sleep", "complete")],
            false
        )
        .is_err());
        assert!(!f.vault.join("health").exists());
    }
    let file = f.root.path().join("empty.jsonl");
    fs::write(&file, "").unwrap();
    let report = FetchReport {
        source: "oura".into(),
        since: "2020-01-01".into(),
        until: "2020-01-01".into(),
        collections: vec![CollectionResult {
            collection: "daily_sleep".into(),
            status: "complete".into(),
            records: 1,
            error: None,
        }],
    };
    assert!(f
        .store
        .apply_provider(&file, &report, false, &mut |_| {})
        .is_err());
    assert!(!f.vault.join("health").exists());
}

#[test]
fn undated_provider_collection_replaces_itself_without_dated_or_other_source_loss() {
    let f = Fixture::new();
    apply(
        &f,
        "oura",
        "2020-01-01",
        "2020-01-01",
        &[supplement("oura", "personal_info", "_undated", 1)],
        &[("personal_info", "complete")],
        false,
    )
    .unwrap();
    apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &[supplement("garmin", "profile", "_undated", 2)],
        &[("profile", "complete")],
        false,
    )
    .unwrap();
    apply(
        &f,
        "oura",
        "2020-01-02",
        "2020-01-02",
        &[supplement("oura", "personal_info", "_undated", 3)],
        &[("personal_info", "complete")],
        false,
    )
    .unwrap();
    let q = f.store.query(None, None, None, 100, 0).unwrap();
    assert_eq!(q["records"].as_array().unwrap().len(), 2);
    assert_eq!(
        f.store
            .query(None, None, Some("oura.personal_info"), 100, 0)
            .unwrap()["records"][0]["payload"]["value"],
        3
    );
    assert!(f
        .store
        .query(Some("2020-01-01"), None, None, 100, 0)
        .unwrap()["records"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn localized_apple_zip_preserves_cda_ecg_and_route_originals() {
    use std::io::Write;
    for primary in [
        "导出.xml",
        "apple_health_export/导出.xml",
        "健康/巢狀/匯出.XML",
        "apple_health_export/σ»╝σç║.xml",
    ] {
        let f = Fixture::new();
        f.write(&record("2026-10-22", "60", "Watch"));
        let path = f.root.path().join("export.zip");
        let attachments: [(&str, &[u8]); 3] = [
            (
                "apple_health_export/export_cda.xml",
                b"<?xml version='1.0'?><ClinicalDocument xmlns='urn:hl7-org:v3'>original clinical bytes</ClinicalDocument>",
            ),
            (
                "apple_health_export/electrocardiograms/ecg_2026-10-22.csv",
                b"Time,Voltage\r\n0,0.01\r\n",
            ),
            (
                "apple_health_export/workout-routes/route_2026-06-17_9.39am.gpx",
                b"<gpx>original route bytes</gpx>",
            ),
        ];
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        // CDA precedes the primary XML, matching neither a first-XML heuristic
        // nor the HealthData root. It must survive as attachment evidence.
        for (name, bytes) in attachments {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.start_file(primary, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&fs::read(&f.file).unwrap()).unwrap();
        zip.finish().unwrap();

        let report = f.store.import(&path, false, &mut |_| {}).unwrap();
        assert!(report.complete);
        assert_eq!(report.record_count, 4);
        let manifest = f.store.manifest().unwrap().unwrap();
        assert_eq!(manifest.attachments.len(), 3);
        assert_eq!(manifest.ignored_attachments, 0);
        let records = f.store.query(None, None, None, 100, 0).unwrap();
        let records = records["records"].as_array().unwrap();
        for (original, bytes) in attachments {
            let row = records
                .iter()
                .find(|row| row["attributes"]["original_name"] == original)
                .unwrap();
            assert_eq!(row["kind"], "Attachment");
            let saved = manifest
                .attachments
                .iter()
                .find(|(_, reference)| row["attributes"]["sha256"] == reference.sha256)
                .map(|(path, _)| f.vault.join(path))
                .unwrap();
            assert_eq!(fs::read(saved).unwrap(), bytes);
        }
        for (metric, day) in [
            ("attachment.clinical", "_undated"),
            ("attachment.electrocardiogram", "2026-10-22"),
            ("attachment.workout-route", "2026-06-17"),
        ] {
            let row = records.iter().find(|row| row["metric"] == metric).unwrap();
            assert_eq!(row["day"], day);
        }
        let before = tree(&f.vault);
        assert!(
            !f.store
                .import(&path, false, &mut |_| {})
                .unwrap()
                .data_changed
        );
        assert_eq!(tree(&f.vault), before);
    }
}

#[test]
fn ambiguous_localized_primary_or_cda_alone_cannot_replace_active_data() {
    use std::io::Write;
    let f = Fixture::new();
    f.write(&record("2026-10-22", "60", "Watch"));
    f.import();
    let before = tree(&f.vault);
    for names in [
        vec![
            "apple_health_export/export.xml",
            "apple_health_export/导出.xml",
        ],
        vec!["apple_health_export/export_cda.xml"],
    ] {
        let path = f.root.path().join("invalid.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for name in names {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            if name.ends_with("export_cda.xml") {
                zip.write_all(b"<ClinicalDocument xmlns='urn:hl7-org:v3'/>")
                    .unwrap();
            } else {
                zip.write_all(&fs::read(&f.file).unwrap()).unwrap();
            }
        }
        zip.finish().unwrap();
        assert!(f.store.import(&path, false, &mut |_| {}).is_err());
        assert_eq!(tree(&f.vault), before);
    }
}

#[test]
fn apple_zip_attachments_are_active_original_bytes_and_missing_bytes_recover() {
    use std::io::Write;
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    let path = f.root.path().join("export.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    zip.start_file(
        "apple_health_export/export.xml",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(&fs::read(&f.file).unwrap()).unwrap();
    zip.start_file(
        "apple_health_export/workout-routes/route_2020-01-01.gpx",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(b"<gpx>original route bytes</gpx>").unwrap();
    zip.finish().unwrap();
    let result = f.store.import(&path, false, &mut |_| {}).unwrap();
    assert_eq!(result.record_count, 2);
    let m = f.store.manifest().unwrap().unwrap();
    assert_eq!(m.attachments.len(), 1);
    assert_eq!(m.ignored_attachments, 0);
    let attachment = f.vault.join(m.attachments.keys().next().unwrap());
    assert_eq!(
        fs::read(&attachment).unwrap(),
        b"<gpx>original route bytes</gpx>"
    );
    let before = tree(&f.vault);
    assert!(
        !f.store
            .import(&path, false, &mut |_| {})
            .unwrap()
            .data_changed
    );
    assert_eq!(tree(&f.vault), before);
    fs::remove_file(&attachment).unwrap();
    assert!(f.store.import(&path, false, &mut |_| {}).unwrap().complete);
    assert!(attachment.exists());
    fs::write(&attachment, b"damaged").unwrap();
    assert!(f.store.import(&path, false, &mut |_| {}).is_err());
}

#[test]
fn provider_binary_payloads_become_original_attachments_with_window_scoped_membership() {
    use base64::Engine;
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    f.import();
    let binary = b"PK\x03\x04original raw activity bytes\0";
    let mut raw = supplement("garmin", "activity_files", "2020-01-01", 0);
    raw.data = json!({"filename":"../../activity-1.zip","mime":"application/zip","content_base64":base64::engine::general_purpose::STANDARD.encode(binary)});
    apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &[raw.clone()],
        &[("activity_files", "complete")],
        false,
    )
    .unwrap();
    let payload = &f
        .store
        .query(None, None, Some("garmin.activity_files"), 100, 0)
        .unwrap()["records"][0]["payload"];
    assert_eq!(payload["content_base64"], Value::Null);
    assert_eq!(payload["filename"], "../../activity-1.zip");
    let path = payload["attachment_path"].as_str().unwrap();
    assert!(!path.contains(".."));
    assert!(path.contains("garmin-activity-files"));
    let saved = f.vault.join(path);
    assert_eq!(fs::read(&saved).unwrap(), binary);
    let before = tree(&f.vault);
    assert!(
        !apply(
            &f,
            "garmin",
            "2020-01-01",
            "2020-01-01",
            &[raw],
            &[("activity_files", "complete")],
            false
        )
        .unwrap()
        .data_changed
    );
    assert_eq!(tree(&f.vault), before);
    f.write(&record("2020-01-01", "70", "Watch"));
    f.import();
    assert_eq!(f.store.manifest().unwrap().unwrap().attachments.len(), 1);
    apply(
        &f,
        "garmin",
        "2020-01-02",
        "2020-01-02",
        &[],
        &[("activity_files", "complete")],
        false,
    )
    .unwrap();
    assert_eq!(f.store.manifest().unwrap().unwrap().attachments.len(), 1);
    apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &[],
        &[("activity_files", "failed")],
        false,
    )
    .unwrap();
    assert_eq!(f.store.manifest().unwrap().unwrap().attachments.len(), 1);
    apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &[],
        &[("activity_files", "complete")],
        false,
    )
    .unwrap();
    assert!(f.store.manifest().unwrap().unwrap().attachments.is_empty());
    assert!(saved.exists());
    assert_eq!(f.store.manifest().unwrap().unwrap().record_count, 1);
}

#[test]
fn provider_bad_attachment_or_publication_failure_keeps_previous_manifest() {
    use base64::Engine;
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    f.import();
    let before = fs::read(f.vault.join("health/manifest.json")).unwrap();
    let mut raw = supplement("garmin", "activity_files", "2020-01-01", 0);
    raw.data = json!({"filename":"a.zip","content_base64":"invalid base64!"});
    assert!(apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &[raw.clone()],
        &[("activity_files", "complete")],
        false
    )
    .is_err());
    assert_eq!(
        fs::read(f.vault.join("health/manifest.json")).unwrap(),
        before
    );
    raw.data["content_base64"] =
        json!(base64::engine::general_purpose::STANDARD.encode(b"original bytes"));
    fs::write(f.vault.join("health/attachments"), "blocking file").unwrap();
    assert!(apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-01",
        &[raw],
        &[("activity_files", "complete")],
        false
    )
    .is_err());
    assert_eq!(
        fs::read(f.vault.join("health/manifest.json")).unwrap(),
        before
    );
    assert_eq!(
        f.store.query(None, None, None, 100, 0).unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn provider_duplicate_pages_use_unique_active_counts_but_validate_raw_report_count() {
    let f = Fixture::new();
    let row = supplement("oura", "daily_sleep", "2020-01-01", 42);
    let result = apply(
        &f,
        "oura",
        "2020-01-01",
        "2020-01-01",
        &[row.clone(), row.clone(), row.clone()],
        &[("daily_sleep", "complete")],
        false,
    )
    .unwrap();
    assert_eq!(result.record_count, 1);
    let manifest = f.store.manifest().unwrap().unwrap();
    assert_eq!(
        manifest.sources["oura"].collections["daily_sleep"]["2020-01-01"].record_count,
        1
    );
    let before = tree(&f.vault);
    assert!(
        !apply(
            &f,
            "oura",
            "2020-01-01",
            "2020-01-01",
            &[row],
            &[("daily_sleep", "complete")],
            false
        )
        .unwrap()
        .data_changed
    );
    assert_eq!(tree(&f.vault), before);

    let mut pulse = supplement("oura", "heartrate", "2020-01-01", 60);
    pulse.id = None;
    pulse.data = json!({"timestamp":"2020-01-01T12:00:00Z","source":"awake","bpm":60});
    let mut different = pulse.clone();
    different.data["bpm"] = json!(61);
    let result = apply(
        &f,
        "oura",
        "2020-01-01",
        "2020-01-01",
        &[pulse.clone(), different, pulse],
        &[("heartrate", "complete")],
        false,
    )
    .unwrap();
    assert_eq!(result.record_count, 3);
    let result = f
        .store
        .query(None, None, Some("oura.heartrate"), 100, 0)
        .unwrap();
    assert_eq!(result["records"].as_array().unwrap().len(), 2);
}

#[test]
fn conflicting_provider_id_payload_or_day_fails_before_activation() {
    let f = Fixture::new();
    let row = supplement("garmin", "sleep", "2020-01-01", 1);
    apply(
        &f,
        "garmin",
        "2020-01-01",
        "2020-01-02",
        std::slice::from_ref(&row),
        &[("sleep", "complete")],
        false,
    )
    .unwrap();
    let before = tree(&f.vault);
    let mut payload_conflict = row.clone();
    payload_conflict.data["value"] = json!(2);
    let mut day_conflict = row.clone();
    day_conflict.day = "2020-01-02".into();
    for conflict in [payload_conflict, day_conflict] {
        let error = apply(
            &f,
            "garmin",
            "2020-01-01",
            "2020-01-02",
            &[row.clone(), conflict],
            &[("sleep", "complete")],
            false,
        )
        .unwrap_err();
        assert!(error.contains("Conflicting provider ID"));
        assert_eq!(tree(&f.vault), before);
    }
}

#[test]
fn provider_ids_are_scoped_to_source_and_collection() {
    let f = Fixture::new();
    for source in ["oura", "garmin"] {
        let mut sleep = supplement(source, "sleep", "2020-01-01", 1);
        sleep.id = Some("same-id".into());
        let mut hrv = supplement(source, "hrv", "2020-01-01", 2);
        hrv.id = Some("same-id".into());
        apply(
            &f,
            source,
            "2020-01-01",
            "2020-01-01",
            &[sleep, hrv],
            &[("sleep", "complete"), ("hrv", "complete")],
            false,
        )
        .unwrap();
    }
    assert_eq!(f.store.manifest().unwrap().unwrap().record_count, 4);
    let results = f.store.query(None, None, None, 100, 0).unwrap();
    assert_eq!(results["records"].as_array().unwrap().len(), 4);
}

#[test]
fn mixed_xml_changes_have_distinct_daily_membership_and_unknown_fields_survive() {
    let f = Fixture::new();
    f.write("<Future startDate='2020-01-01 12:00:00 +0900' vendor='unknown'>a<Child key='new'/>b</Future>");
    f.import();
    let old = f.store.manifest().unwrap().unwrap();
    f.write("<Future startDate='2020-01-01 12:00:00 +0900' vendor='unknown'>ab<Child key='new'/></Future>");
    assert_eq!(f.import().changed_days, 1);
    assert_ne!(
        old.days["2020-01-01"].sha256,
        f.store.manifest().unwrap().unwrap().days["2020-01-01"].sha256
    );
    let query = f
        .store
        .query_filtered(
            QueryFilter {
                category: Some("other"),
                source: Some("apple-health"),
                ..Default::default()
            },
            100,
            0,
        )
        .unwrap();
    let row = &query["records"][0];
    assert_eq!(row["text"], "ab");
    assert_eq!(row["text_segments"], json!(["ab", ""]));
    assert_eq!(row["attributes"]["vendor"], "unknown");
    assert_eq!(row["children"][0]["attributes"]["key"], "new");
}

#[test]
fn invalid_export_timestamp_cannot_retire_existing_apple_records() {
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    f.import();
    let before = tree(&f.vault);
    for value in ["", "garbage", "2026-02-30 12:00:00 +0900"] {
        fs::write(
            &f.file,
            format!("<HealthData><ExportDate value='{value}'/></HealthData>"),
        )
        .unwrap();
        assert!(f.store.import(&f.file, false, &mut |_| {}).is_err());
        assert_eq!(tree(&f.vault), before);
    }
}

#[test]
fn zero_length_zip_placeholder_is_an_active_attachment_without_losing_other_data() {
    use std::io::Write;
    let f = Fixture::new();
    f.write(&record("2020-01-01", "60", "Watch"));
    let file = f.root.path().join("export.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&file).unwrap());
    zip.start_file(
        "apple_health_export/export.xml",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(&fs::read(&f.file).unwrap()).unwrap();
    zip.start_file(
        "apple_health_export/future-placeholder.csv",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.finish().unwrap();
    let report = f.store.import(&file, false, &mut |_| {}).unwrap();
    assert!(report.complete);
    assert_eq!(report.record_count, 2);
    let manifest = f.store.manifest().unwrap().unwrap();
    assert_eq!(manifest.attachments.len(), 1);
    let path = manifest.attachments.keys().next().unwrap();
    assert_eq!(fs::metadata(f.vault.join(path)).unwrap().len(), 0);
    let query = f
        .store
        .query(None, None, Some("attachment.other"), 100, 0)
        .unwrap();
    assert_eq!(
        query["records"][0]["attributes"]["original_name"],
        "apple_health_export/future-placeholder.csv"
    );
    assert_eq!(query["records"][0]["attributes"]["size"], "0");
}

#[test]
#[ignore = "requires a synthetic million-record export through HEALTH_SYNC_BENCH_EXPORT"]
fn million_record_schema2_benchmark() {
    let file = std::env::var_os("HEALTH_SYNC_BENCH_EXPORT")
        .expect("Set HEALTH_SYNC_BENCH_EXPORT to the synthetic fixture");
    let f = Fixture::new();
    let started = std::time::Instant::now();
    let report = f
        .store
        .import(Path::new(&file), false, &mut |message| {
            eprintln!("{message}")
        })
        .unwrap();
    let seconds = started.elapsed().as_secs_f64();
    assert!(report.complete);
    assert_eq!(report.record_count, 1_000_000);
    let manifest = f.store.manifest().unwrap().unwrap();
    assert_eq!(manifest.schema_version, 2);
    assert_eq!(manifest.day_count, 3650);
    let manifest_bytes = fs::metadata(f.vault.join("health/manifest.json"))
        .unwrap()
        .len();
    let root = f.root.keep();
    eprintln!(
        "BENCH_RESULT {}",
        json!({"import_seconds":seconds,"record_count":report.record_count,"day_count":manifest.day_count,"manifest_bytes":manifest_bytes,"root":root})
    );
}
