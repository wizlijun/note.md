//! Read-only developer replay. Input is an existing canonical snapshot, not a
//! Vault path. Output preserves evidence locators and declares method migration.
use habitat_core::{model::*, organize};
use std::{collections::BTreeMap, fs, time::Instant};
fn extraction(s: &Snapshot) -> Extraction {
    Extraction {
        sources: s.sources.clone(),
        nodes: s
            .nodes
            .iter()
            .filter(|n| n.node_type != "topic")
            .cloned()
            .collect(),
        evidence: s.evidence.clone(),
        edges: s.edges.clone(),
        coverage: s.meta.coverage.clone(),
        features: BTreeMap::new(),
        focus: s.meta.focus.clone(),
        attention_observations: s.attention_observations.clone(),
        attention: s.attention.clone(),
        retained_keywords: s
            .nodes
            .iter()
            .filter(|n| n.node_type == "keyword")
            .filter_map(|n| n.key.strip_prefix("keyword:").map(str::to_owned))
            .collect(),
        ..Default::default()
    }
}
fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: reorganize_snapshot INPUT_JSONL_OR_ZST OUTPUT_JSONL".into());
    }
    let bytes = fs::read(&args[1]).map_err(|e| e.to_string())?;
    let bytes = if bytes.starts_with(b"{") {
        zstd::stream::encode_all(bytes.as_slice(), 3).map_err(|e| e.to_string())?
    } else {
        bytes
    };
    let before = habitat_core::decode(&bytes)?;
    let start = Instant::now();
    let after = organize::build(
        &before.meta.vault_id,
        &before.meta.scope_hash,
        extraction(&before),
        Some(&before),
    )?;
    let elapsed = start.elapsed().as_millis();
    let again = organize::build(
        &before.meta.vault_id,
        &before.meta.scope_hash,
        extraction(&before),
        Some(&after),
    )?;
    if after != again {
        return Err("same-input rebuild differs".into());
    }
    let raw = habitat_core::codec::encode_jsonl(&after)?;
    let packed = habitat_core::encode(&after)?;
    if habitat_core::decode(&packed)? != after {
        return Err("codec roundtrip differs".into());
    }
    fs::write(&args[2], raw).map_err(|e| e.to_string())?;
    fs::write(format!("{}.zst", args[2]), &packed).map_err(|e| e.to_string())?;
    let mut edge_types = BTreeMap::new();
    for e in &after.edges {
        *edge_types.entry(&e.edge_type).or_insert(0) += 1;
    }
    let mut degree = BTreeMap::new();
    for e in &after.edges {
        for p in &e.participants {
            *degree.entry(&p.node).or_insert(0) += 1;
        }
    }
    let keywords: Vec<_> = after
        .nodes
        .iter()
        .filter(|n| n.node_type == "keyword")
        .collect();
    let mut ranked = keywords.clone();
    ranked.sort_by_key(|n| std::cmp::Reverse(n.evidence.len()));
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"milliseconds":elapsed,"keywords":keywords.len(),"topics":after.nodes.len()-keywords.len(),"edges":after.edges.len(),"edgeTypes":edge_types,"isolatedKeywords":keywords.iter().filter(|n|!degree.contains_key(&n.id)).count(),"packedBytes":packed.len(),"noOpIdentical":true,"roundTrip":true,"changeCause":after.meta.change_cause,"topEvidence":ranked.iter().take(35).map(|n|serde_json::json!({"label":n.label,"status":n.status,"evidence":n.evidence.len()})).collect::<Vec<_>>(),"topicsPreview":after.nodes.iter().filter(|n|n.node_type=="topic").take(20).map(|n|&n.label).collect::<Vec<_>>() })).unwrap());
    Ok(())
}
