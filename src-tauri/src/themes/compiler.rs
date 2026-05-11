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

/// Rewrite a single CSS selector list string to a scoped form.
///
/// Algorithm: split on top-level commas → for each selector, tokenize into
/// (compound, combinator) pairs → substitute scope targets (`:root`,
/// `#write`, `html`, `body` when alone) with the SCOPE marker → normalize
/// child combinators following the scope to descendants → ensure exactly
/// one scope at the start → render. Selector-list results are de-duplicated.
pub fn rewrite_selector_text(input: &str, theme_id: &str) -> String {
    let scope = format!(r#"[data-theme="{theme_id}"] .moraya-editor"#);
    let mut parts: Vec<String> = Vec::new();
    for raw in split_top_level_comma(input) {
        parts.push(rewrite_one(raw.trim(), &scope));
    }
    // Deduplicate while preserving order.
    let mut seen: Vec<String> = Vec::new();
    for p in parts {
        if !seen.iter().any(|s| s == &p) { seen.push(p) }
    }
    seen.join(", ")
}

fn rewrite_one(sel: &str, scope: &str) -> String {
    let tokens = tokenize_selector(sel);
    // tokens is a flat list alternating (compound, combinator); first is compound.
    // Substitute scope targets when compound is exactly one of the four.
    let mut rebuilt: Vec<SelToken> = Vec::with_capacity(tokens.len());
    for tok in tokens {
        match tok {
            SelToken::Compound(s) if is_scope_target(&s) => {
                rebuilt.push(SelToken::ScopeMarker);
            }
            other => rebuilt.push(other),
        }
    }
    // Convert child combinators following a ScopeMarker into descendant.
    for i in 0..rebuilt.len().saturating_sub(1) {
        if matches!(rebuilt[i], SelToken::ScopeMarker)
            && matches!(rebuilt[i + 1], SelToken::Combinator('>'))
        {
            rebuilt[i + 1] = SelToken::Combinator(' ');
        }
    }
    // Ensure exactly one leading ScopeMarker.
    let has_leading_scope = matches!(rebuilt.first(), Some(SelToken::ScopeMarker));
    if !has_leading_scope {
        rebuilt.insert(0, SelToken::Combinator(' '));
        rebuilt.insert(0, SelToken::ScopeMarker);
    }
    // Render.
    let mut out = String::new();
    for tok in rebuilt {
        match tok {
            SelToken::ScopeMarker => out.push_str(scope),
            SelToken::Compound(s) => out.push_str(&s),
            SelToken::Combinator(' ') => out.push(' '),
            SelToken::Combinator(c) => {
                if !out.ends_with(' ') { out.push(' ') }
                out.push(c);
                out.push(' ');
            }
        }
    }
    // Collapse any double spaces.
    while out.contains("  ") { out = out.replace("  ", " ") }
    out.trim().to_string()
}

#[derive(Debug, Clone)]
enum SelToken {
    Compound(String),
    Combinator(char), // ' ' descendant, '>' child, '+' adjacent, '~' general
    ScopeMarker,
}

fn is_scope_target(compound: &str) -> bool {
    matches!(compound, ":root" | "#write" | "html" | "body")
}

fn tokenize_selector(sel: &str) -> Vec<SelToken> {
    let mut out: Vec<SelToken> = Vec::new();
    let mut current = String::new();
    let mut chars = sel.chars().peekable();
    let mut depth_paren = 0usize;
    let mut depth_bracket = 0usize;
    while let Some(c) = chars.next() {
        match c {
            '(' => { depth_paren += 1; current.push(c) }
            ')' => { if depth_paren > 0 { depth_paren -= 1 } current.push(c) }
            '[' => { depth_bracket += 1; current.push(c) }
            ']' => { if depth_bracket > 0 { depth_bracket -= 1 } current.push(c) }
            ' ' | '\t' | '\n' if depth_paren == 0 && depth_bracket == 0 => {
                if !current.is_empty() {
                    out.push(SelToken::Compound(std::mem::take(&mut current)));
                }
                // Peek next non-whitespace; if it's a structural combinator,
                // emit that; else emit descendant.
                while let Some(&p) = chars.peek() {
                    if p == ' ' || p == '\t' || p == '\n' { chars.next(); continue }
                    break;
                }
                match chars.peek() {
                    Some('>') | Some('+') | Some('~') => {
                        let c2 = chars.next().unwrap();
                        // Skip trailing whitespace.
                        while let Some(&p) = chars.peek() {
                            if p == ' ' || p == '\t' || p == '\n' { chars.next(); continue }
                            break;
                        }
                        out.push(SelToken::Combinator(c2));
                    }
                    Some(_) => out.push(SelToken::Combinator(' ')),
                    None => break,
                }
            }
            '>' | '+' | '~' if depth_paren == 0 && depth_bracket == 0 => {
                if !current.is_empty() {
                    out.push(SelToken::Compound(std::mem::take(&mut current)));
                }
                out.push(SelToken::Combinator(c));
                // Skip whitespace after combinator.
                while let Some(&p) = chars.peek() {
                    if p == ' ' || p == '\t' || p == '\n' { chars.next(); continue }
                    break;
                }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(SelToken::Compound(current));
    }
    out
}

fn split_top_level_comma(s: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut depth_paren = 0i32;
    let mut depth_bracket = 0i32;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'(' => depth_paren += 1,
            b')' => depth_paren -= 1,
            b'[' => depth_bracket += 1,
            b']' => depth_bracket -= 1,
            b',' if depth_paren == 0 && depth_bracket == 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < bytes.len() { out.push(&s[start..]) }
    out
}
