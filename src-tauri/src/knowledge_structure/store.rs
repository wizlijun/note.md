use super::history::{committed, git, git_text, validate_bytes};
use habitat_core::{Snapshot, SNAPSHOT_PATH};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    version: u32,
    repo: String,
    base_commit: Option<String>,
    base_snapshot: Option<String>,
    previous_hash: Option<String>,
    target_hash: String,
    snapshot_id: String,
    temp_name: String,
}

pub(crate) fn check_repo(root: &Path) -> Result<(), String> {
    let canonical = fs::canonicalize(root).map_err(io)?;
    let top = git_text(root, &["rev-parse", "--show-toplevel"])?;
    if fs::canonicalize(top.trim()).map_err(io)? != canonical {
        return Err("KNOWLEDGE_INVALID_ROOT: expected the Vault repository root".into());
    }
    Ok(())
}

fn io(error: std::io::Error) -> String {
    format!("KNOWLEDGE_IO: {error}")
}

/// No symlink component is followed, including a dangling target symlink.
fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("KNOWLEDGE_INVALID_PATH: expected a relative Vault path".into());
    }
    let mut joined = root.to_path_buf();
    for part in path.components() {
        joined.push(part);
        match fs::symlink_metadata(&joined) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("KNOWLEDGE_INVALID_PATH: symlink in snapshot/source path".into())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
    }
    Ok(joined)
}

pub(crate) fn read_current(root: &Path) -> Result<Option<Vec<u8>>, String> {
    let path = safe_path(root, SNAPSHOT_PATH)?;
    match fs::metadata(&path) {
        Ok(meta) if !meta.is_file() => {
            Err("KNOWLEDGE_INVALID_PATH: snapshot is not a regular file".into())
        }
        Ok(meta) if meta.len() > 64 * 1024 * 1024 => {
            Err("KNOWLEDGE_TOO_LARGE: snapshot exceeds read budget".into())
        }
        Ok(_) => fs::read(path).map(Some).map_err(io),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io(e)),
    }
}

fn pending_path(runtime: &Path) -> PathBuf {
    runtime.join("knowledge-structure-pending.json")
}

fn read_pending(root: &Path, runtime: &Path) -> Result<Option<Pending>, String> {
    let path = pending_path(runtime);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(e)),
    };
    let pending: Pending =
        serde_json::from_slice(&bytes).map_err(|e| format!("KNOWLEDGE_INVALID_PENDING: {e}"))?;
    if pending.version != 1
        || pending.repo != fs::canonicalize(root).map_err(io)?.to_string_lossy()
        || !pending.temp_name.starts_with(super::TEMP_PREFIX)
        || !pending.temp_name.ends_with(".tmp")
        || Path::new(&pending.temp_name).components().count() != 1
        || !Path::new(&pending.temp_name)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("KNOWLEDGE_INVALID_PENDING: transaction identity does not match".into());
    }
    Ok(Some(pending))
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path).and_then(|f| f.sync_all()).map_err(io)?;
    Ok(())
}

fn write_pending(runtime: &Path, pending: &Pending) -> Result<(), String> {
    fs::create_dir_all(runtime).map_err(io)?;
    let mut temp = tempfile::NamedTempFile::new_in(runtime).map_err(io)?;
    temp.write_all(&serde_json::to_vec(pending).map_err(|e| e.to_string())?)
        .map_err(io)?;
    temp.as_file().sync_all().map_err(io)?;
    temp.persist(pending_path(runtime))
        .map_err(|e| io(e.error))?;
    sync_directory(runtime)
}

fn snapshot_id(bytes: Option<&[u8]>) -> Result<Option<String>, String> {
    bytes
        .map(validate_bytes)
        .transpose()
        .map(|s| s.map(|s| s.meta.snapshot_id))
}

fn check_git_idle(root: &Path) -> Result<(), String> {
    for name in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ] {
        let raw = git_text(root, &["rev-parse", "--git-path", name])?;
        let path = Path::new(raw.trim());
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        };
        if path.exists() {
            return Err(
                "KNOWLEDGE_GIT_BUSY: finish the current Git operation before saving".into(),
            );
        }
    }
    // New snapshots must remain reachable from a branch, not a disposable HEAD.
    git(root, &["symbolic-ref", "-q", "HEAD"])?;
    Ok(())
}

fn check_size(root: &Path, bytes: &[u8]) -> Result<(), String> {
    let limit = crate::vault_sync::large_files::resolve_threshold_bytes(root);
    if bytes.len() as u64 > limit {
        return Err(format!(
            "KNOWLEDGE_TOO_LARGE: {} bytes exceeds Vault limit {limit}",
            bytes.len()
        ));
    }
    Ok(())
}

fn check_sources(root: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let vault_id = fs::read_to_string(safe_path(root, ".notemd/vault-id")?).map_err(io)?;
    if vault_id.trim() != snapshot.meta.vault_id {
        return Err("KNOWLEDGE_VAULT_CHANGED: snapshot belongs to another Vault".into());
    }
    for source in &snapshot.sources {
        if source.path == SNAPSHOT_PATH || source.path.starts_with(".notemd/habitat/") {
            return Err("KNOWLEDGE_INVALID_SOURCE: snapshot cannot ingest its own output".into());
        }
        let path = safe_path(root, &source.path)?;
        if matches!(
            source.status.as_str(),
            "unavailable" | "missing" | "excluded"
        ) {
            continue;
        }
        if source.hash.is_empty() {
            return Err("KNOWLEDGE_INVALID_SOURCE: available source is missing its hash".into());
        }
        let mut file = File::open(path)
            .map_err(|_| format!("KNOWLEDGE_SOURCE_CHANGED: {} is unavailable", source.path))?;
        let mut digest = sha2::Sha256::default();
        use sha2::Digest;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(io)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        let actual = format!("{:x}", digest.finalize());
        if actual != source.hash.strip_prefix("sha256:").unwrap_or(&source.hash) {
            return Err(format!(
                "KNOWLEDGE_SOURCE_CHANGED: {} changed since capture",
                source.path
            ));
        }
    }
    Ok(())
}

fn check_base(expected: Option<&str>, saved: Option<&[u8]>) -> Result<(), String> {
    if snapshot_id(saved)?.as_deref() != expected {
        return Err("KNOWLEDGE_BASE_CHANGED: reload the current snapshot before saving".into());
    }
    Ok(())
}

fn result(status: &str, commit: Option<&str>, snapshot: &Snapshot) -> Value {
    json!({"status": status, "commit": commit, "snapshotId": snapshot.meta.snapshot_id})
}

/// Runtime is an app-owned persistent directory partitioned by Vault identity.
pub fn load(root: &Path, runtime: &Path) -> Result<Value, String> {
    check_repo(root)?;
    let writer = crate::memory_control::v2::RepositoryWriter::new(root);
    let _transaction = writer.begin().map_err(|e| e.to_string())?;
    let (commit, saved) = committed(root)?;
    let current = read_current(root)?;
    let pending = read_pending(root, runtime)?;
    let snapshot = saved.as_deref().map(validate_bytes).transpose()?;
    let modified = current != saved;
    let controlled = pending.as_ref().is_some_and(|p| {
        current
            .as_deref()
            .is_some_and(|bytes| habitat_core::hash(bytes) == p.target_hash)
    });
    Ok(
        json!({"snapshot": snapshot, "commit": commit, "pending": pending.is_some(),
        "externalChange": modified && !controlled, "workingTreeModified": modified}),
    )
}

pub fn save(
    root: &Path,
    runtime: &Path,
    expected_base: Option<&str>,
    bytes: &[u8],
) -> Result<Value, String> {
    save_with_guard(root, runtime, expected_base, bytes, &|_| Ok(()))
}

/// Host authorization/configuration is checked again inside the locked save,
/// after source IO and immediately before publication/commit.
pub fn save_with_guard(
    root: &Path,
    runtime: &Path,
    expected_base: Option<&str>,
    bytes: &[u8],
    authorize: &dyn Fn(&Snapshot) -> Result<(), String>,
) -> Result<Value, String> {
    check_repo(root)?;
    check_size(root, bytes)?;
    let snapshot = validate_bytes(bytes)?;
    let canonical = habitat_core::encode(&snapshot)?;
    check_size(root, &canonical)?;
    let writer = crate::memory_control::v2::RepositoryWriter::new(root);
    let _transaction = writer.begin().map_err(|e| e.to_string())?;
    check_git_idle(root)?;
    if read_pending(root, runtime)?.is_some() {
        return Err("KNOWLEDGE_STRUCTURE_PENDING: recover the previous save before generating another version".into());
    }
    let (base_commit, saved) = committed(root)?;
    check_base(expected_base, saved.as_deref())?;
    let current = read_current(root)?;
    if current != saved {
        return Err(
            "KNOWLEDGE_EXTERNAL_CHANGE: preserve and resolve the existing structure edit".into(),
        );
    }
    super::history::guard_before_sync_commit(root)?;
    check_size(root, &canonical)?;
    check_sources(root, &snapshot)?;
    authorize(&snapshot)?;
    if let Some(saved) = saved.as_deref() {
        let previous = validate_bytes(saved)?;
        if previous.meta.state_hash == snapshot.meta.state_hash {
            return Ok(result("unchanged", base_commit.as_deref(), &previous));
        }
    }
    let expected_parents: Vec<String> = expected_base.into_iter().map(str::to_owned).collect();
    if snapshot.meta.parents != expected_parents {
        return Err(
            "KNOWLEDGE_BASE_CHANGED: snapshot parents do not match the committed base".into(),
        );
    }
    let target = safe_path(root, SNAPSHOT_PATH)?;
    let parent = target.parent().ok_or("KNOWLEDGE_INVALID_PATH")?;
    fs::create_dir_all(parent).map_err(io)?;
    // Check ignoring before creating an untracked output. Never force-add it.
    let ignored = crate::platform::command("git")
        .args(["check-ignore", "--no-index", "-q", "--", SNAPSHOT_PATH])
        .current_dir(root)
        .status()
        .map_err(io)?;
    if ignored.success() {
        return Err("KNOWLEDGE_IGNORED: structure path is excluded from Git".into());
    }
    if ignored.code() != Some(1) {
        return Err("KNOWLEDGE_GIT: cannot verify ignore rules".into());
    }
    let mut temp = tempfile::Builder::new()
        .prefix(super::TEMP_PREFIX)
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(io)?;
    temp.write_all(&canonical).map_err(io)?;
    temp.as_file().sync_all().map_err(io)?;
    let temp_path = temp.into_temp_path().keep().map_err(|e| io(e.error))?;
    let pending = Pending {
        version: 1,
        repo: fs::canonicalize(root)
            .map_err(io)?
            .to_string_lossy()
            .into_owned(),
        base_commit,
        base_snapshot: expected_base.map(str::to_owned),
        previous_hash: saved.as_deref().map(habitat_core::hash),
        target_hash: habitat_core::hash(&canonical),
        snapshot_id: snapshot.meta.snapshot_id.clone(),
        temp_name: temp_path
            .file_name()
            .ok_or("KNOWLEDGE_INVALID_PATH")?
            .to_string_lossy()
            .into_owned(),
    };
    write_pending(runtime, &pending)?;
    authorize(&snapshot)?;
    fs::rename(&temp_path, &target).map_err(io)?;
    sync_directory(parent)?;
    finish_save(root, runtime, &pending, &canonical, authorize)
}

fn finish_save(
    root: &Path,
    runtime: &Path,
    pending: &Pending,
    bytes: &[u8],
    authorize: &dyn Fn(&Snapshot) -> Result<(), String>,
) -> Result<Value, String> {
    let snapshot = validate_bytes(bytes)?;
    if habitat_core::hash(bytes) != pending.target_hash
        || snapshot.meta.snapshot_id != pending.snapshot_id
    {
        return Err(
            "KNOWLEDGE_INVALID_PENDING: snapshot does not match the save transaction".into(),
        );
    }
    check_size(root, bytes)?;
    check_sources(root, &snapshot)?;
    let (head, saved) = committed(root)?;
    if saved
        .as_deref()
        .is_some_and(|b| habitat_core::hash(b) == pending.target_hash)
    {
        authorize(&snapshot)?;
        clear_pending(root, runtime, pending)?;
        return Ok(result("saved", head.as_deref(), &snapshot));
    }
    if head != pending.base_commit || snapshot_id(saved.as_deref())? != pending.base_snapshot {
        return Err(
            "KNOWLEDGE_BASE_CHANGED: repository changed during the save transaction".into(),
        );
    }
    if read_current(root)?.as_deref() != Some(bytes) {
        return Err("KNOWLEDGE_EXTERNAL_CHANGE: snapshot changed before commit".into());
    }
    authorize(&snapshot)?;
    git(root, &["add", "-N", "--", SNAPSHOT_PATH])?;
    git(
        root,
        &[
            "commit",
            "--only",
            "-m",
            "habitat: save knowledge structure",
            "--",
            SNAPSHOT_PATH,
        ],
    )?;
    let (commit, committed_bytes) = committed(root)?;
    let committed_bytes =
        committed_bytes.ok_or("KNOWLEDGE_COMMIT_FAILED: missing committed snapshot")?;
    if habitat_core::hash(&committed_bytes) != pending.target_hash {
        return Err(
            "KNOWLEDGE_COMMIT_FAILED: Git filters or concurrent edits changed the snapshot".into(),
        );
    }
    validate_bytes(&committed_bytes)?;
    clear_pending(root, runtime, pending)?;
    Ok(result("saved", commit.as_deref(), &snapshot))
}

fn clear_pending(root: &Path, runtime: &Path, pending: &Pending) -> Result<(), String> {
    let temp = safe_path(root, &format!(".notemd/habitat/{}", pending.temp_name))?;
    match fs::remove_file(temp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io(e)),
    }
    fs::remove_file(pending_path(runtime)).map_err(io)?;
    sync_directory(runtime)
}

pub fn recover(root: &Path, runtime: &Path) -> Result<Value, String> {
    recover_with_guard(root, runtime, &|_| Ok(()))
}

pub fn recover_with_guard(
    root: &Path,
    runtime: &Path,
    authorize: &dyn Fn(&Snapshot) -> Result<(), String>,
) -> Result<Value, String> {
    check_repo(root)?;
    let writer = crate::memory_control::v2::RepositoryWriter::new(root);
    let _transaction = writer.begin().map_err(|e| e.to_string())?;
    check_git_idle(root)?;
    let pending = read_pending(root, runtime)?
        .ok_or("KNOWLEDGE_NO_PENDING: no controlled save to recover")?;
    let current = read_current(root)?;
    let (_, saved) = committed(root)?;
    if saved
        .as_deref()
        .is_some_and(|b| habitat_core::hash(b) == pending.target_hash)
    {
        if current != saved {
            return Err(
                "KNOWLEDGE_EXTERNAL_CHANGE: committed save has a newer working edit".into(),
            );
        }
        let snapshot = validate_bytes(saved.as_deref().unwrap())?;
        authorize(&snapshot)?;
        let commit = super::history::head(root)?;
        clear_pending(root, runtime, &pending)?;
        return Ok(result("saved", commit.as_deref(), &snapshot));
    }
    if current
        .as_deref()
        .is_some_and(|b| habitat_core::hash(b) == pending.target_hash)
    {
        return finish_save(
            root,
            runtime,
            &pending,
            current.as_deref().unwrap(),
            authorize,
        );
    }
    if current.as_deref().map(habitat_core::hash) != pending.previous_hash {
        return Err("KNOWLEDGE_EXTERNAL_CHANGE: pending save does not own the working file".into());
    }
    let temp_path = safe_path(root, &format!(".notemd/habitat/{}", pending.temp_name))?;
    let bytes = fs::read(&temp_path).map_err(io)?;
    if habitat_core::hash(&bytes) != pending.target_hash {
        return Err("KNOWLEDGE_INVALID_PENDING: interrupted temporary output is damaged".into());
    }
    let snapshot = validate_bytes(&bytes)?;
    check_base(pending.base_snapshot.as_deref(), saved.as_deref())?;
    if super::history::head(root)? != pending.base_commit {
        return Err("KNOWLEDGE_BASE_CHANGED".into());
    }
    check_size(root, &bytes)?;
    check_sources(root, &snapshot)?;
    authorize(&snapshot)?;
    let target = safe_path(root, SNAPSHOT_PATH)?;
    fs::rename(&temp_path, &target).map_err(io)?;
    sync_directory(target.parent().unwrap())?;
    finish_save(root, runtime, &pending, &bytes, authorize)
}

/// Keep the captured draft before restoring the committed projection. This
/// only handles a recognized transaction; unknown working/staged edits survive.
pub fn discard_pending(root: &Path, runtime: &Path) -> Result<Value, String> {
    check_repo(root)?;
    let writer = crate::memory_control::v2::RepositoryWriter::new(root);
    let _transaction = writer.begin().map_err(|e| e.to_string())?;
    check_git_idle(root)?;
    let pending = read_pending(root, runtime)?.ok_or("KNOWLEDGE_NO_PENDING")?;
    let current = read_current(root)?;
    let (commit, saved) = committed(root)?;
    if saved
        .as_deref()
        .is_some_and(|b| habitat_core::hash(b) == pending.target_hash)
    {
        if current != saved {
            return Err("KNOWLEDGE_EXTERNAL_CHANGE: committed save has a newer edit".into());
        }
        let snapshot = validate_bytes(saved.as_deref().unwrap())?;
        clear_pending(root, runtime, &pending)?;
        return Ok(result("already-saved", commit.as_deref(), &snapshot));
    }
    check_base(pending.base_snapshot.as_deref(), saved.as_deref())?;
    let current_hash = current.as_deref().map(habitat_core::hash);
    if current_hash.as_deref() != Some(pending.target_hash.as_str())
        && current_hash != pending.previous_hash
    {
        return Err("KNOWLEDGE_EXTERNAL_CHANGE: discard does not own the working edit".into());
    }
    let archive_dir = runtime.join("abandoned-knowledge-drafts");
    let archive = archive_dir.join(format!("{}.jsonl.zst", pending.snapshot_id));
    // The ID also becomes a local filename; never trust an unvalidated journal.
    if pending.snapshot_id.len() != 64
        || !pending.snapshot_id.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("KNOWLEDGE_INVALID_PENDING: invalid snapshot ID".into());
    }
    let temp_path = safe_path(root, &format!(".notemd/habitat/{}", pending.temp_name))?;
    let bytes = if current_hash.as_deref() == Some(pending.target_hash.as_str()) {
        current.as_deref().unwrap().to_vec()
    } else if temp_path.exists() {
        fs::read(&temp_path).map_err(io)?
    } else {
        // Resume after a crash between restoration and clearing the journal.
        fs::read(&archive).map_err(io)?
    };
    let snapshot = validate_bytes(&bytes)?;
    if habitat_core::hash(&bytes) != pending.target_hash
        || snapshot.meta.snapshot_id != pending.snapshot_id
    {
        return Err("KNOWLEDGE_INVALID_PENDING: draft differs from transaction".into());
    }
    let indexed = git(root, &["show", &format!(":{SNAPSHOT_PATH}")]).ok();
    if let Some(indexed) = indexed.as_deref() {
        if !indexed.is_empty() && Some(indexed) != saved.as_deref() && indexed != bytes {
            return Err("KNOWLEDGE_EXTERNAL_CHANGE: discard does not own the staged edit".into());
        }
    }
    fs::create_dir_all(&archive_dir).map_err(io)?;
    if archive.exists() {
        if fs::read(&archive).map_err(io)? != bytes {
            return Err(
                "KNOWLEDGE_INVALID_PENDING: an existing draft archive has different bytes".into(),
            );
        }
    } else {
        let mut temp = tempfile::NamedTempFile::new_in(&archive_dir).map_err(io)?;
        temp.write_all(&bytes).map_err(io)?;
        temp.as_file().sync_all().map_err(io)?;
        temp.persist_noclobber(&archive).map_err(|e| io(e.error))?;
        sync_directory(&archive_dir)?;
    }
    let target = safe_path(root, SNAPSHOT_PATH)?;
    let parent = target.parent().unwrap();
    if let Some(saved) = saved.as_deref() {
        let mut temp = tempfile::Builder::new()
            .prefix(super::TEMP_PREFIX)
            .suffix(".tmp")
            .tempfile_in(parent)
            .map_err(io)?;
        temp.write_all(saved).map_err(io)?;
        temp.as_file().sync_all().map_err(io)?;
        temp.persist(&target).map_err(|e| io(e.error))?;
    } else if target.exists() {
        fs::remove_file(&target).map_err(io)?;
    }
    sync_directory(parent)?;
    if commit.is_some() {
        git(root, &["reset", "-q", "HEAD", "--", SNAPSHOT_PATH])?;
    } else {
        git(
            root,
            &["rm", "--cached", "--ignore-unmatch", "--", SNAPSHOT_PATH],
        )?;
    }
    clear_pending(root, runtime, &pending)?;
    Ok(
        json!({"status":"archived", "snapshotId":pending.snapshot_id, "archivePath":archive,
        "restoredSnapshotId":pending.base_snapshot, "commit":commit}),
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use habitat_core::{Node, Source};

    pub(crate) fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]).unwrap();
        git(&root, &["config", "user.name", "Test"]).unwrap();
        git(&root, &["config", "user.email", "test@example.invalid"]).unwrap();
        git(&root, &["config", "core.autocrlf", "false"]).unwrap();
        git(&root, &["config", "commit.gpgsign", "false"]).unwrap();
        fs::create_dir(root.join(".notemd")).unwrap();
        fs::write(root.join(".notemd/vault-id"), "test\n").unwrap();
        fs::write(root.join("note.md"), "original\n").unwrap();
        git(&root, &["add", "--", "note.md", ".notemd/vault-id"]).unwrap();
        git(&root, &["commit", "-q", "-m", "baseline"]).unwrap();
        (dir, root)
    }

    pub(crate) fn snapshot(label: &str, previous: Option<&Snapshot>) -> Snapshot {
        let mut s = Snapshot::default();
        s.meta.vault_id = "test".into();
        s.meta.scope_hash = habitat_core::hash("scope");
        s.meta.algorithm.version = "test/1".into();
        s.meta.generated_at = "2026-09-30T00:00:00Z".into();
        s.nodes.push(Node {
            id: "c:one".into(),
            key: "one".into(),
            node_type: "concept".into(),
            label: label.into(),
            status: "candidate".into(),
            ..Default::default()
        });
        habitat_core::finalize(&mut s, previous).unwrap();
        s
    }

    #[test]
    fn old_contract_history_survives_focus_schema_migration_and_window_updates() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        fs::write(root.join(".notemd/vault-id"), "contract-vault\n").unwrap();
        let v1 = include_bytes!("../../../habitat-core/tests/fixtures/contract/schema1.jsonl.zst");
        let old = habitat_core::decode(v1).unwrap();
        let first = save(&root, &runtime, None, v1).unwrap();
        let mut next = old.clone();
        next.meta.focus = Some(habitat_core::FocusContext {
            as_of: "2026-10-02".into(),
            window_days: 30,
            utc_offset_minutes: 480,
        });
        habitat_core::finalize(&mut next, Some(&old)).unwrap();
        assert_eq!(next.meta.schema, habitat_core::SCHEMA);
        let second = save(
            &root,
            &runtime,
            Some(&old.meta.snapshot_id),
            &habitat_core::encode(&next).unwrap(),
        )
        .unwrap();
        let mut later = next.clone();
        later.meta.focus.as_mut().unwrap().as_of = "2026-10-03".into();
        habitat_core::finalize(&mut later, Some(&next)).unwrap();
        assert_eq!(later.meta.change_cause, "attention_window");
        save(
            &root,
            &runtime,
            Some(&next.meta.snapshot_id),
            &habitat_core::encode(&later).unwrap(),
        )
        .unwrap();
        let history = super::super::history::history(&root, 20).unwrap();
        assert_eq!(history["versions"].as_array().unwrap().len(), 3);
        assert_eq!(history["versions"][0]["focus"]["asOf"], "2026-10-03");
        assert_eq!(history["versions"][0]["schema"], habitat_core::SCHEMA);
        let original_bytes = super::super::history::blob(&root, first["commit"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(original_bytes, v1);
        let original =
            super::super::history::read_at(&root, first["commit"].as_str().unwrap()).unwrap();
        assert_eq!(
            original["snapshot"]["meta"]["schema"],
            habitat_core::SCHEMA_V1
        );
        assert_ne!(first["commit"], second["commit"]);
    }

    #[test]
    fn saves_three_versions_without_committing_other_staged_files_and_noop_keeps_head() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        fs::write(root.join("unrelated.md"), "staged user change").unwrap();
        git(&root, &["add", "--", "unrelated.md"]).unwrap();
        let first = snapshot("first", None);
        let saved = save(
            &root,
            &runtime,
            None,
            &habitat_core::encode(&first).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["status"], "saved");
        assert_eq!(
            git_text(&root, &["diff", "--cached", "--name-only"])
                .unwrap()
                .trim(),
            "unrelated.md"
        );
        assert_eq!(
            git_text(
                &root,
                &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]
            )
            .unwrap()
            .trim(),
            SNAPSHOT_PATH
        );
        let head_before = super::super::history::head(&root).unwrap();
        assert_eq!(
            save(
                &root,
                &runtime,
                Some(&first.meta.snapshot_id),
                &habitat_core::encode(&first).unwrap()
            )
            .unwrap()["status"],
            "unchanged"
        );
        assert_eq!(head_before, super::super::history::head(&root).unwrap());
        let second = snapshot("second", Some(&first));
        save(
            &root,
            &runtime,
            Some(&first.meta.snapshot_id),
            &habitat_core::encode(&second).unwrap(),
        )
        .unwrap();
        let third = snapshot("third", Some(&second));
        save(
            &root,
            &runtime,
            Some(&second.meta.snapshot_id),
            &habitat_core::encode(&third).unwrap(),
        )
        .unwrap();
        let history = super::super::history::history(&root, 20).unwrap();
        assert_eq!(history["versions"].as_array().unwrap().len(), 3);
        for v in history["versions"].as_array().unwrap() {
            let read =
                super::super::history::read_at(&root, v["commit"].as_str().unwrap()).unwrap();
            assert_eq!(read["snapshot"]["meta"]["snapshotId"], v["snapshotId"]);
        }
        assert_eq!(load(&root, &runtime).unwrap()["pending"], false);
    }

    #[test]
    fn rejects_changed_source_and_wrong_base_before_replacing_file() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let mut first = snapshot("first", None);
        first.sources.push(Source {
            id: "s:one".into(),
            path: "note.md".into(),
            hash: habitat_core::hash("original\n"),
            family: "f:one".into(),
            status: "available".into(),
            ..Default::default()
        });
        habitat_core::finalize(&mut first, None).unwrap();
        fs::write(root.join("note.md"), "new source\n").unwrap();
        let error = save(
            &root,
            &runtime,
            None,
            &habitat_core::encode(&first).unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("SOURCE_CHANGED"), "{error}");
        assert!(!root.join(SNAPSHOT_PATH).exists());
        let clean = snapshot("clean", None);
        let error = save(
            &root,
            &runtime,
            Some("wrong"),
            &habitat_core::encode(&clean).unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("BASE_CHANGED"));
    }

    #[test]
    fn failed_commit_is_recoverable_and_next_generation_cannot_overwrite_pending() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let first = snapshot("first", None);
        // A non-existent signing tool deterministically fails commit after rename.
        git(&root, &["config", "commit.gpgsign", "true"]).unwrap();
        git(
            &root,
            &["config", "gpg.program", "/nonexistent/habitat-test-gpg"],
        )
        .unwrap();
        assert!(save(
            &root,
            &runtime,
            None,
            &habitat_core::encode(&first).unwrap()
        )
        .is_err());
        assert!(pending_path(&runtime).exists());
        assert_eq!(load(&root, &runtime).unwrap()["pending"], true);
        let second = snapshot("second", None);
        assert!(save(
            &root,
            &runtime,
            None,
            &habitat_core::encode(&second).unwrap()
        )
        .unwrap_err()
        .contains("PENDING"));
        assert!(super::super::history::guard_before_sync_commit(&root)
            .unwrap_err()
            .contains("PENDING"));
        git(&root, &["config", "commit.gpgsign", "false"]).unwrap();
        let recovered = recover(&root, &runtime).unwrap();
        assert_eq!(recovered["snapshotId"], first.meta.snapshot_id);
        assert!(!pending_path(&runtime).exists());
    }

    #[test]
    fn committed_but_unacknowledged_transaction_recovers_without_another_commit() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let first = snapshot("first", None);
        git(&root, &["config", "commit.gpgsign", "true"]).unwrap();
        git(
            &root,
            &["config", "gpg.program", "/nonexistent/habitat-test-gpg"],
        )
        .unwrap();
        assert!(save(
            &root,
            &runtime,
            None,
            &habitat_core::encode(&first).unwrap()
        )
        .is_err());
        git(&root, &["config", "commit.gpgsign", "false"]).unwrap();
        git(
            &root,
            &[
                "commit",
                "--only",
                "-m",
                "commit before crash",
                "--",
                SNAPSHOT_PATH,
            ],
        )
        .unwrap();
        let head_before = super::super::history::head(&root).unwrap();
        recover(&root, &runtime).unwrap();
        assert_eq!(head_before, super::super::history::head(&root).unwrap());
    }

    #[test]
    fn prepared_temporary_recovers_after_interruption_before_rename() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let first = snapshot("prepared", None);
        let bytes = habitat_core::encode(&first).unwrap();
        git(&root, &["config", "commit.gpgsign", "true"]).unwrap();
        git(
            &root,
            &["config", "gpg.program", "/nonexistent/habitat-test-gpg"],
        )
        .unwrap();
        assert!(save(&root, &runtime, None, &bytes).is_err());
        let pending = read_pending(&root, &runtime).unwrap().unwrap();
        fs::write(
            root.join(".notemd/habitat").join(&pending.temp_name),
            &bytes,
        )
        .unwrap();
        fs::remove_file(root.join(SNAPSHOT_PATH)).unwrap();
        git(&root, &["config", "commit.gpgsign", "false"]).unwrap();
        recover(&root, &runtime).unwrap();
        assert_eq!(fs::read(root.join(SNAPSHOT_PATH)).unwrap(), bytes);
        assert!(!pending_path(&runtime).exists());
    }

    #[test]
    fn save_waits_for_the_same_repository_lock_used_by_vault_sync() {
        use std::sync::mpsc;
        use std::time::Duration;
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let writer = crate::memory_control::v2::RepositoryWriter::new(&root);
        let transaction = writer.begin().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let save_root = root.clone();
        let worker = std::thread::spawn(move || {
            let bytes = habitat_core::encode(&snapshot("concurrent", None)).unwrap();
            started_tx.send(()).unwrap();
            done_tx
                .send(save(&save_root, &runtime, None, &bytes))
                .unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(!root.join(SNAPSHOT_PATH).exists());
        drop(transaction);
        assert_eq!(
            done_rx
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap()["status"],
            "saved"
        );
        worker.join().unwrap();
    }

    #[test]
    fn discard_archives_owned_pending_and_allows_fresh_generation() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let first = snapshot("first", None);
        save(
            &root,
            &runtime,
            None,
            &habitat_core::encode(&first).unwrap(),
        )
        .unwrap();
        let second = snapshot("pending second", Some(&first));
        let bytes = habitat_core::encode(&second).unwrap();
        git(&root, &["config", "commit.gpgsign", "true"]).unwrap();
        git(
            &root,
            &["config", "gpg.program", "/nonexistent/habitat-test-gpg"],
        )
        .unwrap();
        assert!(save(&root, &runtime, Some(&first.meta.snapshot_id), &bytes).is_err());
        let archived = discard_pending(&root, &runtime).unwrap();
        assert_eq!(archived["status"], "archived");
        assert_eq!(
            fs::read(archived["archivePath"].as_str().unwrap()).unwrap(),
            bytes
        );
        assert_eq!(
            validate_bytes(&fs::read(root.join(SNAPSHOT_PATH)).unwrap()).unwrap(),
            first
        );
        assert!(!pending_path(&runtime).exists());
        git(&root, &["config", "commit.gpgsign", "false"]).unwrap();
        let next = snapshot("fresh", Some(&first));
        save(
            &root,
            &runtime,
            Some(&first.meta.snapshot_id),
            &habitat_core::encode(&next).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn discard_never_overwrites_an_external_edit() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        git(&root, &["config", "commit.gpgsign", "true"]).unwrap();
        git(
            &root,
            &["config", "gpg.program", "/nonexistent/habitat-test-gpg"],
        )
        .unwrap();
        assert!(save(
            &root,
            &runtime,
            None,
            &habitat_core::encode(&snapshot("pending", None)).unwrap()
        )
        .is_err());
        fs::write(root.join(SNAPSHOT_PATH), "external edit").unwrap();
        assert!(discard_pending(&root, &runtime)
            .unwrap_err()
            .contains("EXTERNAL_CHANGE"));
        assert_eq!(
            fs::read_to_string(root.join(SNAPSHOT_PATH)).unwrap(),
            "external edit"
        );
        assert!(pending_path(&runtime).exists());
    }

    #[test]
    fn unknown_or_truncated_working_edits_are_preserved() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        fs::create_dir_all(root.join(".notemd/habitat")).unwrap();
        let bad = b"{\"kind\":\"meta\"";
        fs::write(root.join(SNAPSHOT_PATH), bad).unwrap();
        let first = snapshot("first", None);
        assert!(save(
            &root,
            &runtime,
            None,
            &habitat_core::encode(&first).unwrap()
        )
        .unwrap_err()
        .contains("EXTERNAL_CHANGE"));
        assert!(recover(&root, &runtime).unwrap_err().contains("NO_PENDING"));
        assert_eq!(fs::read(root.join(SNAPSHOT_PATH)).unwrap(), bad);
        assert_eq!(load(&root, &runtime).unwrap()["externalChange"], true);
    }

    #[test]
    fn actual_configured_threshold_is_enforced_including_exact_boundary() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        fs::write(
            root.join(".notemd/settings.json"),
            r#"{"largeFileThresholdMb":1}"#,
        )
        .unwrap();
        let limit = 1024 * 1024;
        assert!(check_size(&root, &vec![0; limit]).is_ok());
        assert!(check_size(&root, &vec![0; limit + 1])
            .unwrap_err()
            .contains("TOO_LARGE"));
        let at_limit = snapshot("a", None);
        let bytes = habitat_core::encode(&at_limit).unwrap();
        save(&root, &runtime, None, &bytes).unwrap();
        // Hash material is deliberately incompressible enough to exceed 1 MiB.
        let mut over = snapshot("over", Some(&at_limit));
        over.nodes[0].label = (0..50_000)
            .map(|n| habitat_core::hash(n.to_string()))
            .collect();
        habitat_core::finalize(&mut over, Some(&at_limit)).unwrap();
        let too_big = habitat_core::encode(&over).unwrap();
        assert!(too_big.len() > limit);
        assert!(
            save(&root, &runtime, Some(&at_limit.meta.snapshot_id), &too_big)
                .unwrap_err()
                .contains("TOO_LARGE")
        );
        assert_eq!(fs::read(root.join(SNAPSHOT_PATH)).unwrap(), bytes);
    }

    #[test]
    fn host_guard_failure_before_publication_keeps_draft_and_head() {
        use std::cell::Cell;
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let before = super::super::history::head(&root).unwrap();
        let bytes = habitat_core::encode(&snapshot("draft", None)).unwrap();
        let calls = Cell::new(0);
        let guard = |_: &Snapshot| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                Err("CAPTURE_CHANGED".into())
            } else {
                Ok(())
            }
        };
        assert_eq!(
            save_with_guard(&root, &runtime, None, &bytes, &guard).unwrap_err(),
            "CAPTURE_CHANGED"
        );
        assert_eq!(super::super::history::head(&root).unwrap(), before);
        assert!(!root.join(SNAPSHOT_PATH).exists());
        assert_eq!(load(&root, &runtime).unwrap()["pending"], true);
        let archived = discard_pending(&root, &runtime).unwrap();
        assert_eq!(
            fs::read(archived["archivePath"].as_str().unwrap()).unwrap(),
            bytes
        );
        assert!(!root.join(SNAPSHOT_PATH).exists());
    }

    #[test]
    fn host_guard_failure_before_commit_remains_controlled_and_recoverable() {
        use std::cell::Cell;
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let before = super::super::history::head(&root).unwrap();
        let bytes = habitat_core::encode(&snapshot("draft", None)).unwrap();
        let calls = Cell::new(0);
        let guard = |_: &Snapshot| {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                Err("CAPTURE_CHANGED".into())
            } else {
                Ok(())
            }
        };
        assert_eq!(
            save_with_guard(&root, &runtime, None, &bytes, &guard).unwrap_err(),
            "CAPTURE_CHANGED"
        );
        assert_eq!(super::super::history::head(&root).unwrap(), before);
        assert_eq!(fs::read(root.join(SNAPSHOT_PATH)).unwrap(), bytes);
        assert_eq!(load(&root, &runtime).unwrap()["pending"], true);
        assert!(recover_with_guard(&root, &runtime, &|_| Err("REVOKED".into())).is_err());
        assert_eq!(super::super::history::head(&root).unwrap(), before);
        assert_eq!(
            recover_with_guard(&root, &runtime, &|_| Ok(())).unwrap()["status"],
            "saved"
        );
        assert_eq!(load(&root, &runtime).unwrap()["pending"], false);
    }

    #[test]
    fn empty_history_and_invalid_encoding_have_explicit_results() {
        let (dir, root) = fixture();
        assert_eq!(
            super::super::history::history(&root, 20).unwrap()["versions"],
            json!([])
        );
        let runtime = dir.path().join("runtime");
        let bytes = habitat_core::codec::encode_jsonl(&snapshot("a", None)).unwrap();
        let invalid = String::from_utf8(bytes)
            .unwrap()
            .replace(habitat_core::SCHEMA, "vault-knowledge-structure/999");
        assert!(save(&root, &runtime, None, invalid.as_bytes())
            .unwrap_err()
            .contains("INVALID_SNAPSHOT"));
        assert!(!root.join(SNAPSHOT_PATH).exists());
    }

    #[cfg(unix)]
    #[test]
    fn source_and_target_symlinks_do_not_escape_the_vault() {
        use std::os::unix::fs::symlink;
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let outside = dir.path().join("outside");
        fs::write(&outside, "original\n").unwrap();
        fs::remove_file(root.join("note.md")).unwrap();
        symlink(&outside, root.join("note.md")).unwrap();
        let mut s = snapshot("a", None);
        s.sources.push(Source {
            id: "s:one".into(),
            path: "note.md".into(),
            hash: habitat_core::hash("original\n"),
            family: "f:one".into(),
            status: "available".into(),
            ..Default::default()
        });
        habitat_core::finalize(&mut s, None).unwrap();
        assert!(
            save(&root, &runtime, None, &habitat_core::encode(&s).unwrap())
                .unwrap_err()
                .contains("INVALID_PATH")
        );
        assert_eq!(fs::read_to_string(&outside).unwrap(), "original\n");
    }
}
