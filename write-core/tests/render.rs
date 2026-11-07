use write_core::{
    render::{SourceMap, TextRange},
    Document,
};
const PAGE: &str = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
#[test]
fn rich_projection_and_small_edit() {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(
        d.revision(),
        0,
        0,
        "# 标题\n\n**粗体**与*斜体* [链接](https://example.com)\n> 引用\n- 项目\n",
        1,
    )
    .unwrap();
    let map = SourceMap::new(&d.body(), d.revision());
    assert_eq!(map.document.text, "标题\n\n粗体与斜体 链接\n引用\n项目\n");
    assert!(map.document.runs.iter().any(|r| r.bold));
    map.apply_edit(
        &mut d,
        &TextRange {
            start: 4,
            length: 1,
        },
        "新",
        2,
    )
    .unwrap();
    assert!(d.body().contains("**新体**"));
    assert!(d.body().contains("[链接](https://example.com)"));
}
#[test]
fn unicode_escape_and_hard_break() {
    let source = "\\*字&amp;😀  \n下一行\\\n尾";
    let map = SourceMap::new(source, 0);
    assert_eq!(map.document.text, "*字&😀\n下一行\n尾");
    assert!(map
        .source_range(&TextRange {
            start: 4,
            length: 0
        })
        .is_err());
}
#[test]
fn unknown_blocks_preserved_readonly() {
    let source = "```rust\n**raw**\n```\n\n![pic](a.png)";
    let map = SourceMap::new(source, 0);
    assert_eq!(map.document.text, source);
    assert!(map
        .source_range(&TextRange {
            start: 2,
            length: 1
        })
        .is_err());
}
#[test]
fn remove_last_formatted_text_and_literal_paste() {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "**x**", 1).unwrap();
    let map = SourceMap::new(&d.body(), d.revision());
    map.apply_edit(
        &mut d,
        &TextRange {
            start: 0,
            length: 1,
        },
        "",
        2,
    )
    .unwrap();
    assert_eq!(d.body(), "");
    let map = SourceMap::new(&d.body(), d.revision());
    map.apply_edit(
        &mut d,
        &TextRange {
            start: 0,
            length: 0,
        },
        "**literal**",
        3,
    )
    .unwrap();
    assert_eq!(
        SourceMap::new(&d.body(), d.revision()).document.text,
        "**literal**"
    );
}
#[test]
fn format_toggle_block_styles_links_and_nested_runs() {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "hello", 1).unwrap();
    let r = TextRange {
        start: 0,
        length: 5,
    };
    SourceMap::new(&d.body(), d.revision())
        .apply_format(&mut d, &r, "bold", 2)
        .unwrap();
    assert_eq!(d.body(), "**hello**");
    SourceMap::new(&d.body(), d.revision())
        .apply_format(&mut d, &r, "bold", 3)
        .unwrap();
    assert_eq!(d.body(), "hello");
    SourceMap::new(&d.body(), d.revision())
        .apply_format(&mut d, &r, "heading2", 4)
        .unwrap();
    assert_eq!(d.body(), "## hello");
    SourceMap::new(&d.body(), d.revision())
        .apply_link(&mut d, &r, "https://example.com/a(b)", 5)
        .unwrap();
    let m = SourceMap::new(&d.body(), d.revision());
    assert_eq!(m.document.text, "hello");
    assert_eq!(m.document.runs.len(), 1);
    assert_eq!(m.document.runs[0].heading, 2);
    assert!(m.document.runs[0].link.is_some());
    assert_eq!(SourceMap::new("# Title ###\n", 0).document.text, "Title\n");
}

#[test]
fn block_format_converts_ordered_and_bullet_lists_and_stops_at_selected_newline() {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "1. one\n+ two\nplain", 1)
        .unwrap();
    let map = SourceMap::new(&d.body(), d.revision());
    map.apply_format(
        &mut d,
        &TextRange {
            start: 0,
            length: 4,
        },
        "paragraph",
        2,
    )
    .unwrap();
    assert_eq!(d.body(), "one\n+ two\nplain");
    SourceMap::new(&d.body(), d.revision())
        .apply_format(
            &mut d,
            &TextRange {
                start: 4,
                length: 3,
            },
            "ordered_list",
            3,
        )
        .unwrap();
    assert_eq!(d.body(), "one\n1. two\nplain");
}

#[test]
fn rich_clipboard_is_local_markdown_and_rejects_invalid_runs_atomically() {
    use write_core::render::{rich_markdown, RenderDocument, StyleRun};
    let clipboard = RenderDocument {
        text: "Bold italic\n标题".into(),
        runs: vec![
            StyleRun {
                range: TextRange {
                    start: 0,
                    length: 5,
                },
                bold: true,
                ..Default::default()
            },
            StyleRun {
                range: TextRange {
                    start: 5,
                    length: 6,
                },
                bold: true,
                italic: true,
                ..Default::default()
            },
            StyleRun {
                range: TextRange {
                    start: 12,
                    length: 2,
                },
                heading: 2,
                ..Default::default()
            },
        ],
    };
    let markdown = rich_markdown(&clipboard).unwrap();
    assert_eq!(SourceMap::new(&markdown, 0).document.text, clipboard.text);
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "prefix suffix", 1).unwrap();
    SourceMap::new(&d.body(), d.revision())
        .apply_rich_paste(
            &mut d,
            &TextRange {
                start: 7,
                length: 0,
            },
            &clipboard,
            2,
        )
        .unwrap();
    assert!(d.body().starts_with("prefix **"));
    assert!(d.body().ends_with("suffix"));
    let old = d.encode_full();
    let invalid = RenderDocument {
        text: "👩‍💻".into(),
        runs: vec![StyleRun {
            range: TextRange {
                start: 1,
                length: 1,
            },
            bold: true,
            ..Default::default()
        }],
    };
    assert!(SourceMap::new(&d.body(), d.revision())
        .apply_rich_paste(
            &mut d,
            &TextRange {
                start: 0,
                length: 0
            },
            &invalid,
            3
        )
        .is_err());
    assert_eq!(d.encode_full(), old);
}
#[test]
fn visible_selection_survives_markdown_hidden_syntax_and_remote_edit() {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "**A😀B**", 1).unwrap();
    let anchor = SourceMap::new(&d.body(), d.revision())
        .anchor_selection(
            &d,
            &TextRange {
                start: 1,
                length: 2,
            },
        )
        .unwrap();
    let mut peer = Document::load(PAGE, 1, 2, &d.encode_full()).unwrap();
    let u = peer.replace(peer.revision(), 2, 0, "中", 2).unwrap();
    d.apply_remote(&u).unwrap();
    assert_eq!(
        SourceMap::new(&d.body(), d.revision())
            .resolve_selection(&d, &anchor)
            .unwrap(),
        TextRange {
            start: 2,
            length: 2
        }
    );
}

#[test]
fn literal_list_prefixes_stay_visible_in_plain_and_rich_paste() {
    use write_core::render::{rich_markdown, RenderDocument};
    let text = "- literal\n1. literal\n+ literal";
    assert_eq!(
        SourceMap::new(
            &rich_markdown(&RenderDocument {
                text: text.into(),
                runs: vec![]
            })
            .unwrap(),
            0
        )
        .document
        .text,
        text
    );
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    for chunk in ["1", ".", " ", "literal"] {
        let map = SourceMap::new(&d.body(), d.revision());
        let at = map.document.text.encode_utf16().count() as u32;
        map.apply_edit(
            &mut d,
            &TextRange {
                start: at,
                length: 0,
            },
            chunk,
            10,
        )
        .unwrap();
    }
    assert_eq!(
        SourceMap::new(&d.body(), d.revision()).document.text,
        "1. literal"
    );
}

#[test]
fn readonly_markdown_still_allows_stable_reading_selection() {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "```\ncode\n```", 1).unwrap();
    let map = SourceMap::new(&d.body(), d.revision());
    let selection = TextRange {
        start: 4,
        length: 4,
    };
    assert!(map.source_range(&selection).is_err());
    let anchor = map.anchor_selection(&d, &selection).unwrap();
    assert_eq!(map.resolve_selection(&d, &anchor).unwrap(), selection);
}
