use write_core::{Document, render::{SourceMap, TextRange, TypingStyle}};
const PAGE: &str = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
fn fixture(source: &str) -> Document {
    let mut doc = Document::new(PAGE, 1, 1).unwrap();
    if !source.is_empty() { doc.replace(0, 0, 0, source, 1).unwrap(); }
    doc
}
fn insert(doc: &mut Document, at: u32, text: &str, markdown: bool, style: TypingStyle) -> TextRange {
    let map = SourceMap::new(&doc.body(), doc.revision());
    let before = doc.revision();
    let (_, selection) = map.apply_typing_insert(doc, &TextRange { start: at, length: 0 }, text, markdown, style, 10).unwrap_or_else(|e| panic!("source={} insert={text:?} at={at} {e}", doc.body()));
    assert_eq!(doc.revision(), before + 1);
    selection
}
fn style_at(doc: &Document, at: u32) -> TypingStyle {
    let map = SourceMap::new(&doc.body(), doc.revision());
    let mut style = TypingStyle::default();
    for r in &map.document.runs {
        if r.range.start <= at && at < r.range.start + r.range.length { style.bold |= r.bold; style.italic |= r.italic; style.strike |= r.strike; }
    }
    style
}
#[test]
fn input_intent_is_ephemeral_and_ime_commit_is_one_undoable_transaction() {
    let mut doc = fixture("left  right");
    let original = doc.body(); let revision = doc.revision(); let snapshot = doc.snapshot().unwrap();
    let mut style = SourceMap::new(&original, revision).typing_style(&TextRange { start: 5, length: 0 }).unwrap();
    style.toggle("bold"); style.toggle("italic"); style.toggle("strike");
    assert_eq!(doc.revision(), revision); assert_eq!(doc.snapshot().unwrap(), snapshot);
    let caret = insert(&mut doc, 5, "中文😀", false, style);
    assert_eq!(caret.start, 9);
    assert_eq!(SourceMap::new(&doc.body(), 0).document.text, "left 中文😀 right");
    assert_eq!(style_at(&doc, 5), style); assert_eq!(style_at(&doc, 9), TypingStyle::default());
    doc.undo(20).unwrap(); assert_eq!(doc.body(), original);
    doc.redo(21).unwrap(); assert_eq!(style_at(&doc, 5), style);
}
#[test]
fn continuous_typing_toggles_off_without_styling_following_text() {
    let mut doc = fixture("tail"); let bold = TypingStyle { bold: true, ..Default::default() };
    let a = insert(&mut doc, 0, "中", false, bold);
    let b = insert(&mut doc, a.start, "abc", false, bold);
    assert_eq!(doc.body(), "**中abc**tail");
    insert(&mut doc, b.start, "off", false, TypingStyle::default());
    assert_eq!(doc.body(), "**中abc**offtail");
    assert_eq!(style_at(&doc, 4), TypingStyle::default());
    for (source, point, expected) in [("**abcd**", 2, "**ab**x**cd**"), ("**abcd**", 0, "x**abcd**"), ("**abcd**", 4, "**abcd**x")] {
        let mut doc = fixture(source); insert(&mut doc, point, "x", false, TypingStyle::default());
        assert_eq!(doc.body(), expected);
    }
}
#[test]
fn nested_style_boundaries_whitespace_and_lf_preserve_visible_text() {
    for source in ["***abcd***", "~~**abcd**~~", "**a *bc* d**"] {
        let mut doc = fixture(source); let map = SourceMap::new(source, 0); let expected = format!("{}X{}", &map.document.text[..2], &map.document.text[2..]);
        insert(&mut doc, 2, "X", false, TypingStyle { italic: true, ..Default::default() });
        assert_eq!(SourceMap::new(&doc.body(), 0).document.text, expected, "{}", doc.body());
        assert_eq!(style_at(&doc, 2), TypingStyle { italic: true, ..Default::default() }, "{}", doc.body());
    }
    let mut doc = fixture(""); let bold = TypingStyle { bold: true, ..Default::default() };
    let a = insert(&mut doc, 0, "a", false, bold);
    let space = insert(&mut doc, a.start, " ", false, bold);
    let b = insert(&mut doc, space.start, "b\nplain", false, bold);
    assert_eq!(SourceMap::new(&doc.body(), 0).document.text, "a b\nplain");
    assert!(style_at(&doc, 0).bold && style_at(&doc, 2).bold);
    assert!(!style_at(&doc, 4).bold); assert_eq!(b.start, 9);
    let mut punctuation = fixture("word"); insert(&mut punctuation, 4, "!", false, bold);
    assert_eq!(SourceMap::new(&punctuation.body(), 0).document.text, "word!");
    let mut emoji_boundary = fixture("**bold**tail"); insert(&mut emoji_boundary, 4, "😀", false, bold);
    assert_eq!(SourceMap::new(&emoji_boundary.body(), 0).document.text, "bold😀tail");
}
#[test]
fn pending_style_applies_to_markdown_paste_atomically_and_preserves_unknown_blocks() {
    let bold = TypingStyle { bold: true, ..Default::default() };
    for input in ["hello *world*", "**bold** and plain", "- item", "# title", "[link](https://example.com)"] {
        let mut doc = fixture(""); insert(&mut doc, 0, input, true, bold);
        let old = SourceMap::new(input, 0); let new = SourceMap::new(&doc.body(), 0);
        assert_eq!(new.document.text, old.document.text, "{}", doc.body());
        assert!(style_at(&doc, 0).bold, "{}", doc.body());
        doc.undo(20).unwrap(); assert_eq!(doc.body(), "");
    }
    let mut multiline = fixture(""); insert(&mut multiline, 0, "first\nsecond", true, bold);
    assert!(style_at(&multiline, 0).bold); assert!(!style_at(&multiline, 6).bold);
    let mut code = fixture(""); let original = "```rs\nlet x = 1;\n```";
    insert(&mut code, 0, original, true, bold); assert_eq!(code.body(), original);
    let mut nested = fixture("**left right**"); insert(&mut nested, 5, "*new*", true, bold);
    assert_eq!(SourceMap::new(&nested.body(), 0).document.text, "left newright");
    assert!(style_at(&nested, 5).bold && style_at(&nested, 5).italic);
}
#[test]
fn styled_input_and_peer_edit_merge_and_local_undo_keeps_peer_text() {
    let mut local = fixture("tail"); let mut peer = Document::load(PAGE, 1, 2, &local.encode_full()).unwrap();
    insert(&mut local, 0, "中文", false, TypingStyle { bold: true, ..Default::default() });
    let remote = peer.replace(peer.revision(), 4, 0, " remote", 11).unwrap(); local.apply_remote(&remote).unwrap();
    local.undo(20).unwrap(); assert_eq!(local.body(), "tail remote");
}
#[test]
fn explicit_plain_intent_keeps_literals_and_hard_break_exits_the_span() {
    let mut plain = fixture("1");
    insert(&mut plain, 1, ".", false, TypingStyle::default());
    insert(&mut plain, 2, " ", false, TypingStyle::default());
    assert_eq!(SourceMap::new(&plain.body(), 0).document.text, "1. ");
    let mut strong = fixture("**a**");
    insert(&mut strong, 1, "  \n", true, TypingStyle { bold: true, ..Default::default() });
    assert_eq!(strong.body(), "**a**  \n");
    assert_eq!(SourceMap::new(&strong.body(), 0).document.text, "a  \n");
    let map = SourceMap::new("**abcd**", 1); let mut replacement = fixture("**abcd**");
    map.apply_typing_insert(&mut replacement, &TextRange { start: 1, length: 2 }, "新", false, TypingStyle { italic: true, ..Default::default() }, 2).unwrap();
    assert_eq!(SourceMap::new(&replacement.body(), 0).document.text, "a新d");
    assert_eq!(style_at(&replacement, 1), TypingStyle { italic: true, ..Default::default() });
}
