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

const ATLAS_INPUT_BYTES: usize = 64 * 1024 * 1024;
const ATLAS_CACHE_BYTES: usize = 16 * 1024 * 1024;
const ATLAS_LABEL_BYTES: usize = 512;

fn atlas_label(name: &str) -> String {
    if name.len() <= ATLAS_LABEL_BYTES {
        return name.into();
    }
    let mut end = ATLAS_LABEL_BYTES - '…'.len_utf8();
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &name[..end])
}

// Count encoded bytes without allocating another copy of the complete atlas.
fn json_within_budget(value: &Value, budget: usize) -> bool {
    struct LimitedWriter(usize);
    impl Write for LimitedWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.0 {
                return Err(std::io::Error::other("atlas byte budget exceeded"));
            }
            self.0 -= bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(LimitedWriter(budget), value).is_ok()
}

/// Persist geometry only. Fresh snapshot nodes supply all labels/evidence again.
pub fn sanitize_atlas(mut value: Value, allowed: &HashSet<String>) -> Result<Value, String> {
    // Keep v1 readable so the frontend can explicitly rebuild its coordinates
    // once when migrating to v2. Both versions use the same geometry schema.
    if !matches!(
        value["version"].as_str(),
        Some("strata-atlas/1" | "strata-atlas/2")
    ) || value["worldSize"] != 4096
    {
        return Err("布局版本不受支持".into());
    }
    if value["epoch"].as_str().is_none_or(|s| s.len() > 256) {
        return Err("布局批次标识无效".into());
    }
    // Worker layouts also contain the current title/features/sourceGroups. They
    // are discarded below and must not consume the geometry-only disk budget.
    if !json_within_budget(&value, ATLAS_INPUT_BYTES) {
        return Err("布局输入超过 64 MiB 预算".into());
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
            if group["id"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 512)
            {
                return Err("布局分层标识无效".into());
            }
            let name = group["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("布局分层名称无效")?;
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
            // Legacy workers use a complete document title for singleton
            // clusters. Persist a bounded display label, never alter its ID.
            clean.push(json!({"id":group["id"],"name":if pruned {"主题".into()} else {atlas_label(name)},"x":group["x"],"y":group["y"],"radius":group["radius"],"parentId":group["parentId"],"memberIds":members}));
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
    let clean = json!({"version":value["version"],"epoch":value["epoch"],"worldSize":4096,"nodes":value["nodes"],"domains":value["domains"],"topics":value["topics"],"idf":value["idf"],"diagnostics":value["diagnostics"]});
    if !json_within_budget(&clean, ATLAS_CACHE_BYTES) {
        return Err("布局几何缓存超过 16 MiB 预算".into());
    }
    Ok(clean)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atlas() -> Value {
        json!({
            "version":"strata-atlas/1", "epoch":"fixture:1", "worldSize":4096,
            "nodes":[{"id":"n1","x":0.25,"y":0.75,"radius":0.01,"parentTopic":"t","parentDomain":"d","crowded":false}],
            "domains":[{"id":"d","name":"Domain","x":0.5,"y":0.5,"radius":0.4,"memberIds":["n1"]}],
            "topics":[{"id":"t","name":"Topic","parentId":"d","x":0.5,"y":0.5,"radius":0.2,"memberIds":["n1"]}],
            "idf":{"term":1.0}, "diagnostics":{}
        })
    }

    fn allowed() -> HashSet<String> {
        HashSet::from(["n1".into()])
    }

    #[test]
    fn full_worker_payload_over_disk_budget_saves_only_geometry_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path(), &task::hash("vault")).unwrap();
        let mut value = atlas();
        value["nodes"][0]["title"] = json!("x".repeat(ATLAS_CACHE_BYTES + 1));
        value["nodes"][0]["sourceGroups"] = json!([{"groupId":"private source"}]);
        value["nodes"][0]["evidence"] = json!([{"quote":"must not persist"}]);
        assert!(!json_within_budget(&value, ATLAS_CACHE_BYTES));
        cache.save_atlas(value, &allowed()).unwrap();
        let stored = std::fs::read(cache.root.join("atlas.json")).unwrap();
        assert!(stored.len() < 2048);
        let reloaded = cache.load_atlas(&allowed()).unwrap();
        assert_eq!(reloaded["nodes"], atlas()["nodes"]);
        assert!(reloaded["nodes"][0].get("title").is_none());
        assert!(reloaded["nodes"][0].get("sourceGroups").is_none());
        assert!(reloaded["nodes"][0].get("evidence").is_none());
        assert_eq!(reloaded["epoch"], "fixture:1");
    }

    #[test]
    fn input_and_sanitized_geometry_have_separate_hard_byte_limits() {
        let mut value = atlas();
        value["discarded"] = json!("x".repeat(ATLAS_INPUT_BYTES));
        assert!(sanitize_atlas(value, &allowed())
            .unwrap_err()
            .contains("输入超过 64 MiB"));

        let mut value = atlas();
        let idf: serde_json::Map<String, Value> = (0..35_000)
            .map(|i| (format!("{i:05}{}", "x".repeat(495)), json!(1)))
            .collect();
        value["idf"] = json!(idf);
        assert!(json_within_budget(&value, ATLAS_INPUT_BYTES));
        assert!(sanitize_atlas(value, &allowed())
            .unwrap_err()
            .contains("几何缓存超过 16 MiB"));
    }

    #[test]
    fn legacy_atlas_loads_unchanged_until_v2_geometry_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let key = task::hash("vault");
        let cache = Cache::new(dir.path(), &key).unwrap();
        cache.save_atlas(atlas(), &allowed()).unwrap();
        let reopened = Cache::new(dir.path(), &key).unwrap();
        let mut rebuilt = reopened.load_atlas(&allowed()).unwrap();
        assert_eq!(rebuilt["version"], "strata-atlas/1");
        assert_eq!(rebuilt["nodes"][0]["x"], 0.25);
        rebuilt["version"] = json!("strata-atlas/2");
        rebuilt["nodes"][0]["x"] = json!(0.5);
        reopened.save_atlas(rebuilt, &allowed()).unwrap();
        let loaded = cache.load_atlas(&allowed()).unwrap();
        assert_eq!(loaded["version"], "strata-atlas/2");
        assert_eq!(loaded["nodes"][0]["x"], 0.5);
    }

    #[test]
    fn long_cluster_labels_are_bounded_at_utf8_boundaries_without_changing_identity() {
        let mut value = atlas();
        value["domains"][0]["name"] = json!("知识领域".repeat(2000));
        value["topics"][0]["name"] = json!("📚e\u{301}".repeat(4000));
        let clean = sanitize_atlas(value, &allowed()).unwrap();
        for key in ["domains", "topics"] {
            let group = &clean[key][0];
            assert!(group["name"].as_str().unwrap().len() <= ATLAS_LABEL_BYTES);
            assert!(group["name"].as_str().unwrap().ends_with('…'));
            for field in ["id", "x", "y", "radius", "memberIds"] {
                assert_eq!(group[field], atlas()[key][0][field]);
            }
        }
        let mut value = atlas();
        value["domains"][0]["id"] = json!("x".repeat(513));
        assert!(sanitize_atlas(value, &allowed()).is_err());
        for name in [json!(""), Value::Null, json!(["not a label"])] {
            let mut value = atlas();
            value["topics"][0]["name"] = name;
            assert!(sanitize_atlas(value, &allowed()).is_err());
        }
    }

    #[test]
    fn atlas_shape_coordinates_and_authorization_stay_validated() {
        for (key, invalid) in [
            ("version", json!("other")),
            ("worldSize", json!(1)),
            ("epoch", json!("x".repeat(257))),
        ] {
            let mut value = atlas();
            value[key] = invalid;
            assert!(sanitize_atlas(value, &allowed()).is_err());
        }
        for (key, invalid) in [
            ("x", json!(16385)),
            ("y", Value::Null),
            ("radius", json!(-1)),
            ("crowded", json!("no")),
        ] {
            let mut value = atlas();
            value["nodes"][0][key] = invalid;
            assert!(sanitize_atlas(value, &allowed()).is_err());
        }
        let mut value = atlas();
        value["nodes"]
            .as_array_mut()
            .unwrap()
            .push(atlas()["nodes"][0].clone());
        assert!(sanitize_atlas(value, &allowed())
            .unwrap_err()
            .contains("重复"));

        let pruned = sanitize_atlas(atlas(), &HashSet::new()).unwrap();
        assert_eq!(pruned["nodes"], json!([]));
        assert_eq!(pruned["domains"], json!([]));
        assert_eq!(pruned["topics"], json!([]));
        assert_eq!(pruned["idf"], json!({}));
    }
}
