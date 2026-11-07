use base64::{engine::general_purpose::STANDARD, Engine};
use write_core::Document;
fn main() {
    let page = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
    let mut source = Document::new(page, 1, 1).unwrap();
    source
        .replace(source.revision(), 0, 0, "original\ntext", 10)
        .unwrap();
    source
        .replace_from_source(source.revision(), 0, 0, "I", 20, "import")
        .unwrap();
    let page = "80560b45-622d-47e2-a34e-38f9fa0d6b49";
    let fork = Document::fork_snapshot(&source.snapshot().unwrap(), page, 2).unwrap();
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"pageId":page,"full":STANDARD.encode(fork.encode_full()),"expected":fork.snapshot().unwrap()})).unwrap());
}
