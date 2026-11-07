use write_core::{utf16_to_byte, Document, Error};
const PAGE: &str = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
fn new() -> Document {
    Document::new(PAGE, 1, 1).unwrap()
}
fn put(d: &mut Document, at: u32, len: u32, s: &str, time: i64) -> Vec<u8> {
    d.replace(d.revision(), at, len, s, time).unwrap()
}
fn replica(d: &Document, id: u64) -> Document {
    Document::load(PAGE, 1, id, &d.encode_full()).unwrap()
}
fn merge(a: &mut Document, b: &mut Document) {
    let aa = a.encode_full();
    let bb = b.encode_full();
    a.apply_remote(&bb).unwrap();
    b.apply_remote(&aa).unwrap();
    assert_eq!(a.body(), b.body());
    assert_eq!(a.snapshot().unwrap().lines, b.snapshot().unwrap().lines);
}
#[test]
fn utf16_and_graphemes() {
    assert_eq!(utf16_to_byte("中😀e\u{301}", 3).unwrap(), 7);
    assert!(utf16_to_byte("中😀", 2).is_err());
    assert!(utf16_to_byte("e\u{301}", 1).is_err());
    let mut d = new();
    put(&mut d, 0, 0, "中😀e\u{301}", 1);
    assert!(matches!(
        d.replace(d.revision(), 2, 0, "a", 2),
        Err(Error::InvalidOffset)
    ));
    put(&mut d, 1, 2, "文", 3);
    assert_eq!(d.body(), "中文e\u{301}");
}
#[test]
fn split_concurrent_right_edit() {
    let mut a = new();
    put(&mut a, 0, 0, "abcdef", 10);
    let mut b = replica(&a, 2);
    put(&mut a, 3, 0, "\n", 20);
    put(&mut b, 5, 1, "X", 30);
    merge(&mut a, &mut b);
    let s = a.snapshot().unwrap();
    assert_eq!(s.body, "abc\ndeX");
    assert_eq!(s.lines[0].first_ms, Some(10));
    assert_eq!(s.lines[0].last_ms, Some(20));
    assert_eq!(s.lines[1].first_ms, Some(10));
    assert_eq!(s.lines[1].last_ms, Some(30));
}
#[test]
fn merge_concurrent_right_edit() {
    let mut a = new();
    put(&mut a, 0, 0, "abc", 10);
    put(&mut a, 3, 0, "\n", 20);
    put(&mut a, 4, 0, "def", 30);
    let mut b = replica(&a, 2);
    put(&mut a, 3, 1, "", 40);
    put(&mut b, 5, 1, "X", 50);
    merge(&mut a, &mut b);
    let s = a.snapshot().unwrap();
    assert_eq!(s.body, "abcdXf");
    assert_eq!(s.lines[0].first_ms, Some(10));
    assert_eq!(s.lines[0].last_ms, Some(50));
}
#[test]
fn new_empty_line_first_is_unset() {
    let mut d = new();
    put(&mut d, 0, 0, "abc", 10);
    put(&mut d, 3, 0, "\n", 20);
    let s = d.snapshot().unwrap();
    assert_eq!(s.lines[1].first_ms, None);
    put(&mut d, 4, 0, "def", 30);
    let s = d.snapshot().unwrap();
    assert_eq!(s.lines[1].first_ms, Some(30));
    assert_eq!(s.lines[0].last_ms, Some(20));
}
#[test]
fn empty_lines_and_clearing() {
    let mut d = new();
    put(&mut d, 0, 0, "abc\n\ndef\n", 10);
    let s = d.snapshot().unwrap();
    assert_eq!(s.lines.len(), 4);
    assert_eq!(s.lines[1].first_ms, None);
    assert_eq!(s.lines[3].first_ms, None);
    let id = s.lines[0].id.clone();
    put(&mut d, 0, 3, "", 20);
    let s = d.snapshot().unwrap();
    assert_eq!(s.lines[0].id, id);
    assert_eq!(s.lines[0].first_ms, Some(10));
    assert_eq!(s.lines[0].last_ms, Some(20));
}
#[test]
fn duplicate_out_of_order_updates() {
    let mut a = new();
    let initial = a.encode_full();
    let u1 = put(&mut a, 0, 0, "abc", 10);
    let u2 = put(&mut a, 3, 0, "\nDEF", 20);
    let mut b = Document::load(PAGE, 1, 2, &initial).unwrap();
    b.apply_remote(&u2).unwrap();
    b.apply_remote(&u1).unwrap();
    b.apply_remote(&u2).unwrap();
    assert_eq!(a.snapshot().unwrap().lines, b.snapshot().unwrap().lines);
}
#[test]
fn concurrent_newlines_have_unique_ids_and_no_inheritance() {
    let mut a = new();
    put(&mut a, 0, 0, "ab", 10);
    let mut b = replica(&a, 2);
    put(&mut a, 1, 0, "\n", 20);
    put(&mut b, 1, 0, "\n", 30);
    merge(&mut a, &mut b);
    assert_eq!(a.body(), "a\n\nb");
    let ids: std::collections::HashSet<_> = a
        .snapshot()
        .unwrap()
        .lines
        .iter()
        .map(|l| l.id.clone())
        .collect();
    assert_eq!(ids.len(), 3);
    put(&mut a, 2, 0, "x\ny", 40);
    assert_eq!(a.snapshot().unwrap().lines.len(), 4);
}
#[test]
fn stale_edit_and_identity_rejection() {
    let mut a = new();
    let r = a.revision();
    put(&mut a, 0, 0, "x", 10);
    assert!(matches!(
        a.replace(r, 0, 0, "lost", 20),
        Err(Error::StaleRevision)
    ));
    let other = Document::new("c0897f09-23e4-4ab1-a4f1-5da930bb8103", 1, 2).unwrap();
    assert!(a.apply_remote(&other.encode_full()).is_err());
    assert_eq!(a.body(), "x");
}
#[test]
fn undo_preserves_remote_and_line_identity() {
    let mut a = new();
    put(&mut a, 0, 0, "abc", 10);
    let mut b = replica(&a, 2);
    put(&mut a, 1, 0, "\n", 20);
    let id = a.snapshot().unwrap().lines[1].id.clone();
    put(&mut b, 3, 0, "REMOTE", 30);
    merge(&mut a, &mut b);
    a.undo(40).unwrap();
    assert_eq!(a.body(), "abcREMOTE");
    assert_eq!(a.snapshot().unwrap().lines[0].last_ms, Some(40));
    a.redo(50).unwrap();
    let s = a.snapshot().unwrap();
    assert_eq!(s.body, "a\nbcREMOTE");
    assert_eq!(s.lines[1].id, id);
    assert_eq!(s.lines[1].first_ms, Some(10));
    assert_eq!(s.lines[1].last_ms, Some(50));
}
#[test]
fn yjs_reverse_interop() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../write-sync-worker/tests/yjs-v1.json");
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
    let base = STANDARD.decode(value["base"].as_str().unwrap()).unwrap();
    let mut d = Document::load(PAGE, 1, 999, &base).unwrap();
    let u = STANDARD.decode(value["update"].as_str().unwrap()).unwrap();
    d.apply_remote(&u).unwrap();
    assert_eq!(d.body(), value["expectedBody"].as_str().unwrap());
}
#[test]
fn pasted_new_middle_line_has_new_first() {
    let mut d = new();
    put(&mut d, 0, 0, "abcd", 10);
    put(&mut d, 2, 0, "\nnew\n", 20);
    let s = d.snapshot().unwrap();
    assert_eq!(s.body, "ab\nnew\ncd");
    assert_eq!(
        s.lines.iter().map(|l| l.first_ms).collect::<Vec<_>>(),
        vec![Some(10), Some(20), Some(10)]
    );
}
#[test]
fn incremental_keyboard_matches_provenance_replay() {
    let mut d = new();
    put(&mut d, 0, 0, "alpha\nbeta\n", 100);
    let edits = [
        (1, 0, "中", 101),
        (3, 1, "", 102),
        (6, 0, "😀", 103),
        (2, 1, "Z", 90),
        (0, 1, "", 200),
    ];
    for (a, n, t, at) in edits {
        put(&mut d, a, n, t, at);
        assert_eq!(d.snapshot().unwrap(), d.verify_snapshot().unwrap());
    }
}
#[test]
fn randomized_incremental_matches_full_reducer() {
    let mut d = new();
    let mut seed = 1u64;
    for i in 0..250 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let body = d.body();
        let n = body.len() as u32;
        let at = (seed >> 32) as u32 % (n + 1);
        let delete = if at < n && seed.is_multiple_of(4) {
            1
        } else {
            0
        };
        let inserted = match seed % 7 {
            0 => "\n",
            1 => "X\nY",
            2 => "",
            _ => "a",
        };
        put(&mut d, at, delete, inserted, 100 + (i % 31));
        assert_eq!(
            d.snapshot().unwrap(),
            d.verify_snapshot().unwrap(),
            "step {i}, edit {at}/{delete}/{inserted:?}"
        );
    }
}
#[test]
fn concurrent_operations_permutations_converge() {
    for round in 0..16 {
        let mut a = new();
        put(&mut a, 0, 0, "alpha\nbeta\ngamma", 10);
        let mut b = replica(&a, 2);
        let mut c = replica(&a, 3);
        let aa = put(&mut a, (round % 5) as u32, 0, "A\n", 20);
        let bb = put(&mut b, 6 + (round % 4) as u32, 1, "B", 30);
        let cc = put(&mut c, 5, 1, "", 40);
        a.apply_remote(&cc).unwrap();
        a.apply_remote(&bb).unwrap();
        b.apply_remote(&aa).unwrap();
        b.apply_remote(&cc).unwrap();
        c.apply_remote(&bb).unwrap();
        c.apply_remote(&aa).unwrap();
        let sa = a.snapshot().unwrap();
        assert_eq!(sa.lines, b.snapshot().unwrap().lines);
        assert_eq!(sa.lines, c.snapshot().unwrap().lines);
    }
}
#[test]
fn one_item_clients_do_not_break_anchor_index() {
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, ReadTxn, StateVector, Text, Transact, Update};
    let mut d = new();
    put(&mut d, 0, 0, "abcdef", 10);
    for (client, pos) in [(991, 2), (992, 5)] {
        let peer = Doc::with_client_id(client);
        let t = peer.get_or_insert_text("body");
        peer.transact_mut()
            .apply_update(Update::decode_v1(&d.encode_full()).unwrap())
            .unwrap();
        t.insert(&mut peer.transact_mut(), pos, "X");
        d.apply_remote(
            &peer
                .transact()
                .encode_state_as_update_v1(&StateVector::default()),
        )
        .unwrap();
        assert_eq!(d.snapshot().unwrap(), d.verify_snapshot().unwrap());
    }
}
#[test]
fn remote_cannot_remove_timing_events_or_change_root() {
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, Map, ReadTxn, StateVector, Transact, Update};
    let mut d = new();
    put(&mut d, 0, 0, "text", 10);
    let before = d.snapshot().unwrap();
    let peer = Doc::with_client_id(999);
    peer.transact_mut()
        .apply_update(Update::decode_v1(&d.encode_full()).unwrap())
        .unwrap();
    let timing = peer.get_or_insert_map("timing");
    timing.clear(&mut peer.transact_mut());
    assert!(d
        .apply_remote(
            &peer
                .transact()
                .encode_state_as_update_v1(&StateVector::default())
        )
        .is_err());
    assert_eq!(d.snapshot().unwrap(), before);
    let root_peer = Doc::with_client_id(998);
    root_peer
        .transact_mut()
        .apply_update(Update::decode_v1(&d.encode_full()).unwrap())
        .unwrap();
    root_peer.get_or_insert_map("page").insert(
        &mut root_peer.transact_mut(),
        "root_line_id",
        uuid::Uuid::new_v4().to_string(),
    );
    assert!(d
        .apply_remote(
            &root_peer
                .transact()
                .encode_state_as_update_v1(&StateVector::default())
        )
        .is_err());
    assert_eq!(d.snapshot().unwrap(), before);
}

#[test]
fn undo_all_and_redo_keep_first_written_time() {
    let mut d = new();
    put(&mut d, 0, 0, "original", 10);
    d.undo(20).unwrap();
    let s = d.snapshot().unwrap();
    assert_eq!(s.lines[0].text, "");
    assert_eq!(s.lines[0].first_ms, Some(10));
    assert_eq!(s.lines[0].last_ms, Some(20));
    d.redo(30).unwrap();
    let s = d.snapshot().unwrap();
    assert_eq!(s.lines[0].text, "original");
    assert_eq!(s.lines[0].first_ms, Some(10));
    assert_eq!(s.lines[0].last_ms, Some(30));
    assert_eq!(s, d.verify_snapshot().unwrap());
}

#[test]
fn loading_a_used_actor_id_is_rejected() {
    let mut d = new();
    put(&mut d, 0, 0, "one", 10);
    assert!(Document::load(PAGE, 1, 1, &d.encode_full()).is_err());
    assert!(Document::load(PAGE, 1, d.fresh_client_id(), &d.encode_full()).is_ok());
}
#[test]
fn final_peer_surrogate_pair_survives_anchor_index() {
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, ReadTxn, StateVector, Text, Transact, Update};
    let mut d = new();
    put(&mut d, 0, 0, "ab", 10);
    let peer = Doc::with_options(yrs::Options {
        client_id: 777,
        offset_kind: yrs::OffsetKind::Utf16,
        ..Default::default()
    });
    let text = peer.get_or_insert_text("body");
    peer.transact_mut()
        .apply_update(Update::decode_v1(&d.encode_full()).unwrap())
        .unwrap();
    text.insert(&mut peer.transact_mut(), 1, "😀");
    let update = peer
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    d.apply_remote(&update).unwrap();
    assert_eq!(d.body(), "a😀b");
    assert_eq!(d.snapshot().unwrap(), d.verify_snapshot().unwrap());
}

#[test]
fn snapshot_recovery_forks_identity_and_preserves_time_without_fake_creation() {
    let mut d = new();
    put(&mut d, 0, 0, "one\ntwo", 10);
    d.replace_from_source(d.revision(), 4, 0, "I", 20, "import")
        .unwrap();
    let old = d.snapshot().unwrap();
    assert!(Document::fork_snapshot(&old, PAGE, 22).is_err());
    let fork = Document::fork_snapshot(&old, "80560b45-622d-47e2-a34e-38f9fa0d6b49", 22).unwrap();
    let s = fork.snapshot().unwrap();
    assert_eq!(s.lines, old.lines);
    assert_eq!(s.body, old.body);
    assert_ne!(s.page_id, old.page_id);
    let loaded = Document::load(&s.page_id, 1, 23, &fork.encode_full()).unwrap();
    assert_eq!(loaded.snapshot().unwrap().lines, old.lines);
    let unknown = Document::import_unknown("legacy\n", PAGE, 77)
        .unwrap()
        .snapshot()
        .unwrap();
    assert!(unknown
        .lines
        .iter()
        .all(|l| l.first_ms.is_none() && l.last_ms.is_none() && l.time_source == "unknown"));
}
#[test]
fn redo_paste_keeps_new_middle_line_first_time() {
    let mut d = new();
    put(&mut d, 0, 0, "abcd", 10);
    put(&mut d, 2, 0, "\nnew\n", 20);
    assert_eq!(d.snapshot().unwrap().lines[1].first_ms, Some(20));
    d.undo(30).unwrap();
    d.redo(40).unwrap();
    assert_eq!(d.snapshot().unwrap().lines[1].first_ms, Some(20));
}
#[test]
fn invalid_pending_update_cannot_poison_live_state_when_dependency_arrives() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/pending-invalid-v1.json")).unwrap();
    let decode = |key: &str| STANDARD.decode(fixture[key].as_str().unwrap()).unwrap();
    let mut d = Document::load(PAGE, 1, 98, &decode("base")).unwrap();
    d.apply_remote(&decode("pendingInvalid")).unwrap();
    let last_good = d.encode_full();
    assert_eq!(d.body(), "safe");
    assert!(d.apply_remote(&decode("dependency")).is_err());
    assert_eq!(d.body(), "safe");
    assert_eq!(d.encode_full(), last_good);
    let mut reopened = Document::load(PAGE, 1, 99, &last_good).unwrap();
    assert!(reopened.apply_remote(&decode("dependency")).is_err());
    let merged = write_core::merge_wire_updates(&[
        decode("pendingInvalid"),
        decode("dependency"),
        decode("base"),
    ])
    .unwrap();
    assert!(Document::load(PAGE, 1, 99, &merged).is_err());
}

#[test]
fn stable_selection_tracks_remote_emoji_and_undo() {
    fn send<T: Send>() {}
    send::<write_core::SelectionAnchor>();
    send::<write_core::PreparedRemote>();
    let mut d = new();
    put(&mut d, 0, 0, "A👩‍💻B", 10);
    let selection = d.anchor_selection(1, 5).unwrap();
    let caret = d.anchor_selection(6, 0).unwrap();
    let mut remote = replica(&d, 2);
    let u = put(&mut remote, 0, 0, "😀", 20);
    d.apply_remote(&u).unwrap();
    assert_eq!(d.resolve_selection(&selection).unwrap(), (3, 5));
    assert_eq!(d.resolve_selection(&caret).unwrap(), (8, 0));
    put(&mut d, 8, 0, "X", 30);
    d.undo(40).unwrap();
    assert_eq!(d.resolve_selection(&selection).unwrap(), (3, 5));
    let mut combining = new();
    put(&mut combining, 0, 0, "a", 1);
    let caret = combining.anchor_selection(1, 0).unwrap();
    put(&mut combining, 1, 0, "\u{301}", 2);
    assert_eq!(combining.resolve_selection(&caret).unwrap(), (2, 0));
}
#[test]
fn prepared_remote_commits_only_matching_causal_revision() {
    let mut d = new();
    put(&mut d, 0, 0, "base", 10);
    let mut worker = Document::restore(PAGE, 1, 22, &d.encode_full(), d.revision()).unwrap();
    let mut remote = replica(&d, 2);
    let u = put(&mut remote, 4, 0, "R", 20);
    let prepared = worker.prepare_remote(&u).unwrap();
    d.commit_prepared(prepared).unwrap();
    worker.apply_remote(&u).unwrap();
    assert_eq!(d.body(), "baseR");
    assert_eq!(
        d.snapshot().unwrap().lines,
        worker.snapshot().unwrap().lines
    );
    let late = put(&mut remote, 5, 0, "!", 21);
    let prepared = worker.prepare_remote(&late).unwrap();
    put(&mut d, 0, 0, "L", 30);
    assert!(matches!(
        d.commit_prepared(prepared),
        Err(Error::StaleRevision)
    ));
    assert_eq!(d.body(), "LbaseR");
}

#[test]
fn future_pending_clocks_of_the_active_actor_are_rejected() {
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, Text, Transact, Update};
    let mut d = new();
    put(&mut d, 0, 0, "safe", 10);
    let peer = Doc::with_client_id(1);
    let text = peer.get_or_insert_text("body");
    peer.transact_mut()
        .apply_update(Update::decode_v1(&d.encode_full()).unwrap())
        .unwrap();
    text.insert(&mut peer.transact_mut(), 4, "X");
    let future = {
        let mut txn = peer.transact_mut();
        text.insert(&mut txn, 5, "Y");
        txn.encode_update_v1()
    };
    assert!(d.apply_remote(&future).is_err());
    assert_eq!(d.body(), "safe");
    put(&mut d, 4, 0, "L", 20);
    assert_eq!(d.body(), "safeL");
}
