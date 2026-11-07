use base64::{engine::general_purpose::STANDARD, Engine};
use write_core::Document;
fn main() {
    let page = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
    let mut a = Document::new(page, 1, 100).unwrap();
    a.replace(a.revision(), 0, 0, "中文😀abcdef", 100).unwrap();
    let base = a.encode_full();
    let mut b = Document::load(page, 1, 200, &base).unwrap();
    let ua = a.replace(a.revision(), 7, 0, "\n", 200).unwrap();
    let ub = b.replace(b.revision(), 9, 1, "X", 300).unwrap();
    a.apply_remote(&ub).unwrap();
    b.apply_remote(&ua).unwrap();
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"yrs":"0.24.0","protocol":1,"pageId":page,"epoch":1,"base":STANDARD.encode(base),"updates":[STANDARD.encode(ua),STANDARD.encode(ub)],"full":STANDARD.encode(a.encode_full()),"stateVector":STANDARD.encode(a.state_vector()),"expected":a.snapshot().unwrap()})).unwrap());
}
