use base64::{engine::general_purpose::STANDARD, Engine};
use write_core::Document;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, ReadTxn, Transact, Update};
fn main() {
    let page = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
    let mut d = Document::new(page, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "safe", 10).unwrap();
    let base = d.encode_full();
    let peer = Doc::with_client_id(777);
    peer.transact_mut()
        .apply_update(Update::decode_v1(&base).unwrap())
        .unwrap();
    let vector = peer.transact().state_vector();
    peer.get_or_insert_map("page")
        .insert(&mut peer.transact_mut(), "epoch", 1i64);
    let dependency = peer.transact().encode_state_as_update_v1(&vector);
    let page_map = peer.get_or_insert_map("page");
    let pending = {
        let mut txn = peer.transact_mut();
        page_map.insert(&mut txn, "epoch", 2i64);
        txn.encode_update_v1()
    };
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"pageId":page,"epoch":1,"base":STANDARD.encode(base),"dependency":STANDARD.encode(dependency),"pendingInvalid":STANDARD.encode(pending),"expectedLastGood":"safe"})).unwrap());
}
