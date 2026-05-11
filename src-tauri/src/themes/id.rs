//! Theme id validation. IDs match `[a-z0-9][a-z0-9._-]*`.

#[derive(Debug, PartialEq, Eq)]
pub enum ThemeIdError {
    Empty,
    BadLeadingChar(char),
    InvalidChar(char),
}

pub fn is_valid_theme_id(id: &str) -> Result<(), ThemeIdError> {
    let mut chars = id.chars();
    let first = chars.next().ok_or(ThemeIdError::Empty)?;
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(ThemeIdError::BadLeadingChar(first));
    }
    for c in chars {
        let ok = c.is_ascii_lowercase()
            || c.is_ascii_digit()
            || c == '-'
            || c == '_'
            || c == '.';
        if !ok {
            return Err(ThemeIdError::InvalidChar(c));
        }
    }
    Ok(())
}
