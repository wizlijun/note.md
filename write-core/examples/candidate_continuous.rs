//! Real thread scheduling with continuous 100ms input. Network is represented by
//! an explicit 100ms budget, not claimed as a measured end-to-end transport RTT.
use std::{
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use write_core::{render::SourceMap, CandidateCommit, CandidateSession, Document, PreparedRemote};
enum Job {
    Local(u64, Vec<u8>),
    Remote(usize, Vec<u8>),
    Ack(CandidateCommit),
    Stop,
}
fn main() {
    let bytes = std::fs::read(std::env::args().nth(1).expect("fixture")).unwrap();
    let page = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
    let mut active = Document::load(page, 1, 901, &bytes).unwrap();
    let units = active.body().encode_utf16().count();
    let mut remote = Document::load(page, 1, 903, &bytes).unwrap();
    let mut candidate =
        CandidateSession::new(page, 1, active.client_id(), &bytes, active.revision()).unwrap();
    let (jobs, rx) = mpsc::channel();
    let (ready, prepared) = mpsc::channel::<(usize, PreparedRemote)>();
    let worker = thread::spawn(move || {
        let mut through = 0;
        while let Ok(job) = rx.recv() {
            match job {
                Job::Local(rev, u) => candidate.advance_local(rev, &u).unwrap(),
                Job::Remote(id, u) => {
                    candidate.receive_remote(&u).unwrap();
                    through = id;
                }
                Job::Ack(token) => {
                    candidate.ack_committed(token).unwrap();
                    continue;
                }
                Job::Stop => break,
            }
            if let Some(p) = candidate.prepare_current().unwrap() {
                ready.send((through, p)).unwrap();
            }
        }
    });
    let begin = Instant::now();
    let mut next_key = begin;
    let mut next_remote = begin + Duration::from_millis(40);
    let mut sent = 0;
    let mut accepted = 0;
    let mut keys = 0;
    let mut starts = vec![];
    let mut latencies = vec![];
    let mut commits = vec![];
    let mut stale = 0;
    while accepted < 30 {
        let now = Instant::now();
        assert!(
            begin.elapsed() < Duration::from_secs(30),
            "remote starvation"
        );
        if now >= next_key {
            let at = active.body().encode_utf16().count() as u32;
            let u = active
                .replace(active.revision(), at, 0, "L", 200000 + keys)
                .unwrap();
            jobs.send(Job::Local(active.revision(), u)).unwrap();
            keys += 1;
            next_key += Duration::from_millis(100);
        }
        if now >= next_remote && sent < 30 {
            let u = remote
                .replace(remote.revision(), 0, 0, "R", 300000 + sent as i64)
                .unwrap();
            starts.push(Instant::now());
            sent += 1;
            jobs.send(Job::Remote(sent, u)).unwrap();
            next_remote += Duration::from_millis(400);
        }
        while let Ok((through, p)) = prepared.try_recv() {
            let token = p.commit_token().unwrap();
            let commit = Instant::now();
            match active.commit_prepared(p) {
                Ok(()) => {
                    let s = active.snapshot().unwrap();
                    let _ = SourceMap::new(&s.body, active.revision());
                    commits.push(commit.elapsed().as_secs_f64() * 1000.);
                    for start in &starts[accepted..through] {
                        latencies.push(start.elapsed().as_secs_f64() * 1000.);
                    }
                    accepted = accepted.max(through);
                    jobs.send(Job::Ack(token)).unwrap();
                }
                Err(write_core::Error::StaleRevision) => stale += 1,
                Err(e) => panic!("{e}"),
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
    jobs.send(Job::Stop).unwrap();
    worker.join().unwrap();
    assert_eq!(active.body().matches('R').count(), 30);
    assert_eq!(active.body().matches('L').count(), keys as usize);
    let mut sorted = latencies.clone();
    sorted.sort_by(f64::total_cmp);
    commits.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::json!({"scenario":"actual separate worker; continuous input every100ms; remote every400ms; genuine prior per-key history","body_units":units,"local_keys":keys,"remote_count":accepted,"stale_preparations":stale,"remote_latency_ms":latencies,"p95_local_pipeline_ms":sorted[28],"p95_with_100ms_RTT_budget_ms":sorted[28]+100.,"max_local_pipeline_ms":sorted[29],"commit_p95_ms":commits[commits.len()*95/100]})
    );
}
