use crate::rpc::Host;
use habitat_core::{hash, SourceInput};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone)]
pub struct Capture {
    pub index_id: String,
    pub scope_hash: String,
    pub inputs: Vec<SourceInput>,
    pub prefetched: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    snapshot_id: String,
    config_hash: String,
    as_of: String,
    index_generation: String,
    mode: String,
    files: Vec<File>,
    next_cursor: Option<String>,
    coverage: Coverage,
    freshness: String,
}
#[derive(Deserialize)]
struct Coverage {
    stale: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    path: String,
    content_hash: String,
    #[serde(default)]
    index_origin: String,
}

pub async fn read(host: &dyn Host, path: &str) -> Result<String, String> {
    let response = host
        .request("host.vault.read", json!({"path":path}))
        .await?;
    response["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "来源读取格式无效".into())
}
fn eligible(path: &str) -> bool {
    habitat_core::codec::safe_source_path(path)
        && !path.starts_with(".notemd/")
        && !path.starts_with(".local/")
        && !matches!(path, "USER.md" | "MEMORY.md" | "AGENTS.md" | "CLAUDE.md")
        && !path.split('/').any(|p| {
            matches!(
                p,
                ".local" | "node_modules" | ".ssh" | ".aws" | ".credentials"
            )
        })
}

pub async fn capture(host: &dyn Host, stop: &AtomicBool) -> Result<Capture, String> {
    let mut inputs = BTreeMap::new();
    let mut cursor = None;
    let mut cursors = HashSet::new();
    let mut binding = None;
    loop {
        if stop.load(Ordering::Acquire) {
            return Err("已取消".into());
        }
        let params = match &cursor {
            None => json!({"version":1,"pageSize":1000}),
            Some(c) => json!({"version":1,"pageSize":1000,"cursor":c}),
        };
        let page: Page = serde_json::from_value(host.request("host.index.snapshot", params).await?)
            .map_err(|e| format!("索引快照格式错误: {e}"))?;
        if page.mode != "atlas_metadata" {
            return Err("需要全索引 metadata 模式".into());
        }
        // The index omits rows whose source stamp has changed. Accepting that
        // reduced list would silently turn index lag into disappearing knowledge.
        if page.coverage.stale != 0 || page.freshness != "current" {
            return Err("索引尚未完成更新，请等待索引完成后重试；未生成缺少来源的版本".into());
        }
        let stamp = (
            page.snapshot_id.clone(),
            page.config_hash.clone(),
            page.as_of,
            page.index_generation,
        );
        if binding.as_ref().is_some_and(|b| b != &stamp) {
            return Err("索引分页不是同一次捕获".into());
        }
        binding = Some(stamp);
        for f in page.files {
            if eligible(&f.path) {
                if !habitat_core::codec::valid_hash(&f.content_hash) {
                    return Err("索引包含无效内容摘要".into());
                }
                if inputs
                    .insert(
                        f.path.clone(),
                        SourceInput {
                            path: f.path,
                            hash: f.content_hash,
                            origin: f.index_origin,
                        },
                    )
                    .is_some()
                {
                    return Err("索引分页包含重复来源".into());
                }
            }
        }
        if inputs.len() > 100_000 {
            return Err("来源数量超过本地分析预算".into());
        }
        match page.next_cursor {
            Some(c) if cursors.insert(c.clone()) => cursor = Some(c),
            Some(_) => return Err("索引分页游标重复".into()),
            None => break,
        }
    }
    let (index_id, config_hash, _, _) = binding.ok_or("没有取得索引")?;
    let mut prefetched = BTreeMap::new();
    let mut meetings_root = "ssot/meetings".to_string();
    let mut exclude_dirs: Vec<String> = Vec::new();
    for path in [".notemd/settings.json", ".notemd/meetings.json"] {
        let exists = host
            .request("host.vault.exists", json!({"path":path}))
            .await?;
        if exists["exists"].as_bool() == Some(true) {
            let content = read(host, path).await?;
            let v: Value =
                serde_json::from_str(&content).map_err(|_| format!("配置损坏: {path}"))?;
            if path.ends_with("meetings.json") {
                if let Some(value) = v["meetings_root"].as_str() {
                    meetings_root = value.trim_matches('/').to_string();
                }
            }
            if path.ends_with("settings.json") {
                exclude_dirs = v["searchExcludeDirs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|s| s.trim_matches('/').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
            inputs.insert(
                path.into(),
                SourceInput {
                    path: path.into(),
                    hash: hash(&content),
                    origin: "config".into(),
                },
            );
            prefetched.insert(path.into(), content);
        }
    }
    if !eligible(&meetings_root) || meetings_root == "." {
        return Err("会议目录配置超出允许范围".into());
    }
    let exists = host
        .request("host.vault.exists", json!({"path":meetings_root}))
        .await?;
    let excluded = |path: &str| {
        exclude_dirs
            .iter()
            .any(|dir| path == dir || path.starts_with(&format!("{dir}/")))
    };
    let mut queue = VecDeque::new();
    if exists["exists"].as_bool() == Some(true) && !excluded(&meetings_root) {
        queue.push_back((meetings_root.clone(), 0usize));
    }
    let mut visited = 0;
    let mut json_bytes = 0;
    while let Some((path, depth)) = queue.pop_front() {
        if stop.load(Ordering::Acquire) {
            return Err("已取消".into());
        }
        visited += 1;
        if visited > 10_000 || depth > 12 {
            return Err("会议目录超过读取预算".into());
        }
        let result = host
            .request("host.vault.list", json!({"path":path}))
            .await?;
        for entry in result["entries"].as_array().ok_or("会议目录返回格式无效")? {
            let name = entry["name"].as_str().ok_or("目录条目缺少名称")?;
            let is_dir = entry["is_dir"].as_bool().ok_or("目录条目缺少类型")?;
            if !is_dir && name != "knowledge.json" {
                continue;
            }
            if name.is_empty() || name.contains(['/', '\\', '\0']) || matches!(name, "." | "..") {
                return Err("会议目录含无效路径".into());
            }
            let child = format!("{path}/{name}");
            if !eligible(&child) || excluded(&child) {
                continue;
            }
            if is_dir {
                queue.push_back((child, depth + 1));
            } else if name == "knowledge.json" {
                let content = read(host, &child).await?;
                json_bytes += content.len();
                if json_bytes > 96 * 1024 * 1024 {
                    return Err("会议知识超过捕获预算".into());
                }
                inputs.insert(
                    child.clone(),
                    SourceInput {
                        path: child.clone(),
                        hash: hash(&content),
                        origin: "derived".into(),
                    },
                );
                prefetched.insert(child, content);
            }
        }
    }
    let scope_hash=hash(serde_json::to_vec(&json!({"policy":"habitat-capture/1","indexConfig":config_hash,"meetingsRoot":meetings_root,"excluded":[".notemd/* except settings/meetings","USER.md","MEMORY.md","AGENTS.md","CLAUDE.md","private runtime"]})).map_err(|e|e.to_string())?);
    Ok(Capture {
        index_id,
        scope_hash,
        inputs: inputs.into_values().collect(),
        prefetched,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::RequestFuture;
    struct CaptureHost {
        stale: u64,
        entries: Vec<Value>,
    }
    impl Host for CaptureHost {
        fn request<'a>(&'a self, method: &'a str, params: Value) -> RequestFuture<'a> {
            Box::pin(async move {
                match method {
                    "host.index.snapshot" => Ok(
                        json!({"snapshotId":"capture","configHash":"config","asOf":"2026-09-30","indexGeneration":"1","mode":"atlas_metadata","files":[],"nextCursor":null,"coverage":{"stale":self.stale},"freshness":if self.stale==0{"current"}else{"stale"}}),
                    ),
                    "host.vault.exists" => Ok(json!({"exists":params["path"]=="ssot/meetings"})),
                    "host.vault.list" => Ok(json!({"entries":self.entries})),
                    "host.vault.read" if params["path"] == "ssot/meetings/knowledge.json" => {
                        Ok(json!({"content":"{}"}))
                    }
                    _ => Err(format!("unexpected {method}")),
                }
            })
        }
        fn post(&self, _: Value) {}
    }
    #[tokio::test]
    async fn stale_filtered_index_is_rejected_before_extracting() {
        let host = CaptureHost {
            stale: 1,
            entries: vec![],
        };
        assert!(capture(&host, &AtomicBool::new(false))
            .await
            .unwrap_err()
            .contains("等待索引完成"));
    }
    #[tokio::test]
    async fn unrelated_special_posix_filename_does_not_block_knowledge_capture() {
        let host = CaptureHost {
            stale: 0,
            entries: vec![
                json!({"name":"unrelated\\name.bin","is_dir":false}),
                json!({"name":"knowledge.json","is_dir":false}),
            ],
        };
        let result = capture(&host, &AtomicBool::new(false)).await.unwrap();
        assert_eq!(result.inputs.len(), 1);
        assert_eq!(result.inputs[0].path, "ssot/meetings/knowledge.json");
        assert_eq!(result.inputs[0].hash, hash("{}"));
    }
    #[tokio::test]
    async fn traversed_directory_names_remain_strictly_validated() {
        let host = CaptureHost {
            stale: 0,
            entries: vec![json!({"name":"unsafe\\directory","is_dir":true})],
        };
        assert!(capture(&host, &AtomicBool::new(false))
            .await
            .unwrap_err()
            .contains("无效路径"));
    }
}
