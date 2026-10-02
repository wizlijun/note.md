use habitat_core::{extract::Extractor, *};
use std::collections::BTreeSet;

fn session(question: &str, day: &str) -> String {
    format!("# Session\n\n- Started: {day} 12:00\n- Ended: {day} 13:00\n- Source: Codex\n- Project: test\n- Model: gpt-6-sol\n\n---\n\n## 👤 User\n\n{question}\n\n## 🤖 Codex\n\nAssistant answer must not become personal evidence.\n")
}

fn build(docs: &[(&str, String)], as_of: &str, previous: Option<&Snapshot>) -> Snapshot {
    let inputs: Vec<_> = docs
        .iter()
        .map(|(path, text)| SourceInput {
            path: (*path).into(),
            hash: hash(text),
            origin: "unlabeled".into(),
        })
        .collect();
    let mut extractor = Extractor::new("focus-vault", &inputs, previous);
    extractor
        .set_focus(FocusContext {
            as_of: as_of.into(),
            window_days: 30,
            utc_offset_minutes: 480,
        })
        .unwrap();
    for (path, text) in docs {
        extractor.add_document(path, text).unwrap();
    }
    organize::build(
        "focus-vault",
        &hash("scope"),
        extractor.finish().unwrap(),
        previous,
    )
    .unwrap()
}

fn docs() -> Vec<(&'static str, String)> {
    vec![
        (
            "agent-sessions/one.md",
            session("工作记忆与情绪调节有什么关系？", "2026-09-29"),
        ),
        (
            "agent-sessions/two.md",
            session("我想知道工作记忆与情绪调节如何互相影响。", "2026-09-30"),
        ),
        (
            "agent-sessions/three.md",
            session("鱼缸里的硝酸盐浓度为什么会上升？", "2026-09-30"),
        ),
        // The third term provides an observed contrast window for NPMI;
        // two terms occurring in every available window have no association
        // information beyond their marginals.
        (
            "background.md",
            "[[工作记忆]] 和 [[历史知识]]、[[硝酸盐]]。".into(),
        ),
    ]
}

#[test]
fn complete_extraction_and_organization_is_a_byte_identical_noop() {
    let docs = docs();
    let first = build(&docs, "2026-10-02", None);
    assert!(!first.attention.is_empty());
    assert!(
        first.edges.iter().any(|e| e.edge_type == "co_discussed"
            && e.status == "statistical"
            && e.evidence.len() >= 2),
        "nodes={:?}, edges={:?}",
        first.nodes.iter().map(|n| &n.label).collect::<Vec<_>>(),
        first.edges
    );
    let again = build(&docs, "2026-10-02", Some(&first));
    assert_eq!(first.meta.state_hash, again.meta.state_hash);
    assert_eq!(encode(&first).unwrap(), encode(&again).unwrap());
    for a in &first.attention {
        assert!(first.nodes.iter().any(|n| n.id == a.node));
        assert!(a.evidence.iter().all(|id| first
            .attention_observations
            .iter()
            .any(|o| &o.evidence == id)));
    }
}

#[test]
fn advancing_window_retires_attention_without_erasing_learned_keywords_or_roads() {
    let docs = docs();
    let first = build(&docs, "2026-10-02", None);
    assert!(!first.attention.is_empty());
    let later = build(&docs, "2026-11-03", Some(&first));
    assert!(later.attention.is_empty());
    assert!(later.attention_observations.is_empty());
    assert_eq!(first.nodes, later.nodes);
    assert_eq!(first.edges, later.edges);
    assert_eq!(first.meta.structure_hash, later.meta.structure_hash);
    assert_eq!(later.meta.change_cause, "attention_window");
    let again = build(&docs, "2026-11-03", Some(&later));
    assert_eq!(encode(&later).unwrap(), encode(&again).unwrap());
}

#[test]
fn changed_sources_are_rematched_instead_of_reusing_old_evidence_locations() {
    let mut docs = docs();
    let first = build(&docs, "2026-10-02", None);
    docs[0].1 = docs[0].1.replace("## 👤 User\n\n", "## 👤 User\n\n\n\n");
    let next = build(&docs, "2026-10-02", Some(&first));
    let source = next
        .sources
        .iter()
        .find(|s| s.path == "agent-sessions/one.md")
        .unwrap();
    assert_eq!(source.hash, hash(&docs[0].1));
    for observation in &next.attention_observations {
        let evidence = next
            .evidence
            .iter()
            .find(|e| e.id == observation.evidence)
            .unwrap();
        if evidence.source == source.id {
            let line = docs[0].1.lines().nth(evidence.locator.start - 1).unwrap();
            assert!(line.contains("工作记忆"));
            assert!(!first.evidence.iter().any(|old| old.id == evidence.id));
        }
    }
}

#[test]
fn recent_keyword_survives_more_than_twelve_hundred_background_candidates() {
    let mut data = Extraction::default();
    data.sources.push(Source {
        id: "source".into(),
        path: "note.md".into(),
        hash: hash("body"),
        family: "family".into(),
        status: "available".into(),
        ..Default::default()
    });
    data.evidence.push(Evidence {
        id: "evidence".into(),
        source: "source".into(),
        locator: Locator {
            start: 1,
            end: 1,
            ..Default::default()
        },
        role: "context".into(),
        authorship: "human".into(),
        granularity: "paragraph".into(),
        verification: "matched".into(),
    });
    for i in 0..1201 {
        data.nodes.push(Node {
            id: format!("background:{i}"),
            key: format!("background:{i}"),
            node_type: "concept".into(),
            label: format!("历史词{i:04}"),
            status: "observed".into(),
            evidence: vec!["evidence".into()],
            ..Default::default()
        });
    }
    data.nodes.push(Node {
        id: "recent".into(),
        key: "recent".into(),
        node_type: "keyword".into(),
        label: "最近关注关键词".into(),
        status: "observed".into(),
        evidence: vec!["evidence".into()],
        ..Default::default()
    });
    data.focus = Some(FocusContext {
        as_of: "2026-10-02".into(),
        window_days: 30,
        utc_offset_minutes: 480,
    });
    data.attention.push(Attention {
        node: "recent".into(),
        score: 1.,
        last_observed_at: "2026-10-01".into(),
        active_days: 1,
        events: 1,
        evidence: vec!["evidence".into()],
        category: "concept".into(),
    });
    data.attention_observations.push(AttentionObservation {
        evidence: "evidence".into(),
        date: "2026-10-01".into(),
        event_id: "event".into(),
        signal: "agent_user".into(),
        date_basis: "same_day_session".into(),
        confidence: 0.8,
    });
    data.retained_keywords = BTreeSet::from(["最近关注关键词".into()]);
    let snapshot = organize::build("focus-vault", &hash("scope"), data, None).unwrap();
    let node = snapshot
        .nodes
        .iter()
        .find(|n| n.label == "最近关注关键词")
        .unwrap();
    assert!(snapshot.attention.iter().any(|a| a.node == node.id));
    assert_eq!(
        snapshot
            .nodes
            .iter()
            .filter(|n| n.node_type == "keyword")
            .count(),
        1201
    );
}

#[test]
fn declared_project_context_is_not_overwritten_by_a_same_spelling_generic_keyword() {
    let mut docs = docs();
    docs.push(("project.md", "---\ntitle: 工作记忆\ntype: project\n---\n这是明确声明的项目。".into()));
    let snapshot = build(&docs, "2026-10-02", None);
    let node = snapshot.nodes.iter().find(|n| n.label == "工作记忆").unwrap();
    assert_eq!(node.intent_status.as_deref(), Some("declared_project"));
    let attention = snapshot.attention.iter().find(|a| a.node == node.id).unwrap();
    assert_eq!(attention.category, "context");
}
