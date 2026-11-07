//! Source-preserving Markdown projection. Hidden syntax never enters the native text buffer.
use crate::{utf16_to_byte, Document, Error, Result};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use std::ops::Range;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct TextRange {
    pub start: u32,
    pub length: u32,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct StyleRun {
    pub range: TextRange,
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub heading: u8,
    pub quote: bool,
    pub link: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct RenderDocument {
    pub text: String,
    pub runs: Vec<StyleRun>,
}
#[derive(Clone, Debug)]
struct Piece {
    view: Range<u32>,
    source: Range<usize>,
}
#[derive(Clone, Debug)]
pub struct SourceMap {
    pub revision: u64,
    pub document: RenderDocument,
    source: String,
    pieces: Vec<Piece>,
    protected: Vec<Range<usize>>,
    styles: Vec<(Range<usize>, StyleRun)>,
}
impl SourceMap {
    pub fn new(source: &str, revision: u64) -> Self {
        let mut hidden = vec![false; source.len()];
        let mut protected = Vec::new();
        let mut styles = Vec::new();
        let mut replacements = Vec::new();
        let events: Vec<_> = Parser::new_ext(
            source,
            Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES,
        )
        .into_offset_iter()
        .collect();
        let mut links: Vec<(Range<usize>, String, Option<Range<usize>>)> = Vec::new();
        for (event, range) in &events {
            match event {
                Event::Start(
                    Tag::CodeBlock(_)
                    | Tag::HtmlBlock
                    | Tag::Table(_)
                    | Tag::Image { .. }
                    | Tag::FootnoteDefinition(_),
                ) => protected.push(range.clone()),
                Event::Start(Tag::Strong) => {
                    mark(&mut hidden, range.start..range.start + 2);
                    mark(&mut hidden, range.end - 2..range.end);
                    styles.push((
                        range.clone(),
                        StyleRun {
                            bold: true,
                            ..Default::default()
                        },
                    ));
                }
                Event::Start(Tag::Emphasis) => {
                    mark(&mut hidden, range.start..range.start + 1);
                    mark(&mut hidden, range.end - 1..range.end);
                    styles.push((
                        range.clone(),
                        StyleRun {
                            italic: true,
                            ..Default::default()
                        },
                    ));
                }
                Event::Start(Tag::Strikethrough) => {
                    mark(&mut hidden, range.start..range.start + 2);
                    mark(&mut hidden, range.end - 2..range.end);
                    styles.push((
                        range.clone(),
                        StyleRun {
                            strike: true,
                            ..Default::default()
                        },
                    ));
                }
                Event::Start(Tag::Heading { level, .. }) => {
                    let raw = &source[range.clone()];
                    let hashes = raw.bytes().take_while(|b| *b == b'#').count();
                    if hashes > 0 {
                        let width = raw[hashes..]
                            .bytes()
                            .take_while(|b| *b == b' ' || *b == b'\t')
                            .count();
                        mark(&mut hidden, range.start..range.start + hashes + width);
                    } else {
                        protected.push(range.clone());
                    }
                    let trimmed = raw.trim_end_matches(['\n', ' ', '\t']);
                    let closing = trimmed.bytes().rev().take_while(|b| *b == b'#').count();
                    if closing > 0
                        && trimmed.len() > closing
                        && trimmed.as_bytes()[trimmed.len() - closing - 1] == b' '
                    {
                        let begin = trimmed[..trimmed.len() - closing]
                            .trim_end_matches([' ', '\t'])
                            .len();
                        mark(
                            &mut hidden,
                            range.start + begin..range.start + raw.trim_end_matches('\n').len(),
                        );
                    }
                    styles.push((
                        range.clone(),
                        StyleRun {
                            heading: *level as u8,
                            ..Default::default()
                        },
                    ));
                }
                Event::Start(Tag::BlockQuote(_)) => {
                    for (start, line) in source_lines(source, range.clone()) {
                        let n = line.bytes().take_while(|b| *b == b' ').count();
                        if n <= 3 && line[n..].starts_with('>') {
                            let end = start + n + 1 + usize::from(line[n + 1..].starts_with(' '));
                            mark(&mut hidden, start..end);
                        }
                    }
                    styles.push((
                        range.clone(),
                        StyleRun {
                            quote: true,
                            ..Default::default()
                        },
                    ));
                }
                Event::Start(Tag::Item) => {
                    let raw = &source[range.clone()];
                    let n = raw.bytes().take_while(|b| *b == b' ').count();
                    let tail = &raw[n..];
                    let marker = if tail.starts_with("- ")
                        || tail.starts_with("* ")
                        || tail.starts_with("+ ")
                    {
                        2
                    } else {
                        let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
                        if digits > 0
                            && (tail[digits..].starts_with(". ")
                                || tail[digits..].starts_with(") "))
                        {
                            digits + 2
                        } else {
                            0
                        }
                    };
                    if marker > 0 {
                        mark(&mut hidden, range.start..range.start + n + marker);
                    }
                }
                Event::Start(Tag::Link { dest_url, .. }) => {
                    links.push((range.clone(), dest_url.to_string(), None))
                }
                Event::End(TagEnd::Link) => {
                    if let Some((outer, url, Some(inner))) = links.pop() {
                        mark(&mut hidden, outer.start..inner.start);
                        mark(&mut hidden, inner.end..outer.end);
                        styles.push((
                            outer,
                            StyleRun {
                                link: Some(url),
                                ..Default::default()
                            },
                        ));
                    }
                }
                Event::Text(text) => {
                    // pulldown ranges exclude the escape backslash for a literal punctuation.
                    if range.start > 0 && source.as_bytes()[range.start - 1] == b'\\' {
                        let slashes = source[..range.start]
                            .bytes()
                            .rev()
                            .take_while(|b| *b == b'\\')
                            .count();
                        if slashes % 2 == 1 {
                            if let Some(c) = source[range.clone()]
                                .chars()
                                .next()
                                .filter(|c| c.is_ascii_punctuation())
                            {
                                replacements.push((
                                    range.start - 1..range.start + c.len_utf8(),
                                    c.to_string(),
                                ));
                            }
                        }
                    }
                    for (_, _, inner) in &mut links {
                        match inner {
                            Some(r) => {
                                r.start = r.start.min(range.start);
                                r.end = r.end.max(range.end);
                            }
                            None => *inner = Some(range.clone()),
                        }
                    }
                    if text.as_ref() != &source[range.clone()] {
                        replacements.push((range.clone(), text.to_string()));
                    }
                }
                Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) | Event::Rule => {
                    protected.push(range.clone())
                }
                Event::HardBreak if source[range.clone()].ends_with('\n') => {
                    // Keep one LF while hiding the Markdown-only hard-break suffix.
                    mark(&mut hidden, range.start..range.end - 1);
                }
                _ => {}
            }
        }
        for r in &protected {
            hidden[r.clone()].fill(false);
        }
        replacements.retain(|(r, _)| !protected.iter().any(|p| overlap(p, r)));
        replacements.sort_by_key(|(r, _)| r.start);
        let mut text = String::new();
        let mut pieces = Vec::new();
        let mut pos = 0;
        let mut units = 0;
        let mut rep = 0;
        while pos < source.len() {
            if hidden[pos] {
                pos += 1;
                continue;
            }
            while rep < replacements.len() && replacements[rep].0.start < pos {
                rep += 1;
            }
            if let Some((r, value)) = replacements.get(rep).filter(|(r, _)| r.start == pos) {
                let n = value.encode_utf16().count() as u32;
                text.push_str(value);
                pieces.push(Piece {
                    view: units..units + n,
                    source: r.clone(),
                });
                units += n;
                pos = r.end;
                rep += 1;
            } else {
                let c = source[pos..].chars().next().unwrap();
                let n = c.len_utf16() as u32;
                text.push(c);
                pieces.push(Piece {
                    view: units..units + n,
                    source: pos..pos + c.len_utf8(),
                });
                units += n;
                pos += c.len_utf8();
            }
        }
        let mut runs = Vec::new();
        for (r, style) in &styles {
            if protected.iter().any(|p| overlap(p, r)) {
                continue;
            }
            let selected: Vec<_> = pieces.iter().filter(|p| overlap(&p.source, r)).collect();
            if let (Some(first), Some(last)) = (selected.first(), selected.last()) {
                let mut run = style.clone();
                run.range = TextRange {
                    start: first.view.start,
                    length: last.view.end - first.view.start,
                };
                runs.push(run);
            }
        }
        let runs = flatten_runs(runs);
        Self {
            revision,
            document: RenderDocument { text, runs },
            source: source.into(),
            pieces,
            protected,
            styles,
        }
    }
    pub fn source_range(&self, range: &TextRange) -> Result<Range<usize>> {
        self.map_range(range, false)
    }
    fn map_range(&self, range: &TextRange, read_only_selection: bool) -> Result<Range<usize>> {
        let end = range
            .start
            .checked_add(range.length)
            .ok_or(Error::InvalidOffset)?;
        utf16_to_byte(&self.document.text, range.start)?;
        utf16_to_byte(&self.document.text, end)?;
        let right = self.pieces.partition_point(|p| p.view.end <= range.start);
        let left = self.pieces.partition_point(|p| p.view.end <= end);
        let start = if range.length == 0 && right > 0 {
            self.pieces[right - 1].source.end
        } else {
            self.pieces
                .get(right)
                .map(|p| p.source.start)
                .unwrap_or(self.source.len())
        };
        let stop = if range.length == 0 {
            start
        } else {
            self.pieces
                .get(left.wrapping_sub(1))
                .map(|p| p.source.end)
                .ok_or(Error::InvalidOffset)?
        };
        if self
            .pieces
            .get(right)
            .is_some_and(|p| p.view.start != range.start)
            && range.start != self.document.text.encode_utf16().count() as u32
        {
            return Err(Error::InvalidOffset);
        }
        if range.length > 0
            && self
                .pieces
                .get(left.wrapping_sub(1))
                .is_none_or(|p| p.view.end != end)
        {
            return Err(Error::InvalidOffset);
        }
        let mapped = start..stop;
        if !read_only_selection
            && self.protected.iter().any(|p| {
                if mapped.is_empty() {
                    p.start <= start && start < p.end
                } else {
                    overlap(p, &mapped)
                }
            })
        {
            return Err(Error::Invalid(
                "unsupported Markdown block; use Source".into(),
            ));
        }
        Ok(mapped)
    }
    pub fn anchor_selection(
        &self,
        doc: &Document,
        range: &TextRange,
    ) -> Result<crate::SelectionAnchor> {
        if doc.revision() != self.revision {
            return Err(Error::StaleRevision);
        }
        let source = self.map_range(range, true)?;
        doc.anchor_selection(
            self.source[..source.start].encode_utf16().count() as u32,
            self.source[source].encode_utf16().count() as u32,
        )
    }
    pub fn resolve_selection(
        &self,
        doc: &Document,
        anchor: &crate::SelectionAnchor,
    ) -> Result<TextRange> {
        if doc.revision() != self.revision {
            return Err(Error::StaleRevision);
        }
        let (start, length) = doc.resolve_selection(anchor)?;
        let a = self.visible_offset(start)?;
        let b = self.visible_offset(start + length)?;
        Ok(TextRange {
            start: a,
            length: b.saturating_sub(a),
        })
    }
    /// Input must already be sanitized to the supported attributed-text subset.
    /// This method never parses HTML/RTF or accesses clipboard resources.
    pub fn apply_rich_paste(
        &self,
        doc: &mut Document,
        range: &TextRange,
        clipboard: &RenderDocument,
        at_ms: i64,
    ) -> Result<Vec<u8>> {
        if doc.revision() != self.revision {
            return Err(Error::StaleRevision);
        }
        if clipboard.text.is_empty() {
            return self.apply_edit(doc, range, "", at_ms);
        }
        let replacement = rich_markdown(clipboard)?;
        let source = self.source_range(range)?;
        doc.replace(
            self.revision,
            self.source[..source.start].encode_utf16().count() as u32,
            self.source[source].encode_utf16().count() as u32,
            &replacement,
            at_ms,
        )
    }
    pub fn apply_edit(
        &self,
        doc: &mut Document,
        range: &TextRange,
        replacement: &str,
        at_ms: i64,
    ) -> Result<Vec<u8>> {
        if doc.revision() != self.revision {
            return Err(Error::StaleRevision);
        }
        let mut source = self.source_range(range)?;
        if replacement.is_empty() && range.length > 0 {
            // Removing all visible text of a formatted span also removes its now-empty delimiters.
            for (outer, _) in &self.styles {
                let selected: Vec<_> = self
                    .pieces
                    .iter()
                    .filter(|p| overlap(&p.source, outer))
                    .collect();
                if selected
                    .first()
                    .is_some_and(|p| p.view.start == range.start)
                    && selected
                        .last()
                        .is_some_and(|p| p.view.end == range.start + range.length)
                {
                    source.start = source.start.min(outer.start);
                    source.end = source.end.max(outer.end);
                }
            }
        }
        let start = self.source[..source.start].encode_utf16().count() as u32;
        let len = self.source[source.clone()].encode_utf16().count() as u32;
        let mut escaped = escape_literal(replacement);
        let prefix = self.source[..source.start]
            .rsplit('\n')
            .next()
            .unwrap_or("");
        if replacement.starts_with('.')
            && !prefix.is_empty()
            && prefix.bytes().all(|b| b.is_ascii_digit())
        {
            escaped.insert(0, '\\');
        }
        doc.replace(self.revision, start, len, &escaped, at_ms)
    }
    pub fn apply_format(
        &self,
        doc: &mut Document,
        range: &TextRange,
        format: &str,
        at_ms: i64,
    ) -> Result<Vec<u8>> {
        if doc.revision() != self.revision {
            return Err(Error::StaleRevision);
        }
        let mut source = self.source_range(range)?;
        if matches!(
            format,
            "paragraph" | "quote" | "bullet_list" | "ordered_list"
        ) || format.starts_with("heading")
        {
            let start = self.source[..source.start].rfind('\n').map_or(0, |i| i + 1);
            let end = if source.end > start && self.source[..source.end].ends_with('\n') {
                source.end - 1
            } else {
                self.source[source.end..]
                    .find('\n')
                    .map_or(self.source.len(), |i| source.end + i)
            };
            let prefix = match format {
                "paragraph" => String::new(),
                "quote" => "> ".into(),
                "bullet_list" => "- ".into(),
                "ordered_list" => "1. ".into(),
                _ => {
                    let level = format
                        .strip_prefix("heading")
                        .and_then(|s| s.parse::<usize>().ok())
                        .filter(|n| (1..=6).contains(n))
                        .ok_or_else(|| Error::Invalid("heading level".into()))?;
                    format!("{} ", "#".repeat(level))
                }
            };
            let replacement = self.source[start..end]
                .split('\n')
                .map(|line| {
                    let hashes = line.bytes().take_while(|b| *b == b'#').count();
                    let body = if (1..=6).contains(&hashes) && line[hashes..].starts_with(' ') {
                        &line[hashes + 1..]
                    } else if ["> ", "- ", "* ", "+ "].iter().any(|p| line.starts_with(p)) {
                        &line[2..]
                    } else {
                        let digits = line.bytes().take_while(u8::is_ascii_digit).count();
                        if (1..=9).contains(&digits)
                            && (line[digits..].starts_with(". ")
                                || line[digits..].starts_with(") "))
                        {
                            &line[digits + 2..]
                        } else {
                            line
                        }
                    };
                    format!("{prefix}{body}")
                })
                .collect::<Vec<_>>()
                .join("\n");
            return doc.replace(
                self.revision,
                self.source[..start].encode_utf16().count() as u32,
                self.source[start..end].encode_utf16().count() as u32,
                &replacement,
                at_ms,
            );
        }
        if source.is_empty() {
            return Err(Error::Invalid("select text to format".into()));
        }
        let marker = match format {
            "bold" => "**",
            "italic" => "*",
            "strike" => "~~",
            _ => return Err(Error::Invalid("unsupported format".into())),
        };
        let mut replacement = format!("{marker}{}{marker}", &self.source[source.clone()]);
        for (outer, style) in &self.styles {
            let target = match format {
                "bold" => style.bold,
                "italic" => style.italic,
                "strike" => style.strike,
                _ => false,
            };
            if target
                && outer.start + marker.len() == source.start
                && outer.end - marker.len() == source.end
            {
                replacement = self.source[source.clone()].to_string();
                source = outer.clone();
                break;
            }
        }
        let start = self.source[..source.start].encode_utf16().count() as u32;
        let len = self.source[source].encode_utf16().count() as u32;
        doc.replace(self.revision, start, len, &replacement, at_ms)
    }
    pub fn apply_link(
        &self,
        doc: &mut Document,
        range: &TextRange,
        url: &str,
        at_ms: i64,
    ) -> Result<Vec<u8>> {
        if doc.revision() != self.revision {
            return Err(Error::StaleRevision);
        }
        let source = self.source_range(range)?;
        if source.is_empty() || url.is_empty() || url.chars().any(char::is_control) {
            return Err(Error::Invalid("link text and URL required".into()));
        }
        let dest = url
            .replace('\\', "%5C")
            .replace(' ', "%20")
            .replace('<', "%3C")
            .replace('>', "%3E");
        let replacement = format!("[{}](<{dest}>)", &self.source[source.clone()]);
        doc.replace(
            self.revision,
            self.source[..source.start].encode_utf16().count() as u32,
            self.source[source].encode_utf16().count() as u32,
            &replacement,
            at_ms,
        )
    }
    pub fn visible_offset(&self, source_utf16: u32) -> Result<u32> {
        let byte = utf16_to_byte(&self.source, source_utf16)?;
        let index = self.pieces.partition_point(|p| p.source.end <= byte);
        Ok(self
            .pieces
            .get(index)
            .map(|p| p.view.start)
            .unwrap_or(self.document.text.encode_utf16().count() as u32))
    }
}
fn overlap(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start < b.end && a.end > b.start
}
fn mark(hidden: &mut [bool], range: Range<usize>) {
    if range.start <= range.end && range.end <= hidden.len() {
        hidden[range].fill(true);
    }
}
fn source_lines(source: &str, range: Range<usize>) -> Vec<(usize, &str)> {
    let mut pos = range.start;
    source[range]
        .split_inclusive('\n')
        .map(|s| {
            let at = pos;
            pos += s.len();
            (at, s)
        })
        .collect()
}
fn escape_literal(text: &str) -> String {
    let mut out = String::new();
    let mut digits = 0usize;
    let mut number_prefix = true;
    for c in text.chars() {
        if (c == '.' && number_prefix && digits > 0)
            || matches!(
                c,
                '\\' | '*' | '_' | '[' | ']' | '<' | '>' | '`' | '#' | '~' | '-' | '+'
            )
        {
            out.push('\\');
        }
        out.push(c);
        if c == '\n' {
            digits = 0;
            number_prefix = true;
        } else if number_prefix && c.is_ascii_digit() {
            digits += 1;
        } else {
            number_prefix = false;
        }
    }
    out
}

fn flatten_runs(runs: Vec<StyleRun>) -> Vec<StyleRun> {
    let mut points: Vec<u32> = runs
        .iter()
        .flat_map(|r| [r.range.start, r.range.start + r.range.length])
        .collect();
    points.sort_unstable();
    points.dedup();
    let mut output = Vec::new();
    for pair in points.windows(2) {
        let a = pair[0];
        let b = pair[1];
        if a == b {
            continue;
        }
        let mut style = StyleRun {
            range: TextRange {
                start: a,
                length: b - a,
            },
            ..Default::default()
        };
        let mut any = false;
        for r in &runs {
            if r.range.start <= a && r.range.start + r.range.length >= b {
                any = true;
                style.bold |= r.bold;
                style.italic |= r.italic;
                style.strike |= r.strike;
                style.heading = style.heading.max(r.heading);
                style.quote |= r.quote;
                if r.link.is_some() {
                    style.link = r.link.clone();
                }
            }
        }
        if any {
            output.push(style);
        }
    }
    output
}

/// Serialize only supported clipboard runs, then verify the visible round trip
/// before any canonical transaction is made. Unsupported paste must be offered
/// as explicit plain-text fallback by the host, which retains the original data.
pub fn rich_markdown(document: &RenderDocument) -> Result<String> {
    if document.text.contains('\r')
        || document.text.encode_utf16().count() > crate::MAX_BODY_UTF16 as usize
    {
        return Err(Error::Invalid("clipboard text capacity/newline".into()));
    }
    let mut end = 0;
    for run in &document.runs {
        let next = run
            .range
            .start
            .checked_add(run.range.length)
            .ok_or(Error::InvalidOffset)?;
        utf16_to_byte(&document.text, run.range.start)?;
        utf16_to_byte(&document.text, next)?;
        if run.range.start < end
            || run.heading > 6
            || run
                .link
                .as_ref()
                .is_some_and(|s| s.len() > 4096 || s.chars().any(char::is_control))
        {
            return Err(Error::Invalid(
                "clipboard runs must be ordered, nonoverlapping supported styles".into(),
            ));
        }
        end = next;
    }
    let mut output = String::new();
    let mut open = Vec::<(String, String)>::new();
    let mut index = 0;
    let mut position = 0;
    let mut line_start = true;
    let mut digits = 0;
    let mut number_prefix = true;
    for ch in document.text.chars() {
        while index < document.runs.len()
            && document.runs[index].range.start + document.runs[index].range.length <= position
        {
            index += 1
        }
        let style = document
            .runs
            .get(index)
            .filter(|r| r.range.start <= position);
        let mut desired = Vec::<(String, String)>::new();
        if ch != '\n' {
            if line_start {
                if style.is_some_and(|s| s.quote) {
                    output.push_str("> ")
                }
                if let Some(run) = style.filter(|s| s.heading > 0) {
                    output.push_str(&"#".repeat(run.heading as usize));
                    output.push(' ')
                }
                line_start = false;
            }
            if let Some(run) = style {
                if let Some(link) = run.link.as_ref().filter(|s| !s.is_empty()) {
                    let url = link
                        .replace('\\', "%5C")
                        .replace(' ', "%20")
                        .replace('<', "%3C")
                        .replace('>', "%3E");
                    desired.push(("[".into(), format!("](<{url}>)")));
                }
                if run.strike {
                    desired.push(("~~".into(), "~~".into()))
                }
                if run.bold {
                    desired.push(("**".into(), "**".into()))
                }
                if run.italic {
                    desired.push(("*".into(), "*".into()))
                }
            }
        }
        let common = open
            .iter()
            .zip(&desired)
            .take_while(|(a, b)| a == b)
            .count();
        for (_, close) in open[common..].iter().rev() {
            output.push_str(close)
        }
        for (begin, _) in &desired[common..] {
            output.push_str(begin)
        }
        open = desired;
        if ch == '\n' {
            output.push('\n');
            line_start = true;
            digits = 0;
            number_prefix = true
        } else {
            if ch == '.' && number_prefix && digits > 0 {
                output.push('\\')
            }
            output.push_str(&escape_literal(&ch.to_string()));
            if number_prefix && ch.is_ascii_digit() {
                digits += 1
            } else {
                number_prefix = false
            }
        }
        position += ch.len_utf16() as u32;
    }
    for (_, close) in open.iter().rev() {
        output.push_str(close)
    }
    if SourceMap::new(&output, 0).document.text != document.text {
        return Err(Error::Invalid(
            "clipboard needs explicit plain-text fallback".into(),
        ));
    }
    Ok(output)
}
