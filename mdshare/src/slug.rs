use rand::Rng;
use time::{macros::format_description, OffsetDateTime};

/// Generate a slug per spec rules:
/// 1. Format: YYYY-MM-DD-<filename-slug>[-<3-char base62 suffix>]
/// 2. ASCII alphanumerics preserved, lowercased
/// 3. Non-ASCII characters stripped; ` _.` -> `-`; consecutive `-` collapsed; trim
/// 4. Filename portion capped at 40 chars
/// 5. If stripped filename is empty, fall back to `untitled-<8 hex of content hash>`
/// 6. If filename starts with YYYY-MM-DD already, do not double-prefix
/// 7. Suffix: 3 chars from base62 alphabet, controlled by `with_suffix`
pub fn generate(filename: Option<&str>, content: &str, with_suffix: bool) -> String {
    let date = OffsetDateTime::now_local()
        .unwrap_or_else(|_| OffsetDateTime::now_utc())
        .format(format_description!("[year]-[month]-[day]"))
        .expect("date format");

    let base = filename
        .map(|n| {
            // Strip extension first.
            match n.rfind('.') {
                Some(i) if i > 0 => n[..i].to_string(),
                _ => n.to_string(),
            }
        })
        .unwrap_or_default();

    let stripped = strip_to_ascii_slug(&base);
    let truncated: String = stripped.chars().take(40).collect::<String>()
        .trim_end_matches('-').to_string();

    let filename_part = if truncated.is_empty() {
        format!("untitled-{}", content_hash_hex8(content))
    } else if starts_with_iso_date(&truncated) {
        // Filename already starts with YYYY-MM-DD; don't double-prefix.
        truncated
    } else {
        format!("{date}-{truncated}")
    };

    // If filename_part already begins with the date, don't add it again.
    let final_part = if filename_part.starts_with(&date)
        || (starts_with_iso_date(&filename_part)
            && filename_part.len() >= 10
            && filename_part[..10] == *date)
    {
        filename_part
    } else if starts_with_iso_date(&filename_part) {
        // Already has SOME date prefix (different from today's); leave it.
        filename_part
    } else {
        format!("{date}-{filename_part}")
    };

    if with_suffix {
        format!("{final_part}-{}", random_base62_3())
    } else {
        final_part
    }
}

fn strip_to_ascii_slug(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = false;
    for c in input.chars() {
        let mapped: Option<char> = if c.is_ascii_alphanumeric() {
            Some(c.to_ascii_lowercase())
        } else if c == ' ' || c == '_' || c == '.' || c == '-' {
            Some('-')
        } else {
            None
        };
        if let Some(ch) = mapped {
            if ch == '-' {
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            } else {
                out.push(ch);
                last_dash = false;
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn starts_with_iso_date(s: &str) -> bool {
    // YYYY-MM-DD- (4-2-2 digits with dashes, plus a trailing dash)
    let bytes = s.as_bytes();
    if bytes.len() < 11 { return false }
    bytes[..4].iter().all(|b| b.is_ascii_digit())
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(|b| b.is_ascii_digit())
        && bytes[10] == b'-'
}

fn random_base62_3() -> String {
    const ALPHA: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut rng = rand::thread_rng();
    (0..3)
        .map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char)
        .collect()
}

fn content_hash_hex8(content: &str) -> String {
    // FNV-1a 64-bit; first 8 hex chars. Avoids pulling in sha2.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in content.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_suffix(s: &str) -> String {
        // Strip the random 3-char suffix when we want deterministic checks.
        let mut chunks: Vec<&str> = s.split('-').collect();
        chunks.pop();
        chunks.join("-")
    }

    #[test]
    fn ascii_filename_with_date() {
        let s = generate(Some("trip notes.md"), "", true);
        assert!(s.contains("trip-notes"));
        // YYYY-MM-DD-trip-notes-XXX → 6 dash-separated groups
        assert_eq!(s.split('-').count(), 6);
    }

    #[test]
    fn underscore_and_dot_become_dash() {
        let s = no_suffix(&generate(Some("a_b.c.md"), "", true));
        assert!(s.ends_with("-a-b-c"));
    }

    #[test]
    fn collapses_consecutive_dashes() {
        let s = no_suffix(&generate(Some("a   b___c.md"), "", true));
        assert!(s.ends_with("-a-b-c"));
    }

    #[test]
    fn pure_chinese_falls_back_to_untitled_hash() {
        let s = no_suffix(&generate(Some("会议纪要.md"), "hello world", true));
        assert!(s.contains("-untitled-"));
        // The hash is deterministic for fixed content; different filename, same content → same tail.
        let s2 = no_suffix(&generate(Some("不同名字.md"), "hello world", true));
        let tail1 = s.split("untitled-").nth(1).unwrap();
        let tail2 = s2.split("untitled-").nth(1).unwrap();
        assert_eq!(tail1, tail2);
    }

    #[test]
    fn truncates_long_filename_to_40() {
        let long = "a".repeat(200);
        let s = no_suffix(&generate(Some(&format!("{long}.md")), "", true));
        // The filename portion (after the YYYY-MM-DD- prefix) must be 40 chars.
        let parts: Vec<&str> = s.rsplitn(2, '-').collect();
        let filename_part = parts[0];
        assert_eq!(filename_part.len(), 40);
    }

    #[test]
    fn does_not_double_date_prefix() {
        let s = no_suffix(&generate(Some("2024-01-15-meeting.md"), "", true));
        // After the leading YYYY-MM-DD- there should be no SECOND date prefix.
        let dash_groups: Vec<&str> = s.splitn(4, '-').collect();
        let tail = dash_groups[3];
        assert!(!starts_with_iso_date(tail));
    }

    #[test]
    fn untitled_filename_uses_hash_fallback() {
        let s = no_suffix(&generate(None, "any content", true));
        assert!(s.contains("-untitled-"));
    }

    #[test]
    fn no_suffix_when_disabled() {
        let s = generate(Some("foo.md"), "", false);
        // Format: YYYY-MM-DD-foo (4 dash-separated parts)
        assert_eq!(s.split('-').count(), 4);
    }

    #[test]
    fn suffix_is_3_chars_from_base62() {
        let s = generate(Some("foo.md"), "", true);
        let suffix = s.rsplit('-').next().unwrap();
        assert_eq!(suffix.len(), 3);
        assert!(suffix.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn strip_to_ascii_slug_basic() {
        assert_eq!(strip_to_ascii_slug("Hello World"), "hello-world");
        assert_eq!(strip_to_ascii_slug("a__b__c"), "a-b-c");
        assert_eq!(strip_to_ascii_slug("---a---"), "a");
        assert_eq!(strip_to_ascii_slug(""), "");
        assert_eq!(strip_to_ascii_slug("中文"), "");
    }

    #[test]
    fn iso_date_recognition() {
        assert!(starts_with_iso_date("2024-01-15-x"));
        assert!(!starts_with_iso_date("2024-01-15")); // missing trailing dash
        assert!(!starts_with_iso_date("hello"));
    }
}
