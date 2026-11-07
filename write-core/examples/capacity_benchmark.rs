use std::time::Instant;
use write_core::Document;
fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "typing".into());
    let count = std::env::args()
        .nth(2)
        .map(|n| n.parse::<usize>().unwrap())
        .unwrap_or(100_000);
    let mut d = Document::new("87d92d1a-f37d-46e8-b83e-dc3e671fb425", 1, 91).unwrap();
    let begin = Instant::now();
    if mode == "short-lines" {
        let update = d
            .replace(d.revision(), 0, 0, &"中\n".repeat(count / 2), 1)
            .unwrap();
        let t = Instant::now();
        let snapshot = d.snapshot().unwrap();
        println!(
            "{}",
            serde_json::json!({"scenario":mode,"chars":count,"lines":snapshot.lines.len(),"snapshot_bytes":d.encode_full().len(),"update_bytes":update.len(),"snapshot_ms":t.elapsed().as_secs_f64()*1000.,"total_s":begin.elapsed().as_secs_f64()})
        );
    } else {
        for i in 0..count {
            d.replace(d.revision(), i as u32, 0, "中", i as i64 + 1)
                .unwrap();
            if (i + 1) % 10_000 == 0 {
                let bytes = d.encode_full();
                std::fs::write(format!("/tmp/sumi-typing-{}.bin", i + 1), &bytes).unwrap();
                println!(
                    "{}",
                    serde_json::json!({"scenario":mode,"edits":i+1,"snapshot_bytes":bytes.len(),"elapsed_s":begin.elapsed().as_secs_f64()})
                );
            }
        }
    }
}
