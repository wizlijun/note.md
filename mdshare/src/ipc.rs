use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize, Debug)]
pub struct Request {
    pub command: String,
    pub context: Context,
    #[serde(default)]
    pub settings: Option<Map<String, Value>>,
}

#[derive(Deserialize, Debug)]
pub struct Context {
    pub tab: TabMeta,
    #[serde(default)]
    pub rendered_html: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct TabMeta {
    pub path: Option<String>,
    pub filename: Option<String>,
    /// Vault-relative share src, pre-computed by the host (audience→vault map).
    #[serde(default)]
    pub src: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Response {
    pub success: bool,
    pub actions: Vec<Action>,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type")]
pub enum Action {
    #[serde(rename = "toast")]
    Toast {
        level: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    #[serde(rename = "clipboard.write")]
    ClipboardWrite { text: String },
    #[serde(rename = "settings.merge")]
    SettingsMerge { patch: Map<String, Value> },
    #[serde(rename = "cli.result")]
    CliResult { data: Map<String, Value> },
}

impl Response {
    pub fn ok(actions: Vec<Action>) -> Self {
        Self { success: true, actions }
    }
    pub fn fail(actions: Vec<Action>) -> Self {
        Self { success: false, actions }
    }
}

pub fn toast_error(name: &str, message_zh: &str, detail: Option<&str>) -> Action {
    Action::Toast {
        level: "error".into(),
        message: format!("❌ {name}: {message_zh}"),
        detail: detail.map(|s| s.to_string()),
    }
}

pub fn cli_result(data: Map<String, Value>) -> Action {
    Action::CliResult { data }
}
