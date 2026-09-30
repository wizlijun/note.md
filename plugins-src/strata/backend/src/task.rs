use crate::types::{Confidentiality, Evidence, File, Node, OwnerSpecificity, Relation, Unit};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub const TASK: &str = "strata-extract-v1";
pub const RULE: &str = "strata-extract/1.0.0";
pub const MAX_BATCH_BYTES: usize = 32 * 1024;
pub const INSTRUCTIONS: &str =
    include_str!("../../../agent-run-core/templates/strata-extract-v1/INSTRUCTIONS.md");
pub const PROVIDERS: [&str; 3] = [
    "notemd.codex-agent",
    "notemd.claude-agent",
    "notemd.deepseek-agent",
];

pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Packet {
    pub schema: String,
    pub invocation_id: String,
    pub source: File,
    pub units: Vec<Unit>,
}
impl Packet {
    pub fn new(source: File, units: Vec<Unit>) -> Self {
        Self {
            schema: "notemd.strata/input/v1".into(),
            invocation_id: uuid::Uuid::new_v4().to_string(),
            source,
            units,
        }
    }
    pub fn prompt(&self) -> Result<String, String> {
        serde_json::to_string(&json!({"protocol":INSTRUCTIONS,"input":self}))
            .map_err(|_| "无法准备抽取材料".into())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output {
    schema: String,
    invocation_id: String,
    nodes: Vec<RawNode>,
    relations: Vec<RawRelation>,
    #[serde(default)]
    skipped_reason: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawNode {
    id: String,
    title: String,
    kind: String,
    #[serde(default)]
    features: Vec<String>,
    #[serde(default)]
    owner_specificity: OwnerSpecificity,
    #[serde(default)]
    confidentiality: Confidentiality,
    #[serde(default)]
    classification_reason: String,
    epistemic: String,
    #[serde(default)]
    speaker: Option<String>,
    #[serde(default)]
    conditions: Vec<String>,
    #[serde(default)]
    limits: Vec<String>,
    evidence: Vec<RawEvidence>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRelation {
    id: String,
    source: String,
    target: String,
    r#type: String,
    title: String,
    evidence: Vec<RawEvidence>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawEvidence {
    block_key: String,
    line_start: u32,
    line_end: u32,
    quote: String,
}

pub fn terminal_content(status: &Value) -> Result<&str, String> {
    if status["state"] != "done"
        || status.pointer("/record/status").and_then(Value::as_str) != Some("success")
    {
        return Err("Agent 未成功完成，未保存本批知识".into());
    }
    if status
        .pointer("/terminal_result/complete")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err("Agent 未返回完整结果，不能用截断摘要替代".into());
    }
    let text = status
        .pointer("/terminal_result/content")
        .and_then(Value::as_str)
        .ok_or("Agent 结果缺失")?;
    if text.len() > 512 * 1024 {
        return Err("Agent 结果超过校验预算".into());
    }
    Ok(text)
}

pub fn validate_output(text: &str, packet: &Packet) -> Result<(Vec<Node>, Vec<Relation>), String> {
    let output: Output =
        serde_json::from_str(text.trim()).map_err(|_| "Agent JSON 不符合 STRATA 结构契约")?;
    if output.schema != "notemd.strata/extraction/v1"
        || output.invocation_id != packet.invocation_id
    {
        return Err("Agent 结果不属于本次调用".into());
    }
    if output.nodes.len() > 48
        || output.relations.len() > 96
        || (output.nodes.is_empty()
            && output
                .skipped_reason
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty())
    {
        return Err("抽取数量或未处理说明无效".into());
    }
    let mut ids = HashMap::new();
    let mut canonical = HashSet::new();
    let mut nodes = Vec::new();
    for raw in output.nodes {
        if !local_id(&raw.id)
            || ids.contains_key(&raw.id)
            || !bounded(&raw.title, 500)
            || !["entity", "concept", "claim", "event", "narrative"].contains(&raw.kind.as_str())
            || ![
                "explicit_statement",
                "self_report",
                "direct_observation",
                "agent_inference",
                "ambiguous",
            ]
            .contains(&raw.epistemic.as_str())
            || raw.features.len() > 16
            || raw.features.iter().any(|s| !bounded(s, 80))
        {
            return Err("知识对象的标识、类型或文字范围无效".into());
        }
        if raw.speaker.as_ref().is_some_and(|s| !bounded(s, 100))
            || raw.conditions.len() > 12
            || raw.limits.len() > 12
            || raw
                .conditions
                .iter()
                .chain(&raw.limits)
                .any(|s| !bounded(s, 500))
        {
            return Err("说话人、条件或有效范围格式无效".into());
        }
        if raw.owner_specificity == OwnerSpecificity::OwnerSpecific
            && !bounded(&raw.classification_reason, 500)
        {
            return Err("个人独有判断缺少与引文关联的说明".into());
        }
        // Identity conservatively includes source content: word overlap alone
        // cannot merge two people's first-person claims into one fact.
        let id = format!(
            "k{}",
            hash(format!(
                "{}\0{}\0{}",
                packet.source.content_hash,
                raw.kind,
                raw.title.trim()
            ))
            .get(..24)
            .unwrap()
        );
        ids.insert(raw.id, id.clone());
        let evidence = validate_evidence(&raw.evidence, packet)?;
        if !canonical.insert(id.clone()) {
            continue;
        }
        let confidentiality = match (packet.source.confidentiality, raw.confidentiality) {
            (Confidentiality::Confidential, _) | (_, Confidentiality::Confidential) => {
                Confidentiality::Confidential
            }
            (Confidentiality::ExplicitlyPublic, _) => Confidentiality::ExplicitlyPublic,
            _ => Confidentiality::Unknown,
        };
        nodes.push(Node {
            id,
            title: raw.title.trim().into(),
            kind: raw.kind,
            state: "verified".into(),
            features: raw.features,
            links: Vec::new(),
            owner_specificity: raw.owner_specificity,
            confidentiality,
            classification_reason: raw.classification_reason,
            epistemic: raw.epistemic,
            speaker: raw.speaker,
            conditions: raw.conditions,
            limits: raw.limits,
            source_groups: Vec::new(),
            evidence,
        });
    }
    let mut relations = Vec::new();
    let mut relation_ids = HashSet::new();
    for raw in output.relations {
        if !local_id(&raw.id)
            || !relation_ids.insert(raw.id)
            || !bounded(&raw.title, 500)
            || ![
                "supports",
                "contradicts",
                "depends_on",
                "part_of",
                "causes",
                "precedes",
                "references",
                "related_to",
            ]
            .contains(&raw.r#type.as_str())
        {
            return Err("关系类型或标识不受支持".into());
        }
        let source = ids
            .get(&raw.source)
            .ok_or("关系引用不存在的知识点")?
            .clone();
        let target = ids
            .get(&raw.target)
            .ok_or("关系引用不存在的知识点")?
            .clone();
        if source == target {
            return Err("关系不能自行指向同一知识点".into());
        }
        let evidence = validate_evidence(&raw.evidence, packet)?;
        let id = format!(
            "r{}",
            &hash(format!("{source}\0{target}\0{}", raw.r#type))[..24]
        );
        relations.push(Relation {
            id,
            source,
            target,
            r#type: raw.r#type,
            title: raw.title,
            evidence,
        });
    }
    Ok((nodes, relations))
}

fn validate_evidence(raw: &[RawEvidence], packet: &Packet) -> Result<Vec<Evidence>, String> {
    if raw.is_empty() || raw.len() > 8 {
        return Err("每个知识/关系必须有 1–8 条原文证据".into());
    }
    let mut out = Vec::new();
    for item in raw {
        if !bounded(&item.quote, 1000)
            || item.line_start == 0
            || item.line_end < item.line_start
            || item.line_end - item.line_start > 50
        {
            return Err("原文引用长度或行号无效".into());
        }
        let unit = packet
            .units
            .iter()
            .find(|u| u.block_key == item.block_key)
            .ok_or("引用了输入范围外的原文块")?;
        if unit.content_hash != packet.source.content_hash
            || unit.file_key != packet.source.file_key
            || item.line_start < unit.line_start
            || item.line_end > unit.line_end
        {
            return Err("引用越出冻结来源范围".into());
        }
        let excerpt = unit
            .text
            .lines()
            .skip((item.line_start - unit.line_start) as usize)
            .take((item.line_end - item.line_start + 1) as usize)
            .collect::<Vec<_>>()
            .join("\n");
        if !excerpt.contains(&item.quote) || contains_secret(&item.quote) {
            return Err("原文引文与指定行不逐字匹配，或含不应持久化的凭据".into());
        }
        out.push(Evidence {
            id: format!(
                "x{}",
                &hash(format!(
                    "{}\0{}\0{}",
                    packet.source.content_hash, item.block_key, item.quote
                ))[..24]
            ),
            source_id: packet.source.file_key.clone(),
            path: packet.source.path.clone(),
            content_hash: packet.source.content_hash.clone(),
            block_key: item.block_key.clone(),
            line_start: item.line_start,
            line_end: item.line_end,
            quote: item.quote.clone(),
        });
    }
    Ok(out)
}
pub fn contains_secret(text: &str) -> bool {
    text.contains("-----BEGIN PRIVATE KEY-----")
        || text.contains("-----BEGIN RSA PRIVATE KEY-----")
        || text.split_whitespace().any(|word| {
            (word.starts_with("sk-") || word.starts_with("ghp_") || word.starts_with("github_pat_"))
                && word.len() > 24
        })
}
fn bounded(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max && !text.contains('\0')
}
fn local_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet() -> Packet {
        Packet::new(
            File {
                file_key: "f1".into(),
                path: "notes/a.md".into(),
                content_hash: "a".repeat(64),
                ..File::default()
            },
            vec![Unit {
                file_key: "f1".into(),
                content_hash: "a".repeat(64),
                block_key: "b1".into(),
                line_start: 3,
                line_end: 4,
                text: "我决定先做本地检索。\n下周再复盘。".into(),
                breadcrumb: String::new(),
                level: "line".into(),
                is_annotation: false,
                agent_by: None,
                priority: 1.0,
                priority_factors: Value::Null,
            }],
        )
    }
    fn output(packet: &Packet) -> Value {
        json!({"schema":"notemd.strata/extraction/v1","invocationId":packet.invocation_id,"nodes":[{"id":"n1","title":"先做本地检索","kind":"claim","epistemic":"explicit_statement","evidence":[{"blockKey":"b1","lineStart":3,"lineEnd":3,"quote":"我决定先做本地检索。"}]}],"relations":[]})
    }
    #[test]
    fn evidence_requires_exact_quote_within_the_declared_lines() {
        let p = packet();
        let mut value = output(&p);
        assert_eq!(validate_output(&value.to_string(), &p).unwrap().0.len(), 1);
        value["nodes"][0]["evidence"][0]["lineStart"] = json!(4);
        value["nodes"][0]["evidence"][0]["lineEnd"] = json!(4);
        assert!(validate_output(&value.to_string(), &p).is_err());
        value["nodes"][0]["evidence"][0]["quote"] = json!("我已经完成本地检索。");
        assert!(validate_output(&value.to_string(), &p).is_err());
    }
    #[test]
    fn truncated_or_failed_terminal_is_never_accepted() {
        assert!(terminal_content(&json!({"state":"done","record":{"status":"success"},"terminal_result":{"complete":false,"content":"{}"}})).is_err());
        assert!(terminal_content(&json!({"state":"done","record":{"status":"failed"},"terminal_result":{"complete":true,"content":"{}"}})).is_err());
    }
    #[test]
    fn public_cannot_be_inferred_from_unknown_and_personal_needs_reason() {
        let p = packet();
        let mut v = output(&p);
        v["nodes"][0]["confidentiality"] = json!("explicitly_public");
        assert_eq!(
            validate_output(&v.to_string(), &p).unwrap().0[0].confidentiality,
            Confidentiality::Unknown
        );
        v["nodes"][0]["ownerSpecificity"] = json!("owner_specific");
        assert!(validate_output(&v.to_string(), &p).is_err());
    }
}
