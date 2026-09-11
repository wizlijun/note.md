use chrono::{DateTime, NaiveDate};
use chrono_tz::Tz;
use mailparse::{parse_mail, DispositionType, MailHeaderMap, ParsedMail};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_LOCAL_RAW_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PREVIEW_CHARS: usize = 200_000;
const MAX_PREVIEW_HTML_CHARS: usize = 200_000;
const MAX_MIME_DEPTH: usize = 32;
const MAX_MIME_PARTS: usize = 256;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    pub worker_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CursorState {
    pub cursor: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Storage {
    root: PathBuf,
}

impl Storage {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn ensure_layout(&self) -> Result<(), String> {
        for rel in [
            "state",
            "archive/sources",
            "archive/raw",
            "archive/changes",
            "archive/tombstones",
        ] {
            create_private_dir(&self.root.join(rel))?;
        }
        Ok(())
    }

    pub fn load_config(&self) -> Result<Config, String> {
        read_json_or_default(&self.root.join("config.json"))
    }

    pub fn save_config(&self, config: &Config) -> Result<(), String> {
        self.ensure_layout()?;
        atomic_json(&self.root.join("config.json"), config)
    }

    pub fn load_cursor(&self) -> Result<CursorState, String> {
        read_json_or_default(&self.root.join("state/cursor.json"))
    }

    pub fn save_cursor(&self, cursor: Option<String>) -> Result<(), String> {
        self.ensure_layout()?;
        atomic_json(
            &self.root.join("state/cursor.json"),
            &CursorState {
                cursor,
                updated_at: Some(chrono::Utc::now().to_rfc3339()),
            },
        )
    }

    pub fn archive_change(&self, seq: &str, change: &Value) -> Result<(), String> {
        self.ensure_layout()?;
        atomic_json(
            &self
                .root
                .join("archive/changes")
                .join(format!("{}.json", safe_name(seq))),
            change,
        )
    }

    pub fn archive_source(
        &self,
        source_id: &str,
        source: &Value,
        raw: Option<&[u8]>,
    ) -> Result<(), String> {
        self.ensure_layout()?;
        let file = safe_name(source_id);
        let raw_path = self.root.join("archive/raw").join(format!("{file}.eml"));
        let raw_meta = if let Some(bytes) = raw {
            atomic_bytes(&raw_path, bytes)?;
            Some(json!({
                "sha256": hex::encode(Sha256::digest(bytes)),
                "bytes": bytes.len(),
            }))
        } else {
            remove_if_exists(&raw_path)?;
            None
        };
        let envelope = json!({
            "schema": "notemd.assistant-mail.archive.v1",
            "source_id": source_id,
            "archived_at": chrono::Utc::now().to_rfc3339(),
            "source": source,
            "raw": raw_meta,
        });
        atomic_json(
            &self
                .root
                .join("archive/sources")
                .join(format!("{file}.json")),
            &envelope,
        )
    }

    pub fn apply_tombstone(&self, source_id: &str, change: &Value) -> Result<(), String> {
        self.ensure_layout()?;
        let file = safe_name(source_id);
        remove_if_exists(
            &self
                .root
                .join("archive/sources")
                .join(format!("{file}.json")),
        )?;
        remove_if_exists(&self.root.join("archive/raw").join(format!("{file}.eml")))?;
        let tombstone = json!({
            "schema": "notemd.assistant-mail.tombstone.v1",
            "source_id": source_id,
            "applied_at": chrono::Utc::now().to_rfc3339(),
            "change": change,
        });
        atomic_json(
            &self
                .root
                .join("archive/tombstones")
                .join(format!("{file}.json")),
            &tombstone,
        )
    }

    pub fn query(
        &self,
        text: Option<&str>,
        status: Option<&str>,
        date: Option<NaiveDate>,
        timezone: Option<Tz>,
        limit: usize,
    ) -> Result<QueryResult, String> {
        self.ensure_layout()?;
        let mut rows = Vec::new();
        let mut unreadable_sources = 0usize;
        let dir = self.root.join("archive/sources");
        for entry in fs::read_dir(dir).map_err(io_err)? {
            let path = entry.map_err(io_err)?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let value: Value = match read_json(&path) {
                Ok(v) => v,
                Err(_) => {
                    unreadable_sources += 1;
                    continue;
                }
            };
            let source = value.get("source").unwrap_or(&value);
            let projection = safe_query_projection(source);
            if !matches_status(source, status)
                || !matches_text(&projection, text)
                || !matches_date(source, date, timezone)
            {
                continue;
            }
            rows.push(projection);
        }
        rows.sort_by(|a, b| sort_time(b).cmp(sort_time(a)));
        rows.truncate(limit);
        let cursor = self.load_cursor()?;
        let (archived_sources, archived_raw) = self.counts()?;
        let tombstones = count_ext(&self.root.join("archive/tombstones"), "json")?;
        let raw_unavailable = archived_sources.saturating_sub(archived_raw);
        Ok(QueryResult {
            rows,
            coverage: json!({
                "scope": "local_assistant_mail_archive",
                "cursor": cursor.cursor,
                "cursor_updated_at": cursor.updated_at,
                "archived_sources": archived_sources,
                "archived_raw": archived_raw,
                "tombstones": tombstones,
                "gap_count": raw_unavailable + unreadable_sources,
                "gaps": {
                    "raw_unavailable": raw_unavailable,
                    "unreadable_sources": unreadable_sources,
                }
            }),
        })
    }

    pub fn counts(&self) -> Result<(usize, usize), String> {
        self.ensure_layout()?;
        Ok((
            count_ext(&self.root.join("archive/sources"), "json")?,
            count_ext(&self.root.join("archive/raw"), "eml")?,
        ))
    }

    pub fn list_messages(&self) -> Result<Vec<Value>, String> {
        self.ensure_layout()?;
        let mut rows = Vec::new();
        for entry in fs::read_dir(self.root.join("archive/sources")).map_err(io_err)? {
            let path = entry.map_err(io_err)?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let envelope: Value = match read_json(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let source = envelope.get("source").unwrap_or(&envelope);
            let Some(source_id) = envelope
                .get("source_id")
                .or_else(|| source.get("id"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            rows.push(json!({
                "source_id": source_id,
                "subject": source.get("subject").and_then(Value::as_str),
                "claimed_from": source.get("header_from").and_then(Value::as_str),
                "envelope_from": source.get("envelope_from").and_then(Value::as_str),
                "received_at": source.get("created_at").and_then(Value::as_str)
                    .or_else(|| source.get("received_at").and_then(Value::as_str)),
                "status": source.get("status").and_then(Value::as_str),
                "raw_available": !envelope.get("raw").is_none_or(Value::is_null)
                    && self.root.join("archive/raw")
                    .join(format!("{}.eml", safe_name(source_id))).is_file(),
            }));
        }
        rows.sort_by(|left, right| {
            right
                .get("received_at")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(
                    left.get("received_at")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                )
        });
        Ok(rows)
    }

    pub fn message_preview(&self, source_id: &str) -> Result<Value, String> {
        self.ensure_layout()?;
        let file = safe_name(source_id);
        let source_path = self
            .root
            .join("archive/sources")
            .join(format!("{file}.json"));
        let envelope: Value = read_json(&source_path)
            .map_err(|_| "mail source is not available in the private archive".to_string())?;
        if envelope.get("source_id").and_then(Value::as_str) != Some(source_id) {
            return Err("mail source identity does not match its archive entry".into());
        }
        let source = envelope.get("source").unwrap_or(&envelope);
        let raw_meta = envelope
            .get("raw")
            .and_then(Value::as_object)
            .ok_or("mail source does not declare a local raw message")?;
        let expected_bytes = raw_meta
            .get("bytes")
            .and_then(Value::as_u64)
            .ok_or("mail source has invalid raw size metadata")?;
        let expected_sha256 = raw_meta
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|value| value.len() == 64)
            .ok_or("mail source has invalid raw hash metadata")?;
        let raw_path = self.root.join("archive/raw").join(format!("{file}.eml"));
        let actual_bytes = fs::metadata(&raw_path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    "raw mail is not available locally; sync again after Worker processing"
                        .to_string()
                } else {
                    io_err(error)
                }
            })?
            .len();
        if actual_bytes > MAX_LOCAL_RAW_BYTES || actual_bytes != expected_bytes {
            return Err("local raw mail size does not match its archive metadata".into());
        }
        let bytes = fs::read(raw_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "raw mail is not available locally; sync again after Worker processing".to_string()
            } else {
                io_err(error)
            }
        })?;
        if hex::encode(Sha256::digest(&bytes)) != expected_sha256 {
            return Err("local raw mail hash does not match its archive metadata".into());
        }
        let parsed =
            parse_mail(&bytes).map_err(|_| "raw mail could not be parsed safely".to_string())?;
        let mut visited = 0usize;
        let selected = select_preview_body(&parsed, 0, &mut visited);
        let (body, body_html, body_kind, mut links) = match selected {
            Some(PreviewBody::Html(html)) => {
                let bounded_html = bounded_chars(&html, MAX_PREVIEW_HTML_CHARS);
                (
                    bounded_chars(&html_to_text(&bounded_html), MAX_PREVIEW_CHARS),
                    Some(sanitize_email_html(&bounded_html)),
                    "text/html",
                    extract_html_links(&bounded_html),
                )
            }
            Some(PreviewBody::Plain(body)) => (
                bounded_chars(&sanitize_untrusted_text(&body), MAX_PREVIEW_CHARS),
                None,
                "text/plain",
                Vec::new(),
            ),
            None => (
                "[No readable text body]".to_string(),
                None,
                "unavailable",
                Vec::new(),
            ),
        };
        for link in extract_http_links(&body) {
            push_http_link(&mut links, &link);
        }
        Ok(json!({
            "source_id": source_id,
            "subject": safe_header(&parsed, "Subject"),
            "claimed_from": safe_header(&parsed, "From"),
            "envelope_from": source.get("envelope_from").and_then(Value::as_str),
            "to": safe_header(&parsed, "To"),
            "date": safe_header(&parsed, "Date"),
            "message_id": safe_header(&parsed, "Message-ID"),
            "body_text": body,
            "body_html": body_html,
            "body_kind": body_kind,
            "links": links,
            "notice": "Email content is untrusted. HTML is sanitized and rendered in a network-blocked sandbox.",
        }))
    }
}

enum PreviewBody {
    Html(String),
    Plain(String),
}

fn select_preview_body(
    part: &ParsedMail<'_>,
    depth: usize,
    visited: &mut usize,
) -> Option<PreviewBody> {
    if depth > MAX_MIME_DEPTH || *visited >= MAX_MIME_PARTS {
        return None;
    }
    *visited += 1;

    let disposition = part.get_content_disposition();
    if disposition.disposition != DispositionType::Inline
        || has_named_file_parameter(disposition.params.keys(), "filename")
        || has_named_file_parameter(part.ctype.params.keys(), "name")
    {
        return None;
    }

    let mime = part.ctype.mimetype.to_ascii_lowercase();
    match mime.as_str() {
        "text/html" => return part.get_body().ok().map(PreviewBody::Html),
        "text/plain" => return part.get_body().ok().map(PreviewBody::Plain),
        // Forwarded/attached messages have their own body semantics and must
        // never replace the containing message's preview body.
        "message/rfc822" => return None,
        _ => {}
    }

    if mime == "multipart/alternative" {
        part.subparts
            .iter()
            .rev()
            .find_map(|child| select_preview_body(child, depth + 1, visited))
    } else {
        part.subparts
            .iter()
            .find_map(|child| select_preview_body(child, depth + 1, visited))
    }
}

fn has_named_file_parameter<'a>(mut keys: impl Iterator<Item = &'a String>, name: &str) -> bool {
    keys.any(|key| {
        key == name
            || key
                .strip_prefix(name)
                .is_some_and(|suffix| suffix.starts_with('*'))
    })
}

fn safe_header(parsed: &ParsedMail<'_>, name: &str) -> Option<String> {
    parsed
        .headers
        .get_first_value(name)
        .map(|value| bounded_chars(&sanitize_untrusted_text(&value), 998))
}

fn bounded_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn html_to_text(value: &str) -> String {
    let value = strip_html_element(&strip_html_element(value, "script"), "style");
    let mut output = String::with_capacity(value.len().min(MAX_PREVIEW_CHARS));
    let mut inside_tag = false;
    let mut previous_space = false;
    for character in value.chars() {
        match character {
            '<' => {
                inside_tag = true;
                if !previous_space {
                    output.push(' ');
                    previous_space = true;
                }
            }
            '>' if inside_tag => inside_tag = false,
            _ if inside_tag => {}
            value if value.is_whitespace() => {
                if !previous_space {
                    output.push(' ');
                    previous_space = true;
                }
            }
            value => {
                output.push(value);
                previous_space = false;
            }
        }
    }
    sanitize_untrusted_text(&decode_html_entities(&output))
        .trim()
        .to_string()
}

fn sanitize_email_html(value: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .url_relative(ammonia::UrlRelative::Deny)
        .link_rel(None)
        .add_generic_attributes(&["style"])
        .filter_style_properties(
            [
                "background-color",
                "border",
                "border-bottom",
                "border-collapse",
                "border-color",
                "border-left",
                "border-right",
                "border-style",
                "border-top",
                "border-width",
                "color",
                "display",
                "font-family",
                "font-size",
                "font-style",
                "font-weight",
                "height",
                "line-height",
                "margin",
                "margin-bottom",
                "margin-left",
                "margin-right",
                "margin-top",
                "max-height",
                "max-width",
                "padding",
                "padding-bottom",
                "padding-left",
                "padding-right",
                "padding-top",
                "text-align",
                "text-decoration",
                "vertical-align",
                "white-space",
                "width",
            ]
            .into(),
        )
        .attribute_filter(|_, attribute, value| match attribute {
            // Navigation remains an explicit user decision in the trusted
            // window's separately extracted link list. Removing every URL-
            // bearing attribute also prevents tracking pixels independent of
            // the iframe's CSP network boundary.
            "href" | "src" | "cite" => None,
            _ => Some(value.into()),
        });
    builder.clean(value).to_string()
}

fn strip_html_element(value: &str, element: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(start) = lower.find(&format!("<{element}")) else {
            output.push_str(rest);
            return output;
        };
        output.push_str(&rest[..start]);
        let closing = format!("</{element}");
        let Some(relative_end) = lower[start..].find(&closing) else {
            return output;
        };
        let closing_start = start + relative_end;
        let Some(tag_end) = rest[closing_start..].find('>') else {
            return output;
        };
        rest = &rest[closing_start + tag_end + 1..];
    }
}

fn sanitize_untrusted_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            matches!(*character, '\n' | '\r' | '\t')
                || (!character.is_control()
                    && !matches!(
                        *character,
                        '\u{061c}'
                            | '\u{200e}'
                            | '\u{200f}'
                            | '\u{202a}'..='\u{202e}'
                            | '\u{2066}'..='\u{2069}'
                    ))
        })
        .collect()
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn extract_html_links(value: &str) -> Vec<String> {
    let links = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&links);
    let mut builder = ammonia::Builder::default();
    builder
        .url_relative(ammonia::UrlRelative::Deny)
        .attribute_filter(move |element, attribute, value| {
            if element == "a" && attribute == "href" {
                let sanitized = sanitize_untrusted_text(value);
                if sanitized == value {
                    if let Ok(mut links) = captured.lock() {
                        push_http_link(&mut links, value);
                    }
                }
            }
            Some(value.into())
        });
    let _ = builder.clean(value);
    links.lock().map(|links| links.clone()).unwrap_or_default()
}

fn extract_http_links(value: &str) -> Vec<String> {
    let mut links = Vec::new();
    for word in value.split_whitespace() {
        let candidate = word.trim_matches(|character: char| {
            matches!(
                character,
                '<' | '>' | '(' | ')' | '[' | ']' | '"' | '\'' | ',' | ';'
            )
        });
        push_http_link(&mut links, candidate);
        if links.len() == 50 {
            break;
        }
    }
    links
}

fn push_http_link(links: &mut Vec<String>, candidate: &str) {
    if candidate.len() <= 2_048
        && url::Url::parse(candidate).is_ok_and(|url| matches!(url.scheme(), "https" | "http"))
        && !links.iter().any(|link| link == candidate)
        && links.len() < 50
    {
        links.push(candidate.to_string());
    }
}

pub struct QueryResult {
    pub rows: Vec<Value>,
    pub coverage: Value,
}

fn matches_status(source: &Value, expected: Option<&str>) -> bool {
    let Some(expected) = expected.filter(|v| !v.is_empty()) else {
        return true;
    };
    ["processing_status", "status"]
        .iter()
        .any(|key| source.get(key).and_then(Value::as_str) == Some(expected))
}

fn matches_text(source: &Value, needle: Option<&str>) -> bool {
    let Some(needle) = needle.filter(|v| !v.is_empty()).map(str::to_lowercase) else {
        return true;
    };
    ["subject_redacted", "sender_masked"]
        .iter()
        .filter_map(|key| source.get(key).and_then(Value::as_str))
        .any(|value| value.to_lowercase().contains(&needle))
}

/// M0 is intentionally fail-closed: no untrusted subject/title/body text is
/// disclosed at all. Sender names are omitted and an address, when present,
/// is reduced to a display mask. Later structured event output must have its
/// own reviewed schema rather than widening this projection.
pub fn safe_query_projection(source: &Value) -> Value {
    const KEYS: &[&str] = &[
        "id",
        "source_id",
        "received_at",
        "sent_at",
        "processing_status",
        "status",
        "trust_level",
        "has_forward_chain",
        "event_ids",
        "created_at",
        "updated_at",
    ];
    let mut out = serde_json::Map::new();
    for key in KEYS {
        if let Some(value) = source.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    out.insert("subject_redacted".into(), Value::Null);
    out.insert(
        "sender_masked".into(),
        sender_address(source)
            .map(mask_email)
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    out.insert("disclosure".into(), Value::String("metadata_only".into()));
    out.insert(
        "safety_labels".into(),
        json!(["untrusted_text_withheld_m0"]),
    );
    Value::Object(out)
}

fn sender_address(source: &Value) -> Option<&str> {
    source
        .get("from_address")
        .and_then(Value::as_str)
        .or_else(|| source.get("envelope_from").and_then(Value::as_str))
        .or_else(|| source.pointer("/sender/address").and_then(Value::as_str))
        .or_else(|| source.get("sender").and_then(Value::as_str))
}

fn mask_email(value: &str) -> String {
    let Some((local, domain)) = value.rsplit_once('@') else {
        return "[masked-sender]".into();
    };
    let local_first = local.chars().next().unwrap_or('*');
    let labels: Vec<String> = domain
        .split('.')
        .map(|label| {
            label
                .chars()
                .next()
                .map(|c| format!("{c}***"))
                .unwrap_or_else(|| "***".into())
        })
        .collect();
    format!("{local_first}***@{}", labels.join("."))
}

fn matches_date(source: &Value, date: Option<NaiveDate>, timezone: Option<Tz>) -> bool {
    let Some(expected) = date else {
        return true;
    };
    let Some(timezone) = timezone else {
        return false;
    };
    timestamp_candidates(source).any(|value| timestamp_date(value, timezone) == Some(expected))
}

fn timestamp_candidates(source: &Value) -> impl Iterator<Item = &str> {
    const KEYS: &[&str] = &[
        "received_at",
        "sent_at",
        "created_at",
        "updated_at",
        "occurs_at",
        "start_at",
        "end_at",
        "deadline_at",
    ];
    let top = KEYS
        .iter()
        .filter_map(|key| source.get(*key).and_then(Value::as_str));
    let nested = source
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|event| {
            KEYS.iter()
                .filter_map(move |key| event.get(*key).and_then(Value::as_str))
        });
    top.chain(nested)
}

fn timestamp_date(value: &str, timezone: Tz) -> Option<NaiveDate> {
    if value.len() == 10 {
        return NaiveDate::parse_from_str(value, "%Y-%m-%d").ok();
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&timezone).date_naive())
}

fn sort_time(value: &Value) -> &str {
    value
        .get("received_at")
        .or_else(|| value.get("created_at"))
        .or_else(|| value.get("updated_at"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn count_ext(path: &Path, ext: &str) -> Result<usize, String> {
    Ok(fs::read_dir(path)
        .map_err(io_err)?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|v| v.to_str()) == Some(ext))
        .count())
}

fn safe_name(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn read_json_or_default<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    read_json(path)
}

fn read_json<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let file = File::open(path).map_err(io_err)?;
    let mut bytes = Vec::new();
    file.take(8 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(io_err)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("invalid local JSON: {e}"))
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    atomic_bytes(path, &bytes)
}

fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid storage path")?;
    create_private_dir(parent)?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|v| v.to_str()).unwrap_or("data"),
        std::process::id()
    ));
    let mut opts = OpenOptions::new();
    opts.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(io_err)?;
    file.write_all(bytes).map_err(io_err)?;
    file.sync_all().map_err(io_err)?;
    fs::rename(&tmp, path).map_err(io_err)?;
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(io_err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(io_err)?;
    }
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(e)),
    }
}

fn io_err(err: std::io::Error) -> String {
    format!("private storage error: {err}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_never_contains_key_and_cursor_is_atomic() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        storage
            .save_config(&Config {
                worker_url: Some("https://mail.example.test".into()),
            })
            .unwrap();
        storage.save_cursor(Some("cursor-1".into())).unwrap();
        let config = fs::read_to_string(tmp.path().join("config.json")).unwrap();
        assert!(!config.to_lowercase().contains("key"));
        assert_eq!(
            storage.load_cursor().unwrap().cursor.as_deref(),
            Some("cursor-1")
        );
    }

    #[test]
    fn tombstone_removes_source_and_raw_but_keeps_audit_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        storage
            .archive_source(
                "source/unsafe",
                &json!({"id":"source/unsafe"}),
                Some(b"mime"),
            )
            .unwrap();
        storage
            .apply_tombstone("source/unsafe", &json!({"type":"source.deleted"}))
            .unwrap();
        assert_eq!(storage.counts().unwrap(), (0, 0));
        assert_eq!(
            count_ext(&tmp.path().join("archive/tombstones"), "json").unwrap(),
            1
        );
    }

    #[test]
    fn query_projection_excludes_body_and_headers() {
        let source = json!({
            "id":"s1",
            "subject":"OTP 123456 — Magic Link",
            "from_address":"private.person@gmail.com",
            "from_name":"Private Person",
            "body":"password reset secret",
            "body_text":"private preview text",
            "body_html":"<strong>private preview html</strong>",
            "links":["https://private.example.test/confirm"],
            "headers":{"authorization":"x"}
        });
        let out = safe_query_projection(&source);
        let serialized = serde_json::to_string(&out).unwrap();
        assert!(out["subject_redacted"].is_null());
        assert_eq!(out["sender_masked"], "p***@g***.c***");
        for leaked in [
            "OTP",
            "123456",
            "Magic Link",
            "private.person",
            "gmail.com",
            "Private Person",
            "password reset secret",
            "private preview text",
            "private preview html",
            "private.example.test",
        ] {
            assert!(!serialized.contains(leaked), "leaked: {leaked}");
        }
        assert!(out.get("body").is_none());
        assert!(out.get("body_text").is_none());
        assert!(out.get("body_html").is_none());
        assert!(out.get("links").is_none());
        assert!(out.get("headers").is_none());
    }

    #[test]
    fn date_filter_uses_explicit_iana_timezone() {
        let source = json!({"received_at":"2026-09-10T16:30:00Z"});
        let taipei: Tz = "Asia/Taipei".parse().unwrap();
        assert!(matches_date(
            &source,
            Some(NaiveDate::from_ymd_opt(2026, 9, 11).unwrap()),
            Some(taipei)
        ));
        assert!(!matches_date(
            &source,
            Some(NaiveDate::from_ymd_opt(2026, 9, 10).unwrap()),
            Some(taipei)
        ));
        assert!(!matches_date(
            &source,
            Some(NaiveDate::from_ymd_opt(2026, 9, 11).unwrap()),
            None
        ));
    }

    #[test]
    fn query_reports_cursor_time_and_local_gaps() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        storage
            .archive_source(
                "s1",
                &json!({
                    "id":"s1", "status":"ready", "created_at":"2026-09-10T16:30:00Z",
                    "subject":"do not disclose", "envelope_from":"owner@gmail.com"
                }),
                None,
            )
            .unwrap();
        storage.save_cursor(Some("djE6MQ".into())).unwrap();
        let result = storage
            .query(
                None,
                None,
                Some(NaiveDate::from_ymd_opt(2026, 9, 11).unwrap()),
                Some("Asia/Taipei".parse().unwrap()),
                20,
            )
            .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.coverage["cursor"], "djE6MQ");
        assert!(result.coverage["cursor_updated_at"].as_str().is_some());
        assert_eq!(result.coverage["gap_count"], 1);
        assert!(!serde_json::to_string(&result.rows)
            .unwrap()
            .contains("do not disclose"));
    }

    #[test]
    fn trusted_ui_sanitizes_html_for_sandboxed_rendering() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        let raw = concat!(
            "Message-ID: <verify@example.com>\r\n",
            "Subject: Forwarding confirmation\u{202e}\r\n",
            "From: Gmail Team <forwarding-noreply@google.com>\r\n",
            "To: xiaobu@5000g.com\r\n",
            "Content-Type: text/html; charset=utf-8\r\n\r\n",
            "<style>body{display:none}</style><script>steal()</script>",
            "<form action=\"https://evil.test/post\"><input name=\"secret\"></form>",
            "<iframe src=\"https://evil.test/frame\"></iframe>",
            "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.test/refresh\">",
            "<base href=\"https://evil.test/base\"><object data=\"https://evil.test/object\"></object>",
            "<embed src=\"https://evil.test/embed\"><svg><foreignObject>svg</foreignObject></svg>",
            "<img src=\"https://evil.test/track.gif\" srcset=\"https://evil.test/2x 2x\" onerror=\"steal()\" alt=\"logo\">",
            "<!-- href=\"https://evil.test/comment\" -->",
            "<span title=\"href=https://evil.test/title\">label</span>",
            "<a href=\"https://evil.test/\u{202e}confusing\">confusing</a>",
            "<p style=\"color:red;position:fixed;background-image:url(https://evil.test/css)\" onclick=\"steal()\">Confirm at <a href=\"https://example.test/confirm?a=1&amp;b=2\">this button</a></p>",
        );
        storage
            .archive_source(
                "source-1",
                &json!({
                    "id":"source-1", "subject":"Forwarding confirmation",
                    "header_from":"Gmail Team <forwarding-noreply@google.com>",
                    "envelope_from":"forwarding-noreply@google.com",
                    "created_at":"2026-09-11T10:00:00Z", "status":"ready"
                }),
                Some(raw.as_bytes()),
            )
            .unwrap();

        let list = storage.list_messages().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["source_id"], "source-1");
        assert_eq!(list[0]["raw_available"], true);

        let preview = storage.message_preview("source-1").unwrap();
        assert_eq!(preview["subject"], "Forwarding confirmation");
        assert_eq!(preview["envelope_from"], "forwarding-noreply@google.com");
        assert_eq!(
            preview["claimed_from"],
            "Gmail Team <forwarding-noreply@google.com>"
        );
        assert_eq!(preview["body_kind"], "text/html");
        assert!(preview["body_text"]
            .as_str()
            .unwrap()
            .contains("Confirm at"));
        let html = preview["body_html"].as_str().unwrap();
        assert!(html.contains("<p style=\"color:red\">Confirm at <a>this button</a></p>"));
        assert!(html.contains("<img alt=\"logo\">"));
        assert!(!html.contains("script"));
        assert!(!html.contains("<style"));
        assert!(!html.contains("form"));
        assert!(!html.contains("iframe"));
        assert!(!html.contains("<meta"));
        assert!(!html.contains("<base"));
        assert!(!html.contains("<object"));
        assert!(!html.contains("<embed"));
        assert!(!html.contains("<svg"));
        assert!(!html.contains("onclick"));
        assert!(!html.contains("onerror"));
        assert!(!html.contains("srcset"));
        assert!(!html.contains("<a href="));
        assert!(!html.contains("src="));
        assert!(!html.contains("background-image"));
        assert_eq!(
            preview["links"].as_array().unwrap().len(),
            1,
            "unexpected links: {}",
            preview["links"]
        );
        assert_eq!(preview["links"][0], "https://example.test/confirm?a=1&b=2");

        let raw_path = tmp
            .path()
            .join("archive/raw")
            .join(format!("{}.eml", safe_name("source-1")));
        let mut tampered = raw.as_bytes().to_vec();
        *tampered.last_mut().unwrap() = b'!';
        fs::write(&raw_path, tampered).unwrap();
        assert!(storage
            .message_preview("source-1")
            .unwrap_err()
            .contains("hash"));

        storage
            .archive_source(
                "source-1",
                &json!({
                    "id":"source-1", "subject":"Forwarding confirmation",
                    "envelope_from":"forwarding-noreply@google.com",
                    "created_at":"2026-09-11T10:00:00Z", "status":"received_pending"
                }),
                None,
            )
            .unwrap();
        assert!(!raw_path.exists());
        assert_eq!(storage.list_messages().unwrap()[0]["raw_available"], false);
    }

    #[test]
    fn html_is_preferred_in_multipart_alternative_and_plain_text_remains_a_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        let alternative = concat!(
            "Subject: Alternative\r\n",
            "Content-Type: multipart/alternative; boundary=preview\r\n\r\n",
            "--preview\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain version\r\n",
            "--preview\r\nContent-Type: text/html; charset=utf-8\r\n\r\n",
            "<p><strong>HTML version</strong></p>\r\n--preview--\r\n",
        );
        storage
            .archive_source(
                "alternative",
                &json!({"id":"alternative", "status":"ready"}),
                Some(alternative.as_bytes()),
            )
            .unwrap();
        let preview = storage.message_preview("alternative").unwrap();
        assert_eq!(preview["body_kind"], "text/html");
        assert!(preview["body_html"]
            .as_str()
            .unwrap()
            .contains("<strong>HTML version</strong>"));

        let plain = "Subject: Plain\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain only";
        storage
            .archive_source(
                "plain",
                &json!({"id":"plain", "status":"ready"}),
                Some(plain.as_bytes()),
            )
            .unwrap();
        let preview = storage.message_preview("plain").unwrap();
        assert_eq!(preview["body_kind"], "text/plain");
        assert!(preview["body_html"].is_null());
        assert_eq!(preview["body_text"], "Plain only");
    }

    #[test]
    fn attachments_and_forwarded_messages_cannot_replace_the_preview_body() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        let raw = concat!(
            "Subject: Mixed\r\n",
            "Content-Type: multipart/mixed; boundary=outer\r\n\r\n",
            "--outer\r\n",
            "Content-Type: multipart/alternative; boundary=attached\r\n",
            "Content-Disposition: attachment; filename=page.html\r\n\r\n",
            "--attached\r\nContent-Type: text/html\r\n\r\n<p>Nested attachment</p>\r\n",
            "--attached--\r\n",
            "--outer\r\n",
            "Content-Type: message/rfc822\r\n",
            "Content-Disposition: inline\r\n\r\n",
            "Subject: Forwarded\r\nContent-Type: text/html\r\n\r\n<p>Forwarded HTML</p>\r\n",
            "--outer\r\n",
            "Content-Type: text/html; charset=utf-8\r\n",
            "Content-Disposition: attachment; filename=other.html\r\n\r\n",
            "<p>Direct attachment</p>\r\n",
            "--outer\r\n",
            "Content-Type: text/html; charset=utf-8\r\n",
            "Content-Disposition: inline; filename*1=continued.html\r\n\r\n",
            "<p>Orphan filename continuation</p>\r\n",
            "--outer\r\n",
            "Content-Type: text/html; charset=utf-8; name*1=continued.html\r\n",
            "Content-Disposition: inline\r\n\r\n",
            "<p>Orphan name continuation</p>\r\n",
            "--outer\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n\r\nActual message body\r\n",
            "--outer--\r\n",
        );
        storage
            .archive_source(
                "mixed",
                &json!({"id":"mixed", "status":"ready"}),
                Some(raw.as_bytes()),
            )
            .unwrap();
        let preview = storage.message_preview("mixed").unwrap();
        assert_eq!(preview["body_kind"], "text/plain");
        assert!(preview["body_html"].is_null());
        assert_eq!(preview["body_text"], "Actual message body");
    }
}
