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
    let plugins = store.get("plugins").unwrap_or(serde_json::json!({}));
    plugins.get("openclaw-chat")
        .and_then(|oc| oc.get("devices"))
        .and_then(|v| serde_json::from_value::<Vec<Device>>(v.clone()).ok())
        .unwrap_or_default()
}

pub fn write_all(app: &tauri::AppHandle, devices: &[Device]) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    use serde_json::json;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let mut plugins = store.get("plugins")
        .and_then(|v| if v.is_object() { Some(v) } else { None })
        .unwrap_or_else(|| json!({}));
    let devs_val = serde_json::to_value(devices).map_err(|e| e.to_string())?;
    let oc = plugins.get_mut("openclaw-chat")
        .and_then(|v| v.as_object_mut());
    if let Some(oc) = oc {
        oc.insert("devices".to_string(), devs_val);
    } else {
        let mut oc_map = serde_json::Map::new();
        oc_map.insert("devices".to_string(), devs_val);
        plugins.as_object_mut()
            .ok_or_else(|| "plugins must be object".to_string())?
            .insert("openclaw-chat".to_string(), serde_json::Value::Object(oc_map));
    }
    store.set("plugins".to_string(), plugins);
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
