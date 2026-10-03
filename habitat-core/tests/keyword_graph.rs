use habitat_core::{extract::Extractor, hash, model::*, organize};
fn extract(docs: &[(&str, &str)]) -> Extraction {
    let inputs: Vec<_> = docs
        .iter()
        .map(|(p, s)| SourceInput {
            path: (*p).into(),
            hash: hash(s),
            origin: "human".into(),
        })
        .collect();
    let mut x = Extractor::new("keyword-test", &inputs, None);
    for (p, s) in docs {
        x.add_document(p, s).unwrap();
    }
    x.finish().unwrap()
}
fn build(data: Extraction, old: Option<&Snapshot>) -> Snapshot {
    organize::build("keyword-test", &hash("scope"), data, old).unwrap()
}
fn stats(s: &Snapshot) -> Vec<&Edge> {
    s.edges
        .iter()
        .filter(|e| e.edge_type == "co_occurs")
        .collect()
}
fn fixture() -> Extraction {
    extract(&[
        (
            "a.md",
            "[[信息检索]] 与 [[记忆]] 有联系。甲。\n\n[[户外]]。",
        ),
        ("b.md", "[[信息检索]] 与 [[记忆]] 有联系。乙。"),
    ])
}
#[test]
fn keyword_projection_excludes_documents_topics_and_automation_noise() {
    let s=build(extract(&[("note.md","[[123]] [[回忆索引]] [[September 4th, 2020]] [[真实兴趣]] [[spk_01]] [[可爱的长期兴趣是一个非常长而冗长的整个句子它不应成为关键词且需要过滤]]")]),None);
    let words: Vec<_> = s
        .nodes
        .iter()
        .filter(|n| n.node_type == "keyword")
        .map(|n| n.label.as_str())
        .collect();
    assert_eq!(words, vec!["真实兴趣"]);
    assert!(s
        .nodes
        .iter()
        .all(|n| matches!(n.node_type.as_str(), "keyword" | "topic")));
}
#[test]
fn repeated_bounded_windows_create_statistical_edges_with_honest_source_counts() {
    let s = build(fixture(), None);
    let es = stats(&s);
    assert_eq!(es.len(), 1);
    assert_eq!(es[0].status, "statistical");
    assert_eq!(es[0].verified_families, 0);
    assert_eq!(es[0].unresolved_lineage, 2);
    assert_eq!(es[0].participants.len(), 2);
    assert_eq!(es[0].evidence.len(), 2);
    assert_eq!(s.nodes.iter().filter(|n| n.node_type == "topic").count(), 1);
}
#[test]
fn separate_paragraphs_do_not_create_a_document_wide_clique() {
    let s = build(
        extract(&[
            ("a.md", "[[信息检索]] 甲。\n\n[[记忆]] 甲。"),
            ("b.md", "[[信息检索]] 乙。\n\n[[记忆]] 乙。"),
        ]),
        None,
    );
    assert!(stats(&s).is_empty());
}
#[test]
fn duplicated_material_and_repeated_paragraphs_are_not_independent_support() {
    let s = build(
        extract(&[
            (
                "a.md",
                "[[信息检索]] [[记忆]]\n\n[[信息检索]] [[记忆]]\n\n[[户外]]",
            ),
            (
                "copy.md",
                "[[信息检索]] [[记忆]]\n\n[[信息检索]] [[记忆]]\n\n[[户外]]",
            ),
        ]),
        None,
    );
    assert!(stats(&s).is_empty());
}
#[test]
fn coincident_locators_in_related_sources_never_fabricate_joint_windows() {
    let mut data = extract(&[
        ("a.md", "[[信息检索]] 甲"),
        ("a-copy.md", "[[记忆]] 甲"),
        ("b.md", "[[信息检索]] 乙"),
        ("b-copy.md", "[[记忆]] 乙"),
        ("c.md", "[[户外]]"),
    ]);
    for source in &mut data.sources {
        if source.path.starts_with('a') {
            source.family = "family-a".into();
        }
        if source.path.starts_with('b') {
            source.family = "family-b".into();
        }
    }
    let s = build(data, None);
    assert!(stats(&s).is_empty());
}
#[test]
fn long_keyword_lists_and_universal_pairs_do_not_create_statistics() {
    let s=build(extract(&[("a.md","[[词甲]] [[词乙]] [[词丙]] [[词丁]] [[词戊]] [[词己]] [[词庚]] [[词辛]] [[词壬]]甲"),("b.md","[[词甲]] [[词乙]] [[词丙]] [[词丁]] [[词戊]] [[词己]] [[词庚]] [[词辛]] [[词壬]]乙")]),None);
    assert!(stats(&s).is_empty());
    let s = build(
        extract(&[
            ("a.md", "[[信息检索]] [[记忆]]甲"),
            ("b.md", "[[信息检索]] [[记忆]]乙"),
        ]),
        None,
    );
    assert!(stats(&s).is_empty());
}
#[test]
fn lexical_aliases_do_not_claim_entity_identity_and_roles_survive() {
    let mut data = extract(&[("a.md", "[[Alpha]] [[Beta]] [[Gamma]] [[远足]]")]);
    let ids: Vec<_> = ["Alpha", "Beta", "Gamma"]
        .iter()
        .map(|label| {
            data.nodes
                .iter()
                .find(|n| n.label == *label)
                .unwrap()
                .id
                .clone()
        })
        .collect();
    let ev = data
        .nodes
        .iter()
        .find(|n| n.label == "Alpha")
        .unwrap()
        .evidence
        .clone();
    let mut imported = data
        .nodes
        .iter()
        .find(|n| n.label == "Alpha")
        .unwrap()
        .clone();
    imported.id = "scoped-alpha".into();
    imported.key = "knowledge:another:person".into();
    imported.status = "imported".into();
    imported.label = "ＡＬＰＨＡ".into();
    imported.node_type = "entity".into();
    data.nodes.push(imported);
    data.edges.push(Edge {
        id: "hyper".into(),
        edge_type: "delegates_to".into(),
        status: "imported".into(),
        participants: ids
            .iter()
            .zip(["principal", "agent", "work"])
            .map(|(id, role)| Participant {
                node: id.clone(),
                role: role.into(),
            })
            .collect(),
        evidence: ev,
        ..Default::default()
    });
    let s = build(data, None);
    let alpha: Vec<_> = s
        .nodes
        .iter()
        .filter(|n| n.key == "keyword:alpha")
        .collect();
    assert_eq!(alpha.len(), 1);
    assert_eq!(alpha[0].status, "anchor");
    assert_eq!(alpha[0].node_type, "keyword");
    let edge = s
        .edges
        .iter()
        .find(|e| e.edge_type == "delegates_to")
        .unwrap();
    assert_eq!(edge.status, "imported");
    assert_eq!(edge.participants.len(), 3);
    assert!(s.nodes.iter().all(|n| n.node_type != "topic"));
}
#[test]
fn same_input_permutations_codec_history_and_membership_layout_are_stable() {
    let data = fixture();
    let s = build(data.clone(), None);
    let again = build(data.clone(), Some(&s));
    assert_eq!(s, again);
    let mut reversed = data.clone();
    reversed.nodes.reverse();
    reversed.edges.reverse();
    reversed.sources.reverse();
    reversed.evidence.reverse();
    assert_eq!(s, build(reversed, Some(&s)));
    let encoded = habitat_core::encode(&s).unwrap();
    assert_eq!(habitat_core::decode(&encoded).unwrap(), s);
    let mut legacy = s.clone();
    legacy.meta.algorithm.version = "habitat-local/1".into();
    habitat_core::finalize(&mut legacy, None).unwrap();
    let migrated = build(data, Some(&legacy));
    assert_eq!(migrated.meta.change_cause, "algorithm");
    assert!(
        !habitat_core::diff::compare(&legacy, &migrated)
            .unwrap()
            .comparable
    );
    for keyword in s.nodes.iter().filter(|n| n.node_type == "keyword") {
        assert_eq!(
            keyword.id,
            again
                .nodes
                .iter()
                .find(|n| n.key == keyword.key)
                .unwrap()
                .id
        );
    }
}
#[test]
fn explicit_project_intent_survives_keyword_conversion() {
    let s = build(
        extract(&[(
            "plan.md",
            "---\ntype: project\ntitle: My project\n---\nA plan.",
        )]),
        None,
    );
    let n = s.nodes.iter().find(|n| n.label == "My project").unwrap();
    assert_eq!(n.node_type, "project");
    assert_eq!(n.intent_status.as_deref(), Some("declared_project"));
}

#[test]
fn community_growth_then_split_retains_one_identity_and_never_reuses_matching_keys() {
    fn linked(groups: &[Vec<&str>]) -> Extraction {
        let text = groups
            .iter()
            .flatten()
            .map(|s| format!("[[{s}]]"))
            .collect::<Vec<_>>()
            .join(" ");
        let mut data = extract(&[("human.md", &text)]);
        for group in groups {
            for (at, a) in group.iter().enumerate() {
                for b in &group[at + 1..] {
                    let na = data.nodes.iter().find(|n| n.label == *a).unwrap();
                    let nb = data.nodes.iter().find(|n| n.label == *b).unwrap();
                    data.edges.push(Edge {
                        id: format!("{a}-{b}"),
                        edge_type: "explicit_reference".into(),
                        status: "observed".into(),
                        participants: vec![
                            Participant {
                                node: na.id.clone(),
                                role: "source".into(),
                            },
                            Participant {
                                node: nb.id.clone(),
                                role: "target".into(),
                            },
                        ],
                        evidence: na.evidence.clone(),
                        ..Default::default()
                    });
                }
            }
        }
        data
    }
    let labels = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
    let mut previous = None;
    for count in 2..=6 {
        previous = Some(build(
            linked(&[labels[..count].to_vec()]),
            previous.as_ref(),
        ));
    }
    let before = previous.unwrap();
    let old = before
        .nodes
        .iter()
        .find(|n| n.node_type == "topic")
        .unwrap();
    let data = linked(&[labels[..2].to_vec(), labels[2..].to_vec()]);
    let after = build(data.clone(), Some(&before));
    let topics: Vec<_> = after
        .nodes
        .iter()
        .filter(|n| n.node_type == "topic")
        .collect();
    assert_eq!(topics.len(), 2);
    assert!(topics.iter().any(|t| t.id == old.id && t.key == old.key));
    assert_ne!(topics[0].key, topics[1].key);
    assert_eq!(after, build(data, Some(&after)));
    let continued = after.layout.iter().find(|p| p.id == old.id).unwrap();
    let old_center = before.layout.iter().find(|p| p.id == old.id).unwrap();
    assert_eq!(continued, old_center);
    let primary: std::collections::BTreeMap<_, _> = after
        .memberships
        .iter()
        .filter(|m| m.role == "primary")
        .map(|m| (&m.node, &m.topic))
        .collect();
    for n in after.nodes.iter().filter(|n| n.node_type == "keyword") {
        let p = after.layout.iter().find(|p| p.id == n.id).unwrap();
        let c = after
            .layout
            .iter()
            .find(|p| &p.id == primary[&n.id])
            .unwrap();
        assert!((p.x - c.x).hypot(p.y - c.y) < 200.);
    }
}
