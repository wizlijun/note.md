//! Versioned keyword organization: local lexical projection, personalized
//! PageRank and the standard three-phase Leiden implementation.
use crate::{hash, model::*, stable_id};
use leiden_rs::{GraphDataBuilder, Leiden, LeidenConfig, QualityType};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const TOPIC_SPACING: f64 = 480.;
const NODE_SPACING: f64 = 40.;

pub fn algorithm() -> Algorithm {
    Algorithm {
        version: ALGORITHM_VERSION.into(),
        parser_version: "habitat-ast/2".into(),
        tokenizer_version: "nfkc-pos-cvalue/4".into(),
        effective_params: BTreeMap::from([
            ("termQualityScope".into(),serde_json::json!("focus-enabled-extraction; no-focus preserves legacy-declared projection")),
            ("termhood".into(),serde_json::json!("C-value=log2(tokenLength)*(deduplicatedEventFrequency-meanContainingTermFrequency); single-token independent context channel")),
            ("focusTermhoodWeight".into(),serde_json::json!("1+0.2*ln(1+max(C-value,0)); only multi-token terms")),
            ("phraseAdmission".into(),serde_json::json!("nominal tail; multi-token terms require >=2 contextual events or direct inquiry/definition; single-token separate channel")),
            ("emergingSupport".into(),serde_json::json!(">=2 distinct date+normalized-observation utterances, not session identifiers alone")),
            ("typing".into(),serde_json::json!("native-project-metadata+explicit-context-rules; no-trained-NER")),
            ("semanticRelations".into(),serde_json::json!("bounded-literal-predicate-patterns; asserted-source-claim; no-trained-OpenIE")),
            ("communityProjection".into(),serde_json::json!("keyword+project only; statistical edges weight 0.1")),
            ("eventDeduplication".into(),serde_json::json!("date+normalized-user-payload; exact-same-day copies collapse")),
            ("organization".into(), serde_json::json!("leiden-rs/0.8.1")),
            ("quality".into(), serde_json::json!("modularity")),
            ("seed".into(), serde_json::json!(42)),
            ("resolution".into(), serde_json::json!(1.0)),
            ("skipRefinement".into(), serde_json::json!(false)),
            ("maxIterations".into(), serde_json::json!(100)),
            ("keywordIdentity".into(), serde_json::json!("normalized-lexeme-not-entity/1")),
            ("maxBackgroundKeywords".into(), serde_json::json!(crate::keyword::MAX_KEYWORDS)),
            ("stopWords".into(), serde_json::json!("shared-surface-prose-and-context/2")),
            ("vocabularyBudget".into(),serde_json::json!("main terms before background, then rank; explicitly retained observed terms outside cap")),
            ("conceptEvidence".into(),serde_json::json!("local predicate arguments, coordinated research objects, applied practice; full-unit operations excluded; Jieba token boundaries")),
            ("backgroundRanking".into(), serde_json::json!("0.55*normalizedTFIDFPrior+0.45*personalizedPageRank")),
            ("focusMethod".into(), serde_json::json!("dated-personal-events-cvalue/2")),
            ("maxFocusConcepts".into(), serde_json::json!(crate::focus::MAX_CONCEPTS)),
            ("maxFocusContextKeywords".into(), serde_json::json!(crate::focus::MAX_CONTEXTS)),
            ("minFocusActiveDays".into(), serde_json::json!(crate::focus::MIN_ACTIVE_DAYS)),
            ("maxEmergingFocusConcepts".into(), serde_json::json!(crate::focus::MAX_EMERGING)),
            ("focusRetention".into(), serde_json::json!("shared-quality-gate-for-recent-history-retention/2")),
            ("focusRelations".into(), serde_json::json!("historical-clause-NPMI; co_discussed; min2-deduplicated-events; max8-terms; max160-chars/1")),
            ("prior".into(), serde_json::json!("(ln((1+sourceGroups)/(1+termSourceGroups))+1)*(1+ln(1+termSourceGroups))*(4ln(1+humanGroups)+1.5ln(1+linkedGroups)+0.3ln(1+unknownNativeGroups)+2*declaredProject)")),
            ("humanAttentionEvidence".into(), serde_json::json!("matched-explicit-personal-attention; legacy-no-focus-context")),
            ("termFrequency".into(), serde_json::json!("one-contribution-per-source-group")),
            ("pageRankDamping".into(), serde_json::json!(0.85)),
            ("pageRankTolerance".into(), serde_json::json!(1e-10)),
            ("importedOnlyLimit".into(), serde_json::json!(120)),
            ("association".into(), serde_json::json!("bounded-window-NPMI*sourceGroups/(sourceGroups+2)")),
            ("minAssociationSourceGroups".into(), serde_json::json!(2)),
            ("minNPMI".into(), serde_json::json!(0.05)),
            ("maxWindowTerms".into(), serde_json::json!(8)),
            ("maxWindowLines".into(), serde_json::json!(12)),
            ("windowDeduplication".into(), serde_json::json!("source-family+keyword-set/1")),
            ("explicitWeight".into(), serde_json::json!("authority*ln(1+min(16,deduplicatedSourceGroups)); observed/asserted=1, imported=0.25, candidate=0")),
            ("candidateGate".into(), serde_json::json!("humanContext>=1 OR linkedGroups>=2 OR declaredProject OR (unknownNativeGroups>=2 AND linkedGroups>=1); importedOnly requires >=2 groups and an attended explicit neighbor")),
            ("communityName".into(), serde_json::json!("top3 internalStrengthSquared/totalStrength")),
            ("primaryAssignment".into(), serde_json::json!("community")),
            ("topicIdentity".into(), serde_json::json!("birth-id/2")),
            ("layout".into(), serde_json::json!("membership-anchored-districts/3")),
            ("topicSpacing".into(), serde_json::json!(TOPIC_SPACING)),
            ("nodeSpacing".into(), serde_json::json!(NODE_SPACING)),
            ("secondaryThreshold".into(), serde_json::json!(0.2)),
            ("topicContinuation".into(), serde_json::json!(0.6)),
            ("topicContinuationMargin".into(), serde_json::json!(0.15)),
        ]),
    }
}

pub fn build(
    vault_id: &str,
    scope_hash: &str,
    data: Extraction,
    previous: Option<&Snapshot>,
) -> Result<Snapshot, String> {
    let (data, graph) = crate::keyword::project(vault_id, data);
    let mut snapshot = Snapshot {
        meta: Meta {
            vault_id: vault_id.into(),
            scope_hash: scope_hash.into(),
            algorithm: algorithm(),
            coverage: data.coverage,
            focus: data.focus,
            ..Default::default()
        },
        sources: data.sources,
        nodes: data.nodes,
        evidence: data.evidence,
        edges: data.edges,
        attention: data.attention,
        attention_observations: data.attention_observations,
        ..Default::default()
    };
    let candidates = snapshot.nodes.clone();
    let groups = communities(&graph)?;
    let mut clusters: Vec<Vec<usize>> =
        BTreeMap::<usize, Vec<usize>>::new().into_values().collect();
    let mut by_group: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (i, g) in groups.iter().enumerate() {
        by_group.entry(*g).or_default().push(i);
    }
    clusters.extend(by_group.into_values().filter(|items| items.len() >= 2));
    clusters.sort_by(|a, b| candidates[a[0]].id.cmp(&candidates[b[0]].id));
    let old_members: BTreeMap<String, BTreeSet<String>> = previous
        .map(|p| {
            let mut result: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            for m in &p.memberships {
                if m.role == "primary" {
                    result
                        .entry(m.topic.clone())
                        .or_default()
                        .insert(m.node.clone());
                }
            }
            result
        })
        .unwrap_or_default();
    let mut choices = vec![];
    for (i, members) in clusters.iter().enumerate() {
        let ids: BTreeSet<_> = members.iter().map(|j| candidates[*j].id.clone()).collect();
        let mut ranked: Vec<_> = old_members
            .iter()
            .map(|(id, old)| {
                let common = ids.intersection(old).count();
                (
                    id.clone(),
                    common as f64 / (ids.len() + old.len() - common).max(1) as f64,
                )
            })
            .filter(|(_, s)| *s > 0.)
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        if let Some((id, score)) = ranked.first() {
            if *score >= 0.6 && *score - ranked.get(1).map(|v| v.1).unwrap_or(0.) >= 0.15 {
                choices.push((i, id.clone(), *score));
            }
        }
    }
    choices.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.1.cmp(&b.1)).then(a.0.cmp(&b.0)));
    let mut matched = BTreeMap::new();
    let mut used = HashSet::new();
    for (i, id, _) in choices {
        if used.insert(id.clone()) {
            matched.insert(i, id);
        }
    }
    let prior_nodes: HashMap<_, _> = previous
        .map(|s| s.nodes.iter().map(|n| (&n.id, n)).collect())
        .unwrap_or_default();
    let mut topic_for_node = HashMap::new();
    for (i, members) in clusters.iter().enumerate() {
        let member_ids: Vec<_> = members.iter().map(|j| candidates[*j].id.as_str()).collect();
        let key = format!("topic:{}", hash(member_ids.join("\0")));
        let mut representative = members.clone();
        let member_set: BTreeSet<_> = members.iter().copied().collect();
        let distinctiveness = |i: usize| {
            let internal: f64 = graph[i]
                .iter()
                .filter(|(j, _)| member_set.contains(j))
                .map(|(_, w)| w)
                .sum();
            internal * internal / degree(&graph[i]).max(f64::EPSILON)
        };
        representative.sort_by(|a, b| {
            distinctiveness(*b)
                .total_cmp(&distinctiveness(*a))
                .then(candidates[*a].label.len().cmp(&candidates[*b].label.len()))
                .then(candidates[*a].id.cmp(&candidates[*b].id))
        });
        let chosen = &candidates[representative[0]];
        let name = representative
            .iter()
            .take(3)
            .map(|j| candidates[*j].label.as_str())
            .collect::<Vec<_>>()
            .join(" · ");
        let id = matched.get(&i).cloned().unwrap_or_else(|| {
            stable_id(
                "t",
                &format!(
                    "{vault_id}\0{}\0{key}",
                    previous
                        .map(|p| p.meta.snapshot_id.as_str())
                        .unwrap_or("genesis")
                ),
            )
        });
        let old = prior_nodes.get(&id);
        let topic = Node {
            id: id.clone(),
            key: old
                .map(|n| n.key.clone())
                .unwrap_or_else(|| format!("topic:{id}")),
            node_type: "topic".into(),
            label: old
                .filter(|n| n.status == "user-confirmed")
                .map(|n| n.label.clone())
                .unwrap_or(name),
            status: old
                .map(|n| n.status.clone())
                .unwrap_or_else(|| "candidate".into()),
            evidence: chosen.evidence.clone(),
            ..Default::default()
        };
        for j in members {
            topic_for_node.insert(*j, id.clone());
        }
        snapshot.nodes.push(topic);
        if !matched.contains_key(&i) {
            let new_set: BTreeSet<_> = member_ids.iter().map(|s| s.to_string()).collect();
            let overlapping: Vec<_> = old_members
                .iter()
                .filter(|(_, old)| new_set.intersection(old).count() >= 2)
                .map(|(old, _)| old.clone())
                .collect();
            if !overlapping.is_empty() {
                snapshot.lineage.push(Lineage {
                    id: stable_id("l", &id),
                    change: "regrouped".into(),
                    from: overlapping,
                    to: vec![id],
                    status: "candidate".into(),
                });
            }
        }
    }
    // Keep existing lineage for surviving targets: a no-op must not erase the
    // previous regrouping just because this run matched its resulting topic.
    if let Some(old) = previous {
        for l in &old.lineage {
            if l.to
                .iter()
                .all(|id| snapshot.nodes.iter().any(|n| &n.id == id))
                && !snapshot.lineage.iter().any(|x| x.id == l.id)
            {
                snapshot.lineage.push(l.clone());
            }
        }
    }
    for (i, node) in candidates.iter().enumerate() {
        let mut scores: BTreeMap<String, f64> = BTreeMap::new();
        for (&j, &w) in &graph[i] {
            if let Some(topic) = topic_for_node.get(&j) {
                *scores.entry(topic.clone()).or_default() += w;
            }
        }
        let total: f64 = scores.values().sum();
        if total <= 0. {
            continue;
        }
        let mut scores: Vec<_> = scores.into_iter().map(|(id, w)| (id, w / total)).collect();
        scores.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        let best = scores.first().map(|s| s.1).unwrap_or(0.);
        for (topic, score) in scores {
            let primary = topic_for_node.get(&i) == Some(&topic);
            if primary || score >= 0.2 && score >= best * 0.5 {
                snapshot.memberships.push(Membership {
                    id: stable_id("m", &format!("{}\0{topic}", node.id)),
                    node: node.id.clone(),
                    topic,
                    role: if primary { "primary" } else { "secondary" }.into(),
                    score,
                });
            }
        }
    }
    positions(&mut snapshot, previous);
    crate::finalize(&mut snapshot, previous)?;
    Ok(snapshot)
}

fn degree(row: &BTreeMap<usize, f64>) -> f64 {
    row.values().sum()
}
fn communities(graph: &[BTreeMap<usize, f64>]) -> Result<Vec<usize>, String> {
    if graph.is_empty() {
        return Ok(Vec::new());
    }
    if graph.iter().all(BTreeMap::is_empty) {
        return Ok((0..graph.len()).collect());
    }
    let mut builder = GraphDataBuilder::new(graph.len());
    for (i, neighbors) in graph.iter().enumerate() {
        for (&j, &weight) in neighbors {
            if i < j && weight.is_finite() && weight > 0. {
                builder.add_edge(i, j, weight).map_err(|e| e.to_string())?;
            }
        }
    }
    let data = builder.build().map_err(|e| e.to_string())?;
    let result = Leiden::new(LeidenConfig {
        seed: Some(42),
        resolution: 1.0,
        quality: QualityType::Modularity,
        skip_refinement: false,
        ..Default::default()
    })
    .run(&data)
    .map_err(|e| format!("Leiden 社区检测失败: {e}"))?;
    Ok(result.partition.as_slice().to_vec())
}

// Integer square spiral: new districts expand in all directions, with no
// dependence on the number of topics already present in a snapshot.
fn spiral(index: usize) -> (f64, f64) {
    if index == 0 {
        return (0., 0.);
    }
    let ring = (((index as f64).sqrt() + 1.) / 2.).floor() as i64;
    let side = 2 * ring;
    let offset = index as i64 - (side - 1) * (side - 1);
    let (x, y) = if offset < side {
        (ring, 1 - ring + offset)
    } else if offset < 2 * side {
        (ring - 1 - (offset - side), ring)
    } else if offset < 3 * side {
        (-ring, ring - 1 - (offset - 2 * side))
    } else {
        (1 - ring + (offset - 3 * side), -ring)
    };
    (x as f64, y as f64)
}

// Spatial buckets make collision checks local even for large Vaults. Legacy
// or pinned coordinates need not be on the new grid; they still reserve space.
struct Occupied {
    gap: f64,
    cells: HashMap<(i64, i64), Vec<(f64, f64)>>,
}
impl Occupied {
    fn new(gap: f64) -> Self {
        Self {
            gap,
            cells: HashMap::new(),
        }
    }
    fn cell(&self, x: f64, y: f64) -> (i64, i64) {
        ((x / self.gap).floor() as i64, (y / self.gap).floor() as i64)
    }
    fn insert(&mut self, x: f64, y: f64) {
        self.cells.entry(self.cell(x, y)).or_default().push((x, y));
    }
    fn vacant(&self, x: f64, y: f64) -> bool {
        let (cx, cy) = self.cell(x, y);
        (-1..=1).all(|dx| {
            (-1..=1).all(|dy| {
                self.cells
                    .get(&(cx.saturating_add(dx), cy.saturating_add(dy)))
                    .is_none_or(|points| {
                        points.iter().all(|&(px, py)| {
                            (x - px).abs() + 1e-6 >= self.gap || (y - py).abs() + 1e-6 >= self.gap
                        })
                    })
            })
        })
    }
}

fn positions(snapshot: &mut Snapshot, previous: Option<&Snapshot>) {
    // A method migration must not freeze the old spatial buckets as semantic
    // communities. Within the new algorithm unchanged memberships stay put.
    let previous = previous.filter(|p| p.meta.algorithm.version == ALGORITHM_VERSION);
    let old: HashMap<_, _> = previous
        .map(|s| s.layout.iter().map(|p| (&p.id, p)).collect())
        .unwrap_or_default();
    let primary: HashMap<_, _> = snapshot
        .memberships
        .iter()
        .filter(|m| m.role == "primary")
        .map(|m| (&m.node, &m.topic))
        .collect();
    let old_primary: HashMap<_, _> = previous
        .map(|s| {
            s.memberships
                .iter()
                .filter(|m| m.role == "primary")
                .map(|m| (&m.node, &m.topic))
                .collect()
        })
        .unwrap_or_default();
    let mut topics: Vec<_> = snapshot
        .nodes
        .iter()
        .filter(|n| n.node_type == "topic")
        .collect();
    topics.sort_by(|a, b| a.id.cmp(&b.id));
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for topic in primary.values() {
        *counts.entry(topic.as_str()).or_default() += 1;
    }
    let radius = |id: &str| {
        ((counts.get(id).copied().unwrap_or(0) as f64).sqrt().ceil() * NODE_SPACING).max(120.)
    };
    let mut centers: HashMap<String, (f64, f64)> = HashMap::new();
    let mut reserved: Vec<(f64, f64, f64)> = Vec::new();
    let mut occupied = Occupied::new(NODE_SPACING);
    // Reserve all surviving district centers before placing any new ones.
    for topic in &topics {
        if let Some(p) = old.get(&topic.id) {
            centers.insert(topic.id.clone(), (p.x, p.y));
            reserved.push((p.x, p.y, radius(&topic.id)));
            occupied.insert(p.x, p.y);
        }
    }
    let mut next = 0;
    for topic in &topics {
        if centers.contains_key(&topic.id) {
            continue;
        }
        loop {
            let (sx, sy) = spiral(next);
            next += 1;
            let (x, y) = (sx * TOPIC_SPACING, sy * TOPIC_SPACING);
            let r = radius(&topic.id);
            if reserved
                .iter()
                .all(|&(px, py, pr)| (x - px).hypot(y - py) >= r + pr + 120.)
            {
                centers.insert(topic.id.clone(), (x, y));
                reserved.push((x, y, r));
                occupied.insert(x, y);
                break;
            }
        }
    }
    let mut retained = HashSet::new();
    for n in &snapshot.nodes {
        if n.node_type == "topic" {
            continue;
        }
        if let Some(p) = old
            .get(&n.id)
            .filter(|p| p.pinned || primary.get(&n.id) == old_primary.get(&n.id))
        {
            occupied.insert(p.x, p.y);
            snapshot.layout.push((*p).clone());
            retained.insert(n.id.clone());
        }
    }
    let unassigned_count = snapshot
        .nodes
        .iter()
        .filter(|n| n.node_type != "topic" && !primary.contains_key(&n.id))
        .count();
    let unassigned_radius = (unassigned_count as f64).sqrt().ceil() * NODE_SPACING;
    let unassigned_center = loop {
        let (sx, sy) = spiral(next);
        next += 1;
        let (x, y) = (sx * TOPIC_SPACING, sy * TOPIC_SPACING);
        if reserved
            .iter()
            .all(|&(px, py, r)| (x - px).hypot(y - py) >= unassigned_radius + r + 120.)
        {
            break (x, y);
        }
    };
    let mut index: BTreeMap<String, usize> = BTreeMap::new();
    let mut nodes: Vec<_> = snapshot.nodes.iter().collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    for node in nodes {
        if retained.contains(&node.id) {
            continue;
        }
        if let Some(&(x, y)) = centers.get(&node.id) {
            snapshot.layout.push(Layout {
                id: node.id.clone(),
                x,
                y,
                zone: "topic".into(),
                pinned: false,
            });
            continue;
        }
        let topic = primary.get(&node.id).copied();
        let key = topic.cloned().unwrap_or_else(|| "unassigned".into());
        let (cx, cy) = centers.get(&key).copied().unwrap_or(unassigned_center);
        let i = index.entry(key).or_insert(1);
        let (x, y) = loop {
            let (x, y) = spiral(*i);
            *i += 1;
            let (x, y) = (cx + x * NODE_SPACING, cy + y * NODE_SPACING);
            if occupied.vacant(x, y) {
                occupied.insert(x, y);
                break (x, y);
            }
        };
        snapshot.layout.push(Layout {
            id: node.id.clone(),
            x,
            y,
            zone: if topic.is_some() {
                "knowledge"
            } else {
                "unassigned"
            }
            .into(),
            pinned: false,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_edges_do_not_fabricate_communities() {
        assert_eq!(
            communities(&vec![BTreeMap::new(); 3]).unwrap(),
            vec![0, 1, 2]
        );
    }
    #[test]
    fn leiden_three_phases_are_deterministic_and_split_disconnected_groups() {
        let mut graph = vec![BTreeMap::new(); 6];
        for group in [[0, 1, 2], [3, 4, 5]] {
            for &a in &group {
                for &b in &group {
                    if a != b {
                        graph[a].insert(b, 1.);
                    }
                }
            }
        }
        let a = communities(&graph).unwrap();
        let b = communities(&graph).unwrap();
        assert_eq!(a, b);
        assert_eq!(a[0], a[1]);
        assert_eq!(a[3], a[4]);
        assert_ne!(a[0], a[3]);
    }
}
