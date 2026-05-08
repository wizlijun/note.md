use crate::ipc::{Action, Request, Response, toast_error};

const PLUGIN_NAME: &str = "Share";

pub fn run(req: Request) -> Response {
    let path = match req.context.tab.path.as_deref() {
        Some(p) => p.to_string(),
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "无路径，无法复制链接", None)]),
    };
    let settings = req.settings.unwrap_or_default();
    let records = match settings.get("share.records").and_then(|v| v.as_object()) {
        Some(r) => r,
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "本文件未分享过", None)]),
    };
    let record = match records.get(&path).and_then(|v| v.as_object()) {
        Some(r) => r,
        None => return Response::fail(vec![toast_error(PLUGIN_NAME, "本文件未分享过", None)]),
    };
    let url = match record.get("url").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "本地分享记录损坏", None)]),
    };
    Response::ok(vec![
        Action::ClipboardWrite { text: url.clone() },
        Action::Toast {
            level: "success".into(),
            message: format!("✅ 已复制：{url}"),
            detail: None,
        },
    ])
}
