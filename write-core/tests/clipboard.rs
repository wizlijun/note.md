use write_core::{Document, render::{SourceMap, TextRange}};
fn selection(map: &SourceMap, text: &str) -> TextRange {
    let start = map.document.text.find(text).unwrap();
    TextRange { start: map.document.text[..start].encode_utf16().count() as u32, length: text.encode_utf16().count() as u32 }
}
#[test]
fn copy_preserves_nested_markdown_links_lists_and_literal_source() {
    for (source, visible, expected) in [
        ("**bold**", "ol", "**ol**"),
        ("***both***", "oth", "***oth***"),
        ("plain **bold** tail", "ain bo", "ain **bo**"),
        ("**bold *both* end**", "ld bo", "**ld *bo***"),
        ("[hello **bold**](https://example.com)", "bold", "[**bold**](https://example.com)"),
        ("- first\n- second\n", "cond", "- cond"),
        ("> # title\n", "itl", "> # itl"),
        ("one `code` two", "`code`", "`code`"),
        ("```rust\nx < y\n```\n", "x < y", "x < y"),
        ("**😀中文**", "😀中", "**😀中**"),
        ("A &amp; B", "&", "&amp;"),
        ("[hello][id]\n\n[id]: https://example.com \"Title\"\n", "ell", "[ell][id]\n\n[id]: https://example.com \"Title\""),
    ] {
        let map = SourceMap::new(source, 0);
        assert_eq!(map.clipboard_markdown(&[selection(&map, visible)]).unwrap().trim_end(), expected, "{source}");
        assert_eq!(map.clipboard_markdown(&[TextRange { start: 0, length: map.document.text.encode_utf16().count() as u32 }]).unwrap(), source);
    }
}
#[test]
fn multi_selection_copy_cut_is_atomic_undoable_and_preserves_middle() {
    let source = "**first**\nuntouched\n[second](https://example.com)";
    let mut doc = Document::new("00000000-0000-4000-8000-000000000001", 1, 1).unwrap();
    doc.replace(0, 0, 0, source, 1).unwrap();
    let map = SourceMap::new(source, doc.revision());
    let ranges = vec![selection(&map, "second"), selection(&map, "first")];
    assert_eq!(map.clipboard_markdown(&ranges).unwrap(), "**first**\n[second](https://example.com)");
    let rev = doc.revision();
    map.cut_selections(&mut doc, &ranges, 2).unwrap();
    assert_eq!(doc.revision(), rev + 1);
    assert_eq!(doc.body(), "\nuntouched\n");
    doc.undo(3).unwrap(); assert_eq!(doc.body(), source);
    let map = SourceMap::new(&doc.body(), doc.revision());
    let before = doc.body();
    assert!(map.cut_selections(&mut doc, &[ranges[0].clone(), ranges[0].clone()], 4).is_err());
    assert_eq!(doc.body(), before);
}
#[test]
fn markdown_paste_does_not_escape_copied_syntax_and_rejects_stale_or_surrogate_ranges() {
    let mut doc = Document::new("00000000-0000-4000-8000-000000000002", 1, 2).unwrap();
    let map = SourceMap::new("", 0);
    let md = "# Head\n\n- **bold** and *italic*\n\n```rs\nlet x = 1;\n```";
    map.apply_markdown_paste(&mut doc, &TextRange::default(), md, 1).unwrap();
    assert_eq!(doc.body(), md);
    assert!(map.apply_markdown_paste(&mut doc, &TextRange::default(), "stale", 2).is_err());
    let emoji = SourceMap::new("😀", 0);
    assert!(emoji.clipboard_markdown(&[TextRange{start:1,length:1}]).is_err());
}
