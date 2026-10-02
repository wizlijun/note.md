//! Development-only, explicitly invoked read-only Vault validation adapter.
//! Usage: audit_vault ROOT MANIFEST_JSON OUTPUT_JSONL [AS_OF WINDOW_DAYS UTC_OFFSET_MINUTES]
//! The manifest is exported from SQLite with mode=ro; this process never opens
//! or changes the search index. All artifacts must be written outside the Vault.
//! Writes the complete JSONL for local inspection and its .jsonl.zst snapshot.
use habitat_core::{extract::Extractor, hash, model::*, organize};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

fn safe_read(root: &Path, path: &str) -> Result<String, String> {
    if !habitat_core::codec::safe_source_path(path)
        || path.split('/').any(|p| {
            matches!(
                p,
                ".credentials"
                    | ".git"
                    | ".local"
                    | "node_modules"
                    | ".ssh"
                    | ".aws"
                    | "mails"
                    | "mail"
            )
        })
        || matches!(path, "USER.md" | "MEMORY.md" | "AGENTS.md" | "CLAUDE.md")
        || (path.starts_with(".notemd/")
            && !matches!(path, ".notemd/settings.json" | ".notemd/meetings.json"))
    {
        return Err("受控审计范围排除此路径".into());
    }
    let mut cursor = root.to_path_buf();
    for part in path.split('/') {
        cursor.push(part);
        let info = fs::symlink_metadata(&cursor).map_err(|_| "来源不存在或不可访问")?;
        if info.file_type().is_symlink() {
            return Err("来源路径含符号链接".into());
        }
    }
    if !cursor.is_file() {
        return Err("来源不是普通文件".into());
    }
    fs::read_to_string(cursor).map_err(|_| "来源不是可读取的UTF-8文本".into())
}
fn extract(
    root: &Path,
    inputs: &[SourceInput],
    previous: Option<&Snapshot>,
    focus: Option<&FocusContext>,
) -> Result<Extraction, String> {
    let mut extractor = Extractor::new("development-vault-audit", inputs, previous);
    if let Some(focus) = focus {
        extractor.set_focus(focus.clone())?;
    }
    for (index, input) in inputs.iter().enumerate() {
        match safe_read(root, &input.path) {
            Ok(content) => {
                if extractor.add_document(&input.path, &content).is_err() {
                    extractor.mark_unavailable(&input.path, "冻结内容摘要不一致");
                }
            }
            Err(reason) => extractor.mark_unavailable(&input.path, &reason),
        }
        if (index + 1) % 2000 == 0 {
            eprintln!("parsed input progress: {}/{}", index + 1, inputs.len());
        }
    }
    extractor.finish()
}
fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if !matches!(args.len(), 4 | 7) {
        return Err("usage: audit_vault ROOT MANIFEST_JSON OUTPUT_JSONL [AS_OF WINDOW_DAYS UTC_OFFSET_MINUTES]".into());
    }
    let focus = if args.len() == 7 {
        Some(FocusContext {
            as_of: args[4].clone(),
            window_days: args[5]
                .parse()
                .map_err(|_| "WINDOW_DAYS must be an integer")?,
            utc_offset_minutes: args[6]
                .parse()
                .map_err(|_| "UTC_OFFSET_MINUTES must be an integer")?,
        })
    } else {
        None
    };
    let root = fs::canonicalize(&args[1]).map_err(|e| e.to_string())?;
    let output = PathBuf::from(&args[3]);
    let parent = output.parent().ok_or("输出路径缺少父目录")?;
    if fs::canonicalize(parent)
        .map_err(|e| e.to_string())?
        .starts_with(&root)
    {
        return Err("审计输出必须位于Vault以外".into());
    }
    let inputs: Vec<SourceInput> =
        serde_json::from_slice(&fs::read(&args[2]).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let start = Instant::now();
    let data = extract(&root, &inputs, None, focus.as_ref())?;
    let extraction_ms = start.elapsed().as_millis();
    let evidence_ids: std::collections::BTreeSet<_> =
        data.evidence.iter().map(|e| e.id.as_str()).collect();
    eprintln!(
        "extraction gate: {}",
        json!({"nodes":data.nodes.len(),"emptyLabels":data.nodes.iter().filter(|n|n.label.trim().is_empty()).count(),"oversizedKeys":data.nodes.iter().filter(|n|n.key.len()>256).count(),"brokenNodeEvidence":data.nodes.iter().flat_map(|n|&n.evidence).filter(|id|!evidence_ids.contains(id.as_str())).count(),"extractionMs":extraction_ms})
    );
    let start = Instant::now();
    let snapshot = organize::build(
        "development-vault-audit",
        &hash("controlled-index-plus-meeting-knowledge/1"),
        data,
        None,
    )?;
    let organization_ms = start.elapsed().as_millis();
    let bytes = habitat_core::encode(&snapshot)?;
    let jsonl = habitat_core::codec::encode_jsonl(&snapshot)?;
    let start = Instant::now();
    if habitat_core::decode(&bytes)? != snapshot {
        return Err("完整压缩快照解码未无损恢复结构".into());
    }
    let decode_ms = start.elapsed().as_millis();
    let packed_path = output.with_extension("jsonl.zst");
    let mut types: BTreeMap<&str, usize> = BTreeMap::new();
    let mut type_bytes: BTreeMap<String, usize> = BTreeMap::new();
    let mut record_bytes: BTreeMap<String, usize> = BTreeMap::new();
    for line in jsonl.split_inclusive(|b| *b == b'\n') {
        let value: serde_json::Value = serde_json::from_slice(line).map_err(|e| e.to_string())?;
        let kind = value["kind"].as_str().ok_or("JSONL 缺少 kind")?;
        *record_bytes.entry(kind.into()).or_default() += line.len();
        if kind == "node" {
            *type_bytes
                .entry(value["nodeType"].as_str().ok_or("节点缺少类型")?.into())
                .or_default() += line.len();
        }
    }
    for node in &snapshot.nodes {
        *types.entry(&node.node_type).or_default() += 1;
    }
    let mut edge_types: BTreeMap<&str, usize> = BTreeMap::new();
    for edge in &snapshot.edges {
        *edge_types.entry(&edge.edge_type).or_default() += 1;
    }
    let visible: BTreeMap<_, _> = ["Hemory", "note.md", "隐性知识", "Bushcraft"]
        .into_iter()
        .map(|label| {
            let key = label.to_lowercase();
            let count = snapshot
                .nodes
                .iter()
                .filter(|node| {
                    node.label.to_lowercase().contains(&key)
                        || node.aliases.iter().any(|a| a.to_lowercase().contains(&key))
                })
                .count();
            (label, count)
        })
        .collect();
    let initial = json!({"bytes":bytes.len(),"packedBytes":bytes.len(),"jsonlBytes":jsonl.len(),"compressionRatio":bytes.len() as f64/jsonl.len() as f64,"packedPath":packed_path,"jsonlPath":output,"focus":snapshot.meta.focus,"attentionNodes":snapshot.attention.len(),"sources":snapshot.sources.len(),"nodes":snapshot.nodes.len(),"evidence":snapshot.evidence.len(),"edges":snapshot.edges.len(),"types":types,"extractionMs":extraction_ms,"organizationMs":organization_ms,"decodeMs":decode_ms,"losslessDecode":true});
    eprintln!("first full snapshot: {initial}");
    fs::write(&output, &jsonl).map_err(|e| e.to_string())?;
    fs::write(&packed_path, &bytes).map_err(|e| e.to_string())?;
    let start = Instant::now();
    let repeated = extract(&root, &inputs, Some(&snapshot), focus.as_ref())?;
    let again = organize::build(
        "development-vault-audit",
        &hash("controlled-index-plus-meeting-knowledge/1"),
        repeated,
        Some(&snapshot),
    )?;
    let again_bytes = habitat_core::encode(&again)?;
    let again_jsonl = habitat_core::codec::encode_jsonl(&again)?;
    let repeat_ms = start.elapsed().as_millis();
    let same = bytes == again_bytes && jsonl == again_jsonl;
    let mut summary = initial;
    summary["coverage"] = serde_json::to_value(&snapshot.meta.coverage).unwrap();
    summary["nodeBytesByType"] = json!(type_bytes);
    summary["edgesByType"] = json!(edge_types);
    summary["knownThemeLabelMatches"] = json!(visible);
    summary["repeatMs"] = json!(repeat_ms);
    summary["byteIdenticalNoOp"] = json!(same);
    summary["packedByteIdenticalNoOp"] = json!(bytes == again_bytes);
    summary["jsonlByteIdenticalNoOp"] = json!(jsonl == again_jsonl);
    summary["stateHash"] = json!(snapshot.meta.state_hash);
    summary["snapshotId"] = json!(snapshot.meta.snapshot_id);
    summary["manifestHash"] = json!(snapshot.meta.manifest_hash);
    summary["scopeHash"] = json!(snapshot.meta.scope_hash);
    summary["adapter"] = json!("development SQLite mode=ro manifest; same pure extraction/organization/codec as production; not a host RPC capture test");
    summary["recordBytes"] = json!(record_bytes);
    let node_types: BTreeMap<_, _> = snapshot
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n.node_type.as_str()))
        .collect();
    let mut extents: BTreeMap<&str, [f64; 4]> = BTreeMap::new();
    let mut positions = std::collections::BTreeSet::new();
    for position in &snapshot.layout {
        let kind = node_types[position.id.as_str()];
        let bounds = extents
            .entry(kind)
            .or_insert([position.x, position.y, position.x, position.y]);
        bounds[0] = bounds[0].min(position.x);
        bounds[1] = bounds[1].min(position.y);
        bounds[2] = bounds[2].max(position.x);
        bounds[3] = bounds[3].max(position.y);
        positions.insert((
            (position.x * 1e6).round() as i64,
            (position.y * 1e6).round() as i64,
        ));
    }
    summary["layoutExtentsByTypeMinXMinYMaxXMaxY"] = json!(extents);
    summary["layoutCoordinateCollisions"] = json!(snapshot.layout.len() - positions.len());
    summary["packedWithin10MiB"] = json!(bytes.len() <= 10 * 1024 * 1024);
    let summary_path = output.with_file_name(format!(
        "{}-summary.json",
        output.file_stem().unwrap().to_string_lossy()
    ));
    fs::write(&summary_path, serde_json::to_vec_pretty(&summary).unwrap())
        .map_err(|e| e.to_string())?;
    println!("{}",serde_json::to_string(&json!({"summary":summary_path,"bytes":bytes.len(),"byteIdenticalNoOp":same,"knownThemes":visible})).unwrap());
    if !same {
        return Err("真实Vault相同输入重跑未得到字节相同快照".into());
    }
    Ok(())
}
