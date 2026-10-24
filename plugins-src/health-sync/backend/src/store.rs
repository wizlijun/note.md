//! One active daily index across Apple snapshots and provider supplements.
//! Immutable shards precede the atomic manifest;
//! generated Markdown is recoverable and never the source of truth.
use crate::{
    attachments::{extract_for_layout, Attachment},
    auth::GarminRegion,
    catalog,
    layout::Layout,
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub accounts: BTreeMap<String, AccountState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub garmin_region: Option<GarminRegion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_date: Option<String>,
    pub collections: BTreeMap<String, BTreeMap<String, Coverage>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub garmin_region: Option<GarminRegion>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
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

/// A file produced by the trusted ZIP parser, never a path taken from JSON.
pub struct ExportAttachment {
    pub file: PathBuf,
    pub filename: String,
    pub sha256: String,
}

pub struct Store {
    vault: PathBuf,
    local: PathBuf,
    layout: Layout,
}

#[derive(Default)]
pub struct QueryFilter<'a> {
    pub since: Option<&'a str>,
    pub until: Option<&'a str>,
    pub metric: Option<&'a str>,
    pub category: Option<&'a str>,
    pub source: Option<&'a str>,
    pub account_id: Option<&'a str>,
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
fn attachment_path_parts(value: &str) -> Option<(&str, &str)> {
    let parts: Vec<_> = value.split('/').collect();
    let (day, filename) = match parts.as_slice() {
        ["health", "attachments", day, filename] => (*day, *filename),
        ["ssot", "health", year, day, "attachments", filename]
            if valid_day(day) && *year == &day[..4] =>
        {
            (*day, *filename)
        }
        ["ssot", "health", "_undated", "attachments", filename] => ("_undated", *filename),
        _ => return None,
    };
    Some((day, filename))
}
fn valid_attachment_path(value: &str) -> bool {
    let Some((day, filename)) = attachment_path_parts(value) else {
        return false;
    };
    (valid_day(day) || day == "_undated")
        && !filename.is_empty()
        && !filename.starts_with('.')
        && filename
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}
fn valid_coverage(status: &str) -> bool {
    matches!(status, "complete" | "unavailable" | "failed" | "observed")
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
    account_id: Option<&str>,
    layout: Layout,
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
    let relative = layout.attachments(&record.day).join(format!(
        "{}-{}-{}-{}.{}",
        account_id
            .map(|id| format!("{}-{id}", record.source))
            .unwrap_or_else(|| record.source.clone()),
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

fn stage_export_attachment(
    record: &mut ProviderRecord,
    attachment: &ExportAttachment,
    root: &Path,
    staging: &Path,
    account_id: &str,
    layout: Layout,
) -> Result<(PathBuf, PathBuf, String)> {
    if !valid_hash(&attachment.sha256) {
        return Err("Invalid Garmin export attachment checksum".into());
    }
    let path = attachment.file.canonicalize().map_err(err)?;
    if !path.starts_with(root.canonicalize().map_err(err)?) || !path.is_file() {
        return Err("Garmin export attachment is outside private staging directory".into());
    }
    let mut input = File::open(path).map_err(err)?;
    let mut output = NamedTempFile::new_in(staging).map_err(err)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    let mut size = 0u64;
    loop {
        let length = input.read(&mut buffer).map_err(err)?;
        if length == 0 {
            break;
        }
        output.write_all(&buffer[..length]).map_err(err)?;
        digest.update(&buffer[..length]);
        size = size
            .checked_add(length as u64)
            .ok_or("Attachment size overflow")?;
    }
    let checksum = format!("{:x}", digest.finalize());
    if checksum != attachment.sha256 {
        return Err("Garmin export attachment checksum mismatch".into());
    }
    output.flush().map_err(err)?;
    let filename = attachment.filename.rsplit(['/', '\\']).next().unwrap_or("");
    let extension = filename
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 12 && ext.bytes().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or("bin")
        .to_ascii_lowercase();
    let relative = layout.attachments(&record.day).join(format!(
        "garmin-{account_id}-{}-{checksum}.{extension}",
        catalog::metric_slug(&record.collection)
    ));
    let payload = record
        .data
        .as_object_mut()
        .ok_or("Garmin export attachment metadata must be an object")?;
    payload.insert("attachment_path".into(), json!(relative.to_string_lossy()));
    payload.insert("filename".into(), json!(attachment.filename));
    payload.insert("sha256".into(), json!(checksum));
    payload.insert("size".into(), json!(size));
    let (file, path) = output.keep().map_err(err)?;
    drop(file);
    Ok((path, relative, checksum))
}

fn coverage_summary(collections: &BTreeMap<String, BTreeMap<String, Coverage>>) -> Value {
    let mut result = serde_json::Map::new();
    for (collection, coverage) in collections {
        let dates: Vec<_> = coverage.iter().filter(|(day, _)| valid_day(day)).collect();
        result.insert(collection.clone(), json!({
            "complete_days":dates.iter().filter(|(_,c)|c.status == "complete").count(),
            "observed_days":dates.iter().filter(|(_,c)|c.status == "observed").count(),
            "unavailable_days":dates.iter().filter(|(_,c)|c.status == "unavailable").count(),
            "failed_days":dates.iter().filter(|(_,c)|c.status == "failed").count(),
            "first_coverage_day":dates.first().map(|(d,_)|d), "last_coverage_day":dates.last().map(|(d,_)|d),
            "undated":coverage.get("_undated"),
        }));
    }
    Value::Object(result)
}

fn source_summary(manifest: &Manifest) -> Value {
    let mut sources = serde_json::Map::new();
    for (source, state) in &manifest.sources {
        let mut aggregate = state.collections.clone();
        let mut accounts = serde_json::Map::new();
        for (id, account) in &state.accounts {
            let mut count = 0u64;
            for (collection, dates) in &account.collections {
                for (day, coverage) in dates {
                    count += coverage.record_count;
                    let merged = aggregate
                        .entry(collection.clone())
                        .or_default()
                        .entry(day.clone())
                        .or_insert(Coverage {
                            status: "complete".into(),
                            error: None,
                            record_count: 0,
                        });
                    merged.record_count += coverage.record_count;
                    if coverage.status == "failed"
                        || (coverage.status == "unavailable" && merged.status != "failed")
                        || (coverage.status == "observed" && merged.status == "complete")
                    {
                        merged.status = coverage.status.clone();
                        merged.error = coverage.error.clone();
                    }
                }
            }
            accounts.insert(id.clone(),json!({"region":account.garmin_region,"record_count":count,"collections":coverage_summary(&account.collections)}));
        }
        let record_count: u64 = manifest
            .days
            .values()
            .flat_map(|d| d.shards.iter())
            .filter(|s| &s.source == source)
            .map(|s| s.record_count)
            .sum();
        sources.insert(source.clone(), json!({"record_count":record_count,"input_sha256":state.input_sha256,
            "export_date":state.export_date,"collections":coverage_summary(&aggregate),"accounts":accounts}));
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
        let current = vault.join(Layout::Daily.root()).join("manifest.json");
        let legacy = vault.join(Layout::Legacy.root()).join("manifest.json");
        safe_path(&current)?;
        let legacy_exists = match fs::symlink_metadata(&legacy) {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(err(e)),
        };
        if legacy_exists {
            safe_path(&legacy)?;
        }
        if current.exists() && legacy_exists {
            return Err("Both ssot/health/manifest.json and health/manifest.json exist; consolidate the archives before importing".into());
        }
        let layout = if legacy_exists {
            Layout::Legacy
        } else {
            Layout::Daily
        };
        Ok(Self {
            vault,
            local,
            layout,
        })
    }

    fn health(&self) -> PathBuf {
        self.vault.join(self.layout.root())
    }
    fn summary_path(&self, day: &str) -> PathBuf {
        self.vault.join(self.layout.summary(day))
    }
    fn shard_path(&self, day: &str, entry: &Shard) -> PathBuf {
        self.vault.join(self.layout.day(day)).join(entry.filename())
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
        if !matches!(m.schema_version, 2 | 3)
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
            if (m.schema_version < 3
                && (!state.accounts.is_empty() || state.legacy_account_id.is_some()))
                || state
                    .legacy_account_id
                    .as_deref()
                    .is_some_and(|id| !valid_hash(id) || !state.accounts.contains_key(id))
                || (source == "apple-health"
                    && (!state.accounts.is_empty() || state.legacy_account_id.is_some()))
                || state.accounts.keys().any(|id| !valid_hash(id))
            {
                return Err("Invalid provider account metadata".into());
            }
            for dates in state
                .collections
                .values()
                .chain(state.accounts.values().flat_map(|a| a.collections.values()))
            {
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
                || attachment.account_id.as_deref().is_some_and(|id| {
                    !valid_hash(id)
                        || !m
                            .sources
                            .get(&attachment.source)
                            .is_some_and(|s| s.accounts.contains_key(id))
                })
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

    pub fn sync(
        &self,
        file: Option<&Path>,
        dry_run: bool,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Report> {
        let file = match file {
            Some(file) => file.to_path_buf(),
            None => self.remembered_source()?.ok_or(
                "Choose an Apple Health ZIP/XML file first, or pass --file to health-sync",
            )?,
        };
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
            attachments = extract_for_layout(snapshot.path(), staging.path(), self.layout)?;
            for attachment in &attachments {
                touched.insert(attachment.record.day.clone());
                stage_record(&mut insert, &attachment.record)?;
            }
            if let Some(previous) = &old {
                for (day, entry) in &previous.days {
                    touched.insert(day.clone());
                    for shard in &entry.shards {
                        if shard.source != "apple-health" {
                            self.read_shard(day, shard, &mut |mut record| {
                                if !record.attributes.contains_key("accountId") {
                                    if let Some(id) = previous
                                        .sources
                                        .get(&shard.source)
                                        .and_then(|s| s.legacy_account_id.as_ref())
                                    {
                                        record.attributes.insert("accountId".into(), id.clone());
                                    }
                                }
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
                    account_id: None,
                    sha256: attachment.sha256.clone(),
                    collection: None,
                },
            );
        }
        manifest.days = days;
        manifest.sources.insert(
            "apple-health".into(),
            SourceState {
                garmin_region: None,
                input_sha256: Some(input_sha256),
                export_date: Some(export_date),
                collections: BTreeMap::new(),
                ..Default::default()
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
        self.apply_provider_with_region(
            staged_jsonl,
            report,
            dry_run,
            GarminRegion::Global,
            progress,
        )
    }

    pub fn apply_provider_with_region(
        &self,
        staged_jsonl: &Path,
        report: &FetchReport,
        dry_run: bool,
        region: GarminRegion,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Report> {
        self.apply_provider_scoped(staged_jsonl, report, dry_run, region, None, None, progress)
    }

    /// Account identity is verified by auth; legacy identity must never be inferred
    /// from the newly selected account.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_provider_for_account(
        &self,
        staged_jsonl: &Path,
        report: &FetchReport,
        dry_run: bool,
        account_id: &str,
        region: GarminRegion,
        legacy_account_id: Option<&str>,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Report> {
        if !valid_hash(account_id) || legacy_account_id.is_some_and(|id| !valid_hash(id)) {
            return Err("Invalid provider account identity".into());
        }
        self.apply_provider_scoped(
            staged_jsonl,
            report,
            dry_run,
            region,
            Some(account_id),
            legacy_account_id,
            progress,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_provider_scoped(
        &self,
        staged_jsonl: &Path,
        report: &FetchReport,
        dry_run: bool,
        region: GarminRegion,
        account_id: Option<&str>,
        legacy_account_id: Option<&str>,
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
        let mut old = self.manifest()?;
        let original = old.clone();
        self.check_owned(&old)?;
        if account_id.is_none()
            && report.source == "garmin"
            && old
                .as_ref()
                .and_then(|m| m.sources.get("garmin"))
                .is_some_and(|state| state.garmin_region.unwrap_or_default() != region)
        {
            return Err("Garmin region disagrees with this vault's existing provider data".into());
        }
        if let Some(id) = account_id {
            if let Some(manifest) = old.as_mut() {
                if let Some(state) = manifest.sources.get_mut(&report.source) {
                    if state
                        .legacy_account_id
                        .as_deref()
                        .zip(legacy_account_id)
                        .is_some_and(|(a, b)| a != b)
                    {
                        return Err("Legacy account binding disagrees with archive".into());
                    }
                    if state.accounts.is_empty() {
                        let legacy = state.legacy_account_id.as_deref().or(legacy_account_id)
                            .ok_or("Cannot identify the existing provider archive account; existing data was preserved")?.to_string();
                        state.legacy_account_id = Some(legacy.clone());
                        state.accounts.insert(
                            legacy.clone(),
                            AccountState {
                                garmin_region: state.garmin_region,
                                collections: std::mem::take(&mut state.collections),
                            },
                        );
                        for attachment in manifest
                            .attachments
                            .values_mut()
                            .filter(|a| a.source == report.source)
                        {
                            if attachment.account_id.is_none() {
                                attachment.account_id = Some(legacy.clone());
                            }
                        }
                    }
                    if report.source == "garmin"
                        && state
                            .accounts
                            .get(id)
                            .is_some_and(|a| a.garmin_region.unwrap_or_default() != region)
                    {
                        return Err(
                            "Garmin region disagrees with this account's existing data".into()
                        );
                    }
                }
            }
        } else if old
            .as_ref()
            .and_then(|m| m.sources.get(&report.source))
            .is_some_and(|s| !s.accounts.is_empty())
        {
            return Err("An account identity is required for this archive".into());
        }
        let legacy = old
            .as_ref()
            .and_then(|m| m.sources.get(&report.source))
            .and_then(|s| s.legacy_account_id.as_deref());
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
                let bytes = stage_provider_attachment(
                    &mut provider,
                    staging.path(),
                    account_id,
                    self.layout,
                )?;
                let mut attributes =
                    BTreeMap::from([("sourceName".into(), provider.source.clone())]);
                if let Some(id) = account_id {
                    attributes.insert("accountId".into(), id.into());
                }
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
                            let replace_collection =
                                shard.source == report.source && complete.contains(&shard.metric);
                            self.read_shard(day, shard, &mut |mut record| {
                                let owner = record
                                    .attributes
                                    .get("accountId")
                                    .map(String::as_str)
                                    .or(legacy);
                                if replace_collection
                                    && (account_id.is_none() || owner == account_id)
                                {
                                    return Ok(());
                                }
                                if shard.source == report.source
                                    && account_id.is_some()
                                    && !record.attributes.contains_key("accountId")
                                {
                                    record.attributes.insert(
                                        "accountId".into(),
                                        legacy.ok_or("Unidentified legacy provider record")?.into(),
                                    );
                                }
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
            let day = attachment_path_parts(path)
                .map(|(day, _)| day)
                .unwrap_or("");
            let in_window =
                day == "_undated" || (day >= report.since.as_str() && day <= report.until.as_str());
            !(attachment.source == report.source
                && (account_id.is_none()
                    || attachment.account_id.as_deref().or(legacy) == account_id)
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
                    account_id: account_id.map(str::to_string),
                    sha256: attachment.sha256.clone(),
                    collection: Some(collection.clone()),
                },
            );
        }
        let state = manifest.sources.entry(report.source.clone()).or_default();
        let target_collections = if let Some(id) = account_id {
            manifest.schema_version = 3;
            let account = state.accounts.entry(id.into()).or_default();
            if report.source == "garmin" {
                account.garmin_region = Some(region);
            }
            &mut account.collections
        } else {
            if report.source == "garmin" {
                state.garmin_region = Some(region);
            }
            &mut state.collections
        };
        for (name, result) in &collections {
            let coverage = target_collections.entry((*name).to_string()).or_default();
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
        let mut outcome = self.commit(manifest, &original, dry_run)?;
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

    /// Merge only records present in an official export. An export may be one
    /// part of a split download, so absence never means deletion or API coverage.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_garmin_export(
        &self,
        staged_jsonl: &Path,
        report: &FetchReport,
        dry_run: bool,
        account_id: &str,
        region: GarminRegion,
        attachment_root: &Path,
        attachments: &BTreeMap<(String, String), ExportAttachment>,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Report> {
        if !valid_hash(account_id) || report.source != "garmin" {
            return Err("Invalid Garmin export account or source".into());
        }
        if !valid_day(&report.since) || !valid_day(&report.until) || report.since > report.until {
            return Err("Invalid Garmin export date bounds".into());
        }
        let mut expected = BTreeMap::new();
        for collection in &report.collections {
            if !collection.collection.starts_with("export_")
                || collection.collection.len() <= 7
                || collection.status != "complete"
                || collection.error.is_some()
                || expected
                    .insert(collection.collection.clone(), collection.records)
                    .is_some()
            {
                return Err("Invalid Garmin export collection report".into());
            }
        }
        if expected.is_empty() {
            return Err("Garmin export report has no collections".into());
        }
        let _lock = self.lock()?;
        let old = self.manifest()?;
        self.check_owned(&old)?;
        if let Some(state) = old.as_ref().and_then(|m| m.sources.get("garmin")) {
            if state.accounts.is_empty() && !state.collections.is_empty() {
                return Err("Cannot identify the existing Garmin archive account; existing data was preserved".into());
            }
            if state
                .accounts
                .get(account_id)
                .is_some_and(|a| a.garmin_region.unwrap_or_default() != region)
            {
                return Err("Garmin region disagrees with this account's existing data".into());
            }
        }
        let staging = tempfile::tempdir().map_err(err)?;
        let mut db = staging_db(staging.path())?;
        let tx = db.transaction().map_err(err)?;
        tx.execute_batch(
            "CREATE TABLE export_seen(identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);",
        )
        .map_err(err)?;
        let mut touched = BTreeSet::new();
        let mut received: BTreeMap<String, u64> =
            expected.keys().map(|name| (name.clone(), 0)).collect();
        let mut preserved_files = vec![];
        let mut used_files = BTreeSet::new();
        let mut removed_files = BTreeSet::new();
        let mut referenced_files = BTreeSet::new();
        let mut coverage: BTreeMap<String, BTreeMap<String, Coverage>> = BTreeMap::new();
        {
            let mut insert = tx
                .prepare("INSERT INTO records VALUES (?1,?2,?3,?4,?5)")
                .map_err(err)?;
            let mut remember = tx
                .prepare("INSERT OR IGNORE INTO export_seen VALUES (?1,?2)")
                .map_err(err)?;
            let mut seen = tx
                .prepare("SELECT fingerprint FROM export_seen WHERE identity=?1")
                .map_err(err)?;
            let mut count_record = |record: &HealthRecord| {
                let name = record.metric.strip_prefix("garmin.").unwrap().to_string();
                let count = coverage
                    .entry(name)
                    .or_default()
                    .entry(record.day.clone())
                    .or_insert(Coverage {
                        status: "observed".into(),
                        error: None,
                        record_count: 0,
                    });
                count.record_count += 1;
            };
            let mut last = std::time::Instant::now();
            for line in BufReader::new(File::open(staged_jsonl).map_err(err)?).lines() {
                let mut provider: ProviderRecord =
                    serde_json::from_str(&line.map_err(err)?).map_err(err)?;
                if provider.source != "garmin" || !expected.contains_key(&provider.collection) {
                    return Err("Staged Garmin export record disagrees with report".into());
                }
                if provider.day != "_undated"
                    && (!valid_day(&provider.day)
                        || provider.day < report.since
                        || provider.day > report.until)
                {
                    return Err("Garmin export record is outside its date bounds".into());
                }
                *received.get_mut(&provider.collection).unwrap() += 1;
                let fingerprint = json_hash(&(&provider.day, &provider.data))?;
                let identity = match &provider.id {
                    Some(id) => json_hash(&(&provider.collection, "id", id))?,
                    None => json_hash(&(&provider.collection, "content", &fingerprint))?,
                };
                if remember
                    .execute(params![identity, fingerprint])
                    .map_err(err)?
                    == 0
                {
                    let prior: String = seen.query_row([&identity], |r| r.get(0)).map_err(err)?;
                    if prior != fingerprint {
                        return Err("Conflicting Garmin export record identity".into());
                    }
                    continue;
                }
                // Incoming JSON cannot nominate local files, embedded bytes, or
                // existing vault attachments. Only the private map can do that.
                if provider.data.get("content_base64").is_some()
                    || provider.data.get("attachment_path").is_some()
                {
                    return Err("Garmin export payload contains reserved attachment fields".into());
                }
                let file_key = provider
                    .id
                    .as_ref()
                    .map(|id| (provider.collection.clone(), id.clone()));
                let file = if let Some((key, file)) = file_key
                    .as_ref()
                    .and_then(|key| attachments.get(key).map(|file| (key, file)))
                {
                    used_files.insert(key.clone());
                    Some(stage_export_attachment(
                        &mut provider,
                        file,
                        attachment_root,
                        staging.path(),
                        account_id,
                        self.layout,
                    )?)
                } else {
                    None
                };
                let mut attributes = BTreeMap::from([
                    ("sourceName".into(), "garmin".into()),
                    ("accountId".into(), account_id.into()),
                    ("exportIdentity".into(), identity),
                ]);
                if let Some(id) = provider.id {
                    attributes.insert("providerId".into(), id);
                }
                let record = HealthRecord {
                    schema_version: 1,
                    ingest_source: "garmin".into(),
                    kind: "Supplement".into(),
                    day: provider.day,
                    metric: format!("garmin.{}", provider.collection),
                    attributes,
                    children: vec![],
                    text: String::new(),
                    text_segments: None,
                    payload: Some(provider.data),
                };
                if let Some((file, relative_path, sha256)) = file {
                    preserved_files.push((
                        provider.collection,
                        Attachment {
                            record: record.clone(),
                            file,
                            relative_path,
                            sha256,
                        },
                    ));
                }
                touched.insert(record.day.clone());
                count_record(&record);
                stage_record(&mut insert, &record)?;
                if last.elapsed().as_secs() >= 10 {
                    progress("Staging Garmin export records");
                    last = std::time::Instant::now();
                }
            }
            if received != expected || used_files.len() != attachments.len() {
                return Err(
                    "Garmin export record or attachment count disagrees with report".into(),
                );
            }
            // Scan all existing export days, including dates outside this ZIP:
            // a stable ID may have moved to a corrected date in a later export.
            if let Some(manifest) = &old {
                for (day, entry) in &manifest.days {
                    if !touched.contains(day)
                        && !entry
                            .shards
                            .iter()
                            .any(|s| s.source == "garmin" && s.metric.starts_with("garmin.export_"))
                    {
                        continue;
                    }
                    touched.insert(day.clone());
                    for shard in &entry.shards {
                        self.read_shard(day, shard, &mut |record| {
                            let target = record.ingest_source == "garmin"
                                && record.metric.starts_with("garmin.export_")
                                && record
                                    .attributes
                                    .get("accountId")
                                    .is_some_and(|id| id == account_id);
                            if target {
                                let identity = record
                                    .attributes
                                    .get("exportIdentity")
                                    .ok_or("Existing export record has no merge identity")?;
                                if seen.exists([identity]).map_err(err)? {
                                    if let Some(path) = record
                                        .payload
                                        .as_ref()
                                        .and_then(|v| v["attachment_path"].as_str())
                                    {
                                        removed_files.insert(path.to_string());
                                    }
                                    return Ok(());
                                }
                                count_record(&record);
                            }
                            if let Some(path) = record
                                .payload
                                .as_ref()
                                .and_then(|v| v["attachment_path"].as_str())
                            {
                                referenced_files.insert(path.to_string());
                            }
                            stage_record(&mut insert, &record)
                        })?;
                    }
                }
            }
        }
        tx.commit().map_err(err)?;
        let days = self.prepare_days(&db, staging.path(), &touched, &old, dry_run, progress)?;
        let mut manifest = old.clone().unwrap_or_else(empty_manifest);
        manifest.schema_version = 3;
        manifest.days = days;
        for path in removed_files.difference(&referenced_files) {
            manifest.attachments.remove(path);
        }
        for (collection, attachment) in preserved_files {
            self.persist_attachment(&attachment, staging.path(), dry_run)?;
            manifest.attachments.insert(
                attachment.relative_path.to_string_lossy().into_owned(),
                AttachmentRef {
                    account_id: Some(account_id.into()),
                    source: "garmin".into(),
                    sha256: attachment.sha256,
                    collection: Some(collection),
                },
            );
        }
        let account = manifest
            .sources
            .entry("garmin".into())
            .or_default()
            .accounts
            .entry(account_id.into())
            .or_default();
        account.garmin_region = Some(region);
        account
            .collections
            .retain(|name, _| !name.starts_with("export_"));
        account.collections.extend(coverage);
        self.commit(manifest, &old, dry_run)
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
                return Err(format!("{}/ already contains files without a Health Sync manifest; choose a different vault or move that directory", self.layout.root().display()));
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
                || (matches!(record.ingest_source.as_str(), "garmin" | "oura")
                    && record
                        .attributes
                        .get("accountId")
                        .is_some_and(|id| !valid_hash(id)))
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
                built.add(&payload, old.as_ref().map(|m| &m.sources))?;
                if last.elapsed().as_secs() >= 10 {
                    progress(&format!("Preparing {day}"));
                    last = std::time::Instant::now();
                }
            }
            if let Some(shard) = current {
                built.shards.push(self.finish_shard(shard, dry_run)?);
            }
            let sha256 = shard_digest(&built.shards)?;
            let summary = render_summary(&built, self.layout);
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
                conflicts.push(format!("{}: {e}", self.layout.summary(day).display()));
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
            account_id,
        } = filter;
        if account_id.is_some_and(|id| !valid_hash(id)) {
            return Err("Invalid provider account identity".into());
        }
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
                self.read_shard(day, shard, &mut |mut record| {
                    if !record.attributes.contains_key("accountId") {
                        if let Some(id) = m
                            .sources
                            .get(&shard.source)
                            .and_then(|s| s.legacy_account_id.as_ref())
                        {
                            record.attributes.insert("accountId".into(), id.clone());
                        }
                    }
                    if account_id.is_some_and(|id| {
                        !matches!(record.ingest_source.as_str(), "garmin" | "oura")
                            || record.attributes.get("accountId").map(String::as_str) != Some(id)
                    }) {
                        return Ok(());
                    }
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
    accounts: BTreeMap<(String, String, String), u64>,
}
impl DayBuilder {
    fn new(day: &str) -> Self {
        Self {
            day: day.into(),
            shards: vec![],
            count: 0,
            groups: BTreeMap::new(),
            accounts: BTreeMap::new(),
        }
    }
    fn add(
        &mut self,
        payload: &str,
        sources: Option<&BTreeMap<String, SourceState>>,
    ) -> Result<()> {
        self.count += 1;
        let record: HealthRecord = serde_json::from_str(payload).map_err(err)?;
        if record.ingest_source != "apple-health" || record.kind == "Attachment" {
            if let Some(account) = matches!(record.ingest_source.as_str(), "garmin" | "oura")
                .then(|| {
                    record.attributes.get("accountId").or_else(|| {
                        sources
                            .and_then(|s| s.get(&record.ingest_source))
                            .and_then(|s| s.legacy_account_id.as_ref())
                    })
                })
                .flatten()
            {
                *self
                    .accounts
                    .entry((
                        record.ingest_source.clone(),
                        account.clone(),
                        record.metric.clone(),
                    ))
                    .or_default() += 1;
            }
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
fn render_summary(day: &DayBuilder, layout: Layout) -> String {
    let mut s = format!("# 健康档案 · {}\n\n当前有效记录数：{}。本日只有一份有效清单，Apple Health 为综合主档案，Garmin/Oura 为来源明确的补充；不猜测跨源关联，不跨来源或设备累加。\n\nApple 日期取原始 startDate（其次 dateComponents / creationDate），保留来源时区；跨日样本完整归起始日。补充记录采用厂商提供的日期，无日期元数据归入 _undated。\n\n此文件由 Health Sync 生成；个人批注请写入同名 .note.md 文件。\n", day.day, day.count);
    if day.count == 0 {
        s.push_str("\n当前快照已无该日期记录；历史原始分片仍保留。\n");
        return s;
    }
    s.push_str("\n## 分类与原始记录\n\n| 分类 | 采集来源 | 指标/集合 | 记录数 | 原始数据 |\n| --- | --- | --- | ---: | --- |\n");
    for shard in &day.shards {
        s.push_str(&format!(
            "| {} | {} | {} | {} | [JSONL]({}) |\n",
            cell(&shard.category),
            cell(&shard.source),
            cell(&shard.metric),
            shard.record_count,
            layout.shard_link(&day.day, &shard.filename())
        ));
    }
    if !day.accounts.is_empty() {
        s.push_str("\n## 厂商账号记录\n\n各账号分别保留，不跨账号累加健康指标。账号标识对应归档清单。\n\n| 来源 | 账号标识 | 集合 | 记录数 |\n| --- | --- | --- | ---: |\n");
        for ((source, account, metric), count) in &day.accounts {
            s.push_str(&format!(
                "| {} | {} | {} | {} |\n",
                cell(source),
                cell(account),
                cell(metric),
                count
            ));
        }
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

#[cfg(test)]
mod account_tests {
    use super::*;

    struct Fixture {
        temp: tempfile::TempDir,
        store: Store,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let vault = temp.path().join("vault");
            fs::create_dir(&vault).unwrap();
            fs::create_dir(temp.path().join("state")).unwrap();
            let store = Store::new(&vault, &temp.path().join("state")).unwrap();
            Self { temp, store }
        }
        fn staged(&self, records: &[ProviderRecord]) -> PathBuf {
            let path = self.temp.path().join("staged.jsonl");
            let data: Vec<_> = records
                .iter()
                .map(|r| serde_json::to_string(r).unwrap())
                .collect();
            fs::write(&path, data.join("\n")).unwrap();
            path
        }
        fn apply(&self, account: &str, records: &[ProviderRecord], report: &FetchReport) -> Report {
            self.store
                .apply_provider_for_account(
                    &self.staged(records),
                    report,
                    false,
                    account,
                    GarminRegion::Global,
                    None,
                    &mut |_| {},
                )
                .unwrap()
        }
        fn query(&self, account: &str) -> Value {
            self.store
                .query_filtered(
                    QueryFilter {
                        account_id: Some(account),
                        ..Default::default()
                    },
                    100,
                    0,
                )
                .unwrap()
        }
    }
    fn row(collection: &str, day: &str, value: u64) -> ProviderRecord {
        ProviderRecord {
            source: "garmin".into(),
            collection: collection.into(),
            day: day.into(),
            id: Some("shared-id".into()),
            data: json!({"value":value}),
        }
    }
    fn report(day: &str, collections: &[(&str, &str, u64)]) -> FetchReport {
        FetchReport {
            source: "garmin".into(),
            since: day.into(),
            until: day.into(),
            collections: collections
                .iter()
                .map(|(name, status, count)| crate::providers::CollectionResult {
                    collection: (*name).into(),
                    status: (*status).into(),
                    records: *count,
                    error: None,
                })
                .collect(),
        }
    }

    #[test]
    fn account_replacement_preserves_other_accounts_and_failed_coverage() {
        let f = Fixture::new();
        let a = hash(b"garmin:a");
        let b = hash(b"garmin:b");
        let day = "2026-10-01";
        let complete = report(day, &[("sleep", "complete", 1)]);
        f.apply(&a, &[row("sleep", day, 10)], &complete);
        f.apply(&b, &[row("sleep", day, 20)], &complete);
        assert_eq!(f.store.manifest().unwrap().unwrap().record_count, 2);
        f.apply(&a, &[row("sleep", day, 11)], &complete);
        assert_eq!(f.query(&a)["records"][0]["payload"]["value"], 11);
        assert_eq!(f.query(&b)["records"][0]["payload"]["value"], 20);
        let failed = report(day, &[("sleep", "failed", 0)]);
        let outcome = f.apply(&b, &[], &failed);
        assert!(!outcome.complete);
        let m = f.store.manifest().unwrap().unwrap();
        assert_eq!(m.schema_version, 3);
        assert_eq!(
            m.sources["garmin"].accounts[&a].collections["sleep"][day].status,
            "complete"
        );
        assert_eq!(
            m.sources["garmin"].accounts[&b].collections["sleep"][day].status,
            "failed"
        );
        assert_eq!(f.query(&b)["records"].as_array().unwrap().len(), 1);
        let summary = source_summary(&m);
        assert_eq!(summary["garmin"]["accounts"][&a]["record_count"], 1);
        assert_eq!(summary["garmin"]["collections"]["sleep"]["failed_days"], 1);
        assert!(m.days[day].summary.contains(&a) && m.days[day].summary.contains(&b));
        assert!(f
            .store
            .apply_provider(
                &f.staged(&[]),
                &report(day, &[("sleep", "complete", 0)]),
                false,
                &mut |_| {}
            )
            .is_err());
    }

    #[test]
    fn different_garmin_regions_can_coexist_but_same_account_cannot_change_region() {
        let f = Fixture::new();
        let a = hash(b"garmin:123");
        let b = hash(b"garmin:china:123");
        let day = "2026-10-01";
        let r = report(day, &[("sleep", "complete", 1)]);
        f.apply(&a, &[row("sleep", day, 1)], &r);
        let path = f.staged(&[row("sleep", day, 2)]);
        f.store
            .apply_provider_for_account(
                &path,
                &r,
                false,
                &b,
                GarminRegion::China,
                None,
                &mut |_| {},
            )
            .unwrap();
        assert!(f
            .store
            .apply_provider_for_account(
                &path,
                &r,
                false,
                &a,
                GarminRegion::China,
                None,
                &mut |_| {}
            )
            .is_err());
        assert_eq!(f.query(&a)["records"][0]["payload"]["value"], 1);
        assert_eq!(f.query(&b)["records"][0]["payload"]["value"], 2);
    }

    #[test]
    fn attachments_and_undated_profiles_are_isolated_by_account() {
        let f = Fixture::new();
        let a = hash(b"a");
        let b = hash(b"b");
        let day = "2026-10-01";
        let mut file = row("activity_files", day, 0);
        file.data = json!({"content_base64":"c2FtZS1ieXRlcw==","filename":"activity.zip"});
        let profile = row("profile", "_undated", 1);
        let r = report(
            day,
            &[
                ("activity_files", "complete", 1),
                ("profile", "complete", 1),
            ],
        );
        f.apply(&a, &[file.clone(), profile.clone()], &r);
        f.apply(&b, &[file, profile], &r);
        let m = f.store.manifest().unwrap().unwrap();
        assert_eq!(m.attachments.len(), 2);
        let paths: Vec<_> = m.attachments.keys().collect();
        assert_ne!(paths[0], paths[1]);
        assert_eq!(
            m.attachments
                .values()
                .filter(|x| x.account_id.as_deref() == Some(&a))
                .count(),
            1
        );
        f.apply(
            &a,
            &[],
            &report(
                day,
                &[
                    ("activity_files", "complete", 0),
                    ("profile", "complete", 0),
                ],
            ),
        );
        let m = f.store.manifest().unwrap().unwrap();
        assert_eq!(m.attachments.len(), 1);
        assert_eq!(
            m.attachments.values().next().unwrap().account_id.as_deref(),
            Some(b.as_str())
        );
        assert!(f.query(&a)["records"].as_array().unwrap().is_empty());
        assert_eq!(f.query(&b)["records"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn legacy_identity_is_required_and_migration_does_not_rewrite_untouched_shards() {
        let f = Fixture::new();
        let a = hash(b"legacy");
        let b = hash(b"new");
        let oldday = "2026-09-01";
        let newday = "2026-10-01";
        f.store
            .apply_provider(
                &f.staged(&[row("sleep", oldday, 1)]),
                &report(oldday, &[("sleep", "complete", 1)]),
                false,
                &mut |_| {},
            )
            .unwrap();
        let original = f.store.manifest().unwrap().unwrap();
        let old_shard = original.days[oldday].shards[0].clone();
        let old_path = f.store.shard_path(oldday, &old_shard);
        let bytes = fs::read(&old_path).unwrap();
        let staged = f.staged(&[row("sleep", newday, 2)]);
        let r = report(newday, &[("sleep", "complete", 1)]);
        assert!(f
            .store
            .apply_provider_for_account(
                &staged,
                &r,
                false,
                &b,
                GarminRegion::Global,
                None,
                &mut |_| {}
            )
            .is_err());
        assert_eq!(f.store.manifest().unwrap().unwrap(), original);
        f.store
            .apply_provider_for_account(
                &staged,
                &r,
                true,
                &b,
                GarminRegion::Global,
                Some(&a),
                &mut |_| {},
            )
            .unwrap();
        assert_eq!(f.store.manifest().unwrap().unwrap(), original);
        f.store
            .apply_provider_for_account(
                &staged,
                &r,
                false,
                &b,
                GarminRegion::Global,
                Some(&a),
                &mut |_| {},
            )
            .unwrap();
        let m = f.store.manifest().unwrap().unwrap();
        assert_eq!(
            m.sources["garmin"].legacy_account_id.as_deref(),
            Some(a.as_str())
        );
        assert_eq!(m.days[oldday].shards[0], old_shard);
        assert_eq!(fs::read(&old_path).unwrap(), bytes);
        assert_eq!(f.query(&a)["records"][0]["attributes"]["accountId"], a);
        assert_eq!(f.query(&b)["records"].as_array().unwrap().len(), 1);
        assert!(f
            .store
            .apply_provider_for_account(
                &staged,
                &r,
                false,
                &b,
                GarminRegion::Global,
                Some(&b),
                &mut |_| {}
            )
            .is_err());
    }

    #[test]
    fn apple_reimport_keeps_both_accounts_and_account_queries_page_independently() {
        let f = Fixture::new();
        let a = hash(b"a");
        let b = hash(b"b");
        let day = "2026-10-01";
        let export = f.temp.path().join("apple.xml");
        fs::write(&export,format!("<HealthData><ExportDate value='2026-10-24 09:00:00 +0900'/><Record type='HeartRate' startDate='{day}' value='60' accountId='opaque-apple-attribute'/></HealthData>")).unwrap();
        f.store.import(&export, false, &mut |_| {}).unwrap();
        let original = f.store.manifest().unwrap().unwrap();
        let apple = original.days[day].shards[0].clone();
        let r = report(day, &[("sleep", "complete", 1)]);
        f.apply(&a, &[row("sleep", day, 1)], &r);
        f.apply(&b, &[row("sleep", day, 2)], &r);
        fs::write(&export,format!("<HealthData><ExportDate value='2026-10-24 10:00:00 +0900'/><Record type='HeartRate' startDate='{day}' value='60' accountId='opaque-apple-attribute'/></HealthData>")).unwrap();
        f.store.import(&export, false, &mut |_| {}).unwrap();
        let m = f.store.manifest().unwrap().unwrap();
        assert_eq!(m.record_count, 3);
        assert!(m.days[day].shards.contains(&apple));
        let q = f
            .store
            .query_filtered(
                QueryFilter {
                    account_id: Some(&b),
                    ..Default::default()
                },
                1,
                0,
            )
            .unwrap();
        assert_eq!(q["records"].as_array().unwrap().len(), 1);
        assert_eq!(q["has_more"], false);
        assert_eq!(q["records"][0]["payload"]["value"], 2);
        assert!(f
            .store
            .query_filtered(
                QueryFilter {
                    account_id: Some("bad-id"),
                    ..Default::default()
                },
                1,
                0
            )
            .is_err());
    }
    impl Fixture {
        fn export(
            &self,
            account: &str,
            rows: &[ProviderRecord],
            files: &BTreeMap<(String, String), ExportAttachment>,
            dry: bool,
        ) -> Result<Report> {
            let mut counts = BTreeMap::new();
            for row in rows {
                *counts.entry(row.collection.clone()).or_insert(0) += 1;
            }
            let report = FetchReport {
                source: "garmin".into(),
                since: "2000-01-01".into(),
                until: "2099-12-31".into(),
                collections: counts
                    .into_iter()
                    .map(|(collection, records)| crate::providers::CollectionResult {
                        collection,
                        records,
                        status: "complete".into(),
                        error: None,
                    })
                    .collect(),
            };
            self.store.apply_garmin_export(
                &self.staged(rows),
                &report,
                dry,
                account,
                GarminRegion::Global,
                self.temp.path(),
                files,
                &mut |_| {},
            )
        }
        fn export_file(&self, name: &str, bytes: &[u8]) -> ExportAttachment {
            let file = self.temp.path().join(name);
            fs::write(&file, bytes).unwrap();
            ExportAttachment {
                file,
                filename: name.into(),
                sha256: hash(bytes),
            }
        }
    }

    #[test]
    fn export_merge_preserves_api_other_accounts_absent_records_and_moves_ids() {
        let f = Fixture::new();
        let a = hash(b"a");
        let b = hash(b"b");
        let day = "2026-10-01";
        let api = report(day, &[("sleep", "complete", 1)]);
        f.apply(&a, &[row("sleep", day, 100)], &api);
        let mut first = row("export_sleep", day, 1);
        let mut second = row("export_sleep", day, 2);
        second.id = Some("second".into());
        f.export(
            &a,
            &[first.clone(), second.clone()],
            &BTreeMap::new(),
            false,
        )
        .unwrap();
        f.export(&b, &[first.clone()], &BTreeMap::new(), false)
            .unwrap();
        first.day = "2026-10-02".into();
        first.data = json!({"value":3});
        f.export(&a, &[first.clone()], &BTreeMap::new(), false)
            .unwrap();
        let rows = f.query(&a)["records"].as_array().unwrap().clone();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().any(|r| r["payload"]["value"] == 100));
        assert!(rows.iter().any(|r| r["payload"]["value"] == 2));
        assert!(rows
            .iter()
            .any(|r| r["payload"]["value"] == 3 && r["day"] == "2026-10-02"));
        assert_eq!(f.query(&b)["records"][0]["payload"]["value"], 1);
        assert!(
            !f.export(&a, &[first], &BTreeMap::new(), false)
                .unwrap()
                .data_changed
        );
        f.apply(&a, &[row("sleep", day, 200)], &api);
        assert_eq!(f.query(&a)["records"].as_array().unwrap().len(), 3);
        let manifest = f.store.manifest().unwrap().unwrap();
        let coverage = &manifest.sources["garmin"].accounts[&a].collections["export_sleep"];
        assert_eq!(coverage.len(), 2);
        assert!(coverage
            .values()
            .all(|c| c.status == "observed" && c.record_count == 1));
        let summary = source_summary(&manifest);
        assert_eq!(
            summary["garmin"]["collections"]["export_sleep"]["complete_days"],
            0
        );
        assert_eq!(
            summary["garmin"]["collections"]["export_sleep"]["observed_days"],
            2
        );
    }

    #[test]
    fn export_content_records_are_idempotent_and_dry_run_does_not_write_vault() {
        let f = Fixture::new();
        let a = hash(b"a");
        let mut record = row("export_other", "_undated", 1);
        record.id = None;
        assert!(
            f.export(
                &a,
                &[record.clone(), record.clone()],
                &BTreeMap::new(),
                true
            )
            .unwrap()
            .data_changed
        );
        assert!(f.store.manifest().unwrap().is_none());
        assert!(!f.store.health().exists());
        f.export(
            &a,
            &[record.clone(), record.clone()],
            &BTreeMap::new(),
            false,
        )
        .unwrap();
        assert_eq!(f.query(&a)["records"].as_array().unwrap().len(), 1);
        assert!(
            !f.export(&a, &[record], &BTreeMap::new(), false)
                .unwrap()
                .data_changed
        );
    }

    #[test]
    fn export_private_attachments_preserve_empty_bytes_and_reject_corruption() {
        let f = Fixture::new();
        let a = hash(b"a");
        let record = row("export_files", "_undated", 1);
        let key = (record.collection.clone(), record.id.clone().unwrap());
        let mut files = BTreeMap::from([(key.clone(), f.export_file("empty.fit", b""))]);
        f.export(&a, std::slice::from_ref(&record), &files, false)
            .unwrap();
        let manifest = f.store.manifest().unwrap().unwrap();
        let (path, metadata) = manifest.attachments.iter().next().unwrap();
        assert_eq!(metadata.sha256, hash(b""));
        assert_eq!(fs::read(f.store.vault.join(path)).unwrap(), b"");
        assert!(
            !f.export(&a, std::slice::from_ref(&record), &files, false)
                .unwrap()
                .data_changed
        );
        fs::write(&files[&key].file, b"changed").unwrap();
        assert!(f
            .export(&a, std::slice::from_ref(&record), &files, false)
            .unwrap_err()
            .contains("checksum mismatch"));
        assert_eq!(f.store.manifest().unwrap().unwrap(), manifest);
        let external = tempfile::NamedTempFile::new().unwrap();
        files.get_mut(&key).unwrap().file = external.path().into();
        assert!(f
            .export(&a, std::slice::from_ref(&record), &files, false)
            .unwrap_err()
            .contains("outside private staging"));
        let mut unsafe_record = record;
        unsafe_record.data["content_base64"] = json!("secret");
        assert!(f
            .export(&a, &[unsafe_record], &BTreeMap::new(), false)
            .is_err());
    }

    #[test]
    fn export_rejects_api_collections_conflicting_ids_and_orphan_attachments() {
        let f = Fixture::new();
        let a = hash(b"a");
        assert!(f
            .export(
                &a,
                &[row("sleep", "2026-10-01", 1)],
                &BTreeMap::new(),
                false
            )
            .is_err());
        assert!(f
            .export(
                &a,
                &[
                    row("export_sleep", "2026-10-01", 1),
                    row("export_sleep", "2026-10-02", 2)
                ],
                &BTreeMap::new(),
                false
            )
            .is_err());
        let files = BTreeMap::from([(
            ("export_files".into(), "orphan".into()),
            f.export_file("unused.bin", b"x"),
        )]);
        assert!(f
            .export(&a, &[row("export_sleep", "2026-10-01", 1)], &files, false)
            .is_err());
        assert!(f.store.manifest().unwrap().is_none());
    }

    #[test]
    fn export_updated_attachment_retains_another_records_shared_bytes() {
        let f = Fixture::new();
        let a = hash(b"a");
        let first = row("export_files", "_undated", 1);
        let mut second = first.clone();
        second.id = Some("other".into());
        let mut files = BTreeMap::from([
            (
                (first.collection.clone(), first.id.clone().unwrap()),
                f.export_file("one.fit", b"same"),
            ),
            (
                (second.collection.clone(), second.id.clone().unwrap()),
                f.export_file("two.fit", b"same"),
            ),
        ]);
        f.export(&a, &[first.clone(), second], &files, false)
            .unwrap();
        files.remove(&("export_files".into(), "other".into()));
        files.insert(
            (first.collection.clone(), first.id.clone().unwrap()),
            f.export_file("updated.fit", b"updated"),
        );
        f.export(&a, &[first], &files, false).unwrap();
        let manifest = f.store.manifest().unwrap().unwrap();
        assert_eq!(manifest.attachments.len(), 2);
        assert_eq!(manifest.record_count, 2);
        assert!(manifest
            .attachments
            .values()
            .any(|a| a.sha256 == hash(b"same")));
        assert!(manifest
            .attachments
            .values()
            .any(|a| a.sha256 == hash(b"updated")));
    }
    #[test]
    fn existing_legacy_archive_keeps_paths_queries_and_idempotent_imports() {
        let mut f = Fixture::new();
        // Produce a schema-compatible pre-change archive with the legacy writer.
        f.store.layout = Layout::Legacy;
        let source = f.temp.path().join("export.xml");
        let xml = |day: &str| {
            format!("<HealthData><ExportDate value='2026-10-24 12:00:00 +0800'/><Record type='HKQuantityTypeIdentifierHeartRate' startDate='{day} 12:00:00 +0800' value='60'/></HealthData>")
        };
        fs::write(&source, xml("2020-01-01")).unwrap();
        f.store.import(&source, false, &mut |_| {}).unwrap();
        let account = hash(b"legacy-path-test");
        let mut file = row("activity_files", "2020-01-01", 0);
        file.data = json!({"content_base64":"c2FtZS1ieXRlcw==","filename":"activity.zip"});
        f.apply(
            &account,
            &[file],
            &report("2020-01-01", &[("activity_files", "complete", 1)]),
        );
        let manifest_path = f.store.vault.join("health/manifest.json");
        let before = fs::read(&manifest_path).unwrap();
        let before_mtime = fs::metadata(&manifest_path).unwrap().modified().unwrap();
        let reopened = Store::new(&f.store.vault, &f.temp.path().join("state")).unwrap();
        assert!(matches!(reopened.layout, Layout::Legacy));
        assert_eq!(
            reopened.query(None, None, None, 100, 0).unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(
            !reopened
                .import(&source, false, &mut |_| {})
                .unwrap()
                .data_changed
        );
        assert_eq!(fs::read(&manifest_path).unwrap(), before);
        assert_eq!(
            fs::metadata(&manifest_path).unwrap().modified().unwrap(),
            before_mtime
        );
        fs::write(&source, xml("2021-01-02")).unwrap();
        assert!(
            reopened
                .import(&source, false, &mut |_| {})
                .unwrap()
                .complete
        );
        let manifest = reopened.manifest().unwrap().unwrap();
        let new_shard = &manifest.days["2021-01-02"].shards[0];
        assert!(reopened
            .vault
            .join("health/data/2021-01-02")
            .join(new_shard.filename())
            .exists());
        let summary =
            fs::read_to_string(reopened.vault.join("health/daily/2021-01-02-health.md")).unwrap();
        assert!(summary.contains(&format!(
            "[JSONL](../data/2021-01-02/{})",
            new_shard.filename()
        )));
        for path in manifest.attachments.keys() {
            assert!(path.starts_with("health/attachments/2020-01-01/"));
            assert!(reopened.vault.join(path).exists());
        }
        assert!(!reopened.vault.join("ssot").exists());
        f.store = reopened;
        let apple_zip = f.temp.path().join("localized.zip");
        let mut zip = zip::ZipWriter::new(File::create(&apple_zip).unwrap());
        zip.start_file("导出.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&fs::read(&source).unwrap()).unwrap();
        zip.start_file(
            "ecg_2021-01-02.csv",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"original ECG").unwrap();
        zip.finish().unwrap();
        assert!(
            f.store
                .import(&apple_zip, false, &mut |_| {})
                .unwrap()
                .complete
        );
        let export = row("export_files", "_undated", 1);
        let files = BTreeMap::from([(
            (export.collection.clone(), export.id.clone().unwrap()),
            f.export_file("history.fit", b"original FIT"),
        )]);
        assert!(
            f.export(&account, &[export], &files, false)
                .unwrap()
                .complete
        );
        let manifest = f.store.manifest().unwrap().unwrap();
        assert_eq!(manifest.attachments.len(), 3);
        assert!(manifest
            .attachments
            .keys()
            .all(|path| path.starts_with("health/attachments/")));
        assert!(manifest
            .attachments
            .keys()
            .any(|path| path.starts_with("health/attachments/2021-01-02/")));
        assert!(manifest
            .attachments
            .keys()
            .any(|path| path.starts_with("health/attachments/_undated/")));
        for (path, attachment) in &manifest.attachments {
            assert_eq!(
                hash(&fs::read(f.store.vault.join(path)).unwrap()),
                attachment.sha256
            );
        }
        assert!(!f.store.vault.join("ssot").exists());
    }
}
