use crate::world::RenderWorld;
use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use typst::foundations::{Bytes, Dict, IntoValue};

const CACHE_SCHEMA: &str = "typeset-svg-v4";
const RENDERER_VERSION: &str =
    "typst-0.15.1+cmarker-0.1.10+wonderous-book-0.1.2+aiwriter-book-0.4.13+template-18+font-store";
const QUICK_PREVIEW_BYTES: usize = 16 * 1024;
const MAX_CONTINUATION_BYTES: usize = 64 * 1024;
const TEMPLATE: &str = include_str!("../assets/template.typ");
const CMARKER_LIB: &str = include_str!("../assets/cmarker/lib.typ");
const CMARKER_WASM: &[u8] = include_bytes!("../assets/cmarker/plugin.wasm");
const WONDEROUS_BOOK_LIB: &str = include_str!("../assets/wonderous-book/lib.typ");
const AIWRITER_BOOK_TEMPLATE: &str = include_str!("../assets/templates/aiwriter-book.typ");

#[derive(Debug, Clone, Deserialize)]
pub struct RenderRequest {
    pub uri: String,
    pub content: String,
    pub vault_root: String,
    #[serde(default)]
    pub book_style: BookStyleRule,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RenderManifest {
    pub schema: String,
    pub cache_key: String,
    pub page_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RenderResult {
    pub cache_key: String,
    pub page_count: usize,
    pub hit: bool,
    pub complete: bool,
    pub busy: bool,
}

pub struct RenderSession {
    key: String,
    engine: RenderWorld,
    chunks: Vec<RenderChunk>,
    next_chunk: usize,
    page_count: usize,
    title: String,
    author: String,
    book_style: BookStyle,
    temp_dir: PathBuf,
    final_dir: PathBuf,
}

struct RenderChunk {
    markdown: String,
    chapter_start: bool,
}

struct ValidatedSource {
    book_dir: PathBuf,
    markdown: String,
    images: Vec<(PathBuf, Bytes)>,
    title: String,
    author: String,
    book_style: BookStyle,
}

struct CompileInput<'a> {
    markdown: &'a str,
    page_offset: usize,
    title: &'a str,
    author: &'a str,
    book_style: BookStyle,
    first: bool,
    chapter_start: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookStyle {
    Wonderous,
    AiWriter,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BookStyleRule {
    #[default]
    Auto,
    WonderousBook,
    AiwriterBook,
}

impl BookStyle {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wonderous => "wonderous-book",
            Self::AiWriter => "aiwriter-book",
        }
    }
}

#[derive(Default, Deserialize)]
struct BookFrontmatter {
    title: Option<String>,
    creator: Option<String>,
    author: Option<String>,
    language: Option<String>,
    #[serde(default)]
    sources: Vec<BookSource>,
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32,
        0x3400..=0x4dbf
        | 0x4e00..=0x9fff
        | 0xf900..=0xfaff
        | 0x3040..=0x30ff
        | 0xac00..=0xd7af)
}

fn book_style(language: Option<&str>, markdown: &str) -> BookStyle {
    let language_is_cjk = language.is_some_and(|language| {
        let primary = language
            .split(['-', '_'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        matches!(primary.as_str(), "zh" | "ja" | "ko")
    });
    let mut cjk = 0usize;
    let mut significant = 0usize;
    for character in markdown.chars().take(200_000) {
        if character.is_alphanumeric() {
            significant += 1;
            if is_cjk(character) {
                cjk += 1;
            }
        }
    }
    if cjk >= 32 && cjk.saturating_mul(5) >= significant {
        BookStyle::AiWriter
    } else if significant < 160 && language_is_cjk && cjk > 0 {
        // Metadata is useful for genuinely short samples, but a mislabeled
        // full English book must not be forced through the CJK template.
        BookStyle::AiWriter
    } else {
        BookStyle::Wonderous
    }
}

fn resolve_book_style(rule: BookStyleRule, language: Option<&str>, markdown: &str) -> BookStyle {
    match rule {
        BookStyleRule::Auto => book_style(language, markdown),
        BookStyleRule::WonderousBook => BookStyle::Wonderous,
        BookStyleRule::AiwriterBook => BookStyle::AiWriter,
    }
}

#[derive(Default, Deserialize)]
struct BookSource {
    author: Option<String>,
}

impl RenderSession {
    pub fn rendered_pages(&self) -> usize {
        self.page_count
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    pub fn completed_chunks(&self) -> usize {
        self.next_chunk
    }

    pub fn temp_dir(&self) -> &Path {
        &self.temp_dir
    }
}

impl Drop for RenderSession {
    fn drop(&mut self) {
        if self.temp_dir.exists() {
            fs::remove_dir_all(&self.temp_dir).ok();
        }
    }
}

fn strip_frontmatter(markdown: &str) -> &str {
    let text = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return text;
    };
    let mut offset = text.len() - rest.len();
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return &text[offset..];
        }
    }
    text
}

fn book_frontmatter(markdown: &str) -> BookFrontmatter {
    let text = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return BookFrontmatter::default();
    };
    let mut yaml = String::new();
    for line in rest.lines() {
        if line.trim_end_matches('\r') == "---" {
            return serde_yaml::from_str(&yaml).unwrap_or_default();
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    BookFrontmatter::default()
}

fn canonical_regular(path: &Path, root: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} must be a regular non-symlink file"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("resolve {label} {}: {error}", path.display()))?;
    if !canonical.starts_with(root) {
        return Err(format!("{label} is outside the Vault"));
    }
    Ok(canonical)
}

fn has_uri_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once(':') else {
        return false;
    };
    !scheme.is_empty()
        && scheme.chars().enumerate().all(|(index, character)| {
            if index == 0 {
                character.is_ascii_alphabetic()
            } else {
                character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
            }
        })
}

fn local_image_paths(
    markdown: &str,
    book_dir: &Path,
    vault: &Path,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    let parser = Parser::new_ext(markdown, Options::all());
    for event in parser {
        let Event::Start(Tag::Image { dest_url, .. }) = event else {
            continue;
        };
        let raw = dest_url.as_ref();
        if raw.starts_with('#') {
            continue;
        }
        if raw.starts_with('/') || raw.starts_with("//") || has_uri_scheme(raw) {
            return Err(format!("remote or absolute image is not supported: {raw}"));
        }
        let without_suffix = raw.split(['?', '#']).next().unwrap_or(raw);
        let decoded = percent_decode_str(without_suffix)
            .decode_utf8()
            .map_err(|_| format!("image path is not valid UTF-8: {raw}"))?;
        let relative = Path::new(decoded.as_ref());
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(format!(
                "image path must stay inside the book directory: {raw}"
            ));
        }
        paths.push(canonical_regular(&book_dir.join(relative), vault, "image")?);
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn validate_source(request: &RenderRequest) -> Result<ValidatedSource, String> {
    let vault = Path::new(&request.vault_root)
        .canonicalize()
        .map_err(|error| format!("resolve Vault root: {error}"))?;
    if !vault.is_dir() {
        return Err("Vault root is not a directory".into());
    }
    let source = canonical_regular(Path::new(&request.uri), &vault, "source")?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !name.ends_with(".typeset.md") {
        return Err("Typst Reader only renders *.typeset.md".into());
    }
    let book_dir = source
        .parent()
        .ok_or("source has no parent directory")?
        .to_path_buf();
    let frontmatter = book_frontmatter(&request.content);
    let markdown = strip_frontmatter(&request.content).to_string();
    let style = resolve_book_style(
        request.book_style,
        frontmatter.language.as_deref(),
        &markdown,
    );
    let title = frontmatter.title.unwrap_or_else(|| {
        book_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Book")
            .to_string()
    });
    let author = frontmatter
        .creator
        .or(frontmatter.author)
        .or_else(|| {
            frontmatter
                .sources
                .into_iter()
                .find_map(|source| source.author)
        })
        .unwrap_or_default();
    let images = local_image_paths(&markdown, &book_dir, &vault)?
        .into_iter()
        .map(|path| {
            let bytes = fs::read(&path)
                .map_err(|error| format!("read image {}: {error}", path.display()))?;
            Ok((path, Bytes::new(bytes)))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ValidatedSource {
        book_dir,
        markdown,
        images,
        title,
        author,
        book_style: style,
    })
}

fn cache_key(
    content: &str,
    book_dir: &Path,
    images: &[(PathBuf, Bytes)],
    book_style: BookStyle,
) -> Result<String, String> {
    let mut digest = Sha256::new();
    digest.update(CACHE_SCHEMA.as_bytes());
    digest.update([0]);
    digest.update(RENDERER_VERSION.as_bytes());
    digest.update([0]);
    digest.update(TEMPLATE.as_bytes());
    digest.update([0]);
    digest.update(WONDEROUS_BOOK_LIB.as_bytes());
    digest.update([0]);
    digest.update(AIWRITER_BOOK_TEMPLATE.as_bytes());
    digest.update([0]);
    digest.update(CMARKER_LIB.as_bytes());
    digest.update([0]);
    digest.update(CMARKER_WASM);
    digest.update([0]);
    digest.update(book_style.as_str().as_bytes());
    digest.update([0]);
    digest.update(content.as_bytes());
    for (path, bytes) in images {
        digest.update([0]);
        let relative = path
            .strip_prefix(book_dir)
            .map_err(|_| format!("image escaped the book directory: {}", path.display()))?;
        digest.update(relative.as_os_str().as_encoded_bytes());
        digest.update([0]);
        digest.update(bytes.as_slice());
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn manifest_at(cache_dir: &Path, key: &str) -> PathBuf {
    cache_dir.join(CACHE_SCHEMA).join(key).join("manifest.json")
}

fn read_manifest(cache_dir: &Path, key: &str) -> Option<RenderManifest> {
    let manifest: RenderManifest =
        serde_json::from_slice(&fs::read(manifest_at(cache_dir, key)).ok()?).ok()?;
    if manifest.schema != CACHE_SCHEMA || manifest.cache_key != key || manifest.page_count == 0 {
        return None;
    }
    Some(manifest)
}

// CommonMark ends an HTML block at a blank line, even while a figure/div
// container is still open. Keep those containers together across Markdown
// blocks so cmarker's HTML reconstruction sees both opening and closing tags.
fn track_html_containers(html: &str, stack: &mut Vec<String>) {
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        rest = &rest[start + 1..];
        if let Some(comment) = rest.strip_prefix("!--") {
            let Some(end) = comment.find("-->") else {
                return;
            };
            rest = &comment[end + 3..];
            continue;
        }
        let mut quote = None;
        let end = rest.char_indices().find_map(|(index, character)| {
            if let Some(expected) = quote {
                if character == expected {
                    quote = None;
                }
            } else if matches!(character, '\'' | '"') {
                quote = Some(character);
            } else if character == '>' {
                return Some(index);
            }
            None
        });
        let Some(end) = end else { return };
        let tag = rest[..end].trim();
        rest = &rest[end + 1..];
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric() || *character == '-')
            .collect::<String>()
            .to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        if closing {
            if let Some(index) = stack.iter().rposition(|open| *open == name) {
                stack.truncate(index);
            }
        } else if !tag.ends_with('/')
            && !matches!(
                name.as_str(),
                "area"
                    | "base"
                    | "br"
                    | "col"
                    | "embed"
                    | "hr"
                    | "img"
                    | "input"
                    | "link"
                    | "meta"
                    | "param"
                    | "source"
                    | "track"
                    | "wbr"
            )
        {
            stack.push(name);
        }
    }
}

fn chapter_chunks(markdown: String) -> Vec<RenderChunk> {
    use std::collections::{HashMap, HashSet};
    use std::ops::Range;

    let parser = Parser::new_ext(&markdown, Options::all());
    let definitions: HashMap<String, Range<usize>> = parser
        .reference_definitions()
        .iter()
        .map(|(label, definition)| (label.to_lowercase(), definition.span.clone()))
        .collect();
    let mut footnotes = HashMap::new();
    let mut references = Vec::new();
    let mut footnote_references = Vec::new();
    let mut h1_starts = Vec::new();
    let mut safe_boundaries = Vec::new();
    let mut depth = 0usize;
    let mut html_containers = Vec::new();
    let mut footnote_start = None;

    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(tag) => {
                match tag {
                    Tag::Heading {
                        level: HeadingLevel::H1,
                        ..
                    } if depth == 0 && html_containers.is_empty() => {
                        h1_starts.push(range.start);
                    }
                    Tag::FootnoteDefinition(label) => {
                        footnote_start = Some((label.to_string(), range.start));
                    }
                    Tag::Link { id, .. } | Tag::Image { id, .. } if !id.is_empty() => {
                        if let Some(definition) = definitions.get(&id.to_lowercase()) {
                            references.push((range.start, definition.clone()));
                        }
                    }
                    _ => {}
                }
                depth += 1;
            }
            Event::End(tag) => {
                depth = depth.saturating_sub(1);
                if tag == TagEnd::FootnoteDefinition {
                    if let Some((label, start)) = footnote_start.take() {
                        footnotes.insert(label, start..range.end);
                    }
                }
                if depth == 0 && html_containers.is_empty() {
                    safe_boundaries.push(range.end);
                }
            }
            Event::FootnoteReference(label) => {
                footnote_references.push((range.start, label.to_string()))
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                track_html_containers(&html, &mut html_containers)
            }
            Event::Rule if depth == 0 && html_containers.is_empty() => {
                safe_boundaries.push(range.end)
            }
            _ => {}
        }
    }
    safe_boundaries.push(markdown.len());
    safe_boundaries.sort_unstable();
    safe_boundaries.dedup();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < markdown.len() {
        let budget = if chunks.is_empty() {
            QUICK_PREVIEW_BYTES
        } else {
            MAX_CONTINUATION_BYTES
        };
        let limit = start.saturating_add(budget).min(markdown.len());
        let chapter_end = if chunks.is_empty() {
            h1_starts
                .iter()
                .copied()
                .find(|boundary| *boundary >= 512 && *boundary <= limit)
                .or_else(|| {
                    h1_starts
                        .iter()
                        .copied()
                        .find(|boundary| *boundary > start && *boundary <= limit)
                })
        } else {
            h1_starts
                .iter()
                .copied()
                .rfind(|boundary| *boundary > start && *boundary <= limit)
        };
        // An indivisible oversized block (code/list/table/HTML/paragraph) is
        // kept intact. Never cut UTF-8 or silently change Markdown semantics.
        let end = chapter_end
            .or_else(|| {
                safe_boundaries
                    .iter()
                    .copied()
                    .rfind(|boundary| *boundary > start && *boundary <= limit)
            })
            .or_else(|| {
                safe_boundaries
                    .iter()
                    .copied()
                    .find(|boundary| *boundary > start)
            })
            .unwrap_or(markdown.len());
        let chunk = &markdown[start..end];
        if !chunk.trim().is_empty() {
            let mut text = chunk.to_string();
            let mut included = HashSet::new();
            let mut append_definition = |definition: &Range<usize>, text: &mut String| {
                if !(definition.start >= start && definition.end <= end)
                    && included.insert((definition.start, definition.end))
                {
                    text.push_str("\n\n");
                    text.push_str(&markdown[definition.clone()]);
                }
            };
            for (offset, definition) in &references {
                if *offset >= start && *offset < end {
                    append_definition(definition, &mut text);
                }
            }
            // Footnotes can be defined after their first use, including in a
            // later batch. Copy only the needed definitions (and dependencies).
            let mut seen_footnotes = HashSet::new();
            let mut pending: Vec<String> = footnote_references
                .iter()
                .filter(|(offset, _)| *offset >= start && *offset < end)
                .map(|(_, label)| label.clone())
                .collect();
            while let Some(label) = pending.pop() {
                if !seen_footnotes.insert(label.clone()) {
                    continue;
                }
                if let Some(definition) = footnotes.get(&label) {
                    append_definition(definition, &mut text);
                    for (offset, reference) in &references {
                        if definition.contains(offset) {
                            append_definition(reference, &mut text);
                        }
                    }
                    pending.extend(
                        footnote_references
                            .iter()
                            .filter(|(offset, _)| definition.contains(offset))
                            .map(|(_, label)| label.clone()),
                    );
                }
            }
            chunks.push(RenderChunk {
                markdown: text,
                chapter_start: h1_starts.binary_search(&start).is_ok(),
            });
        }
        start = end;
    }
    if chunks.is_empty() {
        chunks.push(RenderChunk {
            markdown,
            chapter_start: false,
        });
    }
    chunks
}

fn compile_chunk(
    engine: &mut RenderWorld,
    input: CompileInput<'_>,
) -> Result<typst_layout::PagedDocument, String> {
    let mut dict = Dict::new();
    dict.insert("markdown".into(), input.markdown.into_value());
    dict.insert(
        "page_offset".into(),
        (input.page_offset as i64).into_value(),
    );
    dict.insert("title".into(), input.title.into_value());
    dict.insert("author".into(), input.author.into_value());
    dict.insert("book_style".into(), input.book_style.as_str().into_value());
    dict.insert("first".into(), input.first.into_value());
    dict.insert("chapter_start".into(), input.chapter_start.into_value());
    engine.set_inputs(dict);
    let compiled = typst::compile(engine);
    // Retain reusable template/plugin/layout work across continuation batches.
    comemo::evict(8);
    let document: typst_layout::PagedDocument = compiled
        .output
        .map_err(|errors| format!("Typst compile failed: {errors:#?}"))?;
    if document.pages().is_empty() {
        return Err("Typst produced no pages".into());
    }
    Ok(document)
}

fn start_session(
    cache_dir: &Path,
    key: String,
    source: ValidatedSource,
) -> Result<RenderSession, String> {
    let ValidatedSource {
        book_dir,
        markdown,
        title,
        author,
        book_style,
        images,
    } = source;
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let schema_dir = cache_dir.join(CACHE_SCHEMA);
    fs::create_dir_all(&schema_dir).map_err(|error| format!("create cache: {error}"))?;
    let final_dir = schema_dir.join(&key);
    if final_dir.exists() {
        fs::remove_dir_all(&final_dir).map_err(|error| format!("remove invalid cache: {error}"))?;
    }
    let temp_dir = schema_dir.join(format!(
        ".{key}.tmp-{}-{}",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed),
    ));
    let mut files = vec![("cmarker/plugin.wasm".to_string(), Bytes::new(CMARKER_WASM))];
    for (path, bytes) in images {
        let relative = path
            .strip_prefix(&book_dir)
            .map_err(|_| "image escaped the book directory")?;
        files.push((relative.to_string_lossy().into_owned(), bytes));
    }
    let engine = RenderWorld::new(
        TEMPLATE,
        &[
            ("cmarker/lib.typ", CMARKER_LIB),
            ("wonderous-book/lib.typ", WONDEROUS_BOOK_LIB),
            ("templates/aiwriter-book.typ", AIWRITER_BOOK_TEMPLATE),
        ],
        files,
    );
    let chunks = chapter_chunks(markdown);
    fs::create_dir(&temp_dir).map_err(|error| format!("create temporary cache: {error}"))?;
    Ok(RenderSession {
        key,
        engine,
        chunks,
        next_chunk: 0,
        page_count: 0,
        title,
        author,
        book_style,
        temp_dir,
        final_dir,
    })
}

pub fn prepare(
    cache_dir: &Path,
    request: &RenderRequest,
) -> Result<(RenderResult, Option<RenderSession>), String> {
    let source = validate_source(request)?;
    let key = cache_key(
        &request.content,
        &source.book_dir,
        &source.images,
        source.book_style,
    )?;
    if let Some(manifest) = read_manifest(cache_dir, &key).filter(|manifest| {
        let dir = cache_dir.join(CACHE_SCHEMA).join(&key);
        (0..manifest.page_count).all(|page| dir.join(format!("page-{page:04}.svg")).is_file())
    }) {
        return Ok((
            RenderResult {
                cache_key: key,
                page_count: manifest.page_count,
                hit: true,
                complete: true,
                busy: false,
            },
            None,
        ));
    }
    let session = start_session(cache_dir, key.clone(), source)?;
    Ok((
        RenderResult {
            cache_key: key,
            page_count: 0,
            hit: false,
            complete: false,
            busy: false,
        },
        Some(session),
    ))
}

pub fn render_next(session: &mut RenderSession) -> Result<RenderResult, String> {
    let chunk = session
        .chunks
        .get(session.next_chunk)
        .ok_or("render session is already complete")?;
    let document = compile_chunk(
        &mut session.engine,
        CompileInput {
            markdown: &chunk.markdown,
            page_offset: session.page_count,
            title: &session.title,
            author: &session.author,
            book_style: session.book_style,
            first: session.next_chunk == 0,
            chapter_start: chunk.chapter_start,
        },
    )?;
    for page in document.pages() {
        let index = session.page_count;
        let svg = typst_svg::svg(page, &Default::default());
        fs::write(session.temp_dir.join(format!("page-{index:04}.svg")), svg)
            .map_err(|error| format!("write cached page: {error}"))?;
        session.page_count += 1;
    }
    session.next_chunk += 1;
    let complete = session.next_chunk == session.chunks.len();
    if complete {
        let manifest = RenderManifest {
            schema: CACHE_SCHEMA.into(),
            cache_key: session.key.clone(),
            page_count: session.page_count,
        };
        fs::write(
            session.temp_dir.join("manifest.json"),
            serde_json::to_vec(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("write cache manifest: {error}"))?;
        if session.final_dir.exists() {
            fs::remove_dir_all(&session.temp_dir).ok();
        } else {
            match fs::rename(&session.temp_dir, &session.final_dir) {
                Ok(()) => {}
                Err(_) if session.final_dir.exists() => {
                    fs::remove_dir_all(&session.temp_dir).ok();
                }
                Err(error) => return Err(format!("commit cache: {error}")),
            }
        }
    }
    Ok(RenderResult {
        cache_key: session.key.clone(),
        page_count: session.page_count,
        hit: false,
        complete,
        busy: false,
    })
}

pub fn in_progress(key: &str, page_count: usize) -> RenderResult {
    RenderResult {
        cache_key: key.to_string(),
        page_count,
        hit: false,
        complete: false,
        busy: true,
    }
}

#[cfg(test)]
pub fn render(cache_dir: &Path, request: &RenderRequest) -> Result<RenderResult, String> {
    let (mut result, session) = prepare(cache_dir, request)?;
    let Some(mut session) = session else {
        return Ok(result);
    };
    while !result.complete {
        result = render_next(&mut session)?;
    }
    Ok(result)
}

pub fn page(cache_dir: &Path, key: &str, page: usize) -> Result<String, String> {
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid cache key".into());
    }
    let manifest = read_manifest(cache_dir, key).ok_or("render cache is unavailable")?;
    if page >= manifest.page_count {
        return Err("page is outside the document".into());
    }
    fs::read_to_string(
        cache_dir
            .join(CACHE_SCHEMA)
            .join(key)
            .join(format!("page-{page:04}.svg")),
    )
    .map_err(|error| format!("read cached page: {error}"))
}

#[cfg(test)]
pub fn session_page(session: &RenderSession, page: usize) -> Result<String, String> {
    if page >= session.page_count {
        return Err("page is outside the rendered portion".into());
    }
    fs::read_to_string(session.temp_dir.join(format!("page-{page:04}.svg")))
        .map_err(|error| format!("read rendered page: {error}"))
}

pub fn in_progress_page(
    cache_dir: &Path,
    key: &str,
    temp_dir: &Path,
    rendered_page_count: usize,
    page_index: usize,
) -> Result<String, String> {
    if page_index >= rendered_page_count {
        return Err("page is outside the rendered portion".into());
    }
    let temporary = temp_dir.join(format!("page-{page_index:04}.svg"));
    if temporary.is_file() {
        return fs::read_to_string(temporary)
            .map_err(|error| format!("read rendered page: {error}"));
    }
    // The final chunk atomically renames the temporary cache before the UI's
    // next status poll observes completion. Keep already-visible pages readable
    // during that short interval.
    page(cache_dir, key, page_index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(vault: &Path, source: &Path, content: &str) -> RenderRequest {
        RenderRequest {
            uri: source.to_string_lossy().into_owned(),
            content: content.into(),
            vault_root: vault.to_string_lossy().into_owned(),
            book_style: BookStyleRule::Auto,
        }
    }

    #[test]
    fn strips_only_a_leading_frontmatter_block() {
        assert_eq!(
            strip_frontmatter("---\ntype: Book\n---\n# Title"),
            "# Title"
        );
        assert_eq!(
            strip_frontmatter("# Title\n---\nbody"),
            "# Title\n---\nbody"
        );
        let metadata =
            book_frontmatter("---\ntitle: Seven Powers\ncreator: Hamilton Helmer\n---\n# One");
        assert_eq!(metadata.title.as_deref(), Some("Seven Powers"));
        assert_eq!(metadata.creator.as_deref(), Some("Hamilton Helmer"));
        let metadata = book_frontmatter(
            "---\ntitle: Why We Remember\nsources:\n  - resource: original.epub\n    author: Charan Ranganath\n---\n",
        );
        assert_eq!(
            metadata.sources[0].author.as_deref(),
            Some("Charan Ranganath")
        );
    }

    #[test]
    fn chooses_the_chinese_template_from_metadata_or_cjk_content() {
        assert_eq!(
            book_style(Some("zh-CN"), "English body"),
            BookStyle::Wonderous
        );
        assert_eq!(book_style(Some("ja"), "短い本文"), BookStyle::AiWriter);
        assert_eq!(book_style(Some("ko_KR"), "짧은 본문"), BookStyle::AiWriter);
        assert_eq!(
            book_style(None, &"这是一本没有语言元数据的中文书籍正文。".repeat(8)),
            BookStyle::AiWriter
        );
        assert_eq!(
            book_style(None, "An English book with a short 中文 title."),
            BookStyle::Wonderous
        );
        assert_eq!(
            book_style(
                Some("zh"),
                &"This is a mislabeled English book. ".repeat(20)
            ),
            BookStyle::Wonderous
        );
        assert_eq!(
            resolve_book_style(BookStyleRule::AiwriterBook, Some("en"), "English body"),
            BookStyle::AiWriter
        );
    }

    #[test]
    fn separates_cache_keys_for_manual_template_rules() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let source = book.join("book.typeset.md");
        let content = "# Book\n\nEnglish body.\n";
        fs::write(&source, content).unwrap();
        let cache = vault.path().join("cache");
        let mut wonderous = request(vault.path(), &source, content);
        wonderous.book_style = BookStyleRule::WonderousBook;
        let mut aiwriter = request(vault.path(), &source, content);
        aiwriter.book_style = BookStyleRule::AiwriterBook;

        let first = render(&cache, &wonderous).unwrap();
        let second = render(&cache, &aiwriter).unwrap();

        assert_ne!(first.cache_key, second.cache_key);
    }

    #[test]
    fn exposes_a_small_preview_without_recompiling_every_subchapter() {
        let markdown = format!(
            "# Part One\n\nIntro.\n\n## 1\n\n## Chapter title\n\n{}",
            (0..100)
                .map(|_| format!("{}\n\n", "paragraph ".repeat(100)))
                .collect::<String>()
        );
        let chunks = chapter_chunks(markdown);

        assert_eq!(chunks.len(), 3, "got {} chunks", chunks.len());
        assert!(chunks[0].markdown.starts_with("# Part One"));
        assert!(chunks[0].markdown.len() <= QUICK_PREVIEW_BYTES);
        assert!(chunks[1].markdown.len() > QUICK_PREVIEW_BYTES);
        assert!(!chunks[1].chapter_start);
    }

    #[test]
    fn long_first_chapter_cannot_bypass_the_preview_budget() {
        let markdown = format!(
            "# First\n\n{}\n# Second\n\nEnd.\n",
            "A short paragraph for a very long first chapter.\n\n".repeat(8_000)
        );
        let chunks = chapter_chunks(markdown.clone());
        assert!(chunks[0].markdown.len() <= QUICK_PREVIEW_BYTES);
        assert!(chunks
            .iter()
            .skip(1)
            .all(|chunk| chunk.markdown.len() <= MAX_CONTINUATION_BYTES));
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.markdown.as_str())
                .collect::<String>(),
            markdown
        );
    }

    #[test]
    fn oversized_nested_blocks_are_never_split_internally() {
        for block in [
            format!("```text\n{}```\n", "code line\n".repeat(10_000)),
            format!(
                "- First item\n\n{}",
                "  Nested paragraph.\n\n".repeat(5_000)
            ),
            format!("<div>\n{}\n</div>\n", "HTML line\n".repeat(10_000)),
            format!(
                "| One | Two |\n| --- | --- |\n{}",
                "| a | b |\n".repeat(10_000)
            ),
        ] {
            let markdown = format!("# Book\n\n{block}\n# End\n\nDone.\n");
            let chunks = chapter_chunks(markdown.clone());
            assert!(
                chunks
                    .iter()
                    .any(|chunk| chunk.markdown.contains(block.trim_end())),
                "split a block: {}",
                &block[..block.len().min(40)]
            );
            assert!(chunks.last().unwrap().markdown.contains("# End\n\nDone."));
        }
    }

    #[test]
    fn keeps_reference_links_and_footnotes_defined_in_later_batches() {
        let chunks = chapter_chunks(format!(
            "# First\n\n[Useful link][source] and a note[^note].\n\n{}\n# Second\n\n[source]: https://example.com\n\n[^note]: A footnote with [another][source].\n",
            "A short paragraph.\n\n".repeat(5_000),
        ));
        let first = &chunks[0].markdown;
        assert!(first.contains("[source]: https://example.com"));
        assert!(first.contains("[^note]: A footnote"));
        assert!(Parser::new_ext(first, Options::all())
            .any(|event| matches!(event, Event::FootnoteReference(_))));
        assert!(Parser::new_ext(first, Options::all())
            .any(|event| matches!(event, Event::Start(Tag::Link { .. }))));
    }

    #[test]
    fn repairs_a_cache_with_a_missing_page() {
        let vault = tempfile::tempdir().unwrap();
        let source = vault.path().join("book.typeset.md");
        let content = "# Book\n\nBody.\n";
        fs::write(&source, content).unwrap();
        let cache = vault.path().join("cache");
        let request = request(vault.path(), &source, content);
        let first = render(&cache, &request).unwrap();
        fs::remove_file(
            cache
                .join(CACHE_SCHEMA)
                .join(&first.cache_key)
                .join("page-0000.svg"),
        )
        .unwrap();
        let repaired = render(&cache, &request).unwrap();
        assert!(!repaired.hit);
        assert!(page(&cache, &repaired.cache_key, 0)
            .unwrap()
            .starts_with("<svg"));
        assert!(render(&cache, &request).unwrap().hit);
    }

    #[test]
    fn session_uses_the_image_snapshot_that_was_hashed() {
        let vault = tempfile::tempdir().unwrap();
        let source = vault.path().join("book.typeset.md");
        let image = vault.path().join("image.svg");
        let content = "# Book\n\n![](image.svg)\n";
        fs::write(&source, content).unwrap();
        fs::write(&image, r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>"#).unwrap();
        let (_, session) = prepare(
            &vault.path().join("cache"),
            &request(vault.path(), &source, content),
        )
        .unwrap();
        fs::remove_file(image).unwrap();
        let mut session = session.unwrap();
        while !render_next(&mut session).unwrap().complete {}
    }

    #[test]
    fn rejects_remote_and_escaping_images() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        assert!(local_image_paths("![](https://example.com/a.png)", &book, vault.path()).is_err());
        assert!(local_image_paths("![](data:image/png;base64,AAAA)", &book, vault.path()).is_err());
        assert!(local_image_paths("![](../a.png)", &book, vault.path()).is_err());
    }

    #[test]
    fn compiles_chinese_commonmark_and_reuses_the_cache() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let source = book.join("book.typeset.md");
        let content = "---\ntype: Book\n---\n# 中文书名\n\n正文 **加粗**\n\n- 列表\n";
        fs::write(&source, content).unwrap();
        let cache = vault.path().join("cache");
        let first = render(&cache, &request(vault.path(), &source, content)).unwrap();
        assert!(!first.hit);
        assert!(first.page_count >= 1);
        assert!(page(&cache, &first.cache_key, 0)
            .unwrap()
            .starts_with("<svg"));
        let second = render(&cache, &request(vault.path(), &source, content)).unwrap();
        assert!(second.hit);
        assert_eq!(second.cache_key, first.cache_key);
    }

    #[test]
    fn compiles_the_ebook_import_semantic_contract() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let source = book.join("book.typeset.md");
        fs::write(
            book.join("diagram.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>"#,
        )
        .unwrap();
        let content = r#"# Chapter

> Quoted text.

H<sub>2</sub>O, x<sup>2</sup>, <mark>important</mark>, <s>obsolete</s>.

<dl>
<dt>Latency</dt>
<dd>Time needed for one operation.</dd>
</dl>

<figure>

![System diagram](diagram.svg)

<figcaption>Figure 1. System diagram.</figcaption>

</figure>
"#;
        fs::write(&source, content).unwrap();

        let canonical_vault = fs::canonicalize(vault.path()).unwrap();
        let images = local_image_paths(content, &book, &canonical_vault).unwrap();
        assert_eq!(
            images,
            vec![fs::canonicalize(book.join("diagram.svg")).unwrap()]
        );

        let rendered = render(
            &vault.path().join("cache"),
            &request(vault.path(), &source, content),
        )
        .unwrap();
        assert!(rendered.page_count >= 1);
    }

    #[test]
    fn changing_a_local_image_invalidates_the_cache() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let source = book.join("book.typeset.md");
        let content = "# Illustrated\n\n![](cover.svg)\n";
        fs::write(&source, content).unwrap();
        let image = book.join("cover.svg");
        fs::write(&image, r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>"#).unwrap();
        let cache = vault.path().join("cache");

        let first = render(&cache, &request(vault.path(), &source, content)).unwrap();
        fs::write(&image, r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>"#).unwrap();
        let second = render(&cache, &request(vault.path(), &source, content)).unwrap();

        assert_ne!(second.cache_key, first.cache_key);
        assert!(!second.hit);
    }

    #[test]
    fn compiles_a_multisection_book_with_tables_code_and_images() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let source = book.join("book.typeset.md");
        fs::write(
            book.join("diagram.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#2563eb"/></svg>"##,
        )
        .unwrap();
        let mut content = String::from("# 长书测试\n\n![](diagram.svg)\n\n| 列一 | 列二 |\n| --- | --- |\n| 中文 | 123 |\n\n```rust\nfn main() {}\n```\n");
        for chapter in 1..=20 {
            content.push_str(&format!(
                "\n# 第 {chapter} 章\n\n这是用于验证分页、中文字体和缓存的正文。\n\n- 要点一\n- 要点二\n"
            ));
        }
        fs::write(&source, &content).unwrap();
        let cache = vault.path().join("cache");

        let first = render(&cache, &request(vault.path(), &source, &content)).unwrap();
        let second = render(&cache, &request(vault.path(), &source, &content)).unwrap();

        assert!(first.page_count >= 20, "got {} pages", first.page_count);
        assert!(second.hit);
        assert_eq!(second.cache_key, first.cache_key);
    }

    #[test]
    fn exposes_the_first_chapter_before_the_full_cache_is_complete() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let source = book.join("book.typeset.md");
        let content = "# First\n\nFirst chapter.\n\n# Second\n\nSecond chapter.\n";
        fs::write(&source, content).unwrap();
        let cache = vault.path().join("cache");

        let (prepared, session) =
            prepare(&cache, &request(vault.path(), &source, content)).unwrap();
        assert_eq!(prepared.page_count, 0);
        assert!(!prepared.complete);
        let mut session = session.unwrap();
        let first = render_next(&mut session).unwrap();
        assert!(!first.complete);
        assert!(first.page_count >= 1);
        assert!(session_page(&session, 0).unwrap().starts_with("<svg"));

        let finished = render_next(&mut session).unwrap();
        assert!(finished.complete);
        assert!(finished.page_count > first.page_count);
        assert!(page(&cache, &finished.cache_key, 0)
            .unwrap()
            .starts_with("<svg"));
    }

    #[test]
    fn aiwriter_continuation_does_not_insert_an_empty_even_page() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let mut session = start_session(
            &vault.path().join("cache"),
            "a".repeat(64),
            ValidatedSource {
                book_dir: book,
                markdown: "# Placeholder\n".into(),
                title: "中文书名".into(),
                author: "作者".into(),
                book_style: BookStyle::AiWriter,
                images: vec![],
            },
        )
        .unwrap();

        let document = compile_chunk(
            &mut session.engine,
            CompileInput {
                markdown: "# 第 二 章\n\n这里是必须出现在下一页的正文。",
                page_offset: 3,
                title: "中文书名",
                author: "作者",
                book_style: BookStyle::AiWriter,
                first: false,
                chapter_start: true,
            },
        )
        .unwrap();

        assert_eq!(document.pages().len(), 1);
        assert!(typst_svg::svg(&document.pages()[0], &Default::default()).len() > 2_000);
    }

    #[test]
    fn tolerates_dangling_epub_fragment_links() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let source = book.join("book.typeset.md");
        let content = "# Index\n\n[A](#calibre_link-373) [Website](https://example.com)\n";
        fs::write(&source, content).unwrap();
        let cache = vault.path().join("cache");

        let rendered = render(&cache, &request(vault.path(), &source, content)).unwrap();
        assert!(rendered.page_count >= 1);
        assert!(page(&cache, &rendered.cache_key, 0)
            .unwrap()
            .starts_with("<svg"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_source_or_image() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let external_source = outside.path().join("book.typeset.md");
        fs::write(&external_source, "# Outside\n").unwrap();
        let linked_source = book.join("book.typeset.md");
        symlink(&external_source, &linked_source).unwrap();
        assert!(validate_source(&request(vault.path(), &linked_source, "# Outside\n")).is_err());

        fs::remove_file(&linked_source).unwrap();
        fs::write(&linked_source, "![](cover.svg)\n").unwrap();
        let external_image = outside.path().join("cover.svg");
        fs::write(
            &external_image,
            r#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
        )
        .unwrap();
        symlink(&external_image, book.join("cover.svg")).unwrap();
        assert!(
            validate_source(&request(vault.path(), &linked_source, "![](cover.svg)\n")).is_err()
        );
    }

    #[test]
    fn rejects_invalid_cache_keys_and_out_of_range_pages() {
        let vault = tempfile::tempdir().unwrap();
        let book = vault.path().join("book");
        fs::create_dir(&book).unwrap();
        let source = book.join("book.typeset.md");
        fs::write(&source, "# Book\n").unwrap();
        let cache = vault.path().join("cache");
        let rendered = render(&cache, &request(vault.path(), &source, "# Book\n")).unwrap();

        assert!(page(&cache, "../manifest.json", 0).is_err());
        assert!(page(&cache, &rendered.cache_key, rendered.page_count).is_err());
    }
}
