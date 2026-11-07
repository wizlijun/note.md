use std::time::Instant;
use write_core::{render::SourceMap, Document};
fn main() {
    let bytes = std::fs::read(std::env::args().nth(1).expect("full fixture path")).unwrap();
    let page = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
    let mut active = Document::load(page, 1, 901, &bytes).unwrap();
    let worker = Document::restore(page, 1, 902, &bytes, active.revision()).unwrap();
    let mut remote = Document::load(page, 1, 903, &bytes).unwrap();
    let update = remote
        .replace(remote.revision(), 50000, 0, "REMOTE", 200000)
        .unwrap();
    let begin = Instant::now();
    let prepared = worker.prepare_remote(&update).unwrap();
    let prepare_ms = begin.elapsed().as_secs_f64() * 1000.;
    let begin = Instant::now();
    active.commit_prepared(prepared).unwrap();
    let snapshot = active.snapshot().unwrap();
    let render = SourceMap::new(&snapshot.body, active.revision());
    assert!(render.document.text.contains("REMOTE"));
    println!(
        "{}",
        serde_json::json!({"scenario":"100k genuine prior edits, remote incremental candidate prepared off-thread; not physical UI latency","prepare_ms":prepare_ms,"commit_snapshot_render_ms":begin.elapsed().as_secs_f64()*1000.,"update_bytes":update.len()})
    );
}
