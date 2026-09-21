use crate::render::{self, RenderRequest};
use notemd_plugin_sdk as sdk;
use sdk::plugin_protocol as proto;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

pub struct TypstReaderPlugin {
    data_dir: PathBuf,
    sessions: HashMap<String, render::RenderSession>,
}

impl TypstReaderPlugin {
    pub fn new() -> Self {
        Self {
            data_dir: std::env::temp_dir().join("notemd-typst-reader-uninitialized"),
            sessions: HashMap::new(),
        }
    }
}

impl sdk::NotemdPlugin for TypstReaderPlugin {
    fn initialize(&mut self, _host: &sdk::Host, params: &proto::InitializeParams) {
        self.data_dir = PathBuf::from(&params.data_dir);
    }

    fn activate(
        &mut self,
        _host: &sdk::Host,
        _params: &proto::ActivateParams,
    ) -> Result<(), String> {
        Ok(())
    }

    fn deactivate(&mut self, _host: &sdk::Host) {}

    fn execute_command(
        &mut self,
        _host: &sdk::Host,
        params: &proto::ExecuteCommandParams,
    ) -> Result<Value, String> {
        Err(format!("unknown command '{}'", params.command))
    }

    fn on_ui_request(
        &mut self,
        _host: &sdk::Host,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        match method.strip_prefix("plugin.").unwrap_or(method) {
            "render" => {
                let request: RenderRequest = serde_json::from_value(params)
                    .map_err(|error| format!("invalid render request: {error}"))?;
                let (result, session) = render::prepare(&self.data_dir.join("cache"), &request)?;
                if let Some(session) = session {
                    if self.sessions.len() >= 4 && !self.sessions.contains_key(session.key()) {
                        if let Some(oldest) = self.sessions.keys().next().cloned() {
                            self.sessions.remove(&oldest);
                        }
                    }
                    self.sessions.insert(result.cache_key.clone(), session);
                }
                serde_json::to_value(result).map_err(|error| error.to_string())
            }
            "render-next" => {
                let key = params
                    .get("cache_key")
                    .and_then(Value::as_str)
                    .ok_or("render-next needs cache_key")?;
                let mut session = self
                    .sessions
                    .remove(key)
                    .ok_or("render session is unavailable")?;
                let result = render::render_next(&mut session)?;
                if !result.complete {
                    self.sessions.insert(key.to_string(), session);
                }
                serde_json::to_value(result).map_err(|error| error.to_string())
            }
            "page" => {
                let key = params
                    .get("cache_key")
                    .and_then(Value::as_str)
                    .ok_or("page needs cache_key")?;
                let page_index = params
                    .get("page")
                    .and_then(Value::as_u64)
                    .ok_or("page needs a non-negative page")?
                    as usize;
                let svg = if let Some(session) = self.sessions.get(key) {
                    render::session_page(session, page_index)?
                } else {
                    render::page(&self.data_dir.join("cache"), key, page_index)?
                };
                Ok(json!({ "svg": svg }))
            }
            other => Err(format!("unknown ui method '{other}'")),
        }
    }
}
