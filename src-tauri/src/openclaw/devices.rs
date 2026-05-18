use serde::{Deserialize, Serialize};

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

pub fn read_all(app: &tauri::AppHandle) -> Vec<Device> {
    use tauri_plugin_store::StoreExt;
    let store = match app.store("settings.json") { Ok(s) => s, Err(_) => return vec![] };
    store.get("openclaw.devices")
        .and_then(|v| serde_json::from_value::<Vec<Device>>(v).ok())
        .unwrap_or_default()
}

pub fn write_all(app: &tauri::AppHandle, devices: &[Device]) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set("openclaw.devices".to_string(), serde_json::to_value(devices).map_err(|e| e.to_string())?);
    Ok(())
}

pub fn upsert(app: &tauri::AppHandle, d: Device) -> Result<(), String> {
    let mut all = read_all(app);
    if let Some(existing) = all.iter_mut().find(|x| x.device_id == d.device_id) {
        *existing = d;
    } else {
        all.push(d);
    }
    write_all(app, &all)
}

pub fn set_status(app: &tauri::AppHandle, device_id: &str, status: DeviceStatus) -> Result<(), String> {
    let mut all = read_all(app);
    if let Some(d) = all.iter_mut().find(|x| x.device_id == device_id) {
        d.status = status;
    }
    write_all(app, &all)
}

pub fn forget(app: &tauri::AppHandle, device_id: &str) -> Result<(), String> {
    let mut all = read_all(app);
    all.retain(|d| d.device_id != device_id);
    write_all(app, &all)
}
