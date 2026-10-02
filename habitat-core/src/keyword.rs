//! Evidence-backed lexical projection. Equal normalized spellings identify a
//! keyword, never prove that scoped people or entities are the same entity.
use crate::{model::*, stable_id};
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

pub(crate) const MAX_KEYWORDS: usize = 1200;
const MAX_WINDOW_WORDS: usize = 8;
const MAX_WINDOW_LINES: usize = 12;
const DAMPING: f64 = 0.85;
const MIN_NPMI: f64 = 0.05;
type Graph = Vec<BTreeMap<usize, f64>>;

#[derive(Default)]
struct Word {
    spelling: String,
    originals: Vec<String>,
    labels: BTreeSet<String>,
    evidence: BTreeSet<String>,
    families: BTreeSet<String>,
    human: BTreeSet<String>,
    linked: BTreeSet<String>,
    native_unknown: BTreeSet<String>,
    native: bool,
    declared: bool,
    status: String,
    intent: Option<String>,
}
fn normalized(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn acceptable(value: &str) -> bool {
    let n = value.chars().count();
    if !(2..=64).contains(&n)
        || !value.chars().any(char::is_alphabetic)
        || value.chars().any(|c| {
            c.is_control() || matches!(c, '[' | ']' | '^' | '*' | '{' | '}' | '\\' | '\u{ad}')
        })
        || value.split_whitespace().count() > 8
        || value
            .chars()
            .filter(|c| matches!(c, '，' | '。' | '；' | '！' | '？' | ';' | '?' | '!'))
            .count()
            > 0
        || (n > 30
            && value
                .chars()
                .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)))
    {
        return false;
    }
    // Provenance and workflow tags recur in generated material, but do not
    // express an interest. This is a versioned stop list, not a topic allowlist.
    if value.chars().filter(char::is_ascii_digit).count() >= 2
        && [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
        ]
        .iter()
        .any(|m| value.starts_with(m))
    {
        return false;
    }
    if value.starts_with('@')
        || value.starts_with("api token:")
        || value.ends_with(':')
        || (value.len() == 6 && value.bytes().all(|c| c.is_ascii_hexdigit()))
        || [".ppt", ".pptx", ".jpg", ".png", ".pdf"]
            .iter()
            .any(|ext| value.ends_with(ext))
    {
        return false;
    }
    if value.contains("/nodes/") || value.contains("/assets/") || value.contains("://") {
        return false;
    }
    ![
        "回忆索引",
        "来源覆盖",
        "每日时间线",
        "原始归档",
        "时间线审计",
        "语义核对",
        "chatlog",
        "daily",
        "daily-note",
        "dailynote",
        "timeline",
        "日志",
        "待办",
        "todo",
        "untitled",
        "未命名",
        "source",
        "sources",
        "metadata",
        "embed",
        "image",
        "人物",
        "概念",
        "项目",
        "用户",
        "文件",
        "问题",
        "内容",
        "今天",
        "记录",
        "相关",
        "链接",
        "双链",
        "wikilink",
    ]
    .contains(&value)
        && !value.starts_with("spk_")
}
fn authority(status: &str) -> usize {
    match status {
        "user-confirmed" => 5,
        "observed" => 4,
        "anchor" => 3,
        "candidate" => 2,
        "imported" => 1,
        _ => 0,
    }
}
fn family<'a>(source: &'a Source) -> &'a str {
    if source.family.is_empty() {
        &source.id
    } else {
        &source.family
    }
}
fn count_families(
    edge: &mut Edge,
    evidence: &BTreeMap<&str, &Evidence>,
    sources: &BTreeMap<&str, &Source>,
) {
    let mut verified = BTreeSet::new();
    let mut provisional = BTreeSet::new();
    let mut unresolved = BTreeSet::new();
    for id in &edge.evidence {
        if let Some(s) = evidence
            .get(id.as_str())
            .and_then(|e| sources.get(e.source.as_str()))
        {
            match s.family_status.as_str() {
                "verified" => {
                    verified.insert(family(s));
                }
                "unresolved" => {
                    unresolved.insert(family(s));
                }
                _ => {
                    provisional.insert(family(s));
                }
            }
        }
    }
    edge.verified_families = verified.len();
    edge.provisional_families = provisional.difference(&verified).count();
    edge.unresolved_lineage = unresolved
        .iter()
        .filter(|f| !verified.contains(*f) && !provisional.contains(*f))
        .count();
}
fn edge_weight(edge: &Edge) -> f64 {
    if edge.status == "candidate" || edge.participants.len() != 2 {
        return 0.;
    }
    let authority = match edge.status.as_str() {
        "imported" => 0.25,
        "observed" | "user-confirmed" => 1.,
        _ => 0.,
    };
    authority
        * (1.
            + (edge.verified_families + edge.provisional_families + edge.unresolved_lineage).min(16)
                as f64)
            .ln()
}
fn page_rank(graph: &Graph, prior: &[f64]) -> Vec<f64> {
    if graph.is_empty() {
        return vec![];
    }
    let sum: f64 = prior.iter().sum();
    let teleport: Vec<_> = if sum > 0. {
        prior.iter().map(|x| x / sum).collect()
    } else {
        vec![1. / prior.len() as f64; prior.len()]
    };
    let degree: Vec<f64> = graph.iter().map(|r| r.values().sum()).collect();
    let mut rank = teleport.clone();
    for _ in 0..100 {
        let dangling: f64 = rank
            .iter()
            .zip(&degree)
            .filter(|(_, d)| **d <= 0.)
            .map(|(r, _)| r)
            .sum();
        let mut next: Vec<_> = teleport
            .iter()
            .map(|p| ((1. - DAMPING) + DAMPING * dangling) * p)
            .collect();
        for (i, neighbors) in graph.iter().enumerate() {
            if degree[i] > 0. {
                for (&j, &w) in neighbors {
                    next[j] += DAMPING * rank[i] * w / degree[i];
                }
            }
        }
        let delta: f64 = next.iter().zip(&rank).map(|(a, b)| (a - b).abs()).sum();
        rank = next;
        if delta < 1e-10 {
            break;
        }
    }
    rank
}

struct Window {
    words: BTreeSet<usize>,
    evidence: BTreeSet<String>,
    family: String,
}
struct Association {
    a: usize,
    b: usize,
    weight: f64,
    evidence: BTreeSet<String>,
}

/// Returns a sparse graph used only for ranking/community detection. Statistical
/// weights are not factual predicates and are not hidden in snapshot metadata.
pub(crate) fn project(vault: &str, mut data: Extraction) -> (Extraction, Graph) {
    data.nodes.sort_by(|a, b| a.id.cmp(&b.id));
    data.edges.sort_by(|a, b| a.id.cmp(&b.id));
    let evidence: BTreeMap<_, _> = data.evidence.iter().map(|e| (e.id.as_str(), e)).collect();
    let sources: BTreeMap<_, _> = data.sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut groups: BTreeMap<String, Word> = BTreeMap::new();
    for n in &data.nodes {
        if !matches!(
            n.node_type.as_str(),
            "concept" | "entity" | "project" | "keyword"
        ) {
            continue;
        }
        let norm = normalized(&n.label);
        if !acceptable(&norm) {
            continue;
        }
        let word = groups.entry(norm.clone()).or_insert_with(|| Word {
            spelling: norm,
            ..Default::default()
        });
        word.originals.push(n.id.clone());
        word.labels.insert(n.label.clone());
        // Aliases remain display/search aliases. They are not transitive entity
        // identity assertions and cannot merge unrelated scoped names.
        word.labels.extend(
            n.aliases
                .iter()
                .filter(|a| acceptable(&normalized(a)))
                .cloned(),
        );
        let native = n.status != "imported";
        word.native |= native;
        if authority(&n.status) > authority(&word.status) {
            word.status = n.status.clone();
        }
        if let Some(intent) = &n.intent_status {
            if intent != "imported_project_mention" {
                word.declared = true;
                if word
                    .intent
                    .as_ref()
                    .is_none_or(|old| old == "imported_project_mention" || intent < old)
                {
                    word.intent = Some(intent.clone());
                }
            } else if word.intent.is_none() {
                word.intent = Some(intent.clone());
            }
        }
        for id in &n.evidence {
            let Some(ev) = evidence.get(id.as_str()) else {
                continue;
            };
            let Some(source) = sources.get(ev.source.as_str()) else {
                continue;
            };
            let f = family(source).to_owned();
            word.evidence.insert(id.clone());
            word.families.insert(f.clone());
            if ev.authorship == "human" && ev.verification == "matched" && ev.role == "context" {
                word.human.insert(f.clone());
            }
            if native
                && ev.verification == "matched"
                && ev.role == "context"
                && matches!(ev.granularity.as_str(), "paragraph" | "outline_node")
            {
                word.linked.insert(f.clone());
            }
            if native
                && ev.verification == "matched"
                && matches!(ev.authorship.as_str(), "" | "unlabeled" | "human")
            {
                word.native_unknown.insert(f);
            }
        }
    }
    let words: Vec<_> = groups.into_values().collect();
    let lookup: BTreeMap<_, _> = words
        .iter()
        .enumerate()
        .flat_map(|(i, w)| w.originals.iter().map(move |id| (id.as_str(), i)))
        .collect();
    let mut graph: Graph = vec![BTreeMap::new(); words.len()];
    let mut mapped_edges: BTreeMap<String, (Edge, Vec<(usize, String)>)> = BTreeMap::new();
    for edge in &data.edges {
        // Co-mention assertions are recomputed below with repeated, bounded
        // windows. No clique is manufactured from a multi-party relation.
        if matches!(edge.edge_type.as_str(), "co_mentioned_in" | "co_occurs") {
            continue;
        }
        let Some(participants) = edge
            .participants
            .iter()
            .map(|p| {
                lookup
                    .get(p.node.as_str())
                    .copied()
                    .map(|i| (i, p.role.clone()))
            })
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        let distinct: BTreeSet<_> = participants.iter().map(|(i, _)| *i).collect();
        if distinct.len() < 2 {
            continue;
        }
        let mut participants = participants;
        participants.sort();
        participants.dedup();
        let key = format!(
            "{}:{}:{}",
            edge.edge_type,
            edge.status,
            serde_json::to_string(&participants).unwrap()
        );
        let (aggregate, _) = mapped_edges.entry(key).or_insert_with(|| {
            (
                Edge {
                    edge_type: edge.edge_type.clone(),
                    status: edge.status.clone(),
                    ..Default::default()
                },
                participants,
            )
        });
        aggregate.evidence.extend(edge.evidence.iter().cloned());
    }
    // Aggregate lexical assertions before measuring graph strength. Repeated
    // scoped records from one source family do not buy extra PageRank mass.
    for (edge, participants) in mapped_edges.values_mut() {
        edge.evidence.sort();
        edge.evidence.dedup();
        count_families(edge, &evidence, &sources);
        edge.participants = participants
            .iter()
            .map(|(i, role)| Participant {
                node: i.to_string(),
                role: role.clone(),
            })
            .collect();
        let weight = edge_weight(edge);
        if participants.len() == 2 && weight > 0. {
            let (a, b) = (participants[0].0, participants[1].0);
            if a != b {
                *graph[a].entry(b).or_default() += weight;
                *graph[b].entry(a).or_default() += weight;
            }
        }
    }
    let mut windows: BTreeMap<String, Window> = BTreeMap::new();
    for (i, word) in words.iter().enumerate() {
        for id in &word.evidence {
            let ev = evidence[id.as_str()];
            if ev.verification != "matched"
                || ev.role != "context"
                || !matches!(ev.granularity.as_str(), "paragraph" | "outline_node")
                || ev.locator.end.saturating_sub(ev.locator.start) + 1 > MAX_WINDOW_LINES
            {
                continue;
            }
            let Some(s) = sources.get(ev.source.as_str()) else {
                continue;
            };
            let f = family(s);
            let key = format!(
                "{}:{}:{}:{}",
                ev.source,
                ev.locator.start,
                ev.locator.end,
                ev.locator.outline_id.as_deref().unwrap_or("")
            );
            let unit = windows.entry(key).or_insert_with(|| Window {
                words: BTreeSet::new(),
                evidence: BTreeSet::new(),
                family: f.into(),
            });
            unit.words.insert(i);
            unit.evidence.insert(id.clone());
        }
    }
    // Repeated copies or moved paragraphs from the same source family with
    // the same lexical set count as one sample, even when their locators differ.
    // This conservative projection deliberately does not claim text identity.
    let mut samples: BTreeMap<(String, Vec<usize>), Window> = BTreeMap::new();
    for unit in windows
        .into_values()
        .filter(|u| !u.words.is_empty() && u.words.len() <= MAX_WINDOW_WORDS)
    {
        let key = (unit.family.clone(), unit.words.iter().copied().collect());
        let sample = samples.entry(key).or_insert_with(|| Window {
            words: unit.words.clone(),
            evidence: BTreeSet::new(),
            family: unit.family.clone(),
        });
        sample.evidence.extend(unit.evidence);
    }
    let total = samples.len() as f64;
    let mut marginals = vec![0usize; words.len()];
    let mut pairs: BTreeMap<(usize, usize), (usize, BTreeSet<String>, BTreeSet<String>)> =
        BTreeMap::new();
    for unit in samples.into_values() {
        let ids: Vec<_> = unit.words.iter().copied().collect();
        for &i in &ids {
            marginals[i] += 1;
        }
        for (at, &a) in ids.iter().enumerate() {
            for &b in &ids[at + 1..] {
                let pair = pairs.entry((a, b)).or_default();
                pair.0 += 1;
                pair.1.insert(unit.family.clone());
                pair.2.extend(unit.evidence.iter().cloned());
            }
        }
    }
    let mut associations = Vec::new();
    for ((a, b), (joint, families, ev)) in pairs {
        if families.len() < 2 || total <= 0. {
            continue;
        }
        let p = joint as f64 / total;
        // If every sampled window contains both terms they are not
        // discriminative; the mathematical 0/0 limit is not promoted to 1.
        if p >= 1. {
            continue;
        }
        let npmi =
            (p / ((marginals[a] as f64 / total) * (marginals[b] as f64 / total))).ln() / -p.ln();
        if npmi < MIN_NPMI {
            continue;
        }
        let weight = npmi * families.len() as f64 / (families.len() as f64 + 2.);
        *graph[a].entry(b).or_default() += weight;
        *graph[b].entry(a).or_default() += weight;
        associations.push(Association {
            a,
            b,
            weight,
            evidence: ev,
        });
    }
    let family_count = sources
        .values()
        .map(|s| family(s))
        .collect::<BTreeSet<_>>()
        .len()
        .max(1) as f64;
    let prior: Vec<_> = words
        .iter()
        .map(|w| {
            let idf = ((1. + family_count) / (1. + w.families.len() as f64)).ln() + 1.;
            let attention = 4. * (w.human.len() as f64).ln_1p()
                + 1.5 * (w.linked.len() as f64).ln_1p()
                + 0.3 * (w.native_unknown.len() as f64).ln_1p()
                + if w.declared { 2. } else { 0. };
            // Imported-only records get no teleport mass; they can only enter
            // through an explicit relation to an attended native keyword.
            idf * (1. + (w.families.len() as f64).ln_1p()) * attention
        })
        .collect();
    let ranks = page_rank(&graph, &prior);
    let sum = prior.iter().sum::<f64>().max(f64::EPSILON);
    let mut ranked: Vec<_> = (0..words.len())
        .filter(|&i| {
            let w = &words[i];
            prior[i] > 0.
                && (!w.human.is_empty()
                    || w.linked.len() >= 2
                    || w.declared
                    || w.native_unknown.len() >= 2 && !w.linked.is_empty())
                || !w.native && w.families.len() >= 2 && graph[i].keys().any(|&j| prior[j] > 0.)
        })
        .collect();
    ranked.sort_by(|&a, &b| {
        let score = |i: usize| 0.55 * prior[i] / sum + 0.45 * ranks[i];
        score(b)
            .total_cmp(&score(a))
            .then(words[a].spelling.cmp(&words[b].spelling))
    });
    let mut imported = 0;
    ranked.retain(|&i| {
        if !words[i].native {
            imported += 1;
            imported <= MAX_KEYWORDS / 10
        } else {
            true
        }
    });
    ranked.truncate(MAX_KEYWORDS);
    let selected: BTreeSet<_> = ranked.into_iter().collect();
    let mut output_nodes = Vec::new();
    let mut index = BTreeMap::new();
    for &i in &selected {
        let w = &words[i];
        let key = format!("keyword:{}", w.spelling);
        let id = stable_id("k", &format!("{vault}\0{key}"));
        // Prefer the canonical native spelling; aliases are not allowed to
        // replace the term with a different lexical item.
        let label = w
            .labels
            .iter()
            .filter(|s| normalized(s) == w.spelling)
            .min_by_key(|s| (s.to_lowercase() == **s, s.len(), *s))
            .cloned()
            .unwrap_or_else(|| w.spelling.clone());
        index.insert(i, output_nodes.len());
        output_nodes.push(Node {
            id,
            key,
            node_type: "keyword".into(),
            label: label.clone(),
            status: w.status.clone(),
            aliases: w.labels.iter().filter(|s| **s != label).cloned().collect(),
            evidence: w.evidence.iter().cloned().collect(),
            intent_status: w.intent.clone(),
        });
    }
    let mut output_edges: BTreeMap<String, Edge> = BTreeMap::new();
    for (old, participants) in mapped_edges.into_values() {
        if !participants.iter().all(|(i, _)| selected.contains(i)) {
            continue;
        }
        let mut ps: Vec<_> = participants
            .into_iter()
            .map(|(i, role)| Participant {
                node: output_nodes[index[&i]].id.clone(),
                role,
            })
            .collect();
        ps.sort_by(|a, b| (&a.role, &a.node).cmp(&(&b.role, &b.node)));
        ps.dedup_by(|a, b| a.role == b.role && a.node == b.node);
        let id = stable_id(
            "edge",
            &format!(
                "{}\0{}\0{}",
                old.edge_type,
                old.status,
                serde_json::to_string(&ps).unwrap()
            ),
        );
        let edge = output_edges.entry(id.clone()).or_insert_with(|| Edge {
            id,
            edge_type: old.edge_type.clone(),
            status: old.status.clone(),
            participants: ps,
            ..Default::default()
        });
        edge.evidence.extend(old.evidence.iter().cloned());
    }
    for assoc in associations {
        if !selected.contains(&assoc.a) || !selected.contains(&assoc.b) {
            continue;
        }
        let ps = vec![
            Participant {
                node: output_nodes[index[&assoc.a]].id.clone(),
                role: "term".into(),
            },
            Participant {
                node: output_nodes[index[&assoc.b]].id.clone(),
                role: "term".into(),
            },
        ];
        let id = stable_id(
            "edge",
            &format!(
                "co_occurs\0statistical\0{}",
                serde_json::to_string(&ps).unwrap()
            ),
        );
        output_edges.insert(
            id.clone(),
            Edge {
                id,
                edge_type: "co_occurs".into(),
                status: "statistical".into(),
                participants: ps,
                evidence: assoc.evidence.into_iter().collect(),
                ..Default::default()
            },
        );
        debug_assert!(assoc.weight > 0.);
    }
    for e in output_edges.values_mut() {
        e.evidence.sort();
        e.evidence.dedup();
        count_families(e, &evidence, &sources);
    }
    let mut output_graph = vec![BTreeMap::new(); output_nodes.len()];
    for (&original, &i) in &index {
        for (&neighbor, &w) in &graph[original] {
            if let Some(&j) = index.get(&neighbor) {
                output_graph[i].insert(j, w);
            }
        }
    }
    let used: BTreeSet<_> = output_nodes
        .iter()
        .flat_map(|n| n.evidence.iter())
        .chain(output_edges.values().flat_map(|e| e.evidence.iter()))
        .cloned()
        .collect();
    let kept_evidence: Vec<_> = data
        .evidence
        .into_iter()
        .filter(|e| used.contains(&e.id))
        .collect();
    let assigned: BTreeSet<_> = kept_evidence.iter().map(|e| e.source.as_str()).collect();
    let mut coverage = data.coverage;
    coverage.unassigned_sources = data
        .sources
        .iter()
        .filter(|s| s.role != "config" && !assigned.contains(s.id.as_str()))
        .count();
    (
        Extraction {
            sources: data.sources,
            nodes: output_nodes,
            evidence: kept_evidence,
            edges: output_edges.into_values().collect(),
            coverage,
            features: BTreeMap::new(),
        },
        output_graph,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lexical_relation_duplicates_from_one_family_do_not_increase_graph_weight() {
        let source = Source {
            id: "source".into(),
            family: "family".into(),
            family_status: "unresolved".into(),
            ..Default::default()
        };
        let ev = Evidence {
            id: "ev".into(),
            source: source.id.clone(),
            role: "context".into(),
            authorship: "human".into(),
            verification: "matched".into(),
            granularity: "paragraph".into(),
            locator: Locator {
                start: 1,
                end: 1,
                ..Default::default()
            },
        };
        let make_node = |id: &str, label: &str| Node {
            id: id.into(),
            key: id.into(),
            label: label.into(),
            node_type: "concept".into(),
            status: "anchor".into(),
            evidence: vec![ev.id.clone()],
            ..Default::default()
        };
        let edge = Edge {
            id: "original".into(),
            edge_type: "supports".into(),
            status: "observed".into(),
            participants: vec![
                Participant {
                    node: "a".into(),
                    role: "supporter".into(),
                },
                Participant {
                    node: "b".into(),
                    role: "supported".into(),
                },
            ],
            evidence: vec![ev.id.clone()],
            unresolved_lineage: 1,
            ..Default::default()
        };
        let data = Extraction {
            sources: vec![source],
            nodes: vec![make_node("a", "Alpha"), make_node("b", "Beta")],
            evidence: vec![ev.clone()],
            edges: vec![edge.clone()],
            ..Default::default()
        };
        let (_, before) = project("v", data.clone());
        let mut duplicate = data;
        let mut node = make_node("a-scoped-copy", "ALPHA");
        node.evidence.push("ev-copy".into());
        duplicate.nodes.push(node);
        let mut copied_ev = ev;
        copied_ev.id = "ev-copy".into();
        copied_ev.locator.start = 20;
        copied_ev.locator.end = 20;
        duplicate.evidence.push(copied_ev);
        let mut copy = edge;
        copy.id = "copy".into();
        copy.participants[0].node = "a-scoped-copy".into();
        copy.evidence = vec!["ev-copy".into()];
        copy.verified_families = 999;
        duplicate.edges.push(copy);
        let (snapshot, after) = project("v", duplicate);
        assert_eq!(before, after);
        let edge = snapshot
            .edges
            .iter()
            .find(|e| e.edge_type == "supports")
            .unwrap();
        assert_eq!(edge.unresolved_lineage, 1);
        assert_eq!(edge.verified_families, 0);
    }
}
