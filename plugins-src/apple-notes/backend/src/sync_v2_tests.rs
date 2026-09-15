use super::*;
use crate::source::{Account, Attachment, Folder};

fn snapshot() -> Snapshot {
    Snapshot {
        complete: true,
        warnings: vec![],
        accounts: vec![Account {
            id: "account-id".into(),
            name: "iCloud".into(),
        }],
        notes: vec![Note {
            id: "note-id".into(),
            title: "会议 / Alpha".into(),
            account_id: "account-id".into(),
            folders: vec![Folder {
                id: "folder-id".into(),
                name: "Notes".into(),
            }],
            created_at: "2026-09-15T16:30:05+08:00".into(),
            modified_at: "2026-09-15T10:00:00Z".into(),
            html: "<p><b>Hello</b> world</p>".into(),
            locked: false,
            attachments: vec![],
        }],
    }
}
fn apply(root: &Path, snapshot: &Snapshot) -> Result<SyncReport> {
    apply_snapshot(root, snapshot, root, false)
}
fn ledger(root: &Path) -> Ledger {
    read_mapping(root).unwrap().unwrap()
}
fn document(root: &Path, id: &str) -> String {
    fs::read_to_string(root.join(&ledger(root).notes[id].path)).unwrap()
}
fn attach(snapshot: &mut Snapshot, id: &str, name: &str, exported: Option<&str>) {
    snapshot.notes[0].attachments.push(Attachment {
        id: id.into(),
        name: name.into(),
        content_id: format!("cid:{id}"),
        relative_path: exported.map(str::to_string),
        url: None,
    });
}
fn write_legacy(root: &Path, snapshot: &Snapshot, asset: bool) -> String {
    let note = &snapshot.notes[0];
    let parent = format!(
        "applenotes/iCloud--{}/Notes--{}",
        &hash(note.account_id.as_bytes())[..16],
        &hash(note.folders[0].id.as_bytes())[..16]
    );
    let stem = format!(
        "2026-09-15-083005Z-{}-legacy",
        &hash(note.id.as_bytes())[..16]
    );
    let path = format!("{parent}/{stem}.md");
    fs::create_dir_all(root.join(&parent)).unwrap();
    let mut yaml = serde_yaml::to_string(&serde_json::json!({"readonly": true, "source": "apple-notes", "type":"Note",
        "apple_notes_id":note.id,"account_id":note.account_id,"folder_ids":[note.folders[0].id],
        "account":"iCloud","folders":["Notes"],"title":note.title,"created":note.created_at,"modified":note.modified_at,"locked":false})).unwrap();
    yaml = format!("---\n{yaml}---\n\n**Retained body**\n");
    let mut files = BTreeMap::new();
    if asset {
        let name = format!("{stem}.attachments/photo--{}.png", &hash(b"asset-id")[..16]);
        fs::create_dir_all(root.join(&parent).join(Path::new(&name).parent().unwrap())).unwrap();
        fs::write(root.join(&parent).join(&name), b"legacy photo").unwrap();
        yaml.push_str(&format!("\n![Photo](<{}>)\n", encoded(&name)));
        files.insert(name, hash(b"legacy photo"));
    }
    fs::write(root.join(&path), &yaml).unwrap();
    files.insert(format!("{stem}.md"), hash(yaml.as_bytes()));
    atomic_json(
        root,
        &format!("{CONTROL}/state.json"),
        &serde_json::json!({"version":1,"notes":{
            note.id.clone():{"account_id":note.account_id,"path":path,"files":files}
        }}),
    )
    .unwrap();
    path
}

#[test]
fn readable_paths_yaml_and_single_mapping_are_stable() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    assert_eq!(apply(root, &s).unwrap().created, 1);
    let entry = &ledger(root).notes["note-id"];
    assert_eq!(
        entry.path,
        "applenotes/iCloud/Notes/2026-09-15-会议-alpha.md"
    );
    let text = document(root, "note-id");
    assert!(text.contains("readonly: true") && text.contains("**Hello** world"));
    for forbidden in [
        "apple_notes_id",
        "account_id",
        "folder_ids",
        "note-id",
        "folder-id",
    ] {
        assert!(!text.contains(forbidden));
    }
    assert_eq!(ledger(root).version, 2);
    assert_eq!(ledger(root).source, "apple-notes");
    assert!(root.join(MAPPING).is_file());
    assert!(!root.join(format!("{CONTROL}/pending.json")).exists());
    let before = fs::metadata(root.join(&entry.path))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(apply(root, &s).unwrap().unchanged, 1);
    assert_eq!(
        fs::metadata(root.join(&entry.path))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    s.notes[0].html.push_str("<p>update</p>");
    assert_eq!(apply(root, &s).unwrap().updated, 1);
    s.notes[0].title = "Renamed".into();
    assert_eq!(apply(root, &s).unwrap().moved, 1);
    s.notes.clear();
    assert_eq!(apply(root, &s).unwrap().deleted, 1);
    assert!(!ledger(root).trash.is_empty());
}

#[test]
fn collisions_use_stable_numbers_across_reordering_deletion_and_new_ids() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    let mut second = s.notes[0].clone();
    second.id = "z-note".into();
    s.notes.push(second);
    apply(root, &s).unwrap();
    let first = ledger(root);
    assert!(first.notes["z-note"].path.ends_with("会议-alpha-2.md"));
    s.notes.reverse();
    apply(root, &s).unwrap();
    assert_eq!(ledger(root).notes, first.notes);
    s.notes.retain(|n| n.id == "z-note");
    apply(root, &s).unwrap();
    assert_eq!(
        ledger(root).notes["z-note"].path,
        first.notes["z-note"].path
    );
    let mut third = s.notes[0].clone();
    third.id = "a-new".into();
    s.notes.push(third);
    apply(root, &s).unwrap();
    assert_eq!(
        ledger(root).notes["z-note"].path,
        first.notes["z-note"].path
    );
    assert!(ledger(root).notes["a-new"].path.ends_with("会议-alpha.md"));
}

#[test]
fn unicode_and_case_equivalent_directories_and_attachments_do_not_collide() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    assert_eq!(fold("straße"), fold("STRASSE"));
    s.accounts[0].name = "Café".into();
    s.notes[0].folders[0].name = "Work".into();
    s.accounts.push(Account {
        id: "second-account".into(),
        name: "CAFE\u{301}".into(),
    });
    let mut other = s.notes[0].clone();
    other.id = "other".into();
    other.account_id = "second-account".into();
    other.folders[0].id = "other-folder".into();
    s.notes.push(other);
    fs::write(root.join("asset"), "bytes").unwrap();
    attach(&mut s, "asset-one", "Résumé.png", Some("asset"));
    attach(
        &mut s,
        "asset-two",
        "RE\u{301}SUME\u{301}.png",
        Some("asset"),
    );
    apply(root, &s).unwrap();
    let mapped = ledger(root);
    assert_ne!(
        fold(&mapped.accounts["account-id"].path),
        fold(&mapped.accounts["second-account"].path)
    );
    let a = &mapped.notes["note-id"].attachments;
    assert_ne!(
        fold(a["asset-one"].path.as_deref().unwrap()),
        fold(a["asset-two"].path.as_deref().unwrap())
    );
    assert!(a["asset-two"].path.as_deref().unwrap().ends_with("-2.png"));
}

#[test]
fn global_backup_handles_title_swaps_and_parent_moves() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    s.notes[0].title = "alpha".into();
    s.notes[0].html = "<p>First</p>".into();
    let mut other = s.notes[0].clone();
    other.id = "second".into();
    other.title = "beta".into();
    other.html = "<p>Second</p>".into();
    s.notes.push(other);
    apply(root, &s).unwrap();
    s.notes[0].title = "beta".into();
    s.notes[1].title = "alpha".into();
    assert_eq!(apply(root, &s).unwrap().moved, 2);
    assert!(document(root, "note-id").contains("First"));
    assert!(document(root, "second").contains("Second"));
    s.notes[0].folders[0].name = "notes".into();
    s.notes[1].folders[0].name = "notes".into();
    assert_eq!(apply(root, &s).unwrap().moved, 2);
    assert!(ledger(root).notes["note-id"].path.contains("/notes/"));
}

#[test]
fn moving_notes_and_folders_cannot_take_a_stationary_owners_path() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    s.notes[0].id = "a-mover".into();
    s.notes[0].folders = vec![
        Folder {
            id: "parent-one".into(),
            name: "Parent One".into(),
        },
        Folder {
            id: "a-shared".into(),
            name: "Shared".into(),
        },
    ];
    let mut resident = s.notes[0].clone();
    resident.id = "z-resident".into();
    resident.title = "Resident".into();
    resident.folders = vec![
        Folder {
            id: "parent-two".into(),
            name: "Parent Two".into(),
        },
        Folder {
            id: "z-shared".into(),
            name: "Shared".into(),
        },
    ];
    s.notes.push(resident);
    apply(root, &s).unwrap();
    let before = ledger(root);
    let resident_folder = before.folders["z-shared"].path.clone();

    s.notes[0].folders[0] = s.notes[1].folders[0].clone();
    s.notes[0].title = s.notes[1].title.clone();
    apply(root, &s).unwrap();
    let after = ledger(root);
    assert_eq!(after.folders["z-shared"].path, resident_folder);
    assert!(after.folders["a-shared"].path.ends_with("/Shared-2"));
    let note_vault = tempfile::tempdir().unwrap();
    let note_root = note_vault.path();
    let mut notes = snapshot();
    notes.notes[0].id = "a-mover".into();
    let mut note_resident = notes.notes[0].clone();
    note_resident.id = "z-resident".into();
    note_resident.folders[0] = Folder {
        id: "inbox".into(),
        name: "Inbox".into(),
    };
    notes.notes.push(note_resident);
    apply(note_root, &notes).unwrap();
    let resident_note = ledger(note_root).notes["z-resident"].path.clone();
    notes.notes[0].folders = notes.notes[1].folders.clone();
    apply(note_root, &notes).unwrap();
    let after_notes = ledger(note_root);
    assert_eq!(after_notes.notes["z-resident"].path, resident_note);
    assert!(after_notes.notes["a-mover"].path.ends_with("-2.md"));
}

#[test]
fn explicit_attachment_identity_survives_renames_and_export_failure() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    fs::write(root.join("asset"), "old bytes").unwrap();
    attach(&mut s, "asset-id", "Photo #1.png", Some("asset"));
    s.notes[0].html.push_str("<img src=\"cid:asset-id\">");
    apply(root, &s).unwrap();
    assert!(document(root, "note-id").contains("%23"));
    assert!(!document(root, "note-id").contains("cid:asset-id"));
    s.notes[0].attachments[0].relative_path = None;
    s.notes[0].attachments[0].name = "Renamed.png".into();
    s.notes[0].title = "Moved".into();
    s.warnings.push("export failed".into());
    assert!(!apply(root, &s).unwrap().complete);
    let entry = &ledger(root).notes["note-id"];
    let asset = &entry.attachments["asset-id"];
    assert!(asset.path.as_deref().unwrap().ends_with("/Renamed.png"));
    assert_eq!(asset.hash.as_deref(), Some(hash(b"old bytes").as_str()));
    assert_eq!(
        fs::read_to_string(root.join(asset.path.as_deref().unwrap())).unwrap(),
        "old bytes"
    );
    fs::remove_file(root.join(asset.path.as_deref().unwrap())).unwrap();
    assert!(!apply(root, &s).unwrap().complete);
    assert!(document(root, "note-id").contains("unavailable"));
    let unavailable = &ledger(root).notes["note-id"].attachments["asset-id"];
    assert!(unavailable.path.is_none() && unavailable.hash.is_none());
}

#[test]
fn legacy_mapping_migrates_locked_notes_assets_and_tombstones_old_binary() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    let old = write_legacy(root, &s, true);
    s.notes[0].locked = true;
    s.notes[0].html.clear();
    assert!(!apply(root, &s).unwrap().complete);
    assert!(!root.join(old).exists());
    let text = document(root, "note-id");
    assert!(text.contains("Retained body") && !text.contains("apple_notes_id"));
    let entry = &ledger(root).notes["note-id"];
    assert_eq!(entry.legacy_attachments.len(), 1);
    let oldasset = entry.legacy_attachments.values().next().unwrap();
    assert!(oldasset.path.as_deref().unwrap().ends_with("/photo.png"));
    assert!(text.contains(&encoded(
        &entry_relative(entry, oldasset.path.as_deref().unwrap()).unwrap()
    )));
    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(format!("{CONTROL}/state.json"))).unwrap())
            .unwrap();
    assert_eq!(marker, serde_json::json!({"version":2,"notes":{}}));
    s.notes[0].locked = false;
    s.notes[0].html = "<p>Unlocked</p>".into();
    attach(&mut s, "asset-id", "photo.png", None);
    s.warnings.push("export failed".into());
    apply(root, &s).unwrap();
    let mapped = ledger(root);
    assert!(mapped.notes["note-id"].legacy_attachments.is_empty());
    assert_eq!(
        mapped.notes["note-id"].attachments["asset-id"]
            .hash
            .as_deref(),
        Some(hash(b"legacy photo").as_str())
    );
}

#[test]
fn missing_locked_legacy_asset_stays_a_fingerprint_until_full_id_is_visible() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    write_legacy(root, &s, true);
    let legacy: Ledger =
        serde_json::from_slice(&fs::read(root.join(format!("{CONTROL}/state.json"))).unwrap())
            .unwrap();
    let asset = legacy.notes["note-id"]
        .files
        .keys()
        .find(|path| path.contains('/'))
        .unwrap();
    fs::remove_file(root.join(entry_file(&legacy.notes["note-id"], asset))).unwrap();
    s.notes[0].locked = true;
    apply(root, &s).unwrap();
    let migrated = ledger(root);
    assert_eq!(migrated.notes["note-id"].legacy_attachments.len(), 1);
    assert!(migrated.notes["note-id"].attachments.is_empty());

    s.notes[0].locked = false;
    attach(&mut s, "asset-id", "photo.png", None);
    apply(root, &s).unwrap();
    let completed = ledger(root);
    assert!(completed.notes["note-id"].legacy_attachments.is_empty());
    assert!(completed.notes["note-id"]
        .attachments
        .contains_key("asset-id"));
}

#[test]
fn unavailable_and_url_attachment_ids_are_kept_only_in_the_mapping() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    attach(&mut s, "missing-id", "missing.bin", None);
    s.notes[0].attachments.push(Attachment {
        id: "url-id".into(),
        name: "website".into(),
        content_id: String::new(),
        relative_path: None,
        url: Some("https://example.com/item".into()),
    });
    apply(root, &s).unwrap();
    let mapped = ledger(root);
    assert!(mapped.notes["note-id"]
        .attachments
        .contains_key("missing-id"));
    assert_eq!(
        mapped.notes["note-id"].attachments["url-id"].url.as_deref(),
        Some("https://example.com/item")
    );
    let document = document(root, "note-id");
    assert!(!document.contains("missing-id") && !document.contains("url-id"));
    s.notes[0].locked = true;
    s.notes[0].attachments.clear();
    apply(root, &s).unwrap();
    assert_eq!(
        ledger(root).notes["note-id"].attachments["url-id"]
            .url
            .as_deref(),
        Some("https://example.com/item")
    );
}

#[test]
fn legacy_absent_account_is_migrated_without_deleting_copies() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let s = snapshot();
    let old = write_legacy(root, &s, false);
    let mut missing = s.clone();
    missing.accounts.clear();
    missing.notes.clear();
    let report = apply(root, &missing).unwrap();
    assert!(!report.complete);
    assert_eq!(report.deleted, 0);
    assert!(!root.join(old).exists());
    assert!(document(root, "note-id").contains("Retained body"));
}

#[test]
fn dry_run_and_incomplete_inventory_do_not_migrate_or_write() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let s = snapshot();
    assert_eq!(apply_snapshot(root, &s, root, true).unwrap().created, 1);
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    let old = write_legacy(root, &s, true);
    let before = fs::read(root.join(&old)).unwrap();
    apply_snapshot(root, &s, root, true).unwrap();
    assert!(!root.join(MAPPING).exists());
    let mut partial = s.clone();
    partial.complete = false;
    apply(root, &partial).unwrap();
    assert!(!root.join(MAPPING).exists());
    assert_eq!(fs::read(root.join(old)).unwrap(), before);
}

#[test]
fn local_edits_unmanaged_neighbors_and_reserved_mapping_are_protected() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    apply(root, &s).unwrap();
    let path = ledger(root).notes["note-id"].path.clone();
    let parent = root.join(&path).parent().unwrap().to_path_buf();
    fs::write(parent.join("2026-09-15-new.md"), "mine").unwrap();
    s.notes[0].title = "new".into();
    apply(root, &s).unwrap();
    assert!(ledger(root).notes["note-id"].path.ends_with("new-2.md"));
    assert_eq!(
        fs::read_to_string(parent.join("2026-09-15-new.md")).unwrap(),
        "mine"
    );
    fs::write(root.join(&ledger(root).notes["note-id"].path), "edited").unwrap();
    s.notes.clear();
    assert!(apply(root, &s).unwrap_err().contains("Local changes"));
    let empty = tempfile::tempdir().unwrap();
    let mut collision = snapshot();
    collision.accounts[0].name = "ID-SYNC.JSON".into();
    apply(empty.path(), &collision).unwrap();
    assert!(ledger(empty.path()).accounts["account-id"]
        .path
        .ends_with("ID-SYNC.JSON-2"));
}

#[test]
fn mapping_loss_corruption_and_symlinks_never_reimport_or_overwrite() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let s = snapshot();
    apply(root, &s).unwrap();
    fs::remove_file(root.join(MAPPING)).unwrap();
    assert!(apply(root, &s).is_err());
    fs::write(root.join(MAPPING), "broken").unwrap();
    assert!(apply(root, &s).is_err());
    #[cfg(unix)]
    {
        let fresh = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), fresh.path().join("applenotes")).unwrap();
        assert!(apply(fresh.path(), &s).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}

#[test]
fn missing_account_and_locked_content_stay_intact() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    apply(root, &s).unwrap();
    s.notes[0].locked = true;
    s.notes[0].title = "locked renamed".into();
    s.notes[0].html.clear();
    assert!(!apply(root, &s).unwrap().complete);
    assert!(document(root, "note-id").contains("**Hello** world"));
    s.notes.clear();
    s.accounts.clear();
    assert_eq!(apply(root, &s).unwrap().deleted, 0);
    assert!(document(root, "note-id").contains("**Hello** world"));
}

fn pending_fixture(root: &Path) -> (Ledger, Pending, String, Vec<u8>, Vec<u8>) {
    apply(root, &snapshot()).unwrap();
    let old = ledger(root);
    let entry = &old.notes["note-id"];
    let path = entry.path.clone();
    let old_bytes = fs::read(root.join(&path)).unwrap();
    let mut new_bytes = old_bytes.clone();
    new_bytes.extend_from_slice(b"\nRecovered update.\n");
    let digest = hash(&new_bytes);
    let backup = Backup {
        path: path.clone(),
        hash: hash(&old_bytes),
        backup: format!("{CONTROL}/trash/test-tx/0"),
    };
    let install = Install {
        path: path.clone(),
        hash: digest.clone(),
        staged: format!("{CONTROL}/staging/test-tx/0"),
    };
    let mut next = old.clone();
    next.notes
        .get_mut("note-id")
        .unwrap()
        .files
        .insert(filename(&path).unwrap().into(), digest);
    next.trash.push(backup.clone());
    fs::create_dir_all(root.join(&install.staged).parent().unwrap()).unwrap();
    fs::write(root.join(&install.staged), &new_bytes).unwrap();
    let pending = Pending {
        transaction: "test-tx".into(),
        phase: Phase::Backup,
        backups: vec![backup],
        missing_backups: vec![],
        installs: vec![install],
        next: Box::new(next),
    };
    (old, pending, path, old_bytes, new_bytes)
}

#[test]
fn v2_pending_recovers_before_during_and_after_install() {
    for stage in 0..5 {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        let (old, mut pending, path, old_bytes, new_bytes) = pending_fixture(root);
        let source = root.join(&path);
        let backup = root.join(&pending.backups[0].backup);
        let staged = root.join(&pending.installs[0].staged);
        if stage >= 1 {
            fs::create_dir_all(backup.parent().unwrap()).unwrap();
            fs::rename(&source, &backup).unwrap();
        }
        if stage == 4 {
            cleanup_empty(root, [path.clone()], "applenotes").unwrap();
            assert!(!source.parent().unwrap().exists());
        }
        if stage == 2 || stage == 3 {
            pending.phase = Phase::Install;
        }
        if stage == 3 {
            fs::create_dir_all(source.parent().unwrap()).unwrap();
            fs::rename(&staged, &source).unwrap();
        }
        let mut record = old;
        record.pending = Some(pending);
        atomic_json(root, MAPPING, &record).unwrap();
        recover(root).unwrap();
        assert_eq!(fs::read(&source).unwrap(), new_bytes, "stage {stage}");
        assert_eq!(fs::read(&backup).unwrap(), old_bytes, "stage {stage}");
        assert!(ledger(root).pending.is_none());
        let modified = fs::metadata(&source).unwrap().modified().unwrap();
        recover(root).unwrap();
        assert_eq!(fs::metadata(&source).unwrap().modified().unwrap(), modified);
    }
}

#[test]
fn incomplete_or_corrupt_v2_pending_never_changes_the_mirror() {
    for corrupt_staging in [false, true] {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        let (old, mut pending, path, old_bytes, _) = pending_fixture(root);
        if corrupt_staging {
            fs::write(root.join(&pending.installs[0].staged), b"tampered").unwrap();
        } else {
            pending.installs.clear();
        }
        let mut record = old;
        record.pending = Some(pending);
        atomic_json(root, MAPPING, &record).unwrap();
        assert!(recover(root).is_err());
        assert_eq!(fs::read(root.join(path)).unwrap(), old_bytes);
    }
}

#[test]
fn same_hash_missing_file_requires_its_reinstall_operation() {
    for remove_operation in [false, true] {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        apply(root, &snapshot()).unwrap();
        let old = ledger(root);
        let path = old.notes["note-id"].path.clone();
        let bytes = fs::read(root.join(&path)).unwrap();
        fs::remove_file(root.join(&path)).unwrap();
        let staged = format!("{CONTROL}/staging/same-hash/0");
        fs::create_dir_all(root.join(&staged).parent().unwrap()).unwrap();
        fs::write(root.join(&staged), &bytes).unwrap();
        let mut installs = vec![Install {
            path: path.clone(),
            hash: hash(&bytes),
            staged,
        }];
        if remove_operation {
            installs.clear();
        }
        let pending = Pending {
            transaction: "same-hash".into(),
            phase: Phase::Backup,
            backups: vec![],
            missing_backups: vec![],
            installs,
            next: Box::new(old.clone()),
        };
        let mut record = old;
        record.pending = Some(pending);
        atomic_json(root, MAPPING, &record).unwrap();
        if remove_operation {
            assert!(recover(root).is_err());
            assert!(!root.join(path).exists());
        } else {
            recover(root).unwrap();
            assert_eq!(fs::read(root.join(path)).unwrap(), bytes);
        }
    }
}

#[test]
fn legacy_pending_is_replayed_before_v2_migration() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let s = snapshot();
    write_legacy(root, &s, false);
    let legacy: Ledger =
        serde_json::from_slice(&fs::read(root.join(format!("{CONTROL}/state.json"))).unwrap())
            .unwrap();
    atomic_json(
        root,
        &format!("{CONTROL}/pending.json"),
        &LegacyJournal {
            operations: vec![],
            ledger: legacy,
        },
    )
    .unwrap();
    recover(root).unwrap();
    assert!(!root.join(format!("{CONTROL}/pending.json")).exists());
    apply(root, &s).unwrap();
    assert_eq!(ledger(root).version, 2);
}

#[test]
fn legacy_pending_partially_backed_up_file_is_installed_then_migrated() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let s = snapshot();
    write_legacy(root, &s, false);
    let mut legacy: Ledger =
        serde_json::from_slice(&fs::read(root.join(format!("{CONTROL}/state.json"))).unwrap())
            .unwrap();
    let path = legacy.notes["note-id"].path.clone();
    let old_bytes = fs::read(root.join(&path)).unwrap();
    let mut new_bytes = old_bytes.clone();
    new_bytes.extend_from_slice(b"\nlegacy recovery\n");
    legacy
        .notes
        .get_mut("note-id")
        .unwrap()
        .files
        .insert(filename(&path).unwrap().into(), hash(&new_bytes));
    let staged = format!("{CONTROL}/staging/legacy-partial/0");
    let backup = format!("{CONTROL}/trash/legacy-partial/0");
    fs::create_dir_all(root.join(&staged).parent().unwrap()).unwrap();
    fs::write(root.join(&staged), &new_bytes).unwrap();
    let journal = LegacyJournal {
        operations: vec![
            LegacyOperation {
                old: Some(path.clone()),
                old_hash: Some(hash(&old_bytes)),
                new: None,
                staged: None,
                backup: backup.clone(),
            },
            LegacyOperation {
                old: None,
                old_hash: None,
                new: Some(path.clone()),
                staged: Some(staged),
                backup: backup.clone(),
            },
        ],
        ledger: legacy,
    };
    atomic_json(root, &format!("{CONTROL}/pending.json"), &journal).unwrap();
    fs::create_dir_all(root.join(&backup).parent().unwrap()).unwrap();
    fs::rename(root.join(&path), root.join(&backup)).unwrap();
    recover(root).unwrap();
    assert_eq!(fs::read(root.join(&path)).unwrap(), new_bytes);
    assert_eq!(fs::read(root.join(&backup)).unwrap(), old_bytes);
    apply(root, &s).unwrap();
    assert_eq!(ledger(root).version, 2);
}

#[test]
fn duplicate_ids_bad_dates_and_concurrency_fail_safely() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let mut s = snapshot();
    s.notes.push(s.notes[0].clone());
    assert!(apply(root, &s).is_err());
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    s.notes.pop();
    s.notes[0].created_at = "bad".into();
    assert!(apply(root, &s).is_err());
    let lock = acquire(root).unwrap();
    assert!(acquire(root).is_err());
    drop(lock);
    assert!(acquire(root).is_ok());
}
