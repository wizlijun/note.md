use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;
use mailparse::{parse_mail, DispositionType, MailHeaderMap, ParsedMail};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const MAX_LOCAL_RAW_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PREVIEW_CHARS: usize = 200_000;
const MAX_PREVIEW_HTML_CHARS: usize = 200_000;
const MAX_MIME_DEPTH: usize = 32;
const MAX_MIME_PARTS: usize = 256;

const PRIVATE_ROOT: &str = ".notemd/assistant-mail";
const DEFAULT_ARCHIVE_DIR: &str = "ssot/mails";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    pub worker_url: Option<String>,
    #[serde(default = "default_archive_dir")]
    pub archive_dir: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            worker_url: None,
            archive_dir: default_archive_dir(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CursorState {
    pub cursor: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Storage {
    vault_root: PathBuf,
    legacy_root: Option<PathBuf>,
}

impl Storage {
    #[cfg(test)]
    pub fn new(vault_root: PathBuf) -> Self {
        Self {
            vault_root,
            legacy_root: None,
        }
    }

    pub fn with_legacy(vault_root: PathBuf, legacy_root: PathBuf) -> Self {
        Self {
            vault_root,
            legacy_root: Some(legacy_root),
        }
    }

    pub fn ensure_layout(&self) -> Result<(), String> {
        ensure_vault_root(&self.vault_root)?;
        ensure_safe_relative_dir(&self.vault_root, Path::new(PRIVATE_ROOT))?;
        ensure_safe_relative_dir(
            &self.vault_root,
            Path::new(&format!("{PRIVATE_ROOT}/state")),
        )?;
        ensure_safe_relative_dir(
            &self.vault_root,
            Path::new(&format!("{PRIVATE_ROOT}/state/changes")),
        )?;
        ensure_safe_relative_dir(
            &self.vault_root,
            Path::new(&format!("{PRIVATE_ROOT}/state/tombstones")),
        )?;
        let config = self.load_config()?;
        self.ensure_archive_dir(&config.archive_dir)?;
        Ok(())
    }

    pub fn load_config(&self) -> Result<Config, String> {
        let config: Config = read_json_or_default(&self.private_root().join("config.json"))?;
        validate_archive_dir(&config.archive_dir)?;
        Ok(config)
    }

    pub fn save_config(&self, config: &Config) -> Result<(), String> {
        validate_archive_dir(&config.archive_dir)?;
        ensure_vault_root(&self.vault_root)?;
        ensure_safe_relative_dir(&self.vault_root, Path::new(PRIVATE_ROOT))?;
        let old = self.load_config()?;
        self.ensure_archive_dir(&old.archive_dir)?;
        self.ensure_archive_dir(&config.archive_dir)?;
        if old.archive_dir != config.archive_dir {
            self.copy_archive(&old.archive_dir, &config.archive_dir)?;
        }
        atomic_json(&self.private_root().join("config.json"), config)?;
        if old.archive_dir != config.archive_dir {
            self.remove_archive_pairs(&old.archive_dir)?;
        }
        Ok(())
    }

    pub fn load_cursor(&self) -> Result<CursorState, String> {
        read_json_or_default(&self.private_root().join("state/cursor.json"))
    }

    pub fn save_cursor(&self, cursor: Option<String>) -> Result<(), String> {
        self.ensure_layout()?;
        atomic_json(
            &self.private_root().join("state/cursor.json"),
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
                .private_root()
                .join("state/changes")
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
        let archive_root = self.archive_root()?;
        let source_path = match find_source_paths(&archive_root, source_id)?
            .into_iter()
            .next()
        {
            Some(path) => path,
            None => self.allocate_source_path(&archive_root, source_id, source)?,
        };
        let raw_path = source_path.with_extension("eml");
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
        atomic_json(&source_path, &envelope)
    }

    pub fn apply_tombstone(&self, source_id: &str, change: &Value) -> Result<(), String> {
        self.ensure_layout()?;
        let file = safe_name(source_id);
        let tombstone = json!({
            "schema": "notemd.assistant-mail.tombstone.v1",
            "source_id": source_id,
            "applied_at": chrono::Utc::now().to_rfc3339(),
            "change": change,
        });
        atomic_json(
            &self
                .private_root()
                .join("state/tombstones")
                .join(format!("{file}.json")),
            &tombstone,
        )?;
        for source_path in find_source_paths(&self.archive_root()?, source_id)? {
            remove_if_exists(&source_path.with_extension("eml"))?;
            remove_if_exists(&source_path)?;
        }
        Ok(())
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
        for path in collect_files_with_extension(&self.archive_root()?, "json")? {
            let value: Value = match read_json(&path) {
                Ok(v) => v,
                Err(_) => {
                    unreadable_sources += 1;
                    continue;
                }
            };
            let Some(source_id) = envelope_source_id(&value) else {
                continue;
            };
            if self.is_tombstoned(source_id) {
                continue;
            }
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
        let tombstones = count_ext(&self.private_root().join("state/tombstones"), "json")?;
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
        let mut sources = 0usize;
        let mut raw = 0usize;
        for path in collect_files_with_extension(&self.archive_root()?, "json")? {
            let Ok(envelope) = read_json::<Value>(&path) else {
                continue;
            };
            let Some(source_id) = envelope_source_id(&envelope) else {
                continue;
            };
            if self.is_tombstoned(source_id) {
                continue;
            }
            sources += 1;
            if path.with_extension("eml").is_file() {
                raw += 1;
            }
        }
        Ok((sources, raw))
    }

    pub fn list_messages(&self) -> Result<Vec<Value>, String> {
        self.ensure_layout()?;
        let mut rows = Vec::new();
        for path in collect_files_with_extension(&self.archive_root()?, "json")? {
            let envelope: Value = match read_json(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let Some(source_id) = envelope_source_id(&envelope) else {
                continue;
            };
            if self.is_tombstoned(source_id) {
                continue;
            }
            let source = envelope.get("source").unwrap_or(&envelope);
            rows.push(json!({
                "source_id": source_id,
                "subject": source.get("subject").and_then(Value::as_str),
                "claimed_from": source.get("header_from").and_then(Value::as_str),
                "envelope_from": source.get("envelope_from").and_then(Value::as_str),
                "received_at": source.get("created_at").and_then(Value::as_str)
                    .or_else(|| source.get("received_at").and_then(Value::as_str)),
                "status": source.get("status").and_then(Value::as_str),
                "raw_available": !envelope.get("raw").is_none_or(Value::is_null)
                    && path.with_extension("eml").is_file(),
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
        if self.is_tombstoned(source_id) {
            return Err("mail source has been deleted".into());
        }
        let source_path = find_source_paths(&self.archive_root()?, source_id)?
            .into_iter()
            .next()
            .ok_or_else(|| "mail source is not available in the Vault archive".to_string())?;
        let envelope: Value = read_json(&source_path)
            .map_err(|_| "mail source is not available in the Vault archive".to_string())?;
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
        let raw_path = source_path.with_extension("eml");
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
        let (body, body_html, body_kind) = match selected {
            Some(PreviewBody::Html(html)) => {
                let bounded_html = bounded_chars(&html, MAX_PREVIEW_HTML_CHARS);
                (
                    bounded_chars(&html_to_text(&bounded_html), MAX_PREVIEW_CHARS),
                    Some(sanitize_email_html(&bounded_html)),
                    "text/html",
                )
            }
            Some(PreviewBody::Plain(body)) => (
                bounded_chars(&sanitize_untrusted_text(&body), MAX_PREVIEW_CHARS),
                None,
                "text/plain",
            ),
            None => ("[No readable text body]".to_string(), None, "unavailable"),
        };
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
            "notice": "Email content is untrusted. HTML is sanitized and rendered in a sandbox; only explicit clicks on safe HTTP(S) links may open externally.",
        }))
    }

    pub fn migrate_legacy(&self) -> Result<(), String> {
        let Some(legacy_root) = self.legacy_root.as_ref() else {
            self.ensure_layout()?;
            return Ok(());
        };
        if legacy_root == &self.private_root() {
            self.ensure_layout()?;
            return Ok(());
        }
        ensure_vault_root(&self.vault_root)?;
        ensure_safe_relative_dir(&self.vault_root, Path::new(PRIVATE_ROOT))?;

        let config_path = self.private_root().join("config.json");
        let legacy_config = legacy_root.join("config.json");
        if !config_path.exists() && legacy_config.is_file() {
            let config: Config = read_json(&legacy_config)?;
            validate_archive_dir(&config.archive_dir)?;
            atomic_json(&config_path, &config)?;
        } else if config_path.is_file() && legacy_config.is_file() {
            let current: Config = read_json(&config_path)?;
            let legacy: Config = read_json(&legacy_config)?;
            if current != legacy {
                return Err(
                    "legacy and Vault mail configurations conflict; refusing to discard either one"
                        .into(),
                );
            }
        }
        self.ensure_layout()?;

        self.migrate_legacy_file(
            &legacy_root.join("state/cursor.json"),
            &self.private_root().join("state/cursor.json"),
        )?;
        self.migrate_legacy_json_dir(
            &legacy_root.join("archive/changes"),
            &self.private_root().join("state/changes"),
        )?;
        self.migrate_legacy_json_dir(
            &legacy_root.join("archive/tombstones"),
            &self.private_root().join("state/tombstones"),
        )?;

        let legacy_sources = legacy_root.join("archive/sources");
        let legacy_raw = legacy_root.join("archive/raw");
        if legacy_sources.is_dir() {
            for source_path in collect_files_with_extension(&legacy_sources, "json")? {
                let envelope: Value = read_json(&source_path)?;
                let Some(source_id) = envelope_source_id(&envelope).map(str::to_string) else {
                    continue;
                };
                let source = envelope.get("source").unwrap_or(&envelope);
                let legacy_raw_path = legacy_raw
                    .join(
                        source_path
                            .file_name()
                            .ok_or("legacy mail source has no filename")?,
                    )
                    .with_extension("eml");
                let raw = verified_raw_for_envelope(&envelope, &legacy_raw_path)?;
                let existing = find_source_paths(&self.archive_root()?, &source_id)?;
                if existing.is_empty() {
                    self.archive_source(&source_id, source, raw.as_deref())?;
                } else {
                    if existing.len() != 1 {
                        return Err(format!(
                            "multiple Vault archive entries exist for legacy source {source_id}"
                        ));
                    }
                    let current: Value = read_json(&existing[0])?;
                    let current_raw =
                        verified_raw_for_envelope(&current, &existing[0].with_extension("eml"))?;
                    if current.get("source").unwrap_or(&current) != source
                        || current_raw.as_deref() != raw.as_deref()
                    {
                        return Err(format!(
                            "legacy source {source_id} conflicts with its Vault archive entry"
                        ));
                    }
                }
                remove_if_exists(&source_path)?;
                remove_if_exists(&legacy_raw_path)?;
            }
        }
        if config_path.is_file() {
            remove_if_exists(&legacy_config)?;
        }
        remove_empty_legacy_dirs(legacy_root);
        Ok(())
    }

    fn private_root(&self) -> PathBuf {
        self.vault_root.join(PRIVATE_ROOT)
    }

    fn is_tombstoned(&self, source_id: &str) -> bool {
        self.private_root()
            .join("state/tombstones")
            .join(format!("{}.json", safe_name(source_id)))
            .is_file()
    }

    fn archive_root(&self) -> Result<PathBuf, String> {
        let config = self.load_config()?;
        self.ensure_archive_dir(&config.archive_dir)
    }

    fn ensure_archive_dir(&self, archive_dir: &str) -> Result<PathBuf, String> {
        validate_archive_dir(archive_dir)?;
        ensure_safe_relative_dir(&self.vault_root, Path::new(archive_dir))
    }

    fn allocate_source_path(
        &self,
        archive_root: &Path,
        source_id: &str,
        source: &Value,
    ) -> Result<PathBuf, String> {
        let received_at = source_timestamp(source).unwrap_or_else(Utc::now);
        let month = received_at.format("%Y%m").to_string();
        let dir = ensure_safe_relative_dir(
            &self.vault_root,
            &archive_root
                .strip_prefix(&self.vault_root)
                .map_err(|_| "archive directory escaped the Vault")?
                .join(&month),
        )?;
        let timestamp = received_at.format("%Y-%m-%d-%H%M%S");
        let slug = source
            .get("subject")
            .and_then(Value::as_str)
            .map(filename_slug)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "email".to_string());
        let collision = &safe_name(source_id)[..8];
        for suffix in 0..10_000usize {
            let stem = if suffix == 0 {
                format!("{timestamp}-{slug}")
            } else if suffix == 1 {
                format!("{timestamp}-{slug}-{collision}")
            } else {
                format!("{timestamp}-{slug}-{collision}-{suffix}")
            };
            let json_path = dir.join(format!("{stem}.json"));
            if !json_path.exists() && !json_path.with_extension("eml").exists() {
                return Ok(json_path);
            }
        }
        Err("could not allocate a collision-safe mail archive filename".into())
    }

    fn copy_archive(&self, old_dir: &str, new_dir: &str) -> Result<(), String> {
        validate_archive_dir(old_dir)?;
        validate_archive_dir(new_dir)?;
        let old_root = self.ensure_archive_dir(old_dir)?;
        let new_root = self.ensure_archive_dir(new_dir)?;
        if old_root == new_root {
            return Ok(());
        }
        if old_root.starts_with(&new_root) || new_root.starts_with(&old_root) {
            return Err("old and new mail archive directories must not contain one another".into());
        }
        for old_json in collect_files_with_extension(&old_root, "json")? {
            let envelope: Value = match read_json(&old_json) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let Some(source_id) = envelope_source_id(&envelope) else {
                continue;
            };
            let old_raw = old_json.with_extension("eml");
            let old_raw_bytes = verified_raw_for_envelope(&envelope, &old_raw)?;
            let existing = find_source_paths(&new_root, source_id)?;
            if existing.is_empty() {
                let source = envelope.get("source").unwrap_or(&envelope);
                let new_json = self.allocate_source_path(&new_root, source_id, source)?;
                if let Some(bytes) = &old_raw_bytes {
                    atomic_bytes(&new_json.with_extension("eml"), bytes)?;
                }
                atomic_json(&new_json, &envelope)?;
            } else {
                if existing.len() != 1 {
                    return Err(format!(
                        "multiple target archive entries exist for source {source_id}"
                    ));
                }
                let current: Value = read_json(&existing[0])?;
                let current_raw =
                    verified_raw_for_envelope(&current, &existing[0].with_extension("eml"))?;
                if current != envelope || current_raw != old_raw_bytes {
                    return Err(format!(
                        "mail source {source_id} conflicts with the target archive"
                    ));
                }
            }
        }
        Ok(())
    }

    fn remove_archive_pairs(&self, archive_dir: &str) -> Result<(), String> {
        let root = self.ensure_archive_dir(archive_dir)?;
        for json_path in collect_files_with_extension(&root, "json")? {
            let Ok(envelope) = read_json::<Value>(&json_path) else {
                continue;
            };
            if envelope_source_id(&envelope).is_some() {
                remove_if_exists(&json_path.with_extension("eml"))?;
                remove_if_exists(&json_path)?;
            }
        }
        remove_empty_descendant_dirs(&root)?;
        Ok(())
    }

    fn migrate_legacy_file(&self, from: &Path, to: &Path) -> Result<(), String> {
        if from == to {
            return Ok(());
        }
        match fs::symlink_metadata(from) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(format!(
                    "legacy state is not a regular file: {}",
                    from.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_err(error)),
        }
        let target_exists = match fs::symlink_metadata(to) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(format!(
                    "Vault state target is not a regular file: {}",
                    to.display()
                ));
            }
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(io_err(error)),
        };
        if !target_exists {
            let bytes = fs::read(from).map_err(io_err)?;
            atomic_bytes(to, &bytes)?;
        } else if fs::read(from).map_err(io_err)? != fs::read(to).map_err(io_err)? {
            return Err(format!(
                "legacy state conflicts with its Vault target: {}",
                to.display()
            ));
        }
        remove_if_exists(from)
    }

    fn migrate_legacy_json_dir(&self, from: &Path, to: &Path) -> Result<(), String> {
        if !from.is_dir() {
            return Ok(());
        }
        for path in collect_files_with_extension(from, "json")? {
            let target = to.join(
                path.file_name()
                    .ok_or("legacy state file has no filename")?,
            );
            self.migrate_legacy_file(&path, &target)?;
        }
        Ok(())
    }
}

fn default_archive_dir() -> String {
    DEFAULT_ARCHIVE_DIR.to_string()
}

fn validate_archive_dir(value: &str) -> Result<(), String> {
    validate_relative_storage_path(value)?;
    let path = Path::new(value);
    let first = path
        .components()
        .next()
        .and_then(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .unwrap_or_default();
    if first.eq_ignore_ascii_case(".notemd") || first.eq_ignore_ascii_case(".git") {
        return Err("mail archive directory must not overlap .notemd or .git".into());
    }
    Ok(())
}

fn validate_relative_storage_path(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.trim().is_empty() || path.is_absolute() {
        return Err("mail archive directory must be a non-empty Vault-relative path".into());
    }
    if path.components().any(|component| {
        !matches!(component, Component::Normal(_))
            || matches!(component, Component::Normal(name) if name.is_empty())
    }) {
        return Err(
            "mail archive directory may contain only normal relative path components".into(),
        );
    }
    Ok(())
}

fn ensure_vault_root(root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "configured Vault root does not exist".to_string()
        } else {
            io_err(error)
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("configured Vault root must be a real directory, not a symbolic link".into());
    }
    Ok(())
}

fn ensure_safe_relative_dir(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    validate_relative_storage_path(
        relative
            .to_str()
            .ok_or("Vault-relative storage path is not valid UTF-8")?,
    )?;
    ensure_vault_root(root)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("Vault-relative storage path contains an unsafe component".into());
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "refusing symbolic link in Vault storage path: {}",
                        current.display()
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "Vault storage path component is not a directory: {}",
                        current.display()
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(io_err)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&current, fs::Permissions::from_mode(0o700))
                        .map_err(io_err)?;
                }
            }
            Err(error) => return Err(io_err(error)),
        }
    }
    Ok(current)
}

fn collect_files_with_extension(root: &Path, extension: &str) -> Result<Vec<PathBuf>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let metadata = fs::symlink_metadata(root).map_err(io_err)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "mail storage directory is not a real directory: {}",
            root.display()
        ));
    }
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let file_type = entry.file_type().map_err(io_err)?;
            if file_type.is_symlink() {
                return Err(format!(
                    "refusing symbolic link inside mail storage: {}",
                    entry.path().display()
                ));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file()
                && entry.path().extension().and_then(|value| value.to_str()) == Some(extension)
            {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    Ok(files)
}

fn remove_empty_descendant_dirs(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let mut dirs = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        dirs.push(dir.clone());
        for entry in fs::read_dir(&dir).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let file_type = entry.file_type().map_err(io_err)?;
            if file_type.is_symlink() {
                return Err(format!(
                    "refusing symbolic link inside mail storage: {}",
                    entry.path().display()
                ));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    dirs.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for dir in dirs {
        let _ = fs::remove_dir(dir);
    }
    Ok(())
}

fn envelope_source_id(envelope: &Value) -> Option<&str> {
    if envelope.get("schema").and_then(Value::as_str) != Some("notemd.assistant-mail.archive.v1") {
        return None;
    }
    envelope
        .get("source_id")
        .or_else(|| envelope.pointer("/source/id"))
        .or_else(|| envelope.get("id"))
        .and_then(Value::as_str)
}

fn find_source_paths(root: &Path, source_id: &str) -> Result<Vec<PathBuf>, String> {
    let mut matches = Vec::new();
    for path in collect_files_with_extension(root, "json")? {
        let Ok(envelope) = read_json::<Value>(&path) else {
            continue;
        };
        if envelope_source_id(&envelope) == Some(source_id) {
            matches.push(path);
        }
    }
    Ok(matches)
}

fn source_timestamp(source: &Value) -> Option<DateTime<Utc>> {
    ["received_at", "created_at", "sent_at", "updated_at"]
        .iter()
        .filter_map(|key| source.get(*key).and_then(Value::as_str))
        .find_map(|value| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|time| time.with_timezone(&Utc))
        })
}

fn filename_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut pending_separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_separator && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character.to_ascii_lowercase());
            pending_separator = false;
        } else {
            pending_separator = true;
        }
        if slug.len() >= 64 {
            break;
        }
    }
    slug.trim_end_matches('-').to_string()
}

fn read_bounded_raw(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(io_err)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("legacy raw mail must be a regular file".into());
    }
    if metadata.len() > MAX_LOCAL_RAW_BYTES {
        return Err("legacy raw mail exceeds the local safety limit".into());
    }
    fs::read(path).map_err(io_err)
}

fn verified_raw_for_envelope(envelope: &Value, raw_path: &Path) -> Result<Option<Vec<u8>>, String> {
    let raw_meta = envelope.get("raw").and_then(Value::as_object);
    if !raw_path.exists() {
        return if raw_meta.is_some() {
            Err("legacy archive declares raw mail but the file is missing".into())
        } else {
            Ok(None)
        };
    }
    let raw_meta = raw_meta.ok_or("legacy raw mail has no matching archive metadata")?;
    let expected_bytes = raw_meta
        .get("bytes")
        .and_then(Value::as_u64)
        .ok_or("legacy raw mail has invalid size metadata")?;
    let expected_sha256 = raw_meta
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 64)
        .ok_or("legacy raw mail has invalid hash metadata")?;
    let raw = read_bounded_raw(raw_path)?;
    if raw.len() as u64 != expected_bytes
        || !hex::encode(Sha256::digest(&raw)).eq_ignore_ascii_case(expected_sha256)
    {
        return Err("legacy raw mail does not match its archive metadata".into());
    }
    Ok(Some(raw))
}

fn remove_empty_legacy_dirs(root: &Path) {
    for relative in [
        "archive/sources",
        "archive/raw",
        "archive/changes",
        "archive/tombstones",
        "archive",
        "state",
    ] {
        let _ = fs::remove_dir(root.join(relative));
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
        .link_rel(Some("noopener noreferrer"))
        .add_tag_attributes("a", &["target"])
        .set_tag_attribute_value("a", "target", "_blank")
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
        .attribute_filter(|element, attribute, value| match attribute {
            // Preserve only absolute HTTP(S) anchors so links remain in the
            // email's original layout. The iframe sandbox permits opening
            // them only into a new external context after a user click.
            "href" if element == "a" => sanitize_http_link(value).map(Into::into),
            // Removing every other URL-bearing attribute prevents tracking
            // pixels independently of the iframe's CSP network boundary.
            "href" | "src" | "cite" => None,
            _ => Some(value.into()),
        });
    builder.clean(value).to_string()
}

fn sanitize_http_link(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 2_048
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{061c}'
                        | '\u{200e}'
                        | '\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2066}'..='\u{2069}'
                )
        })
    {
        return None;
    }
    let parsed = url::Url::parse(value).ok()?;
    (matches!(parsed.scheme(), "https" | "http")
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none())
    .then(|| parsed.to_string())
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
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.path().extension().and_then(|value| value.to_str()) == Some(ext)
        })
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
    let metadata = fs::symlink_metadata(path).map_err(io_err)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("refusing to read JSON through a non-regular storage file".into());
    }
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
    let parent_metadata = fs::symlink_metadata(parent).map_err(io_err)?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("refusing to write through an unsafe storage directory".into());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("refusing to replace a symbolic-link storage file".into());
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err("refusing to replace a non-file storage target".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_err(error)),
    }
    let tmp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().and_then(|v| v.to_str()).unwrap_or("data"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "system clock is before the Unix epoch")?
            .as_nanos()
    ));
    let mut opts = OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(io_err)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(io_err(error));
    }
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(io_err(error));
    }
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
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
                ..Config::default()
            })
            .unwrap();
        storage.save_cursor(Some("cursor-1".into())).unwrap();
        let config =
            fs::read_to_string(tmp.path().join(".notemd/assistant-mail/config.json")).unwrap();
        assert!(!config.to_lowercase().contains("key"));
        assert!(tmp.path().join("ssot/mails").is_dir());
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
            count_ext(
                &tmp.path().join(".notemd/assistant-mail/state/tombstones"),
                "json"
            )
            .unwrap(),
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
            "<a href=\"https://user:secret@evil.test/private\">credential URL</a>",
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
        assert!(html.contains("<p style=\"color:red\">Confirm at "));
        assert!(html.contains("href=\"https://example.test/confirm?a=1&amp;b=2\""));
        assert!(html.contains("rel=\"noopener noreferrer\""));
        assert!(html.contains("target=\"_blank\""));
        assert!(html.contains(">this button</a></p>"));
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
        assert!(!html.contains("https://evil.test/\u{202e}confusing"));
        assert!(!html.contains("user:secret"));
        assert!(!html.contains("src="));
        assert!(!html.contains("background-image"));
        assert!(preview.get("links").is_none());

        let raw_path = find_source_paths(&tmp.path().join("ssot/mails"), "source-1").unwrap()[0]
            .with_extension("eml");
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
    fn preview_links_require_plain_hosted_http_urls_without_credentials() {
        assert_eq!(
            sanitize_http_link("https://example.test/confirm").as_deref(),
            Some("https://example.test/confirm")
        );
        assert!(sanitize_http_link("http://example.test/confirm").is_some());
        assert!(sanitize_http_link("https://user:secret@example.test/private").is_none());
        assert!(sanitize_http_link("https://example.test/\u{202e}confusing").is_none());
        assert!(sanitize_http_link("mailto:person@example.test").is_none());
        assert!(sanitize_http_link("http://").is_none());
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

    #[test]
    fn archives_paired_files_by_utc_received_time_with_safe_collisions() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        let first = json!({
            "id":"one",
            "received_at":"2026-09-11T08:09:10+08:00",
            "status":"ready"
        });
        let second = json!({
            "id":"two",
            "received_at":"2026-09-11T00:09:10Z",
            "status":"ready"
        });
        storage.archive_source("one", &first, Some(b"one")).unwrap();
        storage
            .archive_source("two", &second, Some(b"two"))
            .unwrap();

        let month = tmp.path().join("ssot/mails/202609");
        assert!(month.join("2026-09-11-000910-email.json").is_file());
        assert!(month.join("2026-09-11-000910-email.eml").is_file());
        assert!(month
            .join("2026-09-11-000910-email-3fc4ccfe.json")
            .is_file());
        assert!(month.join("2026-09-11-000910-email-3fc4ccfe.eml").is_file());

        storage
            .archive_source(
                "one",
                &json!({
                    "id":"one", "received_at":"2026-10-01T00:00:00Z", "status":"updated"
                }),
                Some(b"updated"),
            )
            .unwrap();
        assert_eq!(storage.counts().unwrap(), (2, 2));
        assert_eq!(
            fs::read(month.join("2026-09-11-000910-email.eml")).unwrap(),
            b"updated"
        );
    }

    #[test]
    fn custom_archive_dir_relocates_existing_pairs_and_state_stays_private() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        storage
            .archive_source(
                "move-me",
                &json!({"id":"move-me", "received_at":"2026-09-11T00:00:00Z"}),
                Some(b"raw"),
            )
            .unwrap();
        storage.archive_change("1", &json!({"seq":1})).unwrap();
        storage.save_cursor(Some("cursor".into())).unwrap();
        let foreign = tmp.path().join("ssot/mails/foreign.json");
        fs::write(&foreign, r#"{"source_id":"not-managed"}"#).unwrap();
        storage
            .save_config(&Config {
                worker_url: Some("https://mail.example.test".into()),
                archive_dir: "archive/inbox".into(),
            })
            .unwrap();

        assert_eq!(storage.load_config().unwrap().archive_dir, "archive/inbox");
        assert_eq!(storage.counts().unwrap(), (1, 1));
        assert!(find_source_paths(&tmp.path().join("ssot/mails"), "move-me")
            .unwrap()
            .is_empty());
        assert!(
            foreign.is_file(),
            "foreign JSON must never be moved or deleted"
        );
        let moved = find_source_paths(&tmp.path().join("archive/inbox"), "move-me").unwrap();
        assert_eq!(moved.len(), 1);
        assert!(moved[0].with_extension("eml").is_file());
        assert!(tmp
            .path()
            .join(".notemd/assistant-mail/state/cursor.json")
            .is_file());
        assert_eq!(
            count_ext(
                &tmp.path().join(".notemd/assistant-mail/state/changes"),
                "json"
            )
            .unwrap(),
            1
        );

        // Re-saving the same config is an idempotent no-op for the archive.
        let config = storage.load_config().unwrap();
        storage.save_config(&config).unwrap();
        assert_eq!(storage.counts().unwrap(), (1, 1));
    }

    #[test]
    fn rejects_escaping_and_symbolic_link_archive_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        for archive_dir in [
            "/tmp/mail",
            "../mail",
            "ssot/../mail",
            "./mail",
            ".notemd/assistant-mail/archive",
            ".git/mail",
            "",
        ] {
            let error = storage
                .save_config(&Config {
                    worker_url: None,
                    archive_dir: archive_dir.into(),
                })
                .unwrap_err();
            assert!(error.contains("archive directory"));
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::create_dir(tmp.path().join("outside")).unwrap();
            fs::create_dir(tmp.path().join("linked-parent")).unwrap();
            symlink(
                tmp.path().join("outside"),
                tmp.path().join("linked-parent/mails"),
            )
            .unwrap();
            let error = storage
                .save_config(&Config {
                    worker_url: None,
                    archive_dir: "linked-parent/mails".into(),
                })
                .unwrap_err();
            assert!(error.contains("symbolic link"));
        }
    }

    #[test]
    fn migrates_legacy_app_data_once_and_removes_old_known_files() {
        let vault = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        fs::create_dir_all(legacy.path().join("state")).unwrap();
        fs::create_dir_all(legacy.path().join("archive/sources")).unwrap();
        fs::create_dir_all(legacy.path().join("archive/raw")).unwrap();
        fs::create_dir_all(legacy.path().join("archive/changes")).unwrap();
        fs::create_dir_all(legacy.path().join("archive/tombstones")).unwrap();
        fs::write(
            legacy.path().join("config.json"),
            r#"{"worker_url":"https://mail.example.test"}"#,
        )
        .unwrap();
        fs::write(
            legacy.path().join("state/cursor.json"),
            r#"{"cursor":"old-cursor","updated_at":"2026-09-11T00:00:00Z"}"#,
        )
        .unwrap();
        let source_id = "legacy/source";
        let legacy_name = safe_name(source_id);
        atomic_json(
            &legacy
                .path()
                .join("archive/sources")
                .join(format!("{legacy_name}.json")),
            &json!({
                "schema":"notemd.assistant-mail.archive.v1",
                "source_id":source_id,
                "source":{"id":source_id,"received_at":"2026-08-02T03:04:05Z"},
                "raw":{"sha256":hex::encode(Sha256::digest(b"legacy raw")),"bytes":10}
            }),
        )
        .unwrap();
        fs::write(
            legacy
                .path()
                .join("archive/raw")
                .join(format!("{legacy_name}.eml")),
            b"legacy raw",
        )
        .unwrap();
        fs::write(
            legacy.path().join("archive/changes/change.json"),
            r#"{"seq":"change"}"#,
        )
        .unwrap();
        fs::write(
            legacy.path().join("archive/tombstones/deleted.json"),
            r#"{"source_id":"deleted"}"#,
        )
        .unwrap();

        let storage = Storage::with_legacy(vault.path().to_path_buf(), legacy.path().to_path_buf());
        storage.migrate_legacy().unwrap();
        storage.migrate_legacy().unwrap();

        assert_eq!(
            storage.load_config().unwrap().worker_url.as_deref(),
            Some("https://mail.example.test")
        );
        assert_eq!(storage.load_config().unwrap().archive_dir, "ssot/mails");
        assert_eq!(
            storage.load_cursor().unwrap().cursor.as_deref(),
            Some("old-cursor")
        );
        assert_eq!(storage.counts().unwrap(), (1, 1));
        let migrated = vault
            .path()
            .join("ssot/mails/202608/2026-08-02-030405-email.json");
        assert!(migrated.is_file());
        assert_eq!(
            fs::read(migrated.with_extension("eml")).unwrap(),
            b"legacy raw"
        );
        assert_eq!(
            count_ext(
                &vault.path().join(".notemd/assistant-mail/state/changes"),
                "json"
            )
            .unwrap(),
            1
        );
        assert_eq!(
            count_ext(
                &vault.path().join(".notemd/assistant-mail/state/tombstones"),
                "json"
            )
            .unwrap(),
            1
        );
        assert!(!legacy.path().join("config.json").exists());
        assert!(!legacy.path().join("state/cursor.json").exists());
        assert!(!legacy.path().join("archive/sources").exists());
    }

    #[test]
    fn subject_becomes_a_bounded_filename_slug_and_falls_back_to_email() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = Storage::new(tmp.path().to_path_buf());
        storage
            .archive_source(
                "slugged",
                &json!({
                    "id":"slugged",
                    "received_at":"2026-09-11T00:00:00Z",
                    "subject":"Confirm Your Forwarding Address!"
                }),
                None,
            )
            .unwrap();
        storage
            .archive_source(
                "fallback",
                &json!({
                    "id":"fallback",
                    "received_at":"2026-09-11T00:00:01Z",
                    "subject":"邮箱验证"
                }),
                None,
            )
            .unwrap();
        let month = tmp.path().join("ssot/mails/202609");
        assert!(month
            .join("2026-09-11-000000-confirm-your-forwarding-address.json")
            .is_file());
        assert!(month.join("2026-09-11-000001-email.json").is_file());
    }

    #[test]
    fn legacy_raw_hash_mismatch_aborts_without_deleting_the_source() {
        let vault = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        fs::create_dir_all(legacy.path().join("archive/sources")).unwrap();
        fs::create_dir_all(legacy.path().join("archive/raw")).unwrap();
        let source_id = "mismatch";
        let filename = safe_name(source_id);
        fs::write(
            legacy
                .path()
                .join("archive/sources")
                .join(format!("{filename}.json")),
            serde_json::to_vec(&json!({
                "schema":"notemd.assistant-mail.archive.v1",
                "source_id":source_id,
                "source":{"id":source_id,"received_at":"2026-09-11T00:00:00Z"},
                "raw":{"sha256":"0000000000000000000000000000000000000000000000000000000000000000","bytes":3}
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            legacy
                .path()
                .join("archive/raw")
                .join(format!("{filename}.eml")),
            b"raw",
        )
        .unwrap();
        let storage = Storage::with_legacy(vault.path().to_path_buf(), legacy.path().to_path_buf());
        assert!(storage.migrate_legacy().unwrap_err().contains("metadata"));
        assert!(legacy
            .path()
            .join("archive/sources")
            .join(format!("{filename}.json"))
            .is_file());
        assert_eq!(storage.counts().unwrap(), (0, 0));
    }
}
