//! Host-owned project mirrors, immutable publication baselines and local review.
use crate::sotvault::{
    logic::sha256_hex,
    mirror_meta,
    store::{self, Record},
    vault_settings,
};
use serde::{Deserialize, Serialize};
pub mod feedback;
pub use feedback::ProjectFeedbackPayload;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use crate::project_share_git as git;

static PROJECT_LOCK: Mutex<()> = Mutex::new(());
// Never acquire a project operation lock while holding PROJECT_LOCK/RecordsLock.
static GIT_LOCKS: OnceLock<Mutex<BTreeMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

const MAX_BYTES: usize = 25 * 1024 * 1024;
const MERGE_KERNEL_VERSION: u32 = 1;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_target: Option<GitTarget>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitTarget { Worktree, Branch, Patch }
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
    #[serde(default)]
    pub parent_snapshot_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub git: Option<SnapshotGit>,
    #[serde(default)]
    pub git_error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotGit {
    pub snapshot_commit: String,
    pub head_at_freeze: String,
    pub prefix: String,
    pub repo_root: String,
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
pub type ProjectFeedbackV1 = ProjectFeedback;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackEnvelope {
    pub payload: ProjectFeedbackPayload,
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
    #[serde(default)]
    pub hunk_summary: Option<HunkSummary>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub git_branch: Option<String>,
    #[serde(default)]
    pub git_commit: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HunkSummary {
    pub accepted: u32,
    pub total: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewDraft {
    pub kernel_version: u32,
    pub ours_hash: String,
    pub hunks: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub target: Option<String>,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptState {
    pub state: String,
    #[serde(default)]
    pub reply: Option<String>,
    #[serde(default)]
    pub sent_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub decided_at: Option<String>,
    #[serde(default)]
    pub included_in_snapshot_id: Option<String>,
    #[serde(default)]
    pub sent_payload_hash: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchIntent {
    pub head: String,
    pub results_hash: String,
    pub commit: String,
    pub branch: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmissionGit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_intent: Option<BranchIntent>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalFeedback {
    pub envelope: FeedbackEnvelope,
    pub status: String,
    pub error: Option<String>,
    pub decisions: BTreeMap<String, Decision>,
    #[serde(default)]
    pub review: BTreeMap<String, ReviewDraft>,
    #[serde(default)]
    pub annotation_decisions: BTreeMap<String, String>,
    #[serde(default)]
    pub receipt: Option<ReceiptState>,
    #[serde(default)]
    pub git: Option<SubmissionGit>,
    #[serde(default)]
    pub superseded_by: Option<String>,
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
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Binding {
    #[serde(default)]
    generation: u64,
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
    #[serde(default)]
    git_target: Option<GitTarget>,
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
fn is_finder_metadata(path: &Path, kind: std::fs::FileType) -> bool {
    kind.is_file() && path.file_name() == Some(std::ffi::OsStr::new(".DS_Store"))
}
/// Remove only reserved files and disposable Finder metadata in managed directories.
/// A new user file appearing after preflight keeps its directory nonempty and stops
/// cleanup; recursive deletion must never consume concurrent user work.
fn remove_reserved_tree(root: &Path, files: &BTreeMap<String, String>) -> Result<()> {
    match std::fs::symlink_metadata(root) {
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => return Err(format!("unsafe deletion directory: {}", root.display())),
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    }
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
        let metadata = safe_destination(root, &directory.strip_prefix(root).map_err(|e| e.to_string())?.join(".DS_Store"))?;
        match std::fs::symlink_metadata(&metadata) {
            Ok(meta) if is_finder_metadata(&metadata, meta.file_type()) => std::fs::remove_file(&metadata).map_err(io_error)?,
            Ok(_) => return Err(format!("unsafe Finder metadata: {}", metadata.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
        match std::fs::remove_dir(&directory) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(format!("directory contains unremoved content; preserve before retry: {}: {error}", directory.display())),
        }
    }
    Ok(())
}
/// Persist directory entries where the platform supports ordinary directory handles.
/// Non-Unix retains atomic rename visibility and file fsync, but makes no promise
/// of directory-entry durability after power loss.
pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    std::fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
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
        sync_directory(parent)
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
            git_target: c.git_target,
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
        let received = vault.join("received");
        for protected in [received.clone(), received.canonicalize().unwrap_or(received)] {
            if source.starts_with(&protected) || (source != vault && protected.starts_with(&source)) {
                return Err("project source and received directories cannot overlap".into());
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
        let received = vault.join("received");
        let received_actual = received.canonicalize().unwrap_or_else(|_| received.clone());
        // Check the requested path before resolving it: an absent Sync target is unsafe too.
        let requested = root.join(relative);
        if requested.starts_with(&received) || requested.starts_with(&received_actual) {
            return Err("UNSAFE_PATH: received is not a project source".into());
        }
        if requested.starts_with(&sync) { return Err("UNSAFE_PATH: Sync is not a project source".into()); }
        for ancestor in requested.ancestors().take_while(|p| *p != root) {
            if let Ok(target) = ancestor.canonicalize() {
                if target.starts_with(&received) || target.starts_with(&received_actual) {
                    return Err("UNSAFE_PATH: received alias is not a project source".into());
                }
                if target.starts_with(&sync) { return Err("UNSAFE_PATH: Sync alias is not a project source".into()); }
            }
        }
        let actual = safe_source(root, relative)?;
        if actual.starts_with(&received) || actual.starts_with(&received_actual) {
            return Err("UNSAFE_PATH: received is not a project source".into());
        }
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
                git_target: None, source_available: Some(false), deleting: entry.get("deleting").and_then(|v| v.as_bool()), error: Some(error),
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
            generation: 0,
            project_id: id.clone(), source_root: source.to_string_lossy().into(),
            mirror_root: self.vault.join(vault_settings::resolve_sync_dir(&self.vault)).join(&id).to_string_lossy().into(), deleting: false, deletion_files: None, deletion_requires_stop: false,
        };
        let c = Config { project_id: id, entry: entry.into(), files: vec![], published_snapshot_id: None, url: None, git_target: None };
        write_json(&self.management(&b, "project.json")?, &c)?;
        bindings.push(b.clone());
        write_json(&self.bindings_path(), &bindings)?;
        self.info(&b)
    }
    pub fn stopped(&self, id: &str) -> Result<()> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        let mut bindings = self.bindings()?;
        let current = bindings.iter_mut().find(|v| v.project_id == id).ok_or("project binding missing")?;
        current.generation = current.generation.wrapping_add(1);
        write_json(&self.bindings_path(), &bindings)?;
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
        binding.generation = binding.generation.wrapping_add(1);
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
        binding.generation = binding.generation.wrapping_add(1);
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
                    if is_finder_metadata(&entry.path(), entry.file_type().map_err(io_error)?) { continue; }
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
                    if local.envelope.payload.project_id() != b.project_id || local.envelope.payload.submission_id() != name {
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
                    if is_finder_metadata(&path, kind) { continue; }
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
        let b = Binding { generation: old.generation.wrapping_add(1), project_id: id.into(), source_root: source.to_string_lossy().into(),
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
            schema_version: 2,
            project_id: id.into(),
            snapshot_id: snapshot_id.clone(),
            entry: c.entry.clone(),
            files,
            parent_snapshot_id: c.published_snapshot_id.clone(),
            created_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
            git: None,
            git_error: None,
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
        if !matches!(s.schema_version, 1 | 2) {
            return Err("unsupported snapshot schema".into());
        }
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
    fn validate_feedback(&self, b: &Binding, feedback: &ProjectFeedbackPayload) -> Result<()> {
        feedback.validate_shape()?;
        if feedback.project_id() != b.project_id {
            return Err("feedback identity mismatch".into());
        }
        let s = self.baseline(b, feedback.snapshot_id())?;
        let mut seen = HashSet::new();
        for edit in feedback.edits() {
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
        for note in feedback.annotations_normalized() {
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
        if !self.config(b)?.files.iter().any(|shared| shared == path) {
            return Err("file outside current shared scope".into());
        }
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
        let path = self.inbox_path(&b, envelope.payload.submission_id())?;
        if path.exists() {
            let mut existing: LocalFeedback = read_json(&path)?;
            if existing.envelope.request_hash != envelope.request_hash
                || serde_json::to_value(&existing.envelope.payload).ok()
                    != serde_json::to_value(&envelope.payload).ok()
            {
                return Err("submission ID has different content".into());
            }
            self.recover(&b, &mut existing)?;
            self.recompute_supersedes(&b)?;
            return self.feedback_metadata(&b, envelope.payload.submission_id());
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
            review: BTreeMap::new(),
            annotation_decisions: BTreeMap::new(),
            receipt: None,
            git: None,
            superseded_by: None,
        };
        // Persist the original before trust validation; failed validation is retained in quarantine.
        write_json(&path, &local)?;
        if let Err(e) = self.validate_feedback(&b, &local.envelope.payload) {
            local.status = "quarantined".into();
            local.error = Some(e);
        }
        write_json(&path, &local)?;
        if local.status == "quarantined" { return Ok(local); }
        self.recompute_supersedes(&b)?;
        self.feedback_metadata(&b, local.envelope.payload.submission_id())
    }
    fn feedback_metadata(&self, b: &Binding, submission: &str) -> Result<LocalFeedback> {
        let f: LocalFeedback = read_json(&self.inbox_path(b, submission)?)?;
        if f.envelope.payload.project_id() != b.project_id || f.envelope.payload.submission_id() != submission {
            return Err("feedback identity mismatch".into());
        }
        Ok(f)
    }
    fn feedback_metadata_list(&self, b: &Binding) -> Result<Vec<LocalFeedback>> {
        let dir = self.management(b, "inbox")?;
        if !dir.exists() { return Ok(vec![]); }
        let mut out = vec![];
        for entry in std::fs::read_dir(dir).map_err(io_error)? {
            let path = entry.map_err(io_error)?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                out.push(self.feedback_metadata(b, path.file_stem().and_then(|s| s.to_str()).ok_or("invalid inbox filename")?)?);
            }
        }
        out.sort_by(|a, b| a.envelope.received_at.cmp(&b.envelope.received_at).then(a.envelope.payload.submission_id().cmp(b.envelope.payload.submission_id())));
        Ok(out)
    }
    pub fn feedback_readonly(&self, id: &str, submission: &str) -> Result<LocalFeedback> {
        let _lock = self.lock()?; let b = self.binding(id)?; self.active(&b)?;
        self.feedback_metadata(&b, submission)
    }
    pub fn feedback_list_readonly(&self, id: &str) -> Result<Vec<LocalFeedback>> {
        let _lock = self.lock()?; let b = self.binding(id)?; self.active(&b)?;
        self.feedback_metadata_list(&b)
    }
    pub fn receipt_set(&self, id: &str, submission: &str, receipt: ReceiptState) -> Result<LocalFeedback> {
        let _lock = self.lock()?; let b = self.binding(id)?; self.active(&b)?;
        if !["auto", "suppressed", "sent", "failed"].contains(&receipt.state.as_str())
            || receipt.reply.as_ref().is_some_and(|s| s.encode_utf16().count() > 2000 || s.contains('\0'))
            || receipt.sent_payload_hash.as_ref().is_some_and(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))) {
            return Err("invalid receipt state: state, reply or payload hash".into());
        }
        let mut f = self.feedback_metadata(&b, submission)?;
        f.receipt = Some(receipt);
        write_json(&self.inbox_path(&b, submission)?, &f)?;
        Ok(f)
    }
    // Hints are presentation metadata only. Recompute over all trusted records for any arrival order.
    fn recompute_supersedes(&self, b: &Binding) -> Result<()> {
        let mut items = self.feedback_metadata_list(b)?;
        let mut successors = BTreeMap::new();
        for f in &items {
            if f.status == "quarantined" || self.validate_feedback(b, &f.envelope.payload).is_err() { continue; }
            if let ProjectFeedbackPayload::V2(v) = &f.envelope.payload {
                if let Some(previous) = &v.supersedes { successors.insert(previous.clone(), v.submission_id.clone()); }
            }
        }
        for f in &mut items {
            let successor = if f.status == "quarantined" { None } else { successors.get(f.envelope.payload.submission_id()).cloned() };
            if f.superseded_by != successor {
                f.superseded_by = successor;
                write_json(&self.inbox_path(b, f.envelope.payload.submission_id())?, f)?;
            }
        }
        Ok(())
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
        } else if !f.envelope.payload.edits().is_empty()
            && f.envelope.payload.edits().iter().all(|e| {
                f.decisions
                    .get(&e.path)
                    .is_some_and(|d| matches!(d.status.as_str(), "accepted" | "rejected" | "branched"))
            })
        {
            f.status = if f.decisions.values().any(|d| d.status == "branched") {
                "branched"
            } else if f.decisions.values().any(|d| d.status == "accepted") {
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
                        write_json(&self.inbox_path(b, f.envelope.payload.submission_id())?, f)?;
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
                    f.review.remove(&path);
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
        write_json(&self.inbox_path(b, f.envelope.payload.submission_id())?, f)
    }
    pub fn inbox(&self, id: &str) -> Result<Vec<LocalFeedback>> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.recompute_supersedes(&b)?;
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
        self.review_file(&b, &f, path)
    }
    fn feedback_for_review_target(
        &self,
        b: &Binding,
        submission: &str,
        git_target: bool,
    ) -> Result<LocalFeedback> {
        if !git_target {
            return self.load_feedback(b, submission);
        }
        let f: LocalFeedback = read_json(&self.inbox_path(b, submission)?)?;
        if f.envelope.payload.project_id() != b.project_id
            || f.envelope.payload.submission_id() != submission
        {
            return Err("feedback identity mismatch".into());
        }
        ensure_no_worktree_intent(&f)?;
        Ok(f)
    }
    pub fn review_readonly(&self, id: &str, submission: &str, path: &str) -> Result<ReviewFile> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        let f = self.feedback_for_review_target(&b, submission, true)?;
        self.review_file(&b, &f, path)
    }
    fn review_file(&self, b: &Binding, f: &LocalFeedback, path: &str) -> Result<ReviewFile> {
        if f.status == "quarantined" {
            return Err("feedback quarantined".into());
        }
        self.validate_feedback(&b, &f.envelope.payload)?;
        let s = self.baseline(&b, f.envelope.payload.snapshot_id())?;
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
            .edits()
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
    pub fn review_save(
        &self,
        id: &str,
        submission: &str,
        path: &str,
        draft: ReviewDraft,
    ) -> Result<LocalFeedback> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        if serde_json::to_vec(&draft).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
            return Err("review draft too large".into());
        }
        if draft.kernel_version != MERGE_KERNEL_VERSION {
            return Err("kernel version mismatch".into());
        }
        if draft
            .target
            .as_deref()
            .is_some_and(|t| !matches!(t, "worktree" | "branch" | "patch"))
        {
            return Err("invalid review target".into());
        }
        let git_target = draft
            .target
            .as_deref()
            .is_some_and(|target| matches!(target, "branch" | "patch"));
        let mut f = self.feedback_for_review_target(&b, submission, git_target)?;
        if f.status == "quarantined" {
            return Err("feedback quarantined".into());
        }
        self.validate_feedback(&b, &f.envelope.payload)?;
        if !f.envelope.payload.edits().iter().any(|e| e.path == path) {
            return Err("no edit for this file".into());
        }
        f.review.insert(path.into(), draft);
        write_json(&self.inbox_path(&b, submission)?, &f)?;
        Ok(f)
    }
    pub fn annotation_decide(
        &self,
        id: &str,
        submission: &str,
        index: usize,
        value: &str,
    ) -> Result<LocalFeedback> {
        self.annotation_decide_target(id, submission, index, value, None)
    }
    fn annotation_decide_target(
        &self,
        id: &str,
        submission: &str,
        index: usize,
        value: &str,
        target: Option<GitTarget>,
    ) -> Result<LocalFeedback> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        let mut f = self.feedback_for_review_target(
            &b,
            submission,
            matches!(target, Some(GitTarget::Branch | GitTarget::Patch)),
        )?;
        if f.status == "quarantined" {
            return Err("feedback quarantined".into());
        }
        self.validate_feedback(&b, &f.envelope.payload)?;
        if index >= f.envelope.payload.annotations_normalized().len() {
            return Err("annotation index out of range".into());
        }
        if !matches!(value, "promoted" | "dismissed") {
            return Err("invalid annotation decision".into());
        }
        f.annotation_decisions
            .insert(index.to_string(), value.into());
        write_json(&self.inbox_path(&b, submission)?, &f)?;
        Ok(f)
    }
    pub fn apply(
        &self,
        id: &str,
        submission: &str,
        path: &str,
        expected: &str,
        content: &str,
        summary: Option<HunkSummary>,
    ) -> Result<LocalFeedback> {
        let _lock = self.lock()?;
        if content.len() > MAX_BYTES {
            return Err("content exceeds 25 MiB".into());
        }
        if summary.as_ref().is_some_and(|s| s.accepted > s.total) {
            return Err("invalid hunk summary".into());
        }
        let b = self.binding(id)?;
        self.active(&b)?;
        let mut f = self.load_feedback(&b, submission)?;
        if f.status == "quarantined" {
            return Err("feedback quarantined".into());
        }
        self.validate_feedback(&b, &f.envelope.payload)?;
        if !f.envelope.payload.edits().iter().any(|e| e.path == path)
            && !f.envelope.payload.annotations_normalized().iter().any(|a| a.path == path)
        {
            return Err("no edit or annotation for this file".into());
        }
        if let Some(d) = f.decisions.get(path) {
            if d.status == "accepted" || d.status == "mirror_pending" {
                return Ok(f);
            }
            if d.status == "rejected" || d.status == "recovery_conflict" || d.status == "branched" {
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
            hunk_summary: summary,
            ..Default::default()
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
    pub fn reject(&self, id: &str, submission: &str, path: Option<&str>, reason: Option<&str>) -> Result<LocalFeedback> {
        self.reject_target(id, submission, path, reason, None)
    }
    fn reject_target(&self, id: &str, submission: &str, path: Option<&str>, reason: Option<&str>, target: Option<GitTarget>) -> Result<LocalFeedback> {
        let _lock = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        if reason.is_some_and(|r| r != "superseded") {
            return Err("invalid reject reason".into());
        }
        let mut f = self.feedback_for_review_target(&b, submission, matches!(target, Some(GitTarget::Branch | GitTarget::Patch)))?;
        if let Some(p) = path {
            if !f.envelope.payload.edits().iter().any(|e| e.path == p) {
                return Err("file outside feedback".into());
            }
        }
        for e in f.envelope.payload.edits() {
            if path.is_some_and(|p| p != e.path) {
                continue;
            }
            if f.decisions.get(&e.path).is_some_and(|d| {
                matches!(
                    d.status.as_str(),
                    "accepted" | "mirror_pending" | "recovery_conflict" | "branched"
                )
            }) {
                continue;
            }
            f.decisions.insert(
                e.path.clone(),
                Decision {
                    status: "rejected".into(),
                    reason: reason.map(String::from),
                    ..Default::default()
                },
            );
        }
        Self::recompute(&mut f);
        if path.is_none() && f.envelope.payload.edits().is_empty() && f.status != "quarantined" {
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
        if f.status == "quarantined" || !f.envelope.payload.edits().is_empty() {
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

    #[cfg(unix)]
    #[test]
    fn project_share_directory_sync_propagates_unix_open_and_sync_errors() {
        let temp = TempDir::new().unwrap();
        sync_directory(temp.path()).unwrap();
        assert!(sync_directory(&temp.path().join("missing-directory")).is_err());
        // /dev/null opens successfully, but fsync is unsupported: the helper must
        // propagate that error as well as the open failure above.
        assert!(std::fs::File::open("/dev/null").is_ok());
        assert!(sync_directory(Path::new("/dev/null")).is_err());
    }
    #[test]
    fn project_share_atomic_writer_preserves_source_on_readonly_and_rename_errors() {
        let temp = TempDir::new().unwrap();
        let file = temp.path().join("source.md");
        let original = "\u{feff}source\r\n".as_bytes();
        write_atomic(&file, original).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), original);
        let permissions = std::fs::metadata(&file).unwrap().permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&file, readonly).unwrap();
        assert!(write_atomic(&file, b"replacement").is_err());
        assert_eq!(std::fs::read(&file).unwrap(), original);
        std::fs::set_permissions(&file, permissions).unwrap();
        let directory = temp.path().join("existing-directory");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("user.md"), original).unwrap();
        assert!(write_atomic(&directory, b"replacement").is_err());
        assert_eq!(std::fs::read(directory.join("user.md")).unwrap(), original);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
    }
    #[test]
    fn project_share_received_source_and_vault_reference_isolation() {
        let (_t, s, _) = fixture();
        let received = s.vault.join("received/share.example/pid");
        std::fs::create_dir_all(&received).unwrap();
        std::fs::write(received.join("README.md"), "guest source").unwrap();
        assert!(s.create(received.join("README.md").to_str().unwrap()).is_err());
        assert!(s.source_root(received.to_str().unwrap()).is_err());
        assert!(s.source_path(&s.vault, "received/share.example/pid/README.md").is_err());
        #[cfg(unix)] {
            let alias = s.vault.join("guest-alias");
            std::os::unix::fs::symlink(&received, &alias).unwrap();
            assert!(s.source_root(alias.to_str().unwrap()).is_err());
            assert!(s.source_path(&s.vault, "guest-alias/README.md").is_err());
        }
        assert_eq!(std::fs::read(received.join("README.md")).unwrap(), b"guest source");
    }
    #[test]
    fn project_share_receipt_metadata_never_recovers_and_survives_restart() {
        let (t, s, p) = git_fixture(); let snap = git_freeze(&s, &p);
        let mut f = git_import(&s, &p, &snap, "receipt");
        let b = s.binding(&p.project_id).unwrap(); let path = s.inbox_path(&b, "receipt").unwrap();
        let before = std::fs::read(Path::new(&p.source_root).join("README.md")).unwrap();
        let mirror = s.mirror_path(&b, "README.md").unwrap(); let mirror_bytes = std::fs::read(&mirror).unwrap();
        f.decisions.insert("README.md".into(), Decision { status: "pending".into(), before_hash: Some(sha256_hex(&before)), result_hash: Some(sha256_hex(b"unfinished")), content: Some("unfinished".into()), ..Default::default() });
        write_json(&path, &f).unwrap();
        let state = p1_state(Path::new(&p.source_root)); let disk = std::fs::read(&path).unwrap();
        for op in ["feedback-readonly", "feedback-list-readonly"] {
            let result = execute_request(&s, &serde_json::json!({"op":op,"project_id":p.project_id,"submissionId":"receipt"}));
            assert!(result.is_ok(), "{op}: {result:?}");
            assert_eq!(std::fs::read(&path).unwrap(), disk);
        }
        for target in ["branch", "patch"] {
            execute_request(&s, &serde_json::json!({"op":"git-target","project_id":p.project_id,"target":target})).unwrap();
            let result = execute_request(&s, &serde_json::json!({"op":"receipt-set","project_id":p.project_id,"submissionId":"receipt","receipt":{"state":"auto","reply":"谢谢","decided_at":"2026-10-13T00:00:00Z","sent_payload_hash":"a".repeat(64)}})).unwrap();
            assert_eq!(result["decisions"]["README.md"]["status"], "pending");
            assert_eq!(p1_state(Path::new(&p.source_root)), state);
            assert_eq!(std::fs::read(&mirror).unwrap(), mirror_bytes);
        }
        let restarted = ProjectStore::new(t.path().join("vault"), t.path().join("state"));
        let saved = execute_request(&restarted, &serde_json::json!({"op":"feedback-readonly","project_id":p.project_id,"submissionId":"receipt"})).unwrap();
        assert_eq!(saved["receipt"]["reply"], "谢谢"); assert_eq!(saved["receipt"]["decided_at"], "2026-10-13T00:00:00Z");
        assert_eq!(saved["receipt"]["sent_payload_hash"], "a".repeat(64));
        for receipt in [serde_json::json!({"state":"unknown"}), serde_json::json!({"state":"auto","reply":"😀".repeat(1001)})] {
            let error = execute_request(&s, &serde_json::json!({"op":"receipt-set","project_id":p.project_id,"submissionId":"receipt","receipt":receipt})).unwrap_err();
            assert!(error.starts_with("invalid receipt state"), "{error}");
        }
        s.begin_delete(&p.project_id).unwrap();
        for op in ["feedback-readonly", "feedback-list-readonly", "receipt-set"] {
            assert!(execute_request(&s, &serde_json::json!({"op":op,"project_id":p.project_id,"submissionId":"receipt","receipt":{"state":"auto"}})).unwrap_err().contains("deletion"));
        }
    }
    #[test]
    fn project_share_receipt_payload_hash_metadata_validates_defaults_and_survives_restart() {
        let (t, s, p) = fixture(); let snap = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snap, "hash")).unwrap();
        let request = |hash: serde_json::Value| serde_json::json!({"op":"receipt-set","project_id":p.project_id,"submissionId":"hash","receipt":{"state":"sent","sent_payload_hash":hash}});
        let saved = execute_request(&s, &request("a".repeat(64).into())).unwrap();
        assert_eq!(saved["receipt"]["sent_payload_hash"], "a".repeat(64));
        let restarted = ProjectStore::new(t.path().join("vault"), t.path().join("state"));
        let reread = execute_request(&restarted, &serde_json::json!({"op":"feedback-readonly","project_id":p.project_id,"submissionId":"hash"})).unwrap();
        assert_eq!(reread["receipt"]["sent_payload_hash"], "a".repeat(64));
        for invalid in ["a".repeat(63), "g".repeat(64), "SECRET_BODY".into()] {
            assert!(execute_request(&s, &request(invalid.into())).unwrap_err().starts_with("invalid receipt state"));
        }
        let legacy = execute_request(&s, &serde_json::json!({"op":"receipt-set","project_id":p.project_id,"submissionId":"hash","receipt":{"state":"auto"}})).unwrap();
        assert!(legacy["receipt"]["sent_payload_hash"].is_null());
    }
    #[test]
    fn project_share_receipt_set_waits_for_records_lock_and_reads_legacy_state() {
        let (_t, s, p) = fixture(); let snap = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snap, "lock")).unwrap();
        let legacy: ReceiptState = serde_json::from_value(serde_json::json!({"state":"auto"})).unwrap();
        assert!(legacy.decided_at.is_none() && legacy.included_in_snapshot_id.is_none());
        let held = s.lock().unwrap();
        let worker = ProjectStore::new(s.vault.clone(), s.state.clone()); let id = p.project_id.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel(); let (done_tx, done_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || { started_tx.send(()).unwrap(); done_tx.send(worker.receipt_set(&id,"lock",legacy)).unwrap(); });
        started_rx.recv().unwrap();
        assert!(done_rx.recv_timeout(std::time::Duration::from_millis(50)).is_err());
        drop(held); done_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap(); thread.join().unwrap();
    }
    #[test]
    fn project_share_supersedes_arrival_order_quarantine_and_cycles() {
        for reverse in [false, true] {
            let (_t, s, p) = fixture(); let snap = freeze(&s, &p);
            let v2 = |id: &str, previous: &str| { let mut value = serde_json::to_value(envelope(&p, &snap, id)).unwrap(); value["payload"]["schemaVersion"] = 2.into(); value["payload"].as_object_mut().unwrap().remove("name"); value["payload"]["supersedes"] = previous.into(); serde_json::from_value::<FeedbackEnvelope>(value).unwrap() };
            if reverse { s.feedback(&p.project_id, v2("new", "old")).unwrap(); }
            s.feedback(&p.project_id, envelope(&p, &snap, "old")).unwrap();
            if !reverse { s.feedback(&p.project_id, v2("new", "old")).unwrap(); }
            let list = s.inbox(&p.project_id).unwrap(); let old = list.iter().find(|f| f.envelope.payload.submission_id() == "old").unwrap();
            assert_eq!(old.superseded_by.as_deref(), Some("new")); assert!(old.decisions.is_empty() && old.review.is_empty()); assert_eq!(old.status,"pending");
            assert!(s.review(&p.project_id, "old", "README.md").is_ok());
            let mut bad = v2("bad", "old"); if let ProjectFeedbackPayload::V2(v) = &mut bad.payload { v.edits[0].base_hash = "0".repeat(64); }
            assert_eq!(s.feedback(&p.project_id, bad).unwrap().status,"quarantined");
            assert_eq!(s.inbox(&p.project_id).unwrap().iter().find(|f| f.envelope.payload.submission_id() == "old").unwrap().superseded_by.as_deref(),Some("new"));
            assert_eq!(s.feedback(&p.project_id, v2("self", "self")).unwrap().status,"quarantined");
            s.feedback(&p.project_id, v2("cycle-a", "cycle-b")).unwrap(); s.feedback(&p.project_id, v2("cycle-b", "cycle-a")).unwrap();
            assert!(s.inbox(&p.project_id).unwrap().iter().all(|f| f.decisions.is_empty()));
            let mut protected = s.feedback(&p.project_id, envelope(&p, &snap, "protected")).unwrap();
            protected.decisions.insert("README.md".into(), Decision { status: "rejected".into(), ..Default::default() });
            protected.review.insert("README.md".into(), review_draft());
            let b = s.binding(&p.project_id).unwrap(); write_json(&s.inbox_path(&b,"protected").unwrap(), &protected).unwrap();
            let decisions = serde_json::to_value(&protected.decisions).unwrap(); let review = serde_json::to_value(&protected.review).unwrap();
            let source = p1_bytes(Path::new(&p.source_root));
            s.feedback(&p.project_id, v2("replacement", "protected")).unwrap();
            let saved = s.feedback_readonly(&p.project_id,"protected").unwrap();
            assert_eq!(saved.superseded_by.as_deref(),Some("replacement"));
            assert_eq!(serde_json::to_value(saved.decisions).unwrap(), decisions); assert_eq!(serde_json::to_value(saved.review).unwrap(),review);
            assert_eq!(p1_bytes(Path::new(&p.source_root)),source);

        }
    }
    fn git_test(repo: &Path, args: &[&str]) -> String {
        String::from_utf8(crate::vault_sync::git_ops::run_git_io(repo, args, &[], None).unwrap())
            .unwrap()
            .trim_end()
            .into()
    }
    fn git_fixture() -> (TempDir, ProjectStore, ProjectInfo) {
        let (t, s, p) = fixture();
        let root = Path::new(&p.source_root);
        git_test(root, &["init", "-b", "main"]);
        git_test(root, &["config", "user.name", "Owner"]);
        git_test(root, &["config", "user.email", "owner@example.test"]);
        git_test(root, &["add", "."]);
        git_test(root, &["commit", "-m", "initial"]);
        (t, s, p)
    }
    fn git_freeze(s: &ProjectStore, p: &ProjectInfo) -> ProjectSnapshot {
        let hashes: BTreeMap<_, _> = ["README.md", "docs/a.md"]
            .iter()
            .map(|path| (path.to_string(), s.read(&p.project_id, path).unwrap().hash))
            .collect();
        serde_json::from_value(execute_request(s, &serde_json::json!({"op":"snapshot", "project_id":p.project_id,"paths":["README.md","docs/a.md"],"hashes":hashes})).unwrap()).unwrap()
    }
    fn git_import(
        s: &ProjectStore,
        p: &ProjectInfo,
        snap: &ProjectSnapshot,
        id: &str,
    ) -> LocalFeedback {
        let mut e = envelope(p, snap, id);
        e.payload.v1_mut().name = Some("Visitor\nNotemd-Project: forged\nCo-authored-by: forged".into());
        serde_json::from_value(
            execute_request(
                s,
                &serde_json::json!({"op":"feedback","project_id":p.project_id,"envelope":e}),
            )
            .unwrap(),
        )
        .unwrap()
    }
    fn real_git_state(root: &Path) -> (Vec<u8>, String, String, Vec<u8>, Vec<u8>) {
        (
            crate::vault_sync::git_ops::run_git_io(
                root,
                &["status", "--porcelain=v1", "-z"],
                &[("GIT_OPTIONAL_LOCKS", "0")],
                None,
            )
            .unwrap(),
            git_test(root, &["rev-parse", "HEAD"]),
            git_test(root, &["symbolic-ref", "HEAD"]),
            std::fs::read(root.join(".git/index")).unwrap(),
            std::fs::read(root.join(".git/config")).unwrap(),
        )
    }
    fn p1_bytes(root: &Path) -> BTreeMap<String, Vec<u8>> {
        fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path == root.join(".git") { continue; }
                if path.is_dir() { visit(root, &path, out); }
                else { out.insert(path.strip_prefix(root).unwrap().to_string_lossy().into(), std::fs::read(path).unwrap()); }
            }
        }
        let mut bytes = BTreeMap::new();
        visit(root, root, &mut bytes);
        bytes
    }
    fn p1_state(root: &Path) -> (BTreeMap<String, Vec<u8>>, Option<Vec<u8>>, String, String, Vec<u8>, BTreeMap<String, Vec<u8>>) {
        (p1_bytes(root), std::fs::read(root.join(".git/index")).ok(),
         git_test(root, &["rev-parse", "HEAD"]), git_test(root, &["symbolic-ref", "HEAD"]),
         std::fs::read(root.join(".git/config")).unwrap(), p1_bytes(&root.join(".git/hooks")))
    }
    #[test]
    fn project_share_git_p1_full_business_preserves_bytes_with_or_without_real_index() {
        for has_index in [true, false] {
            let (_t, s, p) = git_fixture();
            let root = Path::new(&p.source_root);
            std::fs::write(root.join("README.md"), "staged snapshot").unwrap();
            git_test(root, &["add", "README.md"]);
            std::fs::write(root.join("README.md"), "unstaged snapshot\r\n").unwrap();
            std::fs::write(root.join("untracked.bin"), b"\0private\xff\r\n").unwrap();
            std::fs::write(root.join(".git/hooks/pre-commit"), b"#!/bin/sh\nexit 99\n").unwrap();
            if !has_index { std::fs::remove_file(root.join(".git/index")).unwrap(); }
            let before = p1_state(root);
            let snap = git_freeze(&s, &p);
            assert_eq!(before, p1_state(root), "freeze index={has_index}");
            git_import(&s, &p, &snap, "bytes");
            assert_eq!(before, p1_state(root), "import index={has_index}");
            let mirror_before = p1_bytes(Path::new(&p.mirror_root));
            let prepared = execute_git_request(&s, &serde_json::json!({"op":"prepare","project_id":p.project_id,"submissionId":"bytes"})).unwrap();
            for op in ["export-patch", "branch"] {
                execute_git_request(&s, &serde_json::json!({"op":op,"project_id":p.project_id,"submissionId":"bytes","expectedHead":prepared["head"],"results":{"README.md":"approved"}})).unwrap();
                assert_eq!(before, p1_state(root), "{op} index={has_index}");
                let after = p1_bytes(Path::new(&p.mirror_root));
                for (path, bytes) in &mirror_before {
                    if !path.starts_with(".notemd/") { assert_eq!(after.get(path), Some(bytes), "mirror {path}"); }
                }
            }
        }
    }
    #[test]
    fn project_share_git_p1_other_decisions_fail_closed_without_refs_or_writes() {
        let (_t, s, p) = git_fixture();
        let root = Path::new(&p.source_root);
        let snap = git_freeze(&s, &p);
        for status in ["accepted", "rejected", "branched", "pending", "mirror_pending", "source_changed", "recovery_conflict", "quarantined", "unknown"] {
            let mut f = git_import(&s, &p, &snap, status);
            f.decisions.insert("README.md".into(), Decision { status: status.into(), ..Default::default() });
            write_json(&s.inbox_path(&s.binding(&p.project_id).unwrap(), status).unwrap(), &f).unwrap();
            for op in ["branch", "export-patch"] {
                if status == "branched" && op == "export-patch" { continue; }
                let before = p1_state(root);
                let refs = git_test(root, &["show-ref"]);
                let mirror = p1_bytes(Path::new(&p.mirror_root));
                assert!(execute_git_request(&s, &serde_json::json!({"op":op,"project_id":p.project_id,"submissionId":status,"expectedHead":before.2,"results":{"README.md":"forbidden"}})).is_err(), "{status} {op}");
                assert_eq!(refs, git_test(root, &["show-ref"]));
                assert_eq!(before, p1_state(root));
                assert_eq!(mirror, p1_bytes(Path::new(&p.mirror_root)));
            }
        }
    }
    #[test]
    fn project_share_git_p1_user_same_candidate_oid_still_collides_without_intent() {
        let (_t, s, p) = git_fixture();
        let root = Path::new(&p.source_root);
        let snap = git_freeze(&s, &p);
        git_import(&s, &p, &snap, "same-oid");
        let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let capture = captured.clone();
        let owned_root = root.to_path_buf();
        hook(move |_, phase| {
            if phase == "review-built" {
                let unreachable = git_test(&owned_root, &["fsck", "--unreachable", "--no-reflogs"]);
                let commits: Vec<_> = unreachable.lines().filter_map(|l| l.strip_prefix("unreachable commit ")).collect();
                assert_eq!(commits.len(), 1, "only the just-built review commit is unreachable");
                *capture.lock().unwrap() = commits[0].into();
                git_test(&owned_root, &["update-ref", "refs/heads/notemd/readme/same-oid", commits[0]]);
            }
        });
        let result = execute_git_request(&s, &serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"same-oid","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved"}}));
        unhook();
        let result = result.unwrap();
        assert_eq!(result["branch"], "notemd/readme/same-oid-2");
        assert_eq!(result["commit"].as_str().unwrap(), captured.lock().unwrap().as_str());
        assert_eq!(git_test(root, &["rev-parse", "refs/heads/notemd/readme/same-oid"]), result["commit"].as_str().unwrap());
    }
    #[test]
    fn project_share_git_p1_store_branch_collisions_same_oid_suffixes_and_exhaustion() {
        let (_t, s, p) = git_fixture();
        let root = Path::new(&p.source_root);
        let snap = git_freeze(&s, &p);
        let original = git_import(&s, &p, &snap, "collisions");
        let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "collisions").unwrap();
        let request = serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"collisions","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved"}});
        let first = execute_git_request(&s, &request).unwrap();
        let base = first["branch"].as_str().unwrap();
        let oid = first["commit"].as_str().unwrap();
        // Removing our persisted intent leaves an ordinary user-owned same-OID branch.
        // It must collide, even though its commit was originally produced by this request.
        for n in 2..=9 {
            write_json(&path, &original).unwrap();
            let result = execute_git_request(&s, &request).unwrap();
            assert_eq!(result["branch"], format!("{base}-{n}"));
            assert_eq!(git_test(root, &["rev-parse", &format!("refs/heads/{base}")]), oid);
        }
        write_json(&path, &original).unwrap();
        let refs = git_test(root, &["show-ref"]);
        assert!(execute_git_request(&s, &request).unwrap_err().contains("all nine"));
        assert_eq!(refs, git_test(root, &["show-ref"]));
        let after: LocalFeedback = read_json(&path).unwrap();
        assert!(after.git.unwrap().branch_intent.is_none());
    }
    #[test]
    fn project_share_git_p1_store_subdirectory_prefix_and_patch_real_git_am() {
        p1_patch_am_for_name("Visitor\nNotemd-Project: forged\nCo-authored-by: forged");
    }
    #[test]
    fn project_share_git_p1_unicode_author_survives_real_git_am() {
        p1_patch_am_for_name(&"中文访客".repeat(20));
    }
    #[test]
    fn project_share_git_p1_at_author_survives_real_git_am() {
        p1_patch_am_for_name("Visitor@example.test");
    }
    #[test]
    fn project_share_git_p1_boundary_and_normal_author_survive_real_git_am() {
        for name in ["Visitor".to_string(), "a".repeat(40), "a".repeat(41), format!("{}中", "a".repeat(39)), "@<>\n".to_string()] {
            p1_patch_am_for_name(&name);
        }
    }
    fn p1_patch_am_for_name(name: &str) { p1_patch_am_for_payload(name, false); }
    #[test]
    fn project_share_v2_git_author_uses_existing_sanitization() {
        p1_patch_am_for_payload("Visitor@example.test", true);
    }
    fn p1_patch_am_for_payload(name: &str, v2: bool) {
        let (t, s, p) = git_fixture();
        let root = Path::new(&p.source_root);
        let sub = root.join("nested space");
        std::fs::create_dir_all(sub.join("docs")).unwrap();
        std::fs::write(sub.join("README.md"), "nested original\n").unwrap();
        std::fs::write(sub.join("docs/a.md"), "nested other\n").unwrap();
        git_test(root, &["add", "."]);
        git_test(root, &["commit", "-m", "nested project"]);
        let p = s.open(sub.to_str().unwrap(), "README.md").unwrap();
        let snap = git_freeze(&s, &p);
        assert_eq!(snap.git.as_ref().unwrap().prefix, "nested space/");
        let mut envelope = envelope(&p, &snap, "patch-am");
        envelope.payload.v1_mut().name = Some(name.into());
        if v2 {
            let mut payload = serde_json::to_value(&envelope.payload).unwrap();
            payload["schemaVersion"] = serde_json::json!(2);
            payload.as_object_mut().unwrap().remove("name");
            payload["contributor"] = serde_json::json!({"name":name});
            envelope.payload = serde_json::from_value(payload).unwrap();
        }
        execute_request(&s, &serde_json::json!({"op":"feedback","project_id":p.project_id,"envelope":envelope})).unwrap();
        let head = git_test(root, &["rev-parse", "HEAD"]);
        let patch = execute_git_request(&s, &serde_json::json!({"op":"export-patch","project_id":p.project_id,"submissionId":"patch-am","expectedHead":head,"results":{"README.md":"nested approved\n"}})).unwrap();
        let destination = t.path().join("am target");
        git_test(root, &["clone", "--local", "--no-hardlinks", root.to_str().unwrap(), destination.to_str().unwrap()]);
        git_test(&destination, &["config", "user.name", "Receiver"]);
        git_test(&destination, &["config", "user.email", "receiver@example.test"]);
        crate::vault_sync::git_ops::run_git_io(&destination, &["am"], &[], Some(patch["patch"].as_str().unwrap().as_bytes())).unwrap();
        assert_eq!(std::fs::read_to_string(destination.join("nested space/README.md")).unwrap(), "nested approved\n");
        assert_eq!(std::fs::read(destination.join("README.md")).unwrap(), std::fs::read(root.join("README.md")).unwrap());
        let applied_author = git_test(&destination, &["show", "-s", "--format=%an|%ae"]);
        assert!(applied_author.contains("guest, unverified"), "{applied_author}\n{}", patch["patch"]);
        let expected_author = git::guest_author(Some(name), "patch-am", "2026-10-10T00:00:00Z");
        let literal = match name {
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" | "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" => Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (guest, unverified)|patch-am@guest.notemd.invalid"),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa中" => Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (guest, unverified)|patch-am@guest.notemd.invalid"),
            "Visitor@example.test" => Some("Visitorexample.test (guest, unverified)|patch-am@guest.notemd.invalid"),
            "Visitor" => Some("Visitor (guest, unverified)|patch-am@guest.notemd.invalid"),
            "@<>\n" => Some("guest (guest, unverified)|patch-am@guest.notemd.invalid"),
            _ => None,
        };
        if let Some(expected) = literal { assert_eq!(applied_author, expected); }
        else { assert_eq!(applied_author, format!("{}|{}", expected_author.name, expected_author.email)); }
        assert!(expected_author.name.len() <= 60);
        if name == "Visitor" { assert_eq!(expected_author.name, "Visitor (guest, unverified)"); }
        if name == "@<>\n" { assert_eq!(expected_author.name, "guest (guest, unverified)"); }
        let local = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert_eq!(local.envelope.payload.contributor_name(), Some(name));
        assert_eq!(git_test(&destination, &["rev-parse", "HEAD^"]), head);
    }
    #[test]
    fn project_share_git_p1_store_fallback_non_git_bare_unborn_keeps_p0() {
        for kind in ["non-git", "bare", "unborn"] {
            let (_t, s, p) = fixture();
            let root = Path::new(&p.source_root);
            match kind {
                "bare" => { git_test(root, &["init", "--bare"]); }
                "unborn" => { git_test(root, &["init", "-b", "main"]); }
                _ => ()
            }
            let snap = git_freeze(&s, &p);
            assert!(snap.git.is_none(), "{kind}");
            git_import(&s, &p, &snap, kind);
            let before = s.read(&p.project_id, "README.md").unwrap().hash;
            let result = s.apply(&p.project_id, kind, "README.md", &before, "P0 approved", None).unwrap();
            assert_eq!(result.decisions["README.md"].status, "accepted");
            assert_eq!(std::fs::read_to_string(root.join("README.md")).unwrap(), "P0 approved");
        }
    }
    #[test]
    fn project_share_git_p1_store_clean_eol_blobs_match_real_git_add() {
        for kind in ["autocrlf", "eol", "clean"] {
            let (_t, s, p) = git_fixture();
            let root = Path::new(&p.source_root);
            match kind {
                "autocrlf" => { git_test(root, &["config", "core.autocrlf", "true"]); }
                "eol" => { std::fs::write(root.join(".gitattributes"), "*.md text eol=lf\n").unwrap(); }
                _ => {
                    git_test(root, &["config", "filter.test.clean", "sed 's/^/clean:/'"]);
                    git_test(root, &["config", "filter.test.required", "true"]);
                    std::fs::write(root.join(".gitattributes"), "*.md filter=test\n").unwrap();
                }
            }
            std::fs::write(root.join("README.md"), "snapshot\r\ntext\r\n").unwrap();
            let snap = git_freeze(&s, &p);
            git_import(&s, &p, &snap, kind);
            let result = execute_git_request(&s, &serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":kind,"expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved\r\ntext\r\n"}})).unwrap();
            git_test(root, &["add", "README.md"]);
            assert_eq!(git_test(root, &["rev-parse", ":README.md"]), git_test(root, &["rev-parse", &format!("{}:README.md", snap.git.unwrap().snapshot_commit)]), "snapshot {kind}");
            std::fs::write(root.join("README.md"), "approved\r\ntext\r\n").unwrap();
            git_test(root, &["add", "README.md"]);
            assert_eq!(git_test(root, &["rev-parse", ":README.md"]), git_test(root, &["rev-parse", &format!("{}:README.md", result["commit"].as_str().unwrap())]), "branch {kind}");
        }
    }
    #[test]
    fn project_share_git_p1_recovered_not_applied_allows_branch_and_patch() {
        for op in ["branch", "export-patch"] {
            let (_t, s, p) = git_fixture();
            let root = Path::new(&p.source_root);
            let snap = git_freeze(&s, &p);
            let mut e = envelope(&p, &snap, "recovered");
            e.payload.v1_mut().edits.push(Edit { path: "docs/a.md".into(), base_hash: snap.files.iter().find(|f| f.path == "docs/a.md").unwrap().hash.clone(), after_markdown: "second result".into() });
            let mut f: LocalFeedback = serde_json::from_value(execute_request(&s, &serde_json::json!({"op":"feedback","project_id":p.project_id,"envelope":e})).unwrap()).unwrap();
            let before = std::fs::read(root.join("README.md")).unwrap();
            f.decisions.insert("README.md".into(), Decision {
                status: "pending".into(), before_hash: Some(sha256_hex(&before)),
                result_hash: Some(sha256_hex(b"interrupted result")),
                content: Some("interrupted result".into()), ..Default::default()
            });
            let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "recovered").unwrap();
            write_json(&path, &f).unwrap();
            let recovered = s.inbox(&p.project_id).unwrap().pop().unwrap();
            assert_eq!(recovered.decisions["README.md"].status, "not_applied");
            let mut draft = review_draft();
            draft.target = Some(if op == "branch" { "branch" } else { "patch" }.into());
            draft.ours_hash = sha256_hex(&before);
            s.review_save(&p.project_id, "recovered", "README.md", draft).unwrap();
            let prepared = execute_git_request(&s, &serde_json::json!({"op":"prepare","project_id":p.project_id,"submissionId":"recovered"})).unwrap();
            let result = execute_git_request(&s, &serde_json::json!({"op":op,"project_id":p.project_id,"submissionId":"recovered","expectedHead":prepared["head"],"results":{"README.md":"approved after recovery","docs/a.md":"second result"}}));
            let result = result.unwrap();
            if op == "branch" {
                assert!(result.get("stateError").is_none(), "{result}");
                for edit in recovered.envelope.payload.edits() {
                    assert_eq!(result["feedback"]["decisions"][&edit.path]["status"], "branched");
                    let retry = serde_json::json!({"op":"git-branched","project_id":p.project_id,"submissionId":"recovered","path":edit.path,"branch":result["branch"],"commit":result["commit"]});
                    let a = execute_request(&s, &retry).unwrap();
                    assert_eq!(a, execute_request(&s, &retry).unwrap());
                }
            } else {
                let saved: LocalFeedback = read_json(&path).unwrap();
                assert_eq!(saved.decisions["README.md"].status, "not_applied");
                assert!(!saved.decisions.contains_key("docs/a.md"));
            }
            assert_eq!(std::fs::read(root.join("README.md")).unwrap(), before);
        }
    }
    #[test]
    fn project_share_git_final_m1_snapshot_message_and_legacy_ref_never_overwritten() {
        let (_t, s, p) = git_fixture();
        let root = Path::new(&p.source_root);
        let snap = git_freeze(&s, &p);
        let meta = snap.git.as_ref().unwrap();
        assert_eq!(git_test(root, &["show", "-s", "--format=%B", &meta.snapshot_commit]),
            format!("notemd: share snapshot {}\n\nNotemd-Project: {}\nNotemd-Snapshot: {}", snap.snapshot_id, p.project_id, snap.snapshot_id));
        let repo = git::probe(root).unwrap().unwrap();
        let job = short_lock(|| s.capture_share_job(&p.project_id, &snap.snapshot_id, None)).unwrap();
        let author = git::owner_author(&repo, snap.created_at.as_deref().unwrap()).unwrap();
        let old = git::build_commit(&repo, &meta.head_at_freeze, &job.files, &format!("notemd: snapshot {}\n", snap.snapshot_id), Some(&author)).unwrap();
        let name = format!("refs/notemd/share/{}/snapshots/{}", p.project_id, snap.snapshot_id);
        git_test(root, &["update-ref", &name, &old, &meta.snapshot_commit]);
        let outcome = run_share_job(&s, &job, Ok(Some(repo))).unwrap_err();
        assert!(outcome.contains("different content or identity"));
        short_lock(|| s.finish_share_job(&job, &Err(outcome))).unwrap();
        let saved = s.snapshot_get(&p.project_id, &snap.snapshot_id).unwrap();
        assert!(saved.git.is_none()); assert!(saved.git_error.is_some());
        assert_eq!(saved.files.len(), 2);
        assert_eq!(git_test(root, &["rev-parse", &name]), old);
    }
    #[test]
    fn project_share_git_final_m2_same_tree_ref_and_decision_free() {
        for normalized in [false, true] {
            let (_t, s, p) = git_fixture(); let root = Path::new(&p.source_root);
            if normalized {
                git_test(root, &["config", "filter.upper.clean", "tr a-z A-Z"]);
                std::fs::write(root.join(".gitattributes"), "README.md filter=upper\n").unwrap();
                std::fs::write(root.join("README.md"), "NORMALIZED\n").unwrap();
                git_test(root, &["add", "."]); git_test(root, &["commit", "-m", "filter"]);
            }
            let snap = git_freeze(&s, &p); git_import(&s, &p, &snap, "same-tree");
            let head = git_test(root, &["rev-parse", "HEAD"]);
            let content = if normalized { "normalized\n".into() } else { std::fs::read_to_string(root.join("README.md")).unwrap() };
            for op in ["branch", "export-patch"] {
                let before = p1_state(root); let mirrors = p1_bytes(Path::new(&p.mirror_root)); let refs = git_test(root, &["show-ref"]);
                let result = execute_git_request(&s, &serde_json::json!({"op":op,"project_id":p.project_id,"submissionId":"same-tree","expectedHead":head,"results":{"README.md":content}}));
                assert!(result.is_err_and(|e| e.contains("no changes")), "{op}/{normalized}");
                assert_eq!(before, p1_state(root)); assert_eq!(mirrors, p1_bytes(Path::new(&p.mirror_root))); assert_eq!(refs, git_test(root, &["show-ref"]));
            }
        }
    }
    #[test]
    fn project_share_git_final_i4_reject_late_annotation_intent_is_readonly() {
        for target in ["branch", "patch"] {
            for status in ["pending", "mirror_pending"] {
                let (_t, s, p) = annotation_git_fixture();
                let b = s.binding(&p.project_id).unwrap(); let inbox = s.inbox_path(&b, "late-intent").unwrap();
                let mut f: LocalFeedback = read_json(&inbox).unwrap(); f.review.insert("docs/a.md".into(), review_draft()); write_json(&inbox, &f).unwrap();
                execute_request(&s, &serde_json::json!({"op":"review-readonly","project_id":p.project_id,"submissionId":"late-intent","path":"README.md"})).unwrap();
                inject_annotation_worktree_intent(&s, &p.project_id, status);
                let source = p1_state(Path::new(&p.source_root)); let mirrors = p1_bytes(Path::new(&p.mirror_root));
                let result = execute_request(&s, &serde_json::json!({"op":"reject","project_id":p.project_id,"submissionId":"late-intent","path":"README.md","target":target}));
                assert!(result.is_err_and(|e| e.contains("worktree")), "{target}/{status}");
                assert_eq!(source, p1_state(Path::new(&p.source_root))); assert_eq!(mirrors, p1_bytes(Path::new(&p.mirror_root)));
                let recovered = execute_request(&s, &serde_json::json!({"op":"reject","project_id":p.project_id,"submissionId":"late-intent","path":"README.md"})).unwrap();
                assert_eq!(recovered["decisions"]["README.md"]["status"], "rejected");
                assert_eq!(recovered["decisions"]["docs/a.md"]["status"], if status == "pending" { "not_applied" } else { "accepted" });
            }
        }
    }
    #[test]
    fn project_share_git_final_i2_reopen_owned_branch_pure_query_and_only_record() {
        for partial in [false, true] {
            let (_t, s, p) = git_fixture(); let root = Path::new(&p.source_root); let snap = git_freeze(&s, &p);
            let mut e = envelope(&p, &snap, "reopen");
            e.payload.v1_mut().edits.push(Edit { path: "docs/a.md".into(), base_hash: snap.files.iter().find(|f| f.path == "docs/a.md").unwrap().hash.clone(), after_markdown: "second result".into() });
            execute_request(&s, &serde_json::json!({"op":"feedback","project_id":p.project_id,"envelope":e})).unwrap();
            assert!(execute_git_request(&s, &serde_json::json!({"op":"branch-state","project_id":p.project_id,"submissionId":"reopen"})).unwrap().is_null());
            let b = s.binding(&p.project_id).unwrap(); let path = s.inbox_path(&b, "reopen").unwrap(); let backup = path.with_extension("saved");
            let ph = path.clone(); let bh = backup.clone();
            hook(move |_, phase| { if phase == "branch-ref-created" { std::fs::rename(&ph, &bh).unwrap(); std::fs::create_dir(&ph).unwrap(); } });
            let first = execute_git_request(&s, &serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"reopen","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved","docs/a.md":"second result"}}));
            unhook(); let first = first.unwrap(); assert!(first["stateError"].is_string());
            std::fs::remove_dir(&path).unwrap(); std::fs::rename(&backup, &path).unwrap();
            let record = |file: &str| serde_json::json!({"op":"git-branched","project_id":p.project_id,"submissionId":"reopen","path":file,"branch":first["branch"],"commit":first["commit"]});
            if partial {
                execute_request(&s, &record("README.md")).unwrap();
                let ph = path.clone(); let bh = backup.clone();
                hook(move |_, phase| { if phase == "branch-state-verified" { std::fs::rename(&ph, &bh).unwrap(); std::fs::create_dir(&ph).unwrap(); } });
                let failed = execute_request(&s, &record("docs/a.md")); unhook(); assert!(failed.is_err());
                std::fs::remove_dir(&path).unwrap(); std::fs::rename(&backup, &path).unwrap();
            }
            std::fs::write(root.join("advance.md"), "new HEAD").unwrap(); git_test(root, &["add", "advance.md"]); git_test(root, &["commit", "-m", "advance HEAD"]);
            let reopened = ProjectStore::new(s.vault.clone(), s.state.clone());
            let before = p1_state(root); let mirrors = p1_bytes(Path::new(&p.mirror_root)); let refs = git_test(root, &["show-ref"]);
            let state = execute_git_request(&reopened, &serde_json::json!({"op":"branch-state","project_id":p.project_id,"submissionId":"reopen"})).unwrap();
            assert_eq!(state["branch"], first["branch"]); assert_eq!(state["commit"], first["commit"]); assert!(state["stateError"].is_string());
            assert_eq!(before, p1_state(root)); assert_eq!(mirrors, p1_bytes(Path::new(&p.mirror_root))); assert_eq!(refs, git_test(root, &["show-ref"]));
            let name = format!("refs/heads/{}", first["branch"].as_str().unwrap());
            git_test(root, &["update-ref", "-d", &name]);
            let missing_refs = git_test(root, &["show-ref"]);
            assert!(execute_git_request(&reopened, &serde_json::json!({"op":"branch-state","project_id":p.project_id,"submissionId":"reopen"})).unwrap().is_null());
            assert_eq!(mirrors, p1_bytes(Path::new(&p.mirror_root))); assert_eq!(missing_refs, git_test(root, &["show-ref"]));
            git_test(root, &["update-ref", &name, first["commit"].as_str().unwrap()]);
            for file in ["README.md", "docs/a.md"] { execute_request(&reopened, &record(file)).unwrap(); }
            let complete = execute_git_request(&reopened, &serde_json::json!({"op":"branch-state","project_id":p.project_id,"submissionId":"reopen"})).unwrap();
            assert!(complete.get("stateError").is_none()); assert_eq!(complete["feedback"]["status"], "branched"); assert_eq!(refs, git_test(root, &["show-ref"]));
            git_test(root, &["update-ref", &format!("refs/heads/{}", first["branch"].as_str().unwrap()), &git_test(root, &["rev-parse", "HEAD"])]);
            assert!(execute_git_request(&reopened, &serde_json::json!({"op":"branch-state","project_id":p.project_id,"submissionId":"reopen"})).unwrap_err().contains("ref changed"));
        }
    }
    #[test]
    fn project_share_git_final_i2_p0_snapshot_without_git_metadata_recovers_owned_branch() {
        let (_t, s, p) = fixture(); let root = Path::new(&p.source_root);
        let snap = git_freeze(&s, &p); assert!(snap.git.is_none());
        git_test(root, &["init", "-b", "main"]); git_test(root, &["config", "user.name", "Owner"]); git_test(root, &["config", "user.email", "owner@example.test"]);
        git_test(root, &["add", "."]); git_test(root, &["commit", "-m", "initialized after freeze"]);
        git_import(&s, &p, &snap, "p0-snapshot");
        let result = execute_git_request(&s, &serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"p0-snapshot","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved"}})).unwrap();
        let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "p0-snapshot").unwrap(); let mut f: LocalFeedback = read_json(&path).unwrap(); f.decisions.clear(); write_json(&path, &f).unwrap();
        let before = p1_bytes(Path::new(&p.mirror_root)); let refs = git_test(root, &["show-ref"]);
        let state = execute_git_request(&s, &serde_json::json!({"op":"branch-state","project_id":p.project_id,"submissionId":"p0-snapshot"})).unwrap();
        assert_eq!(state["commit"], result["commit"]); assert!(state["stateError"].is_string()); assert_eq!(before, p1_bytes(Path::new(&p.mirror_root))); assert_eq!(refs, git_test(root, &["show-ref"]));
        let saved = execute_request(&s, &serde_json::json!({"op":"git-branched","project_id":p.project_id,"submissionId":"p0-snapshot","path":"README.md","branch":result["branch"],"commit":result["commit"]})).unwrap();
        assert_eq!(saved["decisions"]["README.md"]["status"], "branched"); assert_eq!(refs, git_test(root, &["show-ref"]));
    }
    #[test]
    fn project_share_git_final_i2_latest_guards_and_full_identity_fail_closed() {
        for change in ["scope", "binding", "intent", "decision", "worktree", "snapshot", "envelope", "stop", "ref"] {
            let (_t, s, p) = git_fixture(); let root = Path::new(&p.source_root); let snap = git_freeze(&s, &p);
            git_import(&s, &p, &snap, "query-guards");
            let result = execute_git_request(&s, &serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"query-guards","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved"}})).unwrap();
            let b = s.binding(&p.project_id).unwrap(); let inbox = s.inbox_path(&b, "query-guards").unwrap();
            let mut f: LocalFeedback = read_json(&inbox).unwrap(); f.decisions.clear(); write_json(&inbox, &f).unwrap();
            let query = serde_json::json!({"op":"branch-state","project_id":p.project_id,"submissionId":"query-guards"});
            let original = read_bytes(&inbox).unwrap();
            // A real same-OID user branch without owned intent is not a recoverable result.
            f.git.as_mut().unwrap().branch_intent = None; write_json(&inbox, &f).unwrap();
            assert!(execute_git_request(&s, &query).unwrap().is_null()); write_atomic(&inbox, &original).unwrap();
            let id = p.project_id.clone(); let branch = result["branch"].as_str().unwrap().to_string();
            let after = Arc::new(Mutex::new(None)); let ah = after.clone();
            hook(move |s, phase| {
                if phase != "branch-state-verified" { return; }
                let b = s.binding(&id).unwrap(); let path = s.inbox_path(&b, "query-guards").unwrap();
                match change {
                    "scope" => { let mut c = s.config(&b).unwrap(); c.files.retain(|p| p != "README.md"); write_json(&s.management(&b, "project.json").unwrap(), &c).unwrap(); }
                    "binding" => { let mut bindings = s.bindings().unwrap(); bindings.iter_mut().find(|v| v.project_id == id).unwrap().generation += 1; write_json(&s.bindings_path(), &bindings).unwrap(); }
                    "stop" => { s.stopped(&id).unwrap(); }
                    "snapshot" => { let mut snap = s.baseline(&b, &snap.snapshot_id).unwrap(); snap.entry = "docs/a.md".into(); write_json(&s.management(&b, &format!("snapshots/{}/manifest.json", snap.snapshot_id)).unwrap(), &snap).unwrap(); }
                    "ref" => { git_test(Path::new(&b.source_root), &["update-ref", &format!("refs/heads/{branch}"), &git_test(Path::new(&b.source_root), &["rev-parse", "HEAD"])]); }
                    _ => {
                        let mut f: LocalFeedback = read_json(&path).unwrap();
                        match change {
                            "intent" => f.git.as_mut().unwrap().branch_intent.as_mut().unwrap().results_hash = "different".into(),
                            "decision" => { f.decisions.insert("README.md".into(), Decision { status: "accepted".into(), ..Default::default() }); },
                            "worktree" => { f.decisions.insert("docs/a.md".into(), Decision { status: "pending".into(), ..Default::default() }); },
                            "envelope" => f.envelope.payload.v1_mut().name = Some("changed".into()),
                            _ => unreachable!(),
                        }
                        write_json(&path, &f).unwrap();
                    }
                }
                *ah.lock().unwrap() = Some(p1_bytes(Path::new(&b.mirror_root)));
            });
            let result = execute_git_request(&s, &query); unhook();
            assert!(result.is_err(), "latest {change} must reject");
            assert_eq!(after.lock().unwrap().as_ref().unwrap(), &p1_bytes(Path::new(&p.mirror_root)), "query must not mutate after {change}");
        }
    }
    #[test]
    fn project_share_git_final_i2_owned_commit_identity_and_snapshot_ref_checked() {
        for changed in ["parent", "author", "message", "snapshot-ref"] {
            let (_t, s, p) = git_fixture(); let root = Path::new(&p.source_root); let snap = git_freeze(&s, &p);
            git_import(&s, &p, &snap, "identity");
            let result = execute_git_request(&s, &serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"identity","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved"}})).unwrap();
            let b = s.binding(&p.project_id).unwrap(); let path = s.inbox_path(&b, "identity").unwrap(); let mut f: LocalFeedback = read_json(&path).unwrap();
            f.decisions.clear();
            if changed == "snapshot-ref" {
                git_test(root, &["update-ref", &format!("refs/notemd/share/{}/snapshots/{}", p.project_id, snap.snapshot_id), result["commit"].as_str().unwrap()]);
            } else {
                let raw = git_test(root, &["cat-file", "commit", result["commit"].as_str().unwrap()]);
                let raw = match changed {
                    "parent" => raw.lines().map(|line| if line.starts_with("parent ") { format!("parent {}", snap.git.as_ref().unwrap().snapshot_commit) } else { line.into() }).collect::<Vec<_>>().join("\n"),
                    "author" => raw.replace("author ", "author Forged "),
                    _ => raw.replace("notemd: suggestion", "forged: suggestion"),
                } + "\n";
                let oid = String::from_utf8(crate::vault_sync::git_ops::run_git_io(root, &["hash-object", "-t", "commit", "-w", "--stdin"], &[], Some(raw.as_bytes())).unwrap()).unwrap(); let oid = oid.trim();
                let intent = f.git.as_mut().unwrap().branch_intent.as_mut().unwrap(); intent.commit = oid.into();
                git_test(root, &["update-ref", &format!("refs/heads/{}", intent.branch), oid]);
            }
            write_json(&path, &f).unwrap();
            let before = p1_bytes(Path::new(&p.mirror_root)); let refs = git_test(root, &["show-ref"]);
            let error = execute_git_request(&s, &serde_json::json!({"op":"branch-state","project_id":p.project_id,"submissionId":"identity"})).unwrap_err();
            assert!(error.contains(if changed == "snapshot-ref" { "snapshot ref mismatch" } else { "identity mismatch" }), "{changed}: {error}");
            assert_eq!(before, p1_bytes(Path::new(&p.mirror_root))); assert_eq!(refs, git_test(root, &["show-ref"]));
        }
    }
    #[cfg(unix)]
    #[test]
    fn project_share_git_final_i2_query_subprocess_runs_outside_both_locks() {
        use std::os::unix::fs::PermissionsExt;
        let (t, s, p) = git_fixture(); let root = Path::new(&p.source_root); let snap = git_freeze(&s, &p);
        git_import(&s, &p, &snap, "query-locks");
        execute_git_request(&s, &serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"query-locks","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved"}})).unwrap();
        let script = t.path().join("waiting-git"); let ready = t.path().join("ready"); let release = t.path().join("release");
        std::fs::write(&script, "#!/bin/sh\ncase \"$*\" in *'%P%x00%an'*) touch \"$TEST_READY\"; while [ ! -f \"$TEST_RELEASE\" ]; do sleep 0.01; done;; esac\nexec git \"$@\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let worker = ProjectStore::new(s.vault.clone(), s.state.clone()); let id = p.project_id.clone(); let ready_arg = ready.clone(); let release_arg = release.clone();
        let query = std::thread::spawn(move || crate::vault_sync::git_ops::with_test_git_io(&script, vec![("TEST_READY".into(), ready_arg.to_string_lossy().into()), ("TEST_RELEASE".into(), release_arg.to_string_lossy().into())], || execute_git_request(&worker, &serde_json::json!({"op":"branch-state","project_id":id,"submissionId":"query-locks"}))));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !ready.exists() && std::time::Instant::now() < deadline { std::thread::sleep(std::time::Duration::from_millis(10)); }
        assert!(ready.exists(), "actual query Git child must be waiting");
        let worker = ProjectStore::new(s.vault.clone(), s.state.clone()); let (tx, rx) = std::sync::mpsc::channel();
        let locker = std::thread::spawn(move || { short_lock(|| { let _records = worker.lock()?; Ok(()) }).unwrap(); tx.send(()).unwrap(); });
        let free = rx.recv_timeout(std::time::Duration::from_secs(5)); std::fs::write(release, "").unwrap();
        let result = query.join().unwrap(); locker.join().unwrap(); free.expect("both locks free while branch-state Git child runs"); result.unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn project_share_git_final_i3_unavailable_capability_and_missing_tree_keep_p0() {
        use std::os::unix::fs::PermissionsExt;
        for old in [true, false] {
            let (t, s, mut p) = git_fixture(); let origin = Path::new(&p.source_root).to_path_buf();
            let trace = t.path().join("transport.log");
            let script = t.path().join("old-git");
            if old {
                std::fs::write(&script, "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = --no-lazy-fetch ]; then echo unsupported >&2; exit 129; fi; done\nexec git \"$@\"\n").unwrap();
                std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
            } else {
                git_test(&origin, &["config", "uploadpack.allowFilter", "true"]);
                let dest = t.path().join("partial-source");
                git_test(&origin, &["clone", "--filter=tree:0", "--no-checkout", &format!("file://{}", origin.display()), dest.to_str().unwrap()]);
                git_test(&dest, &["config", "user.name", "Owner"]); git_test(&dest, &["config", "user.email", "owner@example.test"]);
                std::fs::create_dir(dest.join("docs")).unwrap(); std::fs::copy(origin.join("README.md"), dest.join("README.md")).unwrap(); std::fs::copy(origin.join("docs/a.md"), dest.join("docs/a.md")).unwrap();
                p = s.open(dest.to_str().unwrap(), "README.md").unwrap();
            }
            let program = if old { script.as_path() } else { Path::new("git") };
            crate::vault_sync::git_ops::with_test_git_io(program, vec![("GIT_TRACE".into(), trace.to_string_lossy().into())], || {
                let snap = git_freeze(&s, &p); assert!(snap.git.is_none());
                if !old { assert!(snap.git_error.is_some()); }
                git_import(&s, &p, &snap, "fallback");
                let before = s.read(&p.project_id, "README.md").unwrap().hash;
                assert_eq!(s.apply(&p.project_id, "fallback", "README.md", &before, "P0 still works", None).unwrap().decisions["README.md"].status, "accepted");
            });
            let trace = std::fs::read_to_string(trace).unwrap_or_default();
            assert!(!trace.contains(" fetch ") && !trace.contains("upload-pack"), "{trace}");
        }
    }
    #[test]
    fn project_share_git_store_freeze_import_metadata_and_isolation() {
        let (_t, s, p) = git_fixture();
        let root = Path::new(&p.source_root);
        std::fs::write(root.join("README.md"), "unstaged snapshot bytes").unwrap();
        let before = real_git_state(root);
        let snap = git_freeze(&s, &p);
        let meta = snap.git.as_ref().expect("Git snapshot metadata");
        assert_eq!(meta.head_at_freeze, before.1);
        assert_eq!(
            git_test(root, &["rev-parse", &format!("{}^", meta.snapshot_commit)]),
            before.1
        );
        assert_eq!(
            git_test(
                root,
                &["show", &format!("{}:README.md", meta.snapshot_commit)]
            ),
            "unstaged snapshot bytes"
        );
        assert_eq!(before, real_git_state(root));
        let feedback = git_import(&s, &p, &snap, "submission-one");
        let oid = feedback.git.as_ref().unwrap().commit.as_ref().unwrap();
        assert_eq!(
            git_test(root, &["rev-parse", &format!("{oid}^")]),
            meta.snapshot_commit
        );
        let identity = git_test(
            root,
            &["show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%B", oid],
        );
        assert!(identity.contains("guest, unverified"));
        assert!(identity.contains("Owner\nowner@example.test"));
        assert_eq!(
            identity
                .lines()
                .filter(|l| l.starts_with("Notemd-Project:"))
                .count(),
            1
        );
        assert!(identity.contains("Notemd-AI-Assisted: unknown"));
        let mut draft = review_draft();
        draft.updated_at = "newest".into();
        s.review_save(&p.project_id, "submission-one", "README.md", draft)
            .unwrap();
        let retry = git_import(&s, &p, &snap, "submission-one");
        assert_eq!(retry.git.as_ref().unwrap().commit.as_ref(), Some(oid));
        assert_eq!(retry.review["README.md"].updated_at, "newest");
        let mut bad = envelope(&p, &snap, "quarantine");
        bad.payload.v1_mut().edits[0].base_hash = "forged".into();
        let bad = execute_request(
            &s,
            &serde_json::json!({"op":"feedback","project_id":p.project_id,"envelope":bad}),
        )
        .unwrap();
        assert_eq!(bad["status"], "quarantined");
        assert!(!git_test(
            root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/notemd/share/{}/", p.project_id)
            ]
        )
        .contains("quarantine"));
        assert_eq!(before, real_git_state(root));
    }
    #[test]
    fn project_share_git_store_branch_patch_expected_head_and_terminal_protection() {
        let (_t, s, p) = git_fixture();
        let root = Path::new(&p.source_root);
        let snap = git_freeze(&s, &p);
        git_import(&s, &p, &snap, "branch-one");
        let prepared=execute_git_request(&s,&serde_json::json!({"op":"prepare","project_id":p.project_id,"submissionId":"branch-one"})).unwrap();
        assert_eq!(prepared["files"][0]["base"], "[design](docs/a.md)");
        let request = serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"branch-one","expectedHead":prepared["head"],"results":{"README.md":"approved"}});
        let before = real_git_state(root);
        let result = execute_git_request(&s, &request).unwrap();
        let oid = result["commit"].as_str().unwrap();
        assert_eq!(
            git_test(root, &["rev-parse", &format!("{oid}^")]),
            prepared["head"]
        );
        assert!(crate::vault_sync::git_ops::run_git_io(
            root,
            &[
                "merge-base",
                "--is-ancestor",
                &snap.git.unwrap().snapshot_commit,
                oid
            ],
            &[],
            None
        )
        .is_err());
        assert_eq!(
            result["feedback"]["decisions"]["README.md"]["status"],
            "branched"
        );
        assert!(execute_git_request(&s, &request).is_err());
        assert!(s
            .apply(
                &p.project_id,
                "branch-one",
                "README.md",
                &s.read(&p.project_id, "README.md").unwrap().hash,
                "bad",
                None
            )
            .is_err());
        assert_eq!(
            s.reject(&p.project_id, "branch-one", None, None)
                .unwrap()
                .decisions["README.md"]
                .status,
            "branched"
        );
        let mut patch_request = request.clone();
        patch_request["op"] = "export-patch".into();
        let patch = execute_git_request(&s, &patch_request).unwrap();
        assert!(patch["patch"].as_str().unwrap().contains("+approved"));
        assert_eq!(patch, execute_git_request(&s, &patch_request).unwrap());
        patch_request["results"]["README.md"] = "different".into();
        assert!(execute_git_request(&s, &patch_request).is_err());
        assert_eq!(before, real_git_state(root));
        s.begin_delete(&p.project_id).unwrap();
        execute_request(
            &s,
            &serde_json::json!({"op":"delete","project_id":p.project_id}),
        )
        .unwrap();
        assert!(git_test(
            root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/notemd/share/{}/", p.project_id)
            ]
        )
        .is_empty());
        assert_eq!(
            git_test(
                root,
                &[
                    "rev-parse",
                    &format!("refs/heads/{}", result["branch"].as_str().unwrap())
                ]
            ),
            oid
        );
    }
    #[test]
    fn project_share_git_store_scope_types_and_non_git_fallback() {
        let (_t, s, p) = fixture();
        let snap = git_freeze(&s, &p);
        let f = git_import(&s, &p, &snap, "legacy");
        assert_eq!(
            f.git.unwrap().error.as_deref(),
            Some("snapshot has no commit")
        );
        let info = execute_request(
            &s,
            &serde_json::json!({"op":"git-target","project_id":p.project_id,"target":"patch"}),
        )
        .unwrap();
        assert_eq!(info["gitTarget"], "patch");
        assert!(execute_request(
            &s,
            &serde_json::json!({"op":"git-target","project_id":p.project_id,"target":"invalid"})
        )
        .is_err());
        let probe = execute_git_request(
            &s,
            &serde_json::json!({"op":"probe","project_id":p.project_id}),
        )
        .unwrap();
        assert_eq!(probe["git"], false);
        assert_eq!(probe["target"], "worktree");
        let (_t, s, p) = git_fixture();
        let snap = git_freeze(&s, &p);
        git_import(&s, &p, &snap, "scope");
        let prep = execute_git_request(
            &s,
            &serde_json::json!({"op":"prepare","project_id":p.project_id,"submissionId":"scope"}),
        )
        .unwrap();
        let mut r = serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"scope","expectedHead":prep["head"],"results":{}});
        assert!(execute_git_request(&s, &r).is_err());
        r["results"] = serde_json::json!({"README.md":"ok","extra.md":"bad"});
        assert!(execute_git_request(&s, &r).is_err());
        r["results"] = serde_json::json!({"README.md":false});
        assert!(execute_git_request(&s, &r).is_err());
        r["results"] = serde_json::json!({"README.md":"ok"});
        r["expectedHead"] = "0".repeat(40).into();
        assert!(execute_git_request(&s, &r).is_err());
        r["expectedHead"] = prep["head"].clone();
        r["sourceRoot"] = "/tmp".into();
        assert!(execute_git_request(&s, &r).is_err());
    }
    fn hook(action: impl FnMut(&ProjectStore, &str) + 'static) {
        GIT_TEST_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
    }
    fn unhook() {
        GIT_TEST_HOOK.with(|slot| *slot.borrow_mut() = None);
    }
    #[test]
    fn project_share_git_store_two_phase_preserves_latest_draft_and_cleans_late_refs() {
        let (_t, s, p) = git_fixture();
        let snap = git_freeze(&s, &p);
        let id = p.project_id.clone();
        hook(move |s, phase| {
            if phase == "share-ref-created" {
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    short_lock(|| Ok(())).unwrap();
                    tx.send(()).unwrap();
                });
                rx.recv_timeout(std::time::Duration::from_secs(5))
                    .expect("global lock must be free");
                let file = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(s.records_path().with_extension("json.lock"))
                    .unwrap();
                fs2::FileExt::try_lock_exclusive(&file).unwrap();
                fs2::FileExt::unlock(&file).unwrap();
                let mut draft = review_draft();
                draft.updated_at = "interleaved draft".into();
                s.review_save(&id, "interleave", "README.md", draft)
                    .unwrap();
            }
        });
        let f = git_import(&s, &p, &snap, "interleave");
        unhook();
        assert_eq!(f.review["README.md"].updated_at, "interleaved draft");
        let id = p.project_id.clone();
        hook(move |s, phase| {
            if phase == "share-ref-created" {
                s.begin_delete(&id).unwrap();
            }
        });
        let _ = git_import(&s, &p, &snap, "late-delete");
        unhook();
        let root = Path::new(&p.source_root);
        assert!(!git_test(
            root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/notemd/share/{}/", p.project_id)
            ]
        )
        .contains("late-delete"));
        execute_request(
            &s,
            &serde_json::json!({"op":"delete","project_id":p.project_id}),
        )
        .unwrap();
        assert!(!Path::new(&p.mirror_root).exists());
    }
    #[test]
    fn project_share_git_store_head_rebind_stop_scope_races_and_read_only_prepare() {
        let (_t, s, p) = git_fixture();
        let root = p.source_root.clone();
        hook(move |_, phase| {
            if phase == "head-sampled" {
                git_test(
                    Path::new(&root),
                    &["commit", "--allow-empty", "-m", "advanced"],
                );
            }
        });
        let failed = git_freeze(&s, &p);
        unhook();
        assert!(failed.git.is_none());
        assert!(failed.git_error.unwrap().contains("HEAD changed"));
        let snap = git_freeze(&s, &p);
        git_import(&s, &p, &snap, "readonly");
        let b = s.binding(&p.project_id).unwrap();
        let path = s.inbox_path(&b, "readonly").unwrap();
        let mut f: LocalFeedback = read_json(&path).unwrap();
        f.decisions.insert(
            "README.md".into(),
            Decision {
                status: "pending".into(),
                before_hash: Some(s.read(&p.project_id, "README.md").unwrap().hash),
                result_hash: Some(sha256_hex(b"would recover")),
                content: Some("would recover".into()),
                ..Default::default()
            },
        );
        write_json(&path, &f).unwrap();
        let before = std::fs::read(&path).unwrap();
        let source_before = std::fs::read(Path::new(&p.source_root).join("README.md")).unwrap();
        assert!(execute_git_request(
            &s,
            &serde_json::json!({"op":"prepare","project_id":p.project_id,"submissionId":"readonly"})
        )
        .unwrap_err()
        .contains("worktree"));
        assert_eq!(before, std::fs::read(&path).unwrap());
        assert_eq!(
            source_before,
            std::fs::read(Path::new(&p.source_root).join("README.md")).unwrap()
        );
        let id = p.project_id.clone();
        hook(move |s, phase| {
            if phase == "share-ref-created" {
                s.stopped(&id).unwrap();
            }
        });
        git_import(&s, &p, &snap, "late-stop");
        unhook();
        assert!(!git_test(
            Path::new(&p.source_root),
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/notemd/share/{}/", p.project_id)
            ]
        )
        .contains("late-stop"));
        let replacement = Path::new(&p.source_root)
            .parent()
            .unwrap()
            .join("replacement");
        std::fs::create_dir_all(replacement.join("docs")).unwrap();
        std::fs::write(replacement.join("README.md"), &source_before).unwrap();
        std::fs::write(replacement.join("docs/a.md"), "[home](../README.md)").unwrap();
        let id = p.project_id.clone();
        hook(move |s, phase| {
            if phase == "share-ref-created" {
                s.rebind(&id, replacement.to_str().unwrap()).unwrap();
            }
        });
        git_import(&s, &p, &snap, "late-rebind");
        unhook();
        assert!(!git_test(
            Path::new(&p.source_root),
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/notemd/share/{}/", p.project_id)
            ]
        )
        .contains("late-rebind"));
    }
    #[test]
    fn project_share_git_store_branch_state_failure_retry_is_owned_and_idempotent() {
        let (_t, s, p) = git_fixture();
        let snap = git_freeze(&s, &p);
        git_import(&s, &p, &snap, "retry-branch");
        let head = git_test(Path::new(&p.source_root), &["rev-parse", "HEAD"]);
        let b = s.binding(&p.project_id).unwrap();
        let path = s.inbox_path(&b, "retry-branch").unwrap();
        let backup = path.with_extension("saved");
        let path_hook = path.clone();
        let backup_hook = backup.clone();
        let id = p.project_id.clone();
        hook(move |s, phase| {
            if phase == "review-built" {
                let mut draft = review_draft();
                draft.target = Some("branch".into());
                draft.updated_at = "saved during build".into();
                s.review_save(&id, "retry-branch", "README.md", draft)
                    .unwrap();
            }
            if phase == "branch-ref-created" {
                std::fs::rename(&path_hook, &backup_hook).unwrap();
                std::fs::create_dir(&path_hook).unwrap();
            }
        });
        let r = serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"retry-branch","expectedHead":head,"results":{"README.md":"approved"}});
        let first = execute_git_request(&s, &r).unwrap();
        unhook();
        assert!(first["stateError"].as_str().unwrap().contains("retry"));
        assert_eq!(
            first["feedback"]["review"]["README.md"]["updated_at"],
            "saved during build"
        );
        assert_eq!(
            first["feedback"]["git"]["branch_intent"]["commit"],
            first["commit"]
        );
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&backup, &path).unwrap();
        let before = git_test(
            Path::new(&p.source_root),
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        );
        let retry = execute_git_request(&s, &r).unwrap();
        assert_eq!(first["branch"], retry["branch"]);
        assert_eq!(first["commit"], retry["commit"]);
        assert!(retry.get("stateError").is_none());
        assert_eq!(
            before,
            git_test(
                Path::new(&p.source_root),
                &["for-each-ref", "--format=%(refname)", "refs/heads/"]
            )
        );
        let retry_record = serde_json::json!({"op":"git-branched","project_id":p.project_id,"submissionId":"retry-branch","path":"README.md","branch":retry["branch"],"commit":retry["commit"],"summary":{"accepted":1,"total":2}});
        let saved = execute_request(&s, &retry_record).unwrap();
        assert_eq!(saved["decisions"]["README.md"]["status"], "branched");
        let mut forged = retry_record;
        forged["branch"] = "main".into();
        assert!(execute_request(&s, &forged).is_err());
    }
    #[test]
    fn project_share_git_store_existing_hidden_commit_reuses_semantics_not_time() {
        let (_t, s, p) = git_fixture();
        let snap = git_freeze(&s, &p);
        let f = git_import(&s, &p, &snap, "old-object");
        let root = Path::new(&p.source_root);
        let original = f.git.unwrap().commit.unwrap();
        let raw = git_test(root, &["cat-file", "commit", &original]);
        let historical = raw
            .lines()
            .map(|line| {
                if line.starts_with("committer ") {
                    "committer Owner <owner@example.test> 946684800 +0000"
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let old = String::from_utf8(
            crate::vault_sync::git_ops::run_git_io(
                root,
                &["hash-object", "-t", "commit", "-w", "--stdin"],
                &[],
                Some(historical.as_bytes()),
            )
            .unwrap(),
        )
        .unwrap()
        .trim()
        .to_string();
        assert_ne!(old, original);
        let name = format!("refs/notemd/share/{}/submissions/old-object", p.project_id);
        git_test(root, &["update-ref", &name, &old, &original]);
        assert_eq!(
            git_import(&s, &p, &snap, "old-object")
                .git
                .unwrap()
                .commit
                .unwrap(),
            old
        );
        // A different author must not get reused under the same create-only ref.
        let tampered = historical.replace("author Visitor", "author Forged");
        let other = String::from_utf8(
            crate::vault_sync::git_ops::run_git_io(
                root,
                &["hash-object", "-t", "commit", "-w", "--stdin"],
                &[],
                Some(tampered.as_bytes()),
            )
            .unwrap(),
        )
        .unwrap()
        .trim()
        .to_string();
        git_test(root, &["update-ref", &name, &other, &old]);
        let rejected = git_import(&s, &p, &snap, "old-object");
        assert!(rejected
            .git
            .unwrap()
            .error
            .unwrap()
            .contains("different content or identity"));
        assert_eq!(git_test(root, &["rev-parse", &name]), other);
    }
    #[test]
    fn project_share_git_store_child_runs_outside_both_locks_and_delete_waits_per_project() {
        let (_t, s, p) = git_fixture();
        let root = Path::new(&p.source_root);
        let ready = root.parent().unwrap().join("git-ready");
        let release = root.parent().unwrap().join("git-release");
        let filter = root.parent().unwrap().join("filter.sh");
        std::fs::write(
            &filter,
            format!(
                "#!/bin/sh\ntouch '{}'\nwhile [ ! -f '{}' ]; do sleep 0.01; done\ncat\n",
                ready.display(),
                release.display()
            ),
        )
        .unwrap();
        git_test(
            root,
            &[
                "config",
                "filter.shareblock.clean",
                &format!("sh '{}'", filter.display()),
            ],
        );
        git_test(root, &["config", "filter.shareblock.required", "true"]);
        std::fs::write(root.join(".gitattributes"), "README.md filter=shareblock\n").unwrap();
        let worker = ProjectStore::new(s.vault.clone(), s.state.clone());
        let info = p.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let result = git_freeze(&worker, &info);
            done_tx.send(result).unwrap();
        });
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !ready.exists() && std::time::Instant::now() < until {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(ready.exists(), "real Git clean filter must be running");
        let (lock_tx, lock_rx) = std::sync::mpsc::channel();
        let store = ProjectStore::new(s.vault.clone(), s.state.clone());
        let id = p.project_id.clone();
        let marker = std::thread::spawn(move || {
            short_lock(|| {
                let _records = store.lock()?;
                store.binding(&id).map(|_| ())
            })
            .unwrap();
            execute_request(
                &store,
                &serde_json::json!({"op":"begin-delete","project_id":id}),
            )
            .unwrap();
            lock_tx.send(()).unwrap();
        });
        let free = lock_rx.recv_timeout(std::time::Duration::from_secs(5));
        if free.is_err() {
            std::fs::write(&release, "").unwrap();
        }
        free.expect("both locks are available during Git subprocess");
        marker.join().unwrap();
        let store = ProjectStore::new(s.vault.clone(), s.state.clone());
        let id = p.project_id.clone();
        let (delete_tx, delete_rx) = std::sync::mpsc::channel();
        let deleting = std::thread::spawn(move || {
            delete_tx
                .send(execute_request(
                    &store,
                    &serde_json::json!({"op":"delete","project_id":id}),
                ))
                .unwrap();
        });
        assert!(
            delete_rx
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err(),
            "delete waits for in-flight Git operation"
        );
        assert!(
            execute_request(
                &s,
                &serde_json::json!({"op":"get","project_id":p.project_id})
            )
            .is_ok(),
            "delete wait does not occupy global lock"
        );
        std::fs::write(&release, "").unwrap();
        done_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        delete_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
            .unwrap();
        thread.join().unwrap();
        deleting.join().unwrap();
        assert!(!Path::new(&p.mirror_root).exists());
        assert!(git_test(
            root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/notemd/share/{}/", p.project_id)
            ]
        )
        .is_empty());
    }
    #[test]
    fn project_share_git_store_prepare_and_build_revalidate_head_scope_and_status() {
        let (_t, s, p) = git_fixture();
        let snap = git_freeze(&s, &p);
        git_import(&s, &p, &snap, "gates");
        let root = Path::new(&p.source_root);
        let head = git_test(root, &["rev-parse", "HEAD"]);
        let request = serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"gates","expectedHead":head,"results":{"README.md":"yes"}});
        let root_hook = p.source_root.clone();
        hook(move |_, phase| {
            if phase == "review-built" {
                git_test(
                    Path::new(&root_hook),
                    &["commit", "--allow-empty", "-m", "concurrent head"],
                );
            }
        });
        assert!(execute_git_request(&s, &request)
            .unwrap_err()
            .contains("HEAD changed"));
        unhook();
        assert!(git_test(
            root,
            &["for-each-ref", "--format=%(refname)", "refs/heads/notemd/"]
        )
        .is_empty());
        let mut request = request;
        request["expectedHead"] = git_test(root, &["rev-parse", "HEAD"]).into();
        let id = p.project_id.clone();
        hook(move |s, phase| {
            if phase == "review-built" {
                let b = s.binding(&id).unwrap();
                let mut c = s.config(&b).unwrap();
                c.files.retain(|p| p != "README.md");
                write_json(&s.management(&b, "project.json").unwrap(), &c).unwrap();
            }
        });
        assert!(execute_git_request(&s, &request)
            .unwrap_err()
            .contains("scope changed"));
        unhook();
        assert!(execute_git_request(
            &s,
            &serde_json::json!({"op":"prepare","project_id":p.project_id,"submissionId":"gates"})
        )
        .unwrap_err()
        .contains("scope"));
        let b = s.binding(&p.project_id).unwrap();
        let mut c = s.config(&b).unwrap();
        c.files.push("README.md".into());
        write_json(&s.management(&b, "project.json").unwrap(), &c).unwrap();
        let id = p.project_id.clone();
        hook(move |s, phase| {
            if phase == "review-built" {
                s.reject(&id, "gates", None, None).unwrap();
            }
        });
        assert!(execute_git_request(&s, &request).is_err());
        unhook();
        assert!(git_test(
            root,
            &["for-each-ref", "--format=%(refname)", "refs/heads/notemd/"]
        )
        .is_empty());
    }
    #[test]
    fn project_share_git_store_linked_worktree_and_same_vault_repository_boundary() {
        let (t, s, p) = git_fixture();
        let main = Path::new(&p.source_root);
        let linked = t.path().join("linked project");
        git_test(
            main,
            &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
        );
        let p = s.open(linked.to_str().unwrap(), "README.md").unwrap();
        let before = git_test(&linked, &["status", "--porcelain=v1"]);
        let index = git_test(&linked, &["rev-parse", "--git-path", "index"]);
        let index_before = std::fs::read(&index).unwrap();
        let snap = git_freeze(&s, &p);
        assert!(snap.git.is_some());
        git_import(&s, &p, &snap, "linked");
        assert_eq!(before, git_test(&linked, &["status", "--porcelain=v1"]));
        assert_eq!(index_before, std::fs::read(index).unwrap());
        let t = TempDir::new().unwrap();
        let vault = t.path().join("vault");
        std::fs::create_dir_all(vault.join("docs")).unwrap();
        std::fs::write(vault.join("README.md"), "root").unwrap();
        std::fs::write(vault.join("docs/a.md"), "a").unwrap();
        git_test(&vault, &["init", "-b", "main"]);
        git_test(&vault, &["config", "user.name", "Owner"]);
        git_test(&vault, &["config", "user.email", "owner@example.test"]);
        git_test(&vault, &["add", "."]);
        git_test(&vault, &["commit", "-m", "base"]);
        let before = real_git_state(&vault);
        let s = ProjectStore::new(vault.clone(), t.path().join("state"));
        let p = s.open(vault.to_str().unwrap(), "README.md").unwrap();
        let sampled = git::probe(&vault).unwrap();
        let snap = freeze(&s, &p);
        let after_p0 = real_git_state(&vault);
        assert_ne!(
            before.0, after_p0.0,
            "same-Vault P0 creates existing managed mirror/private metadata"
        );
        let job = s
            .capture_share_job(&p.project_id, &snap.snapshot_id, None)
            .unwrap();
        run_share_job(&s, &job, Ok(sampled)).unwrap();
        assert_eq!(
            after_p0,
            real_git_state(&vault),
            "Git stage adds no worktree/index/HEAD/config mutation beyond private metadata"
        );
    }
    #[test]
    fn project_share_git_store_record_retry_does_not_apply_clean_filter_twice() {
        let (_t, s, p) = git_fixture();
        let snap = git_freeze(&s, &p);
        git_import(&s, &p, &snap, "filter-retry");
        let root = Path::new(&p.source_root);
        git_test(
            root,
            &["config", "filter.prefix.clean", "sed 's/^/clean:/'"],
        );
        std::fs::write(root.join(".gitattributes"), "README.md filter=prefix\n").unwrap();
        let result=execute_git_request(&s,&serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"filter-retry","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved"}})).unwrap();
        assert_eq!(
            git_test(
                root,
                &[
                    "show",
                    &format!("{}:README.md", result["commit"].as_str().unwrap())
                ]
            ),
            "clean:approved"
        );
        execute_request(&s,&serde_json::json!({"op":"git-branched","project_id":p.project_id,"submissionId":"filter-retry","path":"README.md","branch":result["branch"],"commit":result["commit"]})).unwrap();
        git_test(root, &["config", "filter.prefix.clean", "exit 99"]);
        let query = execute_git_request(&s, &serde_json::json!({"op":"branch-state","project_id":p.project_id,"submissionId":"filter-retry"})).unwrap();
        assert_eq!(query["commit"], result["commit"]);
    }
    #[test]
    fn project_share_git_store_probe_owner_identity_and_whole_submission_gates() {
        let (_t, s, p) = git_fixture();
        let root = Path::new(&p.source_root);
        let probe = serde_json::json!({"op":"probe","project_id":p.project_id});
        assert_eq!(
            execute_git_request(&s, &probe).unwrap()["target"],
            "worktree"
        );
        git_test(
            root,
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/no-network",
            ],
        );
        assert_eq!(execute_git_request(&s, &probe).unwrap()["target"], "branch");
        execute_request(
            &s,
            &serde_json::json!({"op":"git-target","project_id":p.project_id,"target":"patch"}),
        )
        .unwrap();
        assert_eq!(execute_git_request(&s, &probe).unwrap()["target"], "patch");
        let snap = git_freeze(&s, &p);
        let mut e = envelope(&p, &snap, "whole");
        e.payload.v1_mut().edits.push(Edit {
            path: "docs/a.md".into(),
            base_hash: snap
                .files
                .iter()
                .find(|f| f.path == "docs/a.md")
                .unwrap()
                .hash
                .clone(),
            after_markdown: "second".into(),
        });
        execute_request(
            &s,
            &serde_json::json!({"op":"feedback","project_id":p.project_id,"envelope":e}),
        )
        .unwrap();
        s.review_save(&p.project_id, "whole", "README.md", review_draft())
            .unwrap();
        let request = serde_json::json!({"op":"branch","project_id":p.project_id,"submissionId":"whole","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"first","docs/a.md":"second"}});
        git_test(root, &["config", "user.name", ""]);
        let config = std::fs::read(root.join(".git/config")).unwrap();
        assert!(execute_git_request(&s, &request)
            .unwrap_err()
            .contains("owner identity"));
        assert_eq!(config, std::fs::read(root.join(".git/config")).unwrap());
        let failed = git_freeze(&s, &p);
        assert!(failed.git.is_none());
        assert!(failed.git_error.unwrap().contains("owner identity"));
        git_test(root, &["config", "user.name", "Owner"]);
        let result = execute_git_request(&s, &request).unwrap();
        assert_eq!(
            result["feedback"]["decisions"]["README.md"]["status"],
            "branched"
        );
        assert_eq!(
            result["feedback"]["decisions"]["docs/a.md"]["status"],
            "branched"
        );
        assert!(result["feedback"]["review"].get("README.md").is_some());
        let snap = git_freeze(&s, &p);
        git_import(&s, &p, &snap, "mixed");
        s.reject(&p.project_id, "mixed", Some("README.md"), None)
            .unwrap();
        let mut mixed = request;
        mixed["submissionId"] = "mixed".into();
        mixed["op"] = "export-patch".into();
        mixed["results"] = serde_json::json!({"README.md":"no"});
        assert!(execute_git_request(&s, &mixed).is_err());
    }
    #[test]
    fn project_share_git_store_readonly_review_and_targeted_saves_never_recover_a_intent() {
        let (_t, s, p) = git_fixture();
        let snap = git_freeze(&s, &p);
        let mut e = envelope(&p, &snap, "readonly-intent");
        e.payload.v1_mut().annotations.push(review_annotation("README.md"));
        s.feedback(&p.project_id, e).unwrap();
        let b = s.binding(&p.project_id).unwrap();
        let inbox = s.inbox_path(&b, "readonly-intent").unwrap();
        let preview = serde_json::json!({"op":"review-readonly","project_id":p.project_id,"submissionId":"readonly-intent","path":"README.md"});
        let clean = execute_request(&s, &preview).unwrap();
        assert_eq!(clean["current"], "[design](docs/a.md)");
        let mut f: LocalFeedback = read_json(&inbox).unwrap();
        let original = s.read(&p.project_id, "README.md").unwrap();
        f.review.insert("README.md".into(), review_draft());
        f.decisions.insert(
            "README.md".into(),
            Decision {
                status: "pending".into(),
                before_hash: Some(original.hash),
                result_hash: Some(sha256_hex(b"already written")),
                content: Some("already written".into()),
                ..Default::default()
            },
        );
        write_json(&inbox, &f).unwrap();
        std::fs::write(
            Path::new(&p.source_root).join("README.md"),
            "already written",
        )
        .unwrap();
        let mirror = Path::new(&p.mirror_root).join("README.md");
        let mirror_before = std::fs::read(&mirror).unwrap();
        let inbox_before = std::fs::read(&inbox).unwrap();
        assert!(execute_request(&s, &preview)
            .unwrap_err()
            .contains("worktree"));
        assert!(execute_git_request(&s,&serde_json::json!({"op":"prepare","project_id":p.project_id,"submissionId":"readonly-intent"})).unwrap_err().contains("worktree"));
        let mut draft = review_draft();
        draft.target = Some("branch".into());
        assert!(execute_request(&s,&serde_json::json!({"op":"review-save","project_id":p.project_id,"submissionId":"readonly-intent","path":"README.md","draft":draft})).unwrap_err().contains("worktree"));
        assert!(execute_request(&s,&serde_json::json!({"op":"annotation-decide","project_id":p.project_id,"submissionId":"readonly-intent","index":0,"value":"dismissed","target":"patch"})).unwrap_err().contains("worktree"));
        assert!(execute_request(&s,&serde_json::json!({"op":"annotation-decide","project_id":p.project_id,"submissionId":"readonly-intent","index":0,"value":"dismissed","target":"invalid"})).is_err());
        assert_eq!(inbox_before, std::fs::read(&inbox).unwrap());
        assert_eq!(mirror_before, std::fs::read(&mirror).unwrap());
        assert_eq!(
            std::fs::read(Path::new(&p.source_root).join("README.md")).unwrap(),
            b"already written"
        );
        s.review(&p.project_id, "readonly-intent", "README.md")
            .unwrap();
        assert_eq!(std::fs::read(mirror).unwrap(), b"already written");
        let recovered: LocalFeedback = read_json(&inbox).unwrap();
        assert_eq!(recovered.decisions["README.md"].status, "accepted");
        assert!(recovered.review.is_empty());
    }
    fn inject_annotation_worktree_intent(s: &ProjectStore, id: &str, status: &str) -> Vec<u8> {
        short_lock(|| {
            let _records = s.lock()?;
            let b = s.binding(id)?;
            let path = s.inbox_path(&b, "late-intent")?;
            let mut f: LocalFeedback = read_json(&path)?;
            s.validate_feedback(&b, &f.envelope.payload)?;
            assert!(!f
                .envelope
                .payload
                .edits()
                .iter()
                .any(|edit| edit.path == "docs/a.md"));
            assert!(f
                .envelope
                .payload
                .annotations_normalized()
                .iter()
                .any(|note| note.path == "docs/a.md"));
            let source = s.bound_source(&b, "docs/a.md")?;
            let content = "annotation promotion awaiting worktree recovery";
            let decision = Decision {
                status: status.into(),
                before_hash: Some(sha256_hex(&read_bytes(&source)?)),
                result_hash: Some(sha256_hex(content.as_bytes())),
                content: Some(content.into()),
                mirrors: crate::sotvault::plan_source_mirrors(
                    &s.records_path(),
                    &s.vault,
                    &source.to_string_lossy(),
                    content.as_bytes(),
                )?,
                ..Default::default()
            };
            if status == "mirror_pending" {
                write_atomic(&source, content.as_bytes())?;
            }
            f.decisions.insert("docs/a.md".into(), decision);
            write_json(&path, &f)?;
            read_bytes(&path)
        })
        .unwrap()
    }
    fn annotation_git_fixture() -> (TempDir, ProjectStore, ProjectInfo) {
        let (t, s, p) = git_fixture();
        let snap = git_freeze(&s, &p);
        let mut e = envelope(&p, &snap, "late-intent");
        e.payload.v1_mut().annotations.push(review_annotation("docs/a.md"));
        s.feedback(&p.project_id, e).unwrap();
        (t, s, p)
    }
    fn assert_late_annotation_intent_blocks(op: &'static str) {
        for status in ["pending", "mirror_pending"] {
            let (_t, s, p) = annotation_git_fixture();
            let root = Path::new(&p.source_root);
            let refs_before =
                git_test(root, &["for-each-ref", "--format=%(refname) %(objectname)"]);
            let expected = Arc::new(Mutex::new(None));
            let expected_hook = expected.clone();
            let id = p.project_id.clone();
            hook(move |s, phase| {
                if phase
                    == if op == "prepare" {
                        "review-prepared"
                    } else {
                        "review-built"
                    }
                {
                    *expected_hook.lock().unwrap() =
                        Some(inject_annotation_worktree_intent(s, &id, status));
                }
            });
            let request = if op == "prepare" {
                serde_json::json!({"op":op,"project_id":p.project_id,"submissionId":"late-intent"})
            } else {
                serde_json::json!({"op":op,"project_id":p.project_id,"submissionId":"late-intent","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved edit"}})
            };
            let result = execute_git_request(&s, &request);
            unhook();
            assert!(
                result
                    .as_ref()
                    .is_err_and(|error| error.contains("worktree")),
                "{op}/{status} must reject the late annotation intent"
            );
            let b = s.binding(&p.project_id).unwrap();
            assert_eq!(
                read_bytes(&s.inbox_path(&b, "late-intent").unwrap()).unwrap(),
                expected.lock().unwrap().take().unwrap()
            );
            assert_eq!(
                refs_before,
                git_test(root, &["for-each-ref", "--format=%(refname) %(objectname)"])
            );
            assert_eq!(
                read_bytes(&Path::new(&p.mirror_root).join("docs/a.md")).unwrap(),
                b"[home](../README.md)"
            );
            let source_expected = if status == "mirror_pending" {
                "annotation promotion awaiting worktree recovery"
            } else {
                "[home](../README.md)"
            };
            assert_eq!(
                read_bytes(&root.join("docs/a.md")).unwrap(),
                source_expected.as_bytes()
            );
        }
    }
    #[test]
    fn project_share_git_fix1_late_annotation_intent_blocks_prepare() {
        assert_late_annotation_intent_blocks("prepare");
    }
    #[test]
    fn project_share_git_fix1_late_annotation_intent_blocks_branch() {
        assert_late_annotation_intent_blocks("branch");
    }
    #[test]
    fn project_share_git_fix1_late_annotation_intent_blocks_patch() {
        assert_late_annotation_intent_blocks("export-patch");
    }
    fn assert_post_ref_annotation_intent(op: &'static str) {
        for status in ["pending", "mirror_pending"] {
            let (_t, s, p) = annotation_git_fixture();
            let root = Path::new(&p.source_root);
            let refs_before =
                git_test(root, &["for-each-ref", "--format=%(refname) %(objectname)"]);
            let expected = Arc::new(Mutex::new(None));
            let expected_hook = expected.clone();
            let id = p.project_id.clone();
            hook(move |s, phase| {
                if phase
                    == if op == "branch" {
                        "branch-ref-created"
                    } else {
                        "export-ref-created"
                    }
                {
                    *expected_hook.lock().unwrap() =
                        Some(inject_annotation_worktree_intent(s, &id, status));
                }
            });
            let result = execute_git_request(
                &s,
                &serde_json::json!({"op":op,"project_id":p.project_id,"submissionId":"late-intent","expectedHead":git_test(root,&["rev-parse","HEAD"]),"results":{"README.md":"approved edit"}}),
            );
            unhook();
            if op == "branch" {
                let result = result.unwrap();
                assert!(
                    result.get("stateError").and_then(|v| v.as_str()).is_some(),
                    "late intent after branch creation must return stateError"
                );
                assert_eq!(
                    result["feedback"]["decisions"]["docs/a.md"]["status"],
                    status
                );
                assert_eq!(
                    git_test(
                        root,
                        &[
                            "rev-parse",
                            &format!("refs/heads/{}", result["branch"].as_str().unwrap())
                        ]
                    ),
                    result["commit"]
                );
            } else {
                assert!(result.unwrap_err().contains("worktree"));
                assert_eq!(
                    refs_before,
                    git_test(root, &["for-each-ref", "--format=%(refname) %(objectname)"])
                );
            }
            let b = s.binding(&p.project_id).unwrap();
            let bytes = read_bytes(&s.inbox_path(&b, "late-intent").unwrap()).unwrap();
            assert_eq!(bytes, expected.lock().unwrap().take().unwrap());
            let f: LocalFeedback = serde_json::from_slice(&bytes).unwrap();
            assert!(!f.decisions.contains_key("README.md"));
            assert_eq!(f.decisions["docs/a.md"].status, status);
        }
    }
    #[test]
    fn project_share_git_fix1_post_ref_annotation_intent_returns_branch_state_error() {
        assert_post_ref_annotation_intent("branch");
    }
    #[test]
    fn project_share_git_fix1_post_ref_annotation_intent_cleans_export() {
        assert_post_ref_annotation_intent("export-patch");
    }
    #[test]
    fn project_share_git_fix1_optional_fields_are_absent_for_no_remote_and_detached_head() {
        let (_t, s, p) = annotation_git_fixture();
        let root = Path::new(&p.source_root);
        let probe_request = serde_json::json!({"op":"probe","project_id":p.project_id});
        let attached = execute_git_request(&s, &probe_request).unwrap();
        assert_eq!(attached["branch"], "main");
        git_test(root, &["checkout", "--detach"]);
        let detached = execute_git_request(&s, &probe_request).unwrap();
        let prepared=execute_git_request(&s,&serde_json::json!({"op":"prepare","project_id":p.project_id,"submissionId":"late-intent"})).unwrap();
        assert_eq!(
            [
                attached.get("remote").is_none(),
                detached.get("branch").is_none(),
                detached.get("remote").is_none(),
                prepared.get("remote").is_none()
            ],
            [true; 4],
            "optional string fields must be absent, not null"
        );
        git_test(
            root,
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/no-network",
            ],
        );
        assert_eq!(
            execute_git_request(&s, &probe_request).unwrap()["remote"],
            "origin"
        );
    }
    #[test]
    fn project_share_review_real_fixture_preserves_owner_unshared_and_reopens_decisions() {
        let t = TempDir::new().unwrap();
        let source = t.path().join("owner/project");
        std::fs::create_dir_all(&source).unwrap();
        let base = "甲。\n\n乙。\n\n丙。\n[b](b.md) ![picture](pic.png)\n";
        let other = "[a](a.md)\n";
        let image = b"\x89PNG\r\n\x1a\nfixture";
        let private = b"private\0\r\nunchanged";
        std::fs::write(source.join("a.md"), base).unwrap();
        std::fs::write(source.join("b.md"), other).unwrap();
        std::fs::write(source.join("pic.png"), image).unwrap();
        std::fs::write(source.join("unshared.md"), private).unwrap();
        let service = ProjectStore::new(t.path().join("vault"), t.path().join("state"));
        let project = service
            .create(source.join("a.md").to_str().unwrap())
            .unwrap();
        let freeze = || {
            let paths = vec![
                "a.md".to_string(),
                "b.md".to_string(),
                "pic.png".to_string(),
            ];
            let hashes = paths
                .iter()
                .map(|path| {
                    (
                        path.clone(),
                        service.read(&project.project_id, path).unwrap().hash,
                    )
                })
                .collect();
            service
                .snapshot(&project.project_id, paths, hashes)
                .unwrap()
        };
        let s1 = freeze();
        service
            .bundle(&project.project_id, &s1.snapshot_id, "S1")
            .unwrap();
        service
            .published(
                &project.project_id,
                &s1.snapshot_id,
                "https://share.invalid/fixture",
            )
            .unwrap();
        let abandoned = freeze();
        let s2 = freeze();
        service
            .bundle(&project.project_id, &s2.snapshot_id, "S2")
            .unwrap();
        service
            .published(
                &project.project_id,
                &s2.snapshot_id,
                "https://share.invalid/fixture",
            )
            .unwrap();
        assert_eq!(
            s2.parent_snapshot_id.as_deref(),
            Some(s1.snapshot_id.as_str())
        );
        assert_ne!(
            s2.parent_snapshot_id.as_deref(),
            Some(abandoned.snapshot_id.as_str())
        );
        let feedback = FeedbackEnvelope {
            payload: ProjectFeedback {
                schema_version: 1,
                project_id: project.project_id.clone(),
                snapshot_id: s1.snapshot_id.clone(),
                submission_id: "fixture-one".into(),
                edits: vec![Edit {
                    path: "a.md".into(),
                    base_hash: sha256_hex(base.as_bytes()),
                    after_markdown: base.replace("乙。", "乙改。"),
                }],
                annotations: vec![Annotation {
                    path: "a.md".into(),
                    quote: "丙".into(),
                    comment: "复核".into(),
                    start: None,
                    end: None,
                }],
                name: Some("访客".into()),
            }.into(),
            request_hash: "fixture-one".into(),
            received_at: "2026-10-12T08:00:00Z".into(),
        };
        service
            .feedback(&project.project_id, feedback.clone())
            .unwrap();
        let ours = base.replace("甲。", "甲改。");
        std::fs::write(source.join("a.md"), &ours).unwrap();
        let review = service
            .review(&project.project_id, "fixture-one", "a.md")
            .unwrap();
        assert_eq!(review.base, base);
        assert_eq!(review.current, ours);
        let mut draft = review_draft();
        draft.ours_hash = review.current_hash.clone();
        service
            .review_save(&project.project_id, "fixture-one", "a.md", draft)
            .unwrap();
        let reopened = ProjectStore::new(t.path().join("vault"), t.path().join("state"));
        assert!(reopened.inbox(&project.project_id).unwrap()[0]
            .review
            .contains_key("a.md"));
        let result = ours
            .replace("乙。", "乙改。")
            .replace("丙", "{==丙==}{>>访客：复核<<}");
        reopened
            .apply(
                &project.project_id,
                "fixture-one",
                "a.md",
                &review.current_hash,
                &result,
                Some(HunkSummary {
                    accepted: 1,
                    total: 1,
                }),
            )
            .unwrap();
        reopened
            .annotation_decide(&project.project_id, "fixture-one", 0, "promoted")
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(source.join("a.md")).unwrap(),
            result
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&project.mirror_root).join("a.md")).unwrap(),
            result
        );
        assert_eq!(
            std::fs::read(source.join("b.md")).unwrap(),
            other.as_bytes()
        );
        assert_eq!(std::fs::read(source.join("pic.png")).unwrap(), image);
        assert_eq!(std::fs::read(source.join("unshared.md")).unwrap(), private);
        let done = service.inbox(&project.project_id).unwrap().remove(0);
        assert_eq!(done.decisions["a.md"].status, "accepted");
        assert_eq!(done.annotation_decisions["0"], "promoted");
        assert!(done.review.is_empty());
        let mut second = feedback;
        second.payload.v1_mut().submission_id = "fixture-two".into();
        second.request_hash = "fixture-two".into();
        service.feedback(&project.project_id, second).unwrap();
        assert_eq!(
            service
                .review(&project.project_id, "fixture-two", "a.md")
                .unwrap()
                .current,
            result
        );
    }

    #[test]
    fn project_share_review_removed_scope_blocks_review_and_apply_without_changing_bytes() {
        let (_t, service, project) = fixture();
        let snapshot = freeze(&service, &project);
        let path = "docs/a.md";
        let base = snapshot
            .files
            .iter()
            .find(|file| file.path == path)
            .unwrap();
        let feedback = FeedbackEnvelope {
            payload: ProjectFeedback {
                schema_version: 1,
                project_id: project.project_id.clone(),
                snapshot_id: snapshot.snapshot_id.clone(),
                submission_id: "removed-scope".into(),
                edits: vec![Edit {
                    path: path.into(),
                    base_hash: base.hash.clone(),
                    after_markdown: "visitor suggestion".into(),
                }],
                annotations: vec![],
                name: None,
            }.into(),
            request_hash: "removed-scope".into(),
            received_at: "2026-10-12T08:00:00Z".into(),
        };
        service.feedback(&project.project_id, feedback).unwrap();
        let source = Path::new(&project.source_root).join(path);
        let mirror = Path::new(&project.mirror_root).join(path);
        let source_before = std::fs::read(&source).unwrap();
        let mirror_before = std::fs::read(&mirror).unwrap();
        let expected = sha256_hex(&source_before);
        let paths = vec!["README.md".to_string()];
        let hashes = [(
            "README.md".to_string(),
            service.read(&project.project_id, "README.md").unwrap().hash,
        )]
        .into();
        service
            .snapshot(&project.project_id, paths, hashes)
            .unwrap();
        let reviewed = service.review(&project.project_id, "removed-scope", path);
        let applied = service.apply(
            &project.project_id,
            "removed-scope",
            path,
            &expected,
            "visitor suggestion",
            None,
        );
        assert!(
            reviewed.is_err() && applied.is_err(),
            "expectedHash={expected}; review={reviewed:?}; apply={applied:?}"
        );
        assert!(reviewed
            .unwrap_err()
            .contains("outside current shared scope"));
        assert!(applied
            .unwrap_err()
            .contains("outside current shared scope"));
        assert_eq!(std::fs::read(&source).unwrap(), source_before);
        assert_eq!(std::fs::read(&mirror).unwrap(), mirror_before);
        let inbox = service.inbox(&project.project_id).unwrap();
        assert_eq!(
            inbox[0].envelope.payload.edits()[0].after_markdown,
            "visitor suggestion"
        );
        let rejected = service
            .reject(&project.project_id, "removed-scope", Some(path), None)
            .unwrap();
        assert_eq!(rejected.decisions[path].status, "rejected");
        assert_eq!(std::fs::read(&source).unwrap(), source_before);
        assert_eq!(std::fs::read(&mirror).unwrap(), mirror_before);
    }

    #[test]
    fn project_share_review_parent_is_last_successfully_published_snapshot() {
        let (_t, s, p) = fixture();
        let first = freeze(&s, &p);
        assert_eq!(first.schema_version, 2);
        assert!(first.parent_snapshot_id.is_none());
        let created = first.created_at.as_deref().unwrap();
        assert!(created.ends_with('Z'));
        assert!(!created.contains('.'));
        assert_eq!(chrono::DateTime::parse_from_rfc3339(created).unwrap().offset().local_minus_utc(), 0);
        s.bundle(&p.project_id, &first.snapshot_id, "first bundle").unwrap();
        s.published(&p.project_id, &first.snapshot_id, "https://share.example/project").unwrap();
        let abandoned = freeze(&s, &p);
        assert!(s.published(&p.project_id, &abandoned.snapshot_id, "https://share.example/project").is_err());
        let next = freeze(&s, &p);
        assert_eq!(next.parent_snapshot_id.as_deref(), Some(first.snapshot_id.as_str()));
        assert_ne!(next.parent_snapshot_id.as_deref(), Some(abandoned.snapshot_id.as_str()));
        let persisted = s.snapshot_get(&p.project_id, &next.snapshot_id).unwrap();
        assert_eq!(persisted.parent_snapshot_id, next.parent_snapshot_id);
        assert_eq!(persisted.created_at, next.created_at);
    }

    #[test]
    fn project_share_review_draft_roundtrips_without_writing_source() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snapshot, "review1")).unwrap();
        let source = Path::new(&p.source_root).join("README.md");
        let before = std::fs::read(&source).unwrap();
        let draft = ReviewDraft { kernel_version: 1, ours_hash: sha256_hex(&before),
            hunks: BTreeMap::new(), target: None, updated_at: "2026-10-12T08:00:00Z".into() };
        s.review_save(&p.project_id, "review1", "README.md", draft).unwrap();
        let inbox = s.inbox(&p.project_id).unwrap();
        assert_eq!(inbox[0].review["README.md"].kernel_version, 1);
        assert_eq!(std::fs::read(source).unwrap(), before);
    }

    fn review_draft() -> ReviewDraft {
        ReviewDraft {
            kernel_version: MERGE_KERNEL_VERSION,
            ours_hash: sha256_hex(b"proposal source"),
            hunks: [("opaque".into(), serde_json::json!({"choice":"manual","text":"中文\r\n"}))].into(),
            target: None,
            updated_at: "2026-10-12T08:00:00Z".into(),
        }
    }

    fn review_annotation(path: &str) -> Annotation {
        Annotation { path: path.into(), quote: "quote".into(), comment: "comment".into(), start: None, end: None }
    }

    #[test]
    fn project_share_review_legacy_manifest_and_inbox_read_from_disk() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.bundle(&p.project_id, &snapshot.snapshot_id, "legacy bundle").unwrap();
        let b = s.binding(&p.project_id).unwrap();
        let manifest_path = s.management(&b, &format!("snapshots/{}/manifest.json", snapshot.snapshot_id)).unwrap();
        let mut manifest = serde_json::to_value(&snapshot).unwrap();
        manifest["schemaVersion"] = serde_json::json!(1);
        for key in ["parentSnapshotId", "createdAt", "git", "gitError"] {
            manifest.as_object_mut().unwrap().remove(key);
        }
        write_json(&manifest_path, &manifest).unwrap();
        let legacy = s.snapshot_get(&p.project_id, &snapshot.snapshot_id).unwrap();
        assert_eq!(legacy.schema_version, 1);
        assert!(legacy.parent_snapshot_id.is_none() && legacy.created_at.is_none());
        assert!(legacy.git.is_none() && legacy.git_error.is_none());
        assert_eq!(s.bundle_get(&p.project_id, &snapshot.snapshot_id).unwrap(), "legacy bundle");
        let mut local = s.feedback(&p.project_id, envelope(&p, &snapshot, "legacy")).unwrap();
        local.decisions.insert("README.md".into(), Decision { status: "rejected".into(), ..Default::default() });
        let mut json = serde_json::to_value(local).unwrap();
        for key in ["review", "annotation_decisions", "receipt", "git", "superseded_by"] {
            json.as_object_mut().unwrap().remove(key);
        }
        for key in ["hunkSummary", "reason", "gitBranch", "gitCommit"] {
            json["decisions"]["README.md"].as_object_mut().unwrap().remove(key);
        }
        write_json(&s.inbox_path(&b, "legacy").unwrap(), &json).unwrap();
        let legacy = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert!(legacy.review.is_empty() && legacy.annotation_decisions.is_empty());
        assert!(legacy.receipt.is_none() && legacy.git.is_none() && legacy.superseded_by.is_none());
        let d = &legacy.decisions["README.md"];
        assert!(d.hunk_summary.is_none() && d.reason.is_none() && d.git_branch.is_none() && d.git_commit.is_none());
        assert_eq!(legacy.status, "rejected");
        for version in [0, 3] {
            manifest["schemaVersion"] = serde_json::json!(version);
            write_json(&manifest_path, &manifest).unwrap();
            assert!(s.snapshot_get(&p.project_id, &snapshot.snapshot_id).unwrap_err().contains("snapshot schema"));
            assert!(s.bundle_get(&p.project_id, &snapshot.snapshot_id).is_err());
            assert_eq!(s.feedback(&p.project_id, envelope(&p, &snapshot, &format!("unknown{version}"))).unwrap().status, "quarantined");
        }
        manifest["schemaVersion"] = serde_json::json!(2);
        write_json(&manifest_path, &manifest).unwrap();
        let mut unsupported_protocol = envelope(&p, &snapshot, "protocol3");
        unsupported_protocol.payload.v1_mut().schema_version = 3;
        assert_eq!(s.feedback(&p.project_id, unsupported_protocol).unwrap().status, "quarantined");
    }

    #[test]
    fn project_share_review_draft_exact_utf8_limit_and_ipc_keys() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snapshot, "limit")).unwrap();
        let mut draft = review_draft();
        draft.hunks = [("padding".into(), serde_json::json!(""))].into();
        let overhead = serde_json::to_vec(&draft).unwrap().len();
        draft.hunks.insert("padding".into(), serde_json::json!("a".repeat(1024 * 1024 - overhead)));
        assert_eq!(serde_json::to_vec(&draft).unwrap().len(), 1024 * 1024);
        let local = s.review_save(&p.project_id, "limit", "README.md", draft.clone()).unwrap();
        let json = serde_json::to_value(&local).unwrap();
        let saved = &json["review"]["README.md"];
        assert_eq!(saved["kernel_version"], MERGE_KERNEL_VERSION);
        assert_eq!(saved["ours_hash"], draft.ours_hash);
        assert_eq!(saved["updated_at"], draft.updated_at);
        assert!(saved.get("kernelVersion").is_none());
        assert_eq!(*saved, serde_json::to_value(&draft).unwrap());
        let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "limit").unwrap();
        let before = std::fs::read(&path).unwrap();
        draft.hunks.insert("padding".into(), serde_json::json!("a".repeat(1024 * 1024 - overhead + 1)));
        assert!(s.review_save(&p.project_id, "limit", "README.md", draft.clone()).unwrap_err().starts_with("review draft too large"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let chars = (1024 * 1024 - overhead) / 3 + 1;
        draft.hunks.insert("padding".into(), serde_json::json!("中".repeat(chars)));
        assert!(chars < 1024 * 1024);
        assert!(serde_json::to_vec(&draft).unwrap().len() > 1024 * 1024);
        assert!(s.review_save(&p.project_id, "limit", "README.md", draft).unwrap_err().starts_with("review draft too large"));
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[test]
    fn project_share_review_draft_validation_preserves_previous_draft() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut e = envelope(&p, &snapshot, "validation");
        e.payload.v1_mut().annotations.push(review_annotation("docs/a.md"));
        s.feedback(&p.project_id, e).unwrap();
        for target in [None, Some("worktree"), Some("branch"), Some("patch")] {
            let mut draft = review_draft();
            draft.target = target.map(String::from);
            let f = s.review_save(&p.project_id, "validation", "README.md", draft.clone()).unwrap();
            assert_eq!(serde_json::to_value(&f.review["README.md"]).unwrap(), serde_json::to_value(draft).unwrap());
        }
        let inbox_path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "validation").unwrap();
        let before = std::fs::read(&inbox_path).unwrap();
        for version in [0, MERGE_KERNEL_VERSION + 1] {
            let mut draft = review_draft();
            draft.kernel_version = version;
            assert!(s.review_save(&p.project_id, "validation", "README.md", draft).unwrap_err().starts_with("kernel version mismatch"));
        }
        for path in ["docs/a.md", "missing.md", "../README.md"] {
            assert!(s.review_save(&p.project_id, "validation", path, review_draft()).is_err());
        }
        let mut draft = review_draft();
        draft.target = Some("remote".into());
        assert!(s.review_save(&p.project_id, "validation", "README.md", draft).is_err());
        assert_eq!(std::fs::read(inbox_path).unwrap(), before);
    }

    #[test]
    fn project_share_review_annotation_decisions_do_not_write_source() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut e = envelope(&p, &snapshot, "annotations");
        e.payload.v1_mut().edits.clear();
        e.payload.v1_mut().annotations.push(review_annotation("README.md"));
        s.feedback(&p.project_id, e).unwrap();
        let source = Path::new(&p.source_root).join("README.md");
        let before = std::fs::read(&source).unwrap();
        for value in ["promoted", "dismissed"] {
            let f = s.annotation_decide(&p.project_id, "annotations", 0, value).unwrap();
            assert_eq!(f.annotation_decisions["0"], value);
            assert_eq!(f.status, "pending");
        }
        let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "annotations").unwrap();
        let persisted = std::fs::read(&path).unwrap();
        assert!(s.annotation_decide(&p.project_id, "annotations", 1, "promoted").unwrap_err().starts_with("annotation index out of range"));
        assert!(s.annotation_decide(&p.project_id, "annotations", usize::MAX, "promoted").unwrap_err().starts_with("annotation index out of range"));
        assert!(s.annotation_decide(&p.project_id, "annotations", 0, "accepted").is_err());
        assert!(s.review_save(&p.project_id, "annotations", "README.md", review_draft()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), persisted);
        assert_eq!(s.inbox(&p.project_id).unwrap()[0].annotation_decisions["0"], "dismissed");
        assert_eq!(std::fs::read(source).unwrap(), before);
        assert_eq!(std::fs::read(Path::new(&p.mirror_root).join("README.md")).unwrap(), before);
    }

    #[test]
    fn project_share_review_new_ops_respect_deletion_and_trust_boundaries() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut e = envelope(&p, &snapshot, "active");
        e.payload.v1_mut().annotations.push(review_annotation("README.md"));
        s.feedback(&p.project_id, e.clone()).unwrap();
        let mut forged = e;
        forged.payload.v1_mut().submission_id = "quarantine".into();
        forged.payload.v1_mut().edits[0].base_hash = "forged".into();
        assert_eq!(s.feedback(&p.project_id, forged).unwrap().status, "quarantined");
        assert!(s.review_save(&p.project_id, "quarantine", "README.md", review_draft()).unwrap_err().contains("quarantined"));
        assert!(s.annotation_decide(&p.project_id, "quarantine", 0, "promoted").unwrap_err().contains("quarantined"));
        s.begin_delete(&p.project_id).unwrap();
        let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "active").unwrap();
        let before = std::fs::read(&path).unwrap();
        let records = std::fs::read(s.records_path()).unwrap();
        assert_eq!(s.review_save(&p.project_id, "active", "README.md", review_draft()).unwrap_err(), "project deletion in progress");
        assert_eq!(s.annotation_decide(&p.project_id, "active", 0, "promoted").unwrap_err(), "project deletion in progress");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read(s.records_path()).unwrap(), records);
        s.cancel_delete(&p.project_id).unwrap();
        let baseline = s.management(&s.binding(&p.project_id).unwrap(), &format!("snapshots/{}/files/README.md", snapshot.snapshot_id)).unwrap();
        std::fs::write(baseline, "corrupted baseline").unwrap();
        assert!(s.review_save(&p.project_id, "active", "README.md", review_draft()).unwrap_err().contains("baseline corrupted"));
        assert!(s.annotation_decide(&p.project_id, "active", 0, "promoted").unwrap_err().contains("baseline corrupted"));
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[test]
    fn project_share_review_apply_persists_summary_clears_only_applied_draft_and_is_idempotent() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut e = envelope(&p, &snapshot, "apply");
        let second = snapshot.files.iter().find(|f| f.path == "docs/a.md").unwrap();
        e.payload.v1_mut().edits.push(Edit { path: second.path.clone(), base_hash: second.hash.clone(), after_markdown: "second".into() });
        s.feedback(&p.project_id, e).unwrap();
        for path in ["README.md", "docs/a.md"] {
            s.review_save(&p.project_id, "apply", path, review_draft()).unwrap();
        }
        let review = s.review(&p.project_id, "apply", "README.md").unwrap();
        let summary = HunkSummary { accepted: 2, total: 3 };
        let content = "\u{feff}owner\r\nguest\r\n";
        let applied = s.apply(&p.project_id, "apply", "README.md", &review.current_hash, content, Some(summary.clone())).unwrap();
        assert_eq!(applied.decisions["README.md"].status, "accepted");
        assert_eq!(applied.decisions["README.md"].hunk_summary, Some(summary.clone()));
        assert!(!applied.review.contains_key("README.md"));
        assert!(applied.review.contains_key("docs/a.md"));
        let persisted = s.inbox(&p.project_id).unwrap().pop().unwrap();
        let json = serde_json::to_value(&persisted).unwrap();
        assert_eq!(json["decisions"]["README.md"]["hunkSummary"], serde_json::json!({"accepted":2,"total":3}));
        assert!(json["decisions"]["README.md"].get("hunk_summary").is_none());
        let repeated = s.apply(&p.project_id, "apply", "README.md", "stale", "different second apply", Some(HunkSummary { accepted: 0, total: 0 })).unwrap();
        assert_eq!(repeated.decisions["README.md"].hunk_summary, Some(summary));
        assert_eq!(std::fs::read(&review.source_path).unwrap(), content.as_bytes());
        assert_eq!(std::fs::read(Path::new(&p.mirror_root).join("README.md")).unwrap(), content.as_bytes());
    }

    #[test]
    fn project_share_review_annotation_only_apply_uses_existing_source_path() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut e = envelope(&p, &snapshot, "promote");
        e.payload.v1_mut().edits.clear();
        e.payload.v1_mut().annotations.push(review_annotation("README.md"));
        s.feedback(&p.project_id, e).unwrap();
        let review = s.review(&p.project_id, "promote", "README.md").unwrap();
        assert!(s.apply(&p.project_id, "promote", "docs/a.md", &review.current_hash, "outside", None).unwrap_err().contains("no edit or annotation"));
        let applied = s.apply(&p.project_id, "promote", "README.md", &review.current_hash, "owner + promoted annotation", Some(HunkSummary { accepted: 0, total: 0 })).unwrap();
        assert_eq!(applied.decisions["README.md"].status, "accepted");
        assert!(applied.annotation_decisions.is_empty());
        assert_eq!(std::fs::read_to_string(&review.source_path).unwrap(), "owner + promoted annotation");
        s.annotation_decide(&p.project_id, "promote", 0, "promoted").unwrap();
        assert_eq!(s.inbox(&p.project_id).unwrap()[0].annotation_decisions["0"], "promoted");
    }

    #[test]
    fn project_share_review_cas_summary_and_terminal_protection_preserve_draft() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snapshot, "cas")).unwrap();
        s.review_save(&p.project_id, "cas", "README.md", review_draft()).unwrap();
        let review = s.review(&p.project_id, "cas", "README.md").unwrap();
        let before = std::fs::read(&review.source_path).unwrap();
        assert!(s.apply(&p.project_id, "cas", "README.md", &review.current_hash, "invalid", Some(HunkSummary { accepted: 2, total: 1 })).unwrap_err().contains("summary"));
        assert_eq!(std::fs::read(&review.source_path).unwrap(), before);
        std::fs::write(&review.source_path, "new owner text").unwrap();
        assert!(s.apply(&p.project_id, "cas", "README.md", &review.current_hash, "guest", None).unwrap_err().starts_with("source changed"));
        assert_eq!(s.review(&p.project_id, "cas", "README.md").unwrap().status, "source_changed");
        let f = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert!(f.review.contains_key("README.md") && f.decisions.is_empty());
        let current = sha256_hex(b"new owner text");
        std::fs::write(Path::new(&p.mirror_root).join("README.md"), "mirror conflict").unwrap();
        assert!(s.apply(&p.project_id, "cas", "README.md", &current, "guest", None).is_err());
        let mut f = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert!(f.review.contains_key("README.md") && f.decisions.is_empty());
        let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "cas").unwrap();
        for status in ["rejected", "recovery_conflict"] {
            f.decisions.insert("README.md".into(), Decision { status: status.into(), ..Default::default() });
            write_json(&path, &f).unwrap();
            assert!(s.apply(&p.project_id, "cas", "README.md", &current, "guest", None).unwrap_err().contains("decision prevents"));
            assert!(s.inbox(&p.project_id).unwrap()[0].review.contains_key("README.md"));
        }
        assert_eq!(std::fs::read_to_string(&review.source_path).unwrap(), "new owner text");
    }

    #[test]
    fn project_share_review_recover_clears_draft_only_for_written_result() {
        for scenario in ["written", "before", "third", "offline", "deleting"] {
            let (t, s, p) = fixture();
            let snapshot = freeze(&s, &p);
            s.feedback(&p.project_id, envelope(&p, &snapshot, scenario)).unwrap();
            let mut f = s.review_save(&p.project_id, scenario, "README.md", review_draft()).unwrap();
            let source = Path::new(&p.source_root).join("README.md");
            let before = std::fs::read(&source).unwrap();
            let summary = HunkSummary { accepted: 1, total: 2 };
            f.decisions.insert("README.md".into(), Decision {
                status: "pending".into(), before_hash: Some(sha256_hex(&before)),
                result_hash: Some(sha256_hex(b"written result")), content: Some("written result".into()),
                hunk_summary: Some(summary.clone()), ..Default::default()
            });
            let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), scenario).unwrap();
            write_json(&path, &f).unwrap();
            let intent = std::fs::read(&path).unwrap();
            match scenario {
                "written" => std::fs::write(&source, "written result").unwrap(),
                "third" => std::fs::write(&source, "external third text").unwrap(),
                "offline" => std::fs::rename(&p.source_root, t.path().join("source-moved")).unwrap(),
                "deleting" => s.begin_delete(&p.project_id).unwrap(),
                _ => (),
            }
            let recovered = s.inbox(&p.project_id).unwrap().pop().unwrap();
            let decision = &recovered.decisions["README.md"];
            assert_eq!(decision.hunk_summary, Some(summary), "{scenario}");
            assert_eq!(recovered.review.contains_key("README.md"), scenario != "written", "{scenario}");
            match scenario {
                "written" => {
                    assert_eq!(decision.status, "accepted");
                    assert_eq!(std::fs::read_to_string(Path::new(&p.mirror_root).join("README.md")).unwrap(), "written result");
                    assert!(decision.content.is_none());
                }
                "before" => { assert_eq!(decision.status, "not_applied"); assert_eq!(std::fs::read(&source).unwrap(), before); }
                "third" => { assert_eq!(decision.status, "recovery_conflict"); assert_eq!(std::fs::read_to_string(&source).unwrap(), "external third text"); }
                _ => { assert_eq!(decision.status, "pending"); assert_eq!(std::fs::read(&path).unwrap(), intent); }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn project_share_review_mirror_pending_keeps_summary_and_clears_draft_without_reapply() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snapshot, "mirror-pending")).unwrap();
        s.review_save(&p.project_id, "mirror-pending", "README.md", review_draft()).unwrap();
        let review = s.review(&p.project_id, "mirror-pending", "README.md").unwrap();
        let metadata = s.vault.join(".notemd");
        let saved = s.vault.join("metadata-saved");
        std::fs::rename(&metadata, &saved).unwrap();
        std::os::unix::fs::symlink(&saved, &metadata).unwrap();
        let summary = HunkSummary { accepted: 1, total: 1 };
        let pending = s.apply(&p.project_id, "mirror-pending", "README.md", &review.current_hash, "persisted result", Some(summary.clone())).unwrap();
        assert_eq!(pending.decisions["README.md"].status, "mirror_pending");
        assert_eq!(pending.decisions["README.md"].hunk_summary, Some(summary.clone()));
        assert!(!pending.review.contains_key("README.md"));
        assert_eq!(std::fs::read_to_string(&review.source_path).unwrap(), "persisted result");
        let repeated = s.apply(&p.project_id, "mirror-pending", "README.md", "stale", "never written", None).unwrap();
        assert_eq!(repeated.decisions["README.md"].status, "mirror_pending");
        assert_eq!(repeated.decisions["README.md"].hunk_summary, Some(summary.clone()));
        let rejected = s.reject(&p.project_id, "mirror-pending", Some("README.md"), Some("superseded")).unwrap();
        assert_eq!(rejected.decisions["README.md"].status, "mirror_pending");
        assert!(rejected.decisions["README.md"].reason.is_none());
        std::fs::remove_file(&metadata).unwrap();
        std::fs::rename(&saved, &metadata).unwrap();
        let recovered = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert_eq!(recovered.decisions["README.md"].status, "accepted");
        assert_eq!(recovered.decisions["README.md"].hunk_summary, Some(summary));
        assert!(!recovered.review.contains_key("README.md"));
        assert_eq!(std::fs::read_to_string(&review.source_path).unwrap(), "persisted result");
    }

    #[test]
    fn project_share_review_reject_reason_roundtrips_and_preserves_terminal_decisions() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut e = envelope(&p, &snapshot, "reject");
        let second = snapshot.files.iter().find(|f| f.path == "docs/a.md").unwrap();
        e.payload.v1_mut().edits.push(Edit { path: second.path.clone(), base_hash: second.hash.clone(), after_markdown: "second".into() });
        s.feedback(&p.project_id, e).unwrap();
        assert!(s.reject(&p.project_id, "reject", None, Some("other")).is_err());
        let rejected = s.reject(&p.project_id, "reject", Some("README.md"), Some("superseded")).unwrap();
        assert_eq!(rejected.decisions["README.md"].reason.as_deref(), Some("superseded"));
        assert!(!rejected.decisions.contains_key("docs/a.md"));
        s.reject(&p.project_id, "reject", None, Some("superseded")).unwrap();
        let persisted = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert_eq!(persisted.status, "rejected");
        assert_eq!(persisted.decisions["docs/a.md"].reason.as_deref(), Some("superseded"));
        let mut f = persisted;
        let path = s.inbox_path(&s.binding(&p.project_id).unwrap(), "reject").unwrap();
        for status in ["accepted", "recovery_conflict"] {
            f.decisions.insert("README.md".into(), Decision { status: status.into(), reason: None, ..Default::default() });
            write_json(&path, &f).unwrap();
            let rejected = s.reject(&p.project_id, "reject", Some("README.md"), Some("superseded")).unwrap();
            assert_eq!(rejected.decisions["README.md"].status, status);
            assert!(rejected.decisions["README.md"].reason.is_none());
        }
    }

    #[test]
    fn project_share_review_ipc_strictly_parses_new_fields_and_keeps_legacy_omissions() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut e = envelope(&p, &snapshot, "ipc");
        e.payload.v1_mut().annotations.push(review_annotation("README.md"));
        s.feedback(&p.project_id, e).unwrap();
        let source = Path::new(&p.source_root).join("README.md");
        let before = std::fs::read(&source).unwrap();
        let mut request = serde_json::json!({"op":"review-save","project_id":p.project_id,"submissionId":"ipc","path":"README.md","draft":review_draft()});
        let saved = dispatch(&s, &request).unwrap();
        assert_eq!(saved["review"]["README.md"]["kernel_version"], 1);
        for bad in [serde_json::Value::Null, serde_json::json!({}), serde_json::json!({"kernelVersion":1,"ours_hash":"h","hunks":{},"updated_at":"t"}), serde_json::json!({"kernel_version":1,"ours_hash":"h","hunks":[],"updated_at":"t"})] {
            request["draft"] = bad;
            assert!(dispatch(&s, &request).unwrap_err().starts_with("invalid draft:"));
        }
        request.as_object_mut().unwrap().remove("draft");
        assert_eq!(dispatch(&s, &request).unwrap_err(), "missing draft");
        let mut request = serde_json::json!({"op":"annotation-decide","project_id":p.project_id,"submissionId":"ipc","index":0,"value":"promoted"});
        assert_eq!(dispatch(&s, &request).unwrap()["annotation_decisions"]["0"], "promoted");
        for bad in [serde_json::json!(-1), serde_json::json!(0.5), serde_json::json!("0"), serde_json::Value::Null, serde_json::json!(false)] {
            request["index"] = bad;
            assert!(dispatch(&s, &request).unwrap_err().starts_with("invalid index:"));
        }
        request.as_object_mut().unwrap().remove("index");
        assert_eq!(dispatch(&s, &request).unwrap_err(), "missing index");
        request["index"] = serde_json::json!(0);
        request["value"] = serde_json::json!(123);
        assert!(dispatch(&s, &request).is_err());
        let mut request = serde_json::json!({"op":"apply","project_id":p.project_id,"submissionId":"ipc","path":"README.md","expectedHash":sha256_hex(&before),"content":"IPC final"});
        for bad in [serde_json::json!(false), serde_json::json!("bad"), serde_json::json!({"accepted":-1,"total":1}), serde_json::json!({"accepted":0.5,"total":1}), serde_json::json!({"accepted":1}), serde_json::json!({"accepted":4294967296u64,"total":4294967296u64})] {
            request["summary"] = bad;
            assert!(dispatch(&s, &request).unwrap_err().starts_with("invalid summary:"));
        }
        request["summary"] = serde_json::json!({"accepted":2,"total":1});
        assert_eq!(dispatch(&s, &request).unwrap_err(), "invalid hunk summary");
        let mut reject = serde_json::json!({"op":"reject","project_id":p.project_id,"submissionId":"ipc","path":"README.md"});
        for bad in [serde_json::json!(false), serde_json::json!(123), serde_json::json!({})] {
            reject["reason"] = bad;
            assert!(dispatch(&s, &reject).unwrap_err().starts_with("invalid reason:"));
        }
        reject["reason"] = serde_json::json!("invalid");
        assert_eq!(dispatch(&s, &reject).unwrap_err(), "invalid reject reason");
        reject["reason"] = serde_json::Value::Null;
        reject["path"] = serde_json::json!(false);
        assert!(dispatch(&s, &reject).unwrap_err().starts_with("invalid path:"));
        assert_eq!(std::fs::read(&source).unwrap(), before);
        let f = s.inbox(&p.project_id).unwrap().pop().unwrap();
        assert!(f.decisions.is_empty() && f.review.contains_key("README.md"));
        request.as_object_mut().unwrap().remove("summary");
        assert_eq!(dispatch(&s, &request).unwrap()["decisions"]["README.md"]["hunkSummary"], serde_json::Value::Null);
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "IPC final");
        // Explicit null remains compatible with the same omitted optional field.
        request["summary"] = serde_json::Value::Null;
        assert_eq!(dispatch(&s, &request).unwrap()["decisions"]["README.md"]["status"], "accepted");
        let e = envelope(&p, &snapshot, "legacy-reject");
        s.feedback(&p.project_id, e).unwrap();
        reject["submissionId"] = serde_json::json!("legacy-reject");
        reject["path"] = serde_json::json!("README.md");
        reject.as_object_mut().unwrap().remove("reason");
        assert_eq!(dispatch(&s, &reject).unwrap()["decisions"]["README.md"]["reason"], serde_json::Value::Null);
    }

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
        assert!(s.apply(&p.project_id, "offline", "README.md", "hash", "edit", None).is_err());
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
    fn project_share_delete_cleans_finder_metadata_without_touching_sources() {
        let (_t, s, p) = fixture();
        let snap = freeze(&s, &p);
        s.feedback(&p.project_id, envelope(&p, &snap, "metadata-test")).unwrap();
        let root = Path::new(&p.mirror_root);
        let paths = [".DS_Store".to_string(), ".notemd/.DS_Store".into(),
            ".notemd/snapshots/.DS_Store".into(), ".notemd/inbox/.DS_Store".into(),
            format!(".notemd/snapshots/{}/files/docs/.DS_Store", snap.snapshot_id)];
        let source_metadata = Path::new(&p.source_root).join(".DS_Store");
        std::fs::write(&source_metadata, "source metadata").unwrap();
        for path in &paths {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "Finder metadata").unwrap();
        }
        s.begin_delete(&p.project_id).unwrap();
        assert!(!s.binding(&p.project_id).unwrap().deletion_files.unwrap().keys().any(|path| path.ends_with(".DS_Store")));
        for path in &paths { std::fs::write(root.join(path), "updated metadata").unwrap(); }
        std::fs::write(root.join("docs/.DS_Store"), "created after reservation").unwrap();
        s.delete(&p.project_id).unwrap();
        assert!(!root.exists());
        assert_eq!(std::fs::read_to_string(source_metadata).unwrap(), "source metadata");
        assert!(Path::new(&p.source_root).join("README.md").exists());
    }
    #[test]
    fn project_share_cleanup_handles_metadata_created_after_preflight() {
        let (_t, s, p) = fixture();
        freeze(&s, &p);
        s.begin_delete(&p.project_id).unwrap();
        let (_, files) = s.delete_preflight(&s.binding(&p.project_id).unwrap()).unwrap();
        let root = Path::new(&p.mirror_root);
        std::fs::write(root.join(".DS_Store"), "late metadata").unwrap();
        std::fs::write(root.join("docs/.DS_Store"), "late nested metadata").unwrap();
        remove_reserved_tree(root, &files).unwrap();
        s.delete(&p.project_id).unwrap();
        assert!(!root.exists());
        assert!(s.projects().unwrap().is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn project_share_delete_rejects_metadata_named_symlinks_and_directories() {
        let (t, s, p) = fixture();
        freeze(&s, &p);
        let outside = t.path().join("outside");
        std::fs::write(&outside, "preserve").unwrap();
        for name in [".DS_Store", ".notemd/snapshots/.DS_Store"] {
            let metadata = Path::new(&p.mirror_root).join(name);
            std::os::unix::fs::symlink(&outside, &metadata).unwrap();
            assert!(s.begin_delete(&p.project_id).is_err());
            assert_eq!(std::fs::read_to_string(&outside).unwrap(), "preserve");
            std::fs::remove_file(&metadata).unwrap();
            std::fs::create_dir(&metadata).unwrap();
            assert!(s.begin_delete(&p.project_id).is_err());
            std::fs::remove_dir(&metadata).unwrap();
        }
        let metadata = Path::new(&p.mirror_root).join(".DS_Store");
        s.begin_delete(&p.project_id).unwrap();
        let (_, files) = s.delete_preflight(&s.binding(&p.project_id).unwrap()).unwrap();
        std::os::unix::fs::symlink(&outside, &metadata).unwrap();
        assert!(remove_reserved_tree(Path::new(&p.mirror_root), &files).is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "preserve");
        std::fs::remove_file(&metadata).unwrap();
        s.delete(&p.project_id).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn project_share_cleanup_rejects_root_symlink_created_after_preflight() {
        let (t, s, p) = fixture();
        freeze(&s, &p);
        s.begin_delete(&p.project_id).unwrap();
        let (_, files) = s.delete_preflight(&s.binding(&p.project_id).unwrap()).unwrap();
        let root = Path::new(&p.mirror_root);
        let saved = root.with_extension("saved");
        std::fs::rename(root, &saved).unwrap();
        let outside = t.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join(".DS_Store"), "preserve outside metadata").unwrap();
        std::os::unix::fs::symlink(&outside, root).unwrap();
        assert!(remove_reserved_tree(root, &files).is_err());
        assert_eq!(std::fs::read_to_string(outside.join(".DS_Store")).unwrap(), "preserve outside metadata");
        assert!(saved.join("README.md").exists());
        std::fs::remove_file(root).unwrap();
        std::fs::rename(saved, root).unwrap();
        s.delete(&p.project_id).unwrap();
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
        for name in ["unknown.md", "README.note.md", ".notemd/unknown.json", ".keep", ".DS_Store.md"] {
            let path = Path::new(&p.mirror_root).join(name);
            std::fs::write(&path, "keep me").unwrap();
            assert!(s.begin_delete(&p.project_id).is_err());
            assert!(path.exists());
            std::fs::remove_file(path).unwrap();
        }
        let unknown = Path::new(&p.mirror_root).join("unknown-directory");
        std::fs::create_dir(&unknown).unwrap();
        std::fs::write(unknown.join(".DS_Store"), "metadata in unknown directory").unwrap();
        assert!(s.begin_delete(&p.project_id).is_err());
        assert!(unknown.join(".DS_Store").exists());
        std::fs::remove_dir_all(unknown).unwrap();
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
    #[test]
    fn project_share_v2_real_baseline_review_apply_and_reload() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let original = envelope(&p, &snapshot, "v2-real");
        let mut raw = serde_json::to_value(&original).unwrap();
        raw["payload"]["schemaVersion"] = serde_json::json!(2);
        raw["payload"].as_object_mut().unwrap().remove("name");
        raw["payload"]["contributor"] = serde_json::json!({"name":"Alice", "aiAssisted":true});
        raw["payload"]["message"] = serde_json::json!("Review message");
        raw["payload"]["supersedes"] = serde_json::json!("previous");
        raw["payload"]["rebasedFrom"] = serde_json::json!("S0");
        raw["payload"]["client"] = serde_json::json!({"kind":"browser", "version":"6.1013.1"});
        raw["payload"]["annotations"] = serde_json::json!([{"path":"README.md", "selector":{"exact":"accepted", "prefix":"", "suffix":" text", "start":0,"end":8}, "comment":"Check this", "kind":"question"}]);
        let v2: FeedbackEnvelope = serde_json::from_value(raw.clone()).unwrap();
        let local = s.feedback(&p.project_id, v2.clone()).unwrap();
        assert_eq!(local.status, "pending", "valid v2 must reach review");
        assert_eq!(serde_json::to_value(&local.envelope).unwrap(), raw);
        let review = s.review(&p.project_id, "v2-real", "README.md").unwrap();
        assert_eq!(review.base, snapshot.files.iter().find(|f| f.path == "README.md").unwrap().markdown.as_ref().unwrap().as_str());
        assert_eq!(review.after, "accepted text");
        let applied = s.apply(&p.project_id, "v2-real", "README.md", &review.current_hash, "accepted text", None).unwrap();
        assert_eq!(applied.status, "accepted");
        assert_eq!(serde_json::to_value(&s.inbox(&p.project_id).unwrap()[0].envelope).unwrap(), raw);
        let legacy = envelope(&p, &snapshot, "v1-after-v2");
        let legacy_raw = serde_json::to_value(&legacy).unwrap();
        s.feedback(&p.project_id, legacy).unwrap();
        let reloaded = s.inbox(&p.project_id).unwrap().into_iter().find(|f| f.envelope.payload.submission_id() == "v1-after-v2").unwrap();
        assert_eq!(serde_json::to_value(reloaded.envelope).unwrap(), legacy_raw);
        let mut altered = raw.clone(); altered["payload"]["message"] = serde_json::json!("Changed");
        assert!(s.feedback(&p.project_id, serde_json::from_value(altered).unwrap()).is_err());
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
            }.into(),
        }
    }
    #[test]
    fn project_share_forged_and_unknown_baselines_are_quarantined() {
        let (_t, s, p) = fixture();
        let snapshot = freeze(&s, &p);
        let mut forged = envelope(&p, &snapshot, "forged");
        forged.payload.v1_mut().edits[0].path = "../secret.md".into();
        assert_eq!(
            s.feedback(&p.project_id, forged).unwrap().status,
            "quarantined"
        );
        let mut unknown = envelope(&p, &snapshot, "unknown");
        unknown.payload.v1_mut().snapshot_id = "untrusted".into();
        assert_eq!(
            s.feedback(&p.project_id, unknown).unwrap().status,
            "quarantined"
        );
        let mut bad_hash = envelope(&p, &snapshot, "hash");
        bad_hash.payload.v1_mut().edits[0].base_hash = "fake".into();
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
                None,
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
                "guest",
                None,
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
                "guest",
                None,
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
                ..Default::default()
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
        e.payload.v1_mut().edits.push(Edit {
            path: second.path.clone(),
            base_hash: second.hash.clone(),
            after_markdown: "second edit".into(),
        });
        s.feedback(&p.project_id, e.clone()).unwrap();
        let rejected = s
            .reject(&p.project_id, "partial", Some("docs/a.md"), None)
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
                None,
            )
            .unwrap();
        assert_eq!(accepted.status, "accepted");
        assert_eq!(
            s.feedback(&p.project_id, e).unwrap().decisions["docs/a.md"].status,
            "rejected"
        );
        let mut annotations = envelope(&p, &snapshot, "notes");
        annotations.payload.v1_mut().edits.clear();
        annotations.payload.v1_mut().annotations.push(Annotation {
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
                None,
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
        e.payload.v1_mut().edits.push(Edit {
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
            None,
        )
        .unwrap();
        let mut rejected = e;
        rejected.payload.v1_mut().submission_id = "missing-rejected".into();
        rejected.request_hash = "missing-rejected".into();
        s.feedback(&p.project_id, rejected).unwrap();
        s.reject(&p.project_id, "missing-rejected", Some("docs/a.md"), None)
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
                "A final edit",
                None,
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
                "B edit",
                None,
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
                ..Default::default()
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
fn app_store(app: &tauri::AppHandle) -> Result<ProjectStore> {
    use tauri::Manager;
    let vault = crate::sotvault::resolve_vault_root(app)
        .ok_or("Vault not configured")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    Ok(ProjectStore::new(
        vault,
        app.path().app_data_dir().map_err(|e| e.to_string())?,
    ))
}
#[tauri::command]
pub async fn project_share(
    app: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || execute_request(&app_store(&app)?, &request))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn project_share_git(
    app: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || execute_git_request(&app_store(&app)?, &request))
        .await
        .map_err(|e| e.to_string())?
}

fn project_git_lock(service: &ProjectStore, id: &str) -> Result<Arc<Mutex<()>>> {
    valid_id(id)?;
    let key = service.state.join(id);
    let mut locks = GIT_LOCKS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|e| e.to_string())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    Ok(locks.entry(key).or_default().upgrade().unwrap_or_else(|| {
        let lock = Arc::new(Mutex::new(()));
        locks.insert(service.state.join(id), Arc::downgrade(&lock));
        lock
    }))
}
fn short_lock<T>(action: impl FnOnce() -> Result<T>) -> Result<T> {
    let _guard = PROJECT_LOCK.lock().map_err(|e| e.to_string())?;
    action()
}
fn json<T: Serialize>(value: T) -> Result<serde_json::Value> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}
fn request_string<'a>(request: &'a serde_json::Value, key: &str) -> Result<&'a str> {
    request
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing {key}"))
}

// All capture/finish functions do filesystem IO only. Immutable jobs never own
// PROJECT_LOCK or RecordsLock, including error and cleanup paths.
struct ShareGitJob {
    binding: Binding,
    snapshot: ProjectSnapshot,
    snapshot_hash: String,
    files: BTreeMap<String, Vec<u8>>,
    feedback: Option<LocalFeedback>,
}
impl ProjectStore {
    fn same_binding(&self, captured: &Binding) -> Result<Binding> {
        let current = self.binding(&captured.project_id)?;
        self.active(&current)?;
        if &current != captured {
            return Err("project binding changed; retry".into());
        }
        Ok(current)
    }
    fn capture_share_job(
        &self,
        id: &str,
        snapshot_id: &str,
        feedback: Option<LocalFeedback>,
    ) -> Result<ShareGitJob> {
        let binding = self.binding(id)?;
        self.active(&binding)?;
        let snapshot = self.baseline(&binding, snapshot_id)?;
        let snapshot_hash = snapshot_identity(&snapshot)?;
        let mut files = BTreeMap::new();
        for file in &snapshot.files {
            validate_relative(&file.path)?;
            let bytes = read_bytes(&self.management(
                &binding,
                &format!("snapshots/{snapshot_id}/files/{}", file.path),
            )?)?;
            if sha256_hex(&bytes) != file.hash {
                return Err("snapshot bytes changed".into());
            }
            files.insert(file.path.clone(), bytes);
        }
        if let Some(f) = &feedback {
            if f.status == "quarantined" {
                return Err("feedback quarantined".into());
            }
            self.validate_feedback(&binding, &f.envelope.payload)?;
            files = f
                .envelope
                .payload
                .edits()
                .iter()
                .map(|edit| (edit.path.clone(), edit.after_markdown.as_bytes().to_vec()))
                .collect();
        }
        Ok(ShareGitJob {
            binding,
            snapshot,
            snapshot_hash,
            files,
            feedback,
        })
    }
    fn verify_share_job(&self, job: &ShareGitJob) -> Result<()> {
        let binding = self.same_binding(&job.binding)?;
        if snapshot_identity(&self.baseline(&binding, &job.snapshot.snapshot_id)?)?
            != job.snapshot_hash
        {
            return Err("snapshot changed during Git operation".into());
        }
        if let Some(f) = &job.feedback {
            let latest: LocalFeedback =
                read_json(&self.inbox_path(&binding, f.envelope.payload.submission_id())?)?;
            if !same_envelope(&latest, f)? || latest.status == "quarantined" {
                return Err("feedback changed during Git operation".into());
            }
        }
        Ok(())
    }
    fn finish_share_job(
        &self,
        job: &ShareGitJob,
        outcome: &Result<Option<SnapshotGit>>,
    ) -> Result<serde_json::Value> {
        let _records = self.lock()?;
        self.verify_share_job(job)?;
        if let Some(f) = &job.feedback {
            let path = self.inbox_path(&job.binding, f.envelope.payload.submission_id())?;
            let mut latest: LocalFeedback = read_json(&path)?;
            let intent = latest.git.as_ref().and_then(|g| g.branch_intent.clone());
            latest.git = Some(SubmissionGit {
                branch_intent: intent,
                commit: outcome
                    .as_ref()
                    .ok()
                    .and_then(|v| v.as_ref().map(|g| g.snapshot_commit.clone())),
                error: outcome.as_ref().err().cloned(),
            });
            write_json(&path, &latest)?;
            json(latest)
        } else {
            let mut latest = self.baseline(&job.binding, &job.snapshot.snapshot_id)?;
            latest.git = outcome.as_ref().ok().cloned().flatten();
            latest.git_error = outcome.as_ref().err().cloned();
            write_json(
                &self.management(
                    &job.binding,
                    &format!("snapshots/{}/manifest.json", latest.snapshot_id),
                )?,
                &latest,
            )?;
            json(latest)
        }
    }
}
fn snapshot_identity(snapshot: &ProjectSnapshot) -> Result<String> {
    let mut s = snapshot.clone();
    s.git = None;
    s.git_error = None;
    Ok(sha256_hex(
        &serde_json::to_vec(&s).map_err(|e| e.to_string())?,
    ))
}
fn same_envelope(a: &LocalFeedback, b: &LocalFeedback) -> Result<bool> {
    Ok(
        serde_json::to_value(&a.envelope).map_err(|e| e.to_string())?
            == serde_json::to_value(&b.envelope).map_err(|e| e.to_string())?,
    )
}
fn message(f: &LocalFeedback, head: Option<&str>, coauthor: bool) -> String {
    let p = &f.envelope.payload;
    git::submission_message(
        p.project_id(),
        p.snapshot_id(),
        p.submission_id(),
        p.contributor_name(),
        None,
        None,
        head,
        coauthor,
    )
}
fn object_for_ref(repo: &git::GitRepo, name: &str, candidate: &str) -> Result<(String, bool)> {
    match git::ref_oid(repo, name)? {
        Some(existing) if git::same_commit(repo, &existing, candidate)? => Ok((existing, false)),
        Some(_) => Err("existing share ref has different content or identity".into()),
        None => Ok((candidate.into(), true)),
    }
}
fn run_share_job(
    service: &ProjectStore,
    job: &ShareGitJob,
    sampled: Result<Option<git::GitRepo>>,
) -> Result<Option<serde_json::Value>> {
    let repo = if let Some(f) = &job.feedback {
        let meta = job.snapshot.git.as_ref().ok_or("snapshot has no commit")?;
        let repo =
            git::probe(Path::new(&job.binding.source_root))?.ok_or("Git repository unavailable")?;
        if repo.root != Path::new(&meta.repo_root) || repo.prefix != meta.prefix {
            return Err("snapshot repository changed".into());
        }
        // A private manifest is not itself proof that its oid is our snapshot ref.
        let snap_ref = format!(
            "refs/notemd/share/{}/snapshots/{}",
            job.binding.project_id, job.snapshot.snapshot_id
        );
        if git::ref_oid(&repo, &snap_ref)?.as_deref() != Some(meta.snapshot_commit.as_str()) {
            return Err("snapshot ref mismatch".into());
        }
        let _ = f;
        repo
    } else {
        match sampled? {
            Some(repo) => repo,
            None => return Ok(None),
        }
    };
    let (parent, name, msg, author) = if let Some(f) = &job.feedback {
        let payload = &f.envelope.payload;
        (
            job.snapshot.git.as_ref().unwrap().snapshot_commit.clone(),
            format!(
                "refs/notemd/share/{}/submissions/{}",
                job.binding.project_id, payload.submission_id()
            ),
            message(f, None, false),
            git::guest_author(
                payload.contributor_name(),
                payload.submission_id(),
                &f.envelope.received_at,
            ),
        )
    } else {
        git::ensure_head(&repo, &repo.head)?;
        (
            repo.head.clone(),
            format!(
                "refs/notemd/share/{}/snapshots/{}",
                job.binding.project_id, job.snapshot.snapshot_id
            ),
            format!("notemd: share snapshot {}\n\nNotemd-Project: {}\nNotemd-Snapshot: {}\n", job.snapshot.snapshot_id, job.binding.project_id, job.snapshot.snapshot_id),
            git::owner_author(
                &repo,
                job.snapshot
                    .created_at
                    .as_deref()
                    .ok_or("snapshot creation date missing")?,
            )?,
        )
    };
    // The committer must be the configured owner, never an implicit OS fallback.
    git::owner_author(&repo, &author.date)?;
    let candidate = git::build_commit(&repo, &parent, &job.files, &msg, Some(&author))?;
    let (oid, newly_created) = object_for_ref(&repo, &name, &candidate)?;
    short_lock(|| service.verify_share_job(job))?;
    if job.feedback.is_none() {
        git::ensure_head(&repo, &repo.head)?;
    }
    git::create_ref(&repo, &name, &oid)?;
    let metadata = SnapshotGit {
        snapshot_commit: oid.clone(),
        head_at_freeze: repo.head.clone(),
        prefix: repo.prefix.clone(),
        repo_root: repo.root.to_string_lossy().into(),
    };
    // Tests exercise exactly this gap (draft, delete, rebind, stop, write failure).
    git_test_hook(service, "share-ref-created");
    let outcome = Ok(Some(metadata.clone()));
    match short_lock(|| service.finish_share_job(job, &outcome)) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            if newly_created {
                git::delete_created_ref(&repo, &name, &oid)?;
            }
            Err("Git metadata could not be saved; retry".into())
        }
    }
}
fn execute_request(
    service: &ProjectStore,
    request: &serde_json::Value,
) -> Result<serde_json::Value> {
    let op = request_string(request, "op")?;
    if op == "git-branched" {
        return execute_git_request(service, request);
    }
    if op == "cancel-delete" {
        let lock = project_git_lock(service, request_string(request, "project_id")?)?;
        let _operation = lock.lock().map_err(|e| e.to_string())?;
        return short_lock(|| dispatch(service, request));
    }
    if !matches!(op, "snapshot" | "feedback" | "delete") {
        return short_lock(|| dispatch(service, request));
    }
    let id = request_string(request, "project_id")?;
    // Mark/capture deletion under the global lock, then wait OUTSIDE both store locks.
    if op == "delete" {
        let binding = short_lock(|| {
            if !service.bindings()?.iter().any(|b| b.project_id == id) {
                return Ok(None);
            }
            let b = service.binding(id)?;
            if !b.deleting {
                return Err("begin deletion before deleting project".into());
            }
            if b.deletion_requires_stop {
                return Err("stop remote sharing before deleting project".into());
            }
            let mut roots = vec![PathBuf::from(&b.source_root)];
            // A moved/deleted source subdirectory can leave its repository alive.
            // Only locally captured snapshot metadata supplies fallback roots.
            let snapshots = service.management(&b, "snapshots")?;
            if snapshots.is_dir() {
                for entry in std::fs::read_dir(snapshots).map_err(io_error)? {
                    let entry = entry.map_err(io_error)?;
                    let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                        continue;
                    };
                    if let Ok(snapshot) = service.baseline(&b, &name) {
                        if let Some(meta) = snapshot.git {
                            roots.push(PathBuf::from(meta.repo_root));
                        }
                    }
                }
            }
            roots.sort();
            roots.dedup();
            Ok(Some((b, roots)))
        })?;
        let Some((binding, roots)) = binding else {
            return Ok(serde_json::Value::Null);
        };
        let lock = project_git_lock(service, id)?;
        let _operation = lock.lock().map_err(|e| e.to_string())?;
        short_lock(|| {
            if service.binding(id)? != binding {
                return Err("deletion reservation changed; retry".into());
            }
            Ok(())
        })?;
        // Cleanup failure is local diagnostic only, never a blocker for deletion.
        for root in roots {
            let cleanup = git::probe(&root).and_then(|repo| {
                repo.map(|r| git::delete_project_refs(&r, id))
                    .unwrap_or(Ok(()))
            });
            if cleanup.is_err() {
                eprintln!("project-share: hidden Git refs cleanup failed");
            }
        }
        return short_lock(|| dispatch(service, request));
    }
    let lock = project_git_lock(service, id)?;
    let _operation = lock.lock().map_err(|e| e.to_string())?;
    let before = short_lock(|| service.binding(id))?;
    let sampled = if op == "snapshot" {
        git::probe(Path::new(&before.source_root))
    } else {
        Ok(None)
    };
    git_test_hook(service, "head-sampled");
    let (value, job) = short_lock(|| {
        service.same_binding(&before)?;
        let value = dispatch(service, request)?;
        let job = if op == "snapshot" {
            let snap: ProjectSnapshot =
                serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            service.capture_share_job(id, &snap.snapshot_id, None)
        } else {
            let feedback: LocalFeedback =
                serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            service.capture_share_job(
                id,
                &feedback.envelope.payload.snapshot_id().to_owned(),
                Some(feedback),
            )
        };
        Ok((value, job))
    })?;
    // P0 has already succeeded. Every Git error is non-fatal to that workflow.
    let Ok(job) = job else {
        return Ok(value);
    };
    match run_share_job(service, &job, sampled) {
        Ok(Some(value)) => Ok(value),
        Ok(None) => short_lock(|| service.finish_share_job(&job, &Ok(None))).or(Ok(value)),
        Err(error) => short_lock(|| service.finish_share_job(&job, &Err(error))).or(Ok(value)),
    }
}

#[cfg(not(test))]
fn git_test_hook(_: &ProjectStore, _: &str) {}
#[cfg(test)]
thread_local! { static GIT_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&ProjectStore, &str)>>> = std::cell::RefCell::new(None); }
#[cfg(test)]
fn git_test_hook(service: &ProjectStore, phase: &str) {
    GIT_TEST_HOOK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(service, phase);
        }
    });
}
#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
enum GitRequest {
    #[serde(rename = "probe")]
    Probe { project_id: String },
    #[serde(rename = "prepare")]
    Prepare {
        project_id: String,
        #[serde(rename = "submissionId")]
        submission: String,
    },
    #[serde(rename = "commit-message")]
    CommitMessage {
        project_id: String,
        #[serde(rename = "submissionId")]
        submission: String,
    },
    #[serde(rename = "branch")]
    Branch {
        project_id: String,
        #[serde(rename = "submissionId")]
        submission: String,
        #[serde(rename = "expectedHead")]
        head: String,
        results: BTreeMap<String, String>,
    },
    #[serde(rename = "export-patch")]
    Patch {
        project_id: String,
        #[serde(rename = "submissionId")]
        submission: String,
        #[serde(rename = "expectedHead")]
        head: String,
        results: BTreeMap<String, String>,
    },
    #[serde(rename = "branch-state")]
    BranchState {
        project_id: String,
        #[serde(rename = "submissionId")]
        submission: String,
    },
    #[serde(rename = "git-branched")]
    Branched {
        project_id: String,
        #[serde(rename = "submissionId")]
        submission: String,
        path: String,
        branch: String,
        commit: String,
        #[serde(default)]
        summary: Option<HunkSummary>,
    },
}
impl GitRequest {
    fn project(&self) -> &str {
        match self {
            Self::Probe { project_id }
            | Self::Prepare { project_id, .. }
            | Self::CommitMessage { project_id, .. }
            | Self::Branch { project_id, .. }
            | Self::Patch { project_id, .. }
            | Self::Branched { project_id, .. }
            | Self::BranchState { project_id, .. } => project_id,
        }
    }
    fn submission(&self) -> Option<&str> {
        match self {
            Self::Probe { .. } => None,
            Self::Prepare { submission, .. }
            | Self::CommitMessage { submission, .. }
            | Self::Branch { submission, .. }
            | Self::Patch { submission, .. }
            | Self::Branched { submission, .. }
            | Self::BranchState { submission, .. } => Some(submission),
        }
    }
}
struct GitReview {
    job: ShareGitJob,
    entry: String,
    scope: Vec<String>,
    base: BTreeMap<String, String>,
}
impl ProjectStore {
    fn capture_git_review(&self, id: &str, submission: &str) -> Result<GitReview> {
        let _records = self.lock()?;
        let b = self.binding(id)?;
        self.active(&b)?;
        let f: LocalFeedback = read_json(&self.inbox_path(&b, submission)?)?;
        if f.envelope.payload.project_id() != id || f.envelope.payload.submission_id() != submission {
            return Err("feedback identity mismatch".into());
        }
        ensure_no_worktree_intent(&f)?;
        let c = self.config(&b)?;
        let job = self.capture_share_job(id, f.envelope.payload.snapshot_id(), Some(f.clone()))?;
        let mut base = BTreeMap::new();
        for edit in f.envelope.payload.edits() {
            if !c.files.contains(&edit.path) {
                return Err("file outside current shared scope".into());
            }
            let bytes = read_bytes(&self.management(
                &b,
                &format!(
                    "snapshots/{}/files/{}",
                    f.envelope.payload.snapshot_id(), edit.path
                ),
            )?)?;
            base.insert(
                edit.path.clone(),
                String::from_utf8(bytes).map_err(|_| "baseline is not UTF-8")?,
            );
        }
        Ok(GitReview {
            job,
            entry: c.entry,
            scope: c.files,
            base,
        })
    }
    fn verify_git_review(&self, review: &GitReview) -> Result<LocalFeedback> {
        self.verify_share_job(&review.job)?;
        let c = self.config(&review.job.binding)?;
        if c.files != review.scope || c.entry != review.entry {
            return Err("project shared scope changed; prepare again".into());
        }
        let f = review.job.feedback.as_ref().unwrap();
        let latest: LocalFeedback =
            read_json(&self.inbox_path(&review.job.binding, f.envelope.payload.submission_id())?)?;
        ensure_no_worktree_intent(&latest)?;
        Ok(latest)
    }
    fn save_branch_intent(
        &self,
        review: &GitReview,
        intent: &BranchIntent,
    ) -> Result<LocalFeedback> {
        let _records = self.lock()?;
        let mut latest = self.verify_git_review(review)?;
        review_status(&latest, false)?;
        let g = latest.git.get_or_insert(SubmissionGit {
            commit: None,
            error: None,
            branch_intent: None,
        });
        g.branch_intent = Some(intent.clone());
        write_json(
            &self.inbox_path(&review.job.binding, latest.envelope.payload.submission_id())?,
            &latest,
        )?;
        Ok(latest)
    }
    fn verify_branch_intent(
        &self,
        review: &GitReview,
        intent: &BranchIntent,
    ) -> Result<LocalFeedback> {
        let latest = self.verify_git_review(review)?;
        let saved = latest
            .git
            .as_ref()
            .and_then(|g| g.branch_intent.as_ref())
            .ok_or("missing branch intent")?;
        if saved.branch != intent.branch
            || saved.commit != intent.commit
            || saved.head != intent.head
            || saved.results_hash != intent.results_hash
        {
            return Err("branch intent changed".into());
        }
        for edit in latest.envelope.payload.edits() {
            if latest.decisions.get(&edit.path).is_some_and(|d| {
                d.status != "not_applied"
                    && !(d.status == "branched"
                        && d.git_branch.as_deref() == Some(intent.branch.as_str())
                        && d.git_commit.as_deref() == Some(intent.commit.as_str()))
            }) {
                return Err("file decision prevents recording branch".into());
            }
        }
        Ok(latest)
    }
    fn record_branch(
        &self,
        review: &GitReview,
        intent: &BranchIntent,
        hashes: &BTreeMap<String, String>,
        only: Option<(&str, Option<HunkSummary>)>,
    ) -> Result<LocalFeedback> {
        let _records = self.lock()?;
        let mut latest = self.verify_branch_intent(review, intent)?;
        for edit in latest.envelope.payload.edits() {
            if let Some((path, _)) = &only {
                if *path != edit.path {
                    continue;
                }
            }
            if let Some(d) = latest.decisions.get(&edit.path) {
                if d.status == "branched"
                    && d.git_branch.as_deref() == Some(intent.branch.as_str())
                    && d.git_commit.as_deref() == Some(intent.commit.as_str())
                {
                    continue;
                }
            }
            latest.decisions.insert(
                edit.path.clone(),
                Decision {
                    status: "branched".into(),
                    result_hash: hashes.get(&edit.path).cloned(),
                    git_branch: Some(intent.branch.clone()),
                    git_commit: Some(intent.commit.clone()),
                    hunk_summary: only.as_ref().and_then(|(_, summary)| summary.clone()),
                    ..Default::default()
                },
            );
        }
        Self::recompute(&mut latest);
        write_json(
            &self.inbox_path(&review.job.binding, latest.envelope.payload.submission_id())?,
            &latest,
        )?;
        Ok(latest)
    }
}
fn ensure_no_worktree_intent(feedback: &LocalFeedback) -> Result<()> {
    if feedback
        .decisions
        .values()
        .any(|decision| matches!(decision.status.as_str(), "pending" | "mirror_pending"))
    {
        return Err("worktree apply recovery pending; switch to worktree review first".into());
    }
    Ok(())
}
fn review_status(feedback: &LocalFeedback, patch: bool) -> Result<()> {
    let edits = feedback.envelope.payload.edits();
    if edits.is_empty() {
        return Err("Git operations require edits; annotations use worktree review".into());
    }
    if feedback
        .review
        .values()
        .any(|d| d.kernel_version != MERGE_KERNEL_VERSION)
    {
        return Err("kernel version mismatch".into());
    }
    let all_branched = edits.iter().all(|e| {
        feedback
            .decisions
            .get(&e.path)
            .is_some_and(|d| d.status == "branched")
    });
    if patch && all_branched {
        return Ok(());
    }
    if edits
        .iter()
        .any(|e| feedback.decisions.get(&e.path).is_some_and(|d| d.status != "not_applied"))
    {
        return Err("Git operations require a wholly undecided submission".into());
    }

    Ok(())
}
fn review_repo(review: &GitReview) -> Result<git::GitRepo> {
    let repo = git::probe(Path::new(&review.job.binding.source_root))?
        .ok_or("Git repository unavailable")?;
    if let Some(meta) = &review.job.snapshot.git {
        if repo.root != Path::new(&meta.repo_root) || repo.prefix != meta.prefix {
            return Err("snapshot repository changed".into());
        }
    }
    Ok(repo)
}
fn validate_results(review: &GitReview, results: &BTreeMap<String, String>) -> Result<()> {
    let f = review.job.feedback.as_ref().unwrap();
    if results.len() != f.envelope.payload.edits().len()
        || f.envelope
            .payload
            .edits()
            .iter()
            .any(|e| !results.contains_key(&e.path))
    {
        return Err("results must contain exactly every edit path".into());
    }
    for path in results.keys() {
        validate_relative(path)?;
    }
    if serde_json::to_vec(results)
        .map_err(|e| e.to_string())?
        .len()
        > 5 * 1024 * 1024
    {
        return Err("results exceed 5 MiB".into());
    }
    Ok(())
}
// The TypeScript contract uses absent optional fields, not null values.
fn git_value(mut value: serde_json::Value) -> Result<serde_json::Value> {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    Ok(value)
}
fn execute_git_request(
    service: &ProjectStore,
    request: &serde_json::Value,
) -> Result<serde_json::Value> {
    let request: GitRequest =
        serde_json::from_value(request.clone()).map_err(|e| format!("invalid Git request: {e}"))?;
    let id = request.project();
    let operation = project_git_lock(service, id)?;
    let _operation = operation.lock().map_err(|e| e.to_string())?;
    if let GitRequest::Probe { .. } = &request {
        let (b, target) = short_lock(|| {
            let b = service.binding(id)?;
            service.active(&b)?;
            let target = service.config(&b)?.git_target;
            Ok((b, target))
        })?;
        let repo = git::probe(Path::new(&b.source_root))?;
        short_lock(|| service.same_binding(&b))?;
        return match repo {
            Some(repo) => git_value(
                serde_json::json!({ "git":true,"team":repo.remote.is_some(),"prefix":repo.prefix,"head":repo.head,"branch":repo.branch,"remote":repo.remote,
                "target":target.unwrap_or(if repo.remote.is_some() { GitTarget::Branch } else { GitTarget::Worktree }) }),
            ),
            None => git_value(
                serde_json::json!({"git":false,"team":false,"prefix":"","reason":"Git repository unavailable","target":"worktree"}),
            ),
        };
    }
    let review = short_lock(|| service.capture_git_review(id, request.submission().unwrap()))?;
    let feedback = review.job.feedback.as_ref().unwrap();
    if let GitRequest::CommitMessage { .. } = &request {
        return git_value(serde_json::json!({"message":message(feedback,None,true)}));
    }
    if matches!(request, GitRequest::BranchState { .. })
        && feedback.git.as_ref().and_then(|g| g.branch_intent.as_ref()).is_none()
    {
        short_lock(|| service.verify_git_review(&review))?;
        return Ok(serde_json::Value::Null);
    }
    let repo = review_repo(&review)?;
    let paths: Vec<_> = feedback
        .envelope
        .payload
        .edits()
        .iter()
        .map(|e| e.path.clone())
        .collect();
    if matches!(
        request,
        GitRequest::Branched { .. } | GitRequest::BranchState { .. }
    ) {
        let intent = feedback
            .git
            .as_ref()
            .and_then(|g| g.branch_intent.as_ref())
            .ok_or("missing branch intent")?;
        if let GitRequest::Branched {
            path,
            branch,
            commit,
            summary,
            ..
        } = &request
        {
            validate_relative(path)?;
            if !paths.contains(path) {
                return Err("file outside feedback".into());
            }
            if summary.as_ref().is_some_and(|s| s.accepted > s.total) {
                return Err("invalid hunk summary".into());
            }
            if branch != &intent.branch || commit != &intent.commit {
                return Err("branch is not owned by this submission".into());
            }
        }
        let actual = git::ref_oid(&repo, &format!("refs/heads/{}", intent.branch))?;
        if actual.is_none() && matches!(request, GitRequest::BranchState { .. }) {
            short_lock(|| service.verify_branch_intent(&review, intent))?;
            return Ok(serde_json::Value::Null);
        }
        if actual.as_deref() != Some(intent.commit.as_str()) {
            return Err("branch ref changed".into());
        }
        if let Some(meta) = &review.job.snapshot.git {
            let snap_ref = format!(
                "refs/notemd/share/{id}/snapshots/{}",
                review.job.snapshot.snapshot_id
            );
            if git::ref_oid(&repo, &snap_ref)?.as_deref() != Some(meta.snapshot_commit.as_str()) {
                return Err("snapshot ref mismatch".into());
            }
            git::ensure_snapshot_not_ancestor(&repo, &meta.snapshot_commit, &intent.head)?;
        }
        let author = git::guest_author(
            feedback.envelope.payload.contributor_name(),
            request.submission().unwrap(),
            &feedback.envelope.received_at,
        );
        // The owned immutable oid fixes the complete tree. Never clean stored blobs a second time.
        git::verify_authored_commit(
            &repo,
            &intent.commit,
            &intent.head,
            &message(feedback, Some(&intent.head), false),
            &author,
        )?;
        let bytes = git::read_blobs(&repo, &intent.commit, &paths)?;
        let hashes = bytes
            .iter()
            .map(|(path, bytes)| {
                std::str::from_utf8(bytes).map_err(|_| "branch blob is not UTF-8")?;
                Ok((path.clone(), sha256_hex(bytes)))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        git_test_hook(service, "branch-state-verified");
        if git::ref_oid(&repo, &format!("refs/heads/{}", intent.branch))?.as_deref()
            != Some(intent.commit.as_str())
        {
            return Err("branch ref changed".into());
        }
        if let GitRequest::Branched { path, summary, .. } = &request {
            return json(short_lock(|| {
                service.record_branch(&review, intent, &hashes, Some((path, summary.clone())))
            })?);
        }
        let latest = short_lock(|| service.verify_branch_intent(&review, intent))?;
        let complete = paths.iter().all(|path| {
            latest
                .decisions
                .get(path)
                .is_some_and(|d| d.status == "branched")
        });
        return git_value(
            serde_json::json!({"branch":intent.branch,"commit":intent.commit,"feedback":latest,"remote":repo.remote,
            "stateError":if complete { None } else { Some("Branch created; retry recording branch state") }}),
        );
    }
    let blobs = git::read_blobs(&repo, &repo.head, &paths)?;
    let mut current = BTreeMap::new();
    for (path, bytes) in blobs {
        current.insert(
            path,
            String::from_utf8(bytes).map_err(|_| "HEAD blob is not UTF-8")?,
        );
    }
    if let GitRequest::Prepare { .. } = &request {
        git_test_hook(service, "review-prepared");
        let latest = short_lock(|| service.verify_git_review(&review))?;
        return git_value(
            serde_json::json!({"head":repo.head,"entry":review.entry,"feedback":latest,
            "files":feedback.envelope.payload.edits().iter().map(|e| serde_json::json!({"path":e.path,"base":review.base[&e.path],"current":current[&e.path],"after":e.after_markdown})).collect::<Vec<_>>(),
            "commitMessage":message(feedback,Some(&repo.head),false),"remote":repo.remote}),
        );
    }
    let (expected, results, patch) = match &request {
        GitRequest::Branch { head, results, .. } => (head, results, false),
        GitRequest::Patch { head, results, .. } => (head, results, true),
        _ => unreachable!(),
    };
    review_status(feedback, patch)?;
    validate_results(&review, results)?;
    git::ensure_head(&repo, expected)?;
    if expected != &repo.head {
        return Err("HEAD changed; prepare again".into());
    }
    if let Some(meta) = &review.job.snapshot.git {
        git::ensure_snapshot_not_ancestor(&repo, &meta.snapshot_commit, expected)?;
    }
    let author = git::guest_author(
        feedback.envelope.payload.contributor_name(),
        request.submission().unwrap(),
        &feedback.envelope.received_at,
    );
    git::owner_author(&repo, &author.date)?;
    let bytes = results
        .iter()
        .map(|(p, v)| (p.clone(), v.as_bytes().to_vec()))
        .collect();
    let candidate = git::build_commit(
        &repo,
        expected,
        &bytes,
        &message(feedback, Some(expected), false),
        Some(&author),
    )?;
    git::ensure_changed_tree(&repo, &candidate, expected)?;
    git_test_hook(service, "review-built");
    short_lock(|| {
        let latest = service.verify_git_review(&review)?;
        review_status(&latest, patch)
    })?;
    if patch {
        let name = format!(
            "refs/notemd/share/{id}/exports/{}",
            request.submission().unwrap()
        );
        let (oid, new) = object_for_ref(&repo, &name, &candidate)?;
        git::ensure_head(&repo, expected)?;
        git::create_ref(&repo, &name, &oid)?;
        git_test_hook(service, "export-ref-created");
        if let Err(error) = short_lock(|| service.verify_git_review(&review)) {
            if new {
                git::delete_created_ref(&repo, &name, &oid)?;
            }
            return Err(error);
        }
        return git_value(serde_json::json!({"patch":git::format_patch(&repo,&oid)?}));
    }
    let hash = sha256_hex(&serde_json::to_vec(results).map_err(|e| e.to_string())?);
    let saved_intent = feedback.git.as_ref().and_then(|g| g.branch_intent.as_ref());
    let existing = match saved_intent {
        Some(intent) => git::ref_oid(&repo, &format!("refs/heads/{}", intent.branch))?,
        None => None,
    };
    let reuse_existing = saved_intent.is_some() && existing.is_some();
    let intent = if let (Some(intent), Some(oid)) = (saved_intent, existing) {
        if oid != intent.commit {
            return Err("reserved branch changed".into());
        }
        if intent.head != *expected
            || intent.results_hash != hash
            || !git::same_commit(&repo, &intent.commit, &candidate)?
        {
            return Err(
                "a branch attempt already exists with different content; recover its state first"
                    .into(),
            );
        }
        intent.clone()
    } else {
        BranchIntent {
            head: expected.clone(),
            results_hash: hash,
            commit: candidate,
            branch: git::available_branch(&repo, &review.entry, request.submission().unwrap())?,
        }
    };
    let pending_feedback = short_lock(|| service.save_branch_intent(&review, &intent))?;
    git::ensure_head(&repo, expected)?;
    if reuse_existing {
        if git::ref_oid(&repo, &format!("refs/heads/{}", intent.branch))?.as_deref()
            != Some(intent.commit.as_str())
        {
            return Err("reserved branch changed".into());
        }
    } else if let Err(error) = git::create_branch_ref(&repo, &intent.branch, &intent.commit) {
        // A failed create-only CAS is not ownership of somebody else's branch.
        short_lock(|| {
            let _records = service.lock()?;
            let mut latest = service.verify_git_review(&review)?;
            if let Some(git) = &mut latest.git {
                git.branch_intent = None;
            }
            write_json(
                &service.inbox_path(&review.job.binding, latest.envelope.payload.submission_id())?,
                &latest,
            )
        })?;
        return Err(error);
    }
    git_test_hook(service, "branch-ref-created");
    let hashes = results
        .iter()
        .map(|(p, s)| (p.clone(), sha256_hex(s.as_bytes())))
        .collect();
    let (latest, state_error) = match short_lock(|| {
        service.record_branch(&review, &intent, &hashes, None)
    }) {
        Ok(latest) => (latest, None),
        Err(_) => (
            // A new recovery intent blocks writes, but the latest trusted
            // feedback remains readable for the stateError response.
            short_lock(|| {
                service.verify_share_job(&review.job)?;
                read_json(&service.inbox_path(&review.job.binding, request.submission().unwrap())?)
            })
            .unwrap_or(pending_feedback),
            Some("Branch created; retry recording branch state"),
        ),
    };
    let mut result = serde_json::json!({"branch":intent.branch,"commit":intent.commit,"feedback":latest,"remote":repo.remote});
    if let Some(error) = state_error {
        result["stateError"] = error.into();
    }
    git_value(result)
}

fn dispatch(service: &ProjectStore, request: &serde_json::Value) -> Result<serde_json::Value> {
    fn string<'a>(r: &'a serde_json::Value, key: &str) -> Result<&'a str> {
        r.get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("missing {key}"))
    }
    fn value<T: Serialize>(v: T) -> Result<serde_json::Value> {
        serde_json::to_value(v).map_err(|e| e.to_string())
    }
    fn field<T: serde::de::DeserializeOwned>(r: &serde_json::Value, key: &str) -> Result<T> {
        serde_json::from_value(r.get(key).cloned().ok_or_else(|| format!("missing {key}"))?)
            .map_err(|e| format!("invalid {key}: {e}"))
    }
    fn optional<T: serde::de::DeserializeOwned>(r: &serde_json::Value, key: &str) -> Result<Option<T>> {
        match r.get(key) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(_) => field(r, key).map(Some),
        }
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
        "git-target" => {
            let target: GitTarget = field(request, "target")?;
            let _records = service.lock()?;
            let b = service.binding(id)?; service.active(&b)?;
            let mut c = service.config(&b)?; c.git_target = Some(target);
            write_json(&service.management(&b, "project.json")?, &c)?;
            value(service.info(&b)?)
        },
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
        "feedback-readonly" => value(service.feedback_readonly(id, string(request, "submissionId")?)?),
        "feedback-list-readonly" => value(service.feedback_list_readonly(id)?),
        "receipt-set" => value(service.receipt_set(id, string(request, "submissionId")?, field(request, "receipt").map_err(|e| format!("invalid receipt state: {e}"))?)?),
        "review-readonly" => value(service.review_readonly(
            id, string(request, "submissionId")?, string(request, "path")?,
        )?),
        "review" => value(service.review(
            id,
            string(&request, "submissionId")?,
            string(&request, "path")?,
        )?),
        "review-save" => value(service.review_save(
            id,
            string(&request, "submissionId")?,
            string(&request, "path")?,
            field(&request, "draft")?,
        )?),
        "annotation-decide" => value(service.annotation_decide_target(
            id,
            string(&request, "submissionId")?,
            field(&request, "index")?,
            string(&request, "value")?,
            optional::<GitTarget>(request, "target")?,
        )?),
        "apply" => value(service.apply(
            id,
            string(&request, "submissionId")?,
            string(&request, "path")?,
            string(&request, "expectedHash")?,
            string(&request, "content")?,
            optional(&request, "summary")?,
        )?),
        "reject" => value(service.reject_target(
            id,
            string(&request, "submissionId")?,
            optional::<String>(&request, "path")?.as_deref(),
            optional::<String>(&request, "reason")?.as_deref(),
            optional::<GitTarget>(request, "target")?,
        )?),
        "resolve" => value(service.resolve(id, string(&request, "submissionId")?)?),
        _ => Err(format!("unknown project_share operation: {op}")),
    }
}
