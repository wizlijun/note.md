use habitat_core::*;

const V1: &[u8] = include_bytes!("fixtures/contract/schema1.jsonl.zst");
const V1_JSONL: &[u8] = include_bytes!("fixtures/contract/schema1.jsonl");

fn focused() -> Snapshot {
    let mut snapshot = decode(V1).unwrap();
    snapshot.meta.focus = Some(FocusContext {
        as_of: "2026-10-02".into(),
        window_days: 30,
        utc_offset_minutes: 480,
    });
    snapshot.attention_observations.push(AttentionObservation {
        evidence: "evidence:one".into(),
        date: "2026-10-01".into(),
        event_id: "event:one".into(),
        signal: "agent_user".into(),
        date_basis: "message_timestamp".into(),
        confidence: 1.,
    });
    snapshot.attention.push(Attention {
        node: "node:one".into(),
        score: 0.75,
        last_observed_at: "2026-10-01".into(),
        active_days: 1,
        events: 1,
        evidence: vec!["evidence:one".into()],
        category: "concept".into(),
    });
    finalize(&mut snapshot, None).unwrap();
    snapshot
}

#[test]
fn published_v1_fixture_roundtrips_without_new_fields_or_new_hash_formula() {
    // Produced with the released v1 codec in an independent checkout, not by
    // this codec's own test helper. Both canonical and compressed bytes matter.
    let snapshot = decode(V1).unwrap();
    assert_eq!(snapshot.meta.schema, SCHEMA_V1);
    assert_eq!(codec::encode_jsonl(&snapshot).unwrap(), V1_JSONL);
    assert_eq!(encode(&snapshot).unwrap(), V1);
    let json = serde_json::to_value(&snapshot).unwrap();
    assert!(json.get("attention").is_none());
    assert!(json.get("attentionObservations").is_none());
    assert!(json["meta"].get("focus").is_none());
}

#[test]
fn schema1_rejects_focus_and_both_new_record_types() {
    let old = decode(V1).unwrap();
    let new = focused();
    for which in 0..3 {
        let mut invalid = old.clone();
        match which {
            0 => invalid.meta.focus = new.meta.focus.clone(),
            1 => invalid.attention = new.attention.clone(),
            _ => invalid.attention_observations = new.attention_observations.clone(),
        }
        assert!(validate(&invalid).unwrap_err().contains("旧版"));
    }
    // Even explicit null is not an accepted canonical v1 extension.
    let text = std::str::from_utf8(V1_JSONL).unwrap();
    let with_null = text.replacen("\"kind\":\"meta\"", "\"focus\":null,\"kind\":\"meta\"", 1);
    let bytes = zstd::stream::encode_all(with_null.as_bytes(), 9).unwrap();
    assert!(decode(&bytes).is_err());
}

#[test]
fn schema2_roundtrips_and_same_observation_is_a_byte_identical_noop() {
    let original = focused();
    assert_eq!(original.meta.schema, SCHEMA);
    let encoded = encode(&original).unwrap();
    assert_eq!(decode(&encoded).unwrap(), original);
    let mut next = original.clone();
    next.meta.generated_at = "2026-10-02T20:00:00Z".into();
    assert!(!finalize(&mut next, Some(&original)).unwrap());
    assert_eq!(encode(&next).unwrap(), encoded);
}

#[test]
fn attention_is_hashed_separately_from_knowledge_structure() {
    let original = focused();
    let mut next = original.clone();
    next.attention[0].score = 0.25;
    assert!(validate(&next).unwrap_err().contains("完整性"));
    finalize(&mut next, Some(&original)).unwrap();
    assert_ne!(next.meta.state_hash, original.meta.state_hash);
    assert_eq!(next.meta.structure_hash, original.meta.structure_hash);
    assert_eq!(next.meta.change_cause, "attention");
    let diff = diff::compare(&original, &next).unwrap();
    assert_eq!(diff.attention_changes, 1);
    assert_eq!(diff.observation_changes, 0);
    assert!(diff.causes.contains(&"attention".into()));
    assert!(!diff.causes.contains(&"structure".into()));
    assert!(diff.added.is_empty() && diff.removed.is_empty());
}

#[test]
fn calendar_advances_are_observation_changes_not_algorithm_or_knowledge_growth() {
    let original = focused();
    let mut next = original.clone();
    next.meta.focus.as_mut().unwrap().as_of = "2026-10-03".into();
    finalize(&mut next, Some(&original)).unwrap();
    assert_eq!(next.meta.algorithm, original.meta.algorithm);
    assert_eq!(next.meta.structure_hash, original.meta.structure_hash);
    assert_eq!(next.meta.change_cause, "attention_window");
    let diff = diff::compare(&original, &next).unwrap();
    assert!(diff.causes.contains(&"attention_window".into()));
    assert!(!diff.causes.contains(&"algorithm".into()));
    assert!(diff.comparable);
    assert!(diff.added.is_empty() && diff.removed.is_empty());
    let mut changed = next.clone();
    changed.sources[0].hash = hash("actual new source content");
    finalize(&mut changed, Some(&original)).unwrap();
    let diff = diff::compare(&original, &changed).unwrap();
    assert!(diff.causes.contains(&"attention_window".into()));
    assert!(diff.causes.contains(&"evidence".into()));
}

#[test]
fn source_dates_counts_and_references_must_support_each_attention_record() {
    let original = focused();
    for mutate in [
        |s: &mut Snapshot| s.meta.focus = None,
        |s: &mut Snapshot| s.meta.focus.as_mut().unwrap().as_of = "2026-02-30".into(),
        |s: &mut Snapshot| s.meta.focus.as_mut().unwrap().window_days = 0,
        |s: &mut Snapshot| s.meta.focus.as_mut().unwrap().utc_offset_minutes = 841,
        |s: &mut Snapshot| s.attention[0].node = "missing".into(),
        |s: &mut Snapshot| s.attention[0].score = f64::INFINITY,
        |s: &mut Snapshot| s.attention[0].score = -0.01,
        |s: &mut Snapshot| s.attention[0].category = "diagnosis".into(),
        |s: &mut Snapshot| s.attention[0].active_days = 2,
        |s: &mut Snapshot| s.attention[0].events = 2,
        |s: &mut Snapshot| s.attention[0].last_observed_at = "2026-10-02".into(),
        |s: &mut Snapshot| s.attention[0].evidence.clear(),
        |s: &mut Snapshot| s.nodes[0].evidence.clear(),
        |s: &mut Snapshot| s.attention_observations.clear(),
        |s: &mut Snapshot| s.attention_observations[0].evidence = "missing".into(),
        |s: &mut Snapshot| s.attention_observations[0].date = "2026-10-03".into(),
        |s: &mut Snapshot| s.attention_observations[0].date = "2026-09-02".into(),
        |s: &mut Snapshot| s.attention_observations[0].date = "2026-9-03".into(),
        |s: &mut Snapshot| s.attention_observations[0].confidence = f64::NAN,
        |s: &mut Snapshot| s.attention_observations[0].event_id.clear(),
        |s: &mut Snapshot| s.attention_observations[0].signal.clear(),
        |s: &mut Snapshot| s.attention_observations[0].date_basis.clear(),
        |s: &mut Snapshot| s.attention.push(s.attention[0].clone()),
        |s: &mut Snapshot| {
            s.attention_observations
                .push(s.attention_observations[0].clone())
        },
    ] {
        let mut invalid = original.clone();
        mutate(&mut invalid);
        assert!(validate(&invalid).is_err());
    }
    let mut boundary = original.clone();
    boundary.attention_observations[0].date = "2026-09-03".into();
    boundary.attention[0].last_observed_at = "2026-09-03".into();
    finalize(&mut boundary, None).unwrap();
}

#[test]
fn multiple_mentions_in_one_event_do_not_inflate_event_or_day_counts() {
    let mut snapshot = focused();
    let mut evidence = snapshot.evidence[0].clone();
    evidence.id = "evidence:two".into();
    evidence.locator.start = 2;
    evidence.locator.end = 2;
    snapshot.evidence.push(evidence);
    let mut observation = snapshot.attention_observations[0].clone();
    observation.evidence = "evidence:two".into();
    snapshot.attention_observations.push(observation);
    snapshot.nodes[0].evidence.push("evidence:two".into());
    snapshot.attention[0].evidence.push("evidence:two".into());
    finalize(&mut snapshot, None).unwrap();
    assert_eq!(snapshot.attention[0].events, 1);
    assert_eq!(snapshot.attention[0].active_days, 1);
}
