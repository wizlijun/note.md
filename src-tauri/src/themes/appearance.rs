//! Light/dark appearance resolution from header value and file stem.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Light,
    Dark,
}

impl Appearance {
    pub fn as_str(self) -> &'static str {
        match self {
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        }
    }
}

/// Header value (if any) takes precedence when it's exactly `light` or `dark`
/// (case-insensitive). Otherwise the file stem is inspected for `dark` or
/// `night` as a whole token (delimited by start/end or `[-_]`).
pub fn resolve_appearance(header_value: Option<&str>, stem: &str) -> Appearance {
    if let Some(v) = header_value {
        match v.trim().to_ascii_lowercase().as_str() {
            "light" => return Appearance::Light,
            "dark"  => return Appearance::Dark,
            _ => {}
        }
    }
    if stem_indicates_dark(stem) { Appearance::Dark } else { Appearance::Light }
}

fn stem_indicates_dark(stem: &str) -> bool {
    let lower = stem.to_ascii_lowercase();
    for keyword in &["dark", "night"] {
        if contains_token(&lower, keyword) { return true }
    }
    false
}

fn contains_token(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let nbytes = needle.as_bytes();
    let mut i = 0usize;
    while let Some(found) = haystack[i..].find(needle) {
        let start = i + found;
        let end = start + nbytes.len();
        let left_ok = start == 0 || matches!(bytes[start - 1], b'-' | b'_');
        let right_ok = end == bytes.len() || matches!(bytes[end], b'-' | b'_');
        if left_ok && right_ok { return true }
        i = start + 1;
    }
    false
}

/// `claude-like-dark` → "Claude-Like Dark". Tokens are split on `_` and `.`
/// (rendered as spaces). `-` is preserved.
pub fn title_case_from_stem(stem: &str) -> String {
    // Find which '-' characters (by char index) precede a `dark`/`night` keyword token.
    let chars: Vec<char> = stem.to_lowercase().chars().collect();
    let mut space_at: std::collections::HashSet<usize> = Default::default();
    for keyword in &["dark", "night"] {
        let kchars: Vec<char> = keyword.chars().collect();
        for i in 0..chars.len() {
            if chars[i..].starts_with(&kchars) {
                let end = i + kchars.len();
                let left_ok = i == 0 || matches!(chars[i - 1], '-' | '_');
                let right_ok = end == chars.len() || matches!(chars[end], '-' | '_');
                if left_ok && right_ok && i > 0 && chars[i - 1] == '-' {
                    space_at.insert(i - 1);
                }
            }
        }
    }
    let stem_chars: Vec<char> = stem.chars().collect();
    let mut out = String::with_capacity(stem.len());
    let mut capitalize_next = true;
    for (idx, c) in stem_chars.iter().enumerate() {
        let mapped = if space_at.contains(&idx) || *c == '_' || *c == '.' { ' ' } else { *c };
        if mapped == ' ' || mapped == '-' {
            out.push(mapped);
            capitalize_next = true;
        } else if capitalize_next {
            for u in mapped.to_uppercase() { out.push(u); }
            capitalize_next = false;
        } else {
            out.push(mapped);
        }
    }
    out
}
