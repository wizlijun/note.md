//! Unpacks Calibre-produced HTMLZ archives (a zip containing an HTML body,
//! an optional images directory, and an OPF metadata sidecar), recovers
//! book metadata from that sidecar, and converts the HTML to Markdown while
//! retaining the semantic subset understood by Typeset Reader. File discovery
//! follows the old `01_convert_to_htmlz.py` glob-style heuristics, but Markdown
//! cleanup is deliberately more precise so real book content is not discarded.

#[cfg(test)]
mod tests;

use crate::bookconf::BookMeta;
use htmd::Element;
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Result of unpacking one HTMLZ archive: where its HTML body landed on
/// disk, its images directory (if the archive shipped one), and whatever
/// metadata could be recovered from `metadata.opf`.
pub struct Extracted {
    pub html: PathBuf,
    pub images_dir: Option<PathBuf>,
    pub meta: BookMeta,
}

/// Directory names (case-insensitive) that HTMLZ producers use for their
/// image assets. Calibre itself emits `images/`; the others are kept for
/// HTMLZ files hand-rolled or produced by other tools that the original
/// python pipeline also had to tolerate.
const IMAGE_DIR_NAMES: &[&str] = &["images", "image", "pics", "pictures"];

/// Unzips `htmlz` into `work/htmlz/`, then locates the HTML entry point,
/// image directory, and OPF metadata by walking the extracted tree by file
/// name rather than assuming a fixed structure.
pub fn extract(htmlz: &Path, work: &Path) -> Result<Extracted, String> {
    let dest = work.join("htmlz");
    fs::create_dir_all(&dest).map_err(|e| format!("create {}: {e}", dest.display()))?;

    let file = fs::File::open(htmlz).map_err(|e| format!("open {}: {e}", htmlz.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read htmlz zip: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read htmlz zip entry {i}: {e}"))?;

        // `enclosed_name()` is `zip`'s own guard against zip-slip: it
        // returns `None` for absolute paths or entries whose `..`
        // components would escape the extraction root. Such entries are
        // simply skipped rather than trusted.
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest.join(&enclosed);

        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("mkdir {}: {e}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut out_file = fs::File::create(&out_path)
            .map_err(|e| format!("create {}: {e}", out_path.display()))?;
        io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("write {}: {e}", out_path.display()))?;
    }

    let html = find_html(&dest)
        .ok_or_else(|| format!("no .html/.htm file found in {}", htmlz.display()))?;
    let images_dir = find_images_dir(&dest);
    let meta = find_opf(&dest)
        .and_then(|opf| fs::read_to_string(opf).ok())
        .map(|xml| parse_opf(&xml))
        .unwrap_or_default();

    Ok(Extracted {
        html,
        images_dir,
        meta,
    })
}

/// Recursively collects every regular file under `root`.
fn walk_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// Recursively collects every directory under `root` (root itself excluded).
fn walk_dirs(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.push(path.clone());
            walk_dirs(&path, out);
        }
    }
}

fn eq_ignore_case(name: Option<&std::ffi::OsStr>, candidate: &str) -> bool {
    name.and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(candidate))
}

/// Finds the HTMLZ's HTML body: prefers a file literally named
/// `index.html` (case-insensitive, matching Calibre's own convention);
/// falls back to the first `*.html`/`*.htm` found anywhere in the archive
/// for HTMLZ files that don't follow that convention.
fn find_html(root: &Path) -> Option<PathBuf> {
    let mut files = Vec::new();
    walk_files(root, &mut files);

    if let Some(p) = files
        .iter()
        .find(|p| eq_ignore_case(p.file_name(), "index.html"))
    {
        return Some(p.clone());
    }

    files.into_iter().find(|p| {
        p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
    })
}

fn find_images_dir(root: &Path) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    walk_dirs(root, &mut dirs);
    dirs.into_iter().find(|d| {
        IMAGE_DIR_NAMES
            .iter()
            .any(|candidate| eq_ignore_case(d.file_name(), candidate))
    })
}

fn find_opf(root: &Path) -> Option<PathBuf> {
    let mut files = Vec::new();
    walk_files(root, &mut files);
    files
        .into_iter()
        .find(|p| eq_ignore_case(p.file_name(), "metadata.opf"))
}

/// Metadata fields read from OPF elements. An identifier must explicitly
/// identify itself as ISBN; arbitrary identifiers (such as UUIDs) are skipped.
#[derive(Clone, Copy)]
enum Field {
    Title,
    Creator,
    Publisher,
    Language,
    Identifier { explicit_isbn: bool },
}

fn field_for(local_name: &[u8]) -> Option<Field> {
    match local_name {
        b"title" => Some(Field::Title),
        b"creator" => Some(Field::Creator),
        b"publisher" => Some(Field::Publisher),
        b"language" => Some(Field::Language),
        _ => None,
    }
}

fn isbn_label(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "isbn" | "isbn10" | "isbn13" | "isbn-10" | "isbn-13" | "isbn_10" | "isbn_13"
    )
}

/// Preserve the supplied identifier for downstream checksum validation. A
/// numeric-looking value alone is not evidence that its identifier is ISBN.
fn isbn_value(text: &str, explicit_isbn: bool) -> Option<&str> {
    for prefix in ["urn:isbn:", "isbn:"] {
        if text
            .get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
        {
            let value = text[prefix.len()..].trim();
            return (!value.is_empty()).then_some(value);
        }
    }
    explicit_isbn.then_some(text)
}

/// Parses `metadata.opf` with a quick-xml event stream, reading only the
/// first text found under each `dc:title`/`dc:creator`/`dc:publisher`/
/// `dc:language` element (matched on *local* name, so any namespace prefix
/// or default namespace works), plus explicitly marked ISBN identifiers.
/// Identifier scheme/id attributes or urn:isbn:/isbn: text prefixes mark ISBNs.
/// An unparsable or absent OPF simply yields
/// an all-`None` `BookMeta` -- metadata recovery is always best-effort.
fn parse_opf(xml: &str) -> BookMeta {
    let mut meta = BookMeta::default();
    let mut reader = Reader::from_str(xml);
    let mut current: Option<Field> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) => {
                current = if e.local_name().as_ref() == b"identifier" {
                    let explicit_isbn = e.attributes().flatten().any(|attr| {
                        matches!(attr.key.local_name().as_ref(), b"scheme" | b"id")
                            && attr.unescape_value().is_ok_and(|value| isbn_label(&value))
                    });
                    Some(Field::Identifier { explicit_isbn })
                } else {
                    field_for(e.local_name().as_ref())
                };
            }
            Ok(Event::End(_)) => {
                current = None;
            }
            Ok(Event::Text(t)) => {
                let Some(field) = current else { continue };
                let Ok(text) = t.unescape() else { continue };
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                if let Field::Identifier { explicit_isbn } = field {
                    if meta.isbn.is_none() {
                        meta.isbn = isbn_value(text, explicit_isbn).map(str::to_string);
                    }
                    continue;
                }
                let slot = match field {
                    Field::Title => &mut meta.title,
                    Field::Creator => &mut meta.creator,
                    Field::Publisher => &mut meta.publisher,
                    Field::Language => &mut meta.language,
                    Field::Identifier { .. } => unreachable!(),
                };
                // Only the *first* text under each field name is kept, so
                // a repeated element (e.g. multiple `dc:creator`s) doesn't
                // clobber the first author with a later one.
                if slot.is_none() {
                    *slot = Some(text.to_string());
                }
            }
            _ => {}
        }
    }

    meta
}

fn attr<'a>(element: &'a Element<'a>, name: &str) -> Option<&'a str> {
    element
        .attrs
        .iter()
        .find(|attribute| attribute.name.local.as_ref().eq_ignore_ascii_case(name))
        .map(|attribute| attribute.value.as_ref())
}

fn attr_has_token(element: &Element<'_>, name: &str, token: &str) -> bool {
    attr(element, name).is_some_and(|value| {
        value
            .split_ascii_whitespace()
            .any(|value| value.eq_ignore_ascii_case(token))
    })
}

fn is_hidden(element: &Element<'_>) -> bool {
    attr(element, "hidden").is_some()
        || attr(element, "aria-hidden").is_some_and(|value| value.eq_ignore_ascii_case("true"))
        || attr_has_token(element, "role", "doc-pagebreak")
        || attr_has_token(element, "type", "pagebreak")
        || attr_has_token(element, "epub:type", "pagebreak")
}

fn block_content(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    Some(format!("\n\n{}\n\n", element.content))
}

fn toc_content(content: &str) -> String {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let already_structured = trimmed.starts_with('#')
                || trimmed.starts_with("- ")
                || trimmed.starts_with("* ")
                || trimmed.starts_with("+ ")
                || trimmed
                    .split_once(". ")
                    .is_some_and(|(prefix, _)| prefix.chars().all(|ch| ch.is_ascii_digit()));
            Some(if already_structured {
                line.trim_end().to_string()
            } else {
                let indent = &line[..line.len() - line.trim_start().len()];
                format!("{indent}- {trimmed}")
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn container_content(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    let is_toc = attr_has_token(&element, "role", "doc-toc")
        || attr_has_token(&element, "type", "toc")
        || attr_has_token(&element, "epub:type", "toc")
        || attr_has_token(&element, "class", "toc");
    let content = if is_toc {
        toc_content(element.content)
    } else {
        element.content.to_string()
    };
    Some(format!("\n\n{content}\n\n"))
}

fn semantic_inline(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) || element.content.is_empty() {
        return None;
    }
    let tag = if element.tag == "del" {
        "s"
    } else {
        element.tag
    };
    Some(format!("<{tag}>{}</{tag}>", element.content))
}

fn definition_list(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    let content = element.content.trim();
    if content.is_empty() {
        return None;
    }
    Some(format!("\n\n<dl>\n{content}\n</dl>\n\n"))
}

fn definition_item(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    let content = element.content.trim();
    if content.is_empty() {
        return None;
    }
    Some(format!(
        "\n<{}>{}</{}>\n",
        element.tag, content, element.tag
    ))
}

fn figure_content(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    let content = element.content.trim();
    if content.is_empty() {
        return None;
    }
    // Blank lines keep Markdown images visible to pulldown-cmark, which the
    // Reader uses for path validation and cache invalidation, while cmarker
    // can still associate the following figcaption with this figure.
    Some(format!("\n\n<figure>\n\n{content}\n\n</figure>\n\n"))
}

fn figcaption_content(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    let content = element.content.trim();
    if content.is_empty() {
        return None;
    }
    Some(format!("\n\n<figcaption>{content}</figcaption>\n\n"))
}

fn aside_content(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    let is_note = ["doc-note", "doc-tip", "note", "tip", "sidebar"]
        .iter()
        .any(|token| {
            attr_has_token(&element, "role", token)
                || attr_has_token(&element, "type", token)
                || attr_has_token(&element, "epub:type", token)
                || attr_has_token(&element, "class", token)
        });
    if !is_note {
        return Some(format!("\n\n{}\n\n", element.content));
    }
    let quoted = element
        .content
        .trim()
        .lines()
        .map(|line| {
            if line.is_empty() {
                ">".to_string()
            } else {
                format!("> {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!("\n\n{quoted}\n\n"))
}

fn deduplicated_emphasis(element: Element<'_>, marker: &str) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    let content = element.content;
    let trimmed = content.trim_matches(|ch: char| ch.is_ascii_whitespace());
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() > marker.len() * 2 && trimmed.starts_with(marker) && trimmed.ends_with(marker)
    {
        return Some(content.to_string());
    }
    let start = content.find(trimmed).unwrap_or(0);
    let end = start + trimmed.len();
    Some(format!(
        "{}{marker}{trimmed}{marker}{}",
        &content[..start],
        &content[end..]
    ))
}

fn heading_content(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    let content = element.content.trim();
    if content.is_empty() {
        return None;
    }
    let level = element.tag.strip_prefix('h')?.parse::<usize>().ok()?;
    Some(format!("\n\n{} {content}\n\n", "#".repeat(level)))
}

fn blockquote_content(element: Element<'_>) -> Option<String> {
    if is_hidden(&element) {
        return None;
    }
    let content = element.content.trim();
    if content.is_empty() {
        return None;
    }
    let quoted = content
        .lines()
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!("\n\n{quoted}\n\n"))
}

/// Converts HTML to Markdown via `htmd`, retaining the small semantic subset
/// that Typeset Reader can render safely. Scripts, styles, hidden/page-break
/// markers and arbitrary CSS are deliberately excluded.
pub fn html_to_markdown(html: &str) -> Result<String, String> {
    let converter = htmd::HtmlToMarkdown::builder()
        .skip_tags(vec!["script", "style"])
        .add_handler(vec!["span"], |element: Element<'_>| {
            (!is_hidden(&element)).then(|| element.content.to_string())
        })
        .add_handler(vec!["p"], block_content)
        .add_handler(
            vec![
                "div", "nav", "section", "article", "header", "footer", "main",
            ],
            container_content,
        )
        .add_handler(vec!["aside"], aside_content)
        .add_handler(vec!["blockquote"], blockquote_content)
        .add_handler(vec!["h1", "h2", "h3", "h4", "h5", "h6"], heading_content)
        .add_handler(vec!["i", "em"], |element: Element<'_>| {
            deduplicated_emphasis(element, "_")
        })
        .add_handler(vec!["b", "strong"], |element: Element<'_>| {
            deduplicated_emphasis(element, "**")
        })
        .add_handler(vec!["sup", "sub", "mark", "s", "del"], semantic_inline)
        .add_handler(vec!["dl"], definition_list)
        .add_handler(vec!["dt", "dd"], definition_item)
        .add_handler(vec!["figure"], figure_content)
        .add_handler(vec!["figcaption"], figcaption_content)
        .build();
    let md = converter.convert(html).map_err(|e| e.to_string())?;
    Ok(clean_calibre_markers(&md))
}

/// Normalizes converted Markdown without making content-based guesses:
///
/// 1. stray BOM (`\u{feff}`) removal and NBSP (`\u{a0}`) -> space
/// 2. collapsing runs of 3+ newlines down
///    to a single blank line
///
/// Older versions removed fragment links and guessed that digit-only, `:::`
/// and class-looking text was conversion debris. Those guesses could delete
/// real book content (including code), so page breaks and hidden nodes are now
/// removed from their explicit HTML semantics before conversion.
pub fn clean_calibre_markers(md: &str) -> String {
    static BLANK_RUN: OnceLock<Regex> = OnceLock::new();

    let blank_run = BLANK_RUN.get_or_init(|| Regex::new(r"\n{3,}").unwrap());

    let normalized: String = md
        .chars()
        .filter(|&c| c != '\u{feff}')
        .map(|c| if c == '\u{a0}' { ' ' } else { c })
        .collect();

    blank_run.replace_all(&normalized, "\n\n").into_owned()
}
