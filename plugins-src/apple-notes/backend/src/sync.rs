//! One-way, journaled mirror. Only files recorded in our ledger are owned.
use crate::source::{self, Note, Snapshot};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const CONTROL: &str = ".notemd/apple-notes";
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Entry {
    account_id: String,
    path: String,
    files: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    notes: BTreeMap<String, Entry>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 1,
            notes: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Operation {
    old: Option<String>,
    old_hash: Option<String>,
    new: Option<String>,
    staged: Option<String>,
    backup: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    operations: Vec<Operation>,
    ledger: Ledger,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn component(name: &str, id: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(48)
        .collect();
    let clean = clean.trim_matches(|c: char| c.is_whitespace() || c == '.');
    format!(
        "{}--{}",
        if clean.is_empty() { "Untitled" } else { clean },
        &hash(id.as_bytes())[..16]
    )
}

/// Reject symlinks in every component, including dangling final links.
fn safe(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty() {
        return Err("empty managed path".into());
    }
    let mut result = root.to_path_buf();
    for part in Path::new(relative).components() {
        let Component::Normal(part) = part else {
            return Err(format!("unsafe managed path: {relative}"));
        };
        result.push(part);
        match fs::symlink_metadata(&result) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("symlink is not allowed: {}", result.display()))
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

fn load(root: &Path) -> Result<Ledger> {
    let path = safe(root, &format!("{CONTROL}/state.json"))?;
    if !path.exists() {
        return Ok(Ledger::default());
    }
    let state: Ledger = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if state.version != 1 {
        return Err("unsupported Apple Notes state version".into());
    }
    for entry in state.notes.values() {
        validate_entry(root, entry)?;
    }
    Ok(state)
}

fn validate_entry(root: &Path, entry: &Entry) -> Result<()> {
    if !entry.path.starts_with("applenotes/")
        || !entry.path.ends_with(".md")
        || !entry.files.contains_key(
            Path::new(&entry.path)
                .file_name()
                .unwrap()
                .to_str()
                .ok_or("invalid filename")?,
        )
    {
        return Err("invalid Apple Notes ledger entry".into());
    }
    safe(root, &entry.path)?;
    for file in entry.files.keys() {
        safe(root, &entry_file(entry, file))?;
    }
    Ok(())
}

#[cfg(test)]
fn files_at(root: &Path) -> Result<BTreeMap<String, String>> {
    fn walk(base: &Path, at: &Path, files: &mut BTreeMap<String, String>) -> Result<()> {
        for item in fs::read_dir(at).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let path = item.path();
            let kind = item.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                return Err(format!("symlink in mirrored note: {}", path.display()));
            }
            if kind.is_dir() {
                walk(base, &path, files)?;
            } else if kind.is_file() {
                files.insert(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    hash(&fs::read(&path).map_err(|e| e.to_string())?),
                );
            } else {
                return Err("unsupported file in mirrored note".into());
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files)?;
    Ok(files)
}

fn verify_owned(root: &Path, entry: &Entry) -> Result<()> {
    for (file, expected) in &entry.files {
        let path = safe(root, &entry_file(entry, file))?;
        if path.exists() && hash(&fs::read(path).map_err(|e| e.to_string())?) != *expected {
            return Err(format!(
                "Local changes in {}; move them out or restore the mirror before syncing",
                entry.path
            ));
        }
    }
    Ok(())
}

fn entry_file(entry: &Entry, file: &str) -> String {
    format!(
        "{}/{file}",
        Path::new(&entry.path).parent().unwrap().to_string_lossy()
    )
}

fn note_stem(note: &Note) -> Result<String> {
    let created = chrono::DateTime::parse_from_rfc3339(&note.created_at)
        .map_err(|_| format!("Invalid creation date for {}", note.id))?;
    let timestamp = created
        .with_timezone(&chrono::Utc)
        .format("%Y-%m-%d-%H%M%SZ");
    let mut slug = String::new();
    for c in note.title.chars().take(64) {
        if slug.len() + c.len_utf8() > 192 {
            break;
        }
        if c.is_alphanumeric() {
            slug.extend(c.to_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    Ok(format!(
        "{timestamp}-{}-{}",
        &hash(note.id.as_bytes())[..16],
        if slug.is_empty() { "untitled" } else { slug }
    ))
}

fn destination(note: &Note, account_name: &str) -> Result<String> {
    let mut parts = vec![
        "applenotes".into(),
        component(account_name, &note.account_id),
    ];
    parts.extend(note.folders.iter().map(|f| component(&f.name, &f.id)));
    parts.push(format!("{}.md", note_stem(note)?));
    Ok(parts.join("/"))
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

fn render(
    note: &Note,
    account_name: &str,
    staging: &Path,
    root: &Path,
    previous: Option<&Entry>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    let mut html = note.html.clone();
    let mut links = Vec::new();
    let stem = note_stem(note)?;
    for attachment in &note.attachments {
        let extension = Path::new(&attachment.name)
            .extension()
            .and_then(|s| s.to_str())
            .filter(|s| s.len() <= 12 && s.chars().all(|c| c.is_ascii_alphanumeric()));
        let attachment_stem = Path::new(&attachment.name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("attachment");
        let attachment_name = format!(
            "{}{}",
            component(attachment_stem, &attachment.id),
            extension.map(|e| format!(".{e}")).unwrap_or_default()
        );
        let name = format!("{stem}.attachments/{attachment_name}");
        let previous_bytes = if attachment.relative_path.is_none() {
            let identity = format!("--{}", &hash(attachment.id.as_bytes())[..16]);
            previous
                .and_then(|entry| {
                    entry
                        .files
                        .keys()
                        .find(|f| {
                            f.contains('/')
                                && Path::new(f)
                                    .file_stem()
                                    .is_some_and(|s| s.to_string_lossy().ends_with(&identity))
                        })
                        .map(|f| (entry, f))
                })
                .map(|(entry, file)| {
                    let path = safe(root, &entry_file(entry, file))?;
                    match fs::read(path) {
                        Ok(bytes) => Ok(Some(bytes)),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                        Err(e) => Err(e.to_string()),
                    }
                })
                .transpose()?
                .flatten()
        } else {
            None
        };
        if attachment.relative_path.is_some() || previous_bytes.is_some() {
            let bytes = match &attachment.relative_path {
                Some(relative) => fs::read(safe(staging, relative)?).map_err(|e| e.to_string())?,
                None => previous_bytes.unwrap(),
            };
            let url = encoded(&name);
            if !attachment.content_id.is_empty() {
                html = html.replace(&attachment.content_id, &url);
            }
            files.insert(name, bytes);
            let label = attachment.name.replace(['[', ']', '\n', '\r'], "_");
            links.push(format!("- [{label}](<{url}>)"));
        } else if let Some(url) = attachment
            .url
            .as_deref()
            .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
        {
            links.push(format!("- <{}>", url.replace(['<', '>', '\n', '\r'], "")));
        } else if !note.locked {
            let label = attachment.name.replace(['[', ']', '\n', '\r'], "_");
            links.push(format!("- {label} — unavailable through the Apple Notes export interface; open the original note to view it."));
        }
    }
    let metadata = serde_json::json!({
        "type": "Note", "readonly": true, "source": "apple-notes", "apple_notes_id": note.id,
        "title": note.title, "account": account_name, "account_id": note.account_id,
        "folders": note.folders.iter().map(|f| &f.name).collect::<Vec<_>>(),
        "folder_ids": note.folders.iter().map(|f| &f.id).collect::<Vec<_>>(),
        "created": note.created_at, "modified": note.modified_at, "locked": note.locked
    });
    let yaml = serde_yaml::to_string(&metadata).map_err(|e| e.to_string())?;
    let body = if note.locked {
        "> This note is locked in Apple Notes. Unlock it there, then sync again.".into()
    } else {
        html2md::parse_html(&html)
    };
    let attachments = if links.is_empty() {
        String::new()
    } else {
        format!("\n\n## Attachments\n\n{}", links.join("\n"))
    };
    files.insert(
        format!("{stem}.md"),
        format!("---\n{yaml}---\n\n{}{attachments}\n", body.trim()).into_bytes(),
    );
    Ok(files)
}

fn recover(root: &Path) -> Result<()> {
    let journal_path = safe(root, &format!("{CONTROL}/pending.json"))?;
    if !journal_path.exists() {
        return Ok(());
    }
    let journal: Journal =
        serde_json::from_slice(&fs::read(&journal_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if journal.ledger.version != 1 {
        return Err("unsupported recovery journal".into());
    }
    for entry in journal.ledger.notes.values() {
        validate_entry(root, entry)?;
    }
    // Validate all paths before the first mutation, also when replaying after a crash.
    for op in &journal.operations {
        for path in [&op.old, &op.new].into_iter().flatten() {
            if !path.starts_with("applenotes/") {
                return Err("invalid journal note path".into());
            }
            safe(root, path)?;
        }
        if !op.backup.starts_with(&format!("{CONTROL}/trash/")) {
            return Err("invalid journal backup".into());
        }
        safe(root, &op.backup)?;
        if let Some(staged) = &op.staged {
            if !staged.starts_with(&format!("{CONTROL}/staging/")) {
                return Err("invalid journal staging".into());
            }
            safe(root, staged)?;
        }
    }
    for op in &journal.operations {
        let backup = safe(root, &op.backup)?;
        let needs_install = match &op.staged {
            Some(path) => safe(root, path)?.exists(),
            None => true,
        };
        if let Some(old) = &op.old {
            let old = safe(root, old)?;
            if needs_install && old.exists() && !backup.exists() {
                if op.old_hash.as_ref() != Some(&hash(&fs::read(&old).map_err(|e| e.to_string())?))
                {
                    return Err("local changes prevent recovery; restore the mirrored files before retrying".into());
                }
                fs::create_dir_all(backup.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::rename(old, &backup).map_err(|e| e.to_string())?;
            }
        }
        if let (Some(staged), Some(new)) = (&op.staged, &op.new) {
            let staged = safe(root, staged)?;
            let new = safe(root, new)?;
            if staged.exists() {
                if new.exists() {
                    return Err(format!(
                        "recovery destination already exists: {}",
                        new.display()
                    ));
                }
                fs::create_dir_all(new.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::rename(staged, new).map_err(|e| e.to_string())?;
            } else if !new.exists() {
                return Err("recovery is missing both staged and destination note".into());
            }
        }
    }
    atomic_json(root, &format!("{CONTROL}/state.json"), &journal.ledger)?;
    for op in &journal.operations {
        if let Some(staged) = &op.staged {
            let path = safe(root, staged)?;
            let mut parent = path.parent();
            while let Some(dir) = parent {
                if dir == root.join(format!("{CONTROL}/staging"))
                    || !dir.starts_with(root.join(format!("{CONTROL}/staging")))
                {
                    break;
                }
                if fs::remove_dir(dir).is_err() {
                    break;
                }
                parent = dir.parent();
            }
        }
        if let Some(old) = &op.old {
            let path = safe(root, old)?;
            let mut parent = path.parent();
            while let Some(dir) = parent {
                if dir == root.join("applenotes") || !dir.starts_with(root.join("applenotes")) {
                    break;
                }
                if fs::remove_dir(dir).is_err() {
                    break;
                }
                parent = dir.parent();
            }
        }
    }
    fs::remove_file(journal_path).map_err(|e| e.to_string())
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
        .map_err(|_| "Apple Notes sync is already running for this vault".to_string())?;
    Ok(file)
}

fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        a.canonicalize()
            .ok()
            .zip(b.canonicalize().ok())
            .is_some_and(|(a, b)| a == b)
    }
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
        if safe(&root, &format!("{CONTROL}/pending.json"))?.exists() {
            return Err(
                "an interrupted sync needs recovery; run sync without --dry-run first".into(),
            );
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
    // A partial enumeration is never a usable authoritative snapshot.
    if !snapshot.complete {
        return Ok(report);
    }
    let old = load(root)?;
    let mut next = old.clone();
    let mut seen = BTreeSet::new();
    let accounts: BTreeMap<_, _> = snapshot
        .accounts
        .iter()
        .map(|a| (a.id.as_str(), a.name.as_str()))
        .collect();
    if accounts.len() != snapshot.accounts.len() {
        return Err("duplicate account ids in snapshot".into());
    }
    let mut planned: Vec<(
        String,
        Option<Entry>,
        Option<Entry>,
        BTreeMap<String, Vec<u8>>,
    )> = Vec::new();
    for note in &snapshot.notes {
        if note.id.is_empty() || !seen.insert(note.id.clone()) {
            return Err("empty or duplicate note id in snapshot".into());
        }
        let account = accounts
            .get(note.account_id.as_str())
            .ok_or("note refers to a missing account")?;
        let previous = old.notes.get(&note.id);
        if note.locked {
            report.locked += 1;
            report.complete = false;
            report.warnings.push(format!(
                "Locked note {}: existing content is preserved",
                note.id
            ));
            if previous.is_some() {
                continue;
            }
        }
        let files = render(note, account, staging, root, previous)?;
        let entry = Entry {
            account_id: note.account_id.clone(),
            path: destination(note, account)?,
            files: files
                .iter()
                .map(|(p, bytes)| (p.clone(), hash(bytes)))
                .collect(),
        };
        validate_entry(root, &entry)?;
        if let Some(previous) = previous {
            verify_owned(root, previous)?;
            if previous == &entry
                && entry
                    .files
                    .keys()
                    .all(|f| safe(root, &entry_file(&entry, f)).is_ok_and(|p| p.exists()))
            {
                report.unchanged += 1;
                continue;
            }
            if previous.path != entry.path {
                report.moved += 1;
            } else {
                report.updated += 1;
            }
        } else {
            report.created += 1;
        }
        for file in entry.files.keys() {
            let path = entry_file(&entry, file);
            let owned = previous.is_some_and(|p| {
                p.files.keys().any(|f| {
                    let old = entry_file(p, f);
                    old == path || same_file(&root.join(&old), &root.join(&path))
                })
            });
            if !owned && safe(root, &path)?.exists() {
                return Err(format!("unmanaged destination already exists: {path}"));
            }
        }
        next.notes.insert(note.id.clone(), entry.clone());
        planned.push((note.id.clone(), previous.cloned(), Some(entry), files));
    }
    for (id, previous) in &old.notes {
        if seen.contains(id) {
            continue;
        }
        if !accounts.contains_key(previous.account_id.as_str()) {
            report.complete = false;
            report.warnings.push(format!(
                "Account {} is unavailable; retaining its notes",
                previous.account_id
            ));
            continue;
        }
        verify_owned(root, previous)?;
        report.deleted += 1;
        next.notes.remove(id);
        planned.push((id.clone(), Some(previous.clone()), None, BTreeMap::new()));
    }
    if dry_run || planned.is_empty() {
        return Ok(report);
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
    let mut operations = Vec::new();
    for (id, previous, entry, files) in planned {
        let note_key = hash(id.as_bytes());
        if let Some(previous) = &previous {
            for (file, old_hash) in &previous.files {
                let old = entry_file(previous, file);
                let retained = entry.as_ref().is_some_and(|new| {
                    new.files
                        .iter()
                        .any(|(name, digest)| entry_file(new, name) == old && digest == old_hash)
                });
                if retained {
                    continue;
                }
                if safe(root, &old)?.exists() {
                    operations.push(Operation {
                        old: Some(old),
                        old_hash: Some(old_hash.clone()),
                        new: None,
                        staged: None,
                        backup: format!("{CONTROL}/trash/{tx}/{note_key}/{file}"),
                    });
                }
            }
        }
        if let Some(entry) = entry {
            for (file, bytes) in files {
                let new = entry_file(&entry, &file);
                let retained = previous.as_ref().is_some_and(|old| {
                    old.files.iter().any(|(name, digest)| {
                        entry_file(old, name) == new && entry.files.get(&file) == Some(digest)
                    })
                });
                if retained && safe(root, &new)?.exists() {
                    continue;
                }
                let relative = format!("{CONTROL}/staging/{tx}/{note_key}/{file}");
                let path = safe(root, &relative)?;
                fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                let mut output = File::create(&path).map_err(|e| e.to_string())?;
                output
                    .write_all(&bytes)
                    .and_then(|_| output.sync_all())
                    .map_err(|e| e.to_string())?;
                operations.push(Operation {
                    old: None,
                    old_hash: None,
                    new: Some(new),
                    staged: Some(relative),
                    backup: format!("{CONTROL}/trash/{tx}/{note_key}/{file}"),
                });
            }
        }
    }
    // Keep staging before publishing the journal: a terminated process must be replayable.
    let transaction_path = transaction.keep();
    atomic_json(
        root,
        &format!("{CONTROL}/pending.json"),
        &Journal {
            operations,
            ledger: next,
        },
    )?;
    recover(root)?;
    let _ = fs::remove_dir(transaction_path); // empty after the journal was applied
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{Account, Attachment, Folder};

    fn snapshot() -> Snapshot {
        Snapshot {
            complete: true,
            warnings: vec![],
            accounts: vec![Account {
                id: "account".into(),
                name: "iCloud".into(),
            }],
            notes: vec![Note {
                id: "note-1".into(),
                title: "A / 中文".into(),
                account_id: "account".into(),
                folders: vec![Folder {
                    id: "folder".into(),
                    name: "Notes".into(),
                }],
                created_at: "2026-09-01T00:00:00Z".into(),
                modified_at: "2026-09-15T00:00:00Z".into(),
                html: "<h1>A / 中文</h1><p><b>Hello</b> world</p>".into(),
                locked: false,
                attachments: vec![],
            }],
        }
    }

    fn apply(root: &Path, snapshot: &Snapshot) -> Result<SyncReport> {
        apply_snapshot(root, snapshot, root, false)
    }

    #[test]
    fn create_noop_update_move_and_recoverable_delete() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        let mut s = snapshot();
        assert_eq!(apply(root, &s).unwrap().created, 1);
        let state = load(root).unwrap();
        let path = root.join(&state.notes["note-1"].path);
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("readonly: true"));
        assert!(content.contains("**Hello** world"));
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(apply(root, &s).unwrap().unchanged, 1);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), mtime);
        s.notes[0].html.push_str("<p>updated</p>");
        assert_eq!(apply(root, &s).unwrap().updated, 1);
        s.notes[0].title = "Renamed".into();
        s.notes[0].folders.push(Folder {
            id: "child".into(),
            name: "Nested".into(),
        });
        assert_eq!(apply(root, &s).unwrap().moved, 1);
        assert!(!path.exists());
        let moved = root.join(&load(root).unwrap().notes["note-1"].path);
        assert!(moved.exists());
        s.notes.clear();
        assert_eq!(apply(root, &s).unwrap().deleted, 1);
        assert!(!moved.exists());
        assert!(load(root).unwrap().notes.is_empty());
        assert!(!files_at(&root.join(format!("{CONTROL}/trash")))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn partial_or_missing_account_never_deletes() {
        let vault = tempfile::tempdir().unwrap();
        let mut s = snapshot();
        apply(vault.path(), &s).unwrap();
        s.notes.clear();
        s.complete = false;
        assert!(!apply(vault.path(), &s).unwrap().complete);
        assert_eq!(load(vault.path()).unwrap().notes.len(), 1);
        s.complete = true;
        s.accounts.clear();
        let report = apply(vault.path(), &s).unwrap();
        assert!(!report.complete);
        assert_eq!(report.deleted, 0);
        assert_eq!(load(vault.path()).unwrap().notes.len(), 1);
    }

    #[test]
    fn locked_notes_preserve_body_and_new_locked_notes_get_metadata() {
        let vault = tempfile::tempdir().unwrap();
        let mut s = snapshot();
        apply(vault.path(), &s).unwrap();
        let before = load(vault.path()).unwrap().notes;
        s.notes[0].locked = true;
        s.notes[0].html.clear();
        let report = apply(vault.path(), &s).unwrap();
        assert_eq!(report.locked, 1);
        assert!(!report.complete);
        assert_eq!(load(vault.path()).unwrap().notes, before);
        s.notes[0].id = "new-locked".into();
        s.notes.push(snapshot().notes.remove(0));
        apply(vault.path(), &s).unwrap();
        let entry = &load(vault.path()).unwrap().notes["new-locked"];
        assert!(fs::read_to_string(vault.path().join(&entry.path))
            .unwrap()
            .contains("locked: true"));
    }

    #[test]
    fn duplicate_names_and_unsafe_names_have_distinct_safe_paths() {
        let vault = tempfile::tempdir().unwrap();
        let mut s = snapshot();
        s.notes[0].title = "../../".into();
        let mut other = s.notes[0].clone();
        other.id = "note-2".into();
        s.notes.push(other);
        assert_eq!(apply(vault.path(), &s).unwrap().created, 2);
        let paths: BTreeSet<_> = load(vault.path())
            .unwrap()
            .notes
            .values()
            .map(|e| e.path.clone())
            .collect();
        assert_eq!(paths.len(), 2);
        for path in paths {
            assert!(!path.contains("/../"));
            assert!(vault.path().join(path).exists());
        }
    }

    #[test]
    fn attachments_are_local_encoded_and_synced() {
        let vault = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        fs::write(staging.path().join("file"), b"photo bytes").unwrap();
        let mut s = snapshot();
        s.notes[0].html.push_str("<img src=\"cid:test\">");
        s.notes[0].attachments.push(Attachment {
            id: "att".into(),
            name: "截图 #1.png".into(),
            content_id: "cid:test".into(),
            relative_path: Some("file".into()),
            url: None,
        });
        apply_snapshot(vault.path(), &s, staging.path(), false).unwrap();
        let entry = &load(vault.path()).unwrap().notes["note-1"];
        assert_eq!(entry.files.len(), 2);
        let doc = fs::read_to_string(vault.path().join(&entry.path)).unwrap();
        assert!(!doc.contains("cid:test"));
        assert!(doc.contains("%23"));
        assert!(doc.contains(".png>"));
        let asset = entry
            .files
            .keys()
            .find(|name| name.ends_with(".png"))
            .unwrap();
        let asset_path = vault.path().join(entry_file(entry, asset));
        let before = fs::metadata(&asset_path).unwrap().modified().unwrap();
        s.notes[0].html.push_str("<p>only the body changed</p>");
        assert_eq!(
            apply_snapshot(vault.path(), &s, staging.path(), false)
                .unwrap()
                .updated,
            1
        );
        assert_eq!(
            fs::metadata(&asset_path).unwrap().modified().unwrap(),
            before
        );
        fs::write(staging.path().join("file"), b"new photo").unwrap();
        assert_eq!(
            apply_snapshot(vault.path(), &s, staging.path(), false)
                .unwrap()
                .updated,
            1
        );
    }

    #[test]
    fn dry_run_does_not_create_any_vault_files() {
        let vault = tempfile::tempdir().unwrap();
        let report = apply_snapshot(vault.path(), &snapshot(), vault.path(), true).unwrap();
        assert!(report.dry_run);
        assert_eq!(report.created, 1);
        assert_eq!(fs::read_dir(vault.path()).unwrap().count(), 0);
    }

    #[test]
    fn local_changes_and_unmanaged_destinations_are_not_overwritten() {
        let vault = tempfile::tempdir().unwrap();
        let s = snapshot();
        let destination = vault
            .path()
            .join(destination(&s.notes[0], "iCloud").unwrap());
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&destination, "mine").unwrap();
        assert!(apply(vault.path(), &s).unwrap_err().contains("unmanaged"));
        fs::remove_file(&destination).unwrap();
        apply(vault.path(), &s).unwrap();
        fs::write(&destination, "mine").unwrap();
        let mut empty = s.clone();
        empty.notes.clear();
        assert!(apply(vault.path(), &empty)
            .unwrap_err()
            .contains("Local changes"));
        assert_eq!(fs::read_to_string(destination).unwrap(), "mine");
    }

    #[test]
    fn concurrent_sync_is_rejected() {
        let vault = tempfile::tempdir().unwrap();
        let lock = acquire(vault.path()).unwrap();
        assert!(acquire(vault.path()).is_err());
        drop(lock);
        assert!(acquire(vault.path()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_boundaries_are_rejected() {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join("applenotes")).unwrap();
        assert!(apply(vault.path(), &snapshot())
            .unwrap_err()
            .contains("symlink"));
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert!(safe(vault.path(), "../escape").is_err());
        assert!(safe(vault.path(), "/absolute").is_err());
    }

    #[test]
    fn duplicate_ids_fail_before_writing() {
        let vault = tempfile::tempdir().unwrap();
        let mut s = snapshot();
        s.notes.push(s.notes[0].clone());
        assert!(apply(vault.path(), &s).is_err());
        assert_eq!(fs::read_dir(vault.path()).unwrap().count(), 0);
    }

    #[test]
    fn interrupted_install_replays_after_rename_without_archiving_new_copy() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        let s = snapshot();
        apply(root, &s).unwrap();
        let ledger = load(root).unwrap();
        let entry = ledger.notes["note-1"].clone();
        // Simulate a recovered missing local copy: install completed, ledger did not.
        let journal = Journal {
            operations: vec![Operation {
                old: None,
                old_hash: None,
                new: Some(entry.path.clone()),
                staged: Some(format!("{CONTROL}/staging/interrupted/note")),
                backup: format!("{CONTROL}/trash/interrupted/note"),
            }],
            ledger,
        };
        atomic_json(root, &format!("{CONTROL}/pending.json"), &journal).unwrap();
        recover(root).unwrap();
        assert!(root.join(&entry.path).exists());
        assert!(!root.join(format!("{CONTROL}/pending.json")).exists());
        assert!(!root
            .join(format!("{CONTROL}/trash/interrupted/note"))
            .exists());
    }

    #[test]
    fn filename_has_creation_utc_stable_identity_and_unicode_slug() {
        let mut s = snapshot();
        s.notes[0].created_at = "2026-09-15T16:30:05+08:00".into();
        s.notes[0].title = "会议记录 / Project Alpha".into();
        let name = note_stem(&s.notes[0]).unwrap();
        assert!(name.starts_with("2026-09-15-083005Z-"));
        assert!(name.ends_with("-会议记录-project-alpha"));
        s.notes[0].title = "Renamed".into();
        let renamed = note_stem(&s.notes[0]).unwrap();
        assert_eq!(
            name.splitn(6, '-').take(5).collect::<Vec<_>>(),
            renamed.splitn(6, '-').take(5).collect::<Vec<_>>()
        );
    }

    #[test]
    fn unavailable_attachment_keeps_same_id_bytes_after_renames() {
        let vault = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        fs::write(staging.path().join("export"), "original asset").unwrap();
        let mut s = snapshot();
        s.notes[0].attachments.push(Attachment {
            id: "asset-id".into(),
            name: "before.png".into(),
            content_id: "cid:asset".into(),
            relative_path: Some("export".into()),
            url: None,
        });
        apply_snapshot(vault.path(), &s, staging.path(), false).unwrap();
        s.notes[0].title = "Renamed note".into();
        s.notes[0].attachments[0].name = "after.png".into();
        s.notes[0].attachments[0].relative_path = None;
        s.warnings.push("attachment export unavailable".into());
        let report = apply_snapshot(vault.path(), &s, staging.path(), false).unwrap();
        assert!(!report.complete);
        assert_eq!(report.moved, 1);
        let entry = &load(vault.path()).unwrap().notes["note-1"];
        let asset = entry
            .files
            .keys()
            .find(|name| name.ends_with(".png"))
            .unwrap();
        assert_eq!(
            fs::read_to_string(vault.path().join(entry_file(entry, asset))).unwrap(),
            "original asset"
        );
    }

    #[test]
    fn untracked_neighbor_survives_deletion() {
        let vault = tempfile::tempdir().unwrap();
        let mut s = snapshot();
        apply(vault.path(), &s).unwrap();
        let entry = &load(vault.path()).unwrap().notes["note-1"];
        let extra = vault.path().join(entry_file(entry, "personal.md"));
        fs::write(&extra, "mine").unwrap();
        s.notes.clear();
        apply(vault.path(), &s).unwrap();
        assert_eq!(fs::read_to_string(extra).unwrap(), "mine");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn folder_case_only_rename_does_not_block_sync() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        let mut s = snapshot();
        apply(root, &s).unwrap();
        let old_path = load(root).unwrap().notes["note-1"].path.clone();
        s.notes[0].folders[0].name = "notes".into();
        let new_path = destination(&s.notes[0], "iCloud").unwrap();
        assert_ne!(old_path, new_path);
        // On the default macOS filesystem these differently spelled paths
        // already identify the same file before the move is planned.
        if root.join(&new_path).exists() {
            assert!(same_file(&root.join(&old_path), &root.join(&new_path)));
        }
        let report = apply(root, &s).unwrap();
        assert!(report.complete);
        assert_eq!(report.moved, 1);
        let entry = &load(root).unwrap().notes["note-1"];
        assert_eq!(entry.path, new_path);
        let doc = fs::read_to_string(root.join(&entry.path)).unwrap();
        assert!(doc.contains("**Hello** world"));
        let yaml = doc.split("---").nth(1).unwrap();
        let metadata: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(metadata["folders"][0].as_str(), Some("notes"));
        assert_eq!(files_at(&root.join("applenotes")).unwrap().len(), 1);
        assert_eq!(apply(root, &s).unwrap().unchanged, 1);
    }

    #[test]
    fn unavailable_and_locally_missing_attachment_uses_placeholder_and_syncs_other_notes() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        let staging = tempfile::tempdir().unwrap();
        fs::write(staging.path().join("asset"), "original attachment").unwrap();
        let mut s = snapshot();
        let mut other = s.notes[0].clone();
        other.id = "note-2".into();
        s.notes.push(other);
        s.notes[0].attachments.push(Attachment {
            id: "asset-id".into(),
            name: "photo.png".into(),
            content_id: "cid:asset".into(),
            relative_path: Some("asset".into()),
            url: None,
        });
        apply_snapshot(root, &s, staging.path(), false).unwrap();
        let ledger = load(root).unwrap();
        let entry = &ledger.notes["note-1"];
        let asset = entry
            .files
            .keys()
            .find(|name| name.ends_with(".png"))
            .unwrap();
        fs::remove_file(root.join(entry_file(entry, asset))).unwrap();
        s.notes[0].attachments[0].relative_path = None;
        s.warnings.push("Notes attachment export failed".into());
        s.notes[1]
            .html
            .push_str("<p>The other note still updates.</p>");
        let report = apply_snapshot(root, &s, staging.path(), false).unwrap();
        assert!(!report.complete);
        assert_eq!(report.updated, 2);
        assert!(!report.warnings.is_empty());
        let ledger = load(root).unwrap();
        let first = &ledger.notes["note-1"];
        let doc = fs::read_to_string(root.join(&first.path)).unwrap();
        assert!(doc.contains("**Hello** world"));
        assert!(doc.contains("photo.png — unavailable through the Apple Notes export interface"));
        assert_eq!(first.files.len(), 1);
        let other = fs::read_to_string(root.join(&ledger.notes["note-2"].path)).unwrap();
        assert!(other.contains("The other note still updates."));
    }

    #[test]
    fn interrupted_after_backup_installs_once_and_cleans_staging_directories() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        let mut s = snapshot();
        apply(root, &s).unwrap();
        let mut ledger = load(root).unwrap();
        let entry = ledger.notes["note-1"].clone();
        let old_bytes = fs::read(root.join(&entry.path)).unwrap();
        s.notes[0].html.push_str("<p>Recovered content.</p>");
        let files = render(&s.notes[0], "iCloud", root, root, Some(&entry)).unwrap();
        let (filename, new_bytes) = files.iter().next().unwrap();
        assert_ne!(&old_bytes, new_bytes);
        ledger.notes.get_mut("note-1").unwrap().files = files
            .iter()
            .map(|(name, bytes)| (name.clone(), hash(bytes)))
            .collect();
        let staged = format!("{CONTROL}/staging/interrupted/note-key/{filename}");
        let backup = format!("{CONTROL}/trash/interrupted/note-key/{filename}");
        fs::create_dir_all(root.join(&staged).parent().unwrap()).unwrap();
        fs::write(root.join(&staged), new_bytes).unwrap();
        let journal = Journal {
            operations: vec![
                Operation {
                    old: Some(entry.path.clone()),
                    old_hash: Some(hash(&old_bytes)),
                    new: None,
                    staged: None,
                    backup: backup.clone(),
                },
                Operation {
                    old: None,
                    old_hash: None,
                    new: Some(entry.path.clone()),
                    staged: Some(staged),
                    backup: backup.clone(),
                },
            ],
            ledger,
        };
        atomic_json(root, &format!("{CONTROL}/pending.json"), &journal).unwrap();
        // The process stopped after archiving the old file but before installing.
        fs::create_dir_all(root.join(&backup).parent().unwrap()).unwrap();
        fs::rename(root.join(&entry.path), root.join(&backup)).unwrap();
        assert!(!root.join(&entry.path).exists());
        recover(root).unwrap();
        assert_eq!(&fs::read(root.join(&entry.path)).unwrap(), new_bytes);
        assert_eq!(fs::read(root.join(&backup)).unwrap(), old_bytes);
        assert_eq!(load(root).unwrap().notes, journal.ledger.notes);
        assert!(!root.join(format!("{CONTROL}/pending.json")).exists());
        assert!(!root.join(format!("{CONTROL}/staging/interrupted")).exists());
        assert_eq!(
            fs::read_dir(root.join(format!("{CONTROL}/staging")))
                .unwrap()
                .count(),
            0
        );
        let installed_mtime = fs::metadata(root.join(&entry.path))
            .unwrap()
            .modified()
            .unwrap();
        let backups = files_at(&root.join(format!("{CONTROL}/trash"))).unwrap();
        recover(root).unwrap();
        assert_eq!(&fs::read(root.join(&entry.path)).unwrap(), new_bytes);
        assert_eq!(
            fs::metadata(root.join(&entry.path))
                .unwrap()
                .modified()
                .unwrap(),
            installed_mtime
        );
        assert_eq!(
            files_at(&root.join(format!("{CONTROL}/trash"))).unwrap(),
            backups
        );
    }
}
