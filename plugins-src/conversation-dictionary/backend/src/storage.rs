use crate::model::{Baseline, ControlState, Dictionary, Settings, DEFAULT_DICTIONARY_PATH};
use fs2::FileExt;
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub const SETTINGS_PATH: &str = ".notemd/conversation-dictionary.json";
pub const CONTROL_DIR: &str = ".notemd/conversation-dictionary";

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn validate_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.starts_with('/') || value.contains('\0') {
        return Err("path must be a non-empty Vault-relative path".into());
    }
    let path = Path::new(value);
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err("path contains an unsafe component".into()),
        }
    }
    let extension = path
        .extension()
        .and_then(|part| part.to_str())
        .unwrap_or("");
    if !matches!(extension, "yml" | "yaml") {
        return Err("dictionary path must end in .yml or .yaml".into());
    }
    Ok(path.to_path_buf())
}

pub fn resolve_inside(vault: &Path, relative: &Path) -> Result<PathBuf, String> {
    let joined = vault.join(relative);
    let mut cursor = vault.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err("unsafe Vault-relative path".into());
        };
        cursor.push(part);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "path crosses a symbolic link: {}",
                    cursor.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(joined)
}

pub fn ensure_safe_parent(vault: &Path, relative: &Path) -> Result<PathBuf, String> {
    let path = resolve_inside(vault, relative)?;
    let parent = relative.parent().ok_or("path has no parent")?;
    let mut cursor = vault.to_path_buf();
    for component in parent.components() {
        let Component::Normal(part) = component else {
            return Err("unsafe Vault-relative path".into());
        };
        cursor.push(part);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "path crosses a symbolic link: {}",
                    cursor.display()
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!(
                    "path component is not a directory: {}",
                    cursor.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&cursor)
                    .map_err(|error| format!("{}: {error}", cursor.display()))?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    resolve_inside(vault, relative)?;
    Ok(path)
}

pub fn load_settings(vault: &Path) -> Result<Settings, String> {
    let path = vault.join(SETTINGS_PATH);
    if !path.exists() {
        return Ok(Settings::default());
    }
    let value: Settings = read_json(&path)?;
    if value.schema != crate::model::SETTINGS_SCHEMA {
        return Err(format!("unsupported settings schema '{}'", value.schema));
    }
    validate_relative_path(&value.dictionary_path)?;
    Ok(value)
}

pub fn save_settings(vault: &Path, settings: &Settings) -> Result<(), String> {
    validate_relative_path(&settings.dictionary_path)?;
    atomic_json(&vault.join(SETTINGS_PATH), settings)
}

pub fn dictionary_path(vault: &Path) -> Result<PathBuf, String> {
    let settings = load_settings(vault)?;
    let relative = validate_relative_path(&settings.dictionary_path)?;
    resolve_inside(vault, &relative)
}

pub fn control_path(vault: &Path) -> PathBuf {
    vault.join(CONTROL_DIR).join("control.json")
}

pub fn journal_path(vault: &Path) -> PathBuf {
    vault.join(CONTROL_DIR).join("journal.json")
}

pub fn lock_file(vault: &Path) -> Result<File, String> {
    let path = vault.join(CONTROL_DIR).join("write.lock");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.lock_exclusive().map_err(|error| error.to_string())?;
    Ok(file)
}

pub fn load_control(vault: &Path) -> Result<ControlState, String> {
    let path = control_path(vault);
    if !path.exists() {
        return Ok(ControlState::default());
    }
    read_json(&path)
}

pub fn save_control(vault: &Path, control: &ControlState) -> Result<(), String> {
    atomic_json(&control_path(vault), control)
}

pub fn read_dictionary(path: &Path) -> Result<(Dictionary, Vec<u8>), String> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let dictionary: Dictionary = serde_yaml::from_slice(&bytes)
        .map_err(|error| format!("invalid dictionary YAML: {error}"))?;
    Ok((dictionary, bytes))
}

pub fn verified_dictionary(vault: &Path) -> Result<(Dictionary, Baseline), String> {
    let path = dictionary_path(vault)?;
    let (dictionary, bytes) = read_dictionary(&path)?;
    let baseline = load_control(vault)?
        .baseline
        .ok_or("dictionary has no locally reviewed baseline")?;
    let hash = sha256(&bytes);
    if hash != baseline.sha256
        || dictionary.dictionary_id != baseline.dictionary_id
        || dictionary.revision != baseline.revision
    {
        return Err("dictionary changed outside the reviewed plugin transaction".into());
    }
    Ok((dictionary, baseline))
}

pub fn dictionary_bytes(dictionary: &Dictionary) -> Result<Vec<u8>, String> {
    let mut stable = dictionary.clone();
    stable.domains.sort_by(|left, right| left.id.cmp(&right.id));
    stable.entries.sort_by(|left, right| left.id.cmp(&right.id));
    stable.rules.sort_by(|left, right| left.id.cmp(&right.id));
    serde_yaml::to_string(&stable)
        .map(|text| text.into_bytes())
        .map_err(|error| error.to_string())
}

pub fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_bytes_inner(path, bytes, None)
}

pub fn atomic_bytes_if_sha256(path: &Path, bytes: &[u8], expected: &str) -> Result<(), String> {
    atomic_bytes_inner(path, bytes, Some(expected))
}

fn atomic_bytes_inner(path: &Path, bytes: &[u8], expected: Option<&str>) -> Result<(), String> {
    let parent = path.parent().ok_or("path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("write"),
        uuid::Uuid::new_v4()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if let Some(expected) = expected {
        let current = match fs::read(path) {
            Ok(current) => current,
            Err(error) => {
                let _ = fs::remove_file(&temp);
                return Err(format!("{}: {error}", path.display()));
            }
        };
        if sha256(&current) != expected {
            let _ = fs::remove_file(&temp);
            return Err("dictionary changed before the reviewed transaction could be saved".into());
        }
    }
    fs::rename(&temp, path).map_err(|error| error.to_string())?;
    File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn atomic_bytes_create_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("path has no parent")?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("write"),
        uuid::Uuid::new_v4()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    let published = fs::hard_link(&temp, path).map_err(|error| {
        format!(
            "refusing to overwrite existing file {}: {error}",
            path.display()
        )
    });
    let _ = fs::remove_file(&temp);
    published?;
    File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    atomic_bytes(path, &bytes)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

pub fn default_dictionary_relative() -> &'static str {
    DEFAULT_DICTIONARY_PATH
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conditional_atomic_write_preserves_an_unexpected_preimage() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("dictionary.yml");
        fs::write(&path, b"external change").unwrap();

        let error = atomic_bytes_if_sha256(&path, b"reviewed change", &sha256(b"old baseline"))
            .unwrap_err();

        assert!(error.contains("changed before"));
        assert_eq!(fs::read(path).unwrap(), b"external change");
    }
}
