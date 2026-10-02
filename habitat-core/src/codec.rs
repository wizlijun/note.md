use crate::{hash, model::*};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::Read;

pub const MAX_DECODE_BYTES: usize = 128 * 1024 * 1024;

pub fn transport_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}
pub fn transport_decode(text: &str) -> Result<Vec<u8>, String> {
    if text.len() > MAX_DECODE_BYTES.div_ceil(3) * 4 {
        return Err("快照传输超过预算".into());
    }
    STANDARD
        .decode(text)
        .map_err(|_| "结构内容不是规范 Base64".into())
}

fn digest(value: impl Serialize) -> Result<String, String> {
    let value = serde_json::to_value(value).map_err(|e| e.to_string())?;
    Ok(hash(serde_json::to_vec(&value).map_err(|e| e.to_string())?))
}

fn normalize(snapshot: &mut Snapshot) {
    snapshot.sources.sort_by(|a, b| a.id.cmp(&b.id));
    snapshot.nodes.sort_by(|a, b| a.id.cmp(&b.id));
    snapshot.evidence.sort_by(|a, b| a.id.cmp(&b.id));
    snapshot.edges.sort_by(|a, b| a.id.cmp(&b.id));
    snapshot.memberships.sort_by(|a, b| a.id.cmp(&b.id));
    snapshot.lineage.sort_by(|a, b| a.id.cmp(&b.id));
    snapshot.layout.sort_by(|a, b| a.id.cmp(&b.id));
    snapshot.attention.sort_by(|a, b| a.node.cmp(&b.node));
    snapshot
        .attention_observations
        .sort_by(|a, b| a.evidence.cmp(&b.evidence));
    snapshot.meta.parents.sort();
    snapshot.meta.parents.dedup();
    snapshot
        .meta
        .coverage
        .diagnostics
        .sort_by(|a, b| (&a.path, &a.code, &a.message).cmp(&(&b.path, &b.code, &b.message)));
    snapshot.meta.coverage.diagnostics.dedup();
    for node in &mut snapshot.nodes {
        node.aliases.sort();
        node.aliases.dedup();
        node.evidence.sort();
        node.evidence.dedup();
    }
    for edge in &mut snapshot.edges {
        edge.evidence.sort();
        edge.evidence.dedup();
        edge.participants
            .sort_by(|a, b| (&a.role, &a.node).cmp(&(&b.role, &b.node)));
        edge.participants.dedup();
    }
    for item in &mut snapshot.memberships {
        item.score = round(item.score);
    }
    for item in &mut snapshot.attention {
        item.score = round(item.score);
        item.evidence.sort();
        item.evidence.dedup();
    }
    for item in &mut snapshot.attention_observations {
        item.confidence = round(item.confidence);
    }
    for item in &mut snapshot.layout {
        item.x = round(item.x);
        item.y = round(item.y);
    }
    for item in &mut snapshot.lineage {
        item.from.sort();
        item.from.dedup();
        item.to.sort();
        item.to.dedup();
    }
}
fn round(value: f64) -> f64 {
    (value * 1_000_000.).round() / 1_000_000.
}

fn state_hash(snapshot: &Snapshot) -> Result<String, String> {
    let mut state = json!({"schema":snapshot.meta.schema,"vaultId":snapshot.meta.vault_id,
        "algorithm":snapshot.meta.algorithm,"scopeHash":snapshot.meta.scope_hash,
        "manifestHash":snapshot.meta.manifest_hash,"structureHash":snapshot.meta.structure_hash,
        "evidenceHash":snapshot.meta.evidence_hash,"layoutHash":snapshot.meta.layout_hash,
        "coverage":snapshot.meta.coverage});
    // The v1 digest must remain byte-for-byte the original formula. New focus
    // records are a separate state dimension, not a knowledge-structure delta.
    if snapshot.meta.schema == SCHEMA {
        state["focus"] = json!(snapshot.meta.focus);
        state["attention"] = json!(snapshot.attention);
        state["attentionObservations"] = json!(snapshot.attention_observations);
    }
    digest(state)
}
fn snapshot_id(meta: &Meta) -> Result<String, String> {
    digest(json!({"schema":meta.schema,"stateHash":meta.state_hash,"parents":meta.parents}))
}
fn hashes(snapshot: &mut Snapshot) -> Result<(), String> {
    snapshot.meta.manifest_hash = digest(&snapshot.sources)?;
    snapshot.meta.structure_hash = digest(json!({"nodes":snapshot.nodes,"edges":snapshot.edges,
        "memberships":snapshot.memberships,"lineage":snapshot.lineage}))?;
    snapshot.meta.evidence_hash = digest(&snapshot.evidence)?;
    snapshot.meta.layout_hash = digest(&snapshot.layout)?;
    snapshot.meta.state_hash = state_hash(snapshot)?;
    snapshot.meta.snapshot_id = snapshot_id(&snapshot.meta)?;
    Ok(())
}

/// Returns false and restores the previous bytes' data on a semantic no-op.
pub fn finalize(snapshot: &mut Snapshot, previous: Option<&Snapshot>) -> Result<bool, String> {
    snapshot.meta.schema = SCHEMA.into();
    snapshot.meta.parents = previous
        .map(|s| vec![s.meta.snapshot_id.clone()])
        .unwrap_or_default();
    normalize(snapshot);
    hashes(snapshot)?;
    if let Some(old) = previous {
        if snapshot.meta.vault_id != old.meta.vault_id {
            return Err("Vault 身份变化，拒绝连接历史".into());
        }
        if snapshot.meta.state_hash == old.meta.state_hash {
            *snapshot = old.clone();
            return Ok(false);
        }
        snapshot.meta.change_cause = if snapshot.meta.algorithm != old.meta.algorithm
            || snapshot.meta.schema != old.meta.schema
        {
            if crate::diff::material_changed(old, snapshot) {
                "mixed"
            } else {
                "algorithm"
            }
        } else if snapshot.meta.scope_hash != old.meta.scope_hash {
            "scope"
        } else if snapshot.meta.focus != old.meta.focus
            && !crate::diff::material_changed(old, snapshot)
        {
            "attention_window"
        } else if snapshot.meta.structure_hash != old.meta.structure_hash {
            "content"
        } else if snapshot.meta.evidence_hash != old.meta.evidence_hash
            || snapshot.meta.manifest_hash != old.meta.manifest_hash
        {
            "evidence"
        } else if snapshot.meta.layout_hash != old.meta.layout_hash {
            "layout"
        } else if snapshot.attention != old.attention
            || snapshot.attention_observations != old.attention_observations
        {
            "attention"
        } else {
            "coverage"
        }
        .into();
    } else {
        snapshot.meta.change_cause = "baseline".into();
    }
    if snapshot.meta.generated_at.is_empty() {
        snapshot.meta.generated_at = chrono::Utc::now().to_rfc3339();
    }
    validate(snapshot)?;
    Ok(true)
}

fn ids<'a>(values: impl Iterator<Item = &'a str>, kind: &str) -> Result<HashSet<&'a str>, String> {
    let mut result = HashSet::new();
    for id in values {
        if id.is_empty() || id.len() > 256 || !result.insert(id) {
            return Err(format!("{kind} 身份为空或重复"));
        }
    }
    Ok(result)
}
pub fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn safe_source_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(['\\', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && !matches!(p, "." | ".." | ".git") && !p.starts_with(".env"))
        && !path.starts_with(".notemd/habitat/")
}

fn focus_date(value: &str) -> Result<chrono::NaiveDate, String> {
    if value.len() != 10 {
        return Err("关注记录日期必须为 YYYY-MM-DD".into());
    }
    let date = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| "关注记录日期无效".to_string())?;
    if date.format("%Y-%m-%d").to_string() != value {
        return Err("关注记录日期必须为 YYYY-MM-DD".into());
    }
    Ok(date)
}

fn unit_score(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn validate_attention(snapshot: &Snapshot) -> Result<(), String> {
    let Some(focus) = &snapshot.meta.focus else {
        if !snapshot.attention.is_empty() || !snapshot.attention_observations.is_empty() {
            return Err("关注记录缺少观察窗口".into());
        }
        return Ok(());
    };
    if !(1..=3660).contains(&focus.window_days) || !(-840..=840).contains(&focus.utc_offset_minutes)
    {
        return Err("关注观察窗口或时区无效".into());
    }
    let as_of = focus_date(&focus.as_of)?;
    let start = as_of
        .checked_sub_days(chrono::Days::new(u64::from(focus.window_days - 1)))
        .ok_or("关注观察窗口超出日期范围")?;
    ids(
        snapshot.attention.iter().map(|a| a.node.as_str()),
        "关注节点",
    )?;
    ids(
        snapshot
            .attention_observations
            .iter()
            .map(|o| o.evidence.as_str()),
        "关注观测证据",
    )?;
    let evidence: HashSet<_> = snapshot.evidence.iter().map(|e| e.id.as_str()).collect();
    let nodes: BTreeMap<_, _> = snapshot.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut observations = BTreeMap::new();
    for observation in &snapshot.attention_observations {
        let date = focus_date(&observation.date)?;
        if !evidence.contains(observation.evidence.as_str())
            || date < start
            || date > as_of
            || observation.event_id.trim().is_empty()
            || observation.event_id.len() > 256
            || observation.signal.trim().is_empty()
            || observation.date_basis.trim().is_empty()
            || !unit_score(observation.confidence)
        {
            return Err("关注观测的证据、事件、日期或置信度无效".into());
        }
        observations.insert(observation.evidence.as_str(), observation);
    }
    for attention in &snapshot.attention {
        let node = nodes.get(attention.node.as_str()).ok_or("关注节点不存在")?;
        if !unit_score(attention.score)
            || !matches!(attention.category.as_str(), "concept" | "context")
            || attention.evidence.is_empty()
            || attention
                .evidence
                .iter()
                .any(|id| !node.evidence.contains(id))
        {
            return Err("关注度分数、类别或节点证据无效".into());
        }
        let mut days = HashSet::new();
        let mut events = HashSet::new();
        for id in &attention.evidence {
            let observation = observations.get(id.as_str()).ok_or("关注度缺少对应观测")?;
            days.insert(observation.date.as_str());
            events.insert(observation.event_id.as_str());
        }
        if attention.active_days as usize != days.len()
            || attention.events as usize != events.len()
            || days.iter().max().copied() != Some(attention.last_observed_at.as_str())
        {
            return Err("关注度日期、活跃天数或事件数与证据不一致".into());
        }
    }
    Ok(())
}

pub fn validate(snapshot: &Snapshot) -> Result<(), String> {
    let meta = &snapshot.meta;
    if !matches!(meta.schema.as_str(), SCHEMA | SCHEMA_V1) {
        return Err("不支持的知识结构版本".into());
    }
    if meta.schema == SCHEMA_V1
        && (meta.focus.is_some()
            || !snapshot.attention.is_empty()
            || !snapshot.attention_observations.is_empty())
    {
        return Err("旧版结构不能携带关注度记录".into());
    }
    if meta.vault_id.is_empty()
        || meta.algorithm.version.is_empty()
        || !valid_hash(&meta.scope_hash)
    {
        return Err("结构缺少 Vault、算法或范围标识".into());
    }
    if chrono::DateTime::parse_from_rfc3339(&meta.generated_at).is_err() {
        return Err("生成时间无效".into());
    }
    if meta
        .parents
        .iter()
        .any(|id| !valid_hash(id) || id == &meta.snapshot_id)
    {
        return Err("父快照无效".into());
    }
    ids(meta.parents.iter().map(String::as_str), "父快照")?;
    let sources = ids(snapshot.sources.iter().map(|s| s.id.as_str()), "来源")?;
    ids(snapshot.sources.iter().map(|s| s.path.as_str()), "来源路径")?;
    let nodes = ids(snapshot.nodes.iter().map(|n| n.id.as_str()), "节点")?;
    ids(snapshot.nodes.iter().map(|n| n.key.as_str()), "节点匹配键")?;
    let evidence = ids(snapshot.evidence.iter().map(|e| e.id.as_str()), "证据")?;
    ids(snapshot.edges.iter().map(|e| e.id.as_str()), "关系")?;
    ids(snapshot.memberships.iter().map(|e| e.id.as_str()), "归属")?;
    ids(snapshot.lineage.iter().map(|e| e.id.as_str()), "谱系")?;
    ids(snapshot.layout.iter().map(|e| e.id.as_str()), "位置")?;
    for s in &snapshot.sources {
        if !safe_source_path(&s.path) || !valid_hash(&s.hash) || s.family.is_empty() {
            return Err("来源清单包含非法路径/hash/家族".into());
        }
    }
    for e in &snapshot.evidence {
        if !sources.contains(e.source.as_str())
            || e.locator.start == 0
            || e.locator.end < e.locator.start
        {
            return Err("证据来源或定位无效".into());
        }
    }
    for n in &snapshot.nodes {
        if n.label.trim().is_empty()
            || n.node_type.is_empty()
            || n.status.is_empty()
            || n.evidence.iter().any(|e| !evidence.contains(e.as_str()))
        {
            return Err("节点缺少类型/名称或存在断开的证据引用".into());
        }
    }
    for e in &snapshot.edges {
        if e.edge_type.is_empty()
            || e.status.is_empty()
            || e.participants.len() < 2
            || e.participants
                .iter()
                .any(|p| !nodes.contains(p.node.as_str()) || p.role.is_empty())
            || e.evidence.iter().any(|id| !evidence.contains(id.as_str()))
        {
            return Err("关系角色或证据引用无效".into());
        }
    }
    let topics: HashSet<_> = snapshot
        .nodes
        .iter()
        .filter(|n| n.node_type == "topic")
        .map(|n| n.id.as_str())
        .collect();
    for m in &snapshot.memberships {
        if !nodes.contains(m.node.as_str())
            || !topics.contains(m.topic.as_str())
            || !m.score.is_finite()
            || !(0.0..=1.0).contains(&m.score)
        {
            return Err("主题归属无效".into());
        }
    }
    for l in &snapshot.layout {
        if !nodes.contains(l.id.as_str()) || !l.x.is_finite() || !l.y.is_finite() {
            return Err("布局引用/坐标无效".into());
        }
    }
    for l in &snapshot.lineage {
        if l.to.iter().any(|id| !nodes.contains(id.as_str())) || l.change.is_empty() {
            return Err("谱系目标无效".into());
        }
    }
    validate_attention(snapshot)?;
    let mut check = snapshot.clone();
    normalize(&mut check);
    if &check != snapshot {
        return Err("快照记录不是规范排序".into());
    }
    hashes(&mut check)?;
    if check.meta != snapshot.meta {
        return Err("快照完整性校验失败".into());
    }
    Ok(())
}

fn push<T: Serialize>(bytes: &mut Vec<u8>, kind: &str, value: &T) -> Result<(), String> {
    let mut value = serde_json::to_value(value).map_err(|e| e.to_string())?;
    value
        .as_object_mut()
        .ok_or("记录不是对象")?
        .insert("kind".into(), json!(kind));
    serde_json::to_writer(&mut *bytes, &value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(())
}
/// Human-readable canonical representation of all semantic records.
pub fn encode_jsonl(snapshot: &Snapshot) -> Result<Vec<u8>, String> {
    validate(snapshot)?;
    let mut bytes = Vec::new();
    push(&mut bytes, "meta", &snapshot.meta)?;
    macro_rules! records {
        ($kind:literal,$field:ident) => {
            for item in &snapshot.$field {
                push(&mut bytes, $kind, item)?;
            }
        };
    }
    records!("source", sources);
    records!("node", nodes);
    records!("evidence", evidence);
    records!("edge", edges);
    records!("membership", memberships);
    records!("lineage", lineage);
    records!("layout", layout);
    records!("attention", attention);
    records!("attention_observation", attention_observations);
    Ok(bytes)
}
fn take<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("快照格式错误: {e}"))
}
fn decode_jsonl(bytes: &[u8]) -> Result<Snapshot, String> {
    if bytes.len() > MAX_DECODE_BYTES {
        return Err("快照超过读取预算".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "快照不是 UTF-8")?;
    let mut snapshot = Snapshot::default();
    let mut found_meta = false;
    for (index, line) in text.lines().enumerate() {
        if line.len() > 4 * 1024 * 1024 {
            return Err("单条结构记录超限".into());
        }
        let mut value: Value = serde_json::from_str(line).map_err(|_| "JSONL 损坏或截断")?;
        let kind = value
            .as_object_mut()
            .and_then(|v| v.remove("kind"))
            .and_then(|v| v.as_str().map(str::to_string))
            .ok_or("记录缺少 kind")?;
        match kind.as_str() {
            "meta" if index == 0 && !found_meta => {
                snapshot.meta = take(value)?;
                found_meta = true;
            }
            "source" => snapshot.sources.push(take(value)?),
            "node" => snapshot.nodes.push(take(value)?),
            "evidence" => snapshot.evidence.push(take(value)?),
            "edge" => snapshot.edges.push(take(value)?),
            "membership" => snapshot.memberships.push(take(value)?),
            "lineage" => snapshot.lineage.push(take(value)?),
            "layout" => snapshot.layout.push(take(value)?),
            "attention" => snapshot.attention.push(take(value)?),
            "attention_observation" => snapshot.attention_observations.push(take(value)?),
            _ => return Err("未知记录类型或重复 metadata".into()),
        }
    }
    if !found_meta {
        return Err("快照为空".into());
    }
    validate(&snapshot)?;
    // Enforces canonical JSON, including duplicate-key rejection and LF framing.
    if encode_jsonl(&snapshot)? != bytes {
        return Err("快照不是规范 JSONL（重复键、排序或字节编码异常）".into());
    }
    Ok(snapshot)
}

/// Standard Zstandard over the complete canonical JSONL, with no dropped data.
/// Git stores the compressed blob; the UI compares the decoded structure.
pub fn encode(snapshot: &Snapshot) -> Result<Vec<u8>, String> {
    let jsonl = encode_jsonl(snapshot)?;
    if jsonl.len() > MAX_DECODE_BYTES {
        return Err("展开结构超过读取预算".into());
    }
    zstd::stream::encode_all(jsonl.as_slice(), 9).map_err(|e| format!("结构压缩失败: {e}"))
}

pub fn decode(bytes: &[u8]) -> Result<Snapshot, String> {
    if bytes.len() > MAX_DECODE_BYTES {
        return Err("快照超过读取预算".into());
    }
    let mut decoder =
        zstd::stream::read::Decoder::new(bytes).map_err(|_| "结构不是有效的 Zstandard 文件")?;
    decoder.window_log_max(27).map_err(|e| e.to_string())?;
    let mut jsonl = Vec::new();
    decoder
        .take((MAX_DECODE_BYTES + 1) as u64)
        .read_to_end(&mut jsonl)
        .map_err(|_| "结构压缩数据损坏或截断")?;
    decode_jsonl(&jsonl)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn empty() -> Snapshot {
        let mut s = Snapshot::default();
        s.meta.vault_id = "vault".into();
        s.meta.scope_hash = hash("all");
        s.meta.algorithm.version = "test/1".into();
        finalize(&mut s, None).unwrap();
        s
    }
    #[test]
    fn roundtrip_and_noop_keep_original_generation_and_parent() {
        let old = empty();
        let mut next = old.clone();
        next.meta.generated_at = "2026-10-01T00:00:00Z".into();
        assert!(!finalize(&mut next, Some(&old)).unwrap());
        assert_eq!(encode(&old).unwrap(), encode(&next).unwrap());
        assert_eq!(decode(&encode(&old).unwrap()).unwrap(), old);
    }
    #[test]
    fn corrupt_hash_and_duplicate_keys_are_rejected() {
        let old = empty();
        let mut value = old.clone();
        value.meta.state_hash = hash("tampered");
        assert!(validate(&value).is_err());
        let text = String::from_utf8(encode_jsonl(&old).unwrap()).unwrap();
        let duplicated = text.replacen(
            "\"kind\":\"meta\"",
            "\"kind\":\"meta\",\"kind\":\"meta\"",
            1,
        );
        assert!(decode_jsonl(duplicated.as_bytes()).is_err());
        assert!(decode_jsonl(text.trim_end().as_bytes()).is_err());
        let unknown = text.replace(SCHEMA, "vault-knowledge-structure/999");
        assert!(
            decode(&zstd::stream::encode_all(unknown.as_bytes(), 9).unwrap())
                .unwrap_err()
                .contains("不支持")
        );
    }
    #[test]
    fn compression_rejects_truncation_trailing_garbage_and_expansion_over_budget() {
        let encoded = encode(&empty()).unwrap();
        assert!(decode(&encoded[..encoded.len() - 1]).is_err());
        let mut trailing = encoded;
        trailing.extend_from_slice(b"garbage");
        assert!(decode(&trailing).is_err());
        let oversized =
            zstd::stream::encode_all(std::io::repeat(b'x').take((MAX_DECODE_BYTES + 1) as u64), 1)
                .unwrap();
        assert!(decode(&oversized).unwrap_err().contains("预算"));
    }
    #[test]
    fn method_change_is_not_content_growth() {
        let old = empty();
        let mut next = old.clone();
        next.meta.algorithm.version = "test/2".into();
        assert!(finalize(&mut next, Some(&old)).unwrap());
        assert_eq!(next.meta.change_cause, "algorithm");
        assert_eq!(next.meta.parents, vec![old.meta.snapshot_id]);
    }
}
