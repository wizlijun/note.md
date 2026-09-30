//! Deterministic, bounded local organization. Affinity is not a factual edge.
//! The initial local-moving/refinement heuristic is explicitly versioned; it
//! is not advertised as a complete Leiden implementation or a semantic oracle.
use crate::{hash, model::*, stable_id};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

const TOP_K: usize = 12;
const CANDIDATES: usize = 256;
const MAX_TERMS: usize = 32;
const TOPIC_SPACING: f64 = 34.;
const NODE_SPACING: f64 = 3.;

pub fn algorithm() -> Algorithm {
    Algorithm {
        version: ALGORITHM_VERSION.into(),
        parser_version: "habitat-ast/1".into(),
        tokenizer_version: "jieba-rs-0.10+nfkc/1".into(),
        effective_params: BTreeMap::from([
            (
                "organization".into(),
                serde_json::json!("connected-local-moving/1"),
            ),
            ("primaryAssignment".into(), serde_json::json!("community")),
            ("topicIdentity".into(), serde_json::json!("birth-id/2")),
            (
                "layout".into(),
                serde_json::json!("anchored-square-spiral/2"),
            ),
            ("topicSpacing".into(), serde_json::json!(TOPIC_SPACING)),
            ("nodeSpacing".into(), serde_json::json!(NODE_SPACING)),
            ("maxTerms".into(), serde_json::json!(MAX_TERMS)),
            ("maxCandidates".into(), serde_json::json!(CANDIDATES)),
            ("maxNeighbors".into(), serde_json::json!(TOP_K)),
            ("cosineThreshold".into(), serde_json::json!(0.25)),
            ("resolution".into(), serde_json::json!(1.0)),
            ("secondaryThreshold".into(), serde_json::json!(0.2)),
            ("topicContinuation".into(), serde_json::json!(0.6)),
            ("topicContinuationMargin".into(), serde_json::json!(0.15)),
        ]),
    }
}

pub fn build(
    vault_id: &str,
    scope_hash: &str,
    mut data: Extraction,
    previous: Option<&Snapshot>,
) -> Result<Snapshot, String> {
    data.nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let mut snapshot = Snapshot {
        meta: Meta {
            vault_id: vault_id.into(),
            scope_hash: scope_hash.into(),
            algorithm: algorithm(),
            coverage: data.coverage,
            ..Default::default()
        },
        sources: data.sources,
        nodes: data.nodes,
        evidence: data.evidence,
        edges: data.edges,
        ..Default::default()
    };
    let candidates: Vec<_> = snapshot
        .nodes
        .iter()
        .filter(|n| matches!(n.node_type.as_str(), "concept" | "entity" | "project"))
        .cloned()
        .collect();
    let graph = affinity(
        &candidates,
        &data.features,
        &snapshot.edges,
        &snapshot.sources,
        &snapshot.evidence,
    );
    let groups = communities(&graph);
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
        representative.sort_by(|a, b| {
            degree(&graph[*b])
                .total_cmp(&degree(&graph[*a]))
                .then(candidates[*a].label.len().cmp(&candidates[*b].label.len()))
                .then(candidates[*a].id.cmp(&candidates[*b].id))
        });
        let chosen = &candidates[representative[0]];
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
                .unwrap_or_else(|| chosen.label.clone()),
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
fn terms(text: &str, jieba: &jieba_rs::Jieba) -> Vec<String> {
    let norm: String = text.nfkc().collect::<String>().to_lowercase();
    jieba
        .cut(&norm, false)
        .into_iter()
        .map(|t| t.word)
        .filter(|t| t.chars().count() >= 2 && t.chars().any(char::is_alphabetic))
        .map(str::to_string)
        .collect()
}
fn affinity(
    nodes: &[Node],
    features: &BTreeMap<String, Vec<String>>,
    edges: &[Edge],
    sources: &[Source],
    evidence: &[Evidence],
) -> Vec<BTreeMap<usize, f64>> {
    let jieba = jieba_rs::Jieba::new();
    let source_family: HashMap<_, _> = sources
        .iter()
        .map(|s| (s.id.as_str(), s.family.as_str()))
        .collect();
    let evidence_family: HashMap<_, _> = evidence
        .iter()
        .filter_map(|e| {
            source_family
                .get(e.source.as_str())
                .map(|f| (e.id.as_str(), *f))
        })
        .collect();
    let mut counts = vec![];
    let mut term_families: HashMap<String, HashSet<String>> = HashMap::new();
    let mut all_families = HashSet::new();
    for node in nodes {
        let mut count: HashMap<String, f64> = HashMap::new();
        for term in terms(&node.label, &jieba) {
            *count.entry(term).or_default() += 3.;
        }
        for term in features.get(&node.id).into_iter().flatten().take(128) {
            for t in terms(term, &jieba) {
                *count.entry(t).or_default() += 1.;
            }
        }
        let mut families: HashSet<String> = node
            .evidence
            .iter()
            .filter_map(|id| evidence_family.get(id.as_str()).map(|s| s.to_string()))
            .collect();
        if families.is_empty() {
            families.insert(format!("anchor:{}", node.id));
        }
        all_families.extend(families.iter().cloned());
        for term in count.keys() {
            term_families
                .entry(term.clone())
                .or_default()
                .extend(families.iter().cloned());
        }
        counts.push(count);
    }
    let family_count = all_families.len();
    let df: HashMap<String, usize> = term_families
        .into_iter()
        .map(|(term, families)| (term, families.len()))
        .collect();
    let max_df = (family_count as f64 * 0.4).ceil().max(8.) as usize;
    let mut vectors: Vec<BTreeMap<String, f64>> = vec![];
    let mut posting: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, count) in counts.into_iter().enumerate() {
        let mut weights: Vec<_> = count
            .into_iter()
            .filter(|(t, _)| df[t] <= max_df)
            .map(|(t, tf)| {
                let idf = ((1 + family_count) as f64 / (1 + df[&t]) as f64).ln() + 1.;
                (t, tf.ln_1p() * idf)
            })
            .collect();
        weights.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        weights.truncate(MAX_TERMS);
        let length = weights
            .iter()
            .map(|(_, w)| w * w)
            .sum::<f64>()
            .sqrt()
            .max(f64::EPSILON);
        let vector: BTreeMap<_, _> = weights.into_iter().map(|(t, w)| (t, w / length)).collect();
        for t in vector.keys() {
            posting.entry(t.clone()).or_default().push(i);
        }
        vectors.push(vector);
    }
    let mut nearest = vec![BTreeMap::new(); nodes.len()];
    for (i, vector) in vectors.iter().enumerate() {
        let mut rare: Vec<_> = vector.keys().collect();
        rare.sort_by_key(|t| (df[*t], *t));
        let mut candidates = BTreeSet::new();
        for t in rare.into_iter().take(16) {
            for &j in posting[t].iter().take(128) {
                if j != i {
                    candidates.insert(j);
                }
                if candidates.len() >= CANDIDATES {
                    break;
                }
            }
            if candidates.len() >= CANDIDATES {
                break;
            }
        }
        let mut ranked: Vec<_> = candidates
            .into_iter()
            .map(|j| {
                let score = vector
                    .iter()
                    .map(|(t, w)| w * vectors[j].get(t).copied().unwrap_or(0.))
                    .sum::<f64>();
                (j, score)
            })
            .filter(|(_, s)| *s >= 0.25)
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        ranked.truncate(TOP_K);
        nearest[i] = ranked.into_iter().collect();
    }
    let mut graph = vec![BTreeMap::new(); nodes.len()];
    for i in 0..nodes.len() {
        for (&j, &w) in &nearest[i] {
            if nearest[j].contains_key(&i) {
                graph[i].insert(j, w);
                graph[j].insert(i, w);
            }
        }
    }
    let lookup: HashMap<_, _> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.as_str(), i))
        .collect();
    // Explicit binary links provide an organization hint. Multi-party records
    // remain hyperedges in the snapshot and are never expanded to a clique.
    for edge in edges {
        if edge.participants.len() != 2 {
            continue;
        }
        if let (Some(&a), Some(&b)) = (
            lookup.get(edge.participants[0].node.as_str()),
            lookup.get(edge.participants[1].node.as_str()),
        ) {
            if a != b {
                let w = if edge.edge_type == "co_mentioned_in" {
                    0.35
                } else {
                    0.5
                };
                graph[a].entry(b).and_modify(|v| *v = v.max(w)).or_insert(w);
                graph[b].entry(a).and_modify(|v| *v = v.max(w)).or_insert(w);
            }
        }
    }
    graph
}

fn communities(graph: &[BTreeMap<usize, f64>]) -> Vec<usize> {
    let n = graph.len();
    let mut labels: Vec<_> = (0..n).collect();
    let degrees: Vec<_> = graph.iter().map(degree).collect();
    let m: f64 = degrees.iter().sum();
    if m <= 0. {
        return labels;
    }
    let mut totals = degrees.clone();
    for _ in 0..16 {
        let mut changed = false;
        for i in 0..n {
            let old = labels[i];
            totals[old] -= degrees[i];
            let mut weights: BTreeMap<usize, f64> = BTreeMap::new();
            for (&j, &w) in &graph[i] {
                *weights.entry(labels[j]).or_default() += w;
            }
            let score =
                |c: usize| weights.get(&c).copied().unwrap_or(0.) - degrees[i] * totals[c] / m;
            let mut best = old;
            let mut gain = score(old);
            for &c in weights.keys() {
                let s = score(c);
                if s > gain + 1e-9 {
                    best = c;
                    gain = s;
                }
            }
            labels[i] = best;
            totals[best] += degrees[i];
            changed |= best != old;
        }
        if !changed {
            break;
        }
    }
    // Split disconnected portions of a local-moving community.
    let mut result = vec![usize::MAX; n];
    for i in 0..n {
        if result[i] != usize::MAX {
            continue;
        }
        let mut pending = vec![i];
        result[i] = i;
        while let Some(j) = pending.pop() {
            for &k in graph[j].keys() {
                if labels[k] == labels[i] && result[k] == usize::MAX {
                    result[k] = i;
                    pending.push(k);
                }
            }
        }
    }
    result
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
    let old: HashMap<_, _> = previous
        .map(|s| s.layout.iter().map(|p| (&p.id, p)).collect())
        .unwrap_or_default();
    let primary: HashMap<_, _> = snapshot
        .memberships
        .iter()
        .filter(|m| m.role == "primary")
        .map(|m| (&m.node, &m.topic))
        .collect();
    let mut topics: Vec<_> = snapshot
        .nodes
        .iter()
        .filter(|n| n.node_type == "topic")
        .collect();
    topics.sort_by(|a, b| a.id.cmp(&b.id));
    let mut centers: HashMap<String, (f64, f64)> = HashMap::new();
    let mut districts = Occupied::new(TOPIC_SPACING);
    let mut occupied = Occupied::new(NODE_SPACING);
    // Even a just-retired landmark remains reserved during this transition;
    // a new district must not appear on top of its surviving former members.
    for p in old.values() {
        occupied.insert(p.x, p.y);
        if p.zone == "topic" {
            districts.insert(p.x, p.y);
        }
    }
    let mut next = 0;
    for topic in topics {
        let (x, y) = if let Some(p) = old.get(&topic.id) {
            (p.x, p.y)
        } else {
            loop {
                let (x, y) = spiral(next);
                next += 1;
                let (x, y) = (x * TOPIC_SPACING, y * TOPIC_SPACING);
                if districts.vacant(x, y) && occupied.vacant(x, y) {
                    districts.insert(x, y);
                    occupied.insert(x, y);
                    break (x, y);
                }
            }
        };
        centers.insert(topic.id.clone(), (x, y));
    }
    let mut index: BTreeMap<String, usize> = BTreeMap::new();
    let mut sorted: Vec<_> = snapshot.nodes.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    for node in sorted {
        if let Some(p) = old.get(&node.id) {
            snapshot.layout.push((*p).clone());
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
        let next = index.entry(key.clone()).or_insert(1);
        let (cx, cy) = centers.get(&key).copied().unwrap_or((-50., 0.));
        let (x, y) = loop {
            let (x, y) = spiral(*next);
            *next += 1;
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
            zone: if node.node_type == "project" {
                "project"
            } else if topic.is_some() {
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
    fn data() -> Extraction {
        Extraction {
            nodes: vec![
                Node {
                    id: "a".into(),
                    key: "a".into(),
                    node_type: "concept".into(),
                    label: "检索记忆".into(),
                    status: "candidate".into(),
                    ..Default::default()
                },
                Node {
                    id: "b".into(),
                    key: "b".into(),
                    node_type: "concept".into(),
                    label: "检索记忆系统".into(),
                    status: "candidate".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }
    #[test]
    fn repeat_is_identical_and_preserves_coordinates() {
        let a = build("v", &hash("scope"), data(), None).unwrap();
        let b = build("v", &hash("scope"), data(), Some(&a)).unwrap();
        assert_eq!(a, b);
    }
    #[test]
    fn zero_graph_has_no_fabricated_groups() {
        assert_eq!(communities(&vec![BTreeMap::new(); 3]), vec![0, 1, 2]);
    }
    fn linked_groups(groups: &[Vec<&str>]) -> Extraction {
        let mut data = Extraction::default();
        for group in groups {
            for &id in group {
                data.nodes.push(Node {
                    id: id.into(),
                    key: id.into(),
                    node_type: "concept".into(),
                    label: id.into(),
                    status: "candidate".into(),
                    ..Default::default()
                });
            }
            for i in 0..group.len() {
                for j in i + 1..group.len() {
                    data.edges.push(Edge {
                        id: format!("{}-{}", group[i], group[j]),
                        edge_type: "explicit".into(),
                        status: "candidate".into(),
                        participants: vec![
                            Participant {
                                node: group[i].into(),
                                role: "a".into(),
                            },
                            Participant {
                                node: group[j].into(),
                                role: "b".into(),
                            },
                        ],
                        ..Default::default()
                    });
                }
            }
        }
        data
    }
    #[test]
    fn growing_then_splitting_a_topic_never_reuses_a_survivors_matching_key() {
        let mut previous = None;
        for members in [
            vec!["a", "b"],
            vec!["a", "b", "c"],
            vec!["a", "b", "c", "d", "e"],
            vec!["a", "b", "c", "d", "e", "f"],
        ] {
            previous = Some(
                build(
                    "v",
                    &hash("scope"),
                    linked_groups(&[members]),
                    previous.as_ref(),
                )
                .unwrap(),
            );
        }
        let before = previous.unwrap();
        let original = before
            .nodes
            .iter()
            .find(|n| n.node_type == "topic")
            .unwrap();
        let groups = [vec!["a", "b"], vec!["c", "d", "e", "f"]];
        let after = build("v", &hash("scope"), linked_groups(&groups), Some(&before)).unwrap();
        let topics: Vec<_> = after
            .nodes
            .iter()
            .filter(|n| n.node_type == "topic")
            .collect();
        assert_eq!(topics.len(), 2);
        assert!(topics
            .iter()
            .any(|n| n.id == original.id && n.key == original.key));
        assert_ne!(topics[0].key, topics[1].key);
        assert_eq!(
            after,
            build("v", &hash("scope"), linked_groups(&groups), Some(&after)).unwrap()
        );
        for old in &before.layout {
            if let Some(now) = after.layout.iter().find(|p| p.id == old.id) {
                assert_eq!(old, now);
            }
        }
    }
    #[test]
    fn incremental_members_keep_old_coordinates_and_find_empty_space() {
        let first = build("v", &hash("scope"), linked_groups(&[vec!["a", "b"]]), None).unwrap();
        let second = build(
            "v",
            &hash("scope"),
            linked_groups(&[vec!["a", "b", "c"]]),
            Some(&first),
        )
        .unwrap();
        for p in &first.layout {
            assert_eq!(second.layout.iter().find(|q| q.id == p.id), Some(p));
        }
        let added = second.layout.iter().find(|p| p.id == "c").unwrap();
        assert!(first
            .layout
            .iter()
            .all(|p| (p.x - added.x).abs() + 1e-6 >= NODE_SPACING
                || (p.y - added.y).abs() + 1e-6 >= NODE_SPACING));
        assert_eq!(
            second
                .memberships
                .iter()
                .filter(|m| m.node == "c" && m.role == "primary")
                .count(),
            1
        );
        assert_eq!(
            second.meta.algorithm.effective_params["primaryAssignment"],
            "community"
        );
    }
    #[test]
    fn new_districts_expand_outward_and_preserve_legacy_and_pinned_space() {
        let mut first = Snapshot::default();
        first.nodes = (0..25)
            .map(|i| Node {
                id: format!("t{i:02}"),
                node_type: "topic".into(),
                ..Default::default()
            })
            .collect();
        positions(&mut first, None);
        let coordinates: HashSet<_> = first
            .layout
            .iter()
            .map(|p| (p.x as i64, p.y as i64))
            .collect();
        assert_eq!(coordinates.len(), 25);
        assert_eq!(coordinates.iter().map(|p| p.0).min(), Some(-68));
        assert_eq!(coordinates.iter().map(|p| p.0).max(), Some(68));
        assert_eq!(coordinates.iter().map(|p| p.1).min(), Some(-68));
        assert_eq!(coordinates.iter().map(|p| p.1).max(), Some(68));
        // A legacy off-grid pin blocks its neighborhood, not just an exact key.
        first.layout[0].x = 0.5;
        first.layout[0].y = 0.5;
        first.layout[0].pinned = true;
        let mut next = Snapshot {
            nodes: first.nodes.clone(),
            ..Default::default()
        };
        next.nodes.push(Node {
            id: "t-new".into(),
            node_type: "topic".into(),
            ..Default::default()
        });
        positions(&mut next, Some(&first));
        for p in &first.layout {
            assert_eq!(next.layout.iter().find(|q| q.id == p.id), Some(p));
        }
        let added = next.layout.iter().find(|p| p.id == "t-new").unwrap();
        assert!(first
            .layout
            .iter()
            .all(|p| (p.x - added.x).abs() + 1e-6 >= TOPIC_SPACING
                || (p.y - added.y).abs() + 1e-6 >= TOPIC_SPACING));
    }
}
