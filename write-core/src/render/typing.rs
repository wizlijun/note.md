use super::{escape_literal, rich_markdown, SourceMap, StyleRun, TextRange};
use crate::{utf16_to_byte, Document, Error, Result};

/// Ephemeral input intent. It is never stored in the CRDT or line timestamps.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TypingStyle {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
}
impl TypingStyle {
    pub fn toggle(&mut self, action: &str) {
        match action {
            "bold" => self.bold = !self.bold,
            "italic" => self.italic = !self.italic,
            "strike" => self.strike = !self.strike,
            _ => {}
        }
    }
    fn include(&mut self, run: &StyleRun) {
        self.bold |= run.bold; self.italic |= run.italic; self.strike |= run.strike;
    }
    fn marker(self) -> String {
        format!("{}{}{}", if self.strike { "~~" } else { "" }, if self.bold { "**" } else { "" }, if self.italic { "*" } else { "" })
    }
}
impl SourceMap {
    pub fn typing_style(&self, range: &TextRange) -> Result<TypingStyle> {
        let source = self.source_range(range)?;
        let mut style = TypingStyle::default();
        for (outer, run) in &self.styles {
            if outer.start < source.start && source.start < outer.end { style.include(run); }
        }
        Ok(style)
    }
    /// Prepare all Markdown delimiters before the single canonical replacement.
    /// This also closes surrounding spans when input explicitly turns them off.
    pub fn apply_typing_insert(&self, doc: &mut Document, range: &TextRange, text: &str, markdown: bool, style: TypingStyle, at: i64) -> Result<(Vec<u8>, TextRange)> {
        if doc.revision() != self.revision { return Err(Error::StaleRevision); }
        if text.is_empty() {
            let update = self.apply_edit(doc, range, text, at)?;
            return Ok((update, TextRange { start: range.start, length: 0 }));
        }
        let original = self.source_range(range)?;
        if !markdown && style == TypingStyle::default() && self.typing_style(range)? == style {
            let update = self.apply_edit(doc, range, text, at)?;
            return Ok((update, TextRange { start: range.start + text.encode_utf16().count() as u32, length: 0 }));
        }
        let incoming = if markdown { SourceMap::new(text, 0).document.text } else { text.to_owned() };
        let start = utf16_to_byte(&self.document.text, range.start)?;
        let end = utf16_to_byte(&self.document.text, range.start + range.length)?;
        let expected = format!("{}{}{}", &self.document.text[..start], incoming, &self.document.text[end..]);
        let mut source = original.clone();
        let mut containers: Vec<_> = self.styles.iter().filter_map(|(outer, run)| {
            let width = if run.bold || run.strike { 2 } else if run.italic { 1 } else { return None };
            Some((outer.clone(), &self.source[outer.start..outer.start + width], width))
        }).collect();
        containers.sort_by_key(|(r, _, _)| (r.start, std::cmp::Reverse(r.end)));
        let mut left: Vec<_> = containers.iter().filter(|(r, _, _)| r.start < original.start && original.start < r.end).cloned().collect();
        let mut right: Vec<_> = containers.iter().filter(|(r, _, _)| r.start < original.end && original.end < r.end).cloned().collect();
        let ambient = self.typing_style(range)?;
        let can_continue = !markdown && style == ambient && !text.contains('\n')
            && text.trim() == text && range.length == 0;
        let mut alternate = None;
        let mut moved_leading = "";
        let mut moved_trailing = "";
        let mut inserted = if can_continue {
            escape_literal(text)
        } else {
            // Remove a delimiter only when this replacement would leave its
            // side empty. Nested inline delimiters are handled inside-out.
            for (outer, _, width) in left.clone().into_iter().rev() {
                if source.start == outer.start + width {
                    source.start = outer.start; left.retain(|(r, _, _)| *r != outer);
                }
            }
            for (outer, _, width) in right.clone().into_iter().rev() {
                if source.end == outer.end - width {
                    source.end = outer.end; right.retain(|(r, _, _)| *r != outer);
                }
            }
            // Emphasis delimiters cannot close/open against whitespace.
            // Move adjacent spaces outside the split spans without changing
            // their visible order or applying the new style to old text.
            let before_space = if left.is_empty() { source.start } else { self.source[..source.start].trim_end_matches([' ', '\t']).len() };
            let after_space = if right.is_empty() { source.end } else { self.source.len() - self.source[source.end..].trim_start_matches([' ', '\t']).len() };
            let leading = &self.source[before_space..source.start];
            let trailing = &self.source[source.end..after_space];
            moved_leading = leading; moved_trailing = trailing;
            source.start = before_space; source.end = after_space;
            let close_left: String = left.iter().rev().map(|(_, marker, _)| *marker).collect();
            let open_right: String = right.iter().map(|(_, marker, _)| *marker).collect();
            let (head, tail) = text.split_once('\n').map_or((text, ""), |(head, _)| (head, &text[head.len()..]));
            let tail = if markdown { tail.to_owned() } else { escape_literal(tail) };
            if !markdown {
                let alternate_head = styled_literal(head, style, true);
                alternate = Some(format!("{close_left}{leading}{alternate_head}{tail}{trailing}{open_right}"));
            }
            let head = if markdown { styled_markdown(head, style) } else { styled_literal(head, style, false) };
            format!("{close_left}{leading}{head}{tail}{trailing}{open_right}")
        };
        let candidate = |value: &str| format!("{}{}{}", &self.source[..source.start], value, &self.source[source.end..]);
        let mut valid = SourceMap::new(&candidate(&inserted), 0).document.text == expected;
        if !valid {
            if let Some(value) = alternate.filter(|value| SourceMap::new(&candidate(value), 0).document.text == expected) { inserted = value; valid = true; }
        }
        if !valid {
            // Markdown cannot style every punctuation/whitespace boundary.
            // Keep the user's text and intent, never leak delimiters or drop input.
            if !markdown && style != TypingStyle::default() {
                return self.apply_typing_insert(doc, range, text, false, TypingStyle::default(), at);
            }
            let close_left: String = left.iter().rev().map(|(_, marker, _)| *marker).collect();
            let open_right: String = right.iter().map(|(_, marker, _)| *marker).collect();
            let literal = if markdown { text.to_owned() } else { escape_literal(text) };
            inserted = format!("{close_left}{moved_leading}{literal}{moved_trailing}{open_right}");
            if SourceMap::new(&candidate(&inserted), 0).document.text != expected {
                return Err(Error::Invalid("typing style cannot preserve this Markdown boundary".into()));
            }
        }
        let update = doc.replace(self.revision, self.source[..source.start].encode_utf16().count() as u32,
            self.source[source.clone()].encode_utf16().count() as u32, &inserted, at)?;
        Ok((update, TextRange { start: range.start + incoming.encode_utf16().count() as u32, length: 0 }))
    }
}

fn styled_markdown(source: &str, style: TypingStyle) -> String {
    let map = SourceMap::new(source, 0);
    if !map.protected.is_empty() { return source.to_owned(); }
    let text = &map.document.text;
    let first = text.len() - text.trim_start().len();
    let last = text.trim_end().len();
    let mut document = map.document.clone();
    document.runs.clear();
    let mut offset = 0;
    let mut run_index = 0;
    for (byte, ch) in text.char_indices() {
        while run_index < map.document.runs.len() && map.document.runs[run_index].range.start + map.document.runs[run_index].range.length <= offset { run_index += 1; }
        let mut run = map.document.runs.get(run_index).filter(|r| r.range.start <= offset).cloned().unwrap_or_default();
        run.range = TextRange { start: offset, length: ch.len_utf16() as u32 };
        if first <= byte && byte < last { run.bold |= style.bold; run.italic |= style.italic; run.strike |= style.strike; }
        offset += ch.len_utf16() as u32;
        document.runs.push(run);
    }
    // The rendered model retains heading/quote attributes but deliberately
    // hides list markers; retain that source prefix when serializing a paste.
    let trimmed = source.trim_start();
    let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
    let prefix = if ["- ", "* ", "+ "].iter().any(|p| trimmed.starts_with(p)) { source.len() - trimmed.len() + 2 }
        else if (1..=9).contains(&digits) && (trimmed[digits..].starts_with(". ") || trimmed[digits..].starts_with(") ")) { source.len() - trimmed.len() + digits + 2 } else { 0 };
    rich_markdown(&document).map(|body| format!("{}{body}", &source[..prefix])).unwrap_or_else(|_| source.to_owned())
}

fn styled_literal(text: &str, style: TypingStyle, alternate: bool) -> String {
    let trimmed = text.trim();
    let leading = text.len() - text.trim_start().len();
    if trimmed.is_empty() { return escape_literal(text); }
    let open = if alternate && style.italic { format!("{}{}{}", if style.strike { "~~" } else { "" }, if style.bold { "**" } else { "" }, "_") } else { style.marker() };
    let close: String = open.chars().rev().collect();
    format!("{}{}{}{}{}", escape_literal(&text[..leading]), open, escape_literal(trimmed), close, escape_literal(&text[leading + trimmed.len()..]))
}
