use std::time::Instant;
use write_core::{render::SourceMap, Document};
fn main() {
    let path = std::env::args().nth(1).expect("full-state fixture path");
    let bytes = std::fs::read(path).unwrap();
    let begin = Instant::now();
    let mut d = Document::load("87d92d1a-f37d-46e8-b83e-dc3e671fb425", 1, 902, &bytes).unwrap();
    let load_ms = begin.elapsed().as_secs_f64() * 1000.;
    let begin = Instant::now();
    let at = d.body().encode_utf16().count() as u32 / 2;
    let update = d.replace(d.revision(), at, 0, "\n", 200000).unwrap();
    let snap = d.snapshot().unwrap();
    let _render = SourceMap::new(&snap.body, d.revision());
    println!(
        "{}",
        serde_json::json!({"full_bytes":bytes.len(),"load_ms":load_ms,"newline_snapshot_render_ms":begin.elapsed().as_secs_f64()*1000.,"newline_update_bytes":update.len()})
    );
}
