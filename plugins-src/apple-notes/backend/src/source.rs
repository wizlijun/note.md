use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub accounts: Vec<Account>,
    pub notes: Vec<Note>,
    pub complete: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub account_id: String,
    pub folders: Vec<Folder>,
    pub created_at: String,
    pub modified_at: String,
    pub html: String,
    pub locked: bool,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub content_id: String,
    pub relative_path: Option<String>,
    pub url: Option<String>,
}

#[cfg(not(target_os = "macos"))]
pub fn read_snapshot(_staging: &Path) -> Result<Snapshot, String> {
    Err("Apple Notes sync is available only on macOS".into())
}

#[cfg(target_os = "macos")]
pub fn read_snapshot(staging: &Path) -> Result<Snapshot, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    let staging = staging
        .canonicalize()
        .map_err(|e| format!("Invalid staging directory: {e}"))?;
    if !staging.is_dir() {
        return Err("Attachment staging path must be a directory".into());
    }
    let mut child = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", include_str!("export.js")])
        .arg(&staging)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Cannot start Apple Notes automation: {e}"))?;
    // Drain both pipes while waiting: a large notebook must not block on pipe capacity.
    let mut stdout = child.stdout.take().unwrap();
    let output = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut stderr = child.stderr.take().unwrap();
    let errors = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < Duration::from_secs(240) => {
                thread::sleep(Duration::from_millis(100));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(match result {
                    Err(e) => format!("Cannot wait for Apple Notes automation: {e}"),
                    _ => "Apple Notes automation timed out after 4 minutes; no deletion is allowed"
                        .into(),
                });
            }
        }
    };
    let bytes = output
        .join()
        .map_err(|_| "Apple Notes output reader failed")?
        .map_err(|e| format!("Cannot read Apple Notes output: {e}"))?;
    let error_bytes = errors
        .join()
        .map_err(|_| "Apple Notes error reader failed")?
        .map_err(|e| format!("Cannot read Apple Notes error status: {e}"))?;
    let status = status?;
    if !status.success() {
        // Never expose osascript diagnostics: they can include note content.
        let permission = String::from_utf8_lossy(&error_bytes).contains("-1743");
        return Err(if permission {
            "Apple Notes automation permission denied. Allow Notes access in System Settings > Privacy & Security > Automation".into()
        } else {
            "Apple Notes automation failed. Ensure Notes is available in the logged-in macOS session and Automation access is allowed".into()
        });
    }
    let snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|_| {
        "Apple Notes returned an invalid snapshot; no deletion is allowed".to_string()
    })?;
    validate_snapshot(&snapshot, &staging)?;
    Ok(snapshot)
}

fn validate_snapshot(snapshot: &Snapshot, staging: &Path) -> Result<(), String> {
    use std::collections::HashSet;
    use std::path::Component;
    let mut accounts = HashSet::new();
    for account in &snapshot.accounts {
        if account.id.is_empty() || !accounts.insert(&account.id) {
            return Err("Apple Notes snapshot has invalid account identities".into());
        }
    }
    if accounts.is_empty() {
        return Err(
            "Apple Notes exposes no accounts; refusing a potentially incomplete snapshot".into(),
        );
    }
    let mut notes = HashSet::new();
    for note in &snapshot.notes {
        if note.id.is_empty() || !notes.insert(&note.id) || !accounts.contains(&note.account_id) {
            return Err("Apple Notes snapshot has invalid note identities".into());
        }
        for attachment in &note.attachments {
            if let Some(relative) = &attachment.relative_path {
                let path = Path::new(relative);
                if relative.is_empty()
                    || path
                        .components()
                        .any(|part| !matches!(part, Component::Normal(_)))
                {
                    return Err("Apple Notes returned an unsafe attachment path".into());
                }
                let file = staging.join(path);
                let metadata = std::fs::symlink_metadata(&file)
                    .map_err(|_| "Apple Notes attachment export is missing".to_string())?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || !file
                        .canonicalize()
                        .map_err(|_| "Cannot resolve exported attachment")?
                        .starts_with(staging)
                {
                    return Err("Apple Notes returned an unsafe attachment file".into());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Snapshot {
        Snapshot {
            accounts: vec![Account {
                id: "account-1".into(),
                name: "iCloud".into(),
            }],
            notes: vec![Note {
                id: "note-1".into(),
                title: "Example".into(),
                account_id: "account-1".into(),
                folders: vec![],
                created_at: "2026-09-15T00:00:00.000Z".into(),
                modified_at: "2026-09-15T00:00:00.000Z".into(),
                html: "<p>Example</p>".into(),
                locked: false,
                attachments: vec![],
            }],
            complete: true,
            warnings: vec![],
        }
    }

    fn attachment(path: &str) -> Attachment {
        Attachment {
            id: "attachment-1".into(),
            name: "Example.txt".into(),
            content_id: "cid:1".into(),
            relative_path: Some(path.into()),
            url: None,
        }
    }

    #[test]
    fn refuses_no_accounts_and_duplicate_or_orphaned_notes() {
        let staging = tempfile::tempdir().unwrap();
        let mut snapshot = fixture();
        assert!(validate_snapshot(&snapshot, staging.path()).is_ok());
        snapshot.accounts.clear();
        assert!(validate_snapshot(&snapshot, staging.path()).is_err());
        let mut snapshot = fixture();
        snapshot.notes.push(snapshot.notes[0].clone());
        assert!(validate_snapshot(&snapshot, staging.path()).is_err());
        let mut snapshot = fixture();
        snapshot.notes[0].account_id = "missing-account".into();
        assert!(validate_snapshot(&snapshot, staging.path()).is_err());
    }

    #[test]
    fn validates_exported_files_and_rejects_unsafe_paths() {
        let staging = tempfile::tempdir().unwrap();
        let staging = staging.path().canonicalize().unwrap();
        std::fs::write(staging.join("Example.txt"), "example").unwrap();
        let mut snapshot = fixture();
        snapshot.notes[0].attachments = vec![attachment("Example.txt")];
        assert!(validate_snapshot(&snapshot, &staging).is_ok());
        for path in ["../Example.txt", "/tmp/Example.txt", "", "missing.txt"] {
            snapshot.notes[0].attachments = vec![attachment(path)];
            assert!(
                validate_snapshot(&snapshot, &staging).is_err(),
                "accepted {path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_attachments_even_inside_staging() {
        let staging = tempfile::tempdir().unwrap();
        let path = staging.path().canonicalize().unwrap();
        std::fs::write(path.join("real.txt"), "example").unwrap();
        std::os::unix::fs::symlink(path.join("real.txt"), path.join("link.txt")).unwrap();
        let mut snapshot = fixture();
        snapshot.notes[0].attachments = vec![attachment("link.txt")];
        assert!(validate_snapshot(&snapshot, &path).is_err());
    }
}
