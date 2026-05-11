//! Light/dark appearance resolution from header value and file stem.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    // Convert dark/night keyword delimiters from `-` to space
    let lower = stem.to_ascii_lowercase();
    let mut dash_to_space = vec![false; stem.len()];

    for keyword in &["dark", "night"] {
        let mut i = 0;
        while let Some(found) = lower[i..].find(keyword) {
            let start = i + found;
            let end = start + keyword.len();
            let left_ok = start == 0 || matches!(lower.as_bytes()[start - 1], b'-' | b'_');
            let right_ok = end == lower.len() || matches!(lower.as_bytes()[end], b'-' | b'_');
            if left_ok && right_ok && start > 0 && lower.as_bytes()[start - 1] == b'-' {
                dash_to_space[start - 1] = true;
            }
            i = start + 1;
        }
    }

    let normalized: String = stem.chars().enumerate().map(|(idx, c)| {
        if dash_to_space[idx] {
            ' '
        } else if c == '_' || c == '.' {
            ' '
        } else {
            c
        }
    }).collect();

    let mut out = String::with_capacity(normalized.len());
    let mut capitalize_next = true;
    for c in normalized.chars() {
        if c == ' ' || c == '-' {
            out.push(c);
            capitalize_next = true;
        } else if capitalize_next {
            for u in c.to_uppercase() { out.push(u); }
            capitalize_next = false;
        } else {
            out.push(c);
        }
    }
    out
}
