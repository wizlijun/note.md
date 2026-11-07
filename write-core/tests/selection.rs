use serde_json::{json, Value};
use write_core::{
    render::{SourceMap, TextRange},
    Document, Error,
};
const PAGE: &str = "84e78293-fd0d-408f-a0e5-27d1de41e43a";
fn edit(doc: &mut Document, at: u32, length: u32, text: &str, time: i64) -> Vec<u8> {
    doc.replace(doc.revision(), at, length, text, time).unwrap()
}
fn document(text: &str) -> Document {
    let mut doc = Document::new(PAGE, 1, 1).unwrap();
    if !text.is_empty() {
        edit(&mut doc, 0, 0, text, 1);
    }
    doc
}
#[test]
fn persisted_selection_and_viewport_follow_offline_remote_edits_after_restart() {
    let doc = document("# Head\nA👩‍💻B\ntail");
    let map = SourceMap::new(&doc.body(), doc.revision());
    let selection = map
        .anchor_selection(
            &doc,
            &TextRange {
                start: 6,
                length: 5,
            },
        )
        .unwrap();
    let viewport = map
        .anchor_selection(
            &doc,
            &TextRange {
                start: 5,
                length: 0,
            },
        )
        .unwrap();
    let selected = doc.serialize_selection(&selection).unwrap();
    let scrolled = doc.serialize_selection(&viewport).unwrap();
    assert!(selected.len() < 512 && scrolled.len() < 512);
    let saved = doc.encode_full();
    let mut remote = Document::load(PAGE, 1, 2, &saved).unwrap();
    let a = edit(&mut remote, 0, 0, "intro\n", 2);
    let b = edit(&mut remote, 6, 0, "😀", 3);
    let mut reopened = Document::restore(PAGE, 1, 3, &saved, doc.revision()).unwrap();
    // Transport may deliver updates while reopening in reverse dependency order.
    reopened.apply_remote(&b).unwrap();
    reopened.apply_remote(&a).unwrap();
    let selection = reopened.deserialize_selection(&selected).unwrap();
    let viewport = reopened.deserialize_selection(&scrolled).unwrap();
    let map = SourceMap::new(&reopened.body(), reopened.revision());
    // The heading is no longer at the start after the emoji, so its '# ' is
    // visible; assert stable source coordinates rather than an assumed layout.
    let (start, length) = reopened.resolve_selection(&selection).unwrap();
    assert_eq!((start, length), (16, 5));
    assert_eq!(reopened.resolve_selection(&viewport).unwrap(), (15, 0));
    assert_eq!(
        map.resolve_selection(&reopened, &selection).unwrap().length,
        5
    );
    assert_eq!(reopened.serialize_selection(&selection).unwrap(), selected);
}
#[test]
fn anchors_are_bound_to_page_epoch_and_creation_root_even_when_actor_clocks_overlap() {
    let source = document("text");
    let anchor = source.anchor_selection(1, 0).unwrap();
    let bytes = source.serialize_selection(&anchor).unwrap();
    let same_id_new_root = document("text");
    assert!(same_id_new_root.deserialize_selection(&bytes).is_err());
    assert!(same_id_new_root.resolve_selection(&anchor).is_err());
    assert!(same_id_new_root.serialize_selection(&anchor).is_err());
    let other = Document::new("b231d47b-5fa7-410d-828f-b527fbd66358", 1, 1).unwrap();
    assert!(other.deserialize_selection(&bytes).is_err());
    assert!(other.resolve_selection(&anchor).is_err());
    let epoch = Document::new(PAGE, 2, 1).unwrap();
    assert!(epoch.deserialize_selection(&bytes).is_err());
    let replica = Document::load(PAGE, 1, 99, &source.encode_full()).unwrap();
    assert_eq!(
        replica
            .resolve_selection(&replica.deserialize_selection(&bytes).unwrap())
            .unwrap(),
        (1, 0)
    );
}
#[test]
fn untrusted_preferences_reject_wrong_roots_maps_unknown_dependencies_and_ambiguous_encoding() {
    let doc = document("A😀B");
    let bytes = doc
        .serialize_selection(&doc.anchor_selection(1, 0).unwrap())
        .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    let before = doc.encode_full();
    let mutate = |f: fn(&mut Value)| {
        let mut value = value.clone();
        f(&mut value);
        assert!(doc
            .deserialize_selection(&serde_json::to_vec(&value).unwrap())
            .is_err());
    };
    mutate(|v| v["schema"] = json!(2));
    mutate(|v| v["epoch"] = json!(2));
    mutate(|v| v["unknown"] = json!(true));
    mutate(|v| v["root_line_id"] = json!("other"));
    mutate(|v| {
        v["start"] = json!({"kind":"body","before":false,"tname":"page"});
        v["end"] = v["start"].clone();
    });
    mutate(|v| {
        v["start"] = json!({"kind":"nested","client":1,"clock":0,"before":false});
        v["end"] = v["start"].clone();
    });
    // Actor 1 clock 0 exists, but belongs to the page map, never the body.
    mutate(|v| {
        v["start"] = json!({"kind":"item","client":1,"clock":0,"before":false});
        v["end"] = v["start"].clone();
    });
    mutate(|v| {
        v["start"] = json!({"kind":"item","client":4294967296u64,"clock":0,"before":false});
        v["end"] = v["start"].clone();
    });
    mutate(|v| {
        v["start"] = json!({"kind":"item","client":3,"clock":0,"before":false});
        v["end"] = v["start"].clone();
    });
    mutate(|v| v["end"]["before"] = json!(true));
    let duplicate = String::from_utf8(bytes.clone())
        .unwrap()
        .replacen("{", "{\"schema\":1,", 1);
    assert!(doc.deserialize_selection(duplicate.as_bytes()).is_err());
    assert!(doc.deserialize_selection(b"{").is_err());
    assert!(matches!(
        doc.deserialize_selection(&vec![b' '; 1025]),
        Err(Error::Capacity)
    ));
    assert_eq!(doc.encode_full(), before);
}
#[test]
fn missing_position_is_retryable_after_local_document_receives_its_dependency() {
    let mut original = document("");
    let base = original.encode_full();
    let mut remote = Document::load(PAGE, 1, 2, &base).unwrap();
    let update = edit(&mut remote, 0, 0, "hello", 2);
    let bytes = remote
        .serialize_selection(&remote.anchor_selection(2, 0).unwrap())
        .unwrap();
    assert!(matches!(
        original.deserialize_selection(&bytes),
        Err(Error::InvalidOffset)
    ));
    original.apply_remote(&update).unwrap();
    let restored = original.deserialize_selection(&bytes).unwrap();
    assert_eq!(original.resolve_selection(&restored).unwrap(), (2, 0));
}
#[test]
fn deleted_ranges_empty_roots_and_combining_characters_remain_safe_after_restart() {
    let mut doc = document("ABCD");
    let bytes = doc
        .serialize_selection(&doc.anchor_selection(1, 2).unwrap())
        .unwrap();
    edit(&mut doc, 1, 3, "", 2);
    let loaded = Document::load(PAGE, 1, 4, &doc.encode_full()).unwrap();
    assert_eq!(
        loaded
            .resolve_selection(&loaded.deserialize_selection(&bytes).unwrap())
            .unwrap(),
        (1, 0)
    );
    let mut empty = document("");
    let bytes = empty
        .serialize_selection(&empty.anchor_selection(0, 0).unwrap())
        .unwrap();
    edit(&mut empty, 0, 0, "a\u{301}", 3);
    let loaded = Document::load(PAGE, 1, 5, &empty.encode_full()).unwrap();
    assert_eq!(
        loaded
            .resolve_selection(&loaded.deserialize_selection(&bytes).unwrap())
            .unwrap(),
        (2, 0)
    );
    let mut combining = document("a");
    let bytes = combining
        .serialize_selection(&combining.anchor_selection(1, 0).unwrap())
        .unwrap();
    edit(&mut combining, 1, 0, "\u{301}", 4);
    let loaded = Document::load(PAGE, 1, 6, &combining.encode_full()).unwrap();
    assert_eq!(
        loaded
            .resolve_selection(&loaded.deserialize_selection(&bytes).unwrap())
            .unwrap(),
        (2, 0)
    );
}
