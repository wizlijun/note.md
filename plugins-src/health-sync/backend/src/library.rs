//! Explicit, durable selection of a raw-data directory outside the vault.
use crate::store::hash;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
type Result<T> = std::result::Result<T, String>;
const MARKER: &str = ".notemd-health-library";
#[derive(Serialize, Deserialize)]
struct Config {
    path: PathBuf,
    identity: String,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn vault_path(vault: &Path) -> Result<PathBuf> {
    let path = vault.canonicalize().map_err(|e| format!("Vault: {e}"))?;
    if !path.is_dir() {
        return Err("Vault must be an existing directory".into());
    }
    Ok(path)
}
fn config_path(vault: &Path, state: &Path) -> Result<PathBuf> {
    Ok(state
        .join(hash(vault_path(vault)?.to_string_lossy().as_bytes()))
        .join("library.json"))
}
fn read_config(vault: &Path, state: &Path) -> Result<Option<Config>> {
    let path = config_path(vault, state)?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn validate(vault: &Path, path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err("Health library path must be absolute".into());
    }
    let root = path.canonicalize().map_err(|e| format!("Health library is unavailable; reconnect its disk or select an existing directory: {e}"))?;
    let vault = vault_path(vault)?;
    if !root.is_dir() {
        return Err("Health library must be an existing directory".into());
    }
    if root.starts_with(&vault) || vault.starts_with(&root) {
        return Err("Health raw data must be outside the Vault: neither the Vault, a folder inside it, nor its parent directory is allowed. The Vault stores analysis reports only.".into());
    }
    Ok(root)
}
fn valid_identity(value: &str) -> bool {
    value.strip_prefix("notemd.health-sync:").is_some_and(|id| {
        id.len() == 64
            && id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn marker(path: &Path) -> Result<Option<String>> {
    let path = path.join(MARKER);
    match fs::symlink_metadata(&path) {
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
            Err("Invalid health library identity marker".into())
        }
        Ok(_) => fs::read_to_string(path).map(Some).map_err(err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
pub(crate) fn verify_database(root: &Path) -> Result<()> {
    let path = root.join("health.sqlite");
    let meta=fs::symlink_metadata(&path).map_err(|e|format!("Health library database is missing or unavailable; restore its backup before continuing: {e}"))?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("Health library database must be a regular file, not a symlink".into());
    }
    crate::storage::open(&path, false)?;
    Ok(())
}
fn resolve_config(vault: &Path, config: &Config) -> Result<(PathBuf, String)> {
    if !valid_identity(&config.identity) {
        return Err("Invalid health library identity".into());
    }
    let path = validate(vault, &config.path)?;
    if path != config.path {
        return Err("Health library directory changed; select the original library again".into());
    }
    if marker(&path)?.as_deref() != Some(&config.identity) {
        return Err("Health library identity is missing or changed; reconnect the original library. No new library was created.".into());
    }
    verify_database(&path)?;
    Ok((
        path,
        config
            .identity
            .trim_start_matches("notemd.health-sync:")
            .to_owned(),
    ))
}
/// Resolve both values from one binding read; concurrent folder selection cannot mix libraries.
pub(crate) fn selection(vault: &Path, state: &Path) -> Result<(PathBuf, String)> {
    let config = read_config(vault, state)?
        .ok_or("Choose a health raw-data folder outside the Vault before importing or syncing")?;
    resolve_config(vault, &config)
}
pub fn resolve(vault: &Path, state: &Path) -> Result<PathBuf> {
    Ok(selection(vault, state)?.0)
}
pub fn identity(vault: &Path, state: &Path) -> Result<String> {
    Ok(selection(vault, state)?.1)
}
pub fn status(vault: &Path, state: &Path) -> Result<Value> {
    let vault = vault_path(vault)?;
    let config = read_config(&vault, state)?;
    let resolution = config.as_ref().map(|config| resolve_config(&vault, config));
    let error = resolution.as_ref().and_then(|r| r.as_ref().err());
    Ok(
        json!({"configured":config.is_some(),"path":config.as_ref().map(|c|&c.path),"available":resolution.as_ref().is_some_and(|r|r.is_ok()),"error":error,"library_id":config.as_ref().map(|c|c.identity.trim_start_matches("notemd.health-sync:")),"storage":"sqlite","database":"health.sqlite"}),
    )
}
pub fn configure(vault: &Path, state: &Path, path: &Path) -> Result<Value> {
    let root = validate(vault, path)?;
    let identity = match marker(&root)? {
        Some(value) => {
            if !valid_identity(&value) {
                return Err("Unrecognized health library marker".into());
            }
            verify_database(&root)?;
            value
        }
        None => {
            if fs::read_dir(&root).map_err(err)?.next().is_some() {
                return Err("Select an empty folder for a new health library, or an existing Health Sync library".into());
            }
            crate::storage::initialize(&root.join("health.sqlite"))?;
            let value = format!("notemd.health-sync:{}", hash(&rand::random::<[u8; 32]>()));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(root.join(MARKER))
                .map_err(err)?;
            file.write_all(value.as_bytes()).map_err(err)?;
            file.sync_all().map_err(err)?;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(root.join("write.lock"))
                .map_err(err)?
                .sync_all()
                .map_err(err)?;
            fs::File::open(&root)
                .and_then(|f| f.sync_all())
                .map_err(err)?;
            value
        }
    };
    let target = config_path(vault, state)?;
    let parent = target
        .parent()
        .ok_or("Missing library configuration parent")?;
    fs::create_dir_all(parent).map_err(err)?;
    let mut temp = NamedTempFile::new_in(parent).map_err(err)?;
    serde_json::to_writer(
        &mut temp,
        &Config {
            path: root,
            identity,
        },
    )
    .map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(&target).map_err(err)?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(err)?;
    status(vault, state)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_use_overlap_symlink_and_offline_are_explicit() {
        let t = tempfile::tempdir().unwrap();
        let vault = t.path().join("vault");
        let root = t.path().join("raw");
        let state = t.path().join("state");
        fs::create_dir(&vault).unwrap();
        fs::create_dir(&root).unwrap();
        fs::create_dir(vault.join("sub")).unwrap();
        assert_eq!(status(&vault, &state).unwrap()["configured"], false);
        assert!(resolve(&vault, &state).is_err());
        for invalid in [&vault, &vault.join("sub"), t.path()] {
            assert!(configure(&vault, &state, invalid).is_err());
        }
        #[cfg(unix)]
        {
            let link = t.path().join("alias");
            std::os::unix::fs::symlink(&vault, &link).unwrap();
            assert!(configure(&vault, &state, &link).is_err());
        }
        configure(&vault, &state, &root).unwrap();
        assert_eq!(
            resolve(&vault, &state).unwrap(),
            root.canonicalize().unwrap()
        );
        configure(&vault, &state, &root).unwrap();
        fs::rename(&root, t.path().join("offline")).unwrap();
        assert!(resolve(&vault, &state).is_err());
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        assert!(resolve(&vault, &state).is_err());
        assert_eq!(status(&vault, &state).unwrap()["available"], false);
    }
    #[test]
    fn malformed_identity_cannot_escape_the_local_state_namespace() {
        let t = tempfile::tempdir().unwrap();
        let vault = t.path().join("vault");
        let root = t.path().join("library");
        let state = t.path().join("state");
        fs::create_dir(&vault).unwrap();
        fs::create_dir(&root).unwrap();
        configure(&vault, &state, &root).unwrap();
        for suffix in [
            format!("/{}", "a".repeat(63)),
            format!("../{}", "a".repeat(61)),
            "G".repeat(64),
        ] {
            let malformed = format!("notemd.health-sync:{suffix}");
            fs::write(root.join(MARKER), &malformed).unwrap();
            assert!(configure(&vault, &state, &root).is_err());
            assert!(resolve(&vault, &state).is_err());
            let target = config_path(&vault, &state).unwrap();
            fs::write(
                target,
                serde_json::to_vec(&Config {
                    path: root.canonicalize().unwrap(),
                    identity: malformed,
                })
                .unwrap(),
            )
            .unwrap();
            assert!(resolve(&vault, &state).is_err());
        }
    }
}
