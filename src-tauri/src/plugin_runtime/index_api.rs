//! Bounded, ephemeral index snapshots. A frozen snapshot freezes data, never
//! authorization. Both process RPC and plugin-window RPC use this adapter.
use plugin_protocol::{IndexBlocksParams, IndexRange, IndexSnapshotParams, IndexStatusParams};
use searchidx::{
    query::Weights,
    snapshot::{Capture, File, UnitRef},
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
const MAX_CACHE_BYTES: usize = 256 * 1024 * 1024;
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
    let skipped = capture
        .files
        .iter()
        .filter(|f| f.priority_basis.is_none())
        .count();
    let coverage = json!({"indexed":capture.indexed,"selected":capture.files.len(),"stale":stale,"excluded":excluded,"undated":capture.undated,"skipped":skipped});
    let retained = serde_json::to_vec(&capture.files).unwrap().len() + capture.files.len() * 32; // fixed per-file unit fingerprint
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
fn blocks_page(
    snap: &mut Snapshot,
    p: &IndexBlocksParams,
    read_units: &mut impl FnMut(&File) -> Result<Vec<UnitRef>, String>,
) -> Result<Value, String> {
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
        // Load only this requested file after verifying its frozen source hash.
        // The index also checks the frozen unit fingerprint before serving it.
        let file_units = match read_units(file) {
            Ok(units) => units,
            Err(error)
                if error.starts_with("SNAPSHOT_STALE") || error.starts_with("SNAPSHOT_LIMIT") =>
            {
                let reason = if error.starts_with("SNAPSHOT_LIMIT") {
                    "too_large"
                } else {
                    "changed"
                };
                conflicts.push(json!({"fileKey":file.file_key,"reason":reason}));
                cursor.file += 1;
                cursor.unit = 0;
                continue;
            }
            Err(error) => return Err(error),
        };
        let lines: Vec<_> = text.split('\n').collect();
        while cursor.unit < file_units.len() {
            let unit = &file_units[cursor.unit];
            let Some(slice) = lines.get(unit.line_start as usize - 1..unit.line_end as usize)
            else {
                conflicts.push(json!({"fileKey":file.file_key,"reason":"changed"}));
                cursor.unit = file_units.len();
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

// Both metadata and lazy units use the same index handle and Vault checks.
// A block page releases the index lock after each file, before reading the next.
fn with_index<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    ctx: &Context,
    action: impl FnOnce(&mut SearchIndex) -> Result<T, String>,
) -> Result<T, String> {
    if let Some(handle) = app.try_state::<crate::search::IndexHandle>() {
        let mut guard = crate::search::lock(handle.inner());
        let index = guard
            .as_mut()
            .ok_or("INDEX_NOT_READY: initial build or rebuild in progress")?;
        if index.vault_root().canonicalize().ok().as_ref() != Some(&ctx.root) {
            return Err("INDEX_NOT_READY: vault changed".into());
        }
        action(index)
    } else {
        // Read-only CLI access never creates or rebuilds an index.
        let db = searchidx::paths::index_db_path(&ctx.root).ok_or("INDEX_NOT_READY")?;
        let mut index =
            SearchIndex::open_existing_at(&ctx.root, &db, &ctx.opts.source_globs.stamp())?;
        action(&mut index)
    }
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
                let capture = with_index(app, &ctx, |index| {
                    index.capture_metadata(from, to, &as_of, &ctx.weights)
                })?;
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
            let as_of = snap.as_of.clone();
            blocks_page(&mut snap, &p, &mut |file| {
                with_index(app, &ctx, |index| {
                    index.capture_file_units(file, &as_of, &ctx.weights)
                })
            })?
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

/// A captured source set is an analysis boundary, not a replacement for the
/// plugin's live vault.read/write grants. The caller retains those grants.
pub(crate) struct KnowledgeCapture {
    root: PathBuf,
    config: String,
    id: String,
    plugin: String,
    epoch: u64,
}

impl KnowledgeCapture {
    pub(crate) fn recheck<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        graph: &habitat_core::Snapshot,
    ) -> Result<(), String> {
        let ctx = context(app)?;
        if EPOCH.load(Ordering::SeqCst) != self.epoch
            || ctx.root != self.root
            || ctx.config != self.config
        {
            return Err("KNOWLEDGE_CAPTURE_CHANGED: Vault or analysis settings changed".into());
        }
        let entry = lookup(&self.id, &self.plugin, &ctx)?;
        let captured = entry.lock().unwrap_or_else(|p| p.into_inner());
        validate_captured_knowledge(&ctx, &captured, graph)
    }
}

fn validate_captured_knowledge(
    ctx: &Context,
    captured: &Snapshot,
    graph: &habitat_core::Snapshot,
) -> Result<(), String> {
    if captured.range.is_some() {
        return Err("KNOWLEDGE_CAPTURE_SCOPE: HABITAT requires an atlas capture".into());
    }
    if captured.coverage["stale"].as_u64() != Some(0) {
        return Err(
            "KNOWLEDGE_CAPTURE_STALE: 索引尚未完成更新，请等待索引完成后重试；不保存缺少来源的版本"
                .into(),
        );
    }
    validate_knowledge_sources(ctx, &captured.files, graph)
}

pub(crate) fn validate_knowledge_capture<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin: &str,
    id: &str,
    graph: &habitat_core::Snapshot,
) -> Result<KnowledgeCapture, String> {
    if !authorized(plugin) {
        return Err("CAPABILITY_DENIED: index.read revoked".into());
    }
    let epoch = EPOCH.load(Ordering::SeqCst);
    let ctx = context(app)?;
    let lease = KnowledgeCapture {
        root: ctx.root,
        config: ctx.config,
        id: id.into(),
        plugin: plugin.into(),
        epoch,
    };
    lease.recheck(app, graph)?;
    Ok(lease)
}

/// A controlled pending draft may outlive its ephemeral index ID. Recovery
/// keeps its captured source hashes but requires the original analysis policy.
pub(crate) fn validate_knowledge_recovery<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
    graph: &habitat_core::Snapshot,
) -> Result<(), String> {
    let ctx = context(app)?;
    if ctx.root != root {
        return Err("KNOWLEDGE_CAPTURE_CHANGED: Vault changed".into());
    }
    let (meetings_root, configs) = knowledge_configuration(&ctx)?;
    if knowledge_scope_hash(&ctx.config, &meetings_root)? != graph.meta.scope_hash {
        return Err(
            "KNOWLEDGE_CAPTURE_CHANGED: archive this draft and capture the new analysis scope"
                .into(),
        );
    }
    if configs
        .keys()
        .any(|path| !graph.sources.iter().any(|source| &source.path == path))
    {
        return Err("KNOWLEDGE_CAPTURE_CHANGED: configuration was added after capture".into());
    }
    for source in &graph.sources {
        let config = configs.get(&source.path);
        if let Some(expected) = config {
            if expected != &source.hash {
                return Err("KNOWLEDGE_CAPTURE_CHANGED: configuration changed".into());
            }
        } else if !knowledge_eligible(&source.path)
            || (!searchidx::scan::is_indexable(&source.path, &ctx.opts)
                && !knowledge_supplement(&source.path, &meetings_root, &ctx.opts))
        {
            return Err(
                "KNOWLEDGE_CAPTURE_SCOPE: source is outside the current analysis scope".into(),
            );
        }
    }
    Ok(())
}

fn knowledge_eligible(path: &str) -> bool {
    habitat_core::codec::safe_source_path(path)
        && !path.starts_with(".notemd/")
        && !path.starts_with(".local/")
        && !matches!(path, "USER.md" | "MEMORY.md" | "AGENTS.md" | "CLAUDE.md")
        && !path.split('/').any(|p| {
            matches!(
                p,
                ".local" | "node_modules" | ".ssh" | ".aws" | ".credentials"
            )
        })
}

fn knowledge_excluded(path: &str, opts: &ScanOptions) -> bool {
    opts.exclude_dirs.iter().any(|dir| {
        let dir = dir.trim_matches('/');
        !dir.is_empty() && (path == dir || path.starts_with(&format!("{dir}/")))
    })
}

fn knowledge_supplement(path: &str, meetings_root: &str, opts: &ScanOptions) -> bool {
    knowledge_eligible(path)
        && !knowledge_excluded(path, opts)
        && path.starts_with(&format!("{meetings_root}/"))
        && path.ends_with("/knowledge.json")
}

fn knowledge_scope_hash(config: &str, meetings_root: &str) -> Result<String, String> {
    Ok(habitat_core::hash(serde_json::to_vec(&json!({"policy":"habitat-capture/1",
        "indexConfig":config,"meetingsRoot":meetings_root,
        "excluded":[".notemd/* except settings/meetings","USER.md","MEMORY.md","AGENTS.md","CLAUDE.md","private runtime"]}))
        .map_err(|e| e.to_string())?))
}

fn knowledge_configuration(
    ctx: &Context,
) -> Result<(String, std::collections::BTreeMap<String, String>), String> {
    let mut root = "ssot/meetings".to_owned();
    let mut configs = std::collections::BTreeMap::new();
    for path in [".notemd/settings.json", ".notemd/meetings.json"] {
        let file = match open_source(&ctx.root, path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(
                    "KNOWLEDGE_CAPTURE_SCOPE: configuration is unavailable or symlinked".into(),
                )
            }
        };
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 1024 * 1024 {
            return Err("KNOWLEDGE_CAPTURE_SCOPE: configuration exceeds budget".into());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "KNOWLEDGE_CAPTURE_SCOPE: invalid configuration")?;
        if path.ends_with("meetings.json") {
            if let Some(value) = value["meetings_root"].as_str() {
                root = value.trim_matches('/').to_owned();
            }
        }
        configs.insert(path.to_owned(), habitat_core::hash(bytes));
    }
    if !knowledge_eligible(&root) || root == "." {
        return Err("KNOWLEDGE_CAPTURE_SCOPE: invalid meetings root".into());
    }
    Ok((root, configs))
}

fn knowledge_supplement_paths(
    ctx: &Context,
    meetings_root: &str,
) -> Result<HashSet<String>, String> {
    let mut paths = HashSet::new();
    let mut queue = std::collections::VecDeque::from([(meetings_root.to_owned(), 0usize)]);
    let mut visited = 0;
    while let Some((relative, depth)) = queue.pop_front() {
        if knowledge_excluded(&relative, &ctx.opts) {
            continue;
        }
        visited += 1;
        if visited > 10_000 || depth > 12 {
            return Err(
                "KNOWLEDGE_CAPTURE_SCOPE: meetings directory exceeds capture budget".into(),
            );
        }
        let mut path = ctx.root.clone();
        let mut absent = false;
        for part in Path::new(&relative).components() {
            let Component::Normal(part) = part else {
                return Err("KNOWLEDGE_CAPTURE_SCOPE: invalid supplemental path".into());
            };
            path.push(part);
            match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err("KNOWLEDGE_CAPTURE_SCOPE: symlinked meetings path".into())
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    absent = true;
                    break;
                }
                Err(e) => return Err(format!("KNOWLEDGE_CAPTURE_SCOPE: {e}")),
            }
        }
        if absent {
            continue;
        }
        for entry in std::fs::read_dir(path).map_err(|e| format!("KNOWLEDGE_CAPTURE_SCOPE: {e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "KNOWLEDGE_CAPTURE_SCOPE: non-UTF8 source path")?;
            let child = format!("{relative}/{name}");
            if !knowledge_eligible(&child) || knowledge_excluded(&child, &ctx.opts) {
                continue;
            }
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                queue.push_back((child, depth + 1));
            } else if kind.is_file() && name == "knowledge.json" {
                paths.insert(child);
            }
        }
    }
    Ok(paths)
}

fn validate_knowledge_sources(
    ctx: &Context,
    captured: &[File],
    graph: &habitat_core::Snapshot,
) -> Result<(), String> {
    let (meetings_root, configs) = knowledge_configuration(ctx)?;
    if knowledge_scope_hash(&ctx.config, &meetings_root)? != graph.meta.scope_hash {
        return Err(
            "KNOWLEDGE_CAPTURE_SCOPE: submitted scope does not match capture/configuration".into(),
        );
    }
    let expected: HashMap<_, _> = captured
        .iter()
        .filter(|f| knowledge_eligible(&f.path))
        .map(|f| (f.path.as_str(), f.content_hash.as_str()))
        .collect();
    let supplements = knowledge_supplement_paths(ctx, &meetings_root)?;
    let mut supplied = HashSet::new();
    let mut supplement_bytes = 0;
    for source in &graph.sources {
        if !matches!(source.status.as_str(), "available" | "unavailable") {
            return Err("KNOWLEDGE_CAPTURE_SCOPE: unsupported source availability".into());
        }
        if !supplied.insert(source.path.as_str()) {
            return Err("KNOWLEDGE_CAPTURE_SCOPE: duplicate source path".into());
        }
        if let Some(hash) = expected.get(source.path.as_str()) {
            if *hash != source.hash {
                return Err(
                    "KNOWLEDGE_CAPTURE_SCOPE: indexed source hash differs from capture".into(),
                );
            }
            if !searchidx::scan::is_indexable(&source.path, &ctx.opts) {
                return Err(
                    "KNOWLEDGE_CAPTURE_SCOPE: indexed source is outside current analysis scope"
                        .into(),
                );
            }
        } else if let Some(hash) = configs.get(&source.path) {
            if hash != &source.hash {
                return Err("KNOWLEDGE_CAPTURE_CHANGED: configuration changed".into());
            }
        } else if !supplements.contains(&source.path)
            || !knowledge_supplement(&source.path, &meetings_root, &ctx.opts)
        {
            return Err("KNOWLEDGE_CAPTURE_SCOPE: submitted source was not captured".into());
        } else {
            // Supplements are prefetched raw inputs, including when parsing failed.
            // Their hash must not be invented by marking them unavailable.
            let file = open_source(&ctx.root, &source.path)
                .map_err(|_| "KNOWLEDGE_CAPTURE_CHANGED: supplemental source unavailable")?;
            let remaining = 96 * 1024 * 1024 - supplement_bytes;
            let mut bytes = Vec::new();
            file.take(remaining as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            supplement_bytes += bytes.len();
            if supplement_bytes > 96 * 1024 * 1024 || habitat_core::hash(&bytes) != source.hash {
                return Err(
                    "KNOWLEDGE_CAPTURE_CHANGED: supplemental content changed or exceeds budget"
                        .into(),
                );
            }
        }
    }
    if expected.keys().any(|path| !supplied.contains(path))
        || configs.keys().any(|path| !supplied.contains(path.as_str()))
        || supplements
            .iter()
            .any(|path| !supplied.contains(path.as_str()))
    {
        return Err("KNOWLEDGE_CAPTURE_SCOPE: incomplete source manifest; record unavailable inputs instead of dropping them".into());
    }
    Ok(())
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
    fn fixture_units(snap: &Snapshot, file: &File) -> Vec<UnitRef> {
        let mut index = SearchIndex::open_existing_at(
            &snap.context.root,
            &snap.context.root.join(".index.db"),
            "",
        )
        .unwrap();
        index
            .capture_file_units(file, &snap.as_of, &snap.context.weights)
            .unwrap()
    }
    fn read_blocks(snap: &mut Snapshot, p: &IndexBlocksParams) -> Result<Value, String> {
        let mut index = SearchIndex::open_existing_at(
            &snap.context.root,
            &snap.context.root.join(".index.db"),
            "",
        )?;
        let as_of = snap.as_of.clone();
        let weights = snap.context.weights;
        blocks_page(snap, p, &mut |file| {
            index.capture_file_units(file, &as_of, &weights)
        })
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
    fn lightweight_snapshot_loads_only_requested_file_and_reports_lazy_conflicts() {
        let (_dir, mut snap) = fixture();
        assert_eq!(snap.coverage["skipped"], 0);
        let mut p = request(&snap);
        p.file_keys.truncate(1);
        let selected = snap.files[0].clone();
        let expected = fixture_units(&snap, &selected);
        let mut calls = 0;
        let result = blocks_page(&mut snap, &p, &mut |file| {
            calls += 1;
            assert_eq!(file.file_key, selected.file_key);
            Ok(expected.clone())
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(result["units"].as_array().unwrap().len(), expected.len());
        for (error, reason) in [
            ("SNAPSHOT_STALE: unit fingerprint changed", "changed"),
            ("SNAPSHOT_LIMIT: file units exceed budget", "too_large"),
        ] {
            let result = blocks_page(&mut snap, &p, &mut |_| Err(error.into())).unwrap();
            assert!(result["units"].as_array().unwrap().is_empty());
            assert_eq!(result["conflicts"][0]["reason"], reason);
        }
        assert!(blocks_page(&mut snap, &p, &mut |_| Err("INDEX_NOT_READY".into())).is_err());
        snap.range = None;
        assert!(blocks_page(&mut snap, &p, &mut |_| panic!("atlas must not load units")).is_err());
    }
    #[test]
    fn source_is_exact_inclusive_cr_normalized_and_hash_checked() {
        let (dir, mut snap) = fixture();
        let p = request(&snap);
        let result = read_blocks(&mut snap, &p).unwrap();
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
        let result = read_blocks(&mut snap, &p).unwrap();
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
        assert!(read_blocks(&mut snap, &p)
            .unwrap_err()
            .contains("atlas_metadata"));
        snap.range = Some(IndexRange {
            from: "2026-09-01".into(),
            to: "2026-09-30".into(),
            date_kind: "doc_date".into(),
        });
        p.file_keys = vec!["fabricated".into()];
        assert!(read_blocks(&mut snap, &p)
            .unwrap_err()
            .contains("outside snapshot"));
        p = request(&snap);
        snap.served = TOTAL_BYTES;
        assert!(read_blocks(&mut snap, &p).unwrap_err().contains("BUDGET"));
        snap.served = 0;
        snap.context.opts.exclude_dirs = vec![snap.files[0].path.clone()];
        assert!(read_blocks(&mut snap, &p).unwrap()["conflicts"]
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
            let result = read_blocks(&mut snap, &p).unwrap();
            for u in result["units"].as_array().unwrap() {
                assert!(all.insert(u["blockKey"].as_str().unwrap().to_string()));
            }
            pages += 1;
            if let Some(next) = result["nextCursor"].as_str() {
                p.cursor = Some(next.into());
                if pages == 1 {
                    let mut bad = p.clone();
                    bad.file_keys.reverse();
                    assert!(read_blocks(&mut snap, &bad)
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
            snap.files
                .iter()
                .map(|f| fixture_units(&snap, f).len())
                .sum::<usize>()
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
        let result = read_blocks(&mut snap, &p).unwrap();
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

#[cfg(test)]
mod knowledge_capture_tests {
    use super::*;
    use habitat_core::{Snapshot as Graph, Source};

    fn fixture() -> (tempfile::TempDir, Context) {
        let temp = tempfile::tempdir().unwrap();
        let ctx = Context {
            root: temp.path().canonicalize().unwrap(),
            config: "captured-config".into(),
            opts: ScanOptions::default(),
            weights: Weights::default(),
        };
        (temp, ctx)
    }
    fn source(path: &str, body: &str) -> Source {
        Source {
            id: path.into(),
            path: path.into(),
            hash: habitat_core::hash(body),
            status: "available".into(),
            family: path.into(),
            ..Default::default()
        }
    }
    fn indexed(source: &Source) -> File {
        File {
            path: source.path.clone(),
            content_hash: source.hash.clone(),
            file_key: source.id.clone(),
            title: None,
            concept_type: None,
            tags: vec![],
            doc_date: None,
            date_inferred: false,
            index_origin: "authored".into(),
            human_verified: false,
            confidentiality: "default".into(),
            attention_minutes: 0.,
            links: vec![],
            file_priority: 0.,
            priority_basis: None,
            unit_fingerprint: [0; 32],
            mtime: 0,
            size: 0,
        }
    }
    fn graph(ctx: &Context, sources: Vec<Source>) -> Graph {
        let mut graph = Graph::default();
        graph.meta.scope_hash = knowledge_scope_hash(&ctx.config, "ssot/meetings").unwrap();
        graph.sources = sources;
        graph
    }
    #[test]
    fn manifest_is_exactly_bound_to_captured_paths_and_hashes() {
        let (_temp, ctx) = fixture();
        let s = source("notes/a.md", "captured");
        let files = vec![indexed(&s)];
        let mut g = graph(&ctx, vec![s]);
        assert!(validate_knowledge_sources(&ctx, &files, &g).is_ok());
        // Missing bodies remain part of capture, with their original hash.
        g.sources[0].status = "unavailable".into();
        assert!(validate_knowledge_sources(&ctx, &files, &g).is_ok());
        g.sources[0].hash = habitat_core::hash("invented");
        assert!(validate_knowledge_sources(&ctx, &files, &g).is_err());
        g.sources[0].hash = files[0].content_hash.clone();
        g.sources.push(source("notes/uncaptured.md", "outside"));
        assert!(validate_knowledge_sources(&ctx, &files, &g).is_err());
        g.sources.clear();
        assert!(validate_knowledge_sources(&ctx, &files, &g).is_err());
    }
    #[test]
    fn supplements_respect_configured_root_exclusions_and_raw_hash() {
        let (_temp, mut ctx) = fixture();
        std::fs::create_dir_all(ctx.root.join("ssot/meetings/a")).unwrap();
        let path = "ssot/meetings/a/knowledge.json";
        std::fs::write(ctx.root.join(path), "{}").unwrap();
        let mut g = graph(&ctx, vec![source(path, "{}")]);
        assert!(validate_knowledge_sources(&ctx, &[], &g).is_ok());
        g.sources[0].status = "unavailable".into();
        g.sources[0].hash = habitat_core::hash("fabricated");
        assert!(validate_knowledge_sources(&ctx, &[], &g).is_err());
        g.sources[0].hash = habitat_core::hash("{}");
        ctx.opts.exclude_dirs.push("ssot/meetings/a".into());
        assert!(validate_knowledge_sources(&ctx, &[], &g).is_err());
        g.sources.clear();
        assert!(validate_knowledge_sources(&ctx, &[], &g).is_ok());
        ctx.opts.exclude_dirs.clear();
        assert!(validate_knowledge_sources(&ctx, &[], &g).is_err());
    }
    #[test]
    fn configuration_is_mandatory_and_changes_invalidate_capture() {
        let (_temp, ctx) = fixture();
        std::fs::create_dir(ctx.root.join(".notemd")).unwrap();
        std::fs::write(ctx.root.join(".notemd/settings.json"), "{}").unwrap();
        let mut g = graph(&ctx, vec![source(".notemd/settings.json", "{}")]);
        assert!(validate_knowledge_sources(&ctx, &[], &g).is_ok());
        std::fs::write(ctx.root.join(".notemd/settings.json"), "{\"other\":1}").unwrap();
        assert!(validate_knowledge_sources(&ctx, &[], &g).is_err());
        g.sources.clear();
        assert!(validate_knowledge_sources(&ctx, &[], &g).is_err());
    }
    #[test]
    fn policy_matches_backend_and_does_not_reintroduce_private_runtime() {
        assert_eq!(knowledge_scope_hash("config", "meetings").unwrap(), habitat_core::hash(
            serde_json::to_vec(&json!({"policy":"habitat-capture/1","indexConfig":"config","meetingsRoot":"meetings",
            "excluded":[".notemd/* except settings/meetings","USER.md","MEMORY.md","AGENTS.md","CLAUDE.md","private runtime"]})).unwrap()));
        for path in [
            "USER.md",
            "MEMORY.md",
            "AGENTS.md",
            "CLAUDE.md",
            ".notemd/settings.json",
            "notes/.credentials/token.md",
            "notes/.local/a.md",
        ] {
            assert!(!knowledge_eligible(path), "{path}");
        }
        assert!(knowledge_eligible("notes/USER.md"));
    }
    #[test]
    fn index_lag_cannot_publish_a_smaller_source_manifest() {
        let (_temp, ctx) = fixture();
        let source = source("note.md", "old body");
        std::fs::write(ctx.root.join(&source.path), "old body").unwrap();
        let mut file = indexed(&source);
        let metadata = std::fs::metadata(ctx.root.join(&source.path)).unwrap();
        file.size = metadata.len();
        file.mtime = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        // A legitimate edit happened before the index watcher updated its row.
        std::fs::write(
            ctx.root.join(&source.path),
            "changed body with a different size",
        )
        .unwrap();
        let captured = build_snapshot(
            "notemd.habitat",
            ctx.clone(),
            None,
            "2026-09-30".into(),
            Capture {
                files: vec![file],
                indexed: 1,
                undated: 1,
                generation: "old-index".into(),
            },
        )
        .unwrap();
        assert_eq!(captured.coverage["stale"], 1);
        assert!(captured.files.is_empty());
        let reduced = graph(&ctx, vec![]);
        // Exact matching to the filtered files alone would wrongly pass.
        assert!(validate_knowledge_sources(&ctx, &captured.files, &reduced).is_ok());
        assert!(validate_captured_knowledge(&ctx, &captured, &reduced)
            .unwrap_err()
            .contains("KNOWLEDGE_CAPTURE_STALE"));
    }
}
