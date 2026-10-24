//! One active daily index across Apple snapshots and provider supplements.
//! Immutable shards precede the atomic manifest;
//! generated Markdown is recoverable and never the source of truth.
use crate::{
    attachments::{extract_attachments, Attachment},
    catalog,
    model::HealthRecord,
    providers::{FetchReport, ProviderRecord},
    source::parse_export,
};
use fs2::FileExt;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn json_hash(value: &impl Serialize) -> Result<String> {
    struct Hasher(Sha256);
    impl Write for Hasher {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut digest = Hasher(Sha256::new());
    serde_json::to_writer(&mut digest, value).map_err(err)?;
    Ok(format!("{:x}", digest.0.finalize()))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Shard {
    pub source: String,
    pub metric: String,
    pub category: String,
    pub sha256: String,
    pub record_count: u64,
}
impl Shard {
    pub fn filename(&self) -> String {
        let slug = catalog::metric_slug(&self.metric);
        let metric = if matches!(self.source.as_str(), "garmin" | "oura") {
            slug.strip_prefix(&format!("{}-", self.source))
                .unwrap_or(&slug)
        } else {
            &slug
        };
        format!("{}-{}-{}.jsonl", self.source, metric, self.sha256)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SourceState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_date: Option<String>,
    pub collections: BTreeMap<String, BTreeMap<String, Coverage>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Coverage {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub record_count: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Day {
    pub sha256: String,
    pub shards: Vec<Shard>,
    pub record_count: u64,
    pub summary_sha256: String,
    pub previous_summary_sha256: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub schema_version: u32,
    pub source: String,
    pub scope: String,
    pub input_sha256: String,
    pub export_date: String,
    pub root_attributes: BTreeMap<String, String>,
    pub record_count: u64,
    pub day_count: usize,
    pub ignored_attachments: u64,
    pub days: BTreeMap<String, Day>,
    pub sources: BTreeMap<String, SourceState>,
    pub attachments: BTreeMap<String, AttachmentRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentRef {
    pub source: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub complete: bool,
    pub dry_run: bool,
    pub data_changed: bool,
    pub input_sha256: String,
    pub record_count: u64,
    pub changed_days: usize,
    pub unchanged_days: usize,
    pub summary_conflicts: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct SourceConfig {
    file: PathBuf,
}

pub struct Store {
    vault: PathBuf,
    local: PathBuf,
}

#[derive(Default)]
pub struct QueryFilter<'a> {
    pub since: Option<&'a str>,
    pub until: Option<&'a str>,
    pub metric: Option<&'a str>,
    pub category: Option<&'a str>,
    pub source: Option<&'a str>,
}

pub fn default_state_base() -> Result<PathBuf> {
    // Isolate CLI verification without changing HOME or touching personal state.
    if let Some(path) = std::env::var_os("NOTEMD_HEALTH_STATE_DIR") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("NOTEMD_HEALTH_STATE_DIR must be absolute".into());
        }
        return Ok(path);
    }
    let home =
        std::env::var_os("HOME").ok_or("HOME is unavailable; cannot locate application data")?;
    Ok(PathBuf::from(home).join("Library/Application Support/net.notemd.app/health-sync"))
}

/// Reject symlinks in plugin-owned paths. The selected vault itself is canonicalized.
fn safe_path(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("Refusing symlink: {}", current.display()))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err(e)),
        }
    }
    Ok(())
}

fn mkdir(path: &Path) -> Result<()> {
    safe_path(path)?;
    fs::create_dir_all(path).map_err(err)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    safe_path(path)?;
    let parent = path.parent().ok_or("Missing parent")?;
    mkdir(parent)?;
    let mut tmp = NamedTempFile::new_in(parent).map_err(err)?;
    tmp.write_all(bytes).map_err(err)?;
    tmp.as_file().sync_all().map_err(err)?;
    tmp.persist(path).map_err(err)?;
    File::open(parent).and_then(|f| f.sync_all()).map_err(err)
}

fn existing_hash(path: &Path) -> Result<Option<String>> {
    safe_path(path)?;
    match File::open(path) {
        Ok(mut file) => {
            let mut sha = Sha256::new();
            let mut buf = [0; 64 * 1024];
            loop {
                let n = file.read(&mut buf).map_err(err)?;
                if n == 0 {
                    break;
                }
                sha.update(&buf[..n]);
            }
            Ok(Some(format!("{:x}", sha.finalize())))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub fn valid_day(value: &str) -> bool {
    value.len() == 10
        && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map(|d| d.format("%Y-%m-%d").to_string() == value)
            .unwrap_or(false)
}

fn valid_source(source: &str) -> bool {
    matches!(source, "apple-health" | "garmin" | "oura")
}
fn valid_attachment_path(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 4
        && parts[0] == "health"
        && parts[1] == "attachments"
        && (valid_day(parts[2]) || parts[2] == "_undated")
        && !parts[3].is_empty()
        && !parts[3].starts_with('.')
        && parts[3]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}
fn valid_coverage(status: &str) -> bool {
    matches!(status, "complete" | "unavailable" | "failed")
}
fn valid_category(category: &str) -> bool {
    matches!(
        category,
        "sleep"
            | "heart"
            | "activity"
            | "body"
            | "vitals"
            | "nutrition"
            | "mindfulness"
            | "reproductive"
            | "medications"
            | "clinical"
            | "environment"
            | "mobility"
            | "hearing"
            | "metadata"
            | "other"
    )
}
fn shard_digest(shards: &[Shard]) -> Result<String> {
    Ok(hash(&serde_json::to_vec(shards).map_err(err)?))
}
fn staging_db(dir: &Path) -> Result<Connection> {
    let db = Connection::open(dir.join("records.sqlite")).map_err(err)?;
    db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; CREATE TABLE records(day TEXT NOT NULL, source TEXT NOT NULL, metric TEXT NOT NULL, category TEXT NOT NULL, payload TEXT NOT NULL);").map_err(err)?;
    Ok(db)
}
fn stage_record(insert: &mut rusqlite::Statement<'_>, record: &HealthRecord) -> Result<()> {
    insert
        .execute(params![
            record.day,
            record.ingest_source,
            record.metric,
            catalog::category(&record.metric, &record.kind),
            serde_json::to_string(record).map_err(err)?
        ])
        .map_err(err)?;
    Ok(())
}
fn window_days(since: &str, until: &str) -> Result<Vec<String>> {
    if !valid_day(since) || !valid_day(until) || since > until {
        return Err("Provider window must use ordered YYYY-MM-DD dates".into());
    }
    let mut day = chrono::NaiveDate::parse_from_str(since, "%Y-%m-%d").map_err(err)?;
    let end = chrono::NaiveDate::parse_from_str(until, "%Y-%m-%d").map_err(err)?;
    let mut dates = vec![];
    loop {
        dates.push(day.format("%Y-%m-%d").to_string());
        if day == end {
            break;
        }
        day = day.succ_opt().ok_or("Provider date range overflow")?;
    }
    Ok(dates)
}

fn stage_provider_attachment(
    record: &mut ProviderRecord,
    staging: &Path,
) -> Result<Option<(PathBuf, PathBuf, String)>> {
    let Some(encoded) = record.data.get("content_base64") else {
        return Ok(None);
    };
    let encoded = encoded
        .as_str()
        .ok_or("Provider attachment content_base64 must be a string")?;
    const LIMIT: u64 = 256 * 1024 * 1024;
    if encoded.len() as u64 > LIMIT.div_ceil(3) * 4 {
        return Err("Provider attachment exceeds 256 MiB".into());
    }
    let original = record
        .data
        .get("filename")
        .and_then(Value::as_str)
        .ok_or("Provider attachment filename missing")?;
    let basename = original.rsplit(['/', '\\']).next().unwrap_or(original);
    let (stem, extension) = basename.rsplit_once('.').unwrap_or((basename, "bin"));
    let extension = if !extension.is_empty()
        && extension.len() <= 12
        && extension.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        extension.to_ascii_lowercase()
    } else {
        "bin".into()
    };
    let mut reader = base64::read::DecoderReader::new(
        encoded.as_bytes(),
        &base64::engine::general_purpose::STANDARD,
    );
    let mut temp = NamedTempFile::new_in(staging).map_err(err)?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|e| format!("Invalid provider attachment base64: {e}"))?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > LIMIT {
            return Err("Provider attachment exceeds 256 MiB".into());
        }
        digest.update(&buffer[..count]);
        temp.write_all(&buffer[..count]).map_err(err)?;
    }
    if size == 0 {
        return Err("Provider attachment is empty".into());
    }
    temp.flush().map_err(err)?;
    let sha256 = format!("{:x}", digest.finalize());
    let short_name: String = catalog::metric_slug(stem).chars().take(40).collect();
    let relative = PathBuf::from("health/attachments")
        .join(&record.day)
        .join(format!(
            "{}-{}-{}-{}.{}",
            record.source,
            catalog::metric_slug(&record.collection),
            short_name.trim_end_matches('-'),
            sha256,
            extension
        ));
    let data = record
        .data
        .as_object_mut()
        .ok_or("Provider attachment must be an object")?;
    data.remove("content_base64");
    data.insert("attachment_path".into(), json!(relative.to_string_lossy()));
    data.insert("sha256".into(), json!(sha256));
    data.insert("size".into(), json!(size));
    let (file, path) = temp.keep().map_err(err)?;
    drop(file);
    Ok(Some((path, relative, sha256)))
}

fn source_summary(manifest: &Manifest) -> Value {
    let mut sources = serde_json::Map::new();
    for (source, state) in &manifest.sources {
        let mut collections = serde_json::Map::new();
        for (collection, coverage) in &state.collections {
            let dates: Vec<_> = coverage.iter().filter(|(day, _)| valid_day(day)).collect();
            collections.insert(collection.clone(), json!({
                "complete_days":dates.iter().filter(|(_,c)|c.status == "complete").count(),
                "unavailable_days":dates.iter().filter(|(_,c)|c.status == "unavailable").count(),
                "failed_days":dates.iter().filter(|(_,c)|c.status == "failed").count(),
                "first_coverage_day":dates.first().map(|(d,_)|d), "last_coverage_day":dates.last().map(|(d,_)|d),
                "undated":coverage.get("_undated"),
            }));
        }
        let record_count: u64 = manifest
            .days
            .values()
            .flat_map(|d| d.shards.iter())
            .filter(|s| &s.source == source)
            .map(|s| s.record_count)
            .sum();
        sources.insert(
            source.clone(),
            json!({"record_count":record_count,"input_sha256":state.input_sha256,
            "export_date":state.export_date,"collections":collections}),
        );
    }
    Value::Object(sources)
}

impl Store {
    pub fn new(vault: &Path, state_base: &Path) -> Result<Self> {
        let vault = vault.canonicalize().map_err(|e| format!("Vault: {e}"))?;
        if !vault.is_dir() {
            return Err("Vault must be an existing directory".into());
        }
        // Temp paths on macOS commonly begin /var -> /private/var. Canonicalize
        // an existing base, while never following plugin-owned descendants.
        let base = state_base
            .canonicalize()
            .unwrap_or_else(|_| state_base.to_path_buf());
        let local = base.join(hash(vault.to_string_lossy().as_bytes()));
        Ok(Self { vault, local })
    }

    fn health(&self) -> PathBuf {
        self.vault.join("health")
    }
    fn summary_path(&self, day: &str) -> PathBuf {
        self.health().join("daily").join(format!("{day}-health.md"))
    }
    fn shard_path(&self, day: &str, entry: &Shard) -> PathBuf {
        self.health().join("data").join(day).join(entry.filename())
    }

    fn lock(&self) -> Result<File> {
        mkdir(&self.local)?;
        let path = self.local.join("write.lock");
        safe_path(&path)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
            .map_err(err)?;
        file.try_lock_exclusive()
            .map_err(|_| "Health import is busy for this vault; retry later".to_string())?;
        Ok(file)
    }

    pub fn manifest(&self) -> Result<Option<Manifest>> {
        let path = self.health().join("manifest.json");
        safe_path(&path)?;
        let bytes = match fs::read(path) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(err(e)),
        };
        let m: Manifest =
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid health manifest: {e}"))?;
        if m.schema_version != 2
            || m.source != "apple-health"
            || m.scope != "daily-ssot"
            || (!m.input_sha256.is_empty() && !valid_hash(&m.input_sha256))
        {
            return Err("Unsupported health manifest".into());
        }
        let mut total = 0u64;
        for (day, entry) in &m.days {
            if !(valid_day(day) || day == "_undated")
                || !valid_hash(&entry.sha256)
                || !valid_hash(&entry.summary_sha256)
                || entry
                    .previous_summary_sha256
                    .as_deref()
                    .is_some_and(|v| !valid_hash(v))
                || hash(entry.summary.as_bytes()) != entry.summary_sha256
            {
                return Err("Invalid day or hash in health manifest".into());
            }
            total = total
                .checked_add(entry.record_count)
                .ok_or("Manifest count overflow")?;
            let mut shard_total = 0u64;
            let mut seen = BTreeSet::new();
            for shard in &entry.shards {
                if !valid_source(&shard.source)
                    || !valid_hash(&shard.sha256)
                    || shard.record_count == 0
                    || !valid_category(&shard.category)
                    || !seen.insert((&shard.source, &shard.metric, &shard.category))
                {
                    return Err("Invalid shard in health manifest".into());
                }
                shard_total = shard_total
                    .checked_add(shard.record_count)
                    .ok_or("Manifest count overflow")?;
            }
            if shard_total != entry.record_count || shard_digest(&entry.shards)? != entry.sha256 {
                return Err("Health day counts or digest disagree".into());
            }
        }
        if total != m.record_count
            || m.day_count != m.days.values().filter(|d| d.record_count > 0).count()
        {
            return Err("Health manifest counts disagree".into());
        }
        for (source, state) in &m.sources {
            if !valid_source(source)
                || state
                    .input_sha256
                    .as_deref()
                    .is_some_and(|s| !valid_hash(s))
            {
                return Err("Invalid source metadata".into());
            }
            for dates in state.collections.values() {
                for (day, coverage) in dates {
                    if !(valid_day(day) || day == "_undated") || !valid_coverage(&coverage.status) {
                        return Err("Invalid source coverage".into());
                    }
                }
            }
        }
        for (path, attachment) in &m.attachments {
            if !valid_attachment_path(path)
                || !valid_source(&attachment.source)
                || !valid_hash(&attachment.sha256)
            {
                return Err("Invalid attachment in health manifest".into());
            }
        }
        if m.sources
            .get("apple-health")
            .and_then(|s| s.input_sha256.as_deref())
            .unwrap_or("")
            != m.input_sha256
        {
            return Err("Apple source fingerprint disagrees with manifest".into());
        }
        Ok(Some(m))
    }

    fn remembered_source(&self) -> Result<Option<PathBuf>> {
        let path = self.local.join("source.json");
        safe_path(&path)?;
        match fs::read(path) {
            Ok(v) => Ok(Some(
                serde_json::from_slice::<SourceConfig>(&v)
                    .map_err(err)?
                    .file,
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    fn remember(&self, file: &Path) -> Result<()> {
        if self.remembered_source()?.as_deref() != Some(file) {
            atomic_write(
                &self.local.join("source.json"),
                &serde_json::to_vec_pretty(&SourceConfig { file: file.into() }).map_err(err)?,
            )?;
        }
        Ok(())
    }

    pub fn status(&self) -> Result<Value> {
        let manifest = self.manifest()?;
        let summary = manifest.as_ref().map(|m| json!({"schema_version":m.schema_version,"source":m.source,"scope":m.scope,
            "input_sha256":m.input_sha256,"export_date":m.export_date,"record_count":m.record_count,"day_count":m.day_count,
            "ignored_attachments":m.ignored_attachments,"attachment_count":m.attachments.len(),"sources":source_summary(m),"apple_imported":m.sources.contains_key("apple-health"),"first_day":m.days.iter().find(|(d,e)| valid_day(d) && e.record_count > 0).map(|(d,_)|d),
            "last_day":m.days.iter().rev().find(|(d,e)| valid_day(d) && e.record_count > 0).map(|(d,_)|d),"summary_conflicts":self.reconcile_summaries(m,true)}));
        Ok(
            json!({"imported":manifest.is_some(), "manifest":summary, "source_file":self.remembered_source()?}),
        )
    }

    pub fn sync(&self, dry_run: bool, progress: &mut dyn FnMut(&str)) -> Result<Report> {
        let file = self.remembered_source()?.ok_or("No remembered export; run health-import with a complete export.zip or export.xml first")?;
        self.import(&file, dry_run, progress)
    }

    pub fn import(
        &self,
        file: &Path,
        dry_run: bool,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Report> {
        let _lock = self.lock()?;
        let old = self.manifest()?;
        self.check_owned(&old)?;
        let source = file.canonicalize().map_err(|e| {
            format!("Cannot read export (download iCloud Drive files locally first): {e}")
        })?;
        if !source.is_file() {
            return Err("Export must be a regular file".into());
        }
        progress("Copying and fingerprinting the export");
        let mut input = File::open(&source).map_err(err)?;
        let before = input.metadata().map_err(err)?;
        let mut snapshot = NamedTempFile::new().map_err(err)?;
        let mut sha = Sha256::new();
        let mut buf = [0u8; 256 * 1024];
        let mut copied = 0u64;
        let mut last_progress = std::time::Instant::now();
        loop {
            let n = input.read(&mut buf).map_err(err)?;
            if n == 0 {
                break;
            }
            copied += n as u64;
            if copied > 64 * 1024 * 1024 * 1024 {
                return Err("Export exceeds the 64 GiB input limit".into());
            }
            sha.update(&buf[..n]);
            snapshot.write_all(&buf[..n]).map_err(err)?;
            if last_progress.elapsed().as_secs() >= 10 {
                progress("Still copying export");
                last_progress = std::time::Instant::now();
            }
        }
        let after = input.metadata().map_err(err)?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("Export changed while being read; retry after the export finishes".into());
        }
        snapshot.flush().map_err(err)?;
        let input_sha256 = format!("{:x}", sha.finalize());
        if let Some(m) = old.as_ref().filter(|m| m.input_sha256 == input_sha256) {
            // Validate the durable facts before an idempotent shortcut. Missing
            // shards are repaired by reparsing; corrupt immutable files fail.
            if self.shards_present(m, progress)? {
                let conflicts = self.reconcile_summaries(m, dry_run);
                let mut report = Report {
                    complete: conflicts.is_empty(),
                    dry_run,
                    data_changed: false,
                    input_sha256,
                    record_count: m.record_count,
                    changed_days: 0,
                    unchanged_days: m.day_count,
                    summary_conflicts: conflicts,
                    warnings: vec![],
                };
                if !dry_run {
                    if let Err(e) = self.remember(&source) {
                        report.complete = false;
                        report.warnings.push(e);
                    }
                }
                return Ok(report);
            }
        }
        progress("Parsing the complete Apple Health export");
        let staging = tempfile::tempdir().map_err(err)?;
        let mut db = staging_db(staging.path())?;
        let tx = db.transaction().map_err(err)?;
        let stats;
        let attachments;
        let mut touched = BTreeSet::new();
        {
            let mut insert = tx
                .prepare("INSERT INTO records VALUES (?1,?2,?3,?4,?5)")
                .map_err(err)?;
            let mut count = 0u64;
            stats = parse_export(snapshot.path(), |record| {
                touched.insert(record.day.clone());
                stage_record(&mut insert, &record)?;
                count += 1;
                if last_progress.elapsed().as_secs() >= 10 {
                    progress(&format!("Parsed {count} records"));
                    last_progress = std::time::Instant::now();
                }
                Ok(())
            })?;
            progress("Preserving original Apple Health attachments");
            attachments = extract_attachments(snapshot.path(), staging.path())?;
            for attachment in &attachments {
                touched.insert(attachment.record.day.clone());
                stage_record(&mut insert, &attachment.record)?;
            }
            if let Some(previous) = &old {
                for (day, entry) in &previous.days {
                    touched.insert(day.clone());
                    for shard in &entry.shards {
                        if shard.source != "apple-health" {
                            self.read_shard(day, shard, &mut |record| {
                                stage_record(&mut insert, &record)
                            })?;
                        }
                    }
                }
            }
        }
        tx.commit().map_err(err)?;
        let export_date = stats.export_date.ok_or("Missing ExportDate: select a complete Apple Health export, not a filtered XML fragment")?;
        progress("Sorting records and preparing changed days");
        let days = self.prepare_days(&db, staging.path(), &touched, &old, dry_run, progress)?;
        let mut manifest = old.clone().unwrap_or_else(empty_manifest);
        manifest.input_sha256 = input_sha256.clone();
        manifest.export_date = export_date.clone();
        manifest.root_attributes = stats.root_attributes;
        manifest.ignored_attachments = 0;
        manifest
            .attachments
            .retain(|_, attachment| attachment.source != "apple-health");
        for attachment in &attachments {
            self.persist_attachment(attachment, staging.path(), dry_run)?;
            manifest.attachments.insert(
                attachment.relative_path.to_string_lossy().into_owned(),
                AttachmentRef {
                    source: "apple-health".into(),
                    sha256: attachment.sha256.clone(),
                    collection: None,
                },
            );
        }
        manifest.days = days;
        manifest.sources.insert(
            "apple-health".into(),
            SourceState {
                input_sha256: Some(input_sha256),
                export_date: Some(export_date),
                collections: BTreeMap::new(),
            },
        );
        let mut report = self.commit(manifest, &old, dry_run)?;
        if !dry_run {
            if let Err(e) = self.remember(&source) {
                report.complete = false;
                report.warnings.push(format!(
                    "Data committed, but could not remember the source: {e}"
                ));
            }
        }
        Ok(report)
    }

    pub fn apply_provider(
        &self,
        staged_jsonl: &Path,
        report: &FetchReport,
        dry_run: bool,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Report> {
        if !matches!(report.source.as_str(), "garmin" | "oura") {
            return Err("Only Garmin/Oura supplements are accepted by this operation".into());
        }
        let dates = window_days(&report.since, &report.until)?;
        let mut collections = BTreeMap::new();
        for result in &report.collections {
            if result.collection.is_empty()
                || !valid_coverage(&result.status)
                || collections
                    .insert(result.collection.as_str(), result)
                    .is_some()
            {
                return Err("Invalid or duplicate collection report".into());
            }
        }
        if collections.is_empty() {
            return Err("Provider report has no collections".into());
        }
        let complete: BTreeSet<_> = collections
            .iter()
            .filter(|(_, c)| c.status == "complete")
            .map(|(name, _)| format!("{}.{}", report.source, name))
            .collect();
        let _lock = self.lock()?;
        let old = self.manifest()?;
        self.check_owned(&old)?;
        let staging = tempfile::tempdir().map_err(err)?;
        let mut db = staging_db(staging.path())?;
        let tx = db.transaction().map_err(err)?;
        tx.execute_batch(
            "CREATE TABLE provider_seen(identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);",
        )
        .map_err(err)?;
        let mut touched: BTreeSet<String> = if complete.is_empty() {
            BTreeSet::new()
        } else {
            dates.iter().cloned().collect()
        };
        let mut counts: BTreeMap<(String, String), u64> = BTreeMap::new();
        let mut totals: BTreeMap<String, u64> = BTreeMap::new();
        let mut attachments = vec![];
        {
            let mut insert = tx
                .prepare("INSERT INTO records VALUES (?1,?2,?3,?4,?5)")
                .map_err(err)?;
            let mut remember = tx
                .prepare("INSERT OR IGNORE INTO provider_seen(identity,fingerprint) VALUES (?1,?2)")
                .map_err(err)?;
            let mut remembered = tx
                .prepare("SELECT fingerprint FROM provider_seen WHERE identity=?1")
                .map_err(err)?;
            let mut last = std::time::Instant::now();
            for line in BufReader::new(File::open(staged_jsonl).map_err(err)?).lines() {
                let mut provider: ProviderRecord =
                    serde_json::from_str(&line.map_err(err)?).map_err(err)?;
                if provider.source != report.source {
                    return Err("Staged provider source disagrees with report".into());
                }
                let result = collections
                    .get(provider.collection.as_str())
                    .ok_or("Staged record has no collection report")?;
                // An adapter can have emitted pages before a later page fails.
                // Such a partial collection must not become current data.
                if result.status != "complete" {
                    continue;
                }
                if provider.day != "_undated"
                    && (!valid_day(&provider.day)
                        || provider.day < report.since
                        || provider.day > report.until)
                {
                    return Err("Provider record is outside the completed date window".into());
                }
                // Validate the adapter's raw receive count before deduplicating
                // mirrored or overlapping pages. Apple samples never use this table.
                *totals.entry(provider.collection.clone()).or_default() += 1;
                let fingerprint = json_hash(&(&provider.day, &provider.data))?;
                let identity = match &provider.id {
                    Some(id) => format!(
                        "id:{}",
                        json_hash(&(&provider.source, &provider.collection, id))?
                    ),
                    None => format!(
                        "content:{}",
                        json_hash(&(&provider.source, &provider.collection, &fingerprint))?
                    ),
                };
                if remember
                    .execute(params![identity, fingerprint])
                    .map_err(err)?
                    == 0
                {
                    let previous: String = remembered
                        .query_row([&identity], |row| row.get(0))
                        .map_err(err)?;
                    if previous != fingerprint {
                        return Err(format!("Conflicting provider ID in {}.{}: payload or day changed within the same fetch", provider.source, provider.collection));
                    }
                    continue;
                }
                *counts
                    .entry((provider.collection.clone(), provider.day.clone()))
                    .or_default() += 1;
                touched.insert(provider.day.clone());
                let bytes = stage_provider_attachment(&mut provider, staging.path())?;
                let mut attributes =
                    BTreeMap::from([("sourceName".into(), provider.source.clone())]);
                if let Some(id) = provider.id {
                    attributes.insert("providerId".into(), id);
                }
                let record = HealthRecord {
                    schema_version: 1,
                    ingest_source: provider.source.clone(),
                    kind: "Supplement".into(),
                    day: provider.day,
                    metric: format!("{}.{}", provider.source, provider.collection),
                    attributes,
                    children: vec![],
                    text: String::new(),
                    text_segments: None,
                    payload: Some(provider.data),
                };
                if let Some((file, relative_path, sha256)) = bytes {
                    attachments.push((
                        provider.collection,
                        Attachment {
                            record: record.clone(),
                            file,
                            relative_path,
                            sha256,
                        },
                    ));
                }
                stage_record(&mut insert, &record)?;
                if last.elapsed().as_secs() >= 10 {
                    progress("Staging provider records");
                    last = std::time::Instant::now();
                }
            }
            for (name, result) in &collections {
                if result.status == "complete"
                    && totals.get(*name).copied().unwrap_or(0) != result.records
                {
                    return Err(format!(
                        "Collection {name} record count disagrees with staged data"
                    ));
                }
            }
            if old
                .as_ref()
                .and_then(|m| m.days.get("_undated"))
                .is_some_and(|d| {
                    d.shards
                        .iter()
                        .any(|s| s.source == report.source && complete.contains(&s.metric))
                })
            {
                touched.insert("_undated".into());
            }
            if let Some(previous) = &old {
                for day in &touched {
                    if let Some(entry) = previous.days.get(day) {
                        for shard in &entry.shards {
                            if shard.source == report.source && complete.contains(&shard.metric) {
                                continue;
                            }
                            self.read_shard(day, shard, &mut |record| {
                                stage_record(&mut insert, &record)
                            })?;
                        }
                    }
                }
            }
        }
        tx.commit().map_err(err)?;
        progress("Preparing daily source-of-truth files");
        let days = self.prepare_days(&db, staging.path(), &touched, &old, dry_run, progress)?;
        let mut manifest = old.clone().unwrap_or_else(empty_manifest);
        manifest.days = days;
        manifest.attachments.retain(|path, attachment| {
            let day = path.split('/').nth(2).unwrap_or("");
            let in_window =
                day == "_undated" || (day >= report.since.as_str() && day <= report.until.as_str());
            !(attachment.source == report.source
                && in_window
                && attachment
                    .collection
                    .as_ref()
                    .is_some_and(|c| complete.contains(&format!("{}.{}", report.source, c))))
        });
        for (collection, attachment) in &attachments {
            self.persist_attachment(attachment, staging.path(), dry_run)?;
            manifest.attachments.insert(
                attachment.relative_path.to_string_lossy().into_owned(),
                AttachmentRef {
                    source: report.source.clone(),
                    sha256: attachment.sha256.clone(),
                    collection: Some(collection.clone()),
                },
            );
        }
        let state = manifest.sources.entry(report.source.clone()).or_default();
        for (name, result) in &collections {
            let coverage = state.collections.entry((*name).to_string()).or_default();
            for day in &dates {
                let record_count = if result.status == "complete" {
                    counts
                        .get(&(name.to_string(), day.clone()))
                        .copied()
                        .unwrap_or(0)
                } else {
                    coverage.get(day).map(|c| c.record_count).unwrap_or(0)
                };
                coverage.insert(
                    day.clone(),
                    Coverage {
                        status: result.status.clone(),
                        error: result.error.clone(),
                        record_count,
                    },
                );
            }
            if result.status == "complete" && touched.contains("_undated") {
                coverage.insert(
                    "_undated".into(),
                    Coverage {
                        status: "complete".into(),
                        error: None,
                        record_count: counts
                            .get(&(name.to_string(), "_undated".into()))
                            .copied()
                            .unwrap_or(0),
                    },
                );
            }
        }
        let mut outcome = self.commit(manifest, &old, dry_run)?;
        for (name, result) in collections {
            if result.status != "complete" {
                outcome.complete = false;
                outcome.warnings.push(format!(
                    "{}.{}: {}{}",
                    report.source,
                    name,
                    result.status,
                    result
                        .error
                        .as_ref()
                        .map(|e| format!(" ({e})"))
                        .unwrap_or_default()
                ));
            }
        }
        Ok(outcome)
    }

    pub fn catalog(&self) -> Result<Value> {
        let Some(manifest) = self.manifest()? else {
            return Ok(json!({"categories":[],"sources":{}}));
        };
        let mut groups: BTreeMap<String, BTreeMap<(String, String), MetricRange>> = BTreeMap::new();
        for (day, entry) in &manifest.days {
            for shard in &entry.shards {
                groups
                    .entry(shard.category.clone())
                    .or_default()
                    .entry((shard.metric.clone(), shard.source.clone()))
                    .or_default()
                    .add(day, shard.record_count)?;
            }
        }
        let mut categories = vec![];
        for (slug, entries) in groups {
            let mut all = MetricRange::default();
            let mut metrics = vec![];
            for ((metric, source), range) in entries {
                all.record_count = all
                    .record_count
                    .checked_add(range.record_count)
                    .ok_or("Catalog count overflow")?;
                for day in [range.first_day.as_deref(), range.last_day.as_deref()]
                    .into_iter()
                    .flatten()
                {
                    all.add(day, 0)?;
                }
                metrics.push(json!({"metric":metric,"source":source,"record_count":range.record_count,"first_day":range.first_day,"last_day":range.last_day}));
            }
            categories.push(json!({"slug":slug,"record_count":all.record_count,"first_day":all.first_day,"last_day":all.last_day,"metrics":metrics}));
        }
        Ok(json!({"categories":categories,"sources":source_summary(&manifest)}))
    }

    fn ensure_owned(&self) -> Result<()> {
        let marker = self.health().join(".health-sync-v2");
        if !marker.exists() {
            atomic_write(&marker, b"notemd.health-sync\n")?;
        }
        Ok(())
    }

    fn check_owned(&self, old: &Option<Manifest>) -> Result<()> {
        safe_path(&self.health())?;
        if old.is_none()
            && self.health().exists()
            && fs::read_dir(self.health()).map_err(err)?.next().is_some()
        {
            let marker = self.health().join(".health-sync-v2");
            safe_path(&marker)?;
            if fs::read(&marker).ok().as_deref() != Some(b"notemd.health-sync\n") {
                return Err("health/ already contains files without a Health Sync manifest; choose a different vault or move that directory".into());
            }
        }
        Ok(())
    }

    fn persist_attachment(
        &self,
        attachment: &Attachment,
        staging: &Path,
        dry_run: bool,
    ) -> Result<()> {
        let relative = attachment
            .relative_path
            .to_str()
            .ok_or("Non-UTF8 attachment destination")?;
        if !valid_attachment_path(relative) || !valid_hash(&attachment.sha256) {
            return Err("Invalid attachment destination or hash".into());
        }
        let file = attachment.file.canonicalize().map_err(err)?;
        if !file.starts_with(staging.canonicalize().map_err(err)?) {
            return Err("Attachment is outside staging directory".into());
        }
        if dry_run {
            return Ok(());
        }
        self.ensure_owned()?;
        let path = self.vault.join(&attachment.relative_path);
        match existing_hash(&path)? {
            Some(h) if h == attachment.sha256 => Ok(()),
            Some(_) => Err(format!("Corrupt immutable attachment: {relative}")),
            None => {
                mkdir(path.parent().unwrap())?;
                let mut destination = NamedTempFile::new_in(path.parent().unwrap()).map_err(err)?;
                std::io::copy(&mut File::open(file).map_err(err)?, &mut destination)
                    .map_err(err)?;
                destination.as_file().sync_all().map_err(err)?;
                if existing_hash(destination.path())?.as_deref() != Some(&attachment.sha256) {
                    return Err("Attachment content changed before publication".into());
                }
                destination.persist_noclobber(&path).map_err(err)?;
                File::open(path.parent().unwrap())
                    .and_then(|f| f.sync_all())
                    .map_err(err)
            }
        }
    }

    fn read_shard(
        &self,
        day: &str,
        shard: &Shard,
        callback: &mut dyn FnMut(HealthRecord) -> Result<()>,
    ) -> Result<()> {
        let path = self.shard_path(day, shard);
        if existing_hash(&path)?.as_deref() != Some(&shard.sha256) {
            return Err(format!(
                "Missing or corrupt health shard for {day}: {}",
                shard.filename()
            ));
        }
        let mut count = 0u64;
        for line in BufReader::new(File::open(&path).map_err(err)?).lines() {
            let record: HealthRecord = serde_json::from_str(&line.map_err(err)?).map_err(err)?;
            if record.day != day
                || record.ingest_source != shard.source
                || record.metric != shard.metric
                || catalog::category(&record.metric, &record.kind) != shard.category
            {
                return Err(format!(
                    "Shard membership disagrees with manifest for {day}"
                ));
            }
            callback(record)?;
            count += 1;
        }
        if count != shard.record_count {
            return Err(format!("Shard count disagrees for {day}"));
        }
        Ok(())
    }

    fn finish_shard(&self, mut built: ShardBuilder, dry_run: bool) -> Result<Shard> {
        built.file.flush().map_err(err)?;
        let entry = Shard {
            source: built.source,
            metric: built.metric,
            category: built.category,
            sha256: format!("{:x}", built.sha.finalize()),
            record_count: built.count,
        };
        if !dry_run {
            self.ensure_owned()?;
            let path = self.shard_path(&built.day, &entry);
            match existing_hash(&path)? {
                Some(h) if h == entry.sha256 => {}
                Some(_) => return Err(format!("Corrupt immutable shard: {}", path.display())),
                None => {
                    mkdir(path.parent().unwrap())?;
                    let mut dest = NamedTempFile::new_in(path.parent().unwrap()).map_err(err)?;
                    std::io::copy(
                        &mut File::open(built.file.get_ref().path()).map_err(err)?,
                        &mut dest,
                    )
                    .map_err(err)?;
                    dest.as_file().sync_all().map_err(err)?;
                    dest.persist_noclobber(&path).map_err(err)?;
                    File::open(path.parent().unwrap())
                        .and_then(|f| f.sync_all())
                        .map_err(err)?;
                }
            }
        }
        Ok(entry)
    }

    fn prepare_days(
        &self,
        db: &Connection,
        dir: &Path,
        touched: &BTreeSet<String>,
        old: &Option<Manifest>,
        dry_run: bool,
        progress: &mut dyn FnMut(&str),
    ) -> Result<BTreeMap<String, Day>> {
        db.execute_batch("CREATE INDEX records_by_day ON records(day);")
            .map_err(err)?;
        let mut days = old.as_ref().map(|m| m.days.clone()).unwrap_or_default();
        let mut stmt = db.prepare("SELECT source,metric,category,payload FROM records WHERE day=?1 ORDER BY source,metric,category,payload").map_err(err)?;
        let mut last = std::time::Instant::now();
        for day in touched {
            let mut rows = stmt.query([day]).map_err(err)?;
            let mut built = DayBuilder::new(day);
            let mut current: Option<ShardBuilder> = None;
            while let Some(row) = rows.next().map_err(err)? {
                let source: String = row.get(0).map_err(err)?;
                let metric: String = row.get(1).map_err(err)?;
                let category: String = row.get(2).map_err(err)?;
                let payload: String = row.get(3).map_err(err)?;
                if current.as_ref().is_some_and(|s| {
                    s.source != source || s.metric != metric || s.category != category
                }) {
                    built
                        .shards
                        .push(self.finish_shard(current.take().unwrap(), dry_run)?);
                }
                if current.is_none() {
                    current = Some(ShardBuilder::new(day, source, metric, category, dir)?);
                }
                current.as_mut().unwrap().add(&payload)?;
                built.add(&payload)?;
                if last.elapsed().as_secs() >= 10 {
                    progress(&format!("Preparing {day}"));
                    last = std::time::Instant::now();
                }
            }
            if let Some(shard) = current {
                built.shards.push(self.finish_shard(shard, dry_run)?);
            }
            let sha256 = shard_digest(&built.shards)?;
            let summary = render_summary(&built);
            let summary_sha256 = hash(summary.as_bytes());
            let previous = old.as_ref().and_then(|m| m.days.get(day));
            if let Some(previous) =
                previous.filter(|p| p.sha256 == sha256 && p.summary_sha256 == summary_sha256)
            {
                days.insert(day.clone(), previous.clone());
                continue;
            }
            let existing = existing_hash(&self.summary_path(day))?;
            let previous_summary_sha256 = previous.and_then(|p| {
                existing
                    .as_ref()
                    .filter(|h| {
                        *h == &p.summary_sha256
                            || Some(h.as_str()) == p.previous_summary_sha256.as_deref()
                    })
                    .cloned()
            });
            days.insert(
                day.clone(),
                Day {
                    sha256,
                    shards: built.shards,
                    record_count: built.count,
                    summary_sha256,
                    previous_summary_sha256,
                    summary,
                },
            );
        }
        Ok(days)
    }

    fn commit(
        &self,
        mut manifest: Manifest,
        old: &Option<Manifest>,
        dry_run: bool,
    ) -> Result<Report> {
        manifest.record_count = manifest
            .days
            .values()
            .try_fold(0u64, |sum, d| sum.checked_add(d.record_count))
            .ok_or("Manifest count overflow")?;
        manifest.day_count = manifest
            .days
            .values()
            .filter(|d| d.record_count > 0)
            .count();
        let changed_days = manifest
            .days
            .iter()
            .filter(|(day, entry)| {
                old.as_ref()
                    .and_then(|m| m.days.get(*day))
                    .map(|d| &d.sha256)
                    != Some(&entry.sha256)
            })
            .count();
        let data_changed = old.as_ref() != Some(&manifest);
        if !dry_run && data_changed {
            self.ensure_owned()?;
            atomic_write(
                &self.health().join("manifest.json"),
                &serde_json::to_vec_pretty(&manifest).map_err(err)?,
            )?;
        }
        let conflicts = self.reconcile_summaries(&manifest, dry_run);
        Ok(Report {
            complete: conflicts.is_empty(),
            dry_run,
            data_changed,
            input_sha256: manifest.input_sha256,
            record_count: manifest.record_count,
            changed_days,
            unchanged_days: manifest.days.len() - changed_days,
            summary_conflicts: conflicts,
            warnings: vec![],
        })
    }

    fn shards_present(&self, manifest: &Manifest, progress: &mut dyn FnMut(&str)) -> Result<bool> {
        let mut present = true;
        let mut last = std::time::Instant::now();
        for (day, entry) in &manifest.days {
            for shard in &entry.shards {
                match existing_hash(&self.shard_path(day, shard))? {
                    None => present = false,
                    Some(hash) if hash == shard.sha256 => {}
                    Some(_) => {
                        return Err(format!(
                        "Corrupt immutable shard for {day}; restore it from backup before importing"
                    ))
                    }
                }
            }
            if last.elapsed().as_secs() >= 10 {
                progress("Verifying existing health shards");
                last = std::time::Instant::now();
            }
        }
        for (path, attachment) in &manifest.attachments {
            match existing_hash(&self.vault.join(path))? {
                None => present = false,
                Some(h) if h == attachment.sha256 => {}
                Some(_) => return Err(format!("Corrupt immutable attachment: {path}")),
            }
            if last.elapsed().as_secs() >= 10 {
                progress("Verifying original health attachments");
                last = std::time::Instant::now();
            }
        }
        Ok(present)
    }

    fn reconcile_summaries(&self, m: &Manifest, dry_run: bool) -> Vec<String> {
        let mut conflicts = vec![];
        for (day, entry) in &m.days {
            let path = self.summary_path(day);
            let result = (|| -> Result<()> {
                let existing = existing_hash(&path)?;
                if existing.as_deref() == Some(&entry.summary_sha256) {
                    return Ok(());
                }
                if existing.is_some()
                    && existing.as_deref() != entry.previous_summary_sha256.as_deref()
                {
                    return Err("manually edited or unowned summary was preserved".into());
                }
                if !dry_run {
                    atomic_write(&path, entry.summary.as_bytes())?;
                }
                Ok(())
            })();
            if let Err(e) = result {
                conflicts.push(format!("health/daily/{day}-health.md: {e}"));
            }
        }
        conflicts
    }

    pub fn query(
        &self,
        since: Option<&str>,
        until: Option<&str>,
        metric: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Value> {
        self.query_filtered(
            QueryFilter {
                since,
                until,
                metric,
                ..Default::default()
            },
            limit,
            offset,
        )
    }

    pub fn query_filtered(
        &self,
        filter: QueryFilter<'_>,
        limit: usize,
        offset: usize,
    ) -> Result<Value> {
        let QueryFilter {
            since,
            until,
            metric,
            category,
            source,
        } = filter;
        if category.is_some_and(|c| !valid_category(c)) || source.is_some_and(|s| !valid_source(s))
        {
            return Err("Unknown health category or source".into());
        }
        for day in [since, until].into_iter().flatten() {
            if !valid_day(day) {
                return Err("Dates must be YYYY-MM-DD".into());
            }
        }
        if since.zip(until).is_some_and(|(a, b)| a > b) {
            return Err("--since must not be later than --until".into());
        }
        if limit == 0 || limit > 1000 {
            return Err("--limit must be between 1 and 1000".into());
        }
        let m = self.manifest()?.ok_or("No imported health snapshot")?;
        let mut records = vec![];
        let mut matched = 0usize;
        for (day, entry) in &m.days {
            if entry.record_count == 0
                || (day == "_undated" && (since.is_some() || until.is_some()))
                || since.is_some_and(|s| day.as_str() < s)
                || until.is_some_and(|s| day.as_str() > s)
            {
                continue;
            }
            for shard in &entry.shards {
                if metric.is_some_and(|v| shard.metric != v)
                    || category.is_some_and(|v| shard.category != v)
                    || source.is_some_and(|v| shard.source != v)
                {
                    continue;
                }
                let mut more = false;
                self.read_shard(day, shard, &mut |record| {
                    if matched >= offset {
                        if records.len() == limit {
                            more = true;
                        } else {
                            records.push(record);
                        }
                    }
                    matched = matched.checked_add(1).ok_or("Query count overflow")?;
                    Ok(())
                })?;
                if more {
                    return Ok(
                        json!({"records":records,"has_more":true,"next_offset":offset.checked_add(limit).ok_or("Query offset overflow")?,"input_sha256":m.input_sha256}),
                    );
                }
            }
        }
        Ok(
            json!({"records":records,"has_more":false,"next_offset":Value::Null,"input_sha256":m.input_sha256}),
        )
    }
}

fn empty_manifest() -> Manifest {
    Manifest {
        schema_version: 2,
        source: "apple-health".into(),
        scope: "daily-ssot".into(),
        input_sha256: String::new(),
        export_date: String::new(),
        root_attributes: BTreeMap::new(),
        record_count: 0,
        day_count: 0,
        ignored_attachments: 0,
        days: BTreeMap::new(),
        sources: BTreeMap::new(),
        attachments: BTreeMap::new(),
    }
}

#[derive(Default)]
struct MetricRange {
    record_count: u64,
    first_day: Option<String>,
    last_day: Option<String>,
}
impl MetricRange {
    fn add(&mut self, day: &str, count: u64) -> Result<()> {
        self.record_count = self
            .record_count
            .checked_add(count)
            .ok_or("Catalog count overflow")?;
        if valid_day(day) {
            if self.first_day.as_deref().is_none_or(|v| day < v) {
                self.first_day = Some(day.into());
            }
            if self.last_day.as_deref().is_none_or(|v| day > v) {
                self.last_day = Some(day.into());
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct Group {
    count: u64,
    numeric_count: u64,
    min: Option<f64>,
    max: Option<f64>,
}
type GroupKey = (String, String, String, String);
struct DayBuilder {
    day: String,
    shards: Vec<Shard>,
    count: u64,
    groups: BTreeMap<GroupKey, Group>,
}
impl DayBuilder {
    fn new(day: &str) -> Self {
        Self {
            day: day.into(),
            shards: vec![],
            count: 0,
            groups: BTreeMap::new(),
        }
    }
    fn add(&mut self, payload: &str) -> Result<()> {
        self.count += 1;
        let record: HealthRecord = serde_json::from_str(payload).map_err(err)?;
        if record.ingest_source != "apple-health" || record.kind == "Attachment" {
            return Ok(());
        }
        let attr = |key: &str| record.attributes.get(key).cloned().unwrap_or_default();
        let group = self
            .groups
            .entry((
                record.metric.clone(),
                attr("sourceName"),
                attr("device"),
                attr("unit"),
            ))
            .or_default();
        group.count += 1;
        if let Ok(value) = attr("value").parse::<f64>() {
            if value.is_finite() {
                group.numeric_count += 1;
                group.min = Some(group.min.map_or(value, |v| v.min(value)));
                group.max = Some(group.max.map_or(value, |v| v.max(value)));
            }
        }
        Ok(())
    }
}
struct ShardBuilder {
    day: String,
    source: String,
    metric: String,
    category: String,
    file: BufWriter<NamedTempFile>,
    sha: Sha256,
    count: u64,
}
impl ShardBuilder {
    fn new(
        day: &str,
        source: String,
        metric: String,
        category: String,
        dir: &Path,
    ) -> Result<Self> {
        Ok(Self {
            day: day.into(),
            source,
            metric,
            category,
            file: BufWriter::new(NamedTempFile::new_in(dir).map_err(err)?),
            sha: Sha256::new(),
            count: 0,
        })
    }
    fn add(&mut self, payload: &str) -> Result<()> {
        self.file
            .write_all(payload.as_bytes())
            .and_then(|_| self.file.write_all(b"\n"))
            .map_err(err)?;
        self.sha.update(payload.as_bytes());
        self.sha.update(b"\n");
        self.count += 1;
        Ok(())
    }
}
fn cell(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('|', "&#124;")
        .replace(['\r', '\n'], " ")
        .replace('\u{0060}', "&#96;")
}
fn render_summary(day: &DayBuilder) -> String {
    let mut s = format!("# 健康档案 · {}\n\n当前有效记录数：{}。本日只有一份有效清单，Apple Health 为综合主档案，Garmin/Oura 为来源明确的补充；不猜测跨源关联，不跨来源或设备累加。\n\nApple 日期取原始 startDate（其次 dateComponents / creationDate），保留来源时区；跨日样本完整归起始日。补充记录采用厂商提供的日期，无日期元数据归入 _undated。\n\n此文件由 Health Sync 生成；个人批注请写入同名 .note.md 文件。\n", day.day, day.count);
    if day.count == 0 {
        s.push_str("\n当前快照已无该日期记录；历史原始分片仍保留。\n");
        return s;
    }
    s.push_str("\n## 分类与原始记录\n\n| 分类 | 采集来源 | 指标/集合 | 记录数 | 原始数据 |\n| --- | --- | --- | ---: | --- |\n");
    for shard in &day.shards {
        s.push_str(&format!(
            "| {} | {} | {} | {} | [JSONL](../data/{}/{}) |\n",
            cell(&shard.category),
            cell(&shard.source),
            cell(&shard.metric),
            shard.record_count,
            day.day,
            shard.filename()
        ));
    }
    if !day.groups.is_empty() {
        s.push_str("\n## Apple Health 样本\n\n以下是独立样本数量和数值范围，不是健康 App 的每日综合数值。厂商补充记录不参与此表统计。\n\n| 指标 | 写入应用 | 设备 | 单位 | 样本数 | 数值样本数 | 最小值 | 最大值 |\n| --- | --- | --- | --- | ---: | ---: | ---: | ---: |\n");
        for ((metric, source, device, unit), g) in &day.groups {
            s.push_str(&format!(
                "| {} | {} | {} | {} | {} | {} | {} | {} |\n",
                cell(metric),
                cell(source),
                cell(device),
                cell(unit),
                g.count,
                g.numeric_count,
                g.min.map(|v| v.to_string()).unwrap_or_else(|| "—".into()),
                g.max.map(|v| v.to_string()).unwrap_or_else(|| "—".into())
            ));
        }
    }
    s
}
