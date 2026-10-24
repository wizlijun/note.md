//! External SQLite raw-data library shared by all health providers.
//! Candidate merges are staged separately and atomically committed; no reports are generated.
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
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SourceState {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub accounts: BTreeMap<String, AccountState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_date: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
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
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LibraryMetadata {
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
    pending: RefCell<Option<(PathBuf, BTreeSet<String>)>>,
    identity: String,
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
    value.strip_prefix("attachments/")?.split_once('/')
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
    account_id: &str,
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
        "{}-{account_id}-{}-{}-{}.{}",
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
        "{}-{account_id}-{}-{checksum}.{extension}",
        record.source,
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

fn source_summary(metadata: &LibraryMetadata) -> Value {
    let mut sources = serde_json::Map::new();
    for (source, state) in &metadata.sources {
        let mut aggregate: BTreeMap<String, BTreeMap<String, Coverage>> = BTreeMap::new();
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
            accounts.insert(id.clone(),json!({"region":account.garmin_region,"label":account.label,"record_count":count,"collections":coverage_summary(&account.collections)}));
        }
        let record_count: u64 = metadata
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
        let (root, identity) = crate::library::selection(vault, state_base)?;
        let vault_path = vault.canonicalize().map_err(err)?;
        let base = state_base
            .canonicalize()
            .unwrap_or_else(|_| state_base.to_path_buf());
        let local = base
            .join(hash(vault_path.to_string_lossy().as_bytes()))
            .join("libraries")
            .join(&identity);
        Ok(Self {
            vault: root,
            local,
            layout: Layout,
            pending: RefCell::new(None),
            identity,
        })
    }

    pub(crate) fn operational_directory(&self) -> &Path {
        &self.local
    }

    fn health(&self) -> PathBuf {
        self.vault.clone()
    }
    fn database(&self) -> PathBuf {
        self.health().join("health.sqlite")
    }
    fn database_connection(&self, write: bool) -> Result<Connection> {
        self.ensure_owned()?;
        safe_path(&self.database())?;
        // The selected directory must stay available; never recreate an offline mount.
        if !self.health().is_dir() {
            return Err("Health library is unavailable; reconnect its disk".into());
        }
        crate::storage::open(&self.database(), write)
    }

    fn lock(&self) -> Result<File> {
        self.ensure_owned()?;
        if !self.health().is_dir() {
            return Err("Health library is unavailable; reconnect its disk".into());
        }
        let path = self.health().join("write.lock");
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

    pub fn metadata(&self) -> Result<Option<LibraryMetadata>> {
        let Some(m) = crate::storage::load(&self.database_connection(false)?)? else {
            return Ok(None);
        };
        if m.schema_version != 1
            || m.source != "health-library"
            || m.scope != "raw-library"
            || (!m.input_sha256.is_empty() && !valid_hash(&m.input_sha256))
        {
            return Err("Unsupported health metadata".into());
        }
        let mut total = 0u64;
        for (day, entry) in &m.days {
            if !(valid_day(day) || day == "_undated") || !valid_hash(&entry.sha256) {
                return Err("Invalid day or hash in health metadata".into());
            }
            total = total
                .checked_add(entry.record_count)
                .ok_or("LibraryMetadata count overflow")?;
            let mut shard_total = 0u64;
            let mut seen = BTreeSet::new();
            for shard in &entry.shards {
                if !valid_source(&shard.source)
                    || !valid_hash(&shard.sha256)
                    || shard.record_count == 0
                    || !valid_category(&shard.category)
                    || !seen.insert((&shard.source, &shard.metric, &shard.category))
                {
                    return Err("Invalid shard in health metadata".into());
                }
                shard_total = shard_total
                    .checked_add(shard.record_count)
                    .ok_or("LibraryMetadata count overflow")?;
            }
            if shard_total != entry.record_count || shard_digest(&entry.shards)? != entry.sha256 {
                return Err("Health day counts or digest disagree".into());
            }
        }
        if total != m.record_count
            || m.day_count != m.days.values().filter(|d| d.record_count > 0).count()
        {
            return Err("Health metadata counts disagree".into());
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
            if (source == "apple-health" && !state.accounts.is_empty())
                || (source != "apple-health" && state.accounts.is_empty())
                || state.accounts.keys().any(|id| !valid_hash(id))
            {
                return Err("Invalid provider account metadata".into());
            }
            for dates in state.accounts.values().flat_map(|a| a.collections.values()) {
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
                return Err("Invalid attachment in health metadata".into());
            }
        }
        if m.sources
            .get("apple-health")
            .and_then(|s| s.input_sha256.as_deref())
            .unwrap_or("")
            != m.input_sha256
        {
            return Err("Apple source fingerprint disagrees with metadata".into());
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
        let metadata = self.metadata()?;
        let summary = metadata.as_ref().map(|m| json!({"schema_version":m.schema_version,"source":m.source,"scope":m.scope,
            "input_sha256":m.input_sha256,"export_date":m.export_date,"record_count":m.record_count,"day_count":m.day_count,
            "ignored_attachments":m.ignored_attachments,"attachment_count":m.attachments.len(),"sources":source_summary(m),"apple_imported":m.sources.contains_key("apple-health"),"first_day":m.days.iter().find(|(d,e)| valid_day(d) && e.record_count > 0).map(|(d,_)|d),
            "last_day":m.days.iter().rev().find(|(d,e)| valid_day(d) && e.record_count > 0).map(|(d,_)|d)}));
        Ok(
            json!({"imported":metadata.is_some(), "summary":summary, "source_file":self.remembered_source()?}),
        )
    }

    pub fn import(
        &self,
        file: &Path,
        dry_run: bool,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Report> {
        let _lock = self.lock()?;
        let old = self.metadata()?;
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
            // records must pass their checksums; missing attachments can be restored.
            if self.shards_present(m, progress)? {
                let mut report = Report {
                    complete: true,
                    dry_run,
                    data_changed: false,
                    input_sha256,
                    record_count: m.record_count,
                    changed_days: 0,
                    unchanged_days: m.day_count,
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
            // File imports are additive: preserve absent history and use the
            // maximum duplicate multiplicity seen in either input, never SUM.
            tx.execute_batch("CREATE TABLE incoming_counts AS SELECT payload,COUNT(*) AS n FROM records WHERE source='apple-health' GROUP BY payload; CREATE UNIQUE INDEX incoming_payload ON incoming_counts(payload); CREATE TABLE previous_counts(payload TEXT PRIMARY KEY,n INTEGER NOT NULL);").map_err(err)?;
            let mut prior_count = tx.prepare("INSERT INTO previous_counts VALUES(?1,1) ON CONFLICT(payload) DO UPDATE SET n=n+1 RETURNING n").map_err(err)?;
            let mut input_count = tx
                .prepare("SELECT n FROM incoming_counts WHERE payload=?1")
                .map_err(err)?;
            if let Some(previous) = &old {
                for (day, entry) in &previous.days {
                    touched.insert(day.clone());
                    for shard in &entry.shards {
                        self.read_shard(day, shard, &mut |record| {
                            if shard.source == "apple-health" {
                                let payload = serde_json::to_string(&record).map_err(err)?;
                                let previous_n: i64 = prior_count
                                    .query_row([&payload], |r| r.get(0))
                                    .map_err(err)?;
                                let incoming_n: i64 = input_count
                                    .query_row([&payload], |r| r.get(0))
                                    .optional()
                                    .map_err(err)?
                                    .unwrap_or(0);
                                if previous_n <= incoming_n {
                                    return Ok(());
                                }
                            }
                            stage_record(&mut insert, &record)
                        })?;
                    }
                }
            }
        }
        tx.commit().map_err(err)?;
        let export_date = stats.export_date.ok_or("Missing ExportDate: select a complete Apple Health export, not a filtered XML fragment")?;
        progress("Sorting records and preparing changed days");
        let days = self.prepare_days(&db, staging.path(), &touched, &old, dry_run, progress)?;
        let mut metadata = old.clone().unwrap_or_else(empty_metadata);
        metadata.input_sha256 = input_sha256.clone();
        metadata.export_date = export_date.clone();
        metadata.root_attributes = stats.root_attributes;
        metadata.ignored_attachments = 0;
        for attachment in &attachments {
            self.persist_attachment(attachment, staging.path(), dry_run)?;
            metadata.attachments.insert(
                attachment.relative_path.to_string_lossy().into_owned(),
                AttachmentRef {
                    source: "apple-health".into(),
                    account_id: None,
                    sha256: attachment.sha256.clone(),
                    collection: None,
                },
            );
        }
        metadata.days = days;
        metadata.sources.insert(
            "apple-health".into(),
            SourceState {
                input_sha256: Some(input_sha256),
                export_date: Some(export_date),
                ..Default::default()
            },
        );
        let mut report = self.commit(metadata, &old, dry_run)?;
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

    /// API records always belong to an explicitly verified provider account.
    pub fn apply_provider_for_account(
        &self,
        staged_jsonl: &Path,
        report: &FetchReport,
        dry_run: bool,
        account_id: &str,
        region: GarminRegion,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Report> {
        if !valid_hash(account_id) {
            return Err("Invalid provider account identity".into());
        }
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
        let old = self.metadata()?;
        self.check_owned(&old)?;
        if report.source == "garmin"
            && old
                .as_ref()
                .and_then(|m| m.sources.get("garmin"))
                .and_then(|s| s.accounts.get(account_id))
                .is_some_and(|a| a.garmin_region != Some(region))
        {
            return Err("Garmin region disagrees with this account's existing data".into());
        }
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
                attributes.insert("accountId".into(), account_id.into());
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
                            self.read_shard(day, shard, &mut |record| {
                                let owner = record.attributes.get("accountId").map(String::as_str);
                                if replace_collection && owner == Some(account_id) {
                                    return Ok(());
                                }
                                stage_record(&mut insert, &record)
                            })?;
                        }
                    }
                }
            }
        }
        tx.commit().map_err(err)?;
        progress("Preparing SQLite records and indexes");
        let days = self.prepare_days(&db, staging.path(), &touched, &old, dry_run, progress)?;
        let mut metadata = old.clone().unwrap_or_else(empty_metadata);
        metadata.days = days;
        metadata.attachments.retain(|path, attachment| {
            let day = attachment_path_parts(path)
                .map(|(day, _)| day)
                .unwrap_or("");
            let in_window =
                day == "_undated" || (day >= report.since.as_str() && day <= report.until.as_str());
            !(attachment.source == report.source
                && attachment.account_id.as_deref() == Some(account_id)
                && in_window
                && attachment
                    .collection
                    .as_ref()
                    .is_some_and(|c| complete.contains(&format!("{}.{}", report.source, c))))
        });
        for (collection, attachment) in &attachments {
            self.persist_attachment(attachment, staging.path(), dry_run)?;
            metadata.attachments.insert(
                attachment.relative_path.to_string_lossy().into_owned(),
                AttachmentRef {
                    source: report.source.clone(),
                    account_id: Some(account_id.into()),
                    sha256: attachment.sha256.clone(),
                    collection: Some(collection.clone()),
                },
            );
        }
        let state = metadata.sources.entry(report.source.clone()).or_default();
        let account = state.accounts.entry(account_id.into()).or_default();
        if report.source == "garmin" {
            account.garmin_region = Some(region);
        }
        let target_collections = &mut account.collections;
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
        let mut outcome = self.commit(metadata, &old, dry_run)?;
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
        self.apply_export(
            staged_jsonl,
            report,
            dry_run,
            account_id,
            Some(region),
            attachment_root,
            attachments,
            progress,
        )
    }

    /// Additive account-scoped import of a provider's exported files.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_export(
        &self,
        staged_jsonl: &Path,
        report: &FetchReport,
        dry_run: bool,
        account_id: &str,
        region: Option<GarminRegion>,
        attachment_root: &Path,
        attachments: &BTreeMap<(String, String), ExportAttachment>,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Report> {
        let source = report.source.as_str();
        if (source == "garmin") != region.is_some() {
            return Err("Garmin exports require a region; Oura exports do not accept one".into());
        }
        let prefix = format!("{source}.");
        let export_prefix = format!("{source}.export_");
        if !valid_hash(account_id) || !matches!(report.source.as_str(), "garmin" | "oura") {
            return Err("Invalid Provider export account or source".into());
        }
        if !valid_day(&report.since) || !valid_day(&report.until) || report.since > report.until {
            return Err("Invalid Provider export date bounds".into());
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
                return Err("Invalid Provider export collection report".into());
            }
        }
        if expected.is_empty() {
            return Err("Provider export report has no collections".into());
        }
        let _lock = self.lock()?;
        let old = self.metadata()?;
        self.check_owned(&old)?;
        if let Some(state) = old.as_ref().and_then(|m| m.sources.get(source)) {
            if state
                .accounts
                .get(account_id)
                .is_some_and(|a| source == "garmin" && a.garmin_region != region)
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
                let name = record.metric.strip_prefix(&prefix).unwrap().to_string();
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
                if provider.source != source || !expected.contains_key(&provider.collection) {
                    return Err("Staged Provider export record disagrees with report".into());
                }
                if provider.day != "_undated"
                    && (!valid_day(&provider.day)
                        || provider.day < report.since
                        || provider.day > report.until)
                {
                    return Err("Provider export record is outside its date bounds".into());
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
                        return Err("Conflicting Provider export record identity".into());
                    }
                    continue;
                }
                // Incoming JSON cannot nominate local files, embedded bytes, or
                // existing vault attachments. Only the private map can do that.
                if provider.data.get("content_base64").is_some()
                    || provider.data.get("attachment_path").is_some()
                {
                    return Err(
                        "Provider export payload contains reserved attachment fields".into(),
                    );
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
                    ("sourceName".into(), source.into()),
                    ("accountId".into(), account_id.into()),
                    ("exportIdentity".into(), identity),
                ]);
                if let Some(id) = provider.id {
                    attributes.insert("providerId".into(), id);
                }
                let record = HealthRecord {
                    schema_version: 1,
                    ingest_source: source.into(),
                    kind: "Supplement".into(),
                    day: provider.day,
                    metric: format!("{source}.{}", provider.collection),
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
                    progress("Staging Provider export records");
                    last = std::time::Instant::now();
                }
            }
            if received != expected || used_files.len() != attachments.len() {
                return Err(
                    "Provider export record or attachment count disagrees with report".into(),
                );
            }
            // Scan all existing export days, including dates outside this ZIP:
            // a stable ID may have moved to a corrected date in a later export.
            if let Some(metadata) = &old {
                for (day, entry) in &metadata.days {
                    if !touched.contains(day)
                        && !entry
                            .shards
                            .iter()
                            .any(|s| s.source == source && s.metric.starts_with(&export_prefix))
                    {
                        continue;
                    }
                    touched.insert(day.clone());
                    for shard in &entry.shards {
                        self.read_shard(day, shard, &mut |record| {
                            let target = record.ingest_source == source
                                && record.metric.starts_with(&export_prefix)
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
        let mut metadata = old.clone().unwrap_or_else(empty_metadata);
        metadata.days = days;
        for path in removed_files.difference(&referenced_files) {
            metadata.attachments.remove(path);
        }
        for (collection, attachment) in preserved_files {
            self.persist_attachment(&attachment, staging.path(), dry_run)?;
            metadata.attachments.insert(
                attachment.relative_path.to_string_lossy().into_owned(),
                AttachmentRef {
                    account_id: Some(account_id.into()),
                    source: source.into(),
                    sha256: attachment.sha256,
                    collection: Some(collection),
                },
            );
        }
        let account = metadata
            .sources
            .entry(source.into())
            .or_default()
            .accounts
            .entry(account_id.into())
            .or_default();
        account.garmin_region = region;
        account
            .collections
            .retain(|name, _| !name.starts_with("export_"));
        account.collections.extend(coverage);
        self.commit(metadata, &old, dry_run)
    }

    pub fn set_account_label(&self, source: &str, account_id: &str, label: &str) -> Result<()> {
        if !matches!(source, "garmin" | "oura")
            || !valid_hash(account_id)
            || label.trim().is_empty()
            || label.len() > 512
        {
            return Err("Invalid account label".into());
        }
        let _lock = self.lock()?;
        let db = self.database_connection(true)?;
        let previous: Option<Option<String>> = db
            .query_row(
                "SELECT label FROM accounts WHERE source=?1 AND account_id=?2",
                params![source, account_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let Some(previous) = previous else {
            return Err("Account is not present in this health library".into());
        };
        if previous.as_deref() != Some(label.trim()) {
            db.execute(
                "UPDATE accounts SET label=?1 WHERE source=?2 AND account_id=?3",
                params![label.trim(), source, account_id],
            )
            .map_err(err)?;
        }
        Ok(())
    }

    pub fn catalog(&self) -> Result<Value> {
        let Some(metadata) = self.metadata()? else {
            return Ok(json!({"categories":[],"sources":{}}));
        };
        let mut groups: BTreeMap<String, BTreeMap<(String, String), MetricRange>> = BTreeMap::new();
        for (day, entry) in &metadata.days {
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
        Ok(json!({"categories":categories,"sources":source_summary(&metadata)}))
    }

    fn ensure_owned(&self) -> Result<()> {
        safe_path(&self.health())?;
        let marker = self.health().join(".notemd-health-library");
        safe_path(&marker)?;
        if fs::read_to_string(&marker).ok().as_deref()
            != Some(&format!("notemd.health-sync:{}", self.identity))
        {
            return Err("Health library is unavailable or its identity marker is missing".into());
        }
        crate::library::verify_database(&self.health())?;
        Ok(())
    }

    fn check_owned(&self, _old: &Option<LibraryMetadata>) -> Result<()> {
        self.ensure_owned()
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
        let db = self.database_connection(false)?;
        let mut stmt = db.prepare("SELECT payload FROM records WHERE day=?1 AND source=?2 AND metric=?3 AND category=?4 ORDER BY payload,id").map_err(err)?;
        let mut rows = stmt
            .query(params![day, shard.source, shard.metric, shard.category])
            .map_err(err)?;
        let mut count = 0u64;
        let mut sha = Sha256::new();
        while let Some(row) = rows.next().map_err(err)? {
            let payload: String = row.get(0).map_err(err)?;
            sha.update(payload.as_bytes());
            sha.update(b"\n");
            let record: HealthRecord = serde_json::from_str(&payload).map_err(err)?;
            if record.day != day
                || record.ingest_source != shard.source
                || record.metric != shard.metric
                || catalog::category(&record.metric, &record.kind) != shard.category
            {
                return Err("Health database record membership is corrupt".into());
            }
            callback(record)?;
            count += 1;
        }
        if count != shard.record_count || format!("{:x}", sha.finalize()) != shard.sha256 {
            return Err(format!(
                "Health database record count or checksum disagrees for {day}"
            ));
        }
        Ok(())
    }

    fn finish_shard(&self, built: ShardBuilder, _dry_run: bool) -> Result<Shard> {
        Ok(Shard {
            source: built.source,
            metric: built.metric,
            category: built.category,
            sha256: format!("{:x}", built.sha.finalize()),
            record_count: built.count,
        })
    }

    fn prepare_days(
        &self,
        db: &Connection,
        dir: &Path,
        touched: &BTreeSet<String>,
        old: &Option<LibraryMetadata>,
        dry_run: bool,
        progress: &mut dyn FnMut(&str),
    ) -> Result<BTreeMap<String, Day>> {
        *self.pending.borrow_mut() = Some((dir.join("records.sqlite"), touched.clone()));
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
            let previous = old.as_ref().and_then(|m| m.days.get(day));
            if let Some(previous) = previous.filter(|p| p.sha256 == sha256) {
                days.insert(day.clone(), previous.clone());
                continue;
            }
            days.insert(
                day.clone(),
                Day {
                    sha256,
                    shards: built.shards,
                    record_count: built.count,
                },
            );
        }
        Ok(days)
    }

    fn commit(
        &self,
        mut metadata: LibraryMetadata,
        old: &Option<LibraryMetadata>,
        dry_run: bool,
    ) -> Result<Report> {
        metadata.record_count = metadata
            .days
            .values()
            .try_fold(0u64, |sum, d| sum.checked_add(d.record_count))
            .ok_or("LibraryMetadata count overflow")?;
        metadata.day_count = metadata
            .days
            .values()
            .filter(|d| d.record_count > 0)
            .count();
        let changed_days = metadata
            .days
            .iter()
            .filter(|(day, entry)| {
                old.as_ref()
                    .and_then(|m| m.days.get(*day))
                    .map(|d| &d.sha256)
                    != Some(&entry.sha256)
            })
            .count();
        let data_changed = old.as_ref() != Some(&metadata);
        if !dry_run && data_changed {
            self.ensure_owned()?;
            let pending = self.pending.borrow();
            let (candidate, touched) = pending.as_ref().ok_or("Missing staged health records")?;
            crate::storage::commit(
                &mut self.database_connection(true)?,
                &metadata,
                candidate,
                touched,
            )?;
        }
        Ok(Report {
            complete: true,
            dry_run,
            data_changed,
            input_sha256: metadata.input_sha256,
            record_count: metadata.record_count,
            changed_days,
            unchanged_days: metadata.days.len() - changed_days,
            warnings: vec![],
        })
    }

    fn shards_present(
        &self,
        metadata: &LibraryMetadata,
        progress: &mut dyn FnMut(&str),
    ) -> Result<bool> {
        let mut present = true;
        let mut last = std::time::Instant::now();
        for (day, entry) in &metadata.days {
            for shard in &entry.shards {
                self.read_shard(day, shard, &mut |_| Ok(()))?;
            }
            if last.elapsed().as_secs() >= 10 {
                progress("Verifying existing SQLite records");
                last = std::time::Instant::now();
            }
        }
        for (path, attachment) in &metadata.attachments {
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
        let db = self
            .database_connection(false)
            .map_err(|e| format!("No readable health library: {e}"))?;
        let mut predicates = vec![];
        let mut values: Vec<rusqlite::types::Value> = vec![];
        for (column, value) in [
            ("source", source),
            ("account_id", account_id),
            ("metric", metric),
            ("category", category),
        ] {
            if let Some(value) = value {
                predicates.push(format!("{column}=?"));
                values.push(value.to_string().into());
            }
        }
        if since.is_some() || until.is_some() {
            predicates.push("day <> '_undated'".into());
        }
        for (operator, value) in [(">=", since), ("<=", until)] {
            if let Some(value) = value {
                predicates.push(format!("day {operator} ?"));
                values.push(value.to_string().into());
            }
        }
        let clause = if predicates.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", predicates.join(" AND "))
        };
        values.push(((limit + 1) as i64).into());
        values.push(i64::try_from(offset).map_err(err)?.into());
        let sql=format!("SELECT payload FROM records {clause} ORDER BY day,source,metric,category,id LIMIT ? OFFSET ?");
        let mut stmt = db.prepare(&sql).map_err(err)?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(values))
            .map_err(err)?;
        let mut records = vec![];
        while let Some(row) = rows.next().map_err(err)? {
            let payload: String = row.get(0).map_err(err)?;
            let record = serde_json::from_str::<HealthRecord>(&payload).map_err(err)?;
            records.push(record);
        }
        let has_more = records.len() > limit;
        records.truncate(limit);
        let input_sha256: Option<String> = db
            .query_row(
                "SELECT input_sha256 FROM sources WHERE source='apple-health'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?
            .flatten();
        Ok(
            json!({"records":records,"has_more":has_more,"next_offset":if has_more{json!(offset.checked_add(limit).ok_or("Query offset overflow")?)}else{Value::Null},"input_sha256":input_sha256.unwrap_or_default()}),
        )
    }
}

fn empty_metadata() -> LibraryMetadata {
    LibraryMetadata {
        schema_version: 1,
        source: "health-library".into(),
        scope: "raw-library".into(),
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

struct DayBuilder {
    shards: Vec<Shard>,
    count: u64,
}
impl DayBuilder {
    fn new(_day: &str) -> Self {
        Self {
            shards: vec![],
            count: 0,
        }
    }
    fn add(
        &mut self,
        _payload: &str,
        _sources: Option<&BTreeMap<String, SourceState>>,
    ) -> Result<()> {
        self.count += 1;
        Ok(())
    }
}
struct ShardBuilder {
    source: String,
    metric: String,
    category: String,
    sha: Sha256,
    count: u64,
}
impl ShardBuilder {
    fn new(
        _day: &str,
        source: String,
        metric: String,
        category: String,
        _dir: &Path,
    ) -> Result<Self> {
        Ok(Self {
            source,
            metric,
            category,
            sha: Sha256::new(),
            count: 0,
        })
    }
    fn add(&mut self, payload: &str) -> Result<()> {
        self.sha.update(payload.as_bytes());
        self.sha.update(b"\n");
        self.count += 1;
        Ok(())
    }
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
            let library = temp.path().join("library");
            fs::create_dir(&library).unwrap();
            crate::library::configure(&vault, &temp.path().join("state"), &library).unwrap();
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
        assert_eq!(f.store.metadata().unwrap().unwrap().record_count, 2);
        f.apply(&a, &[row("sleep", day, 11)], &complete);
        assert_eq!(f.query(&a)["records"][0]["payload"]["value"], 11);
        assert_eq!(f.query(&b)["records"][0]["payload"]["value"], 20);
        let failed = report(day, &[("sleep", "failed", 0)]);
        let outcome = f.apply(&b, &[], &failed);
        assert!(!outcome.complete);
        let m = f.store.metadata().unwrap().unwrap();
        assert_eq!(m.schema_version, 1);
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
        assert!(f
            .store
            .apply_provider_for_account(
                &f.staged(&[]),
                &report(day, &[("sleep", "complete", 0)]),
                false,
                "invalid",
                GarminRegion::Global,
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
            .apply_provider_for_account(&path, &r, false, &b, GarminRegion::China, &mut |_| {})
            .unwrap();
        assert!(f
            .store
            .apply_provider_for_account(&path, &r, false, &a, GarminRegion::China, &mut |_| {})
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
        let m = f.store.metadata().unwrap().unwrap();
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
        let m = f.store.metadata().unwrap().unwrap();
        assert_eq!(m.attachments.len(), 1);
        assert_eq!(
            m.attachments.values().next().unwrap().account_id.as_deref(),
            Some(b.as_str())
        );
        assert!(f.query(&a)["records"].as_array().unwrap().is_empty());
        assert_eq!(f.query(&b)["records"].as_array().unwrap().len(), 2);
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
        let original = f.store.metadata().unwrap().unwrap();
        let apple = original.days[day].shards[0].clone();
        let r = report(day, &[("sleep", "complete", 1)]);
        f.apply(&a, &[row("sleep", day, 1)], &r);
        f.apply(&b, &[row("sleep", day, 2)], &r);
        fs::write(&export,format!("<HealthData><ExportDate value='2026-10-24 10:00:00 +0900'/><Record type='HeartRate' startDate='{day}' value='60' accountId='opaque-apple-attribute'/></HealthData>")).unwrap();
        f.store.import(&export, false, &mut |_| {}).unwrap();
        let m = f.store.metadata().unwrap().unwrap();
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
        let metadata = f.store.metadata().unwrap().unwrap();
        let coverage = &metadata.sources["garmin"].accounts[&a].collections["export_sleep"];
        assert_eq!(coverage.len(), 2);
        assert!(coverage
            .values()
            .all(|c| c.status == "observed" && c.record_count == 1));
        let summary = source_summary(&metadata);
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
        assert!(f.store.metadata().unwrap().is_none());
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
        let metadata = f.store.metadata().unwrap().unwrap();
        let (path, attachment) = metadata.attachments.iter().next().unwrap();
        assert_eq!(attachment.sha256, hash(b""));
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
        assert_eq!(f.store.metadata().unwrap().unwrap(), metadata);
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
        assert!(f.store.metadata().unwrap().is_none());
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
        let metadata = f.store.metadata().unwrap().unwrap();
        assert_eq!(metadata.attachments.len(), 2);
        assert_eq!(metadata.record_count, 2);
        assert!(metadata
            .attachments
            .values()
            .any(|a| a.sha256 == hash(b"same")));
        assert!(metadata
            .attachments
            .values()
            .any(|a| a.sha256 == hash(b"updated")));
    }
    #[test]
    fn reopened_library_preserves_sources_and_original_attachments() {
        let f = Fixture::new();
        let account = hash(b"external-library-account");
        let mut row = row("activity_files", "2020-01-01", 0);
        row.data = json!({"content_base64":"c2FtZS1ieXRlcw==","filename":"activity.zip"});
        f.apply(
            &account,
            &[row],
            &report("2020-01-01", &[("activity_files", "complete", 1)]),
        );
        let reopened =
            Store::new(&f.temp.path().join("vault"), &f.temp.path().join("state")).unwrap();
        let m = reopened.metadata().unwrap().unwrap();
        assert_eq!(m.record_count, 1);
        for (path, a) in &m.attachments {
            assert!(path.starts_with("attachments/"));
            assert_eq!(
                hash(&fs::read(reopened.health().join(path)).unwrap()),
                a.sha256
            );
        }
        assert_eq!(
            fs::read_dir(f.temp.path().join("vault")).unwrap().count(),
            0
        );
    }
}
