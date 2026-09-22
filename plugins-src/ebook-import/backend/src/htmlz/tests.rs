use super::*;
use std::io::Write;
use zip::write::{SimpleFileOptions, ZipWriter};

/// Builds an in-memory-constructed HTMLZ zip on disk at `path` from
/// `(entry_name, contents)` pairs -- no binary fixture files needed, per
/// the brief.
fn write_htmlz(path: &Path, entries: &[(&str, &[u8])]) {
    let file = fs::File::create(path).unwrap();
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    for (name, contents) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(contents).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn cleans_calibre_markers() {
    let md = "Title{.calibre1}\n[x](#calibre_link-12)\n::: div\n42\nfoo\nbar .ct}\n\n\n\nend";
    let out = clean_calibre_markers(md);
    assert!(out.contains("Title{.calibre1}"));
    assert!(out.contains("[x](#calibre_link-12)"));
    assert!(out.contains("::: div"));
    assert!(out.lines().any(|l| l.trim() == "42"));
    assert!(out.contains("bar .ct}"));
    assert!(out.contains("foo"));
    assert!(!out.contains("\n\n\n")); // ≥3 空行折叠
}

#[test]
fn clean_calibre_markers_preserves_content_and_normalizes_whitespace() {
    let md = "kept\ncaption remnant .cn}\n\u{feff}BOM\u{a0}here";
    let out = clean_calibre_markers(md);
    assert!(out.contains("kept"));
    assert!(out.contains("caption remnant .cn}"));
    assert!(!out.contains('\u{feff}'));
    assert!(out.contains("BOM here"));
}

#[test]
fn extract_reads_opf_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let htmlz_path = tmp.path().join("book.htmlz");
    let opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>七力</dc:title>
    <dc:creator>H</dc:creator>
    <dc:language>zh</dc:language>
    <dc:identifier opf:scheme="ISBN">9780735214491</dc:identifier>
  </metadata>
</package>"#;
    write_htmlz(
        &htmlz_path,
        &[
            ("index.html", b"<html><body><h1>Hi</h1></body></html>"),
            ("images/a.png", &[0x89, 0x50, 0x4e, 0x47]),
            ("metadata.opf", opf.as_bytes()),
        ],
    );

    let work = tmp.path().join("work");
    let extracted = extract(&htmlz_path, &work).expect("extract should succeed");

    assert!(extracted.html.ends_with("index.html"));
    assert_eq!(extracted.meta.title.as_deref(), Some("七力"));
    assert_eq!(extracted.meta.creator.as_deref(), Some("H"));
    assert_eq!(extracted.meta.language.as_deref(), Some("zh"));
    assert_eq!(extracted.meta.isbn.as_deref(), Some("9780735214491"));
    let images_dir = extracted.images_dir.expect("images dir should be found");
    assert_eq!(images_dir.file_name().unwrap(), "images");
    assert!(images_dir.join("a.png").is_file());
}

#[test]
fn extract_falls_back_without_opf_or_images_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let htmlz_path = tmp.path().join("book.htmlz");
    write_htmlz(
        &htmlz_path,
        &[("content.htm", b"<html><body><p>Hello</p></body></html>")],
    );

    let work = tmp.path().join("work");
    let extracted = extract(&htmlz_path, &work).expect("extract should succeed");

    assert!(extracted.html.ends_with("content.htm"));
    assert!(extracted.images_dir.is_none());
    assert!(extracted.meta.title.is_none());
    assert!(extracted.meta.creator.is_none());
    assert!(extracted.meta.publisher.is_none());
    assert!(extracted.meta.language.is_none());
    assert!(extracted.meta.isbn.is_none());
}

#[test]
fn opf_reads_only_explicit_isbn_identifiers_and_keeps_first() {
    for identifier in [
        r#"<dc:identifier opf:scheme="ISBN">978-0-7352-1449-1</dc:identifier>"#,
        r#"<identifier scheme="isbn-13">978-0-7352-1449-1</identifier>"#,
        r#"<dc:identifier id="isbn">978-0-7352-1449-1</dc:identifier>"#,
        r#"<dc:identifier id="ISBN13">978-0-7352-1449-1</dc:identifier>"#,
        "<dc:identifier> urn:isbn:978-0-7352-1449-1 </dc:identifier>",
        "<dc:identifier>URN:ISBN:978-0-7352-1449-1</dc:identifier>",
        "<dc:identifier>isbn:978-0-7352-1449-1</dc:identifier>",
    ] {
        let xml = format!(
            r#"<package><metadata>
            <dc:identifier id="uuid_id">urn:uuid:8b98a58b-bf5f-62fe-3692-a7a20b375c3e</dc:identifier>
            <dc:identifier>9780735214491</dc:identifier>
            {identifier}
            <dc:identifier scheme="ISBN">0735214492</dc:identifier>
            <dc:title>First &amp; title</dc:title><dc:title>Second title</dc:title>
            <dc:creator>First author</dc:creator><dc:creator>Second author</dc:creator>
            <dc:publisher>Publisher</dc:publisher><dc:language>en</dc:language>
            </metadata></package>"#
        );
        let meta = parse_opf(&xml);
        assert_eq!(
            meta.isbn.as_deref(),
            Some("978-0-7352-1449-1"),
            "{identifier}"
        );
        assert_eq!(meta.title.as_deref(), Some("First & title"));
        assert_eq!(meta.creator.as_deref(), Some("First author"));
        assert_eq!(meta.publisher.as_deref(), Some("Publisher"));
        assert_eq!(meta.language.as_deref(), Some("en"));
    }
}

#[test]
fn opf_does_not_guess_isbn_from_other_identifiers_or_empty_values() {
    for identifier in [
        r#"<identifier scheme="UUID">8b98a58b-bf5f-62fe-3692-a7a20b375c3e</identifier>"#,
        r#"<identifier id="BookId">9780735214491</identifier>"#,
        "<identifier>9780735214491</identifier>",
        "<identifier>urn:isbn: </identifier>",
        "<identifier>isbn:</identifier>",
        r#"<identifier scheme="ISBN"> </identifier>"#,
        "<identifier>非ISBN编号</identifier>",
    ] {
        assert!(parse_opf(identifier).isbn.is_none(), "{identifier}");
    }
}

/// Recursively checks whether any file under `root` has the given file
/// name, anywhere in the tree.
fn tree_contains_file_named(root: &Path, name: &str) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if tree_contains_file_named(&path, name) {
                return true;
            }
        } else if path.file_name().and_then(|n| n.to_str()) == Some(name) {
            return true;
        }
    }
    false
}

#[test]
fn extract_rejects_zip_slip_entries() {
    let tmp = tempfile::tempdir().unwrap();
    let htmlz_path = tmp.path().join("book.htmlz");
    write_htmlz(
        &htmlz_path,
        &[
            ("index.html", b"<html><body><p>Hello</p></body></html>"),
            // A `..`-escaping entry name: if extracted naively via
            // `dest.join(name)`, this would land outside `work/htmlz/`
            // entirely (zip-slip). `extract` must reject it via
            // `enclosed_name()` rather than write it anywhere.
            ("../../evil.txt", b"pwned"),
        ],
    );

    let work = tmp.path().join("work");
    let extracted = extract(&htmlz_path, &work).expect("extract should still succeed");

    assert!(extracted.html.ends_with("index.html"));
    // The malicious entry must not have been written anywhere: neither
    // inside the intended extraction root nor anywhere it could have
    // escaped to (the whole tempdir, which contains both `work/` and any
    // `../`-escaped siblings of it).
    assert!(
        !tree_contains_file_named(tmp.path(), "evil.txt"),
        "zip-slip entry should have been skipped, not written to disk"
    );
}

#[test]
fn html_to_markdown_skips_unsafe_tags_without_deleting_visible_text() {
    let html = "<html><body>\
        <script>evil()</script>\
        <h1>Title{.calibre1}</h1>\
        <p>Body text.</p>\
        </body></html>";
    let md = html_to_markdown(html).expect("conversion should succeed");
    assert!(!md.contains("evil()"));
    assert!(md.contains("Title{.calibre1}"));
    assert!(md.contains("Body text."));
}

#[test]
fn html_to_markdown_preserves_heading_hierarchy_and_blockquotes() {
    let html = r#"<html><body>
        <h1>Part One</h1>
        <h2>Chapter One</h2>
        <h3>A Smaller Section</h3>
        <blockquote><p>A quoted paragraph.</p></blockquote>
        <aside role="doc-note"><p>A side note.</p></aside>
        </body></html>"#;

    let md = html_to_markdown(html).expect("conversion should succeed");

    assert!(md.lines().any(|line| line == "# Part One"), "got: {md}");
    assert!(md.lines().any(|line| line == "## Chapter One"), "got: {md}");
    assert!(
        md.lines().any(|line| line == "### A Smaller Section"),
        "got: {md}"
    );
    assert!(
        md.lines()
            .any(|line| line.trim_start().starts_with("> A quoted paragraph.")),
        "got: {md}"
    );
    assert!(
        md.lines()
            .any(|line| line.trim_start().starts_with("> A side note.")),
        "got: {md}"
    );
}

#[test]
fn html_to_markdown_keeps_toc_and_internal_link_text_renderable() {
    let html = r##"<html><body>
        <nav class="toc"><a href="#calibre_link-12">Chapter One</a></nav>
        <h1 id="calibre_link-12">Chapter One</h1>
        <p>Return to the <a href="#calibre_link-12">chapter opening</a>.</p>
        </body></html>"##;

    let md = html_to_markdown(html).expect("conversion should succeed");

    assert!(md.contains("Chapter One"), "TOC label was lost: {md}");
    assert!(
        md.lines().any(|line| line.starts_with("- [Chapter One]")),
        "TOC entry should remain a Markdown list item: {md}"
    );
    assert!(
        md.contains("chapter opening"),
        "internal-link label was lost: {md}"
    );
    assert!(
        md.contains("[Chapter One](#calibre_link-12)")
            && md.contains("[chapter opening](#calibre_link-12)"),
        "internal links should remain valid Markdown until anchor support is added: {md}"
    );
}

#[test]
fn html_to_markdown_preserves_typeset_reader_inline_html_contract() {
    // Typeset Reader's vendored cmarker maps these exact HTML tags to Typst's
    // super/subscript, highlight, and strike primitives. CommonMark has no
    // lossless spelling for the first three, so the importer must retain the
    // safe semantic tags rather than flattening them to plain text.
    let html = r#"<html><body><p>
        E = mc<sup>2</sup>, H<sub>2</sub>O,
        <mark>important</mark>, and <s>obsolete</s>.
        </p></body></html>"#;

    let md = html_to_markdown(html).expect("conversion should succeed");

    for semantic in [
        "<sup>2</sup>",
        "<sub>2</sub>",
        "<mark>important</mark>",
        "<s>obsolete</s>",
    ] {
        assert!(
            md.contains(semantic),
            "Typeset Reader semantic tag {semantic:?} was flattened: {md}"
        );
    }
}

#[test]
fn html_to_markdown_preserves_typeset_reader_definition_lists() {
    // cmarker renders dl/dt/dd as a Typst terms list; flattening the wrapper
    // destroys the term/definition relationship even when the words survive.
    let html = r#"<html><body><dl>
        <dt>Latency</dt><dd>Time needed to complete one operation.</dd>
        <dt>Throughput</dt><dd>Operations completed per unit of time.</dd>
        </dl></body></html>"#;

    let md = html_to_markdown(html).expect("conversion should succeed");

    for tag in ["<dl>", "<dt>", "</dt>", "<dd>", "</dd>", "</dl>"] {
        assert!(
            md.contains(tag),
            "Typeset Reader definition-list tag {tag:?} was flattened: {md}"
        );
    }
    assert!(md.contains("Latency"), "got: {md}");
    assert!(
        md.contains("Time needed to complete one operation."),
        "got: {md}"
    );
}

#[test]
fn html_to_markdown_preserves_typeset_reader_figures_and_captions() {
    // cmarker associates figcaption with figure. The image deliberately stays
    // Markdown so Reader path validation and cache hashing still see it; raw
    // img dimensions are not part of the safe importer contract yet.
    let html = r#"<html><body><figure id="architecture">
        <img src="images/architecture.png" alt="System architecture" width="640" />
        <figcaption>Figure 1. System architecture.</figcaption>
        </figure></body></html>"#;

    let md = html_to_markdown(html).expect("conversion should succeed");

    assert!(md.contains("<figure"), "figure wrapper was flattened: {md}");
    assert!(
        md.contains("</figure>"),
        "figure wrapper was flattened: {md}"
    );
    assert!(
        md.contains("<figcaption>") && md.contains("</figcaption>"),
        "figure caption was detached: {md}"
    );
    assert!(
        md.contains("![System architecture](images/architecture.png)"),
        "figure image must remain visible to Reader's Markdown image scanner: {md}"
    );
    assert!(
        !md.contains("<img"),
        "raw image bypasses Reader safety: {md}"
    );
    assert!(
        !md.contains("width=\"640\""),
        "unsafe raw size leaked: {md}"
    );
}

#[test]
fn html_to_markdown_drops_semantic_pagebreaks_but_keeps_real_numbers() {
    let html = r#"<html><body>
        <p>42</p>
        <span role="doc-pagebreak" title="43">43</span>
        <span type="pagebreak" title="44">44</span>
        <p aria-hidden="true">tracking text</p>
        </body></html>"#;

    let md = html_to_markdown(html).expect("conversion should succeed");

    assert!(md.lines().any(|line| line.trim() == "42"), "got: {md}");
    assert!(!md.contains("43"), "semantic pagebreak leaked: {md}");
    assert!(!md.contains("44"), "semantic pagebreak leaked: {md}");
    assert!(!md.contains("tracking text"), "hidden text leaked: {md}");
}

#[test]
fn html_to_markdown_drops_hidden_semantic_nodes() {
    let html = r#"<html><body>
        <section hidden><h2>Hidden section</h2><p>section secret</p></section>
        <figure aria-hidden="true"><img src="hidden.png" alt="hidden image" />
          <figcaption>hidden caption</figcaption>
        </figure>
        <p>Visible <mark hidden>marked secret</mark> text.</p>
        <h3 aria-hidden="true">hidden heading</h3>
        <h3>Visible heading</h3>
        </body></html>"#;

    let md = html_to_markdown(html).expect("conversion should succeed");

    for hidden in [
        "Hidden section",
        "section secret",
        "hidden image",
        "hidden caption",
        "marked secret",
        "hidden heading",
    ] {
        assert!(!md.contains(hidden), "hidden node leaked {hidden:?}: {md}");
    }
    assert!(
        md.contains("Visible text."),
        "visible siblings changed: {md}"
    );
    assert!(
        md.contains("### Visible heading"),
        "visible heading changed: {md}"
    );
}

#[test]
fn html_to_markdown_deduplicates_calibre_tag_emphasis() {
    let html = "<html><body><p><i><i>italic</i></i> and <b><b>bold</b></b></p></body></html>";
    let md = html_to_markdown(html).expect("conversion should succeed");

    assert!(md.contains("_italic_"), "got: {md}");
    assert!(md.contains("**bold**"), "got: {md}");
    assert!(
        !md.contains("__italic__"),
        "nested italics became bold: {md}"
    );
    assert!(
        !md.contains("****bold****"),
        "nested bold was duplicated: {md}"
    );
}
