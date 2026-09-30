use habitat_core::{extract::Extractor, hash, model::*, organize};
use serde_json::Value;

fn extract(documents: &[(&str, &str)], previous: Option<&Snapshot>) -> Extraction {
    let inputs: Vec<_> = documents
        .iter()
        .map(|(path, content)| SourceInput {
            path: (*path).into(),
            hash: hash(content.as_bytes()),
            origin: "unlabeled".into(),
        })
        .collect();
    let mut extractor = Extractor::new("fixture-vault", &inputs, previous);
    for (path, content) in documents {
        extractor.add_document(path, content).unwrap();
    }
    extractor.finish().unwrap()
}

#[test]
fn wiki_paths_append_only_missing_extensions_and_keep_percent_names_literal() {
    let data = extract(&[
        ("notes/links.md", "[[sub/target]] [[sub/explicit.md]] [[sub/plain.txt]] [[../wikipage/Idea.note.md]] [[sub/literal%20]] [[local]] [encoded](sub/literal%20.md) [[../../escape]] [[sub/missing]]"),
        ("notes/sub/target.md", "# Target"),
        ("notes/sub/explicit.md", "# Explicit"),
        ("notes/sub/plain.txt", "Plain"),
        ("wikipage/Idea.note.md", "- "),
        ("notes/sub/literal%20.md", "# Literal percent"),
        ("notes/sub/literal .md", "# URL space"),
        ("notes/local.md", "# Local relative"),
    ], None);
    assert_eq!(
        data.edges
            .iter()
            .filter(|e| e.edge_type == "wikilink")
            .count(),
        6
    );
    assert_eq!(
        data.edges
            .iter()
            .filter(|e| e.edge_type == "explicit_reference")
            .count(),
        1
    );
    assert_eq!(data.coverage.unresolved_links, 2);
    let reference = data
        .edges
        .iter()
        .find(|e| e.edge_type == "explicit_reference")
        .unwrap();
    let target = &reference
        .participants
        .iter()
        .find(|p| p.role == "target")
        .unwrap()
        .node;
    assert_eq!(
        data.nodes.iter().find(|n| &n.id == target).unwrap().label,
        "URL space"
    );
    assert!(!data
        .nodes
        .iter()
        .any(|n| n.label == "sub/missing" || n.label == "../../escape"));
}

#[test]
fn ast_links_ignore_code_external_and_fragment_and_share_unit_evidence() {
    let data = extract(
        &[
            ("notes/links.md", include_str!("fixtures/habitat/links.md")),
            ("notes/source note.md", "# 原文\n证据。\n"),
            ("wikipage/Hemory.note.md", "---\ntitle: Hemory\n---\n- \n"),
            ("wikipage/Recall.note.md", "---\ntitle: Recall\n---\n- \n"),
        ],
        None,
    );
    let labels: Vec<_> = data.nodes.iter().map(|n| n.label.as_str()).collect();
    assert!(!labels.iter().any(|s| s.contains("假概念")));
    assert_eq!(
        data.edges
            .iter()
            .filter(|e| e.edge_type == "wikilink")
            .count(),
        2
    );
    assert_eq!(
        data.edges
            .iter()
            .filter(|e| e.edge_type == "explicit_reference")
            .count(),
        1
    );
    let mentions: Vec<_> = data
        .edges
        .iter()
        .filter(|e| e.edge_type == "wikilink")
        .collect();
    assert_eq!(mentions[0].evidence, mentions[1].evidence);
    assert_eq!(
        data.edges
            .iter()
            .filter(|e| e.edge_type == "co_mentioned_in")
            .count(),
        1
    );
    assert_eq!(data.coverage.unresolved_links, 0);
    assert_eq!(
        data.nodes
            .iter()
            .find(|n| n.label == "Hemory")
            .unwrap()
            .status,
        "anchor"
    );
    assert!(!labels.contains(&"会话记忆")); // display text is not an identity alias
}

#[test]
fn fenced_outline_answer_is_one_attributed_unit_and_keeps_inner_code_opaque() {
    let data = extract(
        &[(
            "notes/answer.note.md",
            include_str!("fixtures/habitat/answer.note.md"),
        )],
        None,
    );
    let links: Vec<_> = data
        .edges
        .iter()
        .filter(|e| e.edge_type == "wikilink")
        .collect();
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].evidence, links[1].evidence);
    let evidence = data
        .evidence
        .iter()
        .find(|ev| ev.id == links[0].evidence[0])
        .unwrap();
    assert_eq!(evidence.locator.outline_id.as_deref(), Some("answer-1"));
    assert_eq!(evidence.authorship, "fixture/agent");
    assert_eq!(evidence.locator.start, 7);
    assert!(!data.nodes.iter().any(|n| n.label == "程序假概念"));
}

#[test]
fn unique_hash_rename_keeps_source_and_document_identity() {
    let first = extract(
        &[("notes/old.md", "---\ntitle: 稳定概念\n---\n内容保持。\n")],
        None,
    );
    let previous = Snapshot {
        meta: Meta {
            vault_id: "fixture-vault".into(),
            ..Default::default()
        },
        sources: first.sources.clone(),
        nodes: first.nodes.clone(),
        ..Default::default()
    };
    let second = extract(
        &[("notes/new.md", "---\ntitle: 稳定概念\n---\n内容保持。\n")],
        Some(&previous),
    );
    assert_eq!(first.sources[0].id, second.sources[0].id);
    assert_eq!(first.nodes[0].id, second.nodes[0].id);
    assert_eq!(first.evidence[0].id, second.evidence[0].id);
}

#[test]
fn source_chain_and_exact_copies_share_mass_but_unresolved_lineage_stays_unknown() {
    let data = extract(
        &[
            ("raw.md", "原始材料"),
            ("copy.md", "原始材料"),
            (
                "summary.md",
                "---\nsources: [{id: s, resource: /raw.md}]\n---\n摘要",
            ),
            (
                "timeline.md",
                "---\nsources: [{id: s, resource: /summary.md}]\n---\n时间线",
            ),
            ("other.md", "未标注来源"),
            (
                "multi.md",
                "---\nsources: [{resource: /raw.md}, {resource: /other.md}]\n---\n多来源综述",
            ),
        ],
        None,
    );
    let family = |path: &str| data.sources.iter().find(|s| s.path == path).unwrap();
    for path in ["copy.md", "summary.md", "timeline.md"] {
        assert_eq!(family("raw.md").family, family(path).family);
        assert_eq!(family(path).family_status, "verified");
    }
    assert_ne!(family("multi.md").family, family("raw.md").family);
    assert_eq!(family("other.md").family_status, "unresolved");
    assert_eq!(family("multi.md").family_status, "unresolved");
}

#[test]
fn name_collisions_do_not_pick_a_winner_and_custom_wiki_directory_is_order_independent() {
    let documents = [
        ("notes/note.md", "[[同名]]"),
        ("百科/a/同名.note.md", "- 一"),
        ("百科/b/同名.note.md", "- 二"),
        (".notemd/settings.json", "{\"wikipageDir\":\"百科\"}"),
    ];
    let first = extract(&documents, None);
    let mut reversed = documents;
    reversed.reverse();
    let second = extract(&reversed, None);
    assert_eq!(first.nodes, second.nodes);
    assert_eq!(first.edges, second.edges);
    assert!(first.edges.is_empty());
    assert_eq!(first.coverage.unresolved_links, 1);
    assert!(first
        .coverage
        .diagnostics
        .iter()
        .any(|d| d.code == "wiki.ambiguous"));
}

fn knowledge() -> Value {
    serde_json::from_str(include_str!(
        "../../plugins-src/knowledge-browser/fixtures/minimal-valid.json"
    ))
    .unwrap()
}

#[test]
fn meeting_import_retains_all_roles_never_asserts_verification_and_reports_projection_scope() {
    let mut dataset = knowledge();
    dataset["relations"][0]["args"]["work"] = Value::String("c1".into());
    dataset["relations"][1]["args"]["action"] = Value::String("e2".into());
    let text = serde_json::to_string(&dataset).unwrap();
    let data = extract(&[("ssot/meetings/one/knowledge.json", &text)], None);
    assert_eq!(data.coverage.knowledge_records, 8);
    assert_eq!(data.coverage.imported_records, 5);
    assert_eq!(data.coverage.unprojected_records, 3);
    assert_eq!(data.coverage.isolated_records, 0);
    assert_eq!(data.nodes.len(), 3);
    assert_eq!(data.edges.len(), 2);
    assert_eq!(
        data.edges
            .iter()
            .find(|e| e.edge_type == "delegates_to")
            .unwrap()
            .participants
            .len(),
        3
    );
    assert!(data.nodes.iter().all(|n| n.status == "imported"));
    assert!(data.evidence.iter().all(|e| e.verification == "imported"));
    assert!(data
        .coverage
        .diagnostics
        .iter()
        .any(|d| d.code == "knowledge.source_unavailable"));
    let snapshot = organize::build("fixture-vault", &hash("scope"), data, None).unwrap();
    let encoded = habitat_core::codec::encode_jsonl(&snapshot).unwrap();
    assert!(!String::from_utf8(encoded)
        .unwrap()
        .contains("工程负责人委派发布执行人完成发布。")); // no copied source quote
}

#[test]
fn broken_records_remove_their_reference_closure_and_duplicate_json_keys_are_rejected() {
    let mut dataset = knowledge();
    dataset["entities"][0]["i"] = Value::from(7);
    let text = serde_json::to_string(&dataset).unwrap();
    let data = extract(
        &[
            ("ssot/meetings/a/knowledge.json", &text),
            (
                "ssot/meetings/b/knowledge.json",
                "{\"schema\":\"x\",\"schema\":\"y\"}",
            ),
        ],
        None,
    );
    assert!(data.nodes.is_empty());
    assert!(data.edges.is_empty());
    assert!(data.evidence.is_empty());
    assert_eq!(data.coverage.isolated_records, 8);
    assert!(data
        .coverage
        .diagnostics
        .iter()
        .any(|d| d.code == "knowledge.json"));
}

#[test]
fn hash_drift_and_unsubmitted_sources_are_reported_without_derived_objects() {
    let inputs = [
        SourceInput {
            path: "a.md".into(),
            hash: hash("old"),
            ..Default::default()
        },
        SourceInput {
            path: "b.md".into(),
            hash: hash("b"),
            ..Default::default()
        },
    ];
    let mut extractor = Extractor::new("fixture-vault", &inputs, None);
    assert!(extractor.add_document("a.md", "changed").is_err());
    let data = extractor.finish().unwrap();
    assert_eq!(data.coverage.unavailable, 2);
    assert!(data.nodes.is_empty());
}

#[test]
fn long_unicode_names_keep_distinct_identity_and_pass_the_snapshot_contract() {
    let name = "长期概念".repeat(100);
    let text = format!("[[{name}甲]] 和 [[{name}乙]]");
    let data = extract(&[("note.md", &text)], None);
    assert_eq!(
        data.nodes
            .iter()
            .filter(|n| n.node_type == "concept")
            .count(),
        2
    );
    assert!(data.nodes.iter().all(|n| n.key.len() <= 256));
    assert!(data
        .features
        .values()
        .flatten()
        .all(|f| f.chars().count() <= 96));
    let snapshot = organize::build("fixture-vault", &hash("scope"), data, None).unwrap();
    habitat_core::encode(&snapshot).unwrap();
}

#[test]
fn empty_markdown_heading_does_not_erase_the_document_label() {
    let data = extract(&[("untitled.md", "#\n\n本文只有空标题。")], None);
    assert_eq!(data.nodes[0].label, "untitled");
    let snapshot = organize::build("fixture-vault", &hash("scope"), data, None).unwrap();
    habitat_core::encode(&snapshot).unwrap();
}

#[test]
fn dotted_wiki_names_resolve_before_file_paths_and_collect_incoming_source_evidence() {
    let data = extract(
        &[
            ("wikipage/note.md.note.md", "---\ntitle: note.md\n---\n- \n"),
            (
                "notes/context.note.md",
                "- [[note.md]] 需要稳定的概念身份。\n  id:: context-1\n",
            ),
            ("notes/unassigned.md", "独立原始内容"),
        ],
        None,
    );
    let named: Vec<_> = data.nodes.iter().filter(|n| n.label == "note.md").collect();
    assert_eq!(named.len(), 1);
    assert_eq!(named[0].status, "anchor");
    assert_eq!(
        data.edges
            .iter()
            .filter(|e| e.edge_type == "wikilink")
            .count(),
        1
    );
    let context_source = &data
        .sources
        .iter()
        .find(|s| s.path == "notes/context.note.md")
        .unwrap()
        .id;
    assert!(named[0]
        .evidence
        .iter()
        .any(|id| data.evidence.iter().any(|ev| ev.id == *id
            && ev.source == *context_source
            && ev.locator.outline_id.as_deref() == Some("context-1"))));
    assert_eq!(data.coverage.unassigned_sources, 1);
}
