use write_core::{Document, render::{SourceMap, TextRange}};
const PAGE: &str = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
#[test]
fn plain_indentation_stays_editable_and_roundtrips_multiple_lines() {
    let mut doc=Document::new(PAGE,1,1).unwrap();
    doc.replace(0,0,0,"中文😀\nnext",1).unwrap();
    for at in 2..5 {
        let map=SourceMap::new(&doc.body(),doc.revision());
        map.apply_format(&mut doc,&TextRange{start:0,length:map.document.text.encode_utf16().count() as u32},"indent",at).unwrap();
        let view=SourceMap::new(&doc.body(),doc.revision());
        assert!(view.document.text.starts_with(&" ".repeat((at-1) as usize*2)));
        assert!(view.source_range(&TextRange{start:6,length:0}).is_ok());
    }
    for at in 5..8 {
        let map=SourceMap::new(&doc.body(),doc.revision());
        map.apply_format(&mut doc,&TextRange{start:0,length:map.document.text.encode_utf16().count() as u32},"outdent",at).unwrap();
    }
    assert_eq!(doc.body(),"中文😀\nnext");
    let map=SourceMap::new(&doc.body(),doc.revision());
    map.apply_format(&mut doc,&TextRange{start:0,length:0},"outdent",8).unwrap();
    assert_eq!(doc.body(),"中文😀\nnext");
}
#[test]
fn selected_list_indentation_keeps_markdown_and_excludes_next_line() {
    let mut doc=Document::new(PAGE,1,1).unwrap();
    doc.replace(0,0,0,"- one\n- two\n- three",1).unwrap();
    let map=SourceMap::new(&doc.body(),doc.revision());
    map.apply_format(&mut doc,&TextRange{start:4,length:4},"indent",2).unwrap();
    assert_eq!(doc.body(),"- one\n  - two\n- three");
    let map=SourceMap::new(&doc.body(),doc.revision());
    map.apply_format(&mut doc,&TextRange{start:4,length:3},"outdent",3).unwrap();
    assert_eq!(doc.body(),"- one\n- two\n- three");
}
#[test]
fn edit_existing_link_does_not_nest_links_or_change_reference_definitions() {
    let mut doc=Document::new(PAGE,1,1).unwrap();
    doc.replace(0,0,0,"[**word**](https://old.example) next",1).unwrap();
    let map=SourceMap::new(&doc.body(),doc.revision());
    let (range,url)=map.link_target(&TextRange{start:2,length:0}).unwrap().unwrap();
    assert_eq!(url,"https://old.example");assert_eq!(range,TextRange{start:0,length:4});
    map.apply_link(&mut doc,&range,"https://new.example",2).unwrap();
    assert_eq!(doc.body(),"[**word**](<https://new.example>) next");
    assert_eq!(SourceMap::new(&doc.body(),doc.revision()).document.text,"word next");
}

#[test]
fn link_url_change_preserves_outer_emphasis_and_reference_definition() {
    for (source,expected) in [("**[word](old)**","**[word](<new>)**"),("[word][ref]\n\n[ref]: old","[word](<new>)\n\n[ref]: old")] {
        let mut doc=Document::new(PAGE,1,1).unwrap();doc.replace(0,0,0,source,1).unwrap();
        let map=SourceMap::new(&doc.body(),doc.revision());let (range,_)=map.link_target(&TextRange{start:2,length:0}).unwrap().unwrap();
        map.apply_link(&mut doc,&range,"new",2).unwrap();assert_eq!(doc.body(),expected);
    }
}
