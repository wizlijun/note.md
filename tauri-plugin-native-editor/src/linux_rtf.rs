//! Clipboard RTF becomes inert text. The pinned parser is no_std, uses a bounded
//! stack, and has no filesystem, renderer, process, or network capabilities.
//! Keep this conversion independent from GTK so malformed input is testable.
use rclip_rtf::{fonts, Codepage, ControlSymbol, Parser, RunText, Token, Tokenizer};
use std::collections::HashSet;

pub(super) const MAX_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn plain_text(raw: &[u8]) -> Result<String, String> {
    if raw.len() > MAX_BYTES {
        return Err("RTF clipboard exceeds 2 MiB".into());
    }
    let mut parser = Parser::new(raw).map_err(|_| "Invalid RTF clipboard data")?;
    let legacy_fonts: HashSet<_> = fonts(raw, Codepage::default())
        .filter(|font| {
            font.charset
                .is_some_and(|charset| !matches!(charset, 0 | 1))
        })
        .map(|font| font.id)
        .collect();
    let mut output = String::new();
    while let Some(run) = parser.next() {
        let run = run.map_err(|_| "Invalid or excessively nested RTF clipboard data")?;
        if run
            .props
            .font
            .or(parser.default_font())
            .is_some_and(|font| legacy_fonts.contains(&font))
            && matches!(
                Tokenizer::new(&raw[run.offset..]).next(),
                Some(Ok(Token::RawByte(128..=255)))
                    | Some(Ok(Token::ControlSymbol(ControlSymbol::HexByte(128..=255))))
            )
        {
            return Err(
                "RTF uses an unsupported font character set; copy as plain text instead".into(),
            );
        }
        match run.text {
            RunText::Text(text) => output.push_str(text),
            RunText::Char('\u{fffd}') => {
                // Unsupported legacy code pages and broken surrogate sequences
                // must not silently become corrupted prose. Unicode RTF is
                // supported, including Chinese and supplementary characters.
                return Err(
                    "RTF contains undecodable characters; copy as plain text instead".into(),
                );
            }
            RunText::Char(value) => output.push(value),
            RunText::ParagraphBreak | RunText::LineBreak => output.push('\n'),
        }
        if output.len() > MAX_BYTES {
            return Err("Decoded RTF clipboard exceeds 2 MiB".into());
        }
    }
    Ok(output.replace("\r\n", "\n").replace('\r', "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_and_fallbacks_preserve_cjk_emoji_and_plain_markdown() {
        let rtf = br"{\rtf1\ansi\uc1 \u20013?\u25991? \u-10179?\u-8704?\par **stars** \{literal\}\tab end}";
        assert_eq!(
            plain_text(rtf).unwrap(),
            "中文 😀\n**stars** {literal}\tend"
        );
        assert_eq!(plain_text(br"{\rtf1\ansi caf\'e9}").unwrap(), "café");
    }

    #[test]
    fn formatting_metadata_and_external_payloads_never_become_active_content() {
        let rtf = br#"{\rtf1{\fonttbl{\f0 EvilFont;}}{\info{\author secret}}\b Visible\b0  {\field{\*\fldinst INCLUDETEXT \"file:///etc/passwd\"}{\fldrslt label}}{\pict\pngblip 0000}{\object{\objdata deadbeef}}{\*\unknown hidden}}"#;
        assert_eq!(plain_text(rtf).unwrap(), "Visible label");
    }

    #[test]
    fn malformed_and_undecodable_data_is_rejected_without_partial_text() {
        for raw in [
            b"not RTF".as_slice(),
            br"{\rtf1 missing close",
            br"{\rtf1 extra close}}",
            br"{\rtf1 \bin999 abc}",
            br"{\rtf1 \u-10179?}",
            br"{\rtf1\ansi\ansicpg936 \'d6\'d0}",
        ] {
            assert!(plain_text(raw).is_err(), "accepted malformed RTF: {raw:?}");
        }
        let nested = format!("{{\\rtf1 {}text{}}}", "{".repeat(5000), "}".repeat(5000));
        assert!(plain_text(nested.as_bytes()).is_err());
    }

    #[test]
    fn input_and_expanded_output_are_bounded() {
        assert!(plain_text(&vec![b'x'; MAX_BYTES + 1]).is_err());
        // Latin-1 bytes expand to two UTF-8 bytes; bound decoded output too.
        let mut rtf = b"{\\rtf1\\ansi ".to_vec();
        rtf.extend(std::iter::repeat_n(0xe9, MAX_BYTES / 2 + 1));
        rtf.push(b'}');
        assert!(rtf.len() < MAX_BYTES);
        assert!(plain_text(&rtf).is_err());
    }

    #[test]
    fn legacy_font_encoding_is_not_misread_as_global_latin_but_unicode_is_supported() {
        assert!(
            plain_text(br"{\rtf1\ansi\deff0{\fonttbl{\f0\fcharset134 SimSun;}}\f0 \'d6\'d0}")
                .is_err()
        );
        assert_eq!(
            plain_text(br"{\rtf1\ansi\deff0{\fonttbl{\f0\fcharset134 SimSun;}}\f0\uc1 \u20013?}")
                .unwrap(),
            "中"
        );
    }
}
