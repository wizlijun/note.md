//! Host-owned project mirrors, immutable publication baselines and local review.
use crate::sotvault::{
    logic::sha256_hex,
    mirror_meta,
    store::{self, Record},
    vault_settings,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_BYTES: usize = 25 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    #[serde(rename = "project_id")]
    pub project_id: String,
    pub source_root: String,
    pub mirror_root: String,
    pub entry: String,
    pub files: Vec<String>,
    pub published_snapshot_id: Option<String>,
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_available: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleting: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    pub hash: String,
    pub bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub schema_version: u32,
    #[serde(rename = "project_id")]
    pub project_id: String,
    pub snapshot_id: String,
    pub entry: String,
    pub files: Vec<ProjectFile>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub path: String,
    pub base_hash: String,
    pub after_markdown: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub path: String,
    pub quote: String,
    pub comment: String,
    pub start: Option<usize>,
    pub end: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFeedback {
    pub schema_version: u32,
    #[serde(rename = "project_id")]
    pub project_id: String,
    pub snapshot_id: String,
    pub submission_id: String,
    pub edits: Vec<Edit>,
    pub annotations: Vec<Annotation>,
    pub name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackEnvelope {
    pub payload: ProjectFeedback,
    pub request_hash: String,
    pub received_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    #[serde(default)]
    pub mirrors: BTreeMap<String, crate::sotvault::MirrorRefresh>,
    pub status: String,
    pub before_hash: Option<String>,
    pub result_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalFeedback {
    pub envelope: FeedbackEnvelope,
    pub status: String,
    pub error: Option<String>,
    pub decisions: BTreeMap<String, Decision>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    pub source_path: String,
    pub base: String,
    pub current: String,
    pub after: String,
    pub current_hash: String,
    pub status: String,
}
#[derive(Debug, Serialize)]
pub struct MirrorView {
    pub source: ProjectFile,
    pub mirror: ProjectFile,
}
#[derive(Clone, Serialize, Deserialize)]
struct Binding {
    project_id: String,
    source_root: String,
    mirror_root: String,
    #[serde(default)]
    deleting: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deletion_files: Option<BTreeMap<String, String>>,
    #[serde(default)]
    deletion_requires_stop: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(rename = "project_id")]
    project_id: String,
    entry: String,
    files: Vec<String>,
    published_snapshot_id: Option<String>,
    url: Option<String>,
}

pub fn validate_relative(path: &str) -> Result<()> {
    if path.is_empty()
        || path.contains('\\')
        || path.contains(':')
        || path.contains('\0')
        || path.starts_with('/')
    {
        return Err(format!("unsafe relative path: {path}"));
    }
    for part in path.split('/') {
        let lower = part.to_lowercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.starts_with('.')
            || lower == "node_modules"
            || lower.ends_with(".note.md")
            || lower.ends_with(".notes.md")
            || matches!(
                lower.as_str(),
                "credentials" | "credentials.json" | "id_rsa" | "id_ed25519"
            )
            || lower.ends_with(".pem")
            || lower.ends_with(".key")
        {
            return Err(format!("reserved or unsafe path: {path}"));
        }
    }
    Ok(())
}
fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("invalid identifier".into());
    }
    Ok(())
}
fn is_md(path: &str) -> bool {
    [".md", ".markdown", ".mdown", ".mkd", ".mdx"]
        .iter()
        .any(|e| path.to_lowercase().ends_with(e))
}
fn io_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound { format!("NOT_FOUND: {error}") }
    else { format!("UNREADABLE: {error}") }
}
fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    if std::fs::metadata(path).map_err(io_error)?.len() > MAX_BYTES as u64 {
        return Err("TOO_LARGE: file exceeds 25 MiB".into());
    }
    std::fs::read(path).map_err(io_error)
}
fn safe_source(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_relative(relative)?;
    let requested = root.join(relative);
    for ancestor in requested.ancestors().take_while(|p| *p != root) {
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = ancestor.canonicalize().map_err(|e| format!("UNSAFE_PATH: unresolved symlink: {e}"))?;
                if !target.starts_with(root) { return Err("UNSAFE_PATH: source symlink escapes root".into()); }
                let rel = target.strip_prefix(root).map_err(|e| e.to_string())?;
                validate_relative(rel.to_str().ok_or("invalid UTF-8 source path")?)?;
            }
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(io_error(e)),
        }
    }
    let p = root
        .join(relative)
        .canonicalize()
        .map_err(io_error)?;
    if !p.starts_with(root) || !p.is_file() {
        return Err("source escapes project root or is not a file".into());
    }
    let actual = p.strip_prefix(root).map_err(|e| e.to_string())?;
    validate_relative(actual.to_str().ok_or("invalid UTF-8 source path")?)?;
    Ok(p)
}
/// Reject symlinks on every destination ancestor, including management directories.
fn safe_destination(root: &Path, relative: &Path) -> Result<PathBuf> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("unsafe destination".into());
    }
    let mut p = root.to_path_buf();
    for component in relative.components() {
        p.push(component);
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.file_type().is_symlink() => return Err("symlink in mirror path".into()),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(p)
}
/// Remove only the files authorized by the durable deletion reservation.
/// A new file appearing after preflight keeps its directory nonempty and stops
/// cleanup; recursive deletion must never consume concurrent user work.
fn remove_reserved_tree(root: &Path, files: &BTreeMap<String, String>) -> Result<()> {
    let mut directories = HashSet::new();
    directories.insert(root.to_path_buf());
    for (relative, expected) in files {
        let path = safe_destination(root, Path::new(relative))?;
        for directory in path.ancestors().skip(1).take_while(|p| p.starts_with(root)) {
            directories.insert(directory.to_path_buf());
        }
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => return Err(format!("unsafe deletion file: {}", path.display())),
            Ok(_) => {},
        }
        if sha256_hex(&std::fs::read(&path).map_err(io_error)?) != *expected {
            return Err(format!("managed file changed during deletion: {}", path.display()));
        }
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    let mut directories: Vec<_> = directories.into_iter().collect();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        match std::fs::remove_dir(&directory) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(format!("directory contains unremoved content; preserve before retry: {}: {error}", directory.display())),
        }
    }
    Ok(())
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("missing parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        // Preserve existing file permissions when replacing a source file.
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.permissions().readonly() {
                return Err("file is read-only".into());
            }
            std::fs::set_permissions(&temp, meta.permissions()).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&temp, path).map_err(|e| e.to_string())?;
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    write_atomic(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
fn source_modified_at(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok()?.modified().ok()?
        .duration_since(std::time::UNIX_EPOCH).ok()?.as_millis().try_into().ok()
}
fn make_file(path: &str, bytes: Vec<u8>, modified_at: Option<u64>) -> Result<ProjectFile> {
    let hash = sha256_hex(&bytes);
    let size = bytes.len();
    let (markdown, data_url) = if is_md(path) {
        (
            Some(String::from_utf8(bytes).map_err(|_| "Markdown is not UTF-8")?),
            None,
        )
    } else {
        (
            None,
            Some(format!("data:{};base64,{}", mime(path), base64(&bytes))),
        )
    };
    Ok(ProjectFile {
        path: path.into(),
        hash,
        bytes: size,
        modified_at,
        markdown,
        data_url,
    })
}
fn mime(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}
fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as usize) << 16
            | (*chunk.get(1).unwrap_or(&0) as usize) << 8
            | *chunk.get(2).unwrap_or(&0) as usize;
        for i in 0..4 {
            out.push(if i > chunk.len() {
                '='
            } else {
                ABC[(n >> (18 - i * 6)) & 63] as char
            });
        }
    }
    out
}

pub struct ProjectStore {
    vault: PathBuf,
    state: PathBuf,
}
impl ProjectStore {
    pub fn new(vault: PathBuf, state: PathBuf) -> Self {
        Self { vault, state }
    }
    fn bindings_path(&self) -> PathBuf {
        self.state.join("project-share-bindings.json")
    }
    fn bindings(&self) -> Result<Vec<Binding>> {
        if !self.bindings_path().exists() {
            return Ok(vec![]);
        }
        read_json(&self.bindings_path())
    }
    fn binding(&self, id: &str) -> Result<Binding> {
        valid_id(id)?;
        let entries: Vec<serde_json::Value> = read_json(&self.bindings_path())?;
        let entry = entries.into_iter().find(|v| v.get("project_id").and_then(|v| v.as_str()) == Some(id))
            .ok_or("project binding missing; rebind required")?;
        let b: Binding = serde_json::from_value(entry).map_err(|e| e.to_string())?;
        self.validate_binding(&b)?;
        Ok(b)
    }
    fn validate_binding(&self, b: &Binding) -> Result<()> {
        valid_id(&b.project_id)?;
        let expected = self
            .vault
            .join(vault_settings::resolve_sync_dir(&self.vault))
            .join(&b.project_id);
        if Path::new(&b.mirror_root) != expected {
            return Err("project location changed; rebind required".into());
        }
        let relative = expected
            .strip_prefix(&self.vault)
            .map_err(|e| e.to_string())?;
        safe_destination(&self.vault, relative)?;
        Ok(())
    }
    fn management(&self, b: &Binding, rel: &str) -> Result<PathBuf> {
        safe_destination(
            &self.vault,
            &Path::new(&b.mirror_root)
                .strip_prefix(&self.vault)
                .map_err(|e| e.to_string())?
                .join(".notemd")
                .join(rel),
        )
    }
    fn config(&self, b: &Binding) -> Result<Config> {
        let config: Config = read_json(&self.management(b, "project.json")?)?;
        if config.project_id != b.project_id { return Err("project mirror identity mismatch".into()); }
        validate_relative(&config.entry)?;
        Ok(config)
    }
    fn info(&self, b: &Binding) -> Result<ProjectInfo> {
        let c = self.config(b)?;
        Ok(ProjectInfo {
            project_id: b.project_id.clone(),
            source_root: b.source_root.clone(),
            mirror_root: b.mirror_root.clone(),
            entry: c.entry.clone(),
            files: c.files,
            published_snapshot_id: c.published_snapshot_id,
            url: c.url,
            source_available: Some(self.source_root(&b.source_root).and_then(|root| self.source_path(&root, &c.entry)).is_ok()),
            deleting: Some(b.deleting),
            error: None,
        })
    }
    fn source_root(&self, source: &str) -> Result<PathBuf> {
        let source = Path::new(source).canonicalize().map_err(|e| e.to_string())?;
        let vault = self.vault.canonicalize().map_err(|e| e.to_string())?;
        if !source.is_dir() || (source != vault && vault.starts_with(&source)) {
            return Err("project root must be a directory and cannot contain the Vault".into());
        }
        if let Ok(relative) = source.strip_prefix(&vault) {
            if !relative.as_os_str().is_empty() { validate_relative(relative.to_str().ok_or("invalid UTF-8 project root")?)?; }
            let sync_root = vault.join(vault_settings::resolve_sync_dir(&vault));
            if source.starts_with(&sync_root) || (source != vault && sync_root.starts_with(&source)) {
                return Err("project source and Sync mirror directories cannot overlap".into());
            }
        }
        Ok(source)
    }
    fn lock(&self) -> Result<store::RecordsLock> {
        store::lock_records(&self.records_path()).map_err(|e| e.to_string())
    }
    fn active(&self, b: &Binding) -> Result<()> {
        if b.deleting { return Err("project deletion in progress".into()); }
        Ok(())
    }
    fn source_path(&self, root: &Path, relative: &str) -> Result<PathBuf> {
        validate_relative(relative)?;
        self.source_root(root.to_str().ok_or("invalid UTF-8 source root")?)?;
        let vault = self.vault.canonicalize().map_err(io_error)?;
        let sync = vault.join(vault_settings::resolve_sync_dir(&vault));
        // Check the requested path before resolving it: an absent Sync target is unsafe too.
        let requested = root.join(relative);
        if requested.starts_with(&sync) { return Err("UNSAFE_PATH: Sync is not a project source".into()); }
        for ancestor in requested.ancestors().take_while(|p| *p != root) {
            if let Ok(target) = ancestor.canonicalize() {
                if target.starts_with(&sync) { return Err("UNSAFE_PATH: Sync alias is not a project source".into()); }
            }
        }
        let actual = safe_source(root, relative)?;
        if actual.starts_with(&sync) { return Err("UNSAFE_PATH: Sync is not a project source".into()); }
        if let Ok(rel) = actual.strip_prefix(&vault) {
            validate_relative(rel.to_str().ok_or("invalid UTF-8 source path")?)?;
        }
        safe_source(root, relative)
    }
    pub fn get(&self, id: &str) -> Result<ProjectInfo> { self.info(&self.binding(id)?) }
    pub fn projects(&self) -> Result<Vec<ProjectInfo>> {
        if !self.bindings_path().exists() { return Ok(vec![]); }
        let entries: Vec<serde_json::Value> = read_json(&self.bindings_path())?;
        Ok(entries.into_iter().map(|entry| {
            let id = entry.get("project_id").and_then(|v| v.as_str()).unwrap_or("invalid").to_string();
            let result = serde_json::from_value::<Binding>(entry.clone()).map_err(|e| e.to_string())
                .and_then(|b| { self.validate_binding(&b)?; self.info(&b) });
            result.unwrap_or_else(|error| ProjectInfo {
                project_id: id, source_root: entry.get("source_root").and_then(|v| v.as_str()).unwrap_or("").into(),
                mirror_root: entry.get("mirror_root").and_then(|v| v.as_str()).unwrap_or("").into(),
                entry: String::new(), files: vec![], published_snapshot_id: None, url: None,
                source_available: Some(false), deleting: entry.get("deleting").and_then(|v| v.as_bool()), error: Some(error),
            })
        }).collect())
    }
    pub fn create(&self, source_file: &str) -> Result<ProjectInfo> {
        let _lock = self.lock()?;
        std::fs::create_dir_all(&self.vault).map_err(|e| e.to_string())?;
        let file = Path::new(source_file).canonicalize().map_err(io_error)?;
        // A local Sync mirror locates its existing project; it never becomes a source.
        let records = store::read_records(&self.records_path()).map_err(|e| e.to_string())?;
        if let Some(record) = records.records.iter().find(|r| Path::new(&r.vault_path).canonicalize().ok().as_ref() == Some(&file)) {
            if let Some(id) = &record.project_id { return self.get(id); }
        }
        let source = self.source_root(file.parent().ok_or("missing source parent")?.to_str().ok_or("invalid UTF-8 source path")?)?;
        let entry = file.file_name().and_then(|v| v.to_str()).ok_or("invalid source filename")?;
        self.open_locked(&source, entry)
    }
    pub fn open(&self, source: &str, entry: &str) -> Result<ProjectInfo> {
        let _lock = self.lock()?;
        std::fs::create_dir_all(&self.vault).map_err(|e| e.to_string())?;
        let source = self.source_root(source)?;
        self.open_locked(&source, entry)
    }
    fn open_locked(&self, source: &Path, entry: &str) -> Result<ProjectInfo> {
        let file = self.source_path(source, entry)?;
        if !is_md(entry) { return Err("entry must be Markdown".into()); }
        let mut bindings = self.bindings()?;
        let mut matches = vec![];
        for binding in &bindings {
            let Ok(config) = self.config(binding) else { continue; };
            if Path::new(&binding.source_root).join(&config.entry).canonicalize().ok().as_ref() == Some(&file) {
                matches.push(binding);
            }
        }
        if matches.len() > 1 { return Err("multiple projects use this entry; select an existing project".into()); }
        if let Some(b) = matches.first() { return self.get(&b.project_id); }
        let id = uuid::Uuid::new_v4().to_string();
        let b = Binding {
            project_id: id.clone(), source_root: source.to_string_lossy().into(),
            mirror_root: self.vault.join(vault_settings::resolve_sync_dir(&self.vault)).join(&id).to_string_lossy().into(), deleting: false, deletion_files: None, deletion_requires_stop: false,
        };
        let c = Config { project_id: id, entry: entry.into(), files: vec![], published_snapshot_id: None, url: None };
        write_json(&self.management(&b, "project.json")?, &c)?;
        bindings.push(b.clone());
        write_json(&self.bindings_path(), &bindings)?;
        self.info(&b)
    }
    pub fn stopped(&self, id: &str) -> Result<()> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        // A vanished mirror may be the result of an interrupted local deletion.
        if b.deleting && !self.management(&b, "project.json")?.exists() {
            let mut bindings = self.bindings()?;
            bindings.iter_mut().find(|b| b.project_id == id).ok_or("project binding missing")?.deletion_requires_stop = false;
            return write_json(&self.bindings_path(), &bindings);
        }
        let mut c = self.config(&b)?;
        c.url = None;
        let config_path = self.management(&b, "project.json")?;
        write_json(&config_path, &c)?;
        if b.deleting {
            let mut bindings = self.bindings()?;
            let binding = bindings.iter_mut().find(|b| b.project_id == id).ok_or("project binding missing")?;
            binding.deletion_requires_stop = false;
            if let Some(files) = &mut binding.deletion_files {
                files.insert(".notemd/project.json".into(), sha256_hex(&read_bytes(&config_path)?));
            }
            write_json(&self.bindings_path(), &bindings)?;
        }
        Ok(())
    }
    pub fn begin_delete(&self, id: &str) -> Result<()> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        let (_, files) = self.delete_preflight(&b)?;
        if b.deleting { return Ok(()); }
        let requires_stop = if Path::new(&b.mirror_root).exists() { self.config(&b)?.url.is_some() } else { false };
        let mut bindings = self.bindings()?;
        let binding = bindings.iter_mut().find(|b| b.project_id == id).ok_or("project binding missing")?;
        binding.deleting = true;
        binding.deletion_files = Some(files);
        binding.deletion_requires_stop = requires_stop;
        write_json(&self.bindings_path(), &bindings)
    }
    pub fn cancel_delete(&self, id: &str) -> Result<()> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        if let Some(files) = &b.deletion_files {
            if files.keys().any(|path| !Path::new(&b.mirror_root).join(path).exists()) {
                return Err("local cleanup already started; retry deletion".into());
            }
        }
        self.set_deleting(id, false)
    }
    fn set_deleting(&self, id: &str, deleting: bool) -> Result<()> {
        let mut bindings = self.bindings()?;
        let binding = bindings.iter_mut().find(|b| b.project_id == id).ok_or("project binding missing")?;
        binding.deleting = deleting;
        if !deleting { binding.deletion_files = None; binding.deletion_requires_stop = false; }
        write_json(&self.bindings_path(), &bindings)
    }
    /// Enumerate every managed file first. Unknown contents, notes and symlinks
    /// must never be silently discarded by the recursive cleanup.
    fn delete_preflight(&self, b: &Binding) -> Result<(Vec<PathBuf>, BTreeMap<String, String>)> {
        let root = Path::new(&b.mirror_root);
        let records = store::read_records(&self.records_path()).map_err(|e| e.to_string())?;
        if records.records.iter().any(|r| r.project_id.as_deref() != Some(b.project_id.as_str()) && Path::new(&r.vault_path).starts_with(root)) {
            return Err("another Sync record overlaps project mirror".into());
        }
        let mut allowed = HashSet::new();
        let mut mirrors = HashSet::new();
        for record in records.records.iter().filter(|r| r.project_id.as_deref() == Some(b.project_id.as_str())) {
            let relative = Path::new(&record.vault_path).strip_prefix(root).map_err(|_| "project record outside mirror root")?;
            let path = relative.to_str().ok_or("invalid mirror path")?;
            let target = self.mirror_path(b, path)?;
            if root.exists() && b.deletion_files.is_none() && sha256_hex(&read_bytes(&target)?) != record.vault_hash {
                return Err(format!("mirror changed; preserve before deletion: {}", target.display()));
            }
            allowed.insert(target);
            mirrors.insert(mirror_meta::relative_mirror(&self.vault, Path::new(&record.vault_path)));
        }
        if let Some(files) = &b.deletion_files {
            allowed.clear();
            for path in files.keys() {
                allowed.insert(safe_destination(root, Path::new(path))?);
            }
        }
        if root.exists() && b.deletion_files.is_none() {
            let config = self.config(b)?;
            allowed.insert(self.management(b, "project.json")?);
            for path in &config.files {
                let target = self.mirror_path(b, path)?;
                if !allowed.contains(&target) { return Err(format!("project mirror record missing: {path}")); }
            }
            let snapshots = self.management(b, "snapshots")?;
            if snapshots.exists() {
                for entry in std::fs::read_dir(snapshots).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let name = entry.file_name().into_string().map_err(|_| "invalid snapshot name")?;
                    let baseline = self.baseline(b, &name)?;
                    allowed.insert(self.management(b, &format!("snapshots/{name}/manifest.json"))?);
                    let bundle = self.management(b, &format!("snapshots/{name}/bundle.html"))?;
                    if bundle.exists() { allowed.insert(bundle); }
                    for file in baseline.files {
                        validate_relative(&file.path)?;
                        let path = self.management(b, &format!("snapshots/{name}/files/{}", file.path))?;
                        if sha256_hex(&read_bytes(&path)?) != file.hash { return Err(format!("snapshot changed: {}", path.display())); }
                        allowed.insert(path);
                    }
                }
            }
            let inbox = self.management(b, "inbox")?;
            if inbox.exists() {
                for entry in std::fs::read_dir(inbox).map_err(|e| e.to_string())? {
                    let path = entry.map_err(|e| e.to_string())?.path();
                    if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
                    let name = path.file_stem().and_then(|v| v.to_str()).ok_or("invalid feedback name")?;
                    let file = self.inbox_path(b, name)?;
                    let local: LocalFeedback = read_json(&file)?;
                    if local.envelope.payload.project_id != b.project_id || local.envelope.payload.submission_id != name {
                        return Err("feedback identity mismatch".into());
                    }
                    allowed.insert(file);
                }
            }
        }
        if root.exists() {
            fn walk(root: &Path, allowed: &HashSet<PathBuf>) -> Result<()> {
                for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let path = entry.path();
                    let kind = entry.file_type().map_err(|e| e.to_string())?;
                    if kind.is_symlink() { return Err(format!("symlink blocks deletion: {}", path.display())); }
                    if kind.is_dir() {
                        if !allowed.iter().any(|file| file.starts_with(&path)) { return Err(format!("unknown directory blocks deletion: {}", path.display())); }
                        walk(&path, allowed)?;
                    } else if !kind.is_file() || !allowed.contains(&path) {
                        return Err(format!("unknown file blocks deletion: {}", path.display()));
                    }
                }
                Ok(())
            }
            walk(root, &allowed)?;
        }
        // Inspect actual metadata files, including historical filenames, and
        // remove only exact mirror matches belonging to this project's records.
        let dir = safe_destination(&self.vault, Path::new(".notemd/mirrors"))?;
        let mut metadata = vec![];
        if dir.exists() {
            for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                let kind = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?.file_type();
                if kind.is_symlink() { return Err("symlink in mirror metadata path".into()); }
                if !kind.is_file() { continue; }
                if let Ok(meta) = read_json::<mirror_meta::MirrorMeta>(&path) {
                    if mirrors.contains(&meta.mirror) { metadata.push(path); }
                }
            }
        }
        let mut files = b.deletion_files.clone().unwrap_or_default();
        for path in allowed.iter().filter(|path| path.exists()) {
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?.to_str().ok_or("invalid deletion path")?;
            let hash = sha256_hex(&std::fs::read(path).map_err(io_error)?);
            if let Some(expected) = files.get(relative) {
                if expected != &hash { return Err(format!("managed file changed after deletion reservation: {}", path.display())); }
            } else {
                files.insert(relative.to_string(), hash);
            }
        }
        Ok((metadata, files))
    }
    pub fn delete(&self, id: &str) -> Result<()> {
        let _lock = self.lock()?;
        valid_id(id)?;
        if !self.bindings()?.iter().any(|b| b.project_id == id) { return Ok(()); }
        let b = self.binding(id)?;
        if !b.deleting { return Err("begin deletion before deleting project".into()); }
        let (metadata, files) = self.delete_preflight(&b)?;
        if b.deletion_requires_stop { return Err("stop remote sharing before deleting project".into()); }
        let root = Path::new(&b.mirror_root);
        if root.exists() { remove_reserved_tree(root, &files)?; }
        for path in metadata { std::fs::remove_file(path).map_err(|e| e.to_string())?; }
        let mut records = store::read_records(&self.records_path()).map_err(|e| e.to_string())?;
        records.records.retain(|r| r.project_id.as_deref() != Some(id));
        store::save_records(&self.records_path(), &records).map_err(|e| e.to_string())?;
        let mut bindings = self.bindings()?;
        bindings.retain(|b| b.project_id != id);
        write_json(&self.bindings_path(), &bindings)
    }
    /// Rebind an already moved project; never move directories or overwrite files.
    pub fn rebind(&self, id: &str, source: &str) -> Result<ProjectInfo> {
        let _lock = self.lock()?;
        valid_id(id)?;
        let source = self.source_root(source)?;
        let mut bindings = self.bindings()?;
        let old = bindings.iter().find(|b| b.project_id == id).cloned().ok_or("project binding missing")?;
        let b = Binding { project_id: id.into(), source_root: source.to_string_lossy().into(),
            mirror_root: self.vault.join(vault_settings::resolve_sync_dir(&self.vault)).join(id).to_string_lossy().into(), deleting: old.deleting, deletion_files: old.deletion_files.clone(), deletion_requires_stop: old.deletion_requires_stop };
        let config = self.config(&b)?;
        if config.project_id != id { return Err("project mirror identity mismatch".into()); }
        self.active(&old)?;
        let entry_file = self.source_path(&source, &config.entry)?;
        for other in bindings.iter().filter(|b| b.project_id != id) {
            let Ok(c) = self.config(other) else { continue; };
            if Path::new(&other.source_root).join(c.entry).canonicalize().ok().as_ref() == Some(&entry_file) {
                return Err("entry already belongs to another project".into());
            }
        }
        let mut records = store::read_records(&self.records_path()).map_err(|e| e.to_string())?;
        let mut found = HashSet::new();
        for record in records.records.iter_mut().filter(|r| r.project_id.as_deref() == Some(id)) {
            let relative = Path::new(&record.vault_path).strip_prefix(&old.mirror_root)
                .or_else(|_| Path::new(&record.vault_path).strip_prefix(&b.mirror_root))
                .map_err(|_| "project mirror record is outside its binding")?;
            let path = relative.to_str().ok_or("invalid UTF-8 mirror path")?;
            let target = self.mirror_path(&b, path)?;
            let original = self.source_path(&source, path)?;
            if sha256_hex(&read_bytes(&target)?) != record.vault_hash || sha256_hex(&read_bytes(&original)?) != record.source_hash {
                return Err(format!("rebind requires unchanged source and mirror: {path}"));
            }
            found.insert(path.to_string());
            record.vault_path = target.to_string_lossy().into();
            record.source_path = original.to_string_lossy().into();
        }
        if config.files.iter().any(|path| !found.contains(path)) { return Err("project mirror record missing".into()); }
        let mut targets = HashSet::new();
        if records.records.iter().any(|record| !targets.insert(record.vault_path.to_lowercase())) {
            return Err("rebound mirror collides with another Sync record".into());
        }
        // If interrupted between these writes, retrying the same binding is safe.
        store::save_records(&self.records_path(), &records).map_err(|e| e.to_string())?;
        *bindings.iter_mut().find(|binding| binding.project_id == id).unwrap() = b.clone();
        write_json(&self.bindings_path(), &bindings)?;
        self.info(&b)
    }
    pub fn list(&self, id: &str) -> Result<Vec<String>> {
        let b = self.binding(id)?;
        self.source_root(&b.source_root)?;
        let root = Path::new(&b.source_root);
        fn walk(root: &Path, dir: &Path, sync: &Path, files: &mut Vec<String>) -> Result<()> {
            for ent in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                let ent = ent.map_err(|e| e.to_string())?;
                let p = ent.path();
                let rel = p
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if p.starts_with(sync) || validate_relative(&rel).is_err() {
                    continue;
                }
                let typ = ent.file_type().map_err(|e| e.to_string())?;
                if typ.is_dir() {
                    let _ = walk(root, &p, sync, files);
                } else if is_md(&rel) && safe_source(root, &rel).is_ok() {
                    files.push(rel);
                }
            }
            Ok(())
        }
        let mut out = vec![];
        walk(root, root, &self.vault.canonicalize().map_err(io_error)?.join(vault_settings::resolve_sync_dir(&self.vault)), &mut out)?;
        out.retain(|path| self.source_path(root, path).is_ok());
        out.sort();
        Ok(out)
    }
    pub fn read(&self, id: &str, path: &str) -> Result<ProjectFile> {
        let b = self.binding(id)?;
        make_file(
            path,
            read_bytes(&self.source_path(Path::new(&b.source_root), path)?)?,
            None,
        )
    }
    fn mirror_path(&self, b: &Binding, path: &str) -> Result<PathBuf> {
        validate_relative(path)?;
        safe_destination(
            &self.vault,
            &Path::new(&b.mirror_root)
                .strip_prefix(&self.vault)
                .map_err(|e| e.to_string())?
                .join(path),
        )
    }
    fn records_path(&self) -> PathBuf {
        self.state.join("sotvault-sync.json")
    }
    fn write_mirror_meta(&self, target: &Path, hash: &str) -> Result<()> {
        let path = self.state.join("project-share-device.json");
        let device: String = if path.exists() {
            read_json(&path)?
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            write_json(&path, &id)?;
            id
        };
        mirror_meta::write(
            &self.vault,
            &mirror_meta::MirrorMeta {
                mirror: mirror_meta::relative_mirror(&self.vault, target),
                device_id: device,
                device_name: "Project mirror".into(),
                source: String::new(),
                synced_at: now(),
                checksum: format!("sha256:{hash}"),
            },
        )?;
        Ok(())
    }

    fn check_mirror(
        &self,
        b: &Binding,
        path: &str,
        records: &store::RecordStore,
    ) -> Result<PathBuf> {
        let p = self.mirror_path(b, path)?;
        if p.exists() {
            let r = records
                .find_by_vault(&p.to_string_lossy())
                .ok_or("untracked mirror would be overwritten")?;
            if r.project_id.as_deref() != Some(b.project_id.as_str())
                || sha256_hex(&read_bytes(&p)?) != r.vault_hash
            {
                return Err(format!("mirror conflict: {path}"));
            }
        } else if records.find_by_vault(&p.to_string_lossy()).is_some() {
            return Err(format!("mirror missing: {path}"));
        }
        Ok(p)
    }
    pub fn snapshot(
        &self,
        id: &str,
        paths: Vec<String>,
        hashes: BTreeMap<String, String>,
    ) -> Result<ProjectSnapshot> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        let mut c = self.config(&b)?;
        if !paths.contains(&c.entry) || paths.is_empty() {
            return Err("snapshot must include entry".into());
        }
        let mut seen = HashSet::new();
        let mut prepared = vec![];
        let mut total = 0;
        let mut records = store::read_records(&self.records_path()).map_err(|e| e.to_string())?;
        for path in paths {
            validate_relative(&path)?;
            if !seen.insert(path.to_lowercase()) {
                return Err("case-folded path collision".into());
            }
            let source = self.source_path(Path::new(&b.source_root), &path)?;
            let bytes = read_bytes(&source)?;
            let modified_at = source_modified_at(&source);
            total += bytes.len();
            if total > MAX_BYTES {
                return Err("snapshot exceeds 25 MiB".into());
            }
            if hashes.get(&path) != Some(&sha256_hex(&bytes)) {
                return Err(format!("source hash changed: {path}"));
            }
            let target = self.check_mirror(&b, &path, &records)?;
            prepared.push((path, source, target, bytes, modified_at));
        }
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let mut files = vec![];
        for (path, source, target, bytes, modified_at) in &prepared {
            if sha256_hex(&read_bytes(source)?) != sha256_hex(bytes) {
                return Err(format!("source changed during snapshot: {path}"));
            }
            self.check_mirror(&b, path, &records)?;
            write_atomic(target, bytes)?;
            let hash = sha256_hex(bytes);
            records.upsert(Record {
                vault_path: target.to_string_lossy().into(),
                source_path: source.to_string_lossy().into(),
                synced_at: now(),
                source_hash: hash.clone(),
                vault_hash: hash,
                note_merge_base: None,
                project_id: Some(id.into()),
            });
            store::save_records(&self.records_path(), &records).map_err(|e| e.to_string())?;
            self.write_mirror_meta(target, &sha256_hex(bytes))?;
            mirror_meta::refresh_checksums(&self.vault, target, &sha256_hex(bytes))?;
            write_atomic(
                &self.management(&b, &format!("snapshots/{snapshot_id}/files/{path}"))?,
                bytes,
            )?;
            files.push(make_file(path, bytes.clone(), *modified_at)?);
        }
        // Freeze only if all approved source/mirror bytes still match the proposal.
        for (path, source, target, bytes, _) in &prepared {
            if read_bytes(source)? != *bytes || read_bytes(target)? != *bytes {
                return Err(format!("file changed during snapshot: {path}"));
            }
        }
        let s = ProjectSnapshot {
            schema_version: 1,
            project_id: id.into(),
            snapshot_id: snapshot_id.clone(),
            entry: c.entry.clone(),
            files,
        };
        write_json(
            &self.management(&b, &format!("snapshots/{snapshot_id}/manifest.json"))?,
            &s,
        )?;
        c.files = s.files.iter().map(|f| f.path.clone()).collect();
        write_json(&self.management(&b, "project.json")?, &c)?;
        Ok(s)
    }
    fn baseline(&self, b: &Binding, snapshot: &str) -> Result<ProjectSnapshot> {
        valid_id(snapshot)?;
        let s: ProjectSnapshot =
            read_json(&self.management(b, &format!("snapshots/{snapshot}/manifest.json"))?)?;
        if s.project_id != b.project_id || s.snapshot_id != snapshot {
            return Err("baseline identity mismatch".into());
        }
        Ok(s)
    }
    pub fn mirror(&self, id: &str, path: &str) -> Result<MirrorView> {
        let binding = self.binding(id)?;
        let source = self.bound_source(&binding, path)?;
        let target = self.mirror_path(&binding, path)?;
        Ok(MirrorView {
            source: make_file(path, read_bytes(&source)?, None)?,
            mirror: make_file(path, read_bytes(&target)?, None)?,
        })
    }
    pub fn resolve_mirror(
        &self,
        id: &str,
        path: &str,
        expected_source: &str,
        expected_mirror: &str,
    ) -> Result<ProjectInfo> {
        let _lock = self.lock()?;
        let binding = self.binding(id)?;
        self.active(&binding)?;
        let source = self.bound_source(&binding, path)?;
        let target = self.mirror_path(&binding, path)?;
        let bytes = read_bytes(&source)?;
        if sha256_hex(&bytes) != expected_source
            || sha256_hex(&read_bytes(&target)?) != expected_mirror
        {
            return Err("source or mirror changed; review conflict again".into());
        }
        let mut records = store::read_records(&self.records_path()).map_err(|e| e.to_string())?;
        let mut record = records
            .find_by_vault(&target.to_string_lossy())
            .cloned()
            .ok_or("mirror binding missing")?;
        validate_sync_record(&self.records_path(), &self.vault, &record)?;
        if sha256_hex(&read_bytes(&source)?) != expected_source
            || sha256_hex(&read_bytes(&target)?) != expected_mirror
        {
            return Err("source or mirror changed; review conflict again".into());
        }
        write_atomic(&target, &bytes)?;
        record.source_hash = expected_source.into();
        record.vault_hash = expected_source.into();
        record.synced_at = now();
        records.upsert(record);
        store::save_records(&self.records_path(), &records).map_err(|e| e.to_string())?;
        mirror_meta::refresh_checksums(&self.vault, &target, expected_source)?;
        self.info(&binding)
    }
    pub fn snapshot_get(&self, id: &str, snapshot: &str) -> Result<ProjectSnapshot> {
        let binding = self.binding(id)?;
        self.baseline(&binding, snapshot)
    }
    pub fn bundle_get(&self, id: &str, snapshot: &str) -> Result<String> {
        let binding = self.binding(id)?;
        self.baseline(&binding, snapshot)?;
        String::from_utf8(read_bytes(
            &self.management(&binding, &format!("snapshots/{snapshot}/bundle.html"))?,
        )?)
        .map_err(|e| e.to_string())
    }
    pub fn bundle(&self, id: &str, snapshot: &str, html: &str) -> Result<()> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        self.baseline(&b, snapshot)?;
        if html.len() > MAX_BYTES {
            return Err("bundle exceeds 25 MiB".into());
        }
        let path = self.management(&b, &format!("snapshots/{snapshot}/bundle.html"))?;
        if path.exists() && read_bytes(&path)? != html.as_bytes() {
            return Err("snapshot bundle is immutable".into());
        }
        write_atomic(&path, html.as_bytes())
    }
    pub fn published(&self, id: &str, snapshot: &str, url: &str) -> Result<ProjectInfo> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        self.baseline(&b, snapshot)?;
        if !self
            .management(&b, &format!("snapshots/{snapshot}/bundle.html"))?
            .is_file()
        {
            return Err("bundle missing".into());
        }
        let mut c = self.config(&b)?;
        c.published_snapshot_id = Some(snapshot.into());
        c.url = Some(url.into());
        write_json(&self.management(&b, "project.json")?, &c)?;
        self.info(&b)
    }
    fn inbox_path(&self, b: &Binding, submission: &str) -> Result<PathBuf> {
        valid_id(submission)?;
        self.management(b, &format!("inbox/{submission}.json"))
    }
    fn validate_feedback(&self, b: &Binding, feedback: &ProjectFeedback) -> Result<()> {
        if feedback.schema_version != 1 || feedback.project_id != b.project_id {
            return Err("feedback identity mismatch".into());
        }
        let s = self.baseline(b, &feedback.snapshot_id)?;
        let mut seen = HashSet::new();
        for edit in &feedback.edits {
            validate_relative(&edit.path)?;
            if !seen.insert(&edit.path) {
                return Err("duplicate edit".into());
            }
            let f = s
                .files
                .iter()
                .find(|f| f.path == edit.path && f.markdown.is_some())
                .ok_or("file is not shared Markdown")?;
            if f.hash != edit.base_hash {
                return Err("untrusted base hash".into());
            }
            let baseline = read_bytes(&self.management(
                b,
                &format!("snapshots/{}/files/{}", s.snapshot_id, edit.path),
            )?)?;
            if sha256_hex(&baseline) != f.hash {
                return Err("baseline corrupted".into());
            }
        }
        for note in &feedback.annotations {
            validate_relative(&note.path)?;
            if !s
                .files
                .iter()
                .any(|f| f.path == note.path && f.markdown.is_some())
            {
                return Err("annotation outside shared Markdown".into());
            }
        }
        Ok(())
    }
    fn bound_source(&self, b: &Binding, path: &str) -> Result<PathBuf> {
        let source = self.source_path(Path::new(&b.source_root), path)?;
        let target = self.mirror_path(b, path)?;
        let records = store::read_records(&self.records_path()).map_err(|e| e.to_string())?;
        let record = records
            .find_by_vault(&target.to_string_lossy())
            .ok_or("source binding missing")?;
        if record.project_id.as_deref() != Some(b.project_id.as_str())
            || Path::new(&record.source_path) != source
        {
            return Err("source binding mismatch".into());
        }
        Ok(source)
    }
    pub fn feedback(&self, id: &str, envelope: FeedbackEnvelope) -> Result<LocalFeedback> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        let path = self.inbox_path(&b, &envelope.payload.submission_id)?;
        if path.exists() {
            let mut existing: LocalFeedback = read_json(&path)?;
            if existing.envelope.request_hash != envelope.request_hash
                || serde_json::to_value(&existing.envelope.payload).ok()
                    != serde_json::to_value(&envelope.payload).ok()
            {
                return Err("submission ID has different content".into());
            }
            self.recover(&b, &mut existing)?;
            return Ok(existing);
        }
        if serde_json::to_vec(&envelope)
            .map_err(|e| e.to_string())?
            .len()
            > 5 * 1024 * 1024
        {
            return Err("feedback exceeds 5 MiB".into());
        }
        let mut local = LocalFeedback {
            envelope,
            status: "pending".into(),
            error: None,
            decisions: BTreeMap::new(),
        };
        // Persist the original before trust validation; failed validation is retained in quarantine.
        write_json(&path, &local)?;
        if let Err(e) = self.validate_feedback(&b, &local.envelope.payload) {
            local.status = "quarantined".into();
            local.error = Some(e);
        }
        write_json(&path, &local)?;
        Ok(local)
    }
    fn load_feedback(&self, b: &Binding, submission: &str) -> Result<LocalFeedback> {
        let mut f = read_json(&self.inbox_path(b, submission)?)?;
        self.recover(b, &mut f)?;
        Ok(f)
    }
    fn recompute(f: &mut LocalFeedback) {
        if f.status == "quarantined" {
            return;
        }
        if f.decisions.values().any(|d| {
            d.status == "pending" || d.status == "mirror_pending" || d.status == "recovery_conflict"
        }) {
            f.status = "pending".into();
        } else if !f.envelope.payload.edits.is_empty()
            && f.envelope.payload.edits.iter().all(|e| {
                f.decisions
                    .get(&e.path)
                    .is_some_and(|d| d.status == "accepted" || d.status == "rejected")
            })
        {
            f.status = if f.decisions.values().any(|d| d.status == "accepted") {
                "accepted"
            } else {
                "rejected"
            }
            .into();
        }
    }
    fn recover(&self, b: &Binding, f: &mut LocalFeedback) -> Result<()> {
        // Missing sources and deletion reservations leave persisted intents untouched.
        if b.deleting || self.source_root(&b.source_root).is_err() { return Ok(()); }
        let pending: Vec<_> = f
            .decisions
            .iter()
            .filter(|(_, d)| d.status == "pending" || d.status == "mirror_pending")
            .map(|(p, d)| (p.clone(), d.clone()))
            .collect();
        for (path, mut d) in pending {
            if self.source_path(Path::new(&b.source_root), &path).is_err() { continue; }
            let outcome = (|| {
                self.validate_feedback(b, &f.envelope.payload)?;
                let source = self.bound_source(b, &path)?;
                let hash = sha256_hex(&read_bytes(&source)?);
                if d.result_hash.as_ref() == Some(&hash) {
                    if d.mirrors.is_empty() {
                        d.mirrors = crate::sotvault::plan_source_mirrors(
                            &self.records_path(),
                            &self.vault,
                            &source.to_string_lossy(),
                            &read_bytes(&source)?,
                        )?;
                        f.decisions.insert(path.clone(), d.clone());
                        write_json(&self.inbox_path(b, &f.envelope.payload.submission_id)?, f)?;
                    }
                    match crate::sotvault::refresh_source_mirrors_locked(
                        &self.records_path(),
                        &self.vault,
                        &source.to_string_lossy(),
                        &d.mirrors,
                    ) {
                        Ok(()) => {
                            d.status = "accepted".into();
                            d.content = None;
                        }
                        Err(e) => {
                            d.status = "mirror_pending".into();
                            f.error = Some(e);
                        }
                    }
                } else if d.before_hash.as_ref() == Some(&hash) {
                    d.status = "not_applied".into();
                } else {
                    d.status = "recovery_conflict".into();
                    f.error = Some("source differs from both persisted intent hashes".into());
                }
                Ok(())
            })();
            if let Err(e) = outcome {
                d.status = "recovery_conflict".into();
                f.error = Some(e);
            }
            f.decisions.insert(path, d);
        }
        Self::recompute(f);
        write_json(&self.inbox_path(b, &f.envelope.payload.submission_id)?, f)
    }
    pub fn inbox(&self, id: &str) -> Result<Vec<LocalFeedback>> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        let dir = self.management(&b, "inbox")?;
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut out = vec![];
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let p = entry.map_err(|e| e.to_string())?.path();
            if p.extension().and_then(|s| s.to_str()) == Some("json") {
                let submission = p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or("invalid inbox filename")?;
                out.push(self.load_feedback(&b, submission)?);
            }
        }
        out.sort_by(|a, b| a.envelope.received_at.cmp(&b.envelope.received_at));
        Ok(out)
    }
    pub fn review(&self, id: &str, submission: &str, path: &str) -> Result<ReviewFile> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        let f = self.load_feedback(&b, submission)?;
        if f.status == "quarantined" {
            return Err("feedback quarantined".into());
        }
        self.validate_feedback(&b, &f.envelope.payload)?;
        let s = self.baseline(&b, &f.envelope.payload.snapshot_id)?;
        let base = s
            .files
            .iter()
            .find(|f| f.path == path)
            .and_then(|f| f.markdown.clone())
            .ok_or("file outside baseline")?;
        let source = self.bound_source(&b, path)?;
        let current = String::from_utf8(read_bytes(&source)?).map_err(|_| "source is not UTF-8")?;
        let after = f
            .envelope
            .payload
            .edits
            .iter()
            .find(|e| e.path == path)
            .map(|e| e.after_markdown.clone())
            .unwrap_or(base.clone());
        let current_hash = sha256_hex(current.as_bytes());
        let status = f
            .decisions
            .get(path)
            .map(|d| d.status.clone())
            .unwrap_or_else(|| {
                if current == base {
                    "pending"
                } else {
                    "source_changed"
                }
                .into()
            });
        Ok(ReviewFile {
            path: path.into(),
            source_path: source.to_string_lossy().into(),
            base,
            current,
            after,
            current_hash,
            status,
        })
    }
    pub fn apply(
        &self,
        id: &str,
        submission: &str,
        path: &str,
        expected: &str,
        content: &str,
    ) -> Result<LocalFeedback> {
        let _lock = self.lock()?;
        if content.len() > MAX_BYTES {
            return Err("content exceeds 25 MiB".into());
        }
        let b = self.binding(id)?;
        self.active(&b)?;
        let mut f = self.load_feedback(&b, submission)?;
        if f.status == "quarantined" {
            return Err("feedback quarantined".into());
        }
        self.validate_feedback(&b, &f.envelope.payload)?;
        if !f.envelope.payload.edits.iter().any(|e| e.path == path) {
            return Err("no edit for this file".into());
        }
        if let Some(d) = f.decisions.get(path) {
            if d.status == "accepted" || d.status == "mirror_pending" {
                return Ok(f);
            }
            if d.status == "rejected" || d.status == "recovery_conflict" {
                return Err("file decision prevents applying".into());
            }
        }
        let source = self.bound_source(&b, path)?;
        let before = sha256_hex(&read_bytes(&source)?);
        if before != expected {
            return Err("source changed; review again".into());
        }
        crate::sotvault::check_source_mirrors(
            &self.records_path(),
            &self.vault,
            &source.to_string_lossy(),
        )?;
        let decision = Decision {
            status: "pending".into(),
            before_hash: Some(before),
            result_hash: Some(sha256_hex(content.as_bytes())),
            mirrors: crate::sotvault::plan_source_mirrors(
                &self.records_path(),
                &self.vault,
                &source.to_string_lossy(),
                content.as_bytes(),
            )?,
            content: Some(content.into()),
        };
        f.decisions.insert(path.into(), decision);
        f.error = None;
        write_json(&self.inbox_path(&b, submission)?, &f)?;
        if sha256_hex(&read_bytes(&source)?) != expected {
            return Err("source changed; review again".into());
        }
        write_atomic(&source, content.as_bytes())?;
        self.recover(&b, &mut f)?;
        Ok(f)
    }
    pub fn reject(&self, id: &str, submission: &str, path: Option<&str>) -> Result<LocalFeedback> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        let mut f = self.load_feedback(&b, submission)?;
        if let Some(p) = path {
            if !f.envelope.payload.edits.iter().any(|e| e.path == p) {
                return Err("file outside feedback".into());
            }
        }
        for e in &f.envelope.payload.edits {
            if path.is_some_and(|p| p != e.path) {
                continue;
            }
            if f.decisions.get(&e.path).is_some_and(|d| {
                matches!(
                    d.status.as_str(),
                    "accepted" | "mirror_pending" | "recovery_conflict"
                )
            }) {
                continue;
            }
            f.decisions.insert(
                e.path.clone(),
                Decision {
                    status: "rejected".into(),
                    ..Default::default()
                },
            );
        }
        Self::recompute(&mut f);
        if path.is_none() && f.envelope.payload.edits.is_empty() && f.status != "quarantined" {
            f.status = "rejected".into();
        }
        write_json(&self.inbox_path(&b, submission)?, &f)?;
        Ok(f)
    }
    pub fn resolve(&self, id: &str, submission: &str) -> Result<LocalFeedback> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        let mut f = self.load_feedback(&b, submission)?;
        if f.status == "quarantined" || !f.envelope.payload.edits.is_empty() {
            return Err("resolve requires valid annotation-only feedback".into());
        }
        self.validate_feedback(&b, &f.envelope.payload)?;
        f.status = "resolved".into();
        write_json(&self.inbox_path(&b, submission)?, &f)?;
        Ok(f)
    }
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn project_share_modified_at_supports_old_schema_one_manifests() {
        let legacy = serde_json::json!({"schemaVersion":1,"project_id":"p","snapshotId":"s","entry":"README.md",
            "files":[{"path":"README.md","hash":"h","bytes":1,"markdown":"a"}]});
        let snapshot: ProjectSnapshot = serde_json::from_value(legacy).unwrap();
        assert_eq!(snapshot.schema_version, 1);
        assert_eq!(snapshot.files[0].modified_at, None);
        assert!(serde_json::to_value(snapshot).unwrap()["files"][0].get("modifiedAt").is_none());
    }
    #[test]
    fn project_share_snapshot_freezes_source_mtime_not_mirror_copy_time() {
        let (_t, service, project) = fixture();
        let source = Path::new(&project.source_root).join("README.md");
        let old_time = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_600_000_000_123);
        std::fs::File::options().write(true).open(&source).unwrap().set_times(std::fs::FileTimes::new().set_modified(old_time)).unwrap();
        let snapshot = freeze(&service, &project);
        let entry = snapshot.files.iter().find(|file| file.path == "README.md").unwrap();
        assert_eq!(entry.modified_at, Some(1_600_000_000_123));
        assert_eq!(entry.hash, sha256_hex(&std::fs::read(&source).unwrap()));
        assert_ne!(std::fs::metadata(Path::new(&project.mirror_root).join("README.md")).unwrap().modified().unwrap(), old_time);
        assert_eq!(service.snapshot_get(&project.project_id, &snapshot.snapshot_id).unwrap().files[0].modified_at, entry.modified_at);
    }
    #[test]
    fn project_share_fixed_entry_regression() {
        let (_t, s, a) = fixture();
        let b = s.open(&a.source_root, "docs/a.md").unwrap();
        assert_ne!(a.project_id, b.project_id);
        assert_eq!(s.open(&a.source_root, "README.md").unwrap().project_id, a.project_id);
        assert_eq!(s.info(&s.binding(&a.project_id).unwrap()).unwrap().entry, "README.md");
    }
    #[test]
    fn project_share_missing_source_keeps_history_regression() {
        let (_t, s, p) = fixture();
        let snap = freeze(&s, &p);
        std::fs::remove_dir_all(&p.source_root).unwrap();
        assert!(s.snapshot_get(&p.project_id, &snap.snapshot_id).is_ok());
        assert!(s.inbox(&p.project_id).is_ok());
    }
    #[test]
    fn project_share_vault_root_regression() {
        let (_t, s, _) = fixture();
        std::fs::write(s.vault.join("root.md"), "root document").unwrap();
        assert!(s.open(s.vault.to_str().unwrap(), "root.md").is_ok());
    }
    #[test]
    fn project_share_create_uses_complete_entry_and_recovers_nested_legacy_binding() {
        let (_t, s, a) = fixture();
        let nested = s.open(&a.source_root, "docs/a.md").unwrap();
        let restored = s.create(Path::new(&a.source_root).join("docs/a.md").to_str().unwrap()).unwrap();
        assert_eq!(restored.project_id, nested.project_id);
        assert_eq!(restored.source_root, a.source_root);
        assert_eq!(restored.entry, "docs/a.md");
        assert_ne!(restored.project_id, a.project_id);
        assert_eq!(s.create(Path::new(&a.source_root).join("README.md").to_str().unwrap()).unwrap().project_id, a.project_id);
        assert_eq!(s.projects().unwrap().len(), 2);
        let mut bindings = s.bindings().unwrap();
        let mut duplicate = bindings[0].clone();
        duplicate.project_id = "duplicate".into();
        duplicate.mirror_root = s.vault.join("sync/duplicate").to_string_lossy().into();
        let mut config = s.config(&bindings[0]).unwrap();
        config.project_id = duplicate.project_id.clone();
        write_json(&s.management(&duplicate, "project.json").unwrap(), &config).unwrap();
        bindings.push(duplicate);
        write_json(&s.bindings_path(), &bindings).unwrap();
        assert!(s.create(Path::new(&a.source_root).join("README.md").to_str().unwrap()).unwrap_err().contains("multiple projects"));
    }
    #[test]
    fn project_share_missing_source_preserves_pending_intent_and_exact_bundle() {
        let (t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.bundle(&p.project_id, &snapshot.snapshot_id, "exact publication bytes").unwrap();
        let mut feedback = s.feedback(&p.project_id, envelope(&p, &snapshot, "offline")).unwrap();
        feedback.decisions.insert("README.md".into(), Decision { status: "pending".into(),
            before_hash: Some(snapshot.files[0].hash.clone()), result_hash: Some(sha256_hex(b"result")), content: Some("result".into()), ..Default::default() });
        let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "offline").unwrap();
        write_json(&path, &feedback).unwrap();
        let original = std::fs::read(&path).unwrap();
        std::fs::rename(&p.source_root, t.path().join("moved-source")).unwrap();
        assert_eq!(s.get(&p.project_id).unwrap().source_available, Some(false));
        assert_eq!(s.projects().unwrap()[0].source_available, Some(false));
        assert_eq!(s.inbox(&p.project_id).unwrap()[0].decisions["README.md"].status, "pending");
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert_eq!(s.bundle_get(&p.project_id, &snapshot.snapshot_id).unwrap(), "exact publication bytes");
        assert!(s.snapshot_get(&p.project_id, &snapshot.snapshot_id).is_ok());
        assert!(s.snapshot(&p.project_id, vec!["README.md".into()], BTreeMap::new()).is_err());
        assert!(s.apply(&p.project_id, "offline", "README.md", "hash", "edit").is_err());
    }
    #[test]
    fn project_share_projects_reports_each_damaged_item() {
        let (_t, s, p) = fixture();
        let other = s.open(&p.source_root, "docs/a.md").unwrap();
        std::fs::write(Path::new(&other.mirror_root).join(".notemd/project.json"), "bad json").unwrap();
        let mut entries: Vec<serde_json::Value> = read_json(&s.bindings_path()).unwrap();
        entries.push(serde_json::json!({"project_id":"broken-binding"}));
        write_json(&s.bindings_path(), &entries).unwrap();
        let projects = s.projects().unwrap();
        assert_eq!(projects.len(), 3);
        assert!(projects[0].error.is_none());
        assert_eq!(projects[0].entry, "README.md");
        assert!(projects[1].error.is_some());
        assert_eq!(projects[2].project_id, "broken-binding");
        assert!(projects[2].error.is_some());
    }
    #[test]
    fn project_share_read_only_real_absence_is_not_found() {
        let (_t, s, p) = fixture();
        assert!(s.read(&p.project_id, "missing.png").unwrap_err().starts_with("NOT_FOUND:"));
        for path in ["../escape.png", ".notemd/key", "private.note.md", "docs"] {
            assert!(!s.read(&p.project_id, path).unwrap_err().starts_with("NOT_FOUND:"));
        }
        let huge = Path::new(&p.source_root).join("huge.png");
        std::fs::File::create(&huge).unwrap().set_len(MAX_BYTES as u64 + 1).unwrap();
        assert!(s.read(&p.project_id, "huge.png").unwrap_err().starts_with("TOO_LARGE:"));
        std::fs::write(Path::new(&p.source_root).join("invalid.md"), [255]).unwrap();
        assert!(!s.read(&p.project_id, "invalid.md").unwrap_err().starts_with("NOT_FOUND:"));
    }
    #[cfg(unix)]
    #[test]
    fn project_share_vault_root_rejects_sync_reads_in_every_source_entrypoint() {
        let (_t, s, _) = fixture();
        std::fs::write(s.vault.join("root.md"), "root").unwrap();
        let p = s.create(s.vault.join("root.md").to_str().unwrap()).unwrap();
        std::fs::create_dir_all(s.vault.join("sync/generated")).unwrap();
        std::fs::write(s.vault.join("sync/generated/a.md"), "never read").unwrap();
        std::os::unix::fs::symlink(s.vault.join("sync"), s.vault.join("alias")).unwrap();
        for path in ["sync/generated/a.md", "sync/missing.png", "alias/generated/a.md", "alias/missing.png"] {
            assert!(!s.read(&p.project_id, path).unwrap_err().starts_with("NOT_FOUND:"), "{path}");
            assert!(s.snapshot(&p.project_id, vec!["root.md".into(), path.into()], BTreeMap::new()).is_err());
        }
        assert_eq!(s.list(&p.project_id).unwrap(), vec!["root.md"]);
        freeze_one(&s, &p);
        assert_eq!(s.create(Path::new(&p.mirror_root).join("root.md").to_str().unwrap()).unwrap().project_id, p.project_id);
        assert!(s.create(s.vault.join("sync/generated/a.md").to_str().unwrap()).is_err());
    }
    fn freeze_one(s: &ProjectStore, p: &ProjectInfo) -> ProjectSnapshot {
        let file = s.read(&p.project_id, &p.entry).unwrap();
        s.snapshot(&p.project_id, vec![p.entry.clone()], [(p.entry.clone(), file.hash)].into()).unwrap()
    }
    #[test]
    fn project_share_delete_keeps_sources_other_projects_and_legacy_records() {
        let (_t, s, p) = fixture();
        freeze(&s, &p);
        let other = s.open(&p.source_root, "docs/a.md").unwrap();
        freeze_one(&s, &other);
        let legacy = s.vault.join("legacy.md");
        std::fs::write(&legacy, "legacy").unwrap();
        let source_before = std::fs::read(Path::new(&p.source_root).join("README.md")).unwrap();
        let other_before = std::fs::read(Path::new(&other.mirror_root).join("docs/a.md")).unwrap();
        let mut records = store::load_records(&s.records_path());
        records.upsert(Record { vault_path: legacy.to_string_lossy().into(), source_path: Path::new(&p.source_root).join("README.md").to_string_lossy().into(),
            synced_at: 1, source_hash: sha256_hex(&source_before), vault_hash: sha256_hex(b"legacy"), note_merge_base: None, project_id: None });
        store::save_records(&s.records_path(), &records).unwrap();
        let keep: Vec<_> = records.records.iter().filter(|r| r.project_id.as_deref() != Some(p.project_id.as_str())).cloned().collect();
        s.begin_delete(&p.project_id).unwrap();
        assert_eq!(s.get(&p.project_id).unwrap().deleting, Some(true));
        assert!(s.snapshot(&p.project_id, vec!["README.md".into()], BTreeMap::new()).is_err());
        let target = Path::new(&p.mirror_root).join("README.md");
        let records_before = std::fs::read(s.records_path()).unwrap();
        assert!(crate::sotvault::forget_from_store(&s.records_path(), target.to_str().unwrap()).is_err());
        assert_eq!(std::fs::read(s.records_path()).unwrap(), records_before);
        assert!(crate::sotvault::apply_update_from_store(&s.records_path(), &s.vault, target.to_str().unwrap()).is_err());
        s.delete(&p.project_id).unwrap();
        s.delete(&p.project_id).unwrap();
        assert!(!Path::new(&p.mirror_root).exists());
        assert_eq!(std::fs::read(Path::new(&p.source_root).join("README.md")).unwrap(), source_before);
        assert_eq!(std::fs::read(Path::new(&other.mirror_root).join("docs/a.md")).unwrap(), other_before);
        assert_eq!(std::fs::read(&legacy).unwrap(), b"legacy");
        assert_eq!(store::load_records(&s.records_path()).records, keep);
        assert_eq!(mirror_meta::read_all(&s.vault).len(), 1);
        assert_ne!(s.create(Path::new(&p.source_root).join("README.md").to_str().unwrap()).unwrap().project_id, p.project_id);
    }
    #[test]
    fn project_share_delete_revalidates_drift_and_unknown_contents() {
        let (_t, s, p) = fixture();
        freeze(&s, &p);
        let mirror = Path::new(&p.mirror_root).join("README.md");
        let original = std::fs::read(&mirror).unwrap();
        std::fs::write(&mirror, "unsaved mirror work").unwrap();
        assert!(s.begin_delete(&p.project_id).is_err());
        std::fs::write(&mirror, &original).unwrap();
        for name in ["unknown.md", "README.note.md", ".notemd/unknown.json"] {
            let path = Path::new(&p.mirror_root).join(name);
            std::fs::write(&path, "keep me").unwrap();
            assert!(s.begin_delete(&p.project_id).is_err());
            assert!(path.exists());
            std::fs::remove_file(path).unwrap();
        }
        s.begin_delete(&p.project_id).unwrap();
        std::fs::write(&mirror, "changed after reservation").unwrap();
        assert!(s.delete(&p.project_id).is_err());
        assert_eq!(std::fs::read_to_string(&mirror).unwrap(), "changed after reservation");
        s.cancel_delete(&p.project_id).unwrap();
        assert_eq!(s.get(&p.project_id).unwrap().deleting, Some(false));
    }
    #[test]
    fn project_share_delete_offline_draft_missing_source_and_interrupted_cleanup() {
        let (_t, s, p) = fixture();
        std::fs::remove_dir_all(&p.source_root).unwrap();
        s.begin_delete(&p.project_id).unwrap();
        std::fs::remove_dir_all(&p.mirror_root).unwrap();
        s.stopped(&p.project_id).unwrap();
        s.delete(&p.project_id).unwrap();
        assert!(s.projects().unwrap().is_empty());
    }
    #[test]
    fn project_share_active_delete_requires_stopped_and_stopped_keeps_history() {
        let (_t, s, p) = fixture();
        let snap = freeze(&s, &p);
        s.bundle(&p.project_id, &snap.snapshot_id, "bundle").unwrap();
        s.published(&p.project_id, &snap.snapshot_id, "https://share.example/id").unwrap();
        s.begin_delete(&p.project_id).unwrap();
        assert!(s.delete(&p.project_id).is_err());
        assert!(Path::new(&p.mirror_root).exists());
        s.stopped(&p.project_id).unwrap();
        assert!(s.get(&p.project_id).unwrap().url.is_none());
        assert_eq!(s.bundle_get(&p.project_id, &snap.snapshot_id).unwrap(), "bundle");
        s.delete(&p.project_id).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn project_share_delete_symlinks_and_changed_location_preserve_originals() {
        let (t, s, p) = fixture();
        freeze(&s, &p);
        let target = Path::new(&p.mirror_root).join("README.md");
        let outside = t.path().join("outside.md");
        std::fs::copy(&target, &outside).unwrap();
        std::fs::remove_file(&target).unwrap();
        std::os::unix::fs::symlink(&outside, &target).unwrap();
        assert!(s.begin_delete(&p.project_id).is_err());
        assert!(outside.exists());
        std::fs::remove_file(&target).unwrap();
        std::fs::copy(&outside, &target).unwrap();
        s.begin_delete(&p.project_id).unwrap();
        vault_settings::write(&s.vault, &vault_settings::VaultSettings { sync_dir: Some("changed".into()), ..Default::default() }).unwrap();
        assert!(s.delete(&p.project_id).is_err());
        assert!(target.exists());
        assert!(Path::new(&p.source_root).join("README.md").exists());
    }
    #[test]
    fn project_share_partial_cleanup_retries_without_config_or_snapshot_manifest() {
        let (_t, s, p) = fixture();
        let snap = freeze(&s, &p);
        s.begin_delete(&p.project_id).unwrap();
        std::fs::remove_file(Path::new(&p.mirror_root).join(".notemd/project.json")).unwrap();
        std::fs::remove_file(Path::new(&p.mirror_root).join(format!(".notemd/snapshots/{}/manifest.json", snap.snapshot_id))).unwrap();
        std::fs::remove_file(Path::new(&p.mirror_root).join("README.md")).unwrap();
        assert!(s.projects().unwrap()[0].error.is_some());
        assert_eq!(s.projects().unwrap()[0].deleting, Some(true));
        assert!(s.cancel_delete(&p.project_id).is_err());
        s.begin_delete(&p.project_id).unwrap();
        let unknown = Path::new(&p.mirror_root).join("preserve.md");
        std::fs::write(&unknown, "new user work").unwrap();
        assert!(s.delete(&p.project_id).is_err());
        assert_eq!(std::fs::read_to_string(&unknown).unwrap(), "new user work");
        std::fs::remove_file(unknown).unwrap();
        s.delete(&p.project_id).unwrap();
        assert!(s.projects().unwrap().is_empty());
        assert!(Path::new(&p.source_root).join("README.md").exists());
    }
    #[test]
    fn project_share_missing_config_keeps_remote_stop_requirement() {
        let (_t, s, p) = fixture();
        let snap = freeze(&s, &p);
        s.bundle(&p.project_id, &snap.snapshot_id, "bundle").unwrap();
        s.published(&p.project_id, &snap.snapshot_id, "https://share.example/id").unwrap();
        s.begin_delete(&p.project_id).unwrap();
        std::fs::remove_file(Path::new(&p.mirror_root).join(".notemd/project.json")).unwrap();
        assert!(s.delete(&p.project_id).unwrap_err().contains("stop remote"));
        s.stopped(&p.project_id).unwrap();
        s.delete(&p.project_id).unwrap();
    }
    #[test]
    fn project_share_damaged_unrelated_config_does_not_block_create_or_rebind() {
        let (t, s, p) = fixture();
        std::fs::write(Path::new(&p.mirror_root).join(".notemd/project.json"), "broken config").unwrap();
        let nested = s.create(Path::new(&p.source_root).join("docs/a.md").to_str().unwrap()).unwrap();
        assert_ne!(nested.project_id, p.project_id);
        freeze_one(&s, &nested);
        let moved = t.path().join("new-docs");
        std::fs::rename(&nested.source_root, &moved).unwrap();
        s.rebind(&nested.project_id, moved.to_str().unwrap()).unwrap();
        let items = s.projects().unwrap();
        assert!(items.iter().find(|item| item.project_id == p.project_id).unwrap().error.is_some());
        assert!(items.iter().find(|item| item.project_id == nested.project_id).unwrap().error.is_none());
    }
    #[cfg(unix)]
    #[test]
    fn project_share_unreadable_reference_never_becomes_missing() {
        use std::os::unix::fs::PermissionsExt;
        let (_t, s, p) = fixture();
        let path = Path::new(&p.source_root).join("unreadable.png");
        std::fs::write(&path, b"private").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
        let result = s.read(&p.project_id, "unreadable.png");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(result.unwrap_err().starts_with("UNREADABLE:"));
    }
    #[test]
    fn project_share_precise_cleanup_preserves_content_added_after_preflight() {
        let (_t, s, p) = fixture();
        freeze(&s, &p);
        s.begin_delete(&p.project_id).unwrap();
        let b = s.binding(&p.project_id).unwrap();
        let (_, files) = s.delete_preflight(&b).unwrap();
        let added = Path::new(&p.mirror_root).join("concurrent-user-work.md");
        std::fs::write(&added, "preserve concurrent work").unwrap();
        assert!(remove_reserved_tree(Path::new(&p.mirror_root), &files).is_err());
        assert_eq!(std::fs::read_to_string(&added).unwrap(), "preserve concurrent work");
        assert!(s.binding(&p.project_id).unwrap().deleting);
        assert!(s.delete(&p.project_id).is_err());
        std::fs::remove_file(added).unwrap();
        s.delete(&p.project_id).unwrap();
        assert!(s.projects().unwrap().is_empty());
    }
    fn fixture() -> (TempDir, ProjectStore, ProjectInfo) {
        let t = TempDir::new().unwrap();
        let source = t.path().join("source");
        std::fs::create_dir_all(source.join("docs")).unwrap();
        std::fs::write(source.join("README.md"), "[design](docs/a.md)").unwrap();
        std::fs::write(source.join("docs/a.md"), "[home](../README.md)").unwrap();
        let service = ProjectStore::new(t.path().join("vault"), t.path().join("state"));
        let info = service.open(source.to_str().unwrap(), "README.md").unwrap();
        (t, service, info)
    }
    fn freeze(s: &ProjectStore, p: &ProjectInfo) -> ProjectSnapshot {
        let paths: Vec<String> = vec!["README.md".into(), "docs/a.md".into()];
        let hashes = paths
            .iter()
            .map(|path| (path.clone(), s.read(&p.project_id, path).unwrap().hash))
            .collect();
        s.snapshot(&p.project_id, paths, hashes).unwrap()
    }
    #[test]
    fn project_share_supports_vault_child_projects_but_never_sync_sources() {
        let (t, s, _) = fixture();
        let source = s.vault.join("projects/demo");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("README.md"), "vault project").unwrap();
        assert!(s.open(source.to_str().unwrap(), "README.md").is_ok());
        let mirror = s.vault.join("sync/generated");
        std::fs::create_dir_all(&mirror).unwrap();
        std::fs::write(mirror.join("README.md"), "mirror").unwrap();
        assert!(s.open(mirror.to_str().unwrap(), "README.md").is_err());
        assert!(s.open(t.path().to_str().unwrap(), "README.md").is_err());
        vault_settings::write(&s.vault, &vault_settings::VaultSettings {
            sync_dir: Some("projects/sync".into()), ..Default::default()
        }).unwrap();
        let ancestor = s.vault.join("projects");
        std::fs::write(ancestor.join("README.md"), "contains Sync").unwrap();
        assert!(s.open(ancestor.to_str().unwrap(), "README.md").is_err());
    }
    #[test]
    fn project_share_rebind_retains_identity_and_requires_existing_trusted_mirrors() {
        let (t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snapshot, "moved")).unwrap();
        let source = t.path().join("source-moved");
        std::fs::rename(&p.source_root, &source).unwrap();
        let source = source.canonicalize().unwrap();
        assert!(s.list(&p.project_id).is_err());
        let vault = t.path().join("vault-moved");
        std::fs::rename(&s.vault, &vault).unwrap();
        let moved = ProjectStore::new(vault.clone(), s.state.clone());
        let target = vault.join("sync").join(&p.project_id).join("README.md");
        std::fs::write(&target, "unresolved mirror edit").unwrap();
        assert!(moved.rebind(&p.project_id, source.to_str().unwrap()).is_err());
        std::fs::write(&target, "[design](docs/a.md)").unwrap();
        let rebound = moved.rebind(&p.project_id, source.to_str().unwrap()).unwrap();
        assert_eq!(rebound.project_id, p.project_id);
        assert_eq!(moved.inbox(&p.project_id).unwrap().len(), 1);
        let review = moved.review(&p.project_id, "moved", "README.md").unwrap();
        assert!(review.source_path.starts_with(source.to_str().unwrap()));
        let records = store::load_records(&moved.records_path());
        assert!(records.records.iter().filter(|r| r.project_id.as_deref() == Some(p.project_id.as_str())).all(|r| r.source_path.starts_with(source.to_str().unwrap()) && r.vault_path.starts_with(vault.to_str().unwrap())));
        assert!(moved.rebind(&p.project_id, vault.join("sync").to_str().unwrap()).is_err());
    }
    #[test]
    fn project_share_paths_and_mirror_lifecycle() {
        assert!(validate_relative("../outside.md").is_err());
        assert!(validate_relative("docs/a.md").is_ok());
        let (_t, s, p) = fixture();
        assert_eq!(
            s.open(&p.source_root, "README.md").unwrap().project_id,
            p.project_id
        );
        let first = freeze(&s, &p);
        assert_eq!(first.files.len(), 2);
        assert!(Path::new(&p.mirror_root).join("docs/a.md").exists());
        freeze(&s, &p);
        assert!(!Path::new(&p.mirror_root).join("docs/a-2.md").exists());
        std::fs::create_dir_all(Path::new(&p.source_root).join("other")).unwrap();
        std::fs::write(Path::new(&p.source_root).join("other/a.md"), "other").unwrap();
        let paths = vec![
            "README.md".to_string(),
            "docs/a.md".to_string(),
            "other/a.md".to_string(),
        ];
        let hashes = paths
            .iter()
            .map(|path| (path.clone(), s.read(&p.project_id, path).unwrap().hash))
            .collect();
        s.snapshot(&p.project_id, paths, hashes).unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.mirror_root).join("other/a.md")).unwrap(),
            "other"
        );
        assert_eq!(mirror_meta::read_all(&s.vault).len(), 3);
        std::fs::write(Path::new(&p.mirror_root).join("docs/a.md"), "local change").unwrap();
        let h = first
            .files
            .iter()
            .map(|f| (f.path.clone(), f.hash.clone()))
            .collect();
        assert!(s
            .snapshot(
                &p.project_id,
                vec!["README.md".into(), "docs/a.md".into()],
                h
            )
            .is_err());
    }
    #[test]
    fn project_share_source_hash_drift_is_rejected() {
        let (_t, s, p) = fixture();
        let h = s.read(&p.project_id, "README.md").unwrap().hash;
        std::fs::write(Path::new(&p.source_root).join("README.md"), "new").unwrap();
        assert!(s
            .snapshot(
                &p.project_id,
                vec!["README.md".into()],
                [("README.md".into(), h)].into()
            )
            .is_err());
    }
    fn envelope(p: &ProjectInfo, snapshot: &ProjectSnapshot, submission: &str) -> FeedbackEnvelope {
        FeedbackEnvelope {
            request_hash: submission.into(),
            received_at: "2026-10-10T00:00:00Z".into(),
            payload: ProjectFeedback {
                schema_version: 1,
                project_id: p.project_id.clone(),
                snapshot_id: snapshot.snapshot_id.clone(),
                submission_id: submission.into(),
                edits: vec![Edit {
                    path: "README.md".into(),
                    base_hash: snapshot
                        .files
                        .iter()
                        .find(|f| f.path == "README.md")
                        .unwrap()
                        .hash
                        .clone(),
                    after_markdown: "accepted text".into(),
                }],
                annotations: vec![],
                name: None,
            },
        }
    }
    #[test]
    fn project_share_forged_and_unknown_baselines_are_quarantined() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut forged = envelope(&p, &snapshot, "forged");
        forged.payload.edits[0].path = "../secret.md".into();
        assert_eq!(
            s.feedback(&p.project_id, forged).unwrap().status,
            "quarantined"
        );
        let mut unknown = envelope(&p, &snapshot, "unknown");
        unknown.payload.snapshot_id = "untrusted".into();
        assert_eq!(
            s.feedback(&p.project_id, unknown).unwrap().status,
            "quarantined"
        );
        let mut bad_hash = envelope(&p, &snapshot, "hash");
        bad_hash.payload.edits[0].base_hash = "fake".into();
        assert_eq!(
            s.feedback(&p.project_id, bad_hash).unwrap().status,
            "quarantined"
        );
        assert_eq!(s.inbox(&p.project_id).unwrap().len(), 3);
    }
    #[test]
    fn project_share_accept_is_idempotent_and_updates_all_raw_mirrors() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let e = envelope(&p, &snapshot, "accept");
        s.feedback(&p.project_id, e.clone()).unwrap();
        std::fs::write(Path::new(&p.source_root).join("docs/image.png"), b"PNG").unwrap();
        let legacy = s.vault.join("legacy.md");
        std::fs::write(&legacy, "legacy baseline").unwrap();
        let source = Path::new(&p.source_root).join("README.md");
        let mut records = store::load_records(&s.records_path());
        records.upsert(Record {
            vault_path: legacy.to_string_lossy().into(),
            source_path: source.to_string_lossy().into(),
            synced_at: 1,
            source_hash: s.read(&p.project_id, "README.md").unwrap().hash,
            vault_hash: sha256_hex(b"legacy baseline"),
            note_merge_base: None,
            project_id: None,
        });
        store::save_records(&s.records_path(), &records).unwrap();
        let review = s.review(&p.project_id, "accept", "README.md").unwrap();
        let accepted = s
            .apply(
                &p.project_id,
                "accept",
                "README.md",
                &review.current_hash,
                "![same](docs/image.png)",
            )
            .unwrap();
        assert_eq!(accepted.status, "accepted");
        assert_eq!(
            std::fs::read_to_string(&legacy).unwrap(),
            "![same](legacy.assets/image.png)"
        );
        assert_eq!(
            std::fs::read(s.vault.join("legacy.assets/image.png")).unwrap(),
            b"PNG"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.source_root).join("README.md")).unwrap(),
            "![same](docs/image.png)"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.mirror_root).join("README.md")).unwrap(),
            "![same](docs/image.png)"
        );
        assert_eq!(
            s.feedback(&p.project_id, e).unwrap().decisions["README.md"].status,
            "accepted"
        );
        let cfg = std::fs::read_to_string(Path::new(&p.mirror_root).join(".notemd/project.json"))
            .unwrap();
        assert!(!cfg.contains(&p.source_root));
    }
    #[test]
    fn project_share_stale_hash_and_mirror_conflict_never_write_source() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snapshot, "stale"))
            .unwrap();
        let review = s.review(&p.project_id, "stale", "README.md").unwrap();
        std::fs::write(&review.source_path, "owner edit").unwrap();
        assert!(s
            .apply(
                &p.project_id,
                "stale",
                "README.md",
                &review.current_hash,
                "guest"
            )
            .is_err());
        let current = s.review(&p.project_id, "stale", "README.md").unwrap();
        std::fs::write(Path::new(&p.mirror_root).join("README.md"), "mirror edit").unwrap();
        assert!(s
            .apply(
                &p.project_id,
                "stale",
                "README.md",
                &current.current_hash,
                "guest"
            )
            .is_err());
        assert_eq!(
            std::fs::read_to_string(&review.source_path).unwrap(),
            "owner edit"
        );
    }
    #[test]
    fn project_share_recovers_crash_after_source_write() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut f = s
            .feedback(&p.project_id, envelope(&p, &snapshot, "crash"))
            .unwrap();
        let review = s.review(&p.project_id, "crash", "README.md").unwrap();
        f.decisions.insert(
            "README.md".into(),
            Decision {
                status: "pending".into(),
                before_hash: Some(review.current_hash),
                result_hash: Some(sha256_hex(b"written before crash")),
                mirrors: BTreeMap::new(),
                content: Some("written before crash".into()),
            },
        );
        let b = s.binding(&p.project_id).unwrap();
        write_json(&s.inbox_path(&b, "crash").unwrap(), &f).unwrap();
        std::fs::write(&review.source_path, "written before crash").unwrap();
        let recovered = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert_eq!(recovered.status, "accepted");
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.mirror_root).join("README.md")).unwrap(),
            "written before crash"
        );
    }
    #[test]
    fn project_share_file_decisions_and_annotation_resolution_persist() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut e = envelope(&p, &snapshot, "partial");
        let second = snapshot
            .files
            .iter()
            .find(|f| f.path == "docs/a.md")
            .unwrap();
        e.payload.edits.push(Edit {
            path: second.path.clone(),
            base_hash: second.hash.clone(),
            after_markdown: "second edit".into(),
        });
        s.feedback(&p.project_id, e.clone()).unwrap();
        let rejected = s
            .reject(&p.project_id, "partial", Some("docs/a.md"))
            .unwrap();
        assert_eq!(rejected.decisions["docs/a.md"].status, "rejected");
        let review = s.review(&p.project_id, "partial", "README.md").unwrap();
        let accepted = s
            .apply(
                &p.project_id,
                "partial",
                "README.md",
                &review.current_hash,
                "first edit",
            )
            .unwrap();
        assert_eq!(accepted.status, "accepted");
        assert_eq!(
            s.feedback(&p.project_id, e).unwrap().decisions["docs/a.md"].status,
            "rejected"
        );
        let mut annotations = envelope(&p, &snapshot, "notes");
        annotations.payload.edits.clear();
        annotations.payload.annotations.push(Annotation {
            path: "docs/a.md".into(),
            quote: "home".into(),
            comment: "review this".into(),
            start: None,
            end: None,
        });
        s.feedback(&p.project_id, annotations.clone()).unwrap();
        assert_eq!(
            s.resolve(&p.project_id, "notes").unwrap().status,
            "resolved"
        );
        assert_eq!(
            s.feedback(&p.project_id, annotations).unwrap().status,
            "resolved"
        );
    }

    #[test]
    fn project_share_frozen_bundle_can_be_reopened_without_rebuilding() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.bundle(
            &p.project_id,
            &snapshot.snapshot_id,
            "<!doctype html>exact frozen bytes",
        )
        .unwrap();
        assert_eq!(
            s.bundle_get(&p.project_id, &snapshot.snapshot_id).unwrap(),
            "<!doctype html>exact frozen bytes"
        );
        assert_eq!(
            s.snapshot_get(&p.project_id, &snapshot.snapshot_id)
                .unwrap()
                .files[0]
                .hash,
            snapshot.files[0].hash
        );
        assert!(s
            .bundle(&p.project_id, &snapshot.snapshot_id, "different bytes")
            .is_err());
        assert!(s.bundle_get(&p.project_id, "../escape").is_err());
    }

    #[test]
    fn review_fix_explicit_mirror_resolution_requires_both_reviewed_hashes() {
        let (_t, s, p) = fixture();
        freeze(&s, &p);
        std::fs::write(
            Path::new(&p.mirror_root).join("README.md"),
            "mirror owner edit",
        )
        .unwrap();
        let view = s.mirror(&p.project_id, "README.md").unwrap();
        assert!(s
            .resolve_mirror(&p.project_id, "README.md", &view.source.hash, "stale")
            .is_err());
        std::fs::write(
            Path::new(&p.source_root).join("README.md"),
            "new source edit",
        )
        .unwrap();
        assert!(s
            .resolve_mirror(
                &p.project_id,
                "README.md",
                &view.source.hash,
                &view.mirror.hash
            )
            .is_err());
        let view = s.mirror(&p.project_id, "README.md").unwrap();
        s.resolve_mirror(
            &p.project_id,
            "README.md",
            &view.source.hash,
            &view.mirror.hash,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.mirror_root).join("README.md")).unwrap(),
            "new source edit"
        );
        let file = s.read(&p.project_id, "README.md").unwrap();
        s.snapshot(
            &p.project_id,
            vec!["README.md".into()],
            [("README.md".into(), file.hash)].into(),
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn review_fix_metadata_failure_after_mirror_write_recovers_without_source_reapply() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snapshot, "metadata-fail"))
            .unwrap();
        let review = s
            .review(&p.project_id, "metadata-fail", "README.md")
            .unwrap();
        let metadata = s.vault.join(".notemd");
        let saved = s.vault.join("metadata-saved");
        std::fs::rename(&metadata, &saved).unwrap();
        std::os::unix::fs::symlink(&saved, &metadata).unwrap();
        let pending = s
            .apply(
                &p.project_id,
                "metadata-fail",
                "README.md",
                &review.current_hash,
                "intent result",
            )
            .unwrap();
        assert_eq!(pending.decisions["README.md"].status, "mirror_pending");
        assert_eq!(
            std::fs::read_to_string(&review.source_path).unwrap(),
            "intent result"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.mirror_root).join("README.md")).unwrap(),
            "intent result"
        );
        assert!(!pending.decisions["README.md"].mirrors.is_empty());
        std::fs::remove_file(&metadata).unwrap();
        std::fs::rename(&saved, &metadata).unwrap();
        let recovered = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert_eq!(recovered.status, "accepted");
        // A third mirror hash remains a conflict even with a valid source result.
        let mut intent = recovered;
        intent.decisions.get_mut("README.md").unwrap().status = "mirror_pending".into();
        write_json(
            &s.inbox_path(&s.binding(&p.project_id).unwrap(), "metadata-fail")
                .unwrap(),
            &intent,
        )
        .unwrap();
        std::fs::write(
            Path::new(&p.mirror_root).join("README.md"),
            "external third version",
        )
        .unwrap();
        let conflicted = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert_eq!(conflicted.decisions["README.md"].status, "mirror_pending");
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.mirror_root).join("README.md")).unwrap(),
            "external third version"
        );
    }

    #[cfg(unix)]
    #[test]
    fn review_fix_canonical_private_aliases_never_share() {
        let (_t, s, p) = fixture();
        for (target, alias) in [
            ("private.note.md", "public.md"),
            (".env", "env.md"),
            (".notemd/private.md", "hidden.md"),
            ("credentials.json", "credentials.md"),
        ] {
            let target_path = Path::new(&p.source_root).join(target);
            std::fs::create_dir_all(target_path.parent().unwrap()).unwrap();
            std::fs::write(&target_path, "secret").unwrap();
            std::os::unix::fs::symlink(&target_path, Path::new(&p.source_root).join(alias))
                .unwrap();
            assert!(
                s.read(&p.project_id, alias).is_err(),
                "private alias accepted: {alias}"
            );
            assert!(!s.list(&p.project_id).unwrap().contains(&alias.to_string()));
        }
    }
    #[cfg(unix)]
    #[test]
    fn review_fix_real_sync_rejects_symlink_target_and_changed_sync_dir() {
        let (t, s, p) = fixture();
        freeze(&s, &p);
        let target = Path::new(&p.mirror_root).join("README.md");
        let outside = t.path().join("outside.md");
        std::fs::copy(&target, &outside).unwrap();
        std::fs::remove_file(&target).unwrap();
        std::os::unix::fs::symlink(&outside, &target).unwrap();
        std::fs::write(Path::new(&p.source_root).join("README.md"), "new source").unwrap();
        assert!(crate::sotvault::apply_update_from_store(
            &s.records_path(),
            &s.vault,
            target.to_str().unwrap()
        )
        .is_err());
        assert_ne!(std::fs::read_to_string(&outside).unwrap(), "new source");
        std::fs::remove_file(&target).unwrap();
        std::fs::write(&target, "[design](docs/a.md)").unwrap();
        let docs = Path::new(&p.mirror_root).join("docs");
        let outside_docs = t.path().join("outside-docs");
        std::fs::rename(&docs, &outside_docs).unwrap();
        std::os::unix::fs::symlink(&outside_docs, &docs).unwrap();
        std::fs::write(
            Path::new(&p.source_root).join("docs/a.md"),
            "changed source docs",
        )
        .unwrap();
        assert!(crate::sotvault::apply_update_from_store(
            &s.records_path(),
            &s.vault,
            docs.join("a.md").to_str().unwrap()
        )
        .is_err());
        assert_ne!(
            std::fs::read_to_string(outside_docs.join("a.md")).unwrap(),
            "changed source docs"
        );
        std::fs::remove_file(&docs).unwrap();
        std::fs::rename(&outside_docs, &docs).unwrap();
        let other_vault = t.path().join("other-vault");
        std::fs::create_dir_all(&other_vault).unwrap();
        assert!(crate::sotvault::apply_update_from_store(
            &s.records_path(),
            &other_vault,
            target.to_str().unwrap()
        )
        .is_err());
        vault_settings::write(
            &s.vault,
            &vault_settings::VaultSettings {
                sync_dir: Some("changed".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(crate::sotvault::apply_update_from_store(
            &s.records_path(),
            &s.vault,
            target.to_str().unwrap()
        )
        .is_err());
    }
    #[test]
    fn review_fix_missing_sibling_file_does_not_quarantine_or_block_a() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut e = envelope(&p, &snapshot, "missing");
        let b = snapshot
            .files
            .iter()
            .find(|f| f.path == "docs/a.md")
            .unwrap();
        e.payload.edits.push(Edit {
            path: b.path.clone(),
            base_hash: b.hash.clone(),
            after_markdown: "B edit".into(),
        });
        std::fs::remove_file(Path::new(&p.source_root).join("docs/a.md")).unwrap();
        assert_eq!(
            s.feedback(&p.project_id, e.clone()).unwrap().status,
            "pending"
        );
        let review = s.review(&p.project_id, "missing", "README.md").unwrap();
        s.apply(
            &p.project_id,
            "missing",
            "README.md",
            &review.current_hash,
            "A edit",
        )
        .unwrap();
        let mut rejected = e;
        rejected.payload.submission_id = "missing-rejected".into();
        rejected.request_hash = "missing-rejected".into();
        s.feedback(&p.project_id, rejected).unwrap();
        s.reject(&p.project_id, "missing-rejected", Some("docs/a.md"))
            .unwrap();
        let a = s
            .review(&p.project_id, "missing-rejected", "README.md")
            .unwrap();
        assert_eq!(
            s.apply(
                &p.project_id,
                "missing-rejected",
                "README.md",
                &a.current_hash,
                "A final edit"
            )
            .unwrap()
            .status,
            "accepted"
        );
        std::fs::write(
            Path::new(&p.source_root).join("docs/a.md"),
            "[home](../README.md)",
        )
        .unwrap();
        let review_b = s.review(&p.project_id, "missing", "docs/a.md").unwrap();
        assert_eq!(
            s.apply(
                &p.project_id,
                "missing",
                "docs/a.md",
                &review_b.current_hash,
                "B edit"
            )
            .unwrap()
            .status,
            "accepted"
        );
    }
    #[test]
    fn review_fix_recovers_written_source_and_mirror_with_old_record() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut f = s
            .feedback(&p.project_id, envelope(&p, &snapshot, "mirror-crash"))
            .unwrap();
        let review = s
            .review(&p.project_id, "mirror-crash", "README.md")
            .unwrap();
        f.decisions.insert(
            "README.md".into(),
            Decision {
                status: "mirror_pending".into(),
                before_hash: Some(review.current_hash),
                result_hash: Some(sha256_hex(b"written result")),
                mirrors: crate::sotvault::plan_source_mirrors(
                    &s.records_path(),
                    &s.vault,
                    &review.source_path,
                    b"written result",
                )
                .unwrap(),
                content: Some("written result".into()),
            },
        );
        let b = s.binding(&p.project_id).unwrap();
        write_json(&s.inbox_path(&b, "mirror-crash").unwrap(), &f).unwrap();
        std::fs::write(&review.source_path, "written result").unwrap();
        std::fs::write(
            Path::new(&p.mirror_root).join("README.md"),
            "written result",
        )
        .unwrap();
        assert_eq!(
            s.inbox(&p.project_id).unwrap().pop().unwrap().status,
            "accepted"
        );
        let records = store::load_records(&s.records_path());
        assert_eq!(
            records
                .find_by_vault(
                    Path::new(&p.mirror_root)
                        .join("README.md")
                        .to_str()
                        .unwrap()
                )
                .unwrap()
                .vault_hash,
            sha256_hex(b"written result")
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_share_rejects_symlink_escape_and_case_collision() {
        let (t, s, p) = fixture();
        std::fs::write(t.path().join("outside.md"), "secret").unwrap();
        std::os::unix::fs::symlink(
            t.path().join("outside.md"),
            Path::new(&p.source_root).join("escape.md"),
        )
        .unwrap();
        assert!(s.read(&p.project_id, "escape.md").is_err());
        let h = s.read(&p.project_id, "README.md").unwrap().hash;
        assert!(s
            .snapshot(
                &p.project_id,
                vec!["README.md".into(), "readme.md".into()],
                [("README.md".into(), h)].into()
            )
            .is_err());
        std::fs::remove_dir_all(Path::new(&p.mirror_root).join(".notemd")).unwrap();
        std::os::unix::fs::symlink(t.path(), Path::new(&p.mirror_root).join(".notemd")).unwrap();
        assert!(s.inbox(&p.project_id).is_err());
    }
}

/// All project Sync entry points use the current Vault configuration and full
/// local binding, rather than trusting an old Record's absolute paths.
pub(crate) fn validate_sync_record(
    records_path: &Path,
    vault: &Path,
    record: &Record,
) -> Result<()> {
    let Some(id) = &record.project_id else {
        return Ok(());
    };
    let service = ProjectStore::new(
        vault.to_path_buf(),
        records_path
            .parent()
            .ok_or("missing state directory")?
            .to_path_buf(),
    );
    let binding = service.binding(id)?;
    service.active(&binding)?;
    service.source_root(&binding.source_root)?;
    let relative = Path::new(&record.vault_path)
        .strip_prefix(&binding.mirror_root)
        .map_err(|_| "mirror outside bound project")?;
    let path = relative.to_str().ok_or("invalid UTF-8 mirror path")?;
    let target = service.mirror_path(&binding, path)?;
    let source = service.source_path(Path::new(&binding.source_root), path)?;
    if target != Path::new(&record.vault_path) || source != Path::new(&record.source_path) {
        return Err("project source/mirror binding mismatch".into());
    }
    Ok(())
}

pub(crate) fn write_project_mirror(
    records_path: &Path,
    vault: &Path,
    record: &Record,
    bytes: &[u8],
) -> Result<()> {
    validate_sync_record(records_path, vault, record)?;
    write_atomic(Path::new(&record.vault_path), bytes)
}

/// A single host API keeps the browser bundle free of desktop dependencies.
#[tauri::command]
pub fn project_share(
    app: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    use tauri::Manager;
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let vault = crate::sotvault::resolve_vault_root(&app)
        .ok_or("Vault not configured")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let service = ProjectStore::new(vault, app.path().app_data_dir().map_err(|e| e.to_string())?);
    fn string<'a>(r: &'a serde_json::Value, key: &str) -> Result<&'a str> {
        r.get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("missing {key}"))
    }
    fn value<T: Serialize>(v: T) -> Result<serde_json::Value> {
        serde_json::to_value(v).map_err(|e| e.to_string())
    }
    let op = string(&request, "op")?;
    if op == "projects" { return value(service.projects()?); }
    if op == "create" { return value(service.create(string(&request, "sourceFile")?)?); }
    if op == "open" {
        return value(service.open(string(&request, "sourceRoot")?, string(&request, "entry")?)?);
    }
    let id = string(&request, "project_id")?;
    match op {
        "get" => value(service.get(id)?),
        "stopped" => { service.stopped(id)?; Ok(serde_json::Value::Null) },
        "begin-delete" => { service.begin_delete(id)?; Ok(serde_json::Value::Null) },
        "cancel-delete" => { service.cancel_delete(id)?; Ok(serde_json::Value::Null) },
        "delete" => { service.delete(id)?; Ok(serde_json::Value::Null) },
        "rebind" => value(service.rebind(id, string(&request, "sourceRoot")?)?),
        "list" => value(service.list(id)?),
        "snapshot-get" => value(service.snapshot_get(id, string(&request, "snapshotId")?)?),
        "bundle-get" => value(service.bundle_get(id, string(&request, "snapshotId")?)?),
        "mirror" => value(service.mirror(id, string(&request, "path")?)?),
        "resolve-mirror" => value(service.resolve_mirror(
            id,
            string(&request, "path")?,
            string(&request, "expectedSourceHash")?,
            string(&request, "expectedMirrorHash")?,
        )?),
        "read" => value(service.read(id, string(&request, "path")?)?),
        "snapshot" => value(
            service.snapshot(
                id,
                serde_json::from_value(request.get("paths").cloned().ok_or("missing paths")?)
                    .map_err(|e| e.to_string())?,
                serde_json::from_value(request.get("hashes").cloned().ok_or("missing hashes")?)
                    .map_err(|e| e.to_string())?,
            )?,
        ),
        "bundle" => {
            service.bundle(
                id,
                string(&request, "snapshotId")?,
                string(&request, "html")?,
            )?;
            Ok(serde_json::Value::Null)
        }
        "published" => value(service.published(
            id,
            string(&request, "snapshotId")?,
            string(&request, "url")?,
        )?),
        "feedback" => value(
            service.feedback(
                id,
                serde_json::from_value(request.get("envelope").cloned().ok_or("missing envelope")?)
                    .map_err(|e| e.to_string())?,
            )?,
        ),
        "inbox" => value(service.inbox(id)?),
        "review" => value(service.review(
            id,
            string(&request, "submissionId")?,
            string(&request, "path")?,
        )?),
        "apply" => value(service.apply(
            id,
            string(&request, "submissionId")?,
            string(&request, "path")?,
            string(&request, "expectedHash")?,
            string(&request, "content")?,
        )?),
        "reject" => value(service.reject(
            id,
            string(&request, "submissionId")?,
            request.get("path").and_then(|v| v.as_str()),
        )?),
        "resolve" => value(service.resolve(id, string(&request, "submissionId")?)?),
        _ => Err(format!("unknown project_share operation: {op}")),
    }
}
