use mdeditor_lib::themes::compiler::strip_include_when_export;
use mdeditor_lib::themes::compiler::rewrite_selector_text;

#[test]
fn strips_basic_form() {
    let css = "@include-when-export url(https://fonts.example.com/x.css);\n:root {}";
    assert_eq!(strip_include_when_export(css), "\n:root {}");
}

#[test]
fn strips_with_extra_whitespace() {
    let css = "  @include-when-export   url(  https://x  )  ;\n.a {}";
    assert_eq!(strip_include_when_export(css), "\n.a {}");
}

#[test]
fn strips_multiple_occurrences() {
    let css = "@include-when-export url(a);\n.a {}\n@include-when-export url(b);\n.b {}";
    let out = strip_include_when_export(css);
    assert!(!out.contains("@include-when-export"));
    assert!(out.contains(".a"));
    assert!(out.contains(".b"));
}

#[test]
fn preserves_css_with_no_directive() {
    let css = ":root { --x: 1; }\n.a { color: red; }";
    assert_eq!(strip_include_when_export(css), css);
}

#[test]
fn does_not_strip_similarly_named_rules() {
    let css = "/* @include-when-export-comment */\n.a {}";
    assert_eq!(strip_include_when_export(css), css);
}

const SCOPE: &str = r#"[data-theme="x"] .moraya-editor"#;

#[test]
fn rewrites_root() {
    assert_eq!(rewrite_selector_text(":root", "x"), SCOPE);
}

#[test]
fn rewrites_write() {
    assert_eq!(rewrite_selector_text("#write", "x"), SCOPE);
}

#[test]
fn rewrites_html_and_body() {
    assert_eq!(rewrite_selector_text("html", "x"), SCOPE);
    assert_eq!(rewrite_selector_text("body", "x"), SCOPE);
}

#[test]
fn write_child_combinator_becomes_descendant() {
    assert_eq!(rewrite_selector_text("#write > h1", "x"), format!("{SCOPE} h1"));
    assert_eq!(rewrite_selector_text("#write>h1", "x"), format!("{SCOPE} h1"));
}

#[test]
fn write_descendant_unchanged_in_form() {
    assert_eq!(rewrite_selector_text("#write h1", "x"), format!("{SCOPE} h1"));
}

#[test]
fn prefixes_class_selector() {
    assert_eq!(
        rewrite_selector_text(".md-fences", "x"),
        format!("{SCOPE} .md-fences")
    );
}

#[test]
fn prefixes_compound_selector() {
    assert_eq!(
        rewrite_selector_text("a.external", "x"),
        format!("{SCOPE} a.external")
    );
}

#[test]
fn selector_list_each_element_prefixed() {
    let out = rewrite_selector_text("h1, h2, h3", "x");
    assert_eq!(out, format!("{SCOPE} h1, {SCOPE} h2, {SCOPE} h3"));
}

#[test]
fn selector_list_mixed_scope_and_other() {
    // `:root` rewrites to scope; `.foo` gets prefixed; dedupe identical results.
    let out = rewrite_selector_text(":root, .foo", "x");
    assert_eq!(out, format!("{SCOPE}, {SCOPE} .foo"));
}

#[test]
fn body_with_class_is_not_treated_as_scope() {
    // body.modal-open is a compound, not a bare body — prefix without replacement.
    assert_eq!(
        rewrite_selector_text("body.modal-open", "x"),
        format!("{SCOPE} body.modal-open")
    );
}

#[test]
fn scope_attribute_uses_id_verbatim() {
    let out = rewrite_selector_text("#write", "claude-like");
    assert_eq!(out, r#"[data-theme="claude-like"] .moraya-editor"#);
}
