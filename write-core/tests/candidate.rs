use write_core::{CandidateCommit, CandidateSession, Document, Error};
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, Text, Transact, Update};
const PAGE: &str = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
fn base() -> Document {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "abc\ndef😀", 10).unwrap();
    d
}
fn session(d: &Document) -> CandidateSession {
    CandidateSession::new(PAGE, 1, d.client_id(), &d.encode_full(), d.revision()).unwrap()
}
fn peer(d: &Document, id: u64) -> Document {
    Document::load(PAGE, 1, id, &d.encode_full()).unwrap()
}
fn commit(s: &mut CandidateSession, d: &mut Document) {
    let p = s.prepare_current().unwrap().unwrap();
    let token = p.commit_token().unwrap();
    d.commit_prepared(p).unwrap();
    s.ack_committed(token).unwrap();
    assert_eq!(d.snapshot().unwrap(), d.verify_snapshot().unwrap());
}
#[test]
fn persistent_candidate_catches_up_after_stale_preparation() {
    fn assert_send<T: Send>() {}
    assert_send::<CandidateSession>();
    assert_send::<CandidateCommit>();
    let mut d = base();
    let mut p = peer(&d, 2);
    let mut s = session(&d);
    let u = p.replace(p.revision(), 4, 1, "D", 30).unwrap();
    s.receive_remote(&u).unwrap();
    let stale = s.prepare_current().unwrap().unwrap();
    let local = d.replace(d.revision(), 1, 0, "\n", 20).unwrap();
    assert!(matches!(
        d.commit_prepared(stale),
        Err(Error::StaleRevision)
    ));
    s.advance_local(d.revision(), &local).unwrap();
    commit(&mut s, &mut d);
    assert_eq!(d.body(), "a\nbc\nDef😀");
    assert!(!s.has_pending());
    assert!(s.prepare_current().unwrap().is_none());
}
#[test]
fn later_remote_generation_survives_previous_commit_ack() {
    let mut d = base();
    let mut p = peer(&d, 2);
    let mut s = session(&d);
    let first = p.replace(p.revision(), 0, 0, "1", 20).unwrap();
    s.receive_remote(&first).unwrap();
    let prepared = s.prepare_current().unwrap().unwrap();
    let token = prepared.commit_token().unwrap();
    d.commit_prepared(prepared).unwrap();
    let second = p.replace(p.revision(), 0, 0, "2", 30).unwrap();
    s.receive_remote(&second).unwrap();
    s.ack_committed(token.clone()).unwrap();
    let local = d.replace(d.revision(), 0, 0, "L", 40).unwrap();
    s.advance_local(d.revision(), &local).unwrap();
    s.ack_committed(token).unwrap(); // idempotent while the exact confirmed hash is retained
    commit(&mut s, &mut d);
    assert!(d.body().contains('1') && d.body().contains('2') && d.body().contains('L'));
}
#[test]
fn acknowledged_record_can_already_be_in_the_trusted_journal() {
    let mut d = base();
    let mut p = peer(&d, 2);
    let mut s = session(&d);
    let u = p.replace(p.revision(), 0, 0, "X", 20).unwrap();
    s.receive_remote(&u).unwrap();
    let prepared = s.prepare_current().unwrap().unwrap();
    let token = prepared.commit_token().unwrap();
    let update = prepared.update().to_vec();
    d.commit_prepared(prepared).unwrap();
    s.advance_local(d.revision(), &update).unwrap();
    s.ack_committed(token).unwrap();
    assert!(!s.has_pending());
    s.receive_remote(&u).unwrap(); // duplicate still advances host revision once
    let old = d.revision();
    commit(&mut s, &mut d);
    assert_eq!(d.revision(), old + 1);
    assert_eq!(d.body().matches('X').count(), 1);
}
#[test]
fn candidate_replays_split_merge_undo_and_reordered_remote_updates() {
    let mut d = base();
    let mut p = peer(&d, 2);
    let mut s = session(&d);
    let mut expected = peer(&d, 3);
    let mut backlog = vec![];
    for i in 0..60 {
        let local = match i % 4 {
            0 => d.replace(d.revision(), 0, 0, "中\n", 100 + i),
            1 => d.replace(d.revision(), 0, 1, "文", 100 + i),
            2 => d.undo(100 + i),
            _ => d.redo(100 + i),
        }
        .unwrap();
        s.advance_local(d.revision(), &local).unwrap();
        expected.apply_remote(&local).unwrap();
        let update = p
            .replace(
                p.revision(),
                0,
                0,
                if i % 3 == 0 { "🙂\n" } else { "P" },
                200 + i,
            )
            .unwrap();
        backlog.push(update);
        if i % 3 == 2 {
            for u in backlog.drain(..).rev() {
                s.receive_remote(&u).unwrap();
                expected.apply_remote(&u).unwrap();
            }
            commit(&mut s, &mut d);
            assert_eq!(
                d.snapshot().unwrap().lines,
                expected.verify_snapshot().unwrap().lines
            );
        }
    }
}
#[test]
fn deferred_malicious_packet_poison_is_confined_to_candidate() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/pending-invalid-v1.json")).unwrap();
    let decode = |key: &str| STANDARD.decode(fixture[key].as_str().unwrap()).unwrap();
    let mut d = Document::load(PAGE, 1, 9, &decode("base")).unwrap();
    let mut s = session(&d);
    s.receive_remote(&decode("pendingInvalid")).unwrap();
    commit(&mut s, &mut d);
    let before = d.encode_full();
    assert!(s.receive_remote(&decode("dependency")).is_err());
    assert!(s.prepare_current().is_err());
    assert_eq!(d.encode_full(), before);
    assert_eq!(d.body(), "safe");
}
#[test]
fn immutable_timing_and_writer_future_clocks_are_rejected() {
    let d = base();
    let mut s = session(&d);
    let evil = Doc::with_client_id(1);
    evil.transact_mut()
        .apply_update(Update::decode_v1(&d.encode_full()).unwrap())
        .unwrap();
    let text = evil.get_or_insert_text("body");
    let future = {
        let mut t = evil.transact_mut();
        text.push(&mut t, "forged");
        t.encode_update_v1()
    };
    assert!(s.receive_remote(&future).is_err());
    assert!(!s.has_pending());
    let evil = Doc::with_client_id(20);
    evil.transact_mut()
        .apply_update(Update::decode_v1(&d.encode_full()).unwrap())
        .unwrap();
    let timing = evil.get_or_insert_map("timing");
    let key = {
        let t = evil.transact();
        timing.keys(&t).next().unwrap().to_string()
    };
    let altered = {
        let mut t = evil.transact_mut();
        timing.insert(&mut t, key, "[]");
        t.encode_update_v1()
    };
    assert!(s.receive_remote(&altered).is_err());
    assert!(s.prepare_current().is_err());
}
#[test]
fn revision_gap_and_wrong_session_ack_are_rejected() {
    let d = base();
    let mut p = peer(&d, 2);
    let mut s = session(&d);
    let mut other = session(&d);
    let u = p.replace(p.revision(), 0, 0, "X", 20).unwrap();
    assert!(matches!(
        s.advance_local(d.revision() + 2, &u),
        Err(Error::StaleRevision)
    ));
    s.receive_remote(&u).unwrap();
    let token = s
        .prepare_current()
        .unwrap()
        .unwrap()
        .commit_token()
        .unwrap();
    assert!(matches!(
        other.ack_committed(token),
        Err(Error::StaleRevision)
    ));
}

#[test]
fn confirmed_persistence_replica_replays_exact_fifo_and_caches_snapshot() {
    let mut live = base();
    let mut durable = Document::restore(PAGE, 1, 8, &live.encode_full(), live.revision()).unwrap();
    for i in 0..30 {
        let update = match i % 4 {
            0 => live.replace(live.revision(), 0, 0, "文\n", 100 + i),
            1 => live.replace(live.revision(), 0, 1, "字", 100 + i),
            2 => live.undo(100 + i),
            _ => live.redo(100 + i),
        }
        .unwrap();
        let snapshot = durable
            .apply_confirmed_update(live.revision(), &update)
            .unwrap();
        assert_eq!(snapshot, live.snapshot().unwrap());
        assert_eq!(snapshot, durable.verify_snapshot().unwrap());
    }
    assert!(matches!(
        durable.apply_confirmed_update(durable.revision() + 2, &[0, 0]),
        Err(Error::StaleRevision)
    ));
}

#[test]
fn confirmed_replica_still_rejects_combined_pending_poison() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/pending-invalid-v1.json")).unwrap();
    let decode = |key: &str| STANDARD.decode(fixture[key].as_str().unwrap()).unwrap();
    let mut replica = Document::load(PAGE, 1, 9, &decode("base")).unwrap();
    replica
        .apply_confirmed_update(replica.revision() + 1, &decode("pendingInvalid"))
        .unwrap();
    assert!(replica
        .apply_confirmed_update(replica.revision() + 1, &decode("dependency"))
        .is_err());
    // This disposable object is deliberately dropped. It must never be reused
    // after the error; the caller restores a separate durable checkpoint.
}
