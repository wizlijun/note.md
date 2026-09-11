use crate::client::{validate_worker_url, WorkerClient};
use crate::credentials::{
    configured_vault_root, validate_access_key, CredentialStore, VaultCredentialStore,
    RELATIVE_KEY_PATH,
};
use crate::storage::{Config, Storage};
use chrono::NaiveDate;
use chrono_tz::Tz;
use notemd_plugin_sdk as sdk;
use sdk::plugin_protocol as proto;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub struct AssistantMailPlugin {
    legacy_data_dir: PathBuf,
    /// Plans enter this map only after the trusted plugin window has received
    /// their full body. CLI-created plans deliberately do not enter it.
    visible_plans: HashMap<String, (String, PathBuf)>,
}

impl AssistantMailPlugin {
    pub fn new() -> Self {
        Self {
            legacy_data_dir: std::env::temp_dir().join("notemd-assistant-mail-uninitialized"),
            visible_plans: HashMap::new(),
        }
    }

    fn storage(&self) -> Result<Storage, String> {
        let vault = configured_vault_root()?
            .ok_or("Vault is not configured; Assistant Mail cannot access its Vault archive")?;
        let storage = Storage::with_legacy(vault, self.legacy_data_dir.clone());
        storage.migrate_legacy()?;
        Ok(storage)
    }

    fn credential_store(&self) -> Result<VaultCredentialStore, String> {
        let vault = configured_vault_root()?
            .ok_or("Vault is not configured; Assistant Mail cannot access its Vault key")?;
        Ok(VaultCredentialStore::new(vault))
    }

    fn with_client<T>(
        &self,
        use_client: impl FnOnce(&WorkerClient) -> Result<T, String>,
    ) -> Result<T, String> {
        let run = || {
            let config = self.storage()?.load_config()?;
            let url = config
                .worker_url
                .as_deref()
                .ok_or("Assistant Mail Worker URL is not configured")?;
            let key = self
                .credential_store()?
                .get()?
                .ok_or("Assistant Mail access key is not configured")?;
            let client = WorkerClient::new(url, key)?;
            use_client(&client)
            // `client` drops inside this closure. reqwest's blocking client
            // owns a helper runtime which must also drop in a blocking region.
        };
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(run)
        } else {
            run()
        }
    }

    fn local_status(&self) -> Result<Value, String> {
        let vault = configured_vault_root()?;
        let (config, cursor, archived_sources, archived_raw) = match &vault {
            Some(root) => {
                let storage = Storage::with_legacy(root.clone(), self.legacy_data_dir.clone());
                storage.migrate_legacy()?;
                let config = storage.load_config()?;
                let cursor = storage.load_cursor()?.cursor;
                let (sources, raw) = storage.counts()?;
                (config, cursor, sources, raw)
            }
            None => (Config::default(), None, 0, 0),
        };
        let key = match &vault {
            Some(root) => VaultCredentialStore::new(root.clone()).get()?,
            None => None,
        };
        Ok(json!({
            "worker_url": config.worker_url,
            "archive_dir": config.archive_dir,
            "vault_configured": vault.is_some(),
            "credential_path": RELATIVE_KEY_PATH,
            "key_configured": key.is_some(),
            "key_fingerprint": key.as_deref().map(key_fingerprint),
            "local_cursor": cursor,
            "archived_sources": archived_sources,
            "archived_raw": archived_raw,
        }))
    }

    fn status(&self) -> Result<Value, String> {
        let mut local = self.local_status()?;
        let configured = local.get("worker_url").is_some_and(|v| !v.is_null())
            && local
                .get("key_configured")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let remote = if configured {
            Some(self.with_client(|client| client.status())?)
        } else {
            None
        };
        local
            .as_object_mut()
            .unwrap()
            .insert("remote".into(), remote.unwrap_or(Value::Null));
        Ok(local)
    }

    fn sync(&self) -> Result<Value, String> {
        let storage = self.storage()?;
        self.with_client(|client| self.sync_with_client(&storage, client))
    }

    fn sync_with_client(&self, storage: &Storage, client: &WorkerClient) -> Result<Value, String> {
        storage.ensure_layout()?;
        let mut cursor = storage.load_cursor()?.cursor;
        let from_cursor = cursor.clone();
        let mut page_count = 0usize;
        let mut change_count = 0usize;
        let mut source_count = 0usize;
        let mut tombstone_count = 0usize;

        loop {
            page_count += 1;
            if page_count > 10_000 {
                return Err("Worker pagination exceeded the safety limit".into());
            }
            let page = client.changes(cursor.as_deref(), 100)?;
            for change in &page.changes {
                let seq = change.get("seq").map(value_id).unwrap_or_else(|| {
                    change
                        .get("cursor")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string()
                });
                storage.archive_change(&seq, change)?;
                if change.get("entity_type").and_then(Value::as_str) != Some("source") {
                    continue;
                }
                let source_id = change
                    .get("entity_id")
                    .and_then(Value::as_str)
                    .or_else(|| change.pointer("/payload/source_id").and_then(Value::as_str))
                    .or_else(|| change.pointer("/payload/id").and_then(Value::as_str))
                    .ok_or("source change has no entity_id")?;
                if is_tombstone(change) {
                    storage.apply_tombstone(source_id, change)?;
                    tombstone_count += 1;
                } else {
                    match client.source(source_id)? {
                        Some(source) => {
                            let raw = client.raw(source_id)?;
                            verify_raw(&source, raw.as_deref())?;
                            storage.archive_source(source_id, &source, raw.as_deref())?;
                            source_count += 1;
                        }
                        None => {
                            storage.apply_tombstone(
                                source_id,
                                &json!({
                                    "type": "source.deleted",
                                    "source_id": source_id,
                                    "reason": "worker_returned_gone_during_sync"
                                }),
                            )?;
                            tombstone_count += 1;
                        }
                    }
                }
            }
            change_count += page.changes.len();

            let next = page.next_cursor.clone().or_else(|| {
                page.changes
                    .last()
                    .and_then(|c| c.get("cursor"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            if let Some(next_cursor) = next {
                if cursor.as_deref() == Some(next_cursor.as_str()) && page.has_more {
                    return Err("Worker returned a non-advancing pagination cursor".into());
                }
                storage.save_cursor(Some(next_cursor.clone()))?;
                cursor = Some(next_cursor);
            } else if page.has_more {
                return Err("Worker says more changes exist but returned no cursor".into());
            }
            if !page.has_more {
                break;
            }
        }

        Ok(json!({
            "ok": true,
            "from_cursor": from_cursor,
            "to_cursor": cursor,
            "pages": page_count,
            "changes": change_count,
            "sources_archived": source_count,
            "tombstones_applied": tombstone_count,
        }))
    }

    fn query(&self, params: &Value) -> Result<Value, String> {
        let text = param_str(params, "text");
        let status = param_str(params, "status");
        let date_text = param_str(params, "date");
        let timezone_text = param_str(params, "timezone");
        let (date, timezone) = match (date_text.as_deref(), timezone_text.as_deref()) {
            (None, None) => (None, None),
            (Some(date), Some(timezone)) => {
                let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .map_err(|_| "--date must be YYYY-MM-DD".to_string())?;
                let timezone: Tz = timezone.parse()
                    .map_err(|_| "--timezone must be a valid IANA timezone".to_string())?;
                (Some(date), Some(timezone))
            }
            _ => return Err("--date and --timezone must be provided together; system timezone is never inferred".into()),
        };
        let limit = match param_str(params, "limit") {
            None => 20,
            Some(value) => value
                .parse::<usize>()
                .ok()
                .filter(|value| (1..=100).contains(value))
                .ok_or("--limit must be an integer from 1 to 100")?,
        };
        let result =
            self.storage()?
                .query(text.as_deref(), status.as_deref(), date, timezone, limit)?;
        let count = result.rows.len();
        Ok(json!({
            "results": result.rows,
            "count": count,
            "coverage": result.coverage,
            "date": date_text,
            "timezone": timezone_text,
            "raw_included": false,
            "untrusted_text_included": false,
        }))
    }

    fn create_delete_plan(&self, params: &Value) -> Result<Value, String> {
        let source_ids = source_ids(params)?;
        self.with_client(|client| client.create_deletion_plan(&source_ids))
    }

    fn delete_status(&self, params: &Value) -> Result<Value, String> {
        match (param_str(params, "plan"), param_str(params, "job")) {
            (Some(plan), None) => {
                self.with_client(|client| client.deletion_plan(&validate_id("plan", &plan)?))
            }
            (None, Some(job)) => {
                self.with_client(|client| client.deletion_job(&validate_id("job", &job)?))
            }
            _ => Err("specify exactly one of --plan or --job".into()),
        }
    }

    fn remember_visible_plan(&mut self, plan: &Value) -> Result<(), String> {
        let id = plan
            .get("id")
            .or_else(|| plan.get("plan_id"))
            .and_then(Value::as_str)
            .ok_or("Worker deletion plan has no id")?;
        let hash = plan
            .get("plan_hash")
            .and_then(Value::as_str)
            .ok_or("Worker deletion plan has no plan_hash")?;
        let vault = configured_vault_root()?
            .ok_or("Vault is not configured; Assistant Mail cannot remember a delete plan")?;
        self.visible_plans
            .insert(id.to_string(), (hash.to_string(), vault));
        Ok(())
    }

    fn ui_execute_delete(&mut self, params: &Value) -> Result<Value, String> {
        if params.get("confirmation").and_then(Value::as_str) != Some("DELETE") {
            return Err("type DELETE in the Assistant Mail settings window to confirm".into());
        }
        let plan_id = validate_id(
            "plan",
            params.get("plan_id").and_then(Value::as_str).unwrap_or(""),
        )?;
        let plan_hash = validate_id(
            "plan hash",
            params
                .get("plan_hash")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )?;
        let current_vault = configured_vault_root()?
            .ok_or("Vault is not configured; Assistant Mail cannot execute a delete plan")?;
        match self.visible_plans.get(&plan_id) {
            Some((visible_hash, vault))
                if visible_hash == &plan_hash && vault == &current_vault => {}
            _ => {
                return Err(
                    "this exact plan hash has not been displayed in the trusted plugin window"
                        .into(),
                )
            }
        }
        // Re-read immediately before commit. A changed/expired plan cannot be
        // executed with an older hash even if the Worker were permissive.
        let (current, result) = self.with_client(|client| {
            let current = client.deletion_plan(&plan_id)?;
            if current.get("plan_hash").and_then(Value::as_str) != Some(plan_hash.as_str()) {
                return Ok((current, None));
            }
            let result = client.execute_deletion_plan(&plan_id, &plan_hash)?;
            Ok((current, Some(result)))
        })?;
        if current.get("plan_hash").and_then(Value::as_str) != Some(plan_hash.as_str()) {
            self.visible_plans.remove(&plan_id);
            return Err("deletion plan changed or expired; review it again".into());
        }
        let result = result.ok_or("deletion plan was not executed")?;
        self.visible_plans.remove(&plan_id); // single-use in this process
        Ok(result)
    }
}

impl sdk::NotemdPlugin for AssistantMailPlugin {
    fn initialize(&mut self, _host: &sdk::Host, params: &proto::InitializeParams) {
        self.legacy_data_dir = PathBuf::from(&params.data_dir);
    }

    fn activate(
        &mut self,
        host: &sdk::Host,
        _params: &proto::ActivateParams,
    ) -> Result<(), String> {
        match configured_vault_root()? {
            Some(_) => self.storage()?.ensure_layout().inspect_err(|_error| {
                host.log_error("assistant-mail: could not initialize Vault storage");
            }),
            None => Ok(()),
        }
    }

    fn deactivate(&mut self, _host: &sdk::Host) {
        self.visible_plans.clear();
    }

    fn execute_command(
        &mut self,
        _host: &sdk::Host,
        params: &proto::ExecuteCommandParams,
    ) -> Result<Value, String> {
        match params.command.as_str() {
            "status" => self.status(),
            "sync" => self.sync(),
            "query" => self.query(&params.context),
            "delete-plan" => self.create_delete_plan(&params.context),
            "delete-status" => self.delete_status(&params.context),
            // Deliberately no delete/execute command. Permanent deletion is a
            // trusted-window-only RPC guarded by a displayed exact plan hash.
            other => Err(format!("unknown or forbidden command '{other}'")),
        }
    }

    fn on_ui_request(
        &mut self,
        _host: &sdk::Host,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        match method {
            "settings.get" => self.local_status(),
            "settings.save" => {
                let worker_url = validate_worker_url(
                    params
                        .get("worker_url")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                )?;
                if !matches!(
                    worker_url.as_str(),
                    "https://mail.5000g.com" | "https://notemd-assistant-mail.oldbruce.workers.dev"
                ) {
                    return Err("Assistant Mail Worker URL is not an approved deployment".into());
                }
                if let Some(key) = params
                    .get("access_key")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
                {
                    validate_access_key(key)?;
                    self.credential_store()?.set(key)?;
                }
                let storage = self.storage()?;
                let archive_dir = params
                    .get("archive_dir")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("archive_dir must be a non-empty Vault-relative path")?
                    .to_string();
                storage.save_config(&Config {
                    worker_url: Some(worker_url),
                    archive_dir,
                })?;
                self.visible_plans.clear();
                self.local_status()
            }
            "settings.delete_key" => {
                self.credential_store()?.delete()?;
                self.visible_plans.clear();
                self.local_status()
            }
            "connection.test" => {
                let whoami = self.with_client(|client| client.whoami())?;
                Ok(json!({"ok": true, "whoami": whoami}))
            }
            "intake.policy.get" => self.with_client(|client| client.intake_policy()),
            "intake.policy.save" => {
                let enabled = params
                    .get("sender_filter_enabled")
                    .and_then(Value::as_bool)
                    .ok_or("sender_filter_enabled must be a boolean")?;
                let sender = params
                    .get("allowed_sender")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                self.with_client(|client| client.save_intake_policy(enabled, sender))
            }
            "status" => self.status(),
            "sync" => self.sync(),
            "query" => self.query(&params),
            "messages.list" => Ok(json!({"messages": self.storage()?.list_messages()?})),
            "messages.preview" => {
                let source_id = validate_id(
                    "source",
                    params
                        .get("source_id")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                )?;
                self.storage()?.message_preview(&source_id)
            }
            "link.open" => open_external_link(&params),
            "delete.plan.create" => {
                let plan = self.create_delete_plan(&params)?;
                self.remember_visible_plan(&plan)?;
                Ok(plan)
            }
            "delete.plan.get" => {
                let plan_id = validate_id(
                    "plan",
                    params.get("plan_id").and_then(Value::as_str).unwrap_or(""),
                )?;
                let plan = self.with_client(|client| client.deletion_plan(&plan_id))?;
                self.remember_visible_plan(&plan)?;
                Ok(plan)
            }
            "delete.plan.execute" => self.ui_execute_delete(&params),
            "delete.job.get" => {
                let job_id = validate_id(
                    "job",
                    params.get("job_id").and_then(Value::as_str).unwrap_or(""),
                )?;
                self.with_client(|client| client.deletion_job(&job_id))
            }
            other => Err(format!("unknown ui method '{other}'")),
        }
    }
}

fn key_fingerprint(key: &str) -> String {
    format!(
        "sha256:{}",
        &hex::encode(Sha256::digest(key.as_bytes()))[..12]
    )
}

fn validate_external_link(value: &str) -> Result<url::Url, String> {
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
        return Err("mail link is invalid or too long".into());
    }
    let parsed = url::Url::parse(value).map_err(|_| "mail link is not a valid URL")?;
    if !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("only HTTP(S) mail links can be opened".into());
    }
    Ok(parsed)
}

fn open_external_link(params: &Value) -> Result<Value, String> {
    let value = params
        .get("url")
        .and_then(Value::as_str)
        .ok_or("mail link URL is required")?;
    let url = validate_external_link(value)?;
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/open")
            .arg("-u")
            .arg(url.as_str())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "could not open mail link in the system browser")?;
        if !status.success() {
            return Err("could not open mail link in the system browser".into());
        }
        Ok(json!({"ok": true}))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("opening mail links is not supported on this platform".into())
    }
}

fn value_id(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn is_tombstone(change: &Value) -> bool {
    change
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|v| v.contains("deleted") || v.contains("tombstone"))
        || change
            .pointer("/payload/deleted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn verify_raw(source: &Value, raw: Option<&[u8]>) -> Result<(), String> {
    let Some(bytes) = raw else {
        if source.get("status").and_then(Value::as_str) == Some("ready") {
            return Err("Worker marked a source ready but its raw MIME is unavailable".into());
        }
        return Ok(());
    };
    if let Some(expected) = source.get("raw_size").and_then(Value::as_u64) {
        if expected != bytes.len() as u64 {
            return Err("raw MIME size did not match Worker metadata".into());
        }
    }
    if let Some(expected) = source.get("raw_sha256").and_then(Value::as_str) {
        let actual = hex::encode(Sha256::digest(bytes));
        if !expected.eq_ignore_ascii_case(&actual) {
            return Err("raw MIME SHA-256 did not match Worker metadata".into());
        }
    }
    Ok(())
}

fn param_str(value: &Value, key: &str) -> Option<String> {
    for pointer in [
        format!("/cli/flags/{key}"),
        format!("/cli/args/{key}"),
        format!("/cli/{key}"),
        format!("/{key}"),
    ] {
        if let Some(value) = value
            .pointer(&pointer)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            return Some(value.to_string());
        }
    }
    None
}

fn source_ids(params: &Value) -> Result<Vec<String>, String> {
    let raw: Vec<String> = if let Some(values) = params.get("source_ids").and_then(Value::as_array)
    {
        values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    } else {
        param_str(params, "source-ids")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .collect()
    };
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for value in raw {
        let value = validate_id("source", &value)?;
        if seen.insert(value.clone()) {
            ids.push(value);
        }
    }
    if ids.is_empty() {
        return Err("at least one exact source ID is required".into());
    }
    if ids.len() > 100 {
        return Err("a deletion plan may contain at most 100 source IDs".into());
    }
    Ok(ids)
}

fn validate_id(kind: &str, value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(format!("invalid {kind} id"));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_flags_are_read_from_host_context() {
        let context = json!({"cli":{"flags":{"text":"flight","limit":"7"}}});
        assert_eq!(param_str(&context, "text").as_deref(), Some("flight"));
        assert_eq!(param_str(&context, "limit").as_deref(), Some("7"));
    }

    #[test]
    fn source_ids_are_exact_deduplicated_and_bounded() {
        assert_eq!(
            source_ids(&json!({"source_ids":["a","b","a"]})).unwrap(),
            vec!["a", "b"]
        );
        assert!(source_ids(&json!({"source_ids":[]})).is_err());
        assert!(source_ids(&json!({"source_ids":["bad\n"]})).is_err());
    }

    #[test]
    fn access_key_fingerprint_reveals_no_key_material() {
        let key = "very-secret-access-key-1234567890";
        let fingerprint = key_fingerprint(key);
        assert!(fingerprint.starts_with("sha256:"));
        assert!(!fingerprint.contains("very-secret"));
    }

    #[test]
    fn external_mail_links_are_restricted_to_absolute_http_urls() {
        assert_eq!(
            validate_external_link("https://example.test/confirm?a=1")
                .unwrap()
                .scheme(),
            "https"
        );
        assert!(validate_external_link("http://example.test/").is_ok());
        assert!(validate_external_link("javascript:alert(1)").is_err());
        assert!(validate_external_link("mailto:user@example.test").is_err());
        assert!(validate_external_link("/relative").is_err());
        assert!(validate_external_link("https://example.test/\nheader").is_err());
        assert!(validate_external_link("https://trusted.test@evil.test/").is_err());
        assert!(validate_external_link("https://example.test/\u{202e}path").is_err());
    }

    #[test]
    fn daily_query_never_infers_or_accepts_invalid_timezone() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = AssistantMailPlugin {
            legacy_data_dir: tmp.path().join("legacy"),
            visible_plans: HashMap::new(),
        };
        assert!(plugin
            .query(&json!({"date":"2026-09-11"}))
            .unwrap_err()
            .contains("provided together"));
        assert!(plugin
            .query(&json!({"date":"2026-09-11","timezone":"Taipei"}))
            .unwrap_err()
            .contains("IANA"));
        assert!(plugin
            .query(&json!({"limit":"not-a-number"}))
            .unwrap_err()
            .contains("1 to 100"));
        assert!(plugin
            .query(&json!({"limit":"101"}))
            .unwrap_err()
            .contains("1 to 100"));
    }

    #[test]
    fn manifest_is_valid_for_the_declared_host_baseline() {
        let manifest: proto::ManifestV2 =
            serde_json::from_str(include_str!("../../manifest.v2.json")).unwrap();
        proto::validate_manifest(&manifest, "6.910.3").unwrap();
    }

    #[test]
    fn raw_bytes_must_match_worker_size_and_hash_before_archive() {
        let bytes = b"From: sender@example.com\r\n\r\nhello";
        let source = json!({
            "status":"ready",
            "raw_size":bytes.len(),
            "raw_sha256":hex::encode(Sha256::digest(bytes)),
        });
        assert!(verify_raw(&source, Some(bytes)).is_ok());
        assert!(verify_raw(&source, Some(b"different")).is_err());
        assert!(verify_raw(&source, None).is_err());
    }
}
