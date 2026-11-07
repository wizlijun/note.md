use std::time::Instant;
use write_core::{render::SourceMap, CandidateSession, Document};
fn main() {
    let path = std::env::args().nth(1).expect("fixture");
    let bytes = std::fs::read(path).unwrap();
    let page = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
    let mut active = Document::load(page, 1, 901, &bytes).unwrap();
    let mut remote = Document::load(page, 1, 903, &bytes).unwrap();
    let seed = Instant::now();
    let mut session =
        CandidateSession::new(page, 1, active.client_id(), &bytes, active.revision()).unwrap();
    let seed_ms = seed.elapsed().as_secs_f64() * 1000.;
    let mut samples = vec![];
    for i in 0..30 {
        let at = active.body().encode_utf16().count() as u32;
        let local = active
            .replace(active.revision(), at, 0, "L", 200000 + i)
            .unwrap();
        let remote_update = remote
            .replace(remote.revision(), 0, 0, "R", 200000 + i)
            .unwrap();
        let start = Instant::now();
        session.receive_remote(&remote_update).unwrap();
        // Simulates the input that advances the revision during remote preparation.
        session.advance_local(active.revision(), &local).unwrap();
        let prepared = session.prepare_current().unwrap().unwrap();
        let token = prepared.commit_token().unwrap();
        let prepare_ms = start.elapsed().as_secs_f64() * 1000.;
        let commit = Instant::now();
        active.commit_prepared(prepared).unwrap();
        let snapshot = active.snapshot().unwrap();
        let _render = SourceMap::new(&snapshot.body, active.revision());
        let commit_ms = commit.elapsed().as_secs_f64() * 1000.;
        session.ack_committed(token).unwrap();
        assert_eq!(snapshot.body.matches('R').count(), i as usize + 1);
        samples.push((prepare_ms, commit_ms));
    }
    let mut total: Vec<_> = samples.iter().map(|(a, b)| a + b).collect();
    total.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::json!({"scenario":"persistent candidate, actual prior per-key history; one concurrent local key per remote","body_units":bytes.len(),"seed_ms":seed_ms,"samples":samples,"p95_local_pipeline_ms":total[28],"p95_with_100ms_RTT_ms":total[28]+100.})
    );
}
