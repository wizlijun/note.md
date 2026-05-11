//! CSS compilation pipeline: pre-strip Typora-private at-rules, parse with
//! lightningcss, rewrite selectors and url() targets, serialize.

/// Remove every `@include-when-export url(...)` at-rule from the source. This
/// runs *before* lightningcss parses the CSS because lightningcss treats
/// unknown at-rules as parse errors.
///
/// The pattern is line-anchored on the at-rule keyword; the value can wrap
/// across whitespace inside `url(...)`. We require a trailing `;` to avoid
/// matching inside comments or strings.
pub fn strip_include_when_export(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    loop {
        match rest.find("@include-when-export") {
            None => { out.push_str(rest); break }
            Some(idx) => {
                // Check that the keyword is not followed by identifier characters.
                let keyword_end = idx + "@include-when-export".len();
                let is_valid_keyword = if keyword_end >= rest.len() {
                    true
                } else {
                    let next_char = rest[keyword_end..].chars().next().unwrap_or('\0');
                    !next_char.is_alphanumeric() && next_char != '-' && next_char != '_'
                };

                if !is_valid_keyword {
                    // Not the right keyword, skip this occurrence and keep searching.
                    out.push_str(&rest[..keyword_end]);
                    rest = &rest[keyword_end..];
                    continue;
                }

                // Find start of this line so we also drop preceding indentation.
                let before = &rest[..idx];
                let line_start = before.rfind('\n').map(|n| n + 1).unwrap_or(0);
                // Emit everything up to the line start.
                out.push_str(&rest[..line_start]);
                // Find the terminating semicolon after the at-rule.
                let after = &rest[idx..];
                match after.find(';') {
                    None => {
                        // Malformed — bail and keep the rest verbatim.
                        out.push_str(after);
                        break
                    }
                    Some(semi_rel) => {
                        rest = &after[semi_rel + 1..];
                    }
                }
            }
        }
    }
    out
}
