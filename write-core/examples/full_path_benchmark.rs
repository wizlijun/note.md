use std::time::Instant;
use write_core::{render::SourceMap, Document};
fn main() {
    let mut d = Document::new("87d92d1a-f37d-46e8-b83e-dc3e671fb425", 1, 90).unwrap();
    d.replace(
        d.revision(),
        0,
        0,
        &("中".repeat(99000) + &"\n".repeat(1000)),
        1,
    )
    .unwrap();
    d.snapshot().unwrap();
    for i in 0..1000 {
        d.replace(d.revision(), 50000, 0, "字", i + 2).unwrap();
    }
    let mut samples = Vec::new();
    for i in 0..10 {
        let t = Instant::now();
        d.replace(d.revision(), 50000, 0, "\n", 2000 + i).unwrap();
        let snap = d.snapshot().unwrap();
        let rendered = SourceMap::new(&snap.body, d.revision());
        samples.push(t.elapsed().as_secs_f64() * 1000.);
        assert!(!rendered.document.text.is_empty());
    }
    println!(
        "{}",
        serde_json::json!({"scenario":"100k chars + 1000 commits, newline + snapshot + rendering; release, no physical input","samples_ms":samples})
    );
}
