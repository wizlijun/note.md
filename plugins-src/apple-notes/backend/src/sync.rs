//! One-way mirror. All source identities and resumable transaction state live
//! in applenotes/id-sync.json; only files recorded there belong to this plugin.
use crate::source::{self, Folder, Note, Snapshot};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

const CONTROL: &str = ".notemd/apple-notes";
const MAPPING: &str = "applenotes/id-sync.json";
type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncReport {
    pub created: usize,
    pub updated: usize,
    pub moved: usize,
    pub deleted: usize,
    pub unchanged: usize,
    pub locked: usize,
    pub warnings: Vec<String>,
    pub complete: bool,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct AccountEntry {
    name: String,
    path: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct FolderEntry {
    name: String,
    account_id: String,
    parent_id: Option<String>,
    path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Asset {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(rename = "sha256", skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
struct Entry {
    account_id: String,
    folder_ids: Vec<String>,
    title: String,
    created_at: String,
    modified_at: String,
    locked: bool,
    path: String,
    files: BTreeMap<String, String>,
    attachments: BTreeMap<String, Asset>,
    // v1 only kept a 16-character digest in filenames. A locked note cannot
    // expose the full attachment identity until a later successful enumeration.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    legacy_attachments: BTreeMap<String, Asset>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
struct Ledger {
    version: u32,
    source: String,
    accounts: BTreeMap<String, AccountEntry>,
    folders: BTreeMap<String, FolderEntry>,
    notes: BTreeMap<String, Entry>,
    // The recovery catalogue also stays in the single mapping file. Archive
    // filenames are operation numbers, never source IDs or their digests.
    trash: Vec<Backup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending: Option<Pending>,
}
impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 2,
            source: "apple-notes".into(),
            accounts: BTreeMap::new(),
            folders: BTreeMap::new(),
            notes: BTreeMap::new(),
            trash: vec![],
            pending: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Backup {
    path: String,
    hash: String,
    backup: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Install {
    path: String,
    hash: String,
    staged: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Backup,
    Install,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Pending {
    transaction: String,
    phase: Phase,
    backups: Vec<Backup>,
    #[serde(default)]
    missing_backups: Vec<String>,
    installs: Vec<Install>,
    next: Box<Ledger>,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn fold(value: &str) -> String {
    value.nfc().case_fold().nfc().collect()
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn safe(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty() {
        return Err("empty managed path".into());
    }
    let mut result = root.to_path_buf();
    for part in Path::new(relative).components() {
        let Component::Normal(part) = part else {
            return Err("unsafe managed path".into());
        };
        result.push(part);
        match fs::symlink_metadata(&result) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("symlink in managed path".into())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(result)
}
fn atomic_json(root: &Path, relative: &str, value: &impl Serialize) -> Result<()> {
    let path = safe(root, relative)?;
    let parent = path.parent().ok_or("missing parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut tmp, value).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(&path).map_err(|e| e.to_string())?;
    File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())
}
fn sync_directory_chain(path: &Path, root: &Path) -> Result<()> {
    let mut at = Some(path);
    while let Some(directory) = at {
        if !directory.starts_with(root) {
            return Err("directory durability path escaped the vault".into());
        }
        sync_directory(directory)?;
        if directory == root {
            break;
        }
        at = directory.parent();
    }
    Ok(())
}
fn rename_durable(source: &Path, target: &Path) -> Result<()> {
    let source_parent = source.parent().ok_or("missing source parent")?;
    let target_parent = target.parent().ok_or("missing target parent")?;
    fs::rename(source, target).map_err(|e| e.to_string())?;
    sync_directory(source_parent)?;
    if target_parent != source_parent {
        sync_directory(target_parent)?;
    }
    Ok(())
}
fn tombstone(root: &Path) -> Result<()> {
    atomic_json(
        root,
        &format!("{CONTROL}/state.json"),
        &serde_json::json!({"version":2,"notes":{}}),
    )
}
fn filename(path: &str) -> Result<&str> {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "invalid filename".into())
}
fn parent(path: &str) -> Result<&str> {
    Path::new(path)
        .parent()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "invalid parent path".into())
}
fn entry_file(entry: &Entry, file: &str) -> String {
    format!("{}/{file}", parent(&entry.path).unwrap())
}
fn entry_relative(entry: &Entry, path: &str) -> Result<String> {
    path.strip_prefix(&format!("{}/", parent(&entry.path)?))
        .map(str::to_string)
        .ok_or_else(|| "attachment path is outside its note directory".into())
}
fn asset_dir(path: &str) -> Result<String> {
    Ok(format!(
        "{}.attachments",
        filename(path)?
            .strip_suffix(".md")
            .ok_or("invalid note filename")?
    ))
}
fn content_path(path: &str) -> bool {
    path.starts_with("applenotes/") && fold(path) != fold(MAPPING)
}

fn validate_entry(root: &Path, entry: &Entry) -> Result<()> {
    if !content_path(&entry.path)
        || !entry.path.ends_with(".md")
        || !entry.files.contains_key(filename(&entry.path)?)
    {
        return Err("invalid Apple Notes mapping entry".into());
    }
    safe(root, &entry.path)?;
    let prefix = format!("{}/", asset_dir(&entry.path)?);
    let full_prefix = format!("{}/{prefix}", parent(&entry.path)?);
    for (file, digest) in &entry.files {
        if (file != filename(&entry.path)?
            && (!file.starts_with(&prefix) || file[prefix.len()..].contains('/')))
            || !valid_hash(digest)
        {
            return Err("invalid mapped note file".into());
        }
        safe(root, &entry_file(entry, file))?;
    }
    for asset in entry
        .attachments
        .values()
        .chain(entry.legacy_attachments.values())
    {
        match (&asset.path, &asset.hash, &asset.url) {
            (Some(path), Some(digest), None)
                if path.starts_with(&full_prefix)
                    && !path[full_prefix.len()..].contains('/')
                    && entry.files.get(&entry_relative(entry, path)?) == Some(digest) => {}
            (None, None, Some(url))
                if url.starts_with("https://") || url.starts_with("http://") => {}
            (None, None, None) => {}
            _ => return Err("invalid attachment identity mapping".into()),
        }
    }
    if entry.attachments.keys().any(String::is_empty)
        || entry
            .legacy_attachments
            .keys()
            .any(|key| key.len() != 16 || !key.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("invalid attachment identity".into());
    }
    Ok(())
}
fn validate_ledger(root: &Path, ledger: &Ledger) -> Result<()> {
    if ledger.version != 2 || ledger.source != "apple-notes" {
        return Err("unsupported Apple Notes mapping version".into());
    }
    let mut directories = BTreeSet::new();
    for (id, account) in &ledger.accounts {
        if id.is_empty()
            || !content_path(&account.path)
            || parent(&account.path)? != "applenotes"
            || !directories.insert(fold(&account.path))
        {
            return Err("invalid account mapping".into());
        }
        safe(root, &account.path)?;
    }
    for (id, folder) in &ledger.folders {
        let account = ledger
            .accounts
            .get(&folder.account_id)
            .ok_or("folder has no account mapping")?;
        let expected = match &folder.parent_id {
            Some(parent_id) => {
                let p = ledger
                    .folders
                    .get(parent_id)
                    .ok_or("folder has no parent mapping")?;
                if p.account_id != folder.account_id {
                    return Err("folder crosses account boundaries".into());
                }
                &p.path
            }
            None => &account.path,
        };
        if id.is_empty()
            || parent(&folder.path)? != expected
            || !directories.insert(fold(&folder.path))
        {
            return Err("invalid folder mapping".into());
        }
        safe(root, &folder.path)?;
    }
    let mut files = BTreeSet::new();
    for (id, entry) in &ledger.notes {
        if id.is_empty() {
            return Err("empty note identity".into());
        }
        validate_entry(root, entry)?;
        let account = ledger
            .accounts
            .get(&entry.account_id)
            .ok_or("note has no account mapping")?;
        let mut expected = &account.path;
        let mut previous = None;
        for folder_id in &entry.folder_ids {
            let folder = ledger
                .folders
                .get(folder_id)
                .ok_or("note has no folder mapping")?;
            if folder.account_id != entry.account_id || folder.parent_id.as_ref() != previous {
                return Err("invalid note folder hierarchy".into());
            }
            previous = Some(folder_id);
            expected = &folder.path;
        }
        if parent(&entry.path)? != expected {
            return Err("note path disagrees with folder mapping".into());
        }
        for file in entry.files.keys() {
            let path = entry_file(entry, file);
            if directories.contains(&fold(&path)) || !files.insert(fold(&path)) {
                return Err("overlapping file ownership".into());
            }
        }
    }
    for backup in &ledger.trash {
        if !content_path(&backup.path)
            || !valid_hash(&backup.hash)
            || !backup.backup.starts_with(&format!("{CONTROL}/trash/"))
        {
            return Err("invalid Apple Notes recovery catalogue".into());
        }
        safe(root, &backup.path)?;
        safe(root, &backup.backup)?;
    }
    Ok(())
}
fn read_mapping(root: &Path) -> Result<Option<Ledger>> {
    let path = safe(root, MAPPING)?;
    if !path.exists() {
        return Ok(None);
    }
    let ledger: Ledger = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Apple Notes id-sync.json is invalid; restore the mapping before syncing")?;
    validate_ledger(root, &ledger)?;
    Ok(Some(ledger))
}
fn verify_owned(root: &Path, entry: &Entry) -> Result<()> {
    for (file, digest) in &entry.files {
        let path = safe(root, &entry_file(entry, file))?;
        if path.exists() && hash(&fs::read(path).map_err(|e| e.to_string())?) != *digest {
            return Err("Local changes in an Apple Notes mirror; move them out or restore the mirror before syncing".into());
        }
    }
    Ok(())
}
fn read_document(root: &Path, entry: &Entry) -> Result<(serde_yaml::Value, String)> {
    let text = fs::read_to_string(safe(root, &entry.path)?)
        .map_err(|_| "Cannot read an existing mirrored note")?;
    let text = text
        .strip_prefix("---\n")
        .ok_or("mirrored note has no YAML metadata")?;
    let (yaml, body) = text
        .split_once("\n---\n")
        .ok_or("mirrored note has invalid YAML metadata")?;
    Ok((
        serde_yaml::from_str(yaml).map_err(|_| "invalid mirrored note YAML")?,
        body.to_string(),
    ))
}
fn yaml_string(yaml: &serde_yaml::Value, key: &str) -> Result<String> {
    yaml[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("legacy note is missing {key}"))
}
fn yaml_strings(yaml: &serde_yaml::Value, key: &str) -> Result<Vec<String>> {
    yaml[key]
        .as_sequence()
        .ok_or_else(|| format!("legacy note is missing {key}"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("invalid legacy {key}"))
        })
        .collect()
}

fn load_for_sync(root: &Path, snapshot: &Snapshot) -> Result<(Ledger, bool)> {
    if let Some(ledger) = read_mapping(root)? {
        if ledger.pending.is_some() {
            return Err("an interrupted sync must be recovered before planning".into());
        }
        return Ok((ledger, false));
    }
    let legacy = safe(root, &format!("{CONTROL}/state.json"))?;
    if !legacy.exists() {
        let mirror = safe(root, "applenotes")?;
        if mirror.exists()
            && fs::read_dir(mirror)
                .map_err(|e| e.to_string())?
                .next()
                .is_some()
        {
            return Err("Apple Notes mapping is missing but applenotes contains files; restore id-sync.json before syncing".into());
        }
        return Ok((Ledger::default(), false));
    }
    let mut ledger: Ledger = serde_json::from_slice(&fs::read(legacy).map_err(|e| e.to_string())?)
        .map_err(|_| "invalid legacy Apple Notes mapping")?;
    if ledger.version != 1 {
        return Err(
            "Apple Notes id-sync.json is missing after migration; restore it before syncing".into(),
        );
    }
    if ledger.pending.is_some() {
        return Err("unexpected legacy pending state".into());
    }
    ledger.version = 2;
    for (id, entry) in &mut ledger.notes {
        validate_entry(root, entry)?;
        verify_owned(root, entry)?;
        let (note, account_name) = if safe(root, &entry.path)?.exists() {
            let (yaml, _) = read_document(root, entry)?;
            if yaml_string(&yaml, "apple_notes_id")? != *id
                || yaml_string(&yaml, "account_id")? != entry.account_id
            {
                return Err("legacy note identity disagrees with mapping".into());
            }
            let ids = yaml_strings(&yaml, "folder_ids")?;
            let names = yaml_strings(&yaml, "folders")?;
            if ids.len() != names.len() {
                return Err("invalid legacy folder metadata".into());
            }
            (
                Note {
                    id: id.clone(),
                    account_id: entry.account_id.clone(),
                    title: yaml_string(&yaml, "title")?,
                    created_at: yaml_string(&yaml, "created")?,
                    modified_at: yaml_string(&yaml, "modified")?,
                    locked: yaml["locked"].as_bool().unwrap_or(false),
                    html: String::new(),
                    attachments: vec![],
                    folders: ids
                        .into_iter()
                        .zip(names)
                        .map(|(id, name)| Folder { id, name })
                        .collect(),
                },
                yaml_string(&yaml, "account")?,
            )
        } else {
            let note = snapshot
                .notes
                .iter()
                .find(|n| n.id == *id)
                .ok_or("a missing legacy note cannot be migrated without source metadata")?
                .clone();
            let account = snapshot
                .accounts
                .iter()
                .find(|a| a.id == note.account_id)
                .ok_or("missing source account")?;
            (note, account.name.clone())
        };
        let parts: Vec<_> = entry.path.split('/').collect();
        if parts.len() != note.folders.len() + 3 {
            return Err("legacy path disagrees with folder metadata".into());
        }
        let account = AccountEntry {
            name: account_name,
            path: parts[..2].join("/"),
        };
        if ledger
            .accounts
            .get(&note.account_id)
            .is_some_and(|old| old != &account)
        {
            return Err("conflicting legacy account mapping".into());
        }
        ledger.accounts.insert(note.account_id.clone(), account);
        let mut previous = None;
        for (index, folder) in note.folders.iter().enumerate() {
            let value = FolderEntry {
                name: folder.name.clone(),
                account_id: note.account_id.clone(),
                parent_id: previous.clone(),
                path: parts[..index + 3].join("/"),
            };
            if ledger
                .folders
                .get(&folder.id)
                .is_some_and(|old| old != &value)
            {
                return Err("conflicting legacy folder mapping".into());
            }
            ledger.folders.insert(folder.id.clone(), value);
            previous = Some(folder.id.clone());
        }
        entry.title = note.title;
        entry.created_at = note.created_at;
        entry.modified_at = note.modified_at;
        entry.locked = note.locked;
        entry.folder_ids = note.folders.iter().map(|f| f.id.clone()).collect();
        let note_parent = parent(&entry.path)?.to_string();
        for (path, digest) in &entry.files {
            if !path.contains('/') {
                continue;
            }
            let basename = filename(path)?;
            let stem = Path::new(basename)
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("invalid legacy attachment")?;
            let (name, fingerprint) = stem
                .rsplit_once("--")
                .ok_or("legacy attachment has no identity fingerprint")?;
            if fingerprint.len() != 16 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("invalid legacy attachment fingerprint".into());
            }
            let extension = Path::new(basename)
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| format!(".{s}"))
                .unwrap_or_default();
            if entry
                .legacy_attachments
                .insert(
                    fingerprint.into(),
                    Asset {
                        name: format!("{name}{extension}"),
                        path: Some(format!("{note_parent}/{path}")),
                        hash: Some(digest.clone()),
                        url: None,
                    },
                )
                .is_some()
            {
                return Err("ambiguous legacy attachment fingerprints".into());
            }
        }
    }
    validate_ledger(root, &ledger)?;
    Ok((ledger, true))
}

fn clean_component(name: &str) -> String {
    let mut clean = String::new();
    for c in name.nfc() {
        let c = if c.is_control() || "/\\:*?\"<>|".contains(c) {
            '_'
        } else {
            c
        };
        if clean.len() + c.len_utf8() > 180 {
            break;
        }
        clean.push(c);
    }
    let value = clean.trim_matches(|c: char| c.is_whitespace() || c == '.');
    if value.is_empty() {
        "Untitled".into()
    } else {
        value.into()
    }
}
fn note_stem(note: &Note) -> Result<String> {
    let date = chrono::DateTime::parse_from_rfc3339(&note.created_at)
        .map_err(|_| "Invalid Apple Notes creation date")?
        .with_timezone(&chrono::Utc)
        .format("%Y-%m-%d");
    let mut slug = String::new();
    for c in note.title.nfc().flat_map(char::to_lowercase) {
        if slug.len() + c.len_utf8() > 180 {
            break;
        }
        if c.is_alphanumeric() {
            slug.push(c)
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-')
        }
    }
    let slug = slug.trim_matches('-');
    Ok(format!(
        "{date}-{}",
        if slug.is_empty() { "untitled" } else { slug }
    ))
}
fn numbered(base: &str, extension: &str, number: usize) -> String {
    if number == 1 {
        format!("{base}{extension}")
    } else {
        format!("{base}-{number}{extension}")
    }
}
fn recast_numbered(
    prior_name: &str,
    old_base: &str,
    new_base: &str,
    extension: &str,
) -> Option<String> {
    (1..=100_000)
        .find(|number| fold(&numbered(old_base, extension, *number)) == fold(prior_name))
        .map(|number| numbered(new_base, extension, number))
}
struct Allocator {
    occupied: BTreeMap<String, bool>,
    owned_files: BTreeSet<String>,
    owned_dirs: BTreeSet<String>,
    reserved: BTreeSet<String>,
}
impl Allocator {
    fn new(root: &Path, old: &Ledger) -> Result<Self> {
        fn walk(root: &Path, path: &Path, result: &mut BTreeMap<String, bool>) -> Result<()> {
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                let rel = entry
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                result.insert(fold(&rel), kind.is_dir());
                if kind.is_dir() {
                    walk(root, &entry.path(), result)?;
                }
            }
            Ok(())
        }
        let mut value = Self {
            occupied: BTreeMap::new(),
            owned_files: BTreeSet::new(),
            owned_dirs: BTreeSet::new(),
            reserved: BTreeSet::from([fold(MAPPING)]),
        };
        let mirror = safe(root, "applenotes")?;
        if mirror.exists() {
            walk(root, &mirror, &mut value.occupied)?;
        }
        for account in old.accounts.values() {
            value.owned_dirs.insert(fold(&account.path));
        }
        for folder in old.folders.values() {
            value.owned_dirs.insert(fold(&folder.path));
        }
        for entry in old.notes.values() {
            for file in entry.files.keys() {
                let path = entry_file(entry, file);
                value.owned_files.insert(fold(&path));
                if file.contains('/') {
                    value.owned_dirs.insert(fold(parent(&path)?));
                }
            }
        }
        Ok(value)
    }
    fn available(&self, path: &str, directory: bool) -> bool {
        let key = fold(path);
        if self.reserved.contains(&key) {
            return false;
        }
        match self.occupied.get(&key) {
            None => true,
            Some(is_dir) => {
                *is_dir == directory
                    && if directory {
                        self.owned_dirs.contains(&key)
                    } else {
                        self.owned_files.contains(&key)
                    }
            }
        }
    }
    fn reserve(&mut self, path: &str) {
        self.reserved.insert(fold(path));
    }
    fn choose(
        &mut self,
        parent: &str,
        base: &str,
        extension: &str,
        directory: bool,
        note: bool,
    ) -> Result<String> {
        for number in 1..=100_000 {
            let name = numbered(base, extension, number);
            let path = format!("{parent}/{name}");
            let companion = if note {
                Some(format!("{parent}/{}", asset_dir(&path)?))
            } else {
                None
            };
            if self.available(&path, directory)
                && companion.as_ref().is_none_or(|p| self.available(p, true))
            {
                self.reserve(&path);
                if let Some(p) = companion {
                    self.reserve(&p);
                }
                return Ok(path);
            }
        }
        Err("too many colliding Apple Notes names".into())
    }
}

fn retained_note(id: &str, entry: &Entry, old: &Ledger) -> Result<Note> {
    Ok(Note {
        id: id.into(),
        title: entry.title.clone(),
        account_id: entry.account_id.clone(),
        created_at: entry.created_at.clone(),
        modified_at: entry.modified_at.clone(),
        locked: entry.locked,
        html: String::new(),
        attachments: vec![],
        folders: entry
            .folder_ids
            .iter()
            .map(|id| {
                old.folders
                    .get(id)
                    .map(|f| Folder {
                        id: id.clone(),
                        name: f.name.clone(),
                    })
                    .ok_or_else(|| "missing retained folder".into())
            })
            .collect::<Result<_>>()?,
    })
}
fn plan_directories(
    old: &Ledger,
    notes: &BTreeMap<String, (Note, bool)>,
    snapshot: &Snapshot,
    migrating: bool,
    alloc: &mut Allocator,
) -> Result<(
    BTreeMap<String, AccountEntry>,
    BTreeMap<String, FolderEntry>,
)> {
    let mut accounts = BTreeMap::new();
    let mut folders: BTreeMap<String, FolderEntry> = BTreeMap::new();
    for account in &snapshot.accounts {
        accounts.insert(
            account.id.clone(),
            AccountEntry {
                name: account.name.clone(),
                path: String::new(),
            },
        );
    }
    for (note, _) in notes.values() {
        if !accounts.contains_key(&note.account_id) {
            accounts.insert(
                note.account_id.clone(),
                old.accounts
                    .get(&note.account_id)
                    .ok_or("missing account metadata")?
                    .clone(),
            );
        }
        let mut parent_id = None;
        let mut seen = BTreeSet::new();
        for f in &note.folders {
            if f.id.is_empty() || !seen.insert(&f.id) {
                return Err("invalid folder hierarchy".into());
            }
            let wanted = FolderEntry {
                name: f.name.clone(),
                account_id: note.account_id.clone(),
                parent_id: parent_id.clone(),
                path: String::new(),
            };
            if folders.get(&f.id).is_some_and(|prior| prior != &wanted) {
                return Err("conflicting folder identities".into());
            }
            folders.insert(f.id.clone(), wanted);
            parent_id = Some(f.id.clone());
        }
    }
    for (id, entry) in &mut accounts {
        entry.path.clear();
        if !migrating {
            if let Some(prior) = old.accounts.get(id) {
                if fold(&prior.name) == fold(&entry.name) {
                    if let Some(name) = recast_numbered(
                        filename(&prior.path)?,
                        &clean_component(&prior.name),
                        &clean_component(&entry.name),
                        "",
                    ) {
                        let candidate = format!("applenotes/{name}");
                        if alloc.available(&candidate, true) {
                            entry.path = candidate;
                            alloc.reserve(&entry.path);
                        }
                    }
                }
            }
        }
    }
    for entry in accounts.values_mut() {
        if entry.path.is_empty() {
            entry.path =
                alloc.choose("applenotes", &clean_component(&entry.name), "", true, false)?;
        }
    }
    let mut remaining: BTreeSet<String> = folders.keys().cloned().collect();
    while !remaining.is_empty() {
        let ready: Vec<String> = remaining
            .iter()
            .filter(|id| {
                folders[*id]
                    .parent_id
                    .as_ref()
                    .is_none_or(|p| !remaining.contains(p))
            })
            .cloned()
            .collect();
        if ready.is_empty() {
            return Err("cyclic folder hierarchy".into());
        }
        // Stationary owners reserve their own physical paths before a moved
        // object can request the same readable name.
        for id in &ready {
            let request = folders[id].clone();
            let parent = match &request.parent_id {
                Some(p) => folders.get(p).ok_or("missing parent folder")?.path.clone(),
                None => accounts[&request.account_id].path.clone(),
            };
            if !migrating {
                if let Some(prior) = old.folders.get(id) {
                    if fold(&prior.name) == fold(&request.name) {
                        if let Some(name) = recast_numbered(
                            filename(&prior.path)?,
                            &clean_component(&prior.name),
                            &clean_component(&request.name),
                            "",
                        ) {
                            let candidate = format!("{parent}/{name}");
                            if fold(&candidate) == fold(&prior.path)
                                && alloc.available(&candidate, true)
                            {
                                alloc.reserve(&candidate);
                                folders.get_mut(id).unwrap().path = candidate;
                            }
                        }
                    }
                }
            }
        }
        // Next preserve the basename of objects moving to a new parent.
        for id in &ready {
            if folders[id].path.is_empty() && !migrating {
                let request = folders[id].clone();
                let parent = match &request.parent_id {
                    Some(p) => folders.get(p).ok_or("missing parent folder")?.path.clone(),
                    None => accounts[&request.account_id].path.clone(),
                };
                if let Some(prior) = old.folders.get(id) {
                    if fold(&prior.name) == fold(&request.name) {
                        if let Some(name) = recast_numbered(
                            filename(&prior.path)?,
                            &clean_component(&prior.name),
                            &clean_component(&request.name),
                            "",
                        ) {
                            let candidate = format!("{parent}/{name}");
                            if alloc.available(&candidate, true) {
                                alloc.reserve(&candidate);
                                folders.get_mut(id).unwrap().path = candidate;
                            }
                        }
                    }
                }
            }
        }
        for id in &ready {
            if folders[id].path.is_empty() {
                let request = folders[id].clone();
                let parent = match &request.parent_id {
                    Some(p) => folders[p].path.clone(),
                    None => accounts[&request.account_id].path.clone(),
                };
                folders.get_mut(id).unwrap().path =
                    alloc.choose(&parent, &clean_component(&request.name), "", true, false)?;
            }
        }
        for id in ready {
            remaining.remove(&id);
        }
    }
    Ok((accounts, folders))
}
fn plan_note_paths(
    old: &Ledger,
    notes: &BTreeMap<String, (Note, bool)>,
    accounts: &BTreeMap<String, AccountEntry>,
    folders: &BTreeMap<String, FolderEntry>,
    migrating: bool,
    alloc: &mut Allocator,
) -> Result<BTreeMap<String, String>> {
    let mut paths = BTreeMap::new();
    let directory = |note: &Note| {
        note.folders
            .last()
            .map(|f| folders[&f.id].path.clone())
            .unwrap_or_else(|| accounts[&note.account_id].path.clone())
    };
    // As with folders, reserve stationary owners before considering moves.
    for (id, (note, _)) in notes {
        if !migrating {
            if let Some(prior) = old.notes.get(id) {
                let old_stem = note_stem(&retained_note(id, prior, old)?)?;
                let new_stem = note_stem(note)?;
                if fold(&new_stem) == fold(&old_stem) {
                    let parent = directory(note);
                    if let Some(name) =
                        recast_numbered(filename(&prior.path)?, &old_stem, &new_stem, ".md")
                    {
                        let candidate = format!("{parent}/{name}");
                        let assets = format!("{parent}/{}", asset_dir(&candidate)?);
                        if fold(&candidate) == fold(&prior.path)
                            && alloc.available(&candidate, false)
                            && alloc.available(&assets, true)
                        {
                            alloc.reserve(&candidate);
                            alloc.reserve(&assets);
                            paths.insert(id.clone(), candidate);
                        }
                    }
                }
            }
        }
    }
    for (id, (note, _)) in notes {
        if paths.contains_key(id) || migrating {
            continue;
        }
        if let Some(prior) = old.notes.get(id) {
            let old_stem = note_stem(&retained_note(id, prior, old)?)?;
            let new_stem = note_stem(note)?;
            if fold(&new_stem) == fold(&old_stem) {
                let parent = directory(note);
                if let Some(name) =
                    recast_numbered(filename(&prior.path)?, &old_stem, &new_stem, ".md")
                {
                    let candidate = format!("{parent}/{name}");
                    let assets = format!("{parent}/{}", asset_dir(&candidate)?);
                    if alloc.available(&candidate, false) && alloc.available(&assets, true) {
                        alloc.reserve(&candidate);
                        alloc.reserve(&assets);
                        paths.insert(id.clone(), candidate);
                    }
                }
            }
        }
    }
    for (id, (note, _)) in notes {
        if !paths.contains_key(id) {
            paths.insert(
                id.clone(),
                alloc.choose(&directory(note), &note_stem(note)?, ".md", false, true)?,
            );
        }
    }
    Ok(paths)
}

fn encoded(path: &str) -> String {
    path.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn previous_bytes(root: &Path, asset: Option<&Asset>) -> Result<Option<Vec<u8>>> {
    let Some(asset) = asset else {
        return Ok(None);
    };
    let (Some(path), Some(digest)) = (&asset.path, &asset.hash) else {
        return Ok(None);
    };
    match fs::read(safe(root, path)?) {
        Ok(bytes) if hash(&bytes) == *digest => Ok(Some(bytes)),
        Ok(_) => Err("Local changes in a mirrored attachment".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
struct AssetCandidate {
    key: String,
    legacy: bool,
    name: String,
    old: Option<Asset>,
    bytes: Option<Vec<u8>>,
    cid: String,
    url: Option<String>,
    path: Option<String>,
}

struct RenderContext<'a> {
    staging: &'a Path,
    root: &'a Path,
    previous: Option<&'a Entry>,
    preserve: bool,
    migrating: bool,
    alloc: &'a mut Allocator,
    report: &'a mut SyncReport,
}

fn render(
    note: &Note,
    account_name: &str,
    path: &str,
    context: RenderContext<'_>,
) -> Result<(Entry, BTreeMap<String, Vec<u8>>)> {
    let RenderContext {
        staging,
        root,
        previous,
        preserve,
        migrating,
        alloc,
        report,
    } = context;
    let mut candidates = Vec::new();
    let mut seen = BTreeSet::new();
    let mut claimed_legacy = BTreeSet::new();
    if preserve {
        if let Some(prior) = previous {
            for (legacy, assets) in [
                (false, &prior.attachments),
                (true, &prior.legacy_attachments),
            ] {
                for (key, asset) in assets {
                    candidates.push(AssetCandidate {
                        key: key.clone(),
                        legacy,
                        name: asset.name.clone(),
                        old: Some(asset.clone()),
                        bytes: previous_bytes(root, Some(asset))?,
                        cid: String::new(),
                        url: asset.url.clone(),
                        path: None,
                    });
                }
            }
        }
    } else {
        for attachment in &note.attachments {
            if attachment.id.is_empty() || !seen.insert(&attachment.id) {
                return Err("empty or duplicate attachment identity".into());
            }
            let fingerprint = &hash(attachment.id.as_bytes())[..16];
            let old = previous
                .and_then(|p| p.attachments.get(&attachment.id))
                .or_else(|| previous.and_then(|p| p.legacy_attachments.get(fingerprint)));
            if previous.is_some_and(|p| p.legacy_attachments.contains_key(fingerprint))
                && !claimed_legacy.insert(fingerprint.to_string())
            {
                return Err("ambiguous legacy attachment identity".into());
            }
            let bytes = match &attachment.relative_path {
                Some(relative) => Some(
                    fs::read(safe(staging, relative)?)
                        .map_err(|_| "Cannot read exported attachment")?,
                ),
                None => previous_bytes(root, old)?,
            };
            candidates.push(AssetCandidate {
                key: attachment.id.clone(),
                legacy: false,
                name: attachment.name.clone(),
                old: old.cloned(),
                bytes,
                cid: attachment.content_id.clone(),
                url: attachment.url.clone(),
                path: None,
            });
        }
    }
    candidates.sort_by(|a, b| a.key.cmp(&b.key));
    let attachment_directory = format!("{}/{}", parent(path)?, asset_dir(path)?);
    for candidate in &mut candidates {
        if candidate.bytes.is_some() && !migrating {
            if let Some(prior) = &candidate.old {
                if prior.name == candidate.name {
                    if let Some(prior_path) = &prior.path {
                        let target = format!("{attachment_directory}/{}", filename(prior_path)?);
                        if alloc.available(&target, false) {
                            alloc.reserve(&target);
                            candidate.path = Some(target);
                        }
                    }
                }
            }
        }
    }
    for candidate in &mut candidates {
        if candidate.bytes.is_some() && candidate.path.is_none() {
            let clean = clean_component(&candidate.name);
            let stem = Path::new(&clean)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("attachment");
            let extension = Path::new(&clean)
                .extension()
                .and_then(|s| s.to_str())
                .filter(|s| s.len() <= 12 && s.chars().all(|c| c.is_ascii_alphanumeric()))
                .map(|s| format!(".{s}"))
                .unwrap_or_default();
            candidate.path =
                Some(alloc.choose(&attachment_directory, stem, &extension, false, false)?);
        }
    }
    let mut entry = Entry {
        account_id: note.account_id.clone(),
        folder_ids: note.folders.iter().map(|f| f.id.clone()).collect(),
        title: note.title.clone(),
        created_at: note.created_at.clone(),
        modified_at: note.modified_at.clone(),
        locked: note.locked,
        path: path.into(),
        ..Entry::default()
    };
    let mut files = BTreeMap::new();
    let mut links = Vec::new();
    let mut html = note.html.clone();
    let mut retained = if preserve {
        Some(read_document(root, previous.ok_or("missing preserved note")?)?.1)
    } else {
        None
    };
    for candidate in candidates {
        if let (Some(target), Some(bytes)) = (candidate.path, candidate.bytes) {
            let relative = target
                .strip_prefix(&format!("{}/", parent(path)?))
                .ok_or("invalid asset parent")?
                .to_string();
            if !candidate.cid.is_empty() {
                html = html.replace(&candidate.cid, &encoded(&relative));
            }
            if let (Some(body), Some(prior)) = (&mut retained, &candidate.old) {
                if let Some(prior_path) = &prior.path {
                    *body = body.replace(
                        &encoded(&entry_relative(previous.unwrap(), prior_path)?),
                        &encoded(&relative),
                    );
                }
            }
            let label = candidate.name.replace(['[', ']', '\n', '\r'], "_");
            links.push(format!("- [{label}](<{}>)", encoded(&relative)));
            let asset = Asset {
                name: candidate.name,
                path: Some(target),
                hash: Some(hash(&bytes)),
                url: None,
            };
            if candidate.legacy {
                entry.legacy_attachments.insert(candidate.key, asset);
            } else {
                entry.attachments.insert(candidate.key, asset);
            }
            files.insert(relative, bytes);
        } else if let Some(url) = candidate
            .url
            .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
        {
            links.push(format!("- <{}>", url.replace(['<', '>', '\n', '\r'], "")));
            entry.attachments.insert(
                candidate.key,
                Asset {
                    name: candidate.name,
                    path: None,
                    hash: None,
                    url: Some(url),
                },
            );
        } else {
            report.complete = false;
            let label = candidate.name.replace(['[', ']', '\n', '\r'], "_");
            report.warnings.push(format!(
                "Attachment {label} is unavailable in {}",
                filename(path)?
            ));
            links.push(format!("- {label} — unavailable through the Apple Notes export interface; open the original note to view it."));
            entry.attachments.insert(
                candidate.key,
                Asset {
                    name: candidate.name,
                    path: None,
                    hash: None,
                    url: None,
                },
            );
        }
    }
    let metadata = serde_json::json!({"type":"Note","readonly":true,"source":"apple-notes","title":note.title,
        "account":account_name,"folders":note.folders.iter().map(|f|&f.name).collect::<Vec<_>>(),
        "created":note.created_at,"modified":note.modified_at,"locked":note.locked});
    let yaml = serde_yaml::to_string(&metadata).map_err(|e| e.to_string())?;
    let body = if let Some(retained) = retained {
        retained
    } else if note.locked {
        "> This note is locked in Apple Notes. Unlock it there, then sync again.".into()
    } else {
        let mut body = html2md::parse_html(&html);
        if !links.is_empty() {
            body.push_str(&format!("\n\n## Attachments\n\n{}", links.join("\n")));
        }
        body
    };
    files.insert(
        filename(path)?.into(),
        format!("---\n{yaml}---\n\n{}\n", body.trim()).into_bytes(),
    );
    entry.files = files
        .iter()
        .map(|(name, bytes)| (name.clone(), hash(bytes)))
        .collect();
    Ok((entry, files))
}

fn all_files(ledger: &Ledger) -> BTreeMap<String, String> {
    ledger
        .notes
        .values()
        .flat_map(|entry| {
            entry
                .files
                .iter()
                .map(|(file, digest)| (entry_file(entry, file), digest.clone()))
        })
        .collect()
}
fn cleanup_empty(root: &Path, paths: impl IntoIterator<Item = String>, boundary: &str) {
    let boundary = root.join(boundary);
    let mut directories = BTreeSet::new();
    for path in paths {
        let path = root.join(path);
        let mut at = path.parent();
        while let Some(dir) = at {
            if dir == boundary || !dir.starts_with(&boundary) {
                break;
            }
            directories.insert(dir.to_path_buf());
            at = dir.parent();
        }
    }
    let mut ordered: Vec<_> = directories.into_iter().collect();
    ordered.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for dir in ordered {
        let _ = fs::remove_dir(dir);
    }
}
fn validate_pending(root: &Path, ledger: &Ledger, pending: &Pending) -> Result<()> {
    if pending.transaction.is_empty()
        || !pending
            .transaction
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || pending.next.pending.is_some()
    {
        return Err("invalid pending transaction".into());
    }
    validate_ledger(root, &pending.next)?;
    let old = all_files(ledger);
    let next = all_files(&pending.next);
    let expected_backups: BTreeSet<_> = old
        .iter()
        .filter(|(path, digest)| next.get(*path) != Some(*digest))
        .map(|(path, _)| fold(path))
        .collect();
    let required_installs: BTreeSet<_> = next
        .iter()
        .filter(|(path, digest)| old.get(*path) != Some(*digest))
        .map(|(path, _)| fold(path))
        .collect();
    let mut sources = BTreeSet::new();
    let mut destinations = BTreeSet::new();
    for (i, backup) in pending.backups.iter().enumerate() {
        if old.get(&backup.path) != Some(&backup.hash)
            || backup.backup != format!("{CONTROL}/trash/{}/{i}", pending.transaction)
            || !sources.insert(fold(&backup.path))
        {
            return Err("invalid pending backup ownership".into());
        }
        safe(root, &backup.path)?;
        safe(root, &backup.backup)?;
    }
    let mut missing = BTreeSet::new();
    for path in &pending.missing_backups {
        if !old.contains_key(path) || !missing.insert(fold(path)) {
            return Err("invalid missing backup declaration".into());
        }
        let source = safe(root, path)?;
        if pending.phase == Phase::Backup && source.exists() {
            return Err("a declared-missing source appeared during sync".into());
        }
    }
    if sources.union(&missing).cloned().collect::<BTreeSet<_>>() != expected_backups
        || !sources.is_disjoint(&missing)
    {
        return Err("incomplete pending backup operations".into());
    }
    for (i, install) in pending.installs.iter().enumerate() {
        if next.get(&install.path) != Some(&install.hash)
            || install.staged != format!("{CONTROL}/staging/{}/{i}", pending.transaction)
            || !destinations.insert(fold(&install.path))
        {
            return Err("invalid pending installation".into());
        }
        safe(root, &install.path)?;
        safe(root, &install.staged)?;
    }
    if !required_installs.is_subset(&destinations) {
        return Err("incomplete pending install operations".into());
    }
    Ok(())
}
fn recover(root: &Path) -> Result<()> {
    recover_legacy(root)?;
    let Some(mut ledger) = read_mapping(root)? else {
        return Ok(());
    };
    let Some(mut pending) = ledger.pending.take() else {
        return Ok(());
    };
    validate_pending(root, &ledger, &pending)?;
    // Disable old cron binaries before the first layout change. This file has
    // no identities; a v1 binary refuses its unsupported version.
    tombstone(root)?;
    if pending.phase == Phase::Backup {
        // Check every file before moving any, so a local edit cannot yield an
        // avoidable half-migration. Recheck each source immediately before move.
        for backup in &pending.backups {
            let saved = safe(root, &backup.backup)?;
            let source = safe(root, &backup.path)?;
            if saved.exists() && source.exists() {
                return Err("both source and backup exist during sync recovery".into());
            }
            let check = if saved.exists() { saved } else { source };
            if !check.exists() || hash(&fs::read(check).map_err(|e| e.to_string())?) != backup.hash
            {
                return Err("Local changes or missing files prevent sync recovery".into());
            }
        }
        for install in &pending.installs {
            let staged = safe(root, &install.staged)?;
            if hash(&fs::read(staged).map_err(|_| "missing staged sync file")?) != install.hash {
                return Err("staged sync file changed".into());
            }
            let target = safe(root, &install.path)?;
            if target.exists()
                && !pending
                    .backups
                    .iter()
                    .any(|b| fold(&b.path) == fold(&install.path))
            {
                return Err("unmanaged destination appeared during sync".into());
            }
        }
        for backup in &pending.backups {
            let saved = safe(root, &backup.backup)?;
            if !saved.exists() {
                let source = safe(root, &backup.path)?;
                if hash(&fs::read(&source).map_err(|e| e.to_string())?) != backup.hash {
                    return Err("Local changes prevent sync recovery".into());
                }
                fs::create_dir_all(saved.parent().unwrap()).map_err(|e| e.to_string())?;
                sync_directory_chain(saved.parent().unwrap(), root)?;
                rename_durable(&source, &saved)?;
            }
        }
        cleanup_empty(
            root,
            pending.backups.iter().map(|b| b.path.clone()),
            "applenotes",
        );
        pending.phase = Phase::Install;
        ledger.pending = Some(pending.clone());
        atomic_json(root, MAPPING, &ledger)?;
        ledger.pending = None;
    }
    for install in &pending.installs {
        let staged = safe(root, &install.staged)?;
        let target = safe(root, &install.path)?;
        if staged.exists() {
            if target.exists() {
                return Err("unmanaged destination prevents sync recovery".into());
            }
            if hash(&fs::read(&staged).map_err(|e| e.to_string())?) != install.hash {
                return Err("staged sync file changed".into());
            }
            fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            sync_directory_chain(target.parent().unwrap(), root)?;
            rename_durable(&staged, &target)?;
        } else if !target.exists()
            || hash(&fs::read(target).map_err(|e| e.to_string())?) != install.hash
        {
            return Err("installed sync file is missing or changed".into());
        }
    }
    atomic_json(root, MAPPING, pending.next.as_ref())?;
    cleanup_empty(
        root,
        pending.installs.iter().map(|i| i.staged.clone()),
        &format!("{CONTROL}/staging"),
    );
    let _ = fs::remove_dir(root.join(format!("{CONTROL}/staging/{}", pending.transaction)));
    Ok(())
}

fn commit(
    root: &Path,
    old: &Ledger,
    mut next: Ledger,
    files: BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    let old_files = all_files(old);
    let mut backup_specs = Vec::new();
    let mut missing_backups = Vec::new();
    let mut install_specs = Vec::new();
    for (path, digest) in &old_files {
        if files.get(path).is_some_and(|bytes| hash(bytes) == *digest) {
            continue;
        }
        if safe(root, path)?.exists() {
            backup_specs.push((path.clone(), digest.clone()));
        } else {
            missing_backups.push(path.clone());
        }
    }
    for (path, bytes) in files {
        if old_files.get(&path) == Some(&hash(&bytes)) && safe(root, &path)?.exists() {
            continue;
        }
        install_specs.push((path, bytes));
    }
    if backup_specs.is_empty()
        && install_specs.is_empty()
        && *old == next
        && safe(root, MAPPING)?.exists()
    {
        return Ok(());
    }
    let stage_root = safe(root, &format!("{CONTROL}/staging"))?;
    fs::create_dir_all(&stage_root).map_err(|e| e.to_string())?;
    let transaction = tempfile::Builder::new()
        .prefix("sync-")
        .tempdir_in(stage_root)
        .map_err(|e| e.to_string())?;
    let tx = transaction
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let backups: Vec<Backup> = backup_specs
        .into_iter()
        .enumerate()
        .map(|(i, (path, hash))| Backup {
            path,
            hash,
            backup: format!("{CONTROL}/trash/{tx}/{i}"),
        })
        .collect();
    next.trash.extend(backups.iter().cloned());
    let mut installs = Vec::new();
    for (i, (path, bytes)) in install_specs.into_iter().enumerate() {
        let staged = format!("{CONTROL}/staging/{tx}/{i}");
        let mut file = File::create(safe(root, &staged)?).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        installs.push(Install {
            path,
            hash: hash(&bytes),
            staged,
        });
    }
    let pending = Pending {
        transaction: tx,
        phase: Phase::Backup,
        backups,
        missing_backups,
        installs,
        next: Box::new(next),
    };
    validate_pending(root, old, &pending)?;
    // Retain staged data before publishing the recovery record.
    let transaction_path = transaction.keep();
    sync_directory_chain(&transaction_path, root)?;
    let mut record = old.clone();
    record.pending = Some(pending);
    atomic_json(root, MAPPING, &record)?;
    recover(root)?;
    let _ = fs::remove_dir(transaction_path);
    Ok(())
}

fn acquire(root: &Path) -> Result<File> {
    let path = safe(root, &format!("{CONTROL}/sync.lock"))?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.try_lock_exclusive()
        .map_err(|_| "Apple Notes sync is already running for this vault")?;
    Ok(file)
}
pub fn sync(vault: &Path, dry_run: bool) -> Result<SyncReport> {
    if !cfg!(target_os = "macos") {
        return Err("Apple Notes sync is available only on macOS".into());
    }
    let root = vault.canonicalize().map_err(|e| format!("vault: {e}"))?;
    if !root.is_dir() {
        return Err("vault must be an existing directory".into());
    }
    let _lock = if dry_run { None } else { Some(acquire(&root)?) };
    if dry_run {
        if safe(&root, &format!("{CONTROL}/pending.json"))?.exists()
            || read_mapping(&root)?.is_some_and(|l| l.pending.is_some())
        {
            return Err("an interrupted sync needs recovery; run without --dry-run first".into());
        }
    } else {
        recover(&root)?;
    }
    let staging = tempfile::tempdir().map_err(|e| e.to_string())?;
    let snapshot = source::read_snapshot(staging.path())?;
    apply_snapshot(&root, &snapshot, staging.path(), dry_run)
}
fn apply_snapshot(
    root: &Path,
    snapshot: &Snapshot,
    staging: &Path,
    dry_run: bool,
) -> Result<SyncReport> {
    let mut report = SyncReport {
        complete: snapshot.complete && snapshot.warnings.is_empty(),
        dry_run,
        warnings: snapshot.warnings.clone(),
        ..Default::default()
    };
    if !snapshot.complete {
        return Ok(report);
    }
    let accounts: BTreeSet<_> = snapshot.accounts.iter().map(|a| a.id.as_str()).collect();
    if accounts.len() != snapshot.accounts.len() || accounts.contains("") {
        return Err("invalid or duplicate account identities".into());
    }
    let mut notes: BTreeMap<String, (Note, bool)> = BTreeMap::new();
    for note in &snapshot.notes {
        if note.id.is_empty()
            || notes.contains_key(&note.id)
            || !accounts.contains(note.account_id.as_str())
        {
            return Err("invalid or duplicate note identity".into());
        }
        note_stem(note)?;
        notes.insert(note.id.clone(), (note.clone(), false));
    }
    let (old, migrating) = load_for_sync(root, snapshot)?;
    for entry in old.notes.values() {
        verify_owned(root, entry)?;
    }
    for (id, entry) in &old.notes {
        if !notes.contains_key(id) {
            if !accounts.contains(entry.account_id.as_str()) {
                notes.insert(id.clone(), (retained_note(id, entry, &old)?, true));
                report.complete = false;
                report.warnings.push(format!(
                    "Account {} is unavailable; retaining its notes",
                    old.accounts[&entry.account_id].name
                ));
            } else {
                report.deleted += 1;
            }
        }
    }
    let mut alloc = Allocator::new(root, &old)?;
    let (new_accounts, new_folders) =
        plan_directories(&old, &notes, snapshot, migrating, &mut alloc)?;
    let paths = plan_note_paths(
        &old,
        &notes,
        &new_accounts,
        &new_folders,
        migrating,
        &mut alloc,
    )?;
    let mut next = Ledger {
        accounts: new_accounts,
        folders: new_folders,
        trash: old.trash.clone(),
        ..Ledger::default()
    };
    let mut rendered = BTreeMap::new();
    for (id, (note, unavailable)) in notes {
        let previous = old.notes.get(&id);
        let preserve = previous.is_some() && (note.locked || unavailable);
        if note.locked {
            report.locked += 1;
            report.complete = false;
            report.warnings.push(format!(
                "Locked note {}: existing content is preserved",
                filename(&paths[&id])?
            ));
        }
        let (entry, files) = render(
            &note,
            &next.accounts[&note.account_id].name,
            &paths[&id],
            RenderContext {
                staging,
                root,
                previous,
                preserve,
                migrating,
                alloc: &mut alloc,
                report: &mut report,
            },
        )?;
        if let Some(previous) = previous {
            if previous == &entry
                && entry
                    .files
                    .keys()
                    .all(|f| safe(root, &entry_file(&entry, f)).is_ok_and(|p| p.exists()))
            {
                report.unchanged += 1;
            } else if previous.path != entry.path {
                report.moved += 1;
            } else {
                report.updated += 1;
            }
        } else {
            report.created += 1;
        }
        for (file, bytes) in files {
            if rendered.insert(entry_file(&entry, &file), bytes).is_some() {
                return Err("duplicate output path".into());
            }
        }
        next.notes.insert(id, entry);
    }
    validate_ledger(root, &next)?;
    report.warnings.sort();
    report.warnings.dedup();
    if !dry_run {
        commit(root, &old, next, rendered)?;
    }
    Ok(report)
}

// Only read/replay v1 journals. New transactions never write this format.
#[derive(Debug, Serialize, Deserialize)]
struct LegacyOperation {
    old: Option<String>,
    old_hash: Option<String>,
    new: Option<String>,
    staged: Option<String>,
    backup: String,
}
#[derive(Debug, Serialize, Deserialize)]
struct LegacyJournal {
    operations: Vec<LegacyOperation>,
    ledger: Ledger,
}
fn recover_legacy(root: &Path) -> Result<()> {
    let path = safe(root, &format!("{CONTROL}/pending.json"))?;
    if !path.exists() {
        return Ok(());
    }
    if safe(root, MAPPING)?.exists() {
        return Err("legacy and current sync transactions coexist; restore the matching mapping before syncing".into());
    }
    let journal: LegacyJournal =
        serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|_| "invalid legacy recovery journal")?;
    if journal.ledger.version != 1 {
        return Err("unsupported legacy recovery journal".into());
    }
    for entry in journal.ledger.notes.values() {
        validate_entry(root, entry)?;
    }
    let final_files = all_files(&journal.ledger);
    for op in &journal.operations {
        for item in [&op.old, &op.new].into_iter().flatten() {
            if !content_path(item) {
                return Err("invalid legacy recovery path".into());
            }
            safe(root, item)?;
        }
        if !op.backup.starts_with(&format!("{CONTROL}/trash/")) {
            return Err("invalid legacy backup path".into());
        }
        safe(root, &op.backup)?;
        if let Some(staged) = &op.staged {
            if !staged.starts_with(&format!("{CONTROL}/staging/")) {
                return Err("invalid legacy staging path".into());
            }
            safe(root, staged)?;
        }
        if op
            .new
            .as_ref()
            .is_some_and(|p| !final_files.contains_key(p))
        {
            return Err("legacy install has no mapped owner".into());
        }
    }
    for op in &journal.operations {
        if let Some(old) = &op.old {
            let source = safe(root, old)?;
            let backup = safe(root, &op.backup)?;
            if source.exists() && !backup.exists() {
                let current = hash(&fs::read(&source).map_err(|e| e.to_string())?);
                if op.old_hash.as_ref() != Some(&current) {
                    let installed = final_files.get(old) == Some(&current)
                        && journal.operations.iter().any(|next| {
                            next.new.as_ref() == Some(old)
                                && next.staged.as_ref().is_some_and(|p| !root.join(p).exists())
                        });
                    if installed {
                        continue;
                    }
                    return Err("Local changes prevent legacy recovery".into());
                }
                fs::create_dir_all(backup.parent().unwrap()).map_err(|e| e.to_string())?;
                sync_directory_chain(backup.parent().unwrap(), root)?;
                rename_durable(&source, &backup)?;
            }
        }
    }
    for op in &journal.operations {
        if let (Some(staged), Some(new)) = (&op.staged, &op.new) {
            let source = safe(root, staged)?;
            let target = safe(root, new)?;
            let expected = &final_files[new];
            if source.exists() {
                if target.exists() {
                    return Err("legacy recovery destination already exists".into());
                }
                if hash(&fs::read(&source).map_err(|e| e.to_string())?) != *expected {
                    return Err("legacy staged file changed".into());
                }
                fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
                sync_directory_chain(target.parent().unwrap(), root)?;
                rename_durable(&source, &target)?;
            } else if !target.exists()
                || hash(&fs::read(target).map_err(|e| e.to_string())?) != *expected
            {
                return Err("legacy recovery is missing its installed file".into());
            }
        }
    }
    // Keep the legacy representation until load_for_sync imports its YAML and
    // attachment fingerprints into the sole new mapping file.
    atomic_json(root, &format!("{CONTROL}/state.json"), &journal.ledger)?;
    cleanup_empty(
        root,
        journal.operations.iter().filter_map(|op| op.staged.clone()),
        &format!("{CONTROL}/staging"),
    );
    cleanup_empty(
        root,
        journal.operations.iter().filter_map(|op| op.old.clone()),
        "applenotes",
    );
    fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "sync_v2_tests.rs"]
mod tests;
