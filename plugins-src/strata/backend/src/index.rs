use crate::{
    rpc::Host,
    types::{DateRange, File, Unit},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSnapshot {
    pub snapshot_id: String,
    pub config_hash: String,
    pub as_of: String,
    pub files: Vec<File>,
    #[serde(default)]
    pub coverage: Value,
    pub mode: String,
    #[serde(default)]
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocks {
    pub snapshot_id: String,
    pub units: Vec<Unit>,
    #[serde(default)]
    pub conflicts: Vec<Value>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

pub async fn snapshot(host: &dyn Host, range: Option<&DateRange>) -> Result<IndexSnapshot, String> {
    if let Some(range) = range {
        range.validate()?;
    }
    match snapshot_once(host, range).await {
        // A source can change while reading pages in an active Vault. Retry
        // once with a new snapshot; the failed round's files and cursors are
        // dropped together. Authorization, limits and other errors stay final.
        Err(error) if error.starts_with("SNAPSHOT_STALE:") => snapshot_once(host, range).await,
        result => result,
    }
}

async fn snapshot_once(
    host: &dyn Host,
    range: Option<&DateRange>,
) -> Result<IndexSnapshot, String> {
    let mut params = json!({"version":1,"pageSize":1000});
    if let Some(range) = range {
        params["range"] = json!({"from":range.from,"to":range.to,"dateKind":"doc_date"});
    }
    let mut first: Option<IndexSnapshot> = None;
    let mut cursors = HashSet::new();
    loop {
        let page: IndexSnapshot =
            serde_json::from_value(host.request("host.index.snapshot", params.clone()).await?)
                .map_err(|_| "索引快照格式不受支持，请更新 note.md")?;
        let next = page.next_cursor.clone();
        if let Some(all) = first.as_mut() {
            if page.snapshot_id != all.snapshot_id
                || page.config_hash != all.config_hash
                || page.as_of != all.as_of
            {
                return Err("索引分页快照发生变化，请刷新".into());
            }
            all.files.extend(page.files);
        } else {
            first = Some(page);
        }
        if first.as_ref().unwrap().files.len() > 100_000 {
            return Err("索引超过本次浏览预算，请缩小 Vault 范围".into());
        }
        match next {
            Some(cursor) if cursors.insert(cursor.clone()) => params["cursor"] = json!(cursor),
            Some(_) => return Err("索引分页游标重复".into()),
            None => break,
        }
    }
    let mut result = first.unwrap();
    result.next_cursor = None;
    let expected = if range.is_some() {
        "range"
    } else {
        "atlas_metadata"
    };
    if result.mode != expected {
        return Err("索引范围模式不匹配".into());
    }
    for file in &result.files {
        if !safe_path(&file.path)
            || !valid_hash(&file.content_hash)
            || !file.file_priority.is_finite()
            || file.file_priority < 0.0
        {
            return Err("索引包含无效来源，未显示缓存".into());
        }
    }
    Ok(result)
}
pub async fn blocks(
    host: &dyn Host,
    snapshot_id: &str,
    file_keys: &[String],
    cursor: Option<&str>,
    max_bytes: usize,
) -> Result<Blocks, String> {
    let mut params =
        json!({"version":1,"snapshotId":snapshot_id,"fileKeys":file_keys,"maxBytes":max_bytes});
    if let Some(cursor) = cursor {
        params["cursor"] = json!(cursor);
    }
    let result: Blocks = serde_json::from_value(host.request("host.index.blocks", params).await?)
        .map_err(|_| "索引正文格式不受支持")?;
    if result.snapshot_id != snapshot_id {
        return Err("索引正文不属于本次快照".into());
    }
    for unit in &result.units {
        if !file_keys.contains(&unit.file_key)
            || !valid_hash(&unit.content_hash)
            || unit.line_start == 0
            || unit.line_end < unit.line_start
        {
            return Err("索引正文来源不匹配".into());
        }
    }
    Ok(result)
}
pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit())
}
pub fn safe_path(path: &str) -> bool {
    // POSIX permits non-NUL control characters in filenames. JSON RPC escapes
    // them; rejecting them here would hide the entire valid index.
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && !path.contains('\0')
        && path.split('/').all(|part| {
            !part.is_empty()
                && !matches!(part, "." | ".." | ".git" | ".ssh" | ".aws")
                && !part.starts_with(".env")
        })
}

#[cfg(test)]
mod tests {
    use super::{safe_path, snapshot};
    use crate::{
        rpc::{Host, Reply, RequestFuture},
        types::DateRange,
    };
    use serde_json::{json, Value};
    use std::{collections::VecDeque, sync::Mutex};

    struct FakeHost {
        replies: Mutex<VecDeque<Reply>>,
        calls: Mutex<Vec<Value>>,
    }

    impl FakeHost {
        fn new(replies: Vec<Reply>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl Host for FakeHost {
        fn request<'a>(&'a self, method: &'a str, params: Value) -> RequestFuture<'a> {
            Box::pin(async move {
                assert_eq!(method, "host.index.snapshot");
                self.calls.lock().unwrap().push(params);
                self.replies
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected extra RPC")
            })
        }

        fn post(&self, _: Value) {
            panic!("metadata reads must not post events");
        }
    }

    fn page(snapshot_id: &str, file_key: &str, cursor: Option<&str>, range: bool) -> Value {
        json!({
            "snapshotId": snapshot_id,
            "configHash": format!("{snapshot_id}-config"),
            "asOf": "2026-09-30",
            "mode": if range { "range" } else { "atlas_metadata" },
            "files": [{
                "fileKey": file_key,
                "path": format!("{file_key}.md"),
                "contentHash": "a".repeat(64),
                "indexOrigin": "human"
            }],
            "nextCursor": cursor
        })
    }

    #[tokio::test]
    async fn stale_page_restarts_the_whole_snapshot_without_mixing_files_or_cursors() {
        for range in [
            None,
            Some(DateRange {
                from: "2026-09-01".into(),
                to: "2026-09-30".into(),
            }),
        ] {
            let host = FakeHost::new(vec![
                Ok(page("old", "discarded", Some("cursor"), range.is_some())),
                Err("SNAPSHOT_STALE: source changed; refresh metadata".into()),
                Ok(page("new", "kept-a", Some("cursor"), range.is_some())),
                Ok(page("new", "kept-b", None, range.is_some())),
            ]);
            let result = snapshot(&host, range.as_ref()).await.unwrap();
            assert_eq!(result.snapshot_id, "new");
            assert_eq!(result.config_hash, "new-config");
            assert_eq!(
                result
                    .files
                    .iter()
                    .map(|file| file.file_key.as_str())
                    .collect::<Vec<_>>(),
                vec!["kept-a", "kept-b"]
            );
            assert!(result.next_cursor.is_none());
            let calls = host.calls.lock().unwrap();
            assert_eq!(calls.len(), 4);
            assert!(calls[0].get("cursor").is_none());
            assert_eq!(
                calls[0], calls[2],
                "retry must start over with the same date range"
            );
            assert_eq!(calls[1]["cursor"], "cursor");
            assert_eq!(
                calls[3]["cursor"], "cursor",
                "old cursor history must also be discarded"
            );
        }
    }

    #[tokio::test]
    async fn repeated_stale_snapshot_stops_after_two_complete_attempts() {
        let error = "SNAPSHOT_STALE: source changed; refresh metadata";
        let host = FakeHost::new(vec![Err(error.into()), Err(error.into())]);
        assert_eq!(snapshot(&host, None).await.unwrap_err(), error);
        let calls = host.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().all(|params| params.get("cursor").is_none()));
    }

    #[tokio::test]
    async fn only_the_exact_stale_error_prefix_is_retried() {
        for error in [
            "CAPABILITY_DENIED: index.read revoked",
            "SNAPSHOT_EXPIRED",
            "SNAPSHOT_INVALIDATED",
            "SNAPSHOT_LIMIT: metadata exceeds budget",
            "host.index.snapshot 超时",
            "SNAPSHOT_STALE",
            "prefix SNAPSHOT_STALE: source changed",
            "SNAPSHOT_STALE_OTHER: source changed",
        ] {
            let host = FakeHost::new(vec![Err(error.into())]);
            assert_eq!(snapshot(&host, None).await.unwrap_err(), error);
            assert_eq!(
                host.calls.lock().unwrap().len(),
                1,
                "must not retry {error}"
            );
        }
    }

    #[test]
    fn accepts_non_nul_control_characters_in_relative_filenames() {
        // POSIX filenames can contain these characters; JSON RPC preserves them.
        for path in [
            "notes/知识\u{1d}记录.md",
            "notes/tab\tname.md",
            "line\nbreak.md",
            "c1\u{85}.md",
        ] {
            assert!(safe_path(path), "{path:?}");
        }
    }

    #[test]
    fn rejects_nul_and_existing_unsafe_path_forms() {
        for path in [
            "",
            "bad\0.md",
            "/absolute.md",
            "../outside.md",
            "a/../b.md",
            "./note.md",
            "a//b.md",
            "a/",
            "C:/note.md",
            "file:///note.md",
            "a\\b.md",
            ".git/config",
            "a/.ssh/key",
            ".aws/key",
            ".env",
            "a/.env.local",
        ] {
            assert!(!safe_path(path), "{path:?}");
        }
    }
}
