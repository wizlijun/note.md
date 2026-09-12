//! The Worker key is scoped to the active Vault. It is intentionally stored
//! as a plain file so note.md never invokes the macOS Keychain for this plugin.
//! The containing directory and file are private to the current OS user, and a
//! colocated `.gitignore` prevents accidental Vault commits. This is not an
//! isolation boundary from other processes running as the same user.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const RELATIVE_KEY_PATH: &str = ".notemd/assistant-mail/.local/access-key";
const RELATIVE_DIR: &str = ".notemd/assistant-mail";
const RELATIVE_LOCAL_DIR: &str = ".notemd/assistant-mail/.local";
const IGNORE_RULE: &str = ".local/";
const MAX_GITIGNORE_BYTES: u64 = 1024 * 1024;

pub trait CredentialStore {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

#[derive(Debug, Clone)]
pub struct VaultCredentialStore {
    vault_root: PathBuf,
}

impl VaultCredentialStore {
    pub fn new(vault_root: PathBuf) -> Self {
        Self { vault_root }
    }

    fn dir(&self) -> PathBuf {
        self.vault_root.join(RELATIVE_LOCAL_DIR)
    }

    fn path(&self) -> PathBuf {
        self.vault_root.join(RELATIVE_KEY_PATH)
    }
}

impl CredentialStore for VaultCredentialStore {
    fn get(&self) -> Result<Option<String>, String> {
        if !validate_existing_layout(&self.vault_root, &self.dir())? {
            return Ok(None);
        }
        let path = self.path();
        match fs::symlink_metadata(&path) {
            Ok(meta) => {
                reject_symlink(&meta, "Assistant Mail key")?;
                if !meta.is_file() {
                    return Err("Assistant Mail key path is not a regular file".into());
                }
                if meta.len() > 512 {
                    return Err("Assistant Mail key file exceeds 512 bytes".into());
                }
                require_private_permissions(&meta, "Assistant Mail key file")?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("could not inspect Assistant Mail key file".into()),
        }
        verify_git_state(&self.vault_root)?;
        let bytes = fs::read(&path).map_err(|_| "could not read Assistant Mail key file")?;
        let value =
            String::from_utf8(bytes).map_err(|_| "Assistant Mail key file is not valid UTF-8")?;
        validate_access_key(&value)?;
        Ok(Some(value))
    }

    fn set(&self, value: &str) -> Result<(), String> {
        validate_access_key(value)?;
        let plugin_dir = self.vault_root.join(RELATIVE_DIR);
        create_private_layout(&self.vault_root, &plugin_dir, &self.dir())?;
        ensure_gitignore(&plugin_dir)?;
        verify_git_state(&self.vault_root)?;

        let destination = self.path();
        if let Ok(meta) = fs::symlink_metadata(&destination) {
            reject_symlink(&meta, "Assistant Mail key")?;
            if !meta.is_file() {
                return Err("Assistant Mail key path is not a regular file".into());
            }
        }

        atomic_private_write(&destination, value.as_bytes(), "Assistant Mail key")
    }

    fn delete(&self) -> Result<(), String> {
        if !validate_existing_layout(&self.vault_root, &self.dir())? {
            return Ok(());
        }
        let path = self.path();
        match fs::symlink_metadata(&path) {
            Ok(meta) => {
                reject_symlink(&meta, "Assistant Mail key")?;
                if !meta.is_file() {
                    return Err("Assistant Mail key path is not a regular file".into());
                }
                require_private_permissions(&meta, "Assistant Mail key file")?;
                fs::remove_file(path)
                    .map_err(|_| "could not delete Assistant Mail key file".to_string())?;
                sync_directory(&self.dir(), "Assistant Mail key")
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("could not inspect Assistant Mail key file".into()),
        }
    }
}

pub fn configured_vault_root() -> Result<Option<PathBuf>, String> {
    let path = if let Ok(value) = std::env::var("NOTEMD_SHARED_CONFIG") {
        PathBuf::from(value)
    } else {
        let base = dirs::config_dir().ok_or("note.md config directory is unavailable")?;
        base.join("net.notemd.app").join("shared.json")
    };
    configured_vault_root_at(&path)
}

fn configured_vault_root_at(path: &Path) -> Result<Option<PathBuf>, String> {
    let text = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("could not read note.md shared configuration".into()),
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let root = value
        .get("sotvault")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if root.as_ref().is_some_and(|path| !path.is_absolute()) {
        return Err("configured Vault root must be an absolute path".into());
    }
    Ok(root.filter(|path| path.is_dir()))
}

fn create_private_layout(
    vault_root: &Path,
    plugin_dir: &Path,
    local_dir: &Path,
) -> Result<(), String> {
    if !vault_root.is_dir() {
        return Err("configured Vault root is not a directory".into());
    }
    let notemd_dir = vault_root.join(".notemd");
    create_checked_dir(&notemd_dir, false)?;
    create_checked_dir(plugin_dir, true)?;
    create_checked_dir(local_dir, true)
}

fn validate_existing_layout(vault_root: &Path, local_dir: &Path) -> Result<bool, String> {
    if !vault_root.is_dir() {
        return Err("configured Vault root is not a directory".into());
    }
    for (path, private) in [
        (vault_root.join(".notemd"), false),
        (vault_root.join(RELATIVE_DIR), true),
        (local_dir.to_path_buf(), true),
    ] {
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("could not inspect Assistant Mail Vault directory".into()),
        };
        reject_symlink(&meta, "Assistant Mail Vault directory")?;
        if !meta.is_dir() {
            return Err("Assistant Mail Vault path is not a directory".into());
        }
        if private {
            ensure_private_directory_permissions(&path, &meta, "Assistant Mail Vault directory")?;
        }
    }
    let ignore = vault_root.join(RELATIVE_DIR).join(".gitignore");
    let meta = fs::symlink_metadata(ignore)
        .map_err(|_| "Assistant Mail .gitignore is missing or unreadable")?;
    reject_symlink(&meta, "Assistant Mail .gitignore")?;
    if !meta.is_file() {
        return Err("Assistant Mail .gitignore path is not a regular file".into());
    }
    Ok(true)
}

fn create_checked_dir(path: &Path, private: bool) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            reject_symlink(&meta, "Assistant Mail Vault directory")?;
            if !meta.is_dir() {
                return Err("Assistant Mail Vault path is not a directory".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| "could not create Assistant Mail Vault directory")?;
        }
        Err(_) => return Err("could not inspect Assistant Mail Vault directory".into()),
    }
    #[cfg(unix)]
    if private {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "could not restrict Assistant Mail Vault directory")?;
    }
    Ok(())
}

fn ensure_gitignore(dir: &Path) -> Result<(), String> {
    let path = dir.join(".gitignore");
    let mut existing = String::new();
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            reject_symlink(&meta, "Assistant Mail .gitignore")?;
            if !meta.is_file() {
                return Err("Assistant Mail .gitignore path is not a regular file".into());
            }
            if meta.len() > MAX_GITIGNORE_BYTES {
                return Err("Assistant Mail .gitignore is unexpectedly large".into());
            }
            existing = fs::read_to_string(&path)
                .map_err(|_| "could not read Assistant Mail .gitignore")?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("could not inspect Assistant Mail .gitignore".into()),
    }
    if existing.lines().next_back() == Some(IGNORE_RULE) {
        return Ok(());
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(IGNORE_RULE);
    next.push('\n');
    atomic_private_write(&path, next.as_bytes(), "Assistant Mail .gitignore")
}

fn verify_git_state(vault_root: &Path) -> Result<(), String> {
    let inside = Command::new("git")
        .args(["-C"])
        .arg(vault_root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let inside = match inside {
        Ok(status) if status.success() => true,
        Ok(_) => false,
        Err(_) if vault_root.join(".git").exists() => {
            return Err("could not verify that the Assistant Mail key is excluded from Git".into())
        }
        Err(_) => false,
    };
    if !inside {
        return Ok(());
    }

    let tracked = Command::new("git")
        .args(["-C"])
        .arg(vault_root)
        .args(["ls-files", "--error-unmatch", "--", RELATIVE_KEY_PATH])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "could not verify Assistant Mail key Git state")?;
    if tracked.success() {
        return Err(
            "Assistant Mail key is already tracked by Git; rotate the Worker key before continuing"
                .into(),
        );
    }

    let ignored = Command::new("git")
        .args(["-C"])
        .arg(vault_root)
        .args([
            "check-ignore",
            "--no-index",
            "--quiet",
            "--",
            RELATIVE_KEY_PATH,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "could not verify Assistant Mail key Git ignore state")?;
    if !ignored.success() {
        return Err("Assistant Mail key is not excluded from Git".into());
    }
    Ok(())
}

fn atomic_private_write(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{label} has no parent directory"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch")?
        .as_nanos();
    let temporary = dir.join(format!(".access-key.tmp-{}-{nonce}", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let write_result = (|| -> Result<(), String> {
        let mut file = options
            .open(&temporary)
            .map_err(|_| format!("could not create temporary {label} file"))?;
        file.write_all(bytes)
            .map_err(|_| format!("could not write {label} file"))?;
        file.sync_all()
            .map_err(|_| format!("could not flush {label} file"))?;
        drop(file);
        set_private_file_permissions(&temporary, label)?;
        fs::rename(&temporary, path).map_err(|_| format!("could not replace {label} file"))?;
        sync_directory(dir, label)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn reject_symlink(meta: &fs::Metadata, label: &str) -> Result<(), String> {
    if meta.file_type().is_symlink() {
        Err(format!("{label} must not be a symbolic link"))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path, label: &str) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| format!("could not restrict {label} file"))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path, _label: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn require_private_permissions(meta: &fs::Metadata, label: &str) -> Result<(), String> {
    if meta.permissions().mode() & 0o077 != 0 {
        Err(format!(
            "{label} permissions must not allow group or other access"
        ))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn ensure_private_directory_permissions(
    path: &Path,
    meta: &fs::Metadata,
    label: &str,
) -> Result<(), String> {
    let mode = meta.permissions().mode();
    if mode & 0o022 != 0 {
        return Err(format!(
            "{label} permissions must not allow group or other write access"
        ));
    }
    if mode & 0o077 == 0 {
        return Ok(());
    }

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| format!("could not restrict {label}"))?;
    let repaired = fs::symlink_metadata(path)
        .map_err(|_| format!("could not inspect {label} after restricting permissions"))?;
    reject_symlink(&repaired, label)?;
    if !repaired.is_dir() {
        return Err(format!("{label} path is not a directory"));
    }
    require_private_permissions(&repaired, label)
}

#[cfg(not(unix))]
fn ensure_private_directory_permissions(
    _path: &Path,
    _meta: &fs::Metadata,
    _label: &str,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(unix))]
fn require_private_permissions(_meta: &fs::Metadata, _label: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path, label: &str) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| format!("could not flush {label} directory"))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path, _label: &str) -> Result<(), String> {
    Ok(())
}

pub fn validate_access_key(value: &str) -> Result<(), String> {
    let len = value.as_bytes().len();
    if !(32..=512).contains(&len) {
        return Err("access key must contain 32 to 512 bytes".into());
    }
    if value.chars().any(char::is_whitespace) {
        return Err("access key must not contain whitespace".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_key_validation_rejects_short_and_whitespace() {
        assert!(validate_access_key("short").is_err());
        assert!(validate_access_key(&format!("{} {}", "a".repeat(20), "b".repeat(20))).is_err());
        assert!(validate_access_key(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn vault_store_round_trips_overwrites_and_deletes() {
        let vault = tempfile::tempdir().unwrap();
        let store = VaultCredentialStore::new(vault.path().to_path_buf());
        assert_eq!(store.get().unwrap(), None);
        store.set(&"a".repeat(32)).unwrap();
        assert_eq!(store.get().unwrap(), Some("a".repeat(32)));
        store.set(&"b".repeat(64)).unwrap();
        assert_eq!(store.get().unwrap(), Some("b".repeat(64)));
        let ignore =
            fs::read_to_string(vault.path().join(RELATIVE_DIR).join(".gitignore")).unwrap();
        assert_eq!(ignore, ".local/\n");
        store.delete().unwrap();
        assert_eq!(store.get().unwrap(), None);
        store.delete().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn vault_store_uses_private_permissions() {
        let vault = tempfile::tempdir().unwrap();
        let store = VaultCredentialStore::new(vault.path().to_path_buf());
        store.set(&"a".repeat(32)).unwrap();
        let plugin_mode = fs::metadata(vault.path().join(RELATIVE_DIR))
            .unwrap()
            .permissions()
            .mode();
        let dir_mode = fs::metadata(vault.path().join(RELATIVE_LOCAL_DIR))
            .unwrap()
            .permissions()
            .mode();
        let file_mode = fs::metadata(vault.path().join(RELATIVE_KEY_PATH))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(plugin_mode & 0o777, 0o700);
        assert_eq!(dir_mode & 0o777, 0o700);
        assert_eq!(file_mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn get_repairs_read_only_directory_permission_drift() {
        let vault = tempfile::tempdir().unwrap();
        let store = VaultCredentialStore::new(vault.path().to_path_buf());
        store.set(&"a".repeat(32)).unwrap();
        for path in [
            vault.path().join(RELATIVE_DIR),
            vault.path().join(RELATIVE_LOCAL_DIR),
        ] {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }

        assert_eq!(store.get().unwrap(), Some("a".repeat(32)));
        for path in [
            vault.path().join(RELATIVE_DIR),
            vault.path().join(RELATIVE_LOCAL_DIR),
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn get_refuses_group_writable_private_directory() {
        let vault = tempfile::tempdir().unwrap();
        let store = VaultCredentialStore::new(vault.path().to_path_buf());
        store.set(&"a".repeat(32)).unwrap();
        let plugin_dir = vault.path().join(RELATIVE_DIR);
        fs::set_permissions(&plugin_dir, fs::Permissions::from_mode(0o770)).unwrap();

        assert!(store.get().unwrap_err().contains("write access"));
        assert_eq!(
            fs::metadata(plugin_dir).unwrap().permissions().mode() & 0o777,
            0o770
        );
    }

    #[cfg(unix)]
    #[test]
    fn vault_store_refuses_a_symlink_key() {
        use std::os::unix::fs::symlink;
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let store = VaultCredentialStore::new(vault.path().to_path_buf());
        store.set(&"a".repeat(32)).unwrap();
        fs::remove_file(vault.path().join(RELATIVE_KEY_PATH)).unwrap();
        symlink(outside.path(), vault.path().join(RELATIVE_KEY_PATH)).unwrap();
        assert!(store.get().unwrap_err().contains("symbolic link"));
        assert!(store
            .set(&"a".repeat(32))
            .unwrap_err()
            .contains("symbolic link"));
        assert!(store.delete().unwrap_err().contains("symbolic link"));
    }

    #[cfg(unix)]
    #[test]
    fn vault_store_refuses_a_symlinked_internal_directory() {
        use std::os::unix::fs::symlink;
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(vault.path().join(".notemd")).unwrap();
        symlink(outside.path(), vault.path().join(RELATIVE_DIR)).unwrap();
        let store = VaultCredentialStore::new(vault.path().to_path_buf());
        assert!(store
            .set(&"a".repeat(32))
            .unwrap_err()
            .contains("symbolic link"));
        assert!(!outside.path().join(".local/access-key").exists());
    }

    #[cfg(unix)]
    #[test]
    fn get_and_delete_refuse_a_symlinked_parent_directory() {
        use std::os::unix::fs::symlink;
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(vault.path().join(".notemd")).unwrap();
        fs::create_dir(vault.path().join(RELATIVE_DIR)).unwrap();
        fs::set_permissions(
            vault.path().join(RELATIVE_DIR),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::write(
            vault.path().join(RELATIVE_DIR).join(".gitignore"),
            ".local/\n",
        )
        .unwrap();
        fs::write(outside.path().join("access-key"), "a".repeat(32)).unwrap();
        symlink(outside.path(), vault.path().join(RELATIVE_LOCAL_DIR)).unwrap();
        let store = VaultCredentialStore::new(vault.path().to_path_buf());
        assert!(store.get().unwrap_err().contains("symbolic link"));
        assert!(store.delete().unwrap_err().contains("symbolic link"));
        assert!(outside.path().join("access-key").exists());
    }

    #[cfg(unix)]
    #[test]
    fn get_rejects_permissions_that_expose_the_key() {
        let vault = tempfile::tempdir().unwrap();
        let store = VaultCredentialStore::new(vault.path().to_path_buf());
        store.set(&"a".repeat(32)).unwrap();
        fs::set_permissions(
            vault.path().join(RELATIVE_KEY_PATH),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(store.get().unwrap_err().contains("permissions"));
    }

    #[test]
    fn git_negation_is_repaired_and_tracked_keys_fail_closed() {
        let vault = tempfile::tempdir().unwrap();
        assert!(Command::new("git")
            .arg("init")
            .arg("--quiet")
            .arg(vault.path())
            .status()
            .unwrap()
            .success());
        let store = VaultCredentialStore::new(vault.path().to_path_buf());
        store.set(&"a".repeat(32)).unwrap();
        let ignore_path = vault.path().join(RELATIVE_DIR).join(".gitignore");
        let mut ignore = OpenOptions::new().append(true).open(&ignore_path).unwrap();
        writeln!(ignore, "!.local/\n!.local/access-key").unwrap();
        assert!(store.get().unwrap_err().contains("not excluded from Git"));
        store.set(&"a".repeat(32)).unwrap();
        assert_eq!(
            fs::read_to_string(&ignore_path)
                .unwrap()
                .lines()
                .next_back(),
            Some(IGNORE_RULE)
        );
        assert!(Command::new("git")
            .args(["-C"])
            .arg(vault.path())
            .args(["add", "--force", "--", RELATIVE_KEY_PATH])
            .status()
            .unwrap()
            .success());
        assert!(store.get().unwrap_err().contains("already tracked"));
        assert!(store
            .set(&"b".repeat(32))
            .unwrap_err()
            .contains("already tracked"));
    }

    #[test]
    fn shared_config_resolves_the_configured_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let config = dir.path().join("shared.json");
        fs::write(
            &config,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "sotvault": vault.path(),
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            configured_vault_root_at(&config).unwrap(),
            Some(vault.path().to_path_buf())
        );
        fs::write(&config, r#"{"version":1}"#).unwrap();
        assert_eq!(configured_vault_root_at(&config).unwrap(), None);
        fs::write(&config, r#"{"version":1,"sotvault":"relative"}"#).unwrap();
        assert!(configured_vault_root_at(&config).is_err());
        fs::write(&config, b"not json").unwrap();
        assert_eq!(configured_vault_root_at(&config).unwrap(), None);
        fs::write(
            &config,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "sotvault": dir.path().join("missing"),
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(configured_vault_root_at(&config).unwrap(), None);
    }
}
