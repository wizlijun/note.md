//! Bounded, ephemeral index snapshots. A frozen snapshot freezes data, never
//! authorization. Both process RPC and plugin-window RPC use this adapter.
use plugin_protocol::{IndexBlocksParams, IndexRange, IndexSnapshotParams, IndexStatusParams};
use searchidx::{
    query::Weights,
    snapshot::{Capture, File},
    ScanOptions, SearchIndex,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::Manager;

const TTL: Duration = Duration::from_secs(3600);
const TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 128 * 1024 * 1024;
#[derive(Clone)]
struct Context {
    root: PathBuf,
    config: String,
    opts: ScanOptions,
    weights: Weights,
}
#[derive(Clone)]
struct Cursor {
    kind: &'static str,
    binding: String,
    file: usize,
    unit: usize,
}
struct Snapshot {
    id: String,
    plugin: String,
    context: Context,
    range: Option<IndexRange>,
    as_of: String,
    generation: String,
    files: Vec<File>,
    coverage: Value,
    created: Instant,
    cursors: HashMap<String, Cursor>,
    served: usize,
    retained: usize,
    source_stamps: HashMap<String, (u64, u128)>,
}
#[derive(Default)]
struct Cache {
    entries: HashMap<String, Arc<Mutex<Snapshot>>>,
}
static EPOCH: AtomicU64 = AtomicU64::new(0);
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));

/// Called synchronously before Vault switch/reopen. Old IDs cannot resurrect
/// if the user switches back to the original Vault.
pub(crate) fn invalidate_all() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
    CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entries
        .clear();
}
pub(crate) fn invalidate_plugin(plugin: &str) {
    EPOCH.fetch_add(1, Ordering::SeqCst);
    CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entries
        .retain(|_, v| v.lock().unwrap_or_else(|p| p.into_inner()).plugin != plugin);
}
fn authorized(plugin: &str) -> bool {
    super::STATE
        .read()
        .unwrap()
        .plugins
        .get(plugin)
        .is_some_and(|(m, _)| m.capabilities.iter().any(|c| c == "index.read"))
}
fn context<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Context, String> {
    let root = crate::sotvault::resolve_vault_root(app)
        .ok_or("VAULT_UNAVAILABLE")?
        .canonicalize()
        .map_err(|_| "VAULT_UNAVAILABLE")?;
    let vs = crate::sotvault::vault_settings::read(&root);
    let opts = crate::search::options::from_settings(&vs);
    let weights = crate::search::options::weights_from(&vs);
    let config=searchidx::norm::content_hash(&serde_json::to_vec(&json!({"schema":searchidx::store::SCHEMA_VERSION,"tokenizer":searchidx::tokenize::TOKENIZER_ID,"policy":searchidx::snapshot::POLICY_VERSION,"globs":opts.source_globs.stamp(),"exclude":opts.exclude_dirs,"largeMb":opts.large_file_threshold_mb,"weights":weights})).unwrap());
    Ok(Context {
        root,
        config,
        opts,
        weights,
    })
}
fn version(v: u32) -> Result<(), String> {
    if v == 1 {
        Ok(())
    } else {
        Err("INVALID_PARAMS: unsupported index version".into())
    }
}
fn validate_range(range: Option<&IndexRange>) -> Result<(), String> {
    if let Some(r) = range {
        let valid = |d: &str| {
            d.len() == 10
                && !d.starts_with("0000")
                && chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
                    .is_ok_and(|v| v.format("%Y-%m-%d").to_string() == d)
        };
        if r.date_kind != "doc_date" || !valid(&r.from) || !valid(&r.to) || r.from > r.to {
            return Err("INVALID_PARAMS: inclusive doc_date range requires real YYYY-MM-DD dates and from <= to".into());
        }
    }
    Ok(())
}
fn lookup(id: &str, plugin: &str, ctx: &Context) -> Result<Arc<Mutex<Snapshot>>, String> {
    let entry = CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entries
        .get(id)
        .cloned()
        .ok_or("SNAPSHOT_EXPIRED")?;
    {
        let snap = entry.lock().unwrap_or_else(|p| p.into_inner());
        if snap.plugin != plugin {
            return Err("CAPABILITY_DENIED: snapshot owner mismatch".into());
        }
        if snap.context.root != ctx.root || snap.context.config != ctx.config {
            return Err("SNAPSHOT_INVALIDATED".into());
        }
        if snap.created.elapsed() > TTL {
            return Err("SNAPSHOT_EXPIRED".into());
        }
    }
    Ok(entry)
}
fn token(snap: &mut Snapshot, cursor: Cursor) -> Result<String, String> {
    // Stable reuse avoids growing the cursor registry when a page is retried.
    if let Some((id, _)) = snap.cursors.iter().find(|(_, c)| {
        c.kind == cursor.kind
            && c.binding == cursor.binding
            && c.file == cursor.file
            && c.unit == cursor.unit
    }) {
        return Ok(id.clone());
    }
    if snap.cursors.len() >= 4096 {
        return Err("SNAPSHOT_LIMIT: too many cursors".into());
    }
    let id = format!("{}.{}", snap.id, uuid::Uuid::new_v4());
    snap.cursors.insert(id.clone(), cursor);
    Ok(id)
}
fn snapshot_from_cursor(cursor: &str) -> Result<&str, String> {
    cursor
        .split_once('.')
        .map(|(id, _)| id)
        .ok_or_else(|| "INVALID_CURSOR".into())
}
fn resolve_cursor(
    snap: &Snapshot,
    id: Option<&str>,
    kind: &str,
    binding: &str,
) -> Result<Cursor, String> {
    match id {
        None => Ok(Cursor {
            kind: if kind == "metadata" {
                "metadata"
            } else {
                "blocks"
            },
            binding: binding.into(),
            file: 0,
            unit: 0,
        }),
        Some(id) => snap
            .cursors
            .get(id)
            .filter(|c| c.kind == kind && c.binding == binding)
            .cloned()
            .ok_or_else(|| "INVALID_CURSOR: request binding changed".into()),
    }
}
fn safe_path(root: &Path, rel: &str, opts: &ScanOptions) -> Result<PathBuf, &'static str> {
    if !searchidx::scan::is_indexable(rel, opts) {
        return Err("denied");
    }
    let mut path = root.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(name) => path.push(name),
            _ => return Err("denied"),
        }
        let meta = std::fs::symlink_metadata(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "missing"
            } else {
                "denied"
            }
        })?;
        if meta.file_type().is_symlink() {
            return Err("denied");
        }
    }
    if !path.is_file() {
        return Err("denied");
    }
    Ok(path)
}
fn source_stamp(ctx: &Context, file: &File) -> Option<(u64, u128)> {
    let path = safe_path(&ctx.root, &file.path, &ctx.opts).ok()?;
    let meta = std::fs::metadata(path).ok()?;
    Some((
        meta.len(),
        meta.modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    ))
}
fn unchanged(snap: &Snapshot, file: &File) -> bool {
    source_stamp(&snap.context, file).as_ref() == snap.source_stamps.get(&file.file_key)
}
fn stat_current(ctx: &Context, file: &File) -> bool {
    let Ok(path) = safe_path(&ctx.root, &file.path, &ctx.opts) else {
        return false;
    };
    std::fs::metadata(path).is_ok_and(|m| {
        m.len() == file.size
            && m.modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .is_some_and(|d| d.as_secs() as i64 == file.mtime)
    })
}
// openat pins each directory descriptor: an attacker cannot replace an
// intermediate component with a symlink between validation and source read.
#[cfg(unix)]
fn open_source(root: &Path, rel: &str) -> std::io::Result<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let mut file = std::fs::File::open(root)?;
    let parts: Vec<_> = Path::new(rel).components().collect();
    for (i, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        };
        let name = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| std::io::ErrorKind::InvalidInput)?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if i + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        let fd = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        file = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    if !file.metadata()?.is_file() {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}
#[cfg(windows)]
fn open_source(root: &Path, rel: &str) -> std::io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    };
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut std::ffi::c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(0x00200000 /* OPEN_REPARSE_POINT */)
        .open(root.join(rel))?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.file_attributes() & 0x400 != 0 {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    // Validate the opened handle, not a pathname that could have changed
    // after open. This closes intermediate directory/junction replacement.
    let mut wide = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            wide.as_mut_ptr(),
            wide.len() as u32,
            0,
        )
    };
    if length == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if length as usize >= wide.len() {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    wide.truncate(length as usize);
    if !PathBuf::from(std::ffi::OsString::from_wide(&wide)).starts_with(root.canonicalize()?) {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}
#[cfg(not(any(unix, windows)))]
fn open_source(_root: &Path, _rel: &str) -> std::io::Result<std::fs::File> {
    Err(std::io::ErrorKind::Unsupported.into())
}

fn verified_source(ctx: &Context, file: &File) -> Result<String, &'static str> {
    safe_path(&ctx.root, &file.path, &ctx.opts)?;
    let source = open_source(&ctx.root, &file.path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "missing"
        } else {
            "denied"
        }
    })?;
    let limit = (ctx.opts.large_file_threshold_mb as u64 * 1024 * 1024).min(TOTAL_BYTES as u64);
    if source.metadata().map_err(|_| "denied")?.len() > limit {
        return Err("too_large");
    }
    let mut bytes = Vec::new();
    source
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "denied")?;
    if bytes.len() as u64 > limit {
        return Err("too_large");
    }
    if searchidx::norm::content_hash(&bytes) != file.content_hash {
        return Err("changed");
    }
    let text = String::from_utf8(bytes).map_err(|_| "changed")?;
    Ok(searchidx::norm::strip_cr(&text).into_owned())
}
fn build_snapshot(
    plugin: &str,
    ctx: Context,
    range: Option<IndexRange>,
    as_of: String,
    mut capture: Capture,
) -> Result<Snapshot, String> {
    let mut excluded = 0;
    let mut stale = 0;
    capture.files.retain(|f| {
        if safe_path(&ctx.root, &f.path, &ctx.opts).is_err() {
            excluded += 1;
            return false;
        }
        if !stat_current(&ctx, f) {
            stale += 1;
            return false;
        }
        true
    });
    let skipped = capture.files.iter().filter(|f| f.units.is_empty()).count();
    let coverage = json!({"indexed":capture.indexed,"selected":capture.files.len(),"stale":stale,"excluded":excluded,"undated":capture.undated,"skipped":skipped});
    let retained = serde_json::to_vec(&capture.files).unwrap().len()
        + capture
            .files
            .iter()
            .flat_map(|f| &f.units)
            .map(|u| u.breadcrumb.len() + u.agent_by.as_ref().map_or(0, String::len) + 256)
            .sum::<usize>();
    let source_stamps = capture
        .files
        .iter()
        .filter_map(|f| source_stamp(&ctx, f).map(|s| (f.file_key.clone(), s)))
        .collect();
    Ok(Snapshot {
        source_stamps,
        id: uuid::Uuid::new_v4().to_string(),
        plugin: plugin.into(),
        context: ctx,
        range,
        as_of,
        generation: capture.generation,
        files: capture.files,
        coverage,
        created: Instant::now(),
        cursors: HashMap::new(),
        served: 0,
        retained,
    })
}
fn insert(snap: Snapshot) -> Arc<Mutex<Snapshot>> {
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.entries.retain(|_, s| {
        s.lock()
            .unwrap_or_else(|p| p.into_inner())
            .created
            .elapsed()
            < TTL
    });
    loop {
        let mut bytes = snap.retained;
        let mut plugin_count = 0;
        let mut oldest: Option<(String, Instant)> = None;
        for (id, s) in &cache.entries {
            let s = s.lock().unwrap_or_else(|p| p.into_inner());
            bytes += s.retained;
            plugin_count += usize::from(s.plugin == snap.plugin);
            if oldest.as_ref().is_none_or(|(_, t)| s.created < *t) {
                oldest = Some((id.clone(), s.created));
            }
        }
        if bytes <= MAX_CACHE_BYTES && cache.entries.len() < 32 && plugin_count < 8 {
            break;
        }
        if let Some((id, _)) = oldest {
            cache.entries.remove(&id);
        } else {
            break;
        }
    }
    let id = snap.id.clone();
    let value = Arc::new(Mutex::new(snap));
    cache.entries.insert(id, value.clone());
    value
}
fn metadata_page(snap: &mut Snapshot, p: &IndexSnapshotParams) -> Result<Value, String> {
    if p.range != snap.range {
        return Err("INVALID_CURSOR: date range changed".into());
    }
    let page = p.page_size.unwrap_or(500);
    if page == 0 || page > 1000 {
        return Err("INVALID_PARAMS: pageSize must be 1..1000".into());
    }
    let binding = serde_json::to_string(&p.range).unwrap();
    let position = resolve_cursor(snap, p.cursor.as_deref(), "metadata", &binding)?;
    let end = (position.file + page).min(snap.files.len());
    if snap.files[position.file..end]
        .iter()
        .any(|f| !unchanged(snap, f))
    {
        return Err("SNAPSHOT_STALE: source changed; refresh metadata".into());
    }
    let next = if end < snap.files.len() {
        Some(token(
            snap,
            Cursor {
                kind: "metadata",
                binding,
                file: end,
                unit: 0,
            },
        )?)
    } else {
        None
    };
    let mut result = json!({"snapshotId":snap.id,"configHash":snap.context.config,"asOf":snap.as_of,"indexGeneration":snap.generation,"policyVersion":searchidx::snapshot::POLICY_VERSION,"mode":if snap.range.is_some(){"range"}else{"atlas_metadata"},"effectiveWeights":snap.context.weights,"files":&snap.files[position.file..end],"coverage":snap.coverage,"freshness":if snap.coverage["stale"].as_u64().unwrap_or(0)>0{"stale"}else{"current"}});
    if let Some(next) = next {
        result["nextCursor"] = json!(next);
    }
    Ok(result)
}
fn blocks_page(snap: &mut Snapshot, p: &IndexBlocksParams) -> Result<Value, String> {
    if snap.range.is_none() {
        return Err("CAPABILITY_DENIED: atlas_metadata cannot read source blocks".into());
    }
    if p.file_keys.is_empty() || p.file_keys.len() > 1000 {
        return Err("INVALID_PARAMS: fileKeys must contain 1..1000 keys".into());
    }
    let keys: HashSet<_> = p.file_keys.iter().collect();
    if keys.len() != p.file_keys.len() {
        return Err("INVALID_PARAMS: duplicate fileKeys".into());
    }
    let indices: HashMap<_, _> = snap
        .files
        .iter()
        .enumerate()
        .map(|(i, f)| (&f.file_key, i))
        .collect();
    let selected: Vec<usize> = p
        .file_keys
        .iter()
        .map(|key| {
            indices
                .get(key)
                .copied()
                .ok_or_else(|| "CAPABILITY_DENIED: fileKey outside snapshot".to_string())
        })
        .collect::<Result<_, _>>()?;
    let limit = p.max_bytes.unwrap_or(1024 * 1024);
    if limit == 0 || limit > MAX_PAGE_BYTES {
        return Err("INVALID_PARAMS: maxBytes must be 1..4194304".into());
    }
    let binding = searchidx::norm::content_hash(&serde_json::to_vec(&p.file_keys).unwrap());
    let mut cursor = resolve_cursor(snap, p.cursor.as_deref(), "blocks", &binding)?;
    let mut units = Vec::new();
    let mut conflicts = Vec::new();
    let mut bytes = 0;
    let mut pause = false;
    while cursor.file < selected.len() {
        let file = &snap.files[selected[cursor.file]];
        let text = match verified_source(&snap.context, file) {
            Ok(t) => t,
            Err(reason) => {
                conflicts.push(json!({"fileKey":file.file_key,"reason":reason}));
                cursor.file += 1;
                cursor.unit = 0;
                continue;
            }
        };
        let lines: Vec<_> = text.split('\n').collect();
        while cursor.unit < file.units.len() {
            let unit = &file.units[cursor.unit];
            let Some(slice) = lines.get(unit.line_start as usize - 1..unit.line_end as usize)
            else {
                conflicts.push(json!({"fileKey":file.file_key,"reason":"changed"}));
                cursor.unit = file.units.len();
                break;
            };
            let text = slice.join("\n");
            if text.len() > limit {
                conflicts.push(json!({"fileKey":file.file_key,"reason":"too_large"}));
                cursor.unit += 1;
                continue;
            }
            if bytes + text.len() > limit || units.len() >= 2000 {
                pause = true;
                break;
            }
            if snap.served + bytes + text.len() > TOTAL_BYTES {
                return Err("SNAPSHOT_BUDGET_EXCEEDED: source total exceeds 32 MiB".into());
            }
            bytes += text.len();
            let mut value = serde_json::to_value(unit).unwrap();
            value["fileKey"] = json!(file.file_key);
            value["contentHash"] = json!(file.content_hash);
            value["text"] = json!(text);
            units.push(value);
            cursor.unit += 1;
        }
        if pause {
            break;
        }
        cursor.file += 1;
        cursor.unit = 0;
    }
    snap.served += bytes;
    let next = if cursor.file < selected.len() {
        Some(token(snap, cursor)?)
    } else {
        None
    };
    let mut result = json!({"snapshotId":snap.id,"units":units,"conflicts":conflicts});
    if let Some(next) = next {
        result["nextCursor"] = json!(next);
    }
    Ok(result)
}

pub(crate) fn error_code(detail: &str) -> i64 {
    if detail.starts_with("CAPABILITY_DENIED") {
        plugin_protocol::ERR_CAPABILITY_DENIED
    } else {
        plugin_protocol::ERR_INTERNAL
    }
}

pub(crate) fn dispatch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin: &str,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let epoch = EPOCH.load(Ordering::SeqCst);
    if !authorized(plugin) {
        invalidate_plugin(plugin);
        return Err("CAPABILITY_DENIED: index.read revoked".into());
    }
    let ctx = context(app)?;
    let result = match method {
        "host.index.snapshot" => {
            let p: IndexSnapshotParams = serde_json::from_value(params.clone())
                .map_err(|e| format!("INVALID_PARAMS: {e}"))?;
            version(p.version)?;
            validate_range(p.range.as_ref())?;
            let entry = if let Some(cursor) = &p.cursor {
                lookup(snapshot_from_cursor(cursor)?, plugin, &ctx)?
            } else {
                let as_of = searchidx::snapshot::as_of();
                let from = p.range.as_ref().map(|r| r.from.as_str());
                let to = p.range.as_ref().map(|r| r.to.as_str());
                let capture = if let Some(handle) = app.try_state::<crate::search::IndexHandle>() {
                    let mut guard = crate::search::lock(handle.inner());
                    let index = guard
                        .as_mut()
                        .ok_or("INDEX_NOT_READY: initial build or rebuild in progress")?;
                    if index.vault_root().canonicalize().ok().as_ref() != Some(&ctx.root) {
                        return Err("INDEX_NOT_READY: vault changed".into());
                    }
                    index.capture_metadata(from, to, &as_of, &ctx.weights)?
                } else {
                    // Headless CLI uses the existing index without triggering
                    // source reads. Initial/schema rebuild belongs to the indexer.
                    let db = searchidx::paths::index_db_path(&ctx.root).ok_or("INDEX_NOT_READY")?;
                    let mut index = SearchIndex::open_existing_at(
                        &ctx.root,
                        &db,
                        &ctx.opts.source_globs.stamp(),
                    )?;
                    index.capture_metadata(from, to, &as_of, &ctx.weights)?
                };
                insert(build_snapshot(
                    plugin,
                    ctx.clone(),
                    p.range.clone(),
                    as_of,
                    capture,
                )?)
            };
            let mut snap = entry.lock().unwrap_or_else(|p| p.into_inner());
            metadata_page(&mut snap, &p)?
        }
        "host.index.blocks" => {
            let p: IndexBlocksParams = serde_json::from_value(params.clone())
                .map_err(|e| format!("INVALID_PARAMS: {e}"))?;
            version(p.version)?;
            let entry = lookup(&p.snapshot_id, plugin, &ctx)?;
            let mut snap = entry.lock().unwrap_or_else(|p| p.into_inner());
            blocks_page(&mut snap, &p)?
        }
        "host.index.status" => {
            let p: IndexStatusParams = serde_json::from_value(params.clone())
                .map_err(|e| format!("INVALID_PARAMS: {e}"))?;
            version(p.version)?;
            match lookup(&p.snapshot_id, plugin, &ctx) {
                Err(reason) => {
                    json!({"snapshotId":p.snapshot_id,"freshness":"stale","valid":false,"reason":reason})
                }
                Ok(entry) => {
                    let snap = entry.lock().unwrap_or_else(|p| p.into_inner());
                    let valid = snap.coverage["stale"].as_u64() == Some(0)
                        && snap.files.iter().all(|f| unchanged(&snap, f));
                    json!({"snapshotId":p.snapshot_id,"freshness":if valid{"current"}else{"stale"},"valid":valid,"reason":if valid{Value::Null}else{json!("SOURCE_CHANGED")}})
                }
            }
        }
        _ => return Err("METHOD_NOT_FOUND".into()),
    };
    // Recheck after IO: a concurrent Vault/settings/permission change cannot
    // release data obtained under the previous authorization.
    if !authorized(plugin) {
        invalidate_plugin(plugin);
        return Err("CAPABILITY_DENIED: index.read revoked".into());
    }
    let after = context(app)?;
    if EPOCH.load(Ordering::SeqCst) != epoch || after.root != ctx.root || after.config != ctx.config
    {
        return Err("SNAPSHOT_INVALIDATED".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Snapshot) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("2026-09-01-a.md"),"---\ntype: insight\nprivate: true\n---\n# Header\n\nFirst secret paragraph.\n\nSecond secret paragraph.\n").unwrap();
        std::fs::write(
            dir.path().join("2026-09-30-b.md"),
            "# Last\r\n\r\nOther evidence.\r\n",
        )
        .unwrap();
        let root = dir.path().canonicalize().unwrap();
        let opts = ScanOptions::default();
        let mut index = SearchIndex::open_at(&root, &root.join(".index.db"), "").unwrap();
        index.ensure_built(&opts).unwrap();
        let capture = index
            .capture_metadata(
                Some("2026-09-01"),
                Some("2026-09-30"),
                "2026-09-30",
                &Weights::default(),
            )
            .unwrap();
        let ctx = Context {
            root,
            config: "fixture-config".into(),
            opts,
            weights: Weights::default(),
        };
        let range = Some(IndexRange {
            from: "2026-09-01".into(),
            to: "2026-09-30".into(),
            date_kind: "doc_date".into(),
        });
        let snap =
            build_snapshot("fixture.plugin", ctx, range, "2026-09-30".into(), capture).unwrap();
        (dir, snap)
    }
    fn request(snap: &Snapshot) -> IndexBlocksParams {
        IndexBlocksParams {
            version: 1,
            snapshot_id: snap.id.clone(),
            file_keys: snap.files.iter().map(|f| f.file_key.clone()).collect(),
            cursor: None,
            max_bytes: None,
        }
    }
    #[test]
    fn date_validation_rejects_magic_invalid_and_reversed_ranges() {
        for (from, to) in [
            ("0000-01-01", "2026-09-30"),
            ("2026-02-30", "2026-09-30"),
            ("2026-10-01", "2026-09-30"),
            ("2026-9-01", "2026-09-30"),
        ] {
            assert!(validate_range(Some(&IndexRange {
                from: from.into(),
                to: to.into(),
                date_kind: "doc_date".into()
            }))
            .is_err());
        }
        assert!(validate_range(Some(&IndexRange {
            from: "2024-02-29".into(),
            to: "2024-02-29".into(),
            date_kind: "doc_date".into()
        }))
        .is_ok());
    }
    #[test]
    fn metadata_cursor_freezes_pages_binds_range_and_contains_no_body() {
        let (_dir, mut snap) = fixture();
        let p = IndexSnapshotParams {
            version: 1,
            range: snap.range.clone(),
            cursor: None,
            page_size: Some(1),
        };
        let first = metadata_page(&mut snap, &p).unwrap();
        serde_json::from_value::<plugin_protocol::IndexSnapshotResult>(first.clone()).unwrap();
        assert!(!first.to_string().contains("secret paragraph"));
        let mut next = p.clone();
        next.cursor = Some(first["nextCursor"].as_str().unwrap().into());
        let second = metadata_page(&mut snap, &next).unwrap();
        assert_ne!(first["files"][0]["fileKey"], second["files"][0]["fileKey"]);
        assert_eq!(first["snapshotId"], second["snapshotId"]);
        assert!(second.get("nextCursor").is_none());
        next.range = None;
        assert!(metadata_page(&mut snap, &next)
            .unwrap_err()
            .contains("INVALID_CURSOR"));
    }
    #[test]
    fn source_is_exact_inclusive_cr_normalized_and_hash_checked() {
        let (dir, mut snap) = fixture();
        let p = request(&snap);
        let result = blocks_page(&mut snap, &p).unwrap();
        serde_json::from_value::<plugin_protocol::IndexBlocksResult>(result.clone()).unwrap();
        assert!(!result["units"].as_array().unwrap().is_empty());
        for unit in result["units"].as_array().unwrap() {
            let file = snap
                .files
                .iter()
                .find(|f| f.file_key == unit["fileKey"])
                .unwrap();
            let raw = std::fs::read_to_string(dir.path().join(&file.path)).unwrap();
            let normalized = searchidx::norm::strip_cr(&raw);
            let lines: Vec<_> = normalized.split('\n').collect();
            assert_eq!(
                unit["text"],
                lines[unit["lineStart"].as_u64().unwrap() as usize - 1
                    ..unit["lineEnd"].as_u64().unwrap() as usize]
                    .join("\n")
            );
        }
        std::fs::write(dir.path().join(&snap.files[0].path), "CHANGED CONTENT").unwrap();
        let result = blocks_page(&mut snap, &p).unwrap();
        assert!(result["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["reason"] == "changed"));
        assert!(!result.to_string().contains("CHANGED CONTENT"));
    }
    #[test]
    fn atlas_foreign_keys_exclusions_and_budget_fail_closed() {
        let (_dir, mut snap) = fixture();
        let mut p = request(&snap);
        snap.range = None;
        assert!(blocks_page(&mut snap, &p)
            .unwrap_err()
            .contains("atlas_metadata"));
        snap.range = Some(IndexRange {
            from: "2026-09-01".into(),
            to: "2026-09-30".into(),
            date_kind: "doc_date".into(),
        });
        p.file_keys = vec!["fabricated".into()];
        assert!(blocks_page(&mut snap, &p)
            .unwrap_err()
            .contains("outside snapshot"));
        p = request(&snap);
        snap.served = TOTAL_BYTES;
        assert!(blocks_page(&mut snap, &p).unwrap_err().contains("BUDGET"));
        snap.served = 0;
        snap.context.opts.exclude_dirs = vec![snap.files[0].path.clone()];
        assert!(blocks_page(&mut snap, &p).unwrap()["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["reason"] == "denied"));
    }
    #[test]
    fn blocks_paginate_once_and_cursor_cannot_change_file_set() {
        let (_dir, mut snap) = fixture();
        let mut p = request(&snap);
        p.max_bytes = Some(32);
        let mut all = HashSet::new();
        let mut pages = 0;
        loop {
            let result = blocks_page(&mut snap, &p).unwrap();
            for u in result["units"].as_array().unwrap() {
                assert!(all.insert(u["blockKey"].as_str().unwrap().to_string()));
            }
            pages += 1;
            if let Some(next) = result["nextCursor"].as_str() {
                p.cursor = Some(next.into());
                if pages == 1 {
                    let mut bad = p.clone();
                    bad.file_keys.reverse();
                    assert!(blocks_page(&mut snap, &bad)
                        .unwrap_err()
                        .contains("INVALID_CURSOR"));
                }
            } else {
                break;
            }
            assert!(pages < 20);
        }
        assert!(pages > 1);
        assert_eq!(
            all.len(),
            snap.files.iter().map(|f| f.units.len()).sum::<usize>()
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlink_replacement_never_returns_outside_source() {
        let (dir, mut snap) = fixture();
        let p = request(&snap);
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), "OUTSIDE PRIVATE DATA").unwrap();
        let path = dir.path().join(&snap.files[0].path);
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(outside.path(), path).unwrap();
        let result = blocks_page(&mut snap, &p).unwrap();
        assert!(!result.to_string().contains("OUTSIDE PRIVATE"));
        assert!(result["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["reason"] == "denied"));
    }
    #[test]
    fn stale_sources_are_excluded_when_index_has_not_caught_up() {
        let (dir, snap) = fixture();
        std::fs::write(
            dir.path().join(&snap.files[0].path),
            "A different length of content",
        )
        .unwrap();
        let rebuilt = build_snapshot(
            "fixture.plugin",
            snap.context,
            snap.range,
            snap.as_of,
            Capture {
                files: snap.files,
                indexed: 2,
                undated: 0,
                generation: "same-index".into(),
            },
        )
        .unwrap();
        assert_eq!(rebuilt.coverage["stale"], 1);
        assert_eq!(rebuilt.files.len(), 1);
    }
    #[test]
    fn cached_snapshots_bind_plugin_vault_config_expiry_and_revocation() {
        let (_dir, mut snap) = fixture();
        snap.plugin = format!("test.index.{}", uuid::Uuid::new_v4());
        let id = snap.id.clone();
        let plugin = snap.plugin.clone();
        let context = snap.context.clone();
        let entry = insert(snap);
        assert!(lookup(&id, &plugin, &context).is_ok());
        assert!(lookup(&id, "another.plugin", &context).is_err());
        let mut changed = context.clone();
        changed.config = "different".into();
        assert!(lookup(&id, &plugin, &changed).is_err());
        changed = context.clone();
        changed.root = PathBuf::from("/another-vault");
        assert!(lookup(&id, &plugin, &changed).is_err());
        entry.lock().unwrap().created = Instant::now() - TTL - Duration::from_secs(1);
        assert!(lookup(&id, &plugin, &context).is_err());
        entry.lock().unwrap().created = Instant::now();
        invalidate_plugin(&plugin);
        assert!(lookup(&id, &plugin, &context).is_err());
    }
}
