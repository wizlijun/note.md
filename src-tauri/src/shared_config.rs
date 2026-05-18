use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SharedConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sotvault: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rawvault: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibre_path: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub exlibris: serde_json::Value,
}

fn default_version() -> u32 { 1 }

pub fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Library/Application Support/com.laobu.mdeditor-shared/config.json")
}

pub fn read(path: &Path) -> std::io::Result<SharedConfig> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_else(|_| SharedConfig {
            version: 1, ..Default::default()
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SharedConfig {
            version: 1, ..Default::default()
        }),
        Err(e) => Err(e),
    }
}

pub fn write(path: &Path, cfg: &SharedConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn read_missing_returns_default() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.json");
        let cfg = read(&p).unwrap();
        assert_eq!(cfg.version, 1);
        assert_eq!(cfg.sotvault, None);
    }

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.json");
        let cfg = SharedConfig {
            version: 1,
            sotvault: Some("/tmp/sot".into()),
            rawvault: Some("/tmp/raw".into()),
            calibre_path: Some("/Applications/calibre.app/Contents/MacOS".into()),
            exlibris: serde_json::Value::Null,
        };
        write(&p, &cfg).unwrap();
        let back = read(&p).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn write_uses_atomic_tmp_rename() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.json");
        let cfg = SharedConfig::default();
        write(&p, &cfg).unwrap();
        assert!(p.exists());
        assert!(!p.with_extension("json.tmp").exists());
    }

    #[test]
    fn corrupted_file_falls_back_to_default() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.json");
        std::fs::write(&p, "{ not valid json").unwrap();
        let cfg = read(&p).unwrap();
        assert_eq!(cfg.version, 1);
    }
}
