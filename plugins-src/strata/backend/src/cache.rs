use crate::{
    task::{self, Packet},
    types::{File, Job, Node, Relation},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Cache {
    pub root: PathBuf,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub schema: String,
    pub rule: String,
    pub source: File,
    pub harness: String,
    pub model: Option<String>,
    pub nodes: Vec<Node>,
    pub relations: Vec<Relation>,
    pub processed_blocks: Vec<String>,
    pub complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub job_id: String,
    pub snapshot_id: String,
    pub config_hash: String,
    pub packet: Packet,
    pub run_id: Option<String>,
}
impl Cache {
    pub fn new(data_dir: &Path, vault_key: &str) -> Result<Self, String> {
        if !crate::index::valid_hash(vault_key) {
            return Err("Vault cache key 无效".into());
        }
        let root = data_dir.join(vault_key);
        private_dir(&root.join("sources"))?;
        Ok(Self { root })
    }
    fn source_path(&self, key: &str) -> PathBuf {
        self.root
            .join("sources")
            .join(format!("{}.json", task::hash(key)))
    }
    pub fn source(&self, file: &File) -> Result<Option<Artifact>, String> {
        let path = self.source_path(&file.file_key);
        let value: Option<Artifact> = read(&path)?;
        match value {
            Some(value)
                if value.schema == "notemd.strata/artifact/v1"
                    && value.rule == task::RULE
                    && value.source.file_key == file.file_key
                    && value.source.path == file.path
                    && value.source.content_hash == file.content_hash =>
            {
                Ok(Some(value))
            }
            Some(_) => {
                remove(&path)?;
                Ok(None)
            }
            None => Ok(None),
        }
    }
    pub fn invalidate_source(&self, file: &File) -> Result<(), String> {
        remove(&self.source_path(&file.file_key))
    }
    pub fn save_source(&self, artifact: &Artifact) -> Result<(), String> {
        atomic(&self.source_path(&artifact.source.file_key), artifact)
    }
    pub fn prune(&self, files: &[File]) -> Result<usize, String> {
        let current: HashMap<_, _> = files.iter().map(|f| (f.file_key.as_str(), f)).collect();
        let mut removed = 0;
        for entry in
            std::fs::read_dir(self.root.join("sources")).map_err(|_| "无法检查 STRATA 缓存")?
        {
            let path = entry.map_err(|_| "无法检查 STRATA 缓存")?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let artifact: Option<Artifact> = read(&path)?;
            let valid = artifact.as_ref().is_some_and(|a| {
                current.get(a.source.file_key.as_str()).is_some_and(|f| {
                    f.content_hash == a.source.content_hash && f.path == a.source.path
                })
            });
            if !valid {
                remove(&path)?;
                removed += 1;
            }
        }
        Ok(removed)
    }
    pub fn job(&self) -> Result<Option<Job>, String> {
        read(&self.root.join("job.json"))
    }
    pub fn save_job(&self, job: &Job) -> Result<(), String> {
        atomic(&self.root.join("job.json"), job)
    }
    pub fn pending(&self) -> Result<Option<Pending>, String> {
        read(&self.root.join("pending.json"))
    }
    pub fn save_pending(&self, pending: &Pending) -> Result<(), String> {
        atomic(&self.root.join("pending.json"), pending)
    }
    pub fn clear_pending(&self) -> Result<(), String> {
        remove(&self.root.join("pending.json"))
    }
    pub fn load_atlas(&self, allowed: &HashSet<String>) -> Result<Value, String> {
        let atlas: Option<Value> = read(&self.root.join("atlas.json"))?;
        atlas
            .map(|v| sanitize_atlas(v, allowed))
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
    }
    pub fn save_atlas(&self, value: Value, allowed: &HashSet<String>) -> Result<(), String> {
        atomic(
            &self.root.join("atlas.json"),
            &sanitize_atlas(value, allowed)?,
        )
    }
}
fn private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|_| "无法创建 STRATA 本地缓存")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法设置缓存权限")?;
    }
    Ok(())
}
fn remove(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法撤除失效 STRATA 缓存".into()),
    }
}
pub fn atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("缓存目录无效")?;
    private_dir(parent)?;
    let bytes = serde_json::to_vec(value).map_err(|_| "无法编码 STRATA 缓存")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法写入 STRATA 缓存")?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "无法保存 STRATA 缓存")?;
    file.persist(path).map_err(|_| "无法发布 STRATA 缓存")?;
    Ok(())
}
fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let bytes = match std::fs::read(path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 STRATA 缓存".into()),
    };
    if bytes.len() > 32 * 1024 * 1024 {
        remove(path)?;
        return Ok(None);
    }
    match serde_json::from_slice(&bytes) {
        Ok(v) => Ok(Some(v)),
        Err(_) => {
            remove(path)?;
            Ok(None)
        }
    }
}

/// Persist geometry only. Fresh snapshot nodes supply all labels/evidence again.
pub fn sanitize_atlas(mut value: Value, allowed: &HashSet<String>) -> Result<Value, String> {
    if serde_json::to_vec(&value)
        .map_err(|_| "布局格式无效")?
        .len()
        > 16 * 1024 * 1024
        || value["version"] != "strata-atlas/1"
        || value["worldSize"] != 4096
        || value["epoch"].as_str().is_none_or(|s| s.len() > 256)
    {
        return Err("布局版本或大小不受支持".into());
    }
    let nodes = value["nodes"].as_array().ok_or("布局缺少节点")?;
    if nodes.len() > 100_000 {
        return Err("布局节点超过预算".into());
    }
    let mut clean = Vec::new();
    let mut ids = HashSet::new();
    let mut pruned = false;
    for node in nodes {
        let id = node["id"].as_str().ok_or("布局节点标识无效")?;
        if !allowed.contains(id) {
            pruned = true;
            continue;
        }
        if !ids.insert(id.to_string()) {
            return Err("布局节点重复".into());
        }
        for key in ["parentTopic", "parentDomain"] {
            if node[key]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 256)
            {
                return Err("布局节点父级无效".into());
            }
        }
        if !node["crowded"].is_boolean() {
            return Err("布局拥挤标记无效".into());
        }
        for key in ["x", "y", "radius"] {
            let v = node[key].as_f64().ok_or("布局坐标无效")?;
            if !v.is_finite() || v.abs() > 16384.0 || (key == "radius" && v < 0.0) {
                return Err("布局坐标超出范围".into());
            }
        }
        clean.push(json!({"id":id,"x":node["x"],"y":node["y"],"radius":node["radius"],"parentTopic":node["parentTopic"],"parentDomain":node["parentDomain"],"crowded":node["crowded"]}));
    }
    value["nodes"] = json!(clean);
    for key in ["domains", "topics"] {
        let groups = value[key].as_array().ok_or("布局分层无效")?;
        if groups.len() > 100_000 {
            return Err("布局分层超过预算".into());
        }
        let mut clean = Vec::new();
        for group in groups {
            for key in ["id", "name"] {
                if group[key]
                    .as_str()
                    .is_none_or(|s| s.is_empty() || s.len() > 512)
                {
                    return Err("布局分层标识无效".into());
                }
            }
            for key in ["x", "y", "radius"] {
                let v = group[key].as_f64().ok_or("布局分层坐标无效")?;
                if !v.is_finite() || v.abs() > 16384.0 || (key == "radius" && v < 0.0) {
                    return Err("布局分层坐标无效".into());
                }
            }
            let members: Vec<_> = group["memberIds"]
                .as_array()
                .ok_or("布局成员无效")?
                .iter()
                .filter(|id| id.as_str().is_some_and(|s| ids.contains(s)))
                .cloned()
                .collect();
            if members.is_empty() {
                continue;
            }
            clean.push(json!({"id":group["id"],"name":if pruned {Value::String("主题".into())} else {group["name"].clone()},"x":group["x"],"y":group["y"],"radius":group["radius"],"parentId":group["parentId"],"memberIds":members}));
        }
        value[key] = json!(clean);
    }
    if pruned {
        value["idf"] = json!({});
    }
    let idf = value["idf"].as_object().ok_or("布局词频格式无效")?;
    if idf.len() > 100_000
        || idf.iter().any(|(k, v)| {
            k.len() > 512
                || v.as_f64()
                    .is_none_or(|n| !n.is_finite() || !(0.0..=1_000_000.0).contains(&n))
        })
    {
        return Err("布局词频超过范围".into());
    }
    let diagnostics = &value["diagnostics"];
    value["diagnostics"] = json!({
        "graphEdges":diagnostics["graphEdges"].as_u64().unwrap_or(0),
        "crowdedNodes":diagnostics["crowdedNodes"].as_u64().unwrap_or(0),
        "rebuildSuggested":diagnostics["rebuildSuggested"].as_bool().unwrap_or(false),
        "elapsedMs":diagnostics["elapsedMs"].as_f64().filter(|v|v.is_finite()&&*v>=0.0).unwrap_or(0.0)
    });
    Ok(
        json!({"version":value["version"],"epoch":value["epoch"],"worldSize":4096,"nodes":value["nodes"],"domains":value["domains"],"topics":value["topics"],"idf":value["idf"],"diagnostics":value["diagnostics"]}),
    )
}
