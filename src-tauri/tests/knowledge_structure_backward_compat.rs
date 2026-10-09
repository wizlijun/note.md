//! Contract with the fixed snapshot path read by the released 6.930.3 host.
//! Habitat may evolve its own snapshot, but that path must remain readable by
//! the old Git sync guard (or be absent).

use habitat_core::{FocusContext, Snapshot, SCHEMA, SCHEMA_V1, SNAPSHOT_PATH};
use notemd_lib::{knowledge_structure, vault_sync::git_ops};
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const LEGACY_PATH: &str = ".notemd/habitat/knowledge-structure.jsonl.zst";
const RELEASED_V1: &[u8] =
    include_bytes!("../../habitat-core/tests/fixtures/contract/schema1.jsonl.zst");

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleasedMeta {
    schema: String,
    snapshot_id: String,
    state_hash: String,
    parents: Vec<String>,
    generated_at: String,
    vault_id: String,
    algorithm: serde_json::Value,
    scope_hash: String,
    manifest_hash: String,
    structure_hash: String,
    evidence_hash: String,
    layout_hash: String,
    coverage: serde_json::Value,
    change_cause: String,
}

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn head_blob(root: &Path, path: &str) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .args(["show", &format!("HEAD:{path}")])
        .current_dir(root)
        .output()
        .unwrap();
    output.status.success().then_some(output.stdout)
}

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.invalid"]);
    git(&root, &["config", "core.autocrlf", "false"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    fs::create_dir(root.join(".notemd")).unwrap();
    fs::write(root.join(".notemd/vault-id"), "contract-vault\n").unwrap();
    fs::write(root.join("note.md"), "original\n").unwrap();
    git(&root, &["add", "--", ".notemd/vault-id", "note.md"]);
    git(&root, &["commit", "-q", "-m", "baseline"]);
    (dir, root)
}

fn v2_snapshot(previous: Option<&Snapshot>) -> Snapshot {
    let mut snapshot = Snapshot::default();
    snapshot.meta.vault_id = "contract-vault".into();
    snapshot.meta.scope_hash = habitat_core::hash("scope");
    snapshot.meta.algorithm.version = "habitat-focus/7".into();
    snapshot.meta.generated_at = "2026-10-08T00:00:00Z".into();
    snapshot.meta.focus = Some(FocusContext {
        as_of: "2026-10-08".into(),
        window_days: 30,
        utc_offset_minutes: 480,
    });
    habitat_core::finalize(&mut snapshot, previous).unwrap();
    assert_eq!(snapshot.meta.schema, SCHEMA);
    snapshot
}

fn changed_v2_snapshot(previous: &Snapshot, variant: &str) -> Snapshot {
    let mut snapshot = v2_snapshot(Some(previous));
    snapshot.meta.algorithm.version = variant.into();
    habitat_core::finalize(&mut snapshot, Some(previous)).unwrap();
    snapshot
}

fn divergent_legacy_pair() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf, Snapshot) {
    let (dir, local) = fixture();
    let base = v2_snapshot(None);
    fs::create_dir_all(local.join(".notemd/habitat")).unwrap();
    fs::write(local.join(LEGACY_PATH), habitat_core::encode(&base).unwrap()).unwrap();
    git(&local, &["add", "--", LEGACY_PATH]);
    git(&local, &["commit", "-q", "-m", "shared old-path v2"]);
    let remote = dir.path().join("remote.git");
    git(
        dir.path(),
        &["init", "--bare", "-q", "-b", "main", remote.to_str().unwrap()],
    );
    git(&local, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&local, &["push", "-q", "-u", "origin", "main"]);
    let other = dir.path().join("other");
    git(
        dir.path(),
        &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()],
    );
    git(&other, &["config", "user.name", "Other Test"]);
    git(&other, &["config", "user.email", "other@example.invalid"]);
    git(&other, &["config", "commit.gpgsign", "false"]);
    (dir, local, other, remote, base)
}

#[test]
fn migration_is_not_a_second_structure_change_during_sync() {
    let (dir, local, other, remote, base) = divergent_legacy_pair();
    let local_snapshot = changed_v2_snapshot(&base, "local-new-content");
    let local_bytes = habitat_core::encode(&local_snapshot).unwrap();
    knowledge_structure::load(&local, &dir.path().join("local-runtime")).unwrap();
    fs::write(local.join(SNAPSHOT_PATH), &local_bytes).unwrap();
    fs::write(local.join("local-note.md"), "local ordinary note\n").unwrap();
    git(&local, &["add", "--", SNAPSHOT_PATH, "local-note.md"]);
    git(&local, &["commit", "-q", "-m", "local new structure"]);

    knowledge_structure::load(&other, &dir.path().join("other-runtime")).unwrap();
    fs::write(other.join("remote-note.md"), "remote ordinary note\n").unwrap();
    git(&other, &["add", "--", "remote-note.md"]);
    git(&other, &["commit", "-q", "-m", "remote ordinary note"]);
    git(&other, &["push", "-q", "origin", "main"]);

    git_ops::sync(&local, "origin", "main").unwrap();
    assert_eq!(head_blob(&local, SNAPSHOT_PATH).unwrap(), local_bytes);
    assert!(head_blob(&local, LEGACY_PATH).is_none());
    assert_eq!(head_blob(&remote, SNAPSHOT_PATH).unwrap(), local_bytes);
    assert!(head_blob(&remote, LEGACY_PATH).is_none());
    assert_eq!(fs::read(local.join("remote-note.md")).unwrap(), b"remote ordinary note\n");
    assert!(released_guard_accepts(&local));
    assert!(!fs::read_dir(local.join(".notemd/habitat"))
        .unwrap()
        .any(|entry| entry.unwrap().file_name().to_string_lossy().contains(".conflict.")));
    git_ops::sync(&local, "origin", "main").unwrap();
}

#[test]
fn remote_old_path_change_wins_over_local_path_only_migration() {
    let (dir, local, other, remote, base) = divergent_legacy_pair();
    let remote_snapshot = changed_v2_snapshot(&base, "remote-new-content");
    let remote_bytes = habitat_core::encode(&remote_snapshot).unwrap();
    knowledge_structure::load(&local, &dir.path().join("local-runtime")).unwrap();
    fs::write(local.join("local-note.md"), "local ordinary note\n").unwrap();
    git(&local, &["add", "--", "local-note.md"]);
    git(&local, &["commit", "-q", "-m", "local ordinary note"]);

    fs::write(other.join(LEGACY_PATH), &remote_bytes).unwrap();
    fs::write(other.join("remote-note.md"), "remote ordinary note\n").unwrap();
    git(&other, &["add", "--", LEGACY_PATH, "remote-note.md"]);
    git(&other, &["commit", "-q", "-m", "remote old-path structure"]);
    let remote_commit = String::from_utf8(git(&other, &["rev-parse", "HEAD"]))
        .unwrap()
        .trim()
        .to_owned();
    git(&other, &["push", "-q", "origin", "main"]);

    git_ops::sync(&local, "origin", "main").unwrap();
    assert_eq!(head_blob(&local, SNAPSHOT_PATH).unwrap(), remote_bytes);
    assert!(head_blob(&local, LEGACY_PATH).is_none());
    assert_eq!(head_blob(&remote, SNAPSHOT_PATH).unwrap(), remote_bytes);
    assert!(head_blob(&remote, LEGACY_PATH).is_none());
    assert_eq!(fs::read(local.join("remote-note.md")).unwrap(), b"remote ordinary note\n");
    assert_eq!(
        git(&local, &["show", &format!("{remote_commit}:{LEGACY_PATH}")]),
        remote_bytes
    );
    assert!(released_guard_accepts(&local));
    assert!(!fs::read_dir(local.join(".notemd/habitat"))
        .unwrap()
        .any(|entry| entry.unwrap().file_name().to_string_lossy().contains(".conflict.")));
}

#[test]
fn two_real_structure_changes_still_preserve_both_before_merge() {
    let (dir, local, other, remote, base) = divergent_legacy_pair();
    let local_snapshot = changed_v2_snapshot(&base, "local-new-content");
    let remote_snapshot = changed_v2_snapshot(&base, "remote-new-content");
    let local_bytes = habitat_core::encode(&local_snapshot).unwrap();
    let remote_bytes = habitat_core::encode(&remote_snapshot).unwrap();
    knowledge_structure::load(&local, &dir.path().join("local-runtime")).unwrap();
    knowledge_structure::load(&other, &dir.path().join("other-runtime")).unwrap();
    fs::write(local.join(SNAPSHOT_PATH), &local_bytes).unwrap();
    git(&local, &["add", "--", SNAPSHOT_PATH]);
    git(&local, &["commit", "-q", "-m", "local structure"]);
    let local_head = git(&local, &["rev-parse", "HEAD"]);
    fs::write(other.join(SNAPSHOT_PATH), &remote_bytes).unwrap();
    git(&other, &["add", "--", SNAPSHOT_PATH]);
    git(&other, &["commit", "-q", "-m", "remote structure"]);
    git(&other, &["push", "-q", "origin", "main"]);

    let error = git_ops::sync(&local, "origin", "main").unwrap_err();
    assert!(error.contains("KNOWLEDGE_STRUCTURE_CONFLICT"), "{error}");
    assert_eq!(git(&local, &["rev-parse", "HEAD"]), local_head);
    assert_eq!(head_blob(&local, SNAPSHOT_PATH).unwrap(), local_bytes);
    assert_eq!(head_blob(&remote, SNAPSHOT_PATH).unwrap(), remote_bytes);
    assert!(!local.join(".git/MERGE_HEAD").exists());
}

/// Mirrors the released guard's decisive contract: only this fixed path is
/// compared with HEAD and decoded; a missing file is accepted. The strict meta
/// shape comes from v6.930.3, so an accidental `focus` field fails here.
fn released_guard_accepts(root: &Path) -> bool {
    let committed = head_blob(root, LEGACY_PATH);
    let current = fs::read(root.join(LEGACY_PATH)).ok();
    if current != committed {
        return false;
    }
    let staged = Command::new("git")
        .args(["diff", "--cached", "--quiet", "--", LEGACY_PATH])
        .current_dir(root)
        .status()
        .unwrap();
    if !staged.success() {
        return false;
    }
    let Some(bytes) = committed else { return true };
    let Ok(snapshot) = habitat_core::decode(&bytes) else {
        return false;
    };
    let Ok(jsonl) = habitat_core::codec::encode_jsonl(&snapshot) else {
        return false;
    };
    let Some(first) = jsonl.split(|byte| *byte == b'\n').next() else {
        return false;
    };
    let Ok(mut meta_value) = serde_json::from_slice::<serde_json::Value>(first) else {
        return false;
    };
    if meta_value
        .as_object_mut()
        .and_then(|object| object.remove("kind"))
        != Some(serde_json::json!("meta"))
    {
        return false;
    }
    let Ok(meta) = serde_json::from_value::<ReleasedMeta>(meta_value) else {
        return false;
    };
    // Keep the old decoder's schema and integrity gates as well as its strict
    // metadata shape.
    meta.schema == SCHEMA_V1
}

fn sync_note(root: &Path, content: &str) {
    fs::write(root.join("note.md"), content).unwrap();
    assert!(released_guard_accepts(root));
    git_ops::sync(root, "origin", "main").unwrap();
    assert_eq!(head_blob(root, "note.md").unwrap(), content.as_bytes());
    assert!(released_guard_accepts(root));
}

#[test]
fn new_snapshot_with_no_legacy_file_does_not_block_released_sync() {
    let (dir, root) = fixture();
    let runtime = dir.path().join("runtime");
    let snapshot = v2_snapshot(None);
    knowledge_structure::save(
        &root,
        &runtime,
        None,
        &habitat_core::encode(&snapshot).unwrap(),
    )
    .unwrap();
    assert_ne!(SNAPSHOT_PATH, LEGACY_PATH);
    assert!(head_blob(&root, LEGACY_PATH).is_none());
    assert_eq!(
        habitat_core::decode(&head_blob(&root, SNAPSHOT_PATH).unwrap()).unwrap(),
        snapshot,
    );
    sync_note(&root, "ordinary edit after new snapshot\n");
}

#[test]
fn released_v1_file_remains_unchanged_when_new_snapshot_is_saved() {
    let (dir, root) = fixture();
    let runtime = dir.path().join("runtime");
    fs::create_dir_all(root.join(".notemd/habitat")).unwrap();
    fs::write(root.join(LEGACY_PATH), RELEASED_V1).unwrap();
    git(&root, &["add", "--", LEGACY_PATH]);
    git(&root, &["commit", "-q", "-m", "released v1"]);
    assert!(released_guard_accepts(&root));

    let old = habitat_core::decode(RELEASED_V1).unwrap();
    let snapshot = v2_snapshot(Some(&old));
    knowledge_structure::save(
        &root,
        &runtime,
        Some(&old.meta.snapshot_id),
        &habitat_core::encode(&snapshot).unwrap(),
    )
    .unwrap();
    assert_eq!(head_blob(&root, LEGACY_PATH).unwrap(), RELEASED_V1);
    assert_eq!(fs::read(root.join(LEGACY_PATH)).unwrap(), RELEASED_V1);
    assert!(head_blob(&root, SNAPSHOT_PATH).is_some());
    sync_note(&root, "ordinary edit beside released v1\n");
}

#[test]
fn misplaced_v2_is_moved_out_of_released_path_without_losing_history() {
    let (dir, root) = fixture();
    let runtime = dir.path().join("runtime");
    let snapshot = v2_snapshot(None);
    let bytes = habitat_core::encode(&snapshot).unwrap();
    fs::create_dir_all(root.join(".notemd/habitat")).unwrap();
    fs::write(root.join(LEGACY_PATH), &bytes).unwrap();
    git(&root, &["add", "--", LEGACY_PATH]);
    git(&root, &["commit", "-q", "-m", "misplaced v2"]);
    let misplaced_commit = String::from_utf8(git(&root, &["rev-parse", "HEAD"]))
        .unwrap()
        .trim()
        .to_owned();
    assert!(!released_guard_accepts(&root));

    let loaded = knowledge_structure::load(&root, &runtime).unwrap();
    assert_eq!(
        loaded["snapshot"]["meta"]["snapshotId"],
        snapshot.meta.snapshot_id
    );
    assert_eq!(
        git(
            &root,
            &["show", &format!("{misplaced_commit}:{LEGACY_PATH}")]
        ),
        bytes
    );
    assert_eq!(head_blob(&root, SNAPSHOT_PATH).unwrap(), bytes);
    assert!(head_blob(&root, LEGACY_PATH).is_none());
    assert!(!root.join(LEGACY_PATH).exists());
    sync_note(&root, "ordinary edit after migration\n");
}

#[test]
fn released_device_merges_new_snapshot_from_remote_and_syncs_its_note() {
    let (dir, new_device) = fixture();
    let runtime = dir.path().join("runtime");
    fs::create_dir_all(new_device.join(".notemd/habitat")).unwrap();
    fs::write(new_device.join(LEGACY_PATH), RELEASED_V1).unwrap();
    git(&new_device, &["add", "--", LEGACY_PATH]);
    git(&new_device, &["commit", "-q", "-m", "released v1"]);

    let remote = dir.path().join("remote.git");
    git(
        dir.path(),
        &[
            "init",
            "--bare",
            "-q",
            "-b",
            "main",
            remote.to_str().unwrap(),
        ],
    );
    git(
        &new_device,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&new_device, &["push", "-q", "-u", "origin", "main"]);
    let old_device = dir.path().join("old-device");
    git(
        dir.path(),
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            old_device.to_str().unwrap(),
        ],
    );
    git(&old_device, &["config", "user.name", "Old Test"]);
    git(
        &old_device,
        &["config", "user.email", "old@example.invalid"],
    );
    git(&old_device, &["config", "commit.gpgsign", "false"]);
    assert!(released_guard_accepts(&old_device));

    let old = habitat_core::decode(RELEASED_V1).unwrap();
    let snapshot = v2_snapshot(Some(&old));
    let bytes = habitat_core::encode(&snapshot).unwrap();
    knowledge_structure::save(&new_device, &runtime, Some(&old.meta.snapshot_id), &bytes).unwrap();
    git_ops::sync(&new_device, "origin", "main").unwrap();

    fs::write(old_device.join("note.md"), "edited on released device\n").unwrap();
    assert!(released_guard_accepts(&old_device));
    git_ops::sync(&old_device, "origin", "main").unwrap();
    assert!(released_guard_accepts(&old_device));
    assert_eq!(head_blob(&old_device, LEGACY_PATH).unwrap(), RELEASED_V1);
    assert_eq!(head_blob(&old_device, SNAPSHOT_PATH).unwrap(), bytes);
    assert_eq!(
        head_blob(&old_device, "note.md").unwrap(),
        b"edited on released device\n"
    );
    git(&old_device, &["fetch", "origin", "main"]);
    assert_eq!(
        git(&old_device, &["rev-parse", "HEAD"]),
        git(&old_device, &["rev-parse", "origin/main"])
    );
}

#[test]
fn interrupted_migration_resumes_with_identical_new_file() {
    for old_worktree_file_present in [true, false] {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let snapshot = v2_snapshot(None);
        let bytes = habitat_core::encode(&snapshot).unwrap();
        fs::create_dir_all(root.join(".notemd/habitat")).unwrap();
        fs::write(root.join(LEGACY_PATH), &bytes).unwrap();
        git(&root, &["add", "--", LEGACY_PATH]);
        git(&root, &["commit", "-q", "-m", "misplaced v2"]);
        let misplaced_commit = String::from_utf8(git(&root, &["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .to_owned();
        fs::write(root.join(SNAPSHOT_PATH), &bytes).unwrap();
        if !old_worktree_file_present {
            fs::remove_file(root.join(LEGACY_PATH)).unwrap();
        }

        let loaded = knowledge_structure::load(&root, &runtime).unwrap();
        assert_eq!(
            loaded["snapshot"]["meta"]["snapshotId"],
            snapshot.meta.snapshot_id
        );
        assert_eq!(head_blob(&root, SNAPSHOT_PATH).unwrap(), bytes);
        assert!(head_blob(&root, LEGACY_PATH).is_none());
        assert!(!root.join(LEGACY_PATH).exists());
        assert_eq!(
            git(
                &root,
                &["show", &format!("{misplaced_commit}:{LEGACY_PATH}")]
            ),
            bytes
        );
        // A second load and ordinary sync must not replay the migration.
        let migrated_head = git(&root, &["rev-parse", "HEAD"]);
        knowledge_structure::load(&root, &runtime).unwrap();
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), migrated_head);
        sync_note(&root, "note after resumed migration\n");
    }
}

#[test]
fn interrupted_migration_rejects_different_new_file_without_losing_either_copy() {
    for old_worktree_file_present in [true, false] {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let old_bytes = habitat_core::encode(&v2_snapshot(None)).unwrap();
        let mut different = v2_snapshot(None);
        different.meta.algorithm.version = "different/1".into();
        habitat_core::finalize(&mut different, None).unwrap();
        let new_bytes = habitat_core::encode(&different).unwrap();
        fs::create_dir_all(root.join(".notemd/habitat")).unwrap();
        fs::write(root.join(LEGACY_PATH), &old_bytes).unwrap();
        git(&root, &["add", "--", LEGACY_PATH]);
        git(&root, &["commit", "-q", "-m", "misplaced v2"]);
        let original_head = git(&root, &["rev-parse", "HEAD"]);
        fs::write(root.join(SNAPSHOT_PATH), &new_bytes).unwrap();
        if !old_worktree_file_present {
            fs::remove_file(root.join(LEGACY_PATH)).unwrap();
        }

        assert!(knowledge_structure::load(&root, &runtime).is_err());
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), original_head);
        assert_eq!(head_blob(&root, LEGACY_PATH).unwrap(), old_bytes);
        assert!(head_blob(&root, SNAPSHOT_PATH).is_none());
        assert_eq!(fs::read(root.join(SNAPSHOT_PATH)).unwrap(), new_bytes);
        assert_eq!(
            fs::read(root.join(LEGACY_PATH)).ok(),
            old_worktree_file_present.then_some(old_bytes)
        );
    }
}

#[test]
fn fast_forwarded_legacy_v2_is_migrated_before_sync_push() {
    let (dir, new_device) = fixture();
    let remote = dir.path().join("remote.git");
    git(
        dir.path(),
        &[
            "init",
            "--bare",
            "-q",
            "-b",
            "main",
            remote.to_str().unwrap(),
        ],
    );
    git(
        &new_device,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&new_device, &["push", "-q", "-u", "origin", "main"]);

    let old_device = dir.path().join("old-device");
    git(
        dir.path(),
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            old_device.to_str().unwrap(),
        ],
    );
    git(&old_device, &["config", "user.name", "Old Test"]);
    git(
        &old_device,
        &["config", "user.email", "old@example.invalid"],
    );
    git(&old_device, &["config", "commit.gpgsign", "false"]);
    let bytes = habitat_core::encode(&v2_snapshot(None)).unwrap();
    fs::create_dir_all(old_device.join(".notemd/habitat")).unwrap();
    fs::write(old_device.join(LEGACY_PATH), &bytes).unwrap();
    fs::write(
        old_device.join("note.md"),
        "remote note beside misplaced v2\n",
    )
    .unwrap();
    git(&old_device, &["add", "--", LEGACY_PATH, "note.md"]);
    git(&old_device, &["commit", "-q", "-m", "old path v2 and note"]);
    let misplaced_commit = git(&old_device, &["rev-parse", "HEAD"]);
    git(&old_device, &["push", "-q", "origin", "main"]);

    // There are no local edits, so this fetch must fast-forward before the
    // compatibility migration runs. The push must publish the migration too.
    assert!(released_guard_accepts(&new_device));
    git_ops::sync(&new_device, "origin", "main").unwrap();
    assert_eq!(head_blob(&remote, SNAPSHOT_PATH).unwrap(), bytes);
    assert!(head_blob(&remote, LEGACY_PATH).is_none());
    assert_eq!(
        head_blob(&remote, "note.md").unwrap(),
        b"remote note beside misplaced v2\n"
    );
    assert!(released_guard_accepts(&new_device));
    let misplaced_commit = String::from_utf8(misplaced_commit).unwrap();
    assert_eq!(
        git(
            &new_device,
            &[
                "show",
                &format!("{}:{LEGACY_PATH}", misplaced_commit.trim())
            ]
        ),
        bytes
    );

    fs::write(
        new_device.join("note.md"),
        "new note after remote migration\n",
    )
    .unwrap();
    git_ops::sync(&new_device, "origin", "main").unwrap();
    assert_eq!(head_blob(&remote, SNAPSHOT_PATH).unwrap(), bytes);
    assert!(head_blob(&remote, LEGACY_PATH).is_none());
    assert_eq!(
        head_blob(&remote, "note.md").unwrap(),
        b"new note after remote migration\n"
    );
}

#[test]
fn divergent_identical_v2_paths_converge_to_new_path_before_push() {
    let (dir, new_device) = fixture();
    let remote = dir.path().join("remote.git");
    git(
        dir.path(),
        &[
            "init",
            "--bare",
            "-q",
            "-b",
            "main",
            remote.to_str().unwrap(),
        ],
    );
    git(
        &new_device,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&new_device, &["push", "-q", "-u", "origin", "main"]);
    let old_device = dir.path().join("old-device");
    git(
        dir.path(),
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            old_device.to_str().unwrap(),
        ],
    );
    git(&old_device, &["config", "user.name", "Old Test"]);
    git(
        &old_device,
        &["config", "user.email", "old@example.invalid"],
    );
    git(&old_device, &["config", "commit.gpgsign", "false"]);

    let snapshot = v2_snapshot(None);
    let bytes = habitat_core::encode(&snapshot).unwrap();
    let runtime = dir.path().join("runtime");
    knowledge_structure::save(&new_device, &runtime, None, &bytes).unwrap();
    assert_eq!(head_blob(&new_device, SNAPSHOT_PATH).unwrap(), bytes);
    assert!(head_blob(&new_device, LEGACY_PATH).is_none());

    fs::create_dir_all(old_device.join(".notemd/habitat")).unwrap();
    fs::write(old_device.join(LEGACY_PATH), &bytes).unwrap();
    fs::write(
        old_device.join("note.md"),
        "note from divergent old branch\n",
    )
    .unwrap();
    git(&old_device, &["add", "--", LEGACY_PATH, "note.md"]);
    git(&old_device, &["commit", "-q", "-m", "old path v2"]);
    let old_commit = String::from_utf8(git(&old_device, &["rev-parse", "HEAD"]))
        .unwrap()
        .trim()
        .to_owned();
    git(&old_device, &["push", "-q", "origin", "main"]);

    git_ops::sync(&new_device, "origin", "main").unwrap();
    assert_eq!(head_blob(&new_device, SNAPSHOT_PATH).unwrap(), bytes);
    assert!(head_blob(&new_device, LEGACY_PATH).is_none());
    assert_eq!(head_blob(&remote, SNAPSHOT_PATH).unwrap(), bytes);
    assert!(head_blob(&remote, LEGACY_PATH).is_none());
    assert_eq!(
        head_blob(&remote, "note.md").unwrap(),
        b"note from divergent old branch\n"
    );
    assert!(released_guard_accepts(&new_device));
    assert_eq!(
        git(
            &new_device,
            &["show", &format!("{old_commit}:{LEGACY_PATH}")]
        ),
        bytes
    );
    git(
        &new_device,
        &["merge-base", "--is-ancestor", &old_commit, "HEAD"],
    );
}
