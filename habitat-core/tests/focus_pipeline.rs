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
            label: format!(
                "历史词{}{}{}",
                (b'a' + ((i / 676) % 26) as u8) as char,
                (b'a' + ((i / 26) % 26) as u8) as char,
                (b'a' + (i % 26) as u8) as char
            ),
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
    docs.push((
        "project.md",
        "---\ntitle: 工作记忆\ntype: project\n---\n这是明确声明的项目。".into(),
    ));
    let snapshot = build(&docs, "2026-10-02", None);
    let node = snapshot
        .nodes
        .iter()
        .find(|n| n.label == "工作记忆")
        .unwrap();
    assert_eq!(node.intent_status.as_deref(), Some("declared_project"));
    let attention = snapshot
        .attention
        .iter()
        .find(|a| a.node == node.id)
        .unwrap();
    assert_eq!(attention.category, "context");
}

#[test]
fn imported_project_mentions_never_declare_a_personal_project() {
    let mut dataset: serde_json::Value = serde_json::from_str(include_str!(
        "../../plugins-src/knowledge-browser/fixtures/minimal-valid.json"
    ))
    .unwrap();
    dataset["entities"][0]["type"] = "project".into();
    let text = serde_json::to_string(&dataset).unwrap();
    let input = SourceInput {
        path: "ssot/meetings/import/knowledge.json".into(),
        hash: hash(&text),
        origin: "unlabeled".into(),
    };
    let mut extractor = Extractor::new("focus-vault", &[input], None);
    extractor
        .set_focus(FocusContext {
            as_of: "2026-10-02".into(),
            window_days: 30,
            utc_offset_minutes: 480,
        })
        .unwrap();
    extractor
        .add_document("ssot/meetings/import/knowledge.json", &text)
        .unwrap();
    let data = extractor.finish().unwrap();
    assert!(!data.nodes.iter().any(|n| n.node_type == "project"));
    let imported = data
        .nodes
        .iter()
        .find(|n| n.intent_status.as_deref() == Some("imported_project_mention"))
        .unwrap();
    assert_ne!(imported.node_type, "keyword");
}

#[test]
fn direct_definitions_create_typed_source_claims_without_wiki_pages() {
    let docs = vec![(
        "agent-sessions/definition.md",
        session("工作记忆是一种记忆。", "2026-10-01"),
    )];
    let snapshot = build(&docs, "2026-10-02", None);
    let edge = snapshot
        .edges
        .iter()
        .find(|e| e.status == "asserted")
        .expect("literal definition must survive full pipeline");
    assert_eq!(edge.edge_type, "is_a");
    assert_eq!(edge.participants.len(), 2);
    assert!(edge.participants.iter().any(|p| p.role == "subject"));
    assert!(edge.participants.iter().any(|p| p.role == "object"));
    assert!(!edge.evidence.is_empty());
}

#[test]
fn previous_keywords_cannot_resurrect_rejected_format_words() {
    let docs = vec![(
        "agent-sessions/format.md",
        session("输出 JSON title 字段。the title 是字段。", "2026-10-01"),
    )];
    let mut previous = build(&docs, "2026-10-02", None);
    previous.nodes.push(Node {
        id: "old-the".into(),
        key: "keyword:the".into(),
        label: "the".into(),
        node_type: "keyword".into(),
        status: "observed".into(),
        ..Default::default()
    });
    previous.meta.algorithm.version = "habitat-focus/3".into();
    finalize(&mut previous, None).unwrap();
    let snapshot = build(&docs, "2026-10-02", Some(&previous));
    assert!(!snapshot.nodes.iter().any(|n| n.label == "the"));
    assert!(!snapshot.attention.iter().any(|a| snapshot
        .nodes
        .iter()
        .any(|n| n.id == a.node && n.label == "title")));
}

#[test]
fn historical_concept_type_cannot_promote_current_installation_evidence() {
    let docs = vec![
        (
            "agent-sessions/old-a.md",
            session("为什么客户端影响数据一致性？", "2026-08-01"),
        ),
        (
            "agent-sessions/old-b.md",
            session("理解客户端如何影响数据一致性。", "2026-08-02"),
        ),
        (
            "agent-sessions/old-c.md",
            session("比较客户端与服务端的职责区别。", "2026-08-03"),
        ),
        (
            "agent-sessions/recent-a.md",
            session("请安装客户端。", "2026-09-29"),
        ),
        (
            "agent-sessions/recent-b.md",
            session("安装客户端并重连服务器。", "2026-09-30"),
        ),
    ];
    let snapshot = build(&docs, "2026-10-02", None);
    for a in &snapshot.attention {
        let node = snapshot.nodes.iter().find(|n| n.id == a.node).unwrap();
        assert!(!(node.label == "客户端" && a.category == "concept"));
    }
}

#[test]
fn uppercase_acronym_phrase_survives_all_gates_and_previous_snapshot_rematching() {
    let docs = vec![
        ("terms.md", "[[CLIP特征]]。[[router用户]]。".into()),
        (
            "agent-sessions/clip-a.md",
            session("为什么CLIP特征影响检索质量？", "2026-09-29"),
        ),
        (
            "agent-sessions/clip-b.md",
            session("解释CLIP特征的机制。", "2026-09-30"),
        ),
    ];
    let snapshot = build(&docs, "2026-10-02", None);
    let node = snapshot
        .nodes
        .iter()
        .find(|n| n.label == "CLIP特征")
        .expect("case-sensitive lexical evidence must survive normalized identity projection");
    assert_eq!(node.node_type, "keyword");
    assert!(snapshot
        .attention
        .iter()
        .any(|a| a.node == node.id && a.active_days == 2));
    assert!(!snapshot.nodes.iter().any(|n| n.label == "router用户"));
    let again = build(&docs, "2026-10-02", Some(&snapshot));
    assert_eq!(encode(&again).unwrap(), encode(&snapshot).unwrap());
}

#[test]
fn rejected_history_fragments_cannot_reenter_through_wiki_or_previous_snapshots() {
    let docs = vec![
        (
            "links.md",
            "[[可能原因]] [[原因]] [[卡定稿]] [[定稿]] [[命令]] [[安装wespeacker]] [[融入文档]] [[工作记忆]]".into(),
        ),
        (
            "links-two.md",
            "旧词项引用：[[可能原因]] [[原因]] [[卡定稿]] [[定稿]] [[命令]] [[安装wespeacker]] [[融入文档]] [[工作记忆]]"
                .into(),
        ),
        (
            "agent-sessions/old-a.md",
            session("请问可能原因是什么。原因是什么？", "2026-03-21"),
        ),
        (
            "agent-sessions/old-b.md",
            session("服务端没有移动。可能原因是什么", "2026-04-05"),
        ),
        (
            "agent-sessions/old-c.md",
            session("ai生成视频 抽卡：1.5卡定稿 是什么水平", "2026-09-10"),
        ),
        (
            "agent-sessions/old-d.md",
            session(
                "把安装wespeacker依赖的方法备注文档。请把这方面讨论融入文档。",
                "2026-09-18",
            ),
        ),
        (
            "agent-sessions/value-query.md",
            session("运行命令是什么", "2026-08-26"),
        ),
        (
            "agent-sessions/valid.md",
            session("什么是工作记忆？", "2026-10-01"),
        ),
    ];
    // A legacy/no-focus graph deliberately admits wiki anchors. The quality
    // migration must remove proven junk from every layer, not relabel it.
    let inputs: Vec<_> = docs
        .iter()
        .map(|(p, t)| SourceInput {
            path: (*p).into(),
            hash: hash(t),
            origin: "unlabeled".into(),
        })
        .collect();
    let mut legacy = Extractor::new("focus-vault", &inputs, None);
    for (path, text) in &docs {
        legacy.add_document(path, text).unwrap();
    }
    let old = organize::build(
        "focus-vault",
        &hash("scope"),
        legacy.finish().unwrap(),
        None,
    )
    .unwrap();
    assert!(old.nodes.iter().any(|n| n.label == "可能原因"));
    let cleaned = build(&docs, "2026-10-03", Some(&old));
    for label in [
        "可能原因",
        "原因",
        "卡定稿",
        "定稿",
        "命令",
        "安装wespeacker",
        "融入文档",
    ] {
        assert!(
            !cleaned.nodes.iter().any(|n| n.label == label),
            "invalid term survived in some layer: {label}"
        );
    }
    assert!(cleaned
        .nodes
        .iter()
        .any(|n| n.label == "工作记忆" && n.node_type == "keyword"));
    let again = build(&docs, "2026-10-03", Some(&cleaned));
    assert_eq!(encode(&cleaned).unwrap(), encode(&again).unwrap());
    validate(&cleaned).unwrap();
}
