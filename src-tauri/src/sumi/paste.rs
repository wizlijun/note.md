//! Clipboard HTML is tokenized without a renderer, script engine or network loader.
//! Unsupported structures require an explicit plain-text fallback; raw input stays recoverable.
use html5ever::{
    tendril::StrTendril,
    tokenizer::{BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer},
};
use std::cell::RefCell;
use write_core::render::{RenderDocument, StyleRun, TextRange};

#[derive(Default)]
struct State {
    document: RenderDocument,
    stack: Vec<(String, StyleRun)>,
    length: u32,
    unsupported: bool,
    head: usize,
}
struct Sink(RefCell<State>);
impl State {
    fn append(&mut self, text: &str) {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let mut normalized = String::new();
        let mut last = self.document.text.chars().last();
        for ch in text.chars() {
            let ch = if ch.is_ascii_whitespace() { ' ' } else { ch };
            if ch == ' ' && (last.is_none() || last.is_some_and(char::is_whitespace)) {
                continue;
            }
            normalized.push(ch);
            last = Some(ch);
        }
        if normalized.is_empty() {
            return;
        }
        let length = normalized.encode_utf16().count() as u32;
        let mut style = self
            .stack
            .last()
            .map(|(_, s)| s.clone())
            .unwrap_or_default();
        style.range = TextRange {
            start: self.length,
            length,
        };
        if style.bold
            || style.italic
            || style.strike
            || style.heading > 0
            || style.quote
            || style.link.is_some()
        {
            self.document.runs.push(style);
        }
        self.document.text.push_str(&normalized);
        self.length += length;
    }
    fn newline(&mut self, count: usize) {
        if self.document.text.is_empty() {
            return;
        }
        let current = self
            .document
            .text
            .chars()
            .rev()
            .take_while(|&c| c == '\n')
            .count();
        for _ in current..count {
            self.document.text.push('\n');
            self.length += 1;
        }
    }
}
impl TokenSink for Sink {
    type Handle = ();
    fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
        let mut s = self.0.borrow_mut();
        match token {
            Token::TagToken(tag) => {
                let name = tag.name.to_string();
                let start = tag.kind == TagKind::StartTag;
                if name == "head" {
                    if start {
                        s.head += 1
                    } else {
                        s.head = s.head.saturating_sub(1)
                    };
                    return TokenSinkResult::Continue;
                }
                if s.head > 0 {
                    return TokenSinkResult::Continue;
                }
                if matches!(name.as_str(), "html" | "body" | "meta") {
                    return TokenSinkResult::Continue;
                }
                if name == "br" {
                    s.newline(1);
                    return TokenSinkResult::Continue;
                }
                let block = matches!(
                    name.as_str(),
                    "p" | "div" | "blockquote" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                );
                if !matches!(
                    name.as_str(),
                    "p" | "div"
                        | "span"
                        | "strong"
                        | "b"
                        | "em"
                        | "i"
                        | "s"
                        | "del"
                        | "strike"
                        | "a"
                        | "blockquote"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                ) {
                    s.unsupported = true;
                    return TokenSinkResult::Continue;
                }
                if start {
                    if block {
                        s.newline(2)
                    }
                    if s.stack.len() >= 128 {
                        s.unsupported = true;
                        return TokenSinkResult::Continue;
                    }
                    let mut style = s.stack.last().map(|(_, s)| s.clone()).unwrap_or_default();
                    match name.as_str() {
                        "strong" | "b" => style.bold = true,
                        "em" | "i" => style.italic = true,
                        "s" | "del" | "strike" => style.strike = true,
                        "blockquote" => style.quote = true,
                        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                            style.heading = name.as_bytes()[1] - b'0'
                        }
                        _ => {}
                    }
                    for attribute in tag.attrs {
                        let key = attribute.name.local.as_ref();
                        let value = attribute.value.as_ref();
                        if key == "href" && name == "a" {
                            if url::Url::parse(value).ok().is_some_and(|url| {
                                matches!(url.scheme(), "http" | "https" | "mailto")
                            }) {
                                style.link = Some(value.to_owned())
                            } else {
                                s.unsupported = true;
                            }
                        }
                        if key == "style" {
                            for field in value.split(';') {
                                if let Some((key, value)) = field.split_once(':') {
                                    match (
                                        key.trim().to_ascii_lowercase().as_str(),
                                        value.trim().to_ascii_lowercase().as_str(),
                                    ) {
                                        ("font-weight", "bold" | "600" | "700" | "800" | "900") => {
                                            style.bold = true
                                        }
                                        ("font-style", "italic") => style.italic = true,
                                        (
                                            "text-decoration" | "text-decoration-line",
                                            "line-through",
                                        ) => style.strike = true,
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                    if !tag.self_closing {
                        s.stack.push((name, style));
                    }
                } else {
                    if let Some(index) = s.stack.iter().rposition(|(tag, _)| tag == &name) {
                        s.stack.truncate(index);
                    } else {
                        s.unsupported = true;
                    }
                    if block {
                        s.newline(2)
                    }
                }
            }
            Token::CharacterTokens(text) => {
                if s.head == 0 {
                    s.append(&text)
                }
            }
            Token::NullCharacterToken => s.unsupported = true,
            _ => {}
        }
        TokenSinkResult::Continue
    }
}
pub fn html(input: &str) -> Result<RenderDocument, String> {
    if input.len() > 2 * 1024 * 1024 {
        return Err("富文本剪贴板超过 2 MiB；请分段粘贴".into());
    }
    let queue = BufferQueue::default();
    queue.push_back(StrTendril::from_slice(input));
    let tokenizer = Tokenizer::new(Sink(RefCell::new(State::default())), Default::default());
    let _ = tokenizer.feed(&queue);
    tokenizer.end();
    let state = tokenizer.sink.0.into_inner();
    if state.unsupported || state.document.runs.len() > 10000 {
        return Err("剪贴板含未支持的结构，原始草稿已保留。可选择粘贴纯文本。".into());
    }
    Ok(state.document)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_supported_styles_and_decodes_entities() {
        let value = html("<p>Hello <strong>bold &amp; <em>italic</em></strong> 😀</p>").unwrap();
        assert_eq!(value.text, "Hello bold & italic 😀\n\n");
        assert!(value.runs.iter().any(|r| r.bold && r.italic));
        let mut doc =
            write_core::Document::new("00000000-0000-4000-8000-000000000001", 1, 1).unwrap();
        let map = write_core::render::SourceMap::new("", 0);
        map.apply_rich_paste(&mut doc, &TextRange::default(), &value, 1)
            .unwrap();
        assert!(doc.body().contains("**"));
        assert_eq!(
            write_core::render::SourceMap::new(&doc.body(), doc.revision())
                .document
                .text
                .trim(),
            value.text.trim()
        );
    }
    #[test]
    fn never_accepts_active_content_or_complex_structures() {
        for input in [
            "<script>alert(1)</script>",
            "<img src='https://example.invalid/track'>",
            "<table><tr><td>x</td></tr></table>",
            "<a href='javascript:alert(1)'>x</a>",
        ] {
            assert!(html(input).is_err());
        }
    }
}
