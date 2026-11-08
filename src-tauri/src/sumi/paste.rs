//! Clipboard conversion uses html5ever without a renderer, script engine or network.
//! Foreign styling is discarded; the canonical result is plain text or Markdown.
use html5ever::{
    tendril::StrTendril,
    tokenizer::{BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer},
};
use std::cell::RefCell;

/// Plain clipboard data wins over advertised rich alternatives. HTML-only
/// inputs use the existing tokenizer with no renderer, network or style import.
pub fn markdown(text: Option<&str>, html: Option<&str>) -> Result<String, String> {
    if let Some(text) = text { return Ok(text.replace("\r\n", "\n").replace('\r', "\n")); }
    let Some(input) = html else { return Err("剪贴板没有可用文本".into()); };
    if input.len() > 2 * 1024 * 1024 { return Err("剪贴板超过 2 MiB，请分段粘贴".into()); }
    let queue = BufferQueue::default(); queue.push_back(StrTendril::from_slice(input));
    let tokenizer = Tokenizer::new(PlainSink(RefCell::new(PlainState::default())), Default::default());
    let _ = tokenizer.feed(&queue); tokenizer.end();
    Ok(tokenizer.sink.0.into_inner().text.trim_end_matches('\n').to_owned())
}
#[derive(Default)]
struct PlainState { text: String, skip: Vec<String>, pre: usize }
struct PlainSink(RefCell<PlainState>);
impl PlainState {
    fn line(&mut self) { if !self.text.is_empty() && !self.text.ends_with('\n') { self.text.push('\n'); } }
}
impl TokenSink for PlainSink {
    type Handle = ();
    fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
        let mut s = self.0.borrow_mut();
        match token {
            Token::TagToken(tag) => {
                let name = tag.name.to_string(); let start = tag.kind == TagKind::StartTag;
                if matches!(name.as_str(), "head" | "script" | "style" | "template") {
                    if start { s.skip.push(name); } else if let Some(i) = s.skip.iter().rposition(|n| n == &name) { s.skip.truncate(i); }
                    return TokenSinkResult::Continue;
                }
                if !s.skip.is_empty() { return TokenSinkResult::Continue; }
                if name == "pre" { if start { s.pre += 1; } else { s.pre = s.pre.saturating_sub(1); } }
                if matches!(name.as_str(), "p"|"div"|"br"|"li"|"tr"|"blockquote"|"pre"|"h1"|"h2"|"h3"|"h4"|"h5"|"h6") { s.line(); }
                if start && name == "li" { s.text.push_str("- "); }
                if !start && matches!(name.as_str(), "td"|"th") && !s.text.ends_with('\t') { s.text.push('\t'); }
                if start && name == "img" {
                    let alt = tag.attrs.iter().find(|a| a.name.local.as_ref() == "alt").map(|a| a.value.as_ref()).unwrap_or("");
                    s.text.push_str("[图片"); if !alt.is_empty() { s.text.push_str(": "); s.text.push_str(alt); } s.text.push(']');
                }
            }
            Token::CharacterTokens(text) if s.skip.is_empty() => {
                if s.pre > 0 { s.text.push_str(&text); }
                else { for c in text.chars() {
                    if c.is_ascii_whitespace() { if !s.text.is_empty() && !s.text.ends_with(char::is_whitespace) { s.text.push(' '); } }
                    else { s.text.push(c); }
                } }
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plain_wins_and_html_only_becomes_text_without_external_styles_or_active_content() {
        assert_eq!(markdown(Some("**source**\r\n"), Some("<b>other</b>")).unwrap(), "**source**\n");
        assert_eq!(markdown(Some(""), Some("<b>other</b>")).unwrap(), "");
        let text = markdown(None, Some("<html><head><style>bad</style></head><body><p style='color:red;font-family:Evil'>Hello &amp; <b>world</b></p><script>bad()</script><ul><li>A</li><li>B</li></ul><img src='https://example.invalid/track' alt='diagram'><pre>x  &lt; y\n z</pre></body></html>")).unwrap();
        assert_eq!(text, "Hello & world\n- A\n- B\n[图片: diagram]\nx  < y\n z");
        assert!(!text.contains("bad")); assert!(!text.contains("Evil"));
        assert!(markdown(None, None).is_err());
    }
    #[test]
    fn active_content_images_and_tables_only_yield_inert_text() {
        for (input, expected) in [
            ("<script>alert(1)</script>", ""),
            ("<img src='https://example.invalid/track'>", "[图片]"),
            ("<table><tr><td>x</td><td>y</td></tr></table>", "x\ty\t"),
            ("<a href='javascript:alert(1)'>label</a>", "label"),
        ] { assert_eq!(markdown(None, Some(input)).unwrap(), expected); }
    }
    #[test]
    fn explicit_plain_fallback_preserves_markdown_characters_as_literal_text() {
        for (plain, html) in [
            (None, Some("<p>**stars** &amp; [link](https://example.com)</p>")),
            (Some("**RTF text**\r\nnext"), None),
            (Some("[文件: file:///tmp/**name**]"), None),
            (Some("[图片]"), None),
        ] {
            let text = markdown(plain, html).unwrap();
            let mut doc = write_core::Document::new("00000000-0000-4000-8000-000000000001", 1, 1).unwrap();
            let view = write_core::render::SourceMap::new("", 0);
            view.apply_edit(&mut doc, &write_core::render::TextRange::default(), &text, 1).unwrap();
            let result = write_core::render::SourceMap::new(&doc.body(), doc.revision());
            assert_eq!(result.document.text, text);
            assert!(!result.document.runs.iter().any(|r| r.bold || r.italic || r.link.is_some()));
            doc.undo(2).unwrap(); assert_eq!(doc.body(), "");
        }
    }
    #[test]
    fn oversized_html_is_rejected_before_tokenization() {
        assert!(markdown(None, Some(&"x".repeat(2 * 1024 * 1024 + 1))).is_err());
    }
}
