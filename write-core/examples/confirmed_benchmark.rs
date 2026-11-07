use std::time::Instant;
use write_core::Document;
fn main() {
    let bytes = std::fs::read(std::env::args().nth(1).expect("fixture")).unwrap();
    let page = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
    let mut active = Document::load(page, 1, 901, &bytes).unwrap();
    let mut persistence = Document::restore(page, 1, 902, &bytes, active.revision()).unwrap();
    let mut times = vec![];
    for i in 0..30 {
        let at = active.body().encode_utf16().count() as u32;
        let update = active
            .replace(active.revision(), at, 0, "L", 200000 + i)
            .unwrap();
        let start = Instant::now();
        let snapshot = persistence
            .apply_confirmed_update(active.revision(), &update)
            .unwrap();
        times.push(start.elapsed().as_secs_f64() * 1000.);
        assert_eq!(snapshot, active.snapshot().unwrap());
    }
    let mut sorted = times.clone();
    sorted.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::json!({"scenario":"warm disposable persistence replica, 100k genuine edits; confirmed FIFO + complete provenance validation, excludes SQLite I/O","samples_ms":times,"p95_ms":sorted[28]})
    );
}
