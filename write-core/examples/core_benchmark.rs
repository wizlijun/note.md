use std::time::Instant;
use write_core::Document;
fn main() {
    let page = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
    let mut d = Document::new(page, 1, 99).unwrap();
    let body = "中".repeat(99_000) + &"\n".repeat(1_000);
    d.replace(d.revision(), 0, 0, &body, 1).unwrap();
    let mut samples = Vec::new();
    for i in 0..1000 {
        let t = Instant::now();
        d.replace(d.revision(), 50000, 0, "字", i + 2).unwrap();
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::json!({"scenario":"100k chars + 1000 commits; release core, not physical input latency","p50_ms":samples[500],"p95_ms":samples[950],"max_ms":samples[999],"snapshot_bytes":d.encode_full().len()})
    );
}
