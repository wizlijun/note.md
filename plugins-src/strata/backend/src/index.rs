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
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && !path.chars().any(char::is_control)
        && path.split('/').all(|part| {
            !part.is_empty()
                && !matches!(part, "." | ".." | ".git" | ".ssh" | ".aws")
                && !part.starts_with(".env")
        })
}
