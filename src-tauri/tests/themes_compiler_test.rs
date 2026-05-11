use mdeditor_lib::themes::compiler::strip_include_when_export;

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
