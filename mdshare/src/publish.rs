use crate::ipc::{Action, Request, Response, toast_error};
use crate::slug;
use rand::RngCore;
use serde_json::{json, Map, Value};
use time::OffsetDateTime;

const PLUGIN_NAME: &str = "Share";

pub fn run(req: Request) -> Response {
    let tab = &req.context.tab;
    let path = match tab.path.as_deref() {
        Some(p) => p.to_string(),
        None => {
            return Response::fail(vec![toast_error(PLUGIN_NAME, "请先保存文件", None)]);
        }
    };
    let filename = tab.filename.clone().unwrap_or_else(|| "untitled".to_string());

    let settings = req.settings.unwrap_or_default();
    let base_url = match settings.get("share.baseUrl").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.trim_end_matches('/').to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "未配置 Service Base URL", None)]),
    };
    let api_key = match settings.get("share.apiKey").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Response::fail(vec![toast_error(PLUGIN_NAME, "未配置 API Key", None)]),
    };

    // Early branch: image files go through /upload instead of /publish.
    let ext = path
        .rsplit('.')
        .next()
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if let Some(mime) = ext_to_mime(&ext) {
        return run_image_upload(&path, &filename, &ext, mime, &settings, &base_url, &api_key);
    }

    let html = match req.context.rendered_html.as_deref() {
        Some(s) if !s.is_empty() => s,
        _ => {
            return Response::fail(vec![toast_error(PLUGIN_NAME, "内容为空", None)]);
        }
    };
    let with_suffix = settings
        .get("share.slugRandomSuffix")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let expiry = settings
        .get("share.defaultExpiry")
        .and_then(|v| v.as_str())
        .unwrap_or("never");
    let expires_in_seconds = match expiry {
        "7d" => Some(7 * 24 * 3600u64),
        "30d" => Some(30 * 24 * 3600),
        "90d" => Some(90 * 24 * 3600),
        _ => None,
    };

    // Look up existing record for this path.
    let existing_record = settings
        .get("share.records")
        .and_then(|v| v.as_object())
        .and_then(|m| m.get(&path))
        .and_then(|v| v.as_object())
        .cloned();

    let (slug_string, edit_token, is_update) = if let Some(rec) = existing_record.as_ref() {
        let slug = rec.get("slug").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let token = rec.get("edit_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if slug.is_empty() || token.is_empty() {
            return Response::fail(vec![toast_error(PLUGIN_NAME, "本地分享记录损坏，请取消分享后重试", None)]);
        }
        (slug, token, true)
    } else {
        (slug::generate(Some(&filename), html, with_suffix), generate_edit_token(), false)
    };

    // Try to publish, retrying on slug conflict for new shares only.
    let mut current_slug = slug_string.clone();
    let mut attempts = 0;
    let max_attempts = if is_update { 1 } else { 3 };
    loop {
        attempts += 1;
        let body = json!({
            "slug": current_slug,
            "edit_token": edit_token,
            "html": html,
            "expires_in_seconds": expires_in_seconds,
            "metadata": {
                "original_filename": filename,
                "source_ext": filename.rsplit('.').next().unwrap_or(""),
            }
        });
        let url = format!("{base_url}/publish");
        let resp = ureq::post(&url)
            .set("Authorization", &format!("Bearer {api_key}"))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string());

        match resp {
            Ok(_) => {
                // Build the merged records map.
                let mut records: Map<String, Value> = settings
                    .get("share.records")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let share_url = format!("{base_url}/{current_slug}");
                let now = current_iso8601();
                let created_at = existing_record
                    .as_ref()
                    .and_then(|r| r.get("created_at"))
                    .cloned()
                    .unwrap_or_else(|| Value::String(now.clone()));
                let expires_at = match expires_in_seconds {
                    Some(secs) => {
                        let ts = OffsetDateTime::now_utc() + time::Duration::seconds(secs as i64);
                        Value::String(
                            ts.format(&time::format_description::well_known::Rfc3339)
                                .unwrap_or_else(|_| now.clone()),
                        )
                    }
                    None => Value::Null,
                };
                records.insert(
                    path.clone(),
                    json!({
                        "slug": current_slug,
                        "edit_token": edit_token,
                        "url": share_url,
                        "created_at": created_at,
                        "expires_at": expires_at,
                        "filename": filename.clone(),
                    }),
                );
                let mut patch = Map::new();
                patch.insert("share.records".to_string(), Value::Object(records));
                let msg = if is_update { "✅ 内容已更新（链接已复制）" } else { "✅ 分享成功（已复制）" };
                return Response::ok(vec![
                    Action::SettingsMerge { patch },
                    Action::ClipboardWrite { text: share_url.clone() },
                    Action::Toast {
                        level: "success".into(),
                        message: format!("{msg}：{share_url}"),
                        detail: None,
                    },
                ]);
            }
            Err(ureq::Error::Status(409, _)) if !is_update && attempts < max_attempts => {
                current_slug = format!("{slug_string}-{}", attempts + 1);
                continue;
            }
            Err(ureq::Error::Status(409, _)) => {
                return Response::fail(vec![toast_error(PLUGIN_NAME, "slug 冲突，请稍后重试", None)]);
            }
            Err(ureq::Error::Status(401, r)) => {
                return Response::fail(vec![toast_error(
                    PLUGIN_NAME,
                    "API key 无效，请检查 Preferences",
                    Some(&format!("HTTP 401: {}", r.status_text())),
                )]);
            }
            Err(ureq::Error::Status(413, _)) => {
                return Response::fail(vec![toast_error(PLUGIN_NAME, "文档过大", None)]);
            }
            Err(ureq::Error::Status(s, r)) if s >= 500 => {
                return Response::fail(vec![toast_error(
                    PLUGIN_NAME,
                    "服务器繁忙，请稍后重试",
                    Some(&format!("HTTP {s}: {}", r.status_text())),
                )]);
            }
            Err(ureq::Error::Status(s, r)) => {
                return Response::fail(vec![toast_error(
                    PLUGIN_NAME,
                    "上传失败",
                    Some(&format!("HTTP {s}: {}", r.status_text())),
                )]);
            }
            Err(ureq::Error::Transport(t)) => {
                return Response::fail(vec![toast_error(
                    PLUGIN_NAME,
                    "网络错误，请检查网络",
                    Some(&t.to_string()),
                )]);
            }
        }
    }
}

fn generate_edit_token() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn current_iso8601() -> String {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn ext_to_mime(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        _ => None,
    }
}

fn run_image_upload(
    path: &str,
    filename: &str,
    ext: &str,
    mime: &'static str,
    settings: &serde_json::Map<String, serde_json::Value>,
    base_url: &str,
    api_key: &str,
) -> Response {
    use std::fs;

    // Look up existing image record for this path.
    let existing_record = settings
        .get("share.records")
        .and_then(|v| v.as_object())
        .and_then(|m| m.get(path))
        .and_then(|v| v.as_object())
        .cloned();

    // Read file bytes.
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "无法读取图片文件",
                Some(&e.to_string()),
            )]);
        }
    };

    if bytes.len() > 50 * 1024 * 1024 {
        return Response::fail(vec![toast_error(
            PLUGIN_NAME, "图片过大（上限 50 MB）", None,
        )]);
    }

    // Generate a fresh edit_token for each upload.
    let edit_token = generate_edit_token();

    let expiry = settings
        .get("share.defaultExpiry")
        .and_then(|v| v.as_str())
        .unwrap_or("never");
    let expires_in_seconds: Option<u64> = match expiry {
        "7d" => Some(7 * 24 * 3600),
        "30d" => Some(30 * 24 * 3600),
        "90d" => Some(90 * 24 * 3600),
        _ => None,
    };

    let upload_url = format!("{base_url}/upload");
    let mut req = ureq::post(&upload_url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", mime)
        .set("X-Edit-Token", &edit_token)
        .set("X-Filename", filename);
    if let Some(secs) = expires_in_seconds {
        req = req.set("X-Expires-In", &secs.to_string());
    }
    let resp = req.send_bytes(&bytes);

    let upload_response: serde_json::Value = match resp {
        Ok(r) => match r.into_json() {
            Ok(v) => v,
            Err(e) => {
                return Response::fail(vec![toast_error(
                    PLUGIN_NAME, "服务器响应解析失败",
                    Some(&e.to_string()),
                )]);
            }
        },
        Err(ureq::Error::Status(401, r)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "API key 无效，请检查 Preferences",
                Some(&format!("HTTP 401: {}", r.status_text())),
            )]);
        }
        Err(ureq::Error::Status(413, _)) => {
            return Response::fail(vec![toast_error(PLUGIN_NAME, "图片过大", None)]);
        }
        Err(ureq::Error::Status(415, _)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "不支持的图片格式或字节签名不匹配", None,
            )]);
        }
        Err(ureq::Error::Status(s, r)) if s >= 500 => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "服务器繁忙，请稍后重试",
                Some(&format!("HTTP {s}: {}", r.status_text())),
            )]);
        }
        Err(ureq::Error::Status(s, r)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "上传失败",
                Some(&format!("HTTP {s}: {}", r.status_text())),
            )]);
        }
        Err(ureq::Error::Transport(t)) => {
            return Response::fail(vec![toast_error(
                PLUGIN_NAME, "网络错误，请检查网络",
                Some(&t.to_string()),
            )]);
        }
    };

    let id = upload_response.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let resp_ext = upload_response.get("ext").and_then(|v| v.as_str()).unwrap_or(ext).to_string();
    let share_url = upload_response
        .get("url").and_then(|v| v.as_str())
        .unwrap_or("").to_string();
    let expires_at = upload_response.get("expires_at").cloned()
        .unwrap_or(serde_json::Value::Null);
    let size_bytes = upload_response.get("size_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(bytes.len() as u64);

    // Best-effort delete of the previous image (if any). Failures are ignored.
    if let Some(prev) = existing_record.as_ref() {
        if let (Some(prev_id), Some(prev_ext), Some(prev_token)) = (
            prev.get("id").and_then(|v| v.as_str()),
            prev.get("ext").and_then(|v| v.as_str()),
            prev.get("edit_token").and_then(|v| v.as_str()),
        ) {
            let del_url = format!("{base_url}/f/{prev_id}.{prev_ext}");
            let _ = ureq::delete(&del_url)
                .set("Authorization", &format!("Bearer {api_key}"))
                .set("Content-Type", "application/json")
                .send_string(&serde_json::json!({ "edit_token": prev_token }).to_string());
        }
    }

    // Build merged records map.
    let mut records: serde_json::Map<String, serde_json::Value> = settings
        .get("share.records")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let now = current_iso8601();
    records.insert(
        path.to_string(),
        serde_json::json!({
            "kind": "image",
            "id": id,
            "ext": resp_ext,
            "edit_token": edit_token,
            "url": share_url,
            "created_at": now,
            "expires_at": expires_at,
            "filename": filename,
            "size_bytes": size_bytes,
        }),
    );
    let mut patch = serde_json::Map::new();
    patch.insert("share.records".to_string(), serde_json::Value::Object(records));

    let msg = if existing_record.is_some() {
        "✅ 图片已更新（链接已复制）"
    } else {
        "✅ 图片分享成功（已复制）"
    };
    Response::ok(vec![
        Action::SettingsMerge { patch },
        Action::ClipboardWrite { text: share_url.clone() },
        Action::Toast {
            level: "success".into(),
            message: format!("{msg}：{share_url}"),
            detail: None,
        },
    ])
}
