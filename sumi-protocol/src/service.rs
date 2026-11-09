//! Optional private-service capabilities; existing fonts/sound keep version 1.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const OBSERVE_PAGE: &str = "durability.observe_page.v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Hello {
    pub version: u32,
    pub instance: String,
    /// Older backends did not advertise capabilities.
    #[serde(default)]
    pub capabilities: Vec<String>,
}
impl Hello {
    pub fn check_request(&self, method: &str, payload: &Value) -> Result<(), String> {
        if method == "durability" && payload.get("method").and_then(Value::as_str) == Some("observe_page")
            && !self.capabilities.iter().any(|capability| capability == OBSERVE_PAGE) {
            return Err("Sumi 插件版本过旧，缺少安全的本机文件读取能力。请更新 Sumi 插件后重新打开；本机稿件仍保留".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn legacy_hello_requires_upgrade_only_for_atomic_observation() {
        let old: Hello = serde_json::from_value(json!({"version":1,"instance":"legacy"})).unwrap();
        assert!(old.check_request("durability", &json!({"method":"observe_page"})).unwrap_err().contains("请更新 Sumi 插件"));
        for (method, payload) in [("sound", json!({"operation":"play"})), ("fonts", json!({"operation":"statuses"})),
            ("durability", json!({"method":"commit_local"})), ("durability", json!({"method":"load"}))] {
            old.check_request(method, &payload).unwrap();
        }
        let mut current = old;
        current.capabilities.push(OBSERVE_PAGE.into());
        current.check_request("durability", &json!({"method":"observe_page"})).unwrap();
    }
}
