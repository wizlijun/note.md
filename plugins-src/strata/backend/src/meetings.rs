//! Meeting knowledge uses the authorized Vault RPC lane, never direct Vault IO.
use crate::{index, rpc::Host, task};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

const ROOT: &str = "ssot/meetings";
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 12;
const MAX_DIRECTORIES: usize = 10_000;
const MAX_FILES: usize = 5_000;
const MAX_ENTRIES: usize = 100_000;
const COLLECTIONS: [(&str, u8); 6] = [
    ("entities", b'e'),
    ("concepts", b'c'),
    ("claims", b'q'),
    ("events", b'v'),
    ("narratives", b'n'),
    ("relations", b'r'),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub content_hash: String,
    pub content: String,
    pub date: Option<String>,
    pub date_inferred: bool,
}

#[derive(Debug, Serialize)]
pub struct Diagnostic {
    code: &'static str,
    message: &'static str,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    schema: &'static str,
    vault_key: String,
    dataset_key: String,
    snapshot_id: String,
    pub documents: Vec<Document>,
    diagnostics: Vec<Diagnostic>,
    missing_knowledge: usize,
}

fn budget(condition: bool) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err("MEETINGS_LIMIT: 会议数据超过本次读取预算，未返回部分结果".into())
    }
}

fn component(name: &str) -> bool {
    !name.is_empty() && !matches!(name, "." | "..") && !name.contains(['/', '\\', '\0', ':'])
}

fn knowledge_path(path: &str) -> bool {
    path.len() <= 4096
        && path.starts_with("ssot/meetings/")
        && path.ends_with("/knowledge.json")
        && index::safe_path(path)
}

async fn read(host: &dyn Host, path: &str, total: &mut usize) -> Result<String, String> {
    let value = host
        .request("host.vault.read", json!({"path":path}))
        .await?;
    let content = value["content"]
        .as_str()
        .ok_or("MEETINGS_PROTOCOL: 文件内容格式无效")?;
    *total = total
        .checked_add(content.len())
        .ok_or("MEETINGS_LIMIT: 读取字节数溢出")?;
    budget(*total <= MAX_BYTES)?;
    Ok(content.into())
}

fn parse_date(value: &str) -> Option<String> {
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Some(date.date_naive().format("%Y-%m-%d").to_string());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(date) = NaiveDateTime::parse_from_str(value, format) {
            return Some(date.date().format("%Y-%m-%d").to_string());
        }
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .filter(|date| date.format("%Y-%m-%d").to_string() == value)
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn directory_date(path: &str) -> Option<String> {
    path.split('/').rev().find_map(|part| {
        let prefix = part.get(..8)?;
        if !prefix.bytes().all(|b| b.is_ascii_digit())
            || part
                .as_bytes()
                .get(8)
                .is_some_and(|b| !matches!(b, b'_' | b'-'))
        {
            return None;
        }
        NaiveDate::parse_from_str(prefix, "%Y%m%d")
            .ok()
            .map(|date| date.format("%Y-%m-%d").to_string())
    })
}

pub async fn snapshot(host: &dyn Host, root: &str, vault_key: &str) -> Result<Snapshot, String> {
    let exists = host
        .request("host.vault.exists", json!({"path":ROOT}))
        .await?;
    let exists = exists["exists"]
        .as_bool()
        .ok_or("MEETINGS_PROTOCOL: 目录状态格式无效")?;
    let mut queue = VecDeque::new();
    if exists {
        queue.push_back((ROOT.to_string(), 0));
    }
    let mut directories = usize::from(exists);
    let mut entries_seen = 0usize;
    let mut bytes = 0usize;
    let mut documents = Vec::new();
    let mut diagnostics = Vec::new();
    let mut missing_knowledge = 0;
    while let Some((directory, depth)) = queue.pop_front() {
        let listed = host
            .request("host.vault.list", json!({"path":directory}))
            .await?;
        let entries = listed["entries"]
            .as_array()
            .ok_or("MEETINGS_PROTOCOL: 目录列表格式无效")?;
        entries_seen += entries.len();
        budget(entries_seen <= MAX_ENTRIES)?;
        let mut names = HashSet::new();
        let mut knowledge = false;
        let mut meta_yaml = false;
        let mut meta_json = false;
        for entry in entries {
            let name = entry["name"]
                .as_str()
                .filter(|name| {
                    !name.is_empty() && !matches!(*name, "." | "..") && !name.contains(['/', '\0'])
                })
                .ok_or("MEETINGS_PROTOCOL: 目录包含无效路径")?;
            if !names.insert(name) {
                return Err("MEETINGS_PROTOCOL: 目录条目重复".into());
            }
            let is_dir = entry["is_dir"]
                .as_bool()
                .ok_or("MEETINGS_PROTOCOL: 目录条目格式无效")?;
            if is_dir {
                if !component(name) {
                    return Err("MEETINGS_PATH: 会议目录路径不受支持".into());
                }
                directories += 1;
                budget(depth < MAX_DEPTH && directories <= MAX_DIRECTORIES)?;
                let child = format!("{directory}/{name}");
                if !index::safe_path(&child) {
                    return Err("MEETINGS_PATH: 会议目录路径不受支持".into());
                }
                queue.push_back((child, depth + 1));
            } else {
                knowledge |= name == "knowledge.json";
                meta_yaml |= name == "meta.yml";
                meta_json |= name == "meta.json";
            }
        }
        if !knowledge {
            missing_knowledge += usize::from(meta_yaml || meta_json);
            continue;
        }
        budget(documents.len() < MAX_FILES)?;
        let path = format!("{directory}/knowledge.json");
        let content = read(host, &path, &mut bytes).await?;
        let mut date = None;
        if meta_yaml || meta_json {
            let meta_path = format!(
                "{directory}/{}",
                if meta_yaml { "meta.yml" } else { "meta.json" }
            );
            let meta = read(host, &meta_path, &mut bytes).await?;
            let parsed: Option<Value> = if meta_yaml {
                serde_yaml::from_str(&meta).ok()
            } else {
                serde_json::from_str(&meta).ok()
            };
            date = parsed
                .as_ref()
                .and_then(|meta| meta["created_at"].as_str())
                .and_then(parse_date);
            if date.is_none() {
                diagnostics.push(Diagnostic {
                    code: "MEETING_DATE_INVALID",
                    message: "会议 metadata 缺少有效 created_at；尝试目录日期。",
                    path: meta_path,
                });
            }
        }
        let inferred = date.is_none();
        if inferred {
            date = directory_date(&directory);
        }
        if date.is_none() {
            diagnostics.push(Diagnostic {
                code: "MEETING_DATE_UNKNOWN",
                message: "会议日期未知，未使用知识生成时间代替。",
                path: path.clone(),
            });
        }
        documents.push(Document {
            content_hash: task::hash(content.as_bytes()),
            content,
            path,
            date_inferred: inferred && date.is_some(),
            date,
        });
    }
    documents.sort_by(|a, b| a.path.cmp(&b.path));
    let manifest: Vec<_> = documents
        .iter()
        .map(|doc| (&doc.path, &doc.content_hash, &doc.date, doc.date_inferred))
        .collect();
    let snapshot_id =
        task::hash(serde_json::to_vec(&manifest).map_err(|_| "无法编码会议来源清单")?);
    Ok(Snapshot {
        schema: "notemd.strata/meetings/v1",
        vault_key: vault_key.into(),
        dataset_key: task::hash(format!("{root}\0meetings")),
        snapshot_id,
        documents,
        diagnostics,
        missing_knowledge,
    })
}

fn local_id(id: &str, prefix: u8) -> bool {
    let bytes = id.as_bytes();
    bytes.len() >= 2
        && bytes.len() <= 128
        && bytes[0] == prefix
        && matches!(bytes[1], b'1'..=b'9')
        && bytes[2..].iter().all(u8::is_ascii_digit)
}

pub fn allowed_ids(snapshot: &Snapshot) -> HashSet<String> {
    let mut allowed = HashSet::new();
    for document in &snapshot.documents {
        let Ok(dataset) = serde_json::from_str::<Value>(&document.content) else {
            continue;
        };
        if !matches!(
            dataset["schema"].as_str(),
            Some(
                "knowledge-representation-dataset/3.0.0" | "knowledge-representation-dataset/3.1.0"
            )
        ) {
            continue;
        }
        let mut counts = HashMap::new();
        let mut valid = HashSet::new();
        for (collection, prefix) in COLLECTIONS {
            for record in dataset[collection].as_array().into_iter().flatten() {
                if let Some(id) = record["id"].as_str() {
                    *counts.entry(id).or_insert(0usize) += 1;
                    if local_id(id, prefix) {
                        valid.insert(id);
                    }
                }
            }
        }
        let path_hash = task::hash(&document.path);
        allowed.extend(
            valid
                .into_iter()
                .filter(|id| counts[id] == 1)
                .map(|id| format!("meeting:{path_hash}:{id}")),
        );
    }
    allowed
}

fn resolve_source(root: &str, knowledge: &str, uri: &str) -> Result<String, String> {
    let uri = uri.trim();
    if uri.is_empty() || uri.contains(['\0', '\\', ':']) {
        return Err("MEETINGS_SOURCE: 来源不是受支持的 Vault 文件路径".into());
    }
    let base;
    let raw = if let Some(relative) = uri.strip_prefix(&format!("{}/", root.trim_end_matches('/')))
    {
        relative
    } else if uri.starts_with("/ssot/") {
        // Knowledge source URIs commonly use /ssot/... as a Vault-root path.
        &uri[1..]
    } else if uri.starts_with('/') {
        return Err("MEETINGS_SOURCE: 外部绝对路径不可打开".into());
    } else {
        base = format!(
            "{}/{}",
            knowledge.rsplit_once('/').ok_or("会议文件路径无效")?.0,
            uri
        );
        &base
    };
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("MEETINGS_SOURCE: 来源路径越出 Vault".into());
                }
            }
            part => parts.push(part),
        }
    }
    let path = parts.join("/");
    if !index::safe_path(&path) {
        return Err("MEETINGS_SOURCE: 来源路径不受支持".into());
    }
    Ok(path)
}

pub async fn open_source(host: &dyn Host, root: &str, params: &Value) -> Result<String, String> {
    let path = params["path"]
        .as_str()
        .filter(|path| knowledge_path(path))
        .ok_or("MEETINGS_PATH: 只接受会议目录内标准 knowledge.json")?;
    let expected = params["contentHash"]
        .as_str()
        .filter(|hash| index::valid_hash(hash))
        .ok_or("会议来源摘要无效")?;
    let content = read(host, path, &mut 0).await?;
    if task::hash(content.as_bytes()) != expected {
        return Err("MEETINGS_STALE: 会议知识已变化，请刷新后重试".into());
    }
    let Some(source_id) = params.get("sourceId").filter(|value| !value.is_null()) else {
        return Ok(path.into());
    };
    let source_id = source_id
        .as_str()
        .filter(|id| local_id(id, b's'))
        .ok_or("会议来源标识无效")?;
    let dataset: Value = serde_json::from_str(&content).map_err(|_| "会议知识 JSON 无效")?;
    let sources = dataset["sources"].as_array().ok_or("会议知识缺少来源")?;
    let matches: Vec<_> = sources
        .iter()
        .filter(|source| source["id"].as_str() == Some(source_id))
        .collect();
    if matches.len() != 1 {
        return Err("会议来源不存在或标识重复".into());
    }
    let uri = matches[0]["uri"].as_str().ok_or("会议来源路径无效")?;
    let target = resolve_source(root, path, uri)?;
    let exists = host
        .request("host.vault.exists", json!({"path":target}))
        .await?;
    if exists["exists"].as_bool() != Some(true) {
        return Err("MEETINGS_SOURCE: 来源文件不存在或不可访问".into());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{engine::Engine, rpc::RequestFuture};
    use std::{
        collections::BTreeMap,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    const VAULT: &str = "/synthetic-vault";
    const KNOWLEDGE: &str = "ssot/meetings/20260915_120000/knowledge.json";

    #[derive(Default)]
    struct FakeHost {
        files: Mutex<BTreeMap<String, String>>,
        reads: Mutex<Vec<String>>,
        blocked: Mutex<HashSet<String>>,
        switch_vault: AtomicBool,
        info_calls: AtomicUsize,
    }

    impl FakeHost {
        fn file(&self, path: &str, content: impl Into<String>) {
            self.files
                .lock()
                .unwrap()
                .insert(path.into(), content.into());
        }
    }

    impl Host for FakeHost {
        fn request<'a>(&'a self, method: &'a str, params: Value) -> RequestFuture<'a> {
            Box::pin(async move {
                if method == "host.vault.info" {
                    let call = self.info_calls.fetch_add(1, Ordering::SeqCst);
                    return Ok(
                        json!({"root":if self.switch_vault.load(Ordering::SeqCst) && call > 0 { "/other-vault" } else { VAULT }}),
                    );
                }
                let path = params["path"].as_str().unwrap();
                assert!(!path.starts_with('/') && !path.split('/').any(|part| part == ".."));
                if self.blocked.lock().unwrap().contains(path) {
                    return Err("io: path escapes the vault".into());
                }
                let files = self.files.lock().unwrap();
                match method {
                    "host.vault.exists" => Ok(
                        json!({"exists":files.contains_key(path) || files.keys().any(|key| key.starts_with(&format!("{path}/")))}),
                    ),
                    "host.vault.read" => {
                        self.reads.lock().unwrap().push(path.into());
                        Ok(json!({"content":files.get(path).ok_or("io: not found")?}))
                    }
                    "host.vault.list" => {
                        let prefix = format!("{path}/");
                        let mut entries = BTreeMap::new();
                        for key in files.keys().filter_map(|key| key.strip_prefix(&prefix)) {
                            let (name, is_dir) = key
                                .split_once('/')
                                .map_or((key, false), |(name, _)| (name, true));
                            entries.insert(name, is_dir);
                        }
                        Ok(
                            json!({"entries":entries.into_iter().map(|(name,is_dir)| json!({"name":name,"is_dir":is_dir})).collect::<Vec<_>>()}),
                        )
                    }
                    _ => panic!("unexpected RPC: {method}"),
                }
            })
        }
        fn post(&self, _: Value) {
            panic!("read-only meetings must not post events");
        }
    }

    fn dataset() -> String {
        json!({"schema":"knowledge-representation-dataset/3.1.0","generated":{"at":"2099-01-01"},"entities":[{"id":"e1"}],"concepts":[{"id":"c1"}],"claims":[{"id":"q1"}],"events":[{"id":"v1"}],"narratives":[{"id":"n1"}],"relations":[{"id":"r1"}],"sources":[{"id":"s1","uri":"/ssot/meetings/20260915_120000/transcript.md","v":"sha256:unused"}]}).to_string()
    }

    #[tokio::test]
    async fn snapshot_reads_only_standard_knowledge_and_metadata_and_counts_missing() {
        let host = FakeHost::default();
        host.file(KNOWLEDGE, dataset());
        host.file(
            "ssot/meetings/20260915_120000/meta.yml",
            "created_at: '2025-07-22T23:30:00-05:00'\n",
        );
        host.file(
            "ssot/meetings/20260915_120000/transcript.md",
            "must never be read",
        );
        host.file(
            "ssot/meetings/20260915_120000/knowledge_experiment.json",
            "must never be read",
        );
        host.file("ssot/meetings/missing/meta.json", "{}");
        host.file("outside/knowledge.json", "must never be read");
        let result = snapshot(&host, VAULT, &task::hash(VAULT)).await.unwrap();
        assert_eq!(result.documents.len(), 1);
        assert_eq!(result.documents[0].content_hash, task::hash(dataset()));
        assert_eq!(result.documents[0].date.as_deref(), Some("2025-07-22"));
        assert!(!result.documents[0].date_inferred);
        assert_eq!(result.missing_knowledge, 1);
        assert_eq!(result.dataset_key, task::hash(format!("{VAULT}\0meetings")));
        assert_eq!(
            *host.reads.lock().unwrap(),
            vec![KNOWLEDGE, "ssot/meetings/20260915_120000/meta.yml"]
        );
        assert_eq!(allowed_ids(&result).len(), 6);
        assert!(allowed_ids(&result).contains(&format!("meeting:{}:q1", task::hash(KNOWLEDGE))));
        let first_id = result.snapshot_id;
        host.file(
            "ssot/meetings/20260915_120000/meta.yml",
            "created_at: '2025-07-23T00:00:00Z'\n",
        );
        assert_ne!(
            snapshot(&host, VAULT, &task::hash(VAULT))
                .await
                .unwrap()
                .snapshot_id,
            first_id
        );
    }

    #[tokio::test]
    async fn invalid_or_missing_metadata_uses_only_valid_directory_dates() {
        let host = FakeHost::default();
        host.file(KNOWLEDGE, dataset());
        host.file(
            "ssot/meetings/20260915_120000/meta.yml",
            "created_at: [invalid]\n",
        );
        host.file("ssot/meetings/undated/knowledge.json", dataset());
        let result = snapshot(&host, VAULT, &task::hash(VAULT)).await.unwrap();
        assert_eq!(result.documents[0].date.as_deref(), Some("2026-09-15"));
        assert!(result.documents[0].date_inferred);
        assert_eq!(result.documents[1].date, None);
        assert!(!result.documents[1].date_inferred);
        assert_eq!(result.diagnostics.len(), 2);
        assert_eq!(directory_date("ssot/meetings/20260230_100000"), None);
        assert_eq!(directory_date("ssot/meetings/202609151234"), None);
    }

    #[tokio::test]
    async fn unrelated_legal_posix_filenames_do_not_block_standard_knowledge() {
        let host = FakeHost::default();
        host.file(KNOWLEDGE, dataset());
        host.file(
            "ssot/meetings/20260915_120000/unrelated:note.md",
            "must not read",
        );
        host.file(
            "ssot/meetings/20260915_120000/unrelated\\note.md",
            "must not read",
        );
        let result = snapshot(&host, VAULT, &task::hash(VAULT)).await.unwrap();
        assert_eq!(result.documents.len(), 1);
        assert_eq!(*host.reads.lock().unwrap(), vec![KNOWLEDGE]);
    }

    #[tokio::test]
    async fn missing_meetings_root_returns_an_empty_dataset() {
        let result = snapshot(&FakeHost::default(), VAULT, &task::hash(VAULT))
            .await
            .unwrap();
        assert!(result.documents.is_empty());
        assert_eq!(result.missing_knowledge, 0);
    }

    #[tokio::test]
    async fn duplicate_and_wrong_collection_ids_are_not_authorized() {
        let host = FakeHost::default();
        let mut content: Value = serde_json::from_str(&dataset()).unwrap();
        content["claims"] =
            json!([{"id":"q1"},{"id":"q1"},{"id":"e1"},{"id":"q0"},{"id":"q02"},{"id":"q2"}]);
        host.file(KNOWLEDGE, content.to_string());
        let result = snapshot(&host, VAULT, &task::hash(VAULT)).await.unwrap();
        let allowed = allowed_ids(&result);
        let node = |id| format!("meeting:{}:{id}", task::hash(KNOWLEDGE));
        assert!(allowed.contains(&node("q2")));
        for id in ["q1", "e1", "q0", "q02"] {
            assert!(!allowed.contains(&node(id)));
        }
    }

    #[tokio::test]
    async fn traversal_and_input_budgets_fail_instead_of_returning_partial_documents() {
        let host = FakeHost::default();
        host.file(
            &format!(
                "{ROOT}/{}/knowledge.json",
                vec!["nested"; MAX_DEPTH + 1].join("/")
            ),
            "{}",
        );
        assert!(snapshot(&host, VAULT, &task::hash(VAULT))
            .await
            .unwrap_err()
            .starts_with("MEETINGS_LIMIT:"));
        let host = FakeHost::default();
        host.file(KNOWLEDGE, "x".repeat(MAX_BYTES));
        host.file("ssot/meetings/20260915_120000/meta.yml", "x");
        assert!(snapshot(&host, VAULT, &task::hash(VAULT))
            .await
            .unwrap_err()
            .starts_with("MEETINGS_LIMIT:"));
        assert_eq!(
            host.reads.lock().unwrap().len(),
            2,
            "metadata bytes share the total input budget"
        );
    }

    #[tokio::test]
    async fn open_rechecks_knowledge_hash_and_only_tests_source_existence() {
        let host = FakeHost::default();
        host.file(KNOWLEDGE, dataset());
        let transcript = "ssot/meetings/20260915_120000/transcript.md";
        host.file(transcript, "must never be read by this adapter");
        let mut params = json!({"path":KNOWLEDGE,"contentHash":task::hash(dataset())});
        assert_eq!(open_source(&host, VAULT, &params).await.unwrap(), KNOWLEDGE);
        params["sourceId"] = json!("s1");
        assert_eq!(
            open_source(&host, VAULT, &params).await.unwrap(),
            transcript
        );
        assert!(host
            .reads
            .lock()
            .unwrap()
            .iter()
            .all(|path| path == KNOWLEDGE));
        host.blocked.lock().unwrap().insert(transcript.into());
        assert!(open_source(&host, VAULT, &params)
            .await
            .unwrap_err()
            .contains("escapes"));
        host.file(KNOWLEDGE, "{}");
        assert!(open_source(&host, VAULT, &params)
            .await
            .unwrap_err()
            .starts_with("MEETINGS_STALE:"));
        params["path"] = json!("ssot/meetings/20260915_120000/knowledge_other.json");
        assert!(open_source(&host, VAULT, &params)
            .await
            .unwrap_err()
            .starts_with("MEETINGS_PATH:"));
    }

    #[test]
    fn source_paths_stay_inside_the_vault_and_never_become_web_urls() {
        let prefix = "ssot/meetings/20260915_120000";
        for uri in [
            "transcript.md",
            "/ssot/meetings/20260915_120000/transcript.md",
            "/synthetic-vault/ssot/meetings/20260915_120000/transcript.md",
        ] {
            assert_eq!(
                resolve_source(VAULT, KNOWLEDGE, uri).unwrap(),
                format!("{prefix}/transcript.md")
            );
        }
        assert_eq!(
            resolve_source(VAULT, KNOWLEDGE, "../other/source.md").unwrap(),
            "ssot/meetings/other/source.md"
        );
        for uri in [
            "../../../../outside.md",
            "/Users/other/private.md",
            "/synthetic-vault-other/../private/outside.md",
            "https://example.com",
            "file:///tmp/source.md",
            "hemory-staging:item",
            "../../../.ssh/id",
            "bad\0.md",
            "a\\b.md",
        ] {
            assert!(resolve_source(VAULT, KNOWLEDGE, uri).is_err(), "{uri:?}");
        }
    }

    fn atlas(id: &str) -> Value {
        json!({"version":"strata-atlas/2","epoch":"meetings:1","worldSize":4096,
            "nodes":[{"id":id,"x":0.5,"y":0.5,"radius":0.01,"parentDomain":"d","parentTopic":"t","crowded":false}],
            "domains":[{"id":"d","name":"Meeting","x":0.5,"y":0.5,"radius":0.4,"memberIds":[id]}],
            "topics":[{"id":"t","name":"Topic","parentId":"d","x":0.5,"y":0.5,"radius":0.2,"memberIds":[id]}],"idf":{},"diagnostics":{}})
    }

    #[tokio::test]
    async fn engine_keeps_meeting_cache_separate_and_rechecks_vault_identity() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::new());
        engine
            .initialize(&json!({"data_dir":directory.path()}))
            .unwrap();
        let host = Arc::new(FakeHost::default());
        host.file(KNOWLEDGE, dataset());
        let key = task::hash(VAULT);
        let node = format!("meeting:{}:q1", task::hash(KNOWLEDGE));
        let value = atlas(&node);
        engine
            .handle(
                host.clone(),
                "plugin.meetings.atlas.save",
                json!({"vaultKey":key,"atlas":value}),
            )
            .await
            .unwrap();
        assert!(directory
            .path()
            .join("meetings")
            .join(&key)
            .join("atlas.json")
            .is_file());
        assert!(!directory.path().join(&key).join("atlas.json").exists());
        let reopened = Arc::new(Engine::new());
        reopened
            .initialize(&json!({"data_dir":directory.path()}))
            .unwrap();
        let loaded = reopened
            .handle(
                host.clone(),
                "plugin.meetings.atlas.load",
                json!({"vaultKey":key}),
            )
            .await
            .unwrap();
        assert_eq!(loaded["atlas"]["nodes"], value["nodes"]);
        assert!(reopened
            .handle(
                host.clone(),
                "plugin.meetings.open_source",
                json!({"vaultKey":"wrong","path":KNOWLEDGE,"contentHash":task::hash(dataset())})
            )
            .await
            .is_err());
        host.info_calls.store(0, Ordering::SeqCst);
        host.switch_vault.store(true, Ordering::SeqCst);
        assert!(reopened
            .handle(host.clone(), "plugin.meetings.snapshot", json!({}))
            .await
            .unwrap_err()
            .contains("Vault 已切换"));
    }
}
