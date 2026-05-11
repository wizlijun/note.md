//! Parse the first CSS comment block as Typora-format `Key: Value` metadata.

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParsedHeader {
    pub name: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
    pub appearance: Option<String>,
    pub description: Option<String>,
}

pub fn parse_header(css: &str) -> ParsedHeader {
    let mut out = ParsedHeader::default();
    let Some(block) = first_comment_block(css) else { return out };
    for line in block.lines() {
        // Strip leading whitespace and the optional leading `*` Typora uses.
        let mut line = line.trim_start();
        line = line.trim_start_matches('*').trim_start();
        let Some((key_raw, val_raw)) = line.split_once(':') else { continue };
        let key = key_raw.trim().to_ascii_lowercase();
        let val = val_raw.trim().to_string();
        if val.is_empty() { continue }
        match key.as_str() {
            "theme name" => out.name = Some(val),
            "author"     => out.author = Some(val),
            "version"    => out.version = Some(val),
            "appearance" => out.appearance = Some(val),
            "description" => out.description = Some(val),
            _ => {}
        }
    }
    out
}

fn first_comment_block(css: &str) -> Option<&str> {
    // Skip BOM
    let css = css.strip_prefix('\u{FEFF}').unwrap_or(css);
    // Skip leading whitespace + optional @charset declaration.
    let mut rest = css.trim_start();
    if rest.starts_with("@charset") {
        if let Some(end) = rest.find(';') {
            rest = rest[end + 1..].trim_start();
        }
    }
    if !rest.starts_with("/*") { return None }
    let after_open = &rest[2..];
    let close = after_open.find("*/")?;
    Some(&after_open[..close])
}
