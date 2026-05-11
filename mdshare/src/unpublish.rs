use crate::ipc::{Action, Request, Response, toast_error};
use serde_json::{json, Map, Value};

const PLUGIN_NAME: &str = "Share";

pub fn run(req: Request) -> Response {
    let path = match req.context.tab.path.as_deref() {
        Some(p) => p.to_string(),
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "无路径，无法撤销", None)]),
    };
    let settings = req.settings.unwrap_or_default();
    let base_url = match settings.get("share.baseUrl").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.trim_end_matches('/').to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "未配置 Service Base URL", None)]),
    };
    let api_key = match settings.get("share.apiKey").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "未配置 API Key", None)]),
    };

    let mut records: Map<String, Value> = settings
        .get("share.records")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let record = match records.get(&path).and_then(|v| v.as_object()).cloned() {
        Some(r) => r,
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "本文件未分享过", None)]),
    };
    let edit_token = record.get("edit_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if edit_token.is_empty() {
        return Response::fail(vec![toast_error(PLUGIN_NAME, "本地分享记录损坏", None)]);
    }

    let kind = record.get("kind").and_then(|v| v.as_str()).unwrap_or("html");
    let url = if kind == "image" {
        let id = record.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let ext = record.get("ext").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() || ext.is_empty() {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "本地分享记录损坏（缺 id/ext）", None,
            )]);
        }
        format!("{base_url}/f/{id}.{ext}")
    } else {
        let slug = record.get("slug").and_then(|v| v.as_str()).unwrap_or("");
        if slug.is_empty() {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "本地分享记录损坏（缺 slug）", None,
            )]);
        }
        format!("{base_url}/{slug}")
    };
    let body = json!({ "edit_token": edit_token });
    let result = ureq::delete(&url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());

    match result {
        Ok(_) => {}
        Err(ureq::Error::Status(404, _)) => {} // already gone — accept it
        Err(ureq::Error::Status(401, r)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "API key 无效", Some(&format!("HTTP 401: {}", r.status_text())),
            )]);
        }
        Err(ureq::Error::Status(403, _)) => {
            return Response::fail(vec![toast_error(PLUGIN_NAME, "无权撤销该分享（edit_token 不匹配）", None)]);
        }
        Err(ureq::Error::Status(s, r)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "撤销失败", Some(&format!("HTTP {s}: {}", r.status_text())),
            )]);
        }
        Err(ureq::Error::Transport(t)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "网络错误，请检查网络", Some(&t.to_string()),
            )]);
        }
    }

    records.remove(&path);
    let mut patch = Map::new();
    patch.insert("share.records".to_string(), Value::Object(records));
    let slug_value = if kind == "image" {
        record.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()
    } else {
        record.get("slug").and_then(|v| v.as_str()).unwrap_or("").to_string()
    };
    let mut cli_data = serde_json::Map::new();
    cli_data.insert("slug".to_string(), serde_json::Value::String(slug_value));
    cli_data.insert("removed".to_string(), serde_json::Value::Bool(true));
    Response::ok(vec![
        Action::SettingsMerge { patch },
        Action::Toast { level: "success".into(), message: "✅ 已撤销分享".into(), detail: None },
        crate::ipc::cli_result(cli_data),
    ])
}
