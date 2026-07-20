//! Paired-device registry, stored at `<data_dir>/devices.json`.
//!
//! v1 kept this under Tauri's settings.json (`plugins.openclaw-chat.devices`);
//! v2 owns a plain JSON array file in the host-provided data_dir.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub device_id: String,
    pub hostname: String,
    pub status: DeviceStatus,
    pub last_seen: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus { Active, Revoked }

fn devices_path(data_dir: &Path) -> PathBuf {
    data_dir.join("devices.json")
}

pub fn read_all(data_dir: &Path) -> Vec<Device> {
    match std::fs::read_to_string(devices_path(data_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn write_all(data_dir: &Path, devices: &[Device]) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let s = serde_json::to_string_pretty(devices).map_err(|e| e.to_string())?;
    std::fs::write(devices_path(data_dir), s).map_err(|e| e.to_string())
}

pub fn upsert(data_dir: &Path, d: Device) -> Result<(), String> {
    let mut all = read_all(data_dir);
    if let Some(existing) = all.iter_mut().find(|x| x.device_id == d.device_id) {
        *existing = d;
    } else {
        all.push(d);
    }
    write_all(data_dir, &all)
}

pub fn set_status(data_dir: &Path, device_id: &str, status: DeviceStatus) -> Result<(), String> {
    let mut all = read_all(data_dir);
    if let Some(d) = all.iter_mut().find(|x| x.device_id == device_id) {
        d.status = status;
    }
    write_all(data_dir, &all)
}

pub fn forget(data_dir: &Path, device_id: &str) -> Result<(), String> {
    let mut all = read_all(data_dir);
    all.retain(|d| d.device_id != device_id);
    write_all(data_dir, &all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_missing_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_all(dir.path()).is_empty());
    }

    #[test]
    fn upsert_inserts_then_updates() {
        let dir = tempfile::tempdir().unwrap();
        upsert(dir.path(), Device {
            device_id: "d1".into(), hostname: "mac".into(),
            status: DeviceStatus::Active, last_seen: None,
        }).unwrap();
        let all = read_all(dir.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].hostname, "mac");

        // Same id → replace, not append.
        upsert(dir.path(), Device {
            device_id: "d1".into(), hostname: "mac-renamed".into(),
            status: DeviceStatus::Active, last_seen: Some(42),
        }).unwrap();
        let all = read_all(dir.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].hostname, "mac-renamed");
        assert_eq!(all[0].last_seen, Some(42));
    }

    #[test]
    fn set_status_and_forget() {
        let dir = tempfile::tempdir().unwrap();
        upsert(dir.path(), Device {
            device_id: "d1".into(), hostname: "a".into(),
            status: DeviceStatus::Active, last_seen: None,
        }).unwrap();
        upsert(dir.path(), Device {
            device_id: "d2".into(), hostname: "b".into(),
            status: DeviceStatus::Active, last_seen: None,
        }).unwrap();

        set_status(dir.path(), "d1", DeviceStatus::Revoked).unwrap();
        let all = read_all(dir.path());
        assert_eq!(all.iter().find(|d| d.device_id == "d1").unwrap().status, DeviceStatus::Revoked);

        forget(dir.path(), "d1").unwrap();
        let all = read_all(dir.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].device_id, "d2");
    }
}
