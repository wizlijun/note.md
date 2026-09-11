use chrono::{DateTime, NaiveDate};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

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
        let raw_meta = if let Some(bytes) = raw {
            atomic_bytes(
                &self.root.join("archive/raw").join(format!("{file}.eml")),
                bytes,
            )?;
            Some(json!({
                "sha256": hex::encode(Sha256::digest(bytes)),
                "bytes": bytes.len(),
            }))
        } else {
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
        ] {
            assert!(!serialized.contains(leaked), "leaked: {leaked}");
        }
        assert!(out.get("body").is_none());
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
}
