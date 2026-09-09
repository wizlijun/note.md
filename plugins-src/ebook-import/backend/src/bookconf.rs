use std::io::Read;
use std::path::Path;

/// Book metadata as extracted from the source file (EPUB/PDF/etc). All
/// fields are optional because extraction is best-effort and downstream
/// consumers (config.txt) must degrade gracefully to "field omitted".
#[derive(Debug, Default, Clone)]
pub struct BookMeta {
    pub title: Option<String>,
    pub creator: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
}

const FORBIDDEN_CHARS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
const MAX_DIRNAME_CHARS: usize = 200;
const CONFIG_READ_LIMIT: u64 = 64 * 1024;

/// Read the source metadata retained by older imports, without loading book.md
/// or interpreting unrelated translation settings. Oversized/unsafe files are
/// ignored so incomplete metadata never prevents scanning the book library.
pub fn read_config_metadata(path: &Path) -> Option<BookMeta> {
    if path.file_name()? != "config.txt" {
        return None;
    }
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > CONFIG_READ_LIMIT {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(CONFIG_READ_LIMIT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > CONFIG_READ_LIMIT {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    let mut meta = BookMeta::default();
    let mut in_metadata = false;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.starts_with('#') {
            in_metadata = line == "# Book Metadata";
            continue;
        }
        if !in_metadata {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let field = match key.trim() {
            "original_title" => &mut meta.title,
            "creator" => &mut meta.creator,
            "publisher" => &mut meta.publisher,
            "source_language" => &mut meta.language,
            "isbn" => &mut meta.isbn,
            _ => continue,
        };
        if field.is_none() {
            *field = Some(value.to_string());
        }
    }
    Some(meta)
}

/// Ports the directory-name sanitizer from the original `bookread.sh` shell
/// pipeline verbatim, rule order included, so directory names produced by
/// this Rust port are byte-identical to the shell version for the same
/// input (needed so existing ebook libraries organized by the old pipeline
/// keep matching directory names).
pub fn sanitize_dirname(input: &str) -> String {
    let replaced: String = input
        .chars()
        .filter(|c| !matches!(*c, '\u{0}'..='\u{1f}'))
        .map(|c| if FORBIDDEN_CHARS.contains(&c) { '_' } else { c })
        .collect();

    let collapsed = {
        let mut out = String::with_capacity(replaced.len());
        let mut prev_space = false;
        for c in replaced.chars() {
            if c.is_whitespace() {
                if !prev_space {
                    out.push(' ');
                }
                prev_space = true;
            } else {
                out.push(c);
                prev_space = false;
            }
        }
        out
    };

    let trimmed = collapsed.trim_matches(|c: char| c == ' ' || c == '.');

    trimmed.chars().take(MAX_DIRNAME_CHARS).collect()
}

/// OKF v0.2 概念文档头(docs/okf-v0.2-format-constraints.md):`type` 是唯一
/// 必填字段(§4.1),来源书文件按 §5.1 记进 `sources[].resource`。元数据缺失时
/// 只降级为 type + sources —— 缺可选字段绝不影响合规(§11)。
pub fn book_frontmatter(input_file: &str, meta: &BookMeta) -> String {
    let mut out = String::from("---\ntype: Book\n");
    if let Some(v) = &meta.title {
        out.push_str(&format!("title: {}\n", yaml_quote(v)));
    }
    if let Some(v) = &meta.publisher {
        out.push_str(&format!("publisher: {}\n", yaml_quote(v)));
    }
    if let Some(v) = &meta.language {
        out.push_str(&format!("language: {}\n", yaml_quote(v)));
    }
    if let Some(v) = &meta.isbn {
        out.push_str(&format!("isbn: {}\n", yaml_quote(v)));
    }
    out.push_str("sources:\n");
    out.push_str(&format!("  - resource: {}\n", yaml_quote(input_file)));
    if let Some(v) = &meta.creator {
        out.push_str(&format!("    author: {}\n", yaml_quote(v)));
    }
    out.push_str("---\n");
    out
}

/// YAML 双引号标量:书名里的冒号/引号/反斜杠都必须转义,否则整份 frontmatter
/// 不可解析(违反 §11 条件 1)。
fn yaml_quote(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Writes config.txt in the exact key=value layout the downstream
/// translation pipeline (ported from the original python script) parses.
/// The `# Book Metadata` block and each key within it are emitted only
/// when there is data, so a book with no discoverable metadata produces a
/// config.txt with just the transfer/conversion header.
pub fn write_config_txt(
    path: &Path,
    input_file: &str,
    method: &str,
    meta: &BookMeta,
) -> std::io::Result<()> {
    let mut out = String::new();
    out.push_str("# Translation Configuration\n");
    out.push_str(&format!("input_file={input_file}\n"));
    out.push_str("input_lang=auto\n");
    out.push_str("output_lang=zh\n");
    out.push_str(&format!("conversion_method={method}\n"));

    if meta.title.is_some()
        || meta.creator.is_some()
        || meta.publisher.is_some()
        || meta.language.is_some()
        || meta.isbn.is_some()
    {
        out.push('\n');
        out.push_str("# Book Metadata\n");
        if let Some(v) = &meta.title {
            out.push_str(&format!("original_title={v}\n"));
        }
        if let Some(v) = &meta.creator {
            out.push_str(&format!("creator={v}\n"));
        }
        if let Some(v) = &meta.publisher {
            out.push_str(&format!("publisher={v}\n"));
        }
        if let Some(v) = &meta.language {
            out.push_str(&format!("source_language={v}\n"));
        }
        if let Some(v) = &meta.isbn {
            out.push_str(&format!("isbn={v}\n"));
        }
    }

    std::fs::write(path, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_known_nonempty_fields_in_the_source_metadata_block() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.txt");
        let text = concat!(
            "# Translation Configuration\r\ncreator=Not the author\r\n",
            "# Book Metadata\r\noriginal_title = Legacy = Book\r\n",
            "creator=Author One; Author Two\r\npublisher=Source Press\r\n",
            "source_language=en\r\nisbn=9780063488793\r\n",
            "unknown_key=ignored\r\ncreator=\r\n",
            "# Translation Overrides\r\noriginal_title=Do not use\r\n",
        );
        std::fs::write(&path, text).unwrap();
        let meta = read_config_metadata(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Legacy = Book"));
        assert_eq!(meta.creator.as_deref(), Some("Author One; Author Two"));
        assert_eq!(meta.publisher.as_deref(), Some("Source Press"));
        assert_eq!(meta.language.as_deref(), Some("en"));
        assert_eq!(meta.isbn.as_deref(), Some("9780063488793"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn ignores_hidden_names_directories_oversized_and_invalid_utf8_configs() {
        let tmp = tempfile::tempdir().unwrap();
        let hidden = tmp.path().join(".config.txt");
        std::fs::write(&hidden, "# Book Metadata\ncreator=Hidden\n").unwrap();
        assert!(read_config_metadata(&hidden).is_none());
        let path = tmp.path().join("config.txt");
        std::fs::create_dir(&path).unwrap();
        assert!(read_config_metadata(&path).is_none());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, format!("# Book Metadata\ncreator=Too long\n{}", "x".repeat(CONFIG_READ_LIMIT as usize))).unwrap();
        assert!(read_config_metadata(&path).is_none());
        std::fs::write(&path, b"# Book Metadata\ncreator=\xff").unwrap();
        assert!(read_config_metadata(&path).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_source_config() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "# Book Metadata\ncreator=Outside\n").unwrap();
        let path = tmp.path().join("config.txt");
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(read_config_metadata(&path).is_none());
    }

    #[test]
    fn sanitize_ports_shell_rules() {
        assert_eq!(
            sanitize_dirname("a/b\\c:d*e?f\"g<h>i|j"),
            "a_b_c_d_e_f_g_h_i_j"
        );
        assert_eq!(sanitize_dirname("  many   spaces  "), "many spaces");
        assert_eq!(sanitize_dirname("..dots.."), "dots");
        assert_eq!(sanitize_dirname("x\u{0007}y"), "xy");
        assert_eq!(sanitize_dirname(&"字".repeat(300)).chars().count(), 200);
        assert_eq!(sanitize_dirname("   "), "");
    }

    /// 与宿主校验器共用的 golden:同一份 `book.md` 头,这里断言字节,
    /// 宿主 `src/lib/okf/book-head.test.ts` 断言它过 OKF 硬约束。
    /// 两侧都盯着同一个文件,任何一侧漂了都会红。
    #[test]
    fn book_head_matches_the_shared_golden() {
        let golden = include_str!("../tests/fixtures/book-head.md");
        let meta = BookMeta {
            title: Some("7 Powers".into()),
            creator: Some("Hamilton Helmer".into()),
            publisher: Some("Stripe Press".into()),
            language: Some("en".into()),
            isbn: None,
        };
        let head = book_frontmatter("/in/7 \"powers\".epub", &meta);
        assert!(
            golden.starts_with(&head),
            "golden drifted from book_frontmatter\n--- got ---\n{head}\n--- golden ---\n{golden}",
        );
    }

    #[test]
    fn book_frontmatter_carries_type_title_and_source() {
        let meta = BookMeta {
            title: Some("7 Powers".into()),
            creator: Some("Hamilton".into()),
            publisher: None,
            language: Some("en".into()),
            isbn: None,
        };
        let fm = book_frontmatter("/in/7powers.epub", &meta);
        assert_eq!(
            fm,
            concat!(
                "---\n",
                "type: Book\n",
                "title: \"7 Powers\"\n",
                "language: \"en\"\n",
                "sources:\n",
                "  - resource: \"/in/7powers.epub\"\n",
                "    author: \"Hamilton\"\n",
                "---\n",
            )
        );
    }

    #[test]
    fn book_frontmatter_degrades_to_type_and_source_only() {
        let fm = book_frontmatter("/in/unknown.pdf", &BookMeta::default());
        assert_eq!(
            fm,
            "---\ntype: Book\nsources:\n  - resource: \"/in/unknown.pdf\"\n---\n"
        );
    }

    #[test]
    fn book_frontmatter_escapes_quotes_and_backslashes() {
        let meta = BookMeta {
            title: Some("a \"quoted\" \\ title".into()),
            ..Default::default()
        };
        let fm = book_frontmatter("/in/x.epub", &meta);
        assert!(fm.contains("title: \"a \\\"quoted\\\" \\\\ title\"\n"));
    }

    #[test]
    fn config_txt_matches_bookread_format() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("config.txt");
        let meta = BookMeta {
            title: Some("7 Powers".into()),
            creator: Some("Hamilton".into()),
            publisher: None,
            language: Some("en".into()),
            isbn: None,
        };
        write_config_txt(&p, "/in/7powers.epub", "calibre_htmlz", &meta).unwrap();
        let s = std::fs::read_to_string(&p).unwrap();
        assert!(s.contains("input_file=/in/7powers.epub"));
        assert!(s.contains("input_lang=auto"));
        assert!(s.contains("output_lang=zh"));
        assert!(s.contains("conversion_method=calibre_htmlz"));
        assert!(s.contains("original_title=7 Powers"));
        assert!(s.contains("creator=Hamilton"));
        assert!(!s.contains("publisher="));
        assert!(s.contains("source_language=en"));
        assert!(!s.contains("isbn="));
    }

    #[test]
    fn isbn_is_preserved_as_a_string_in_frontmatter_and_config() {
        let meta = BookMeta {
            isbn: Some("0-8044-2957-X".into()),
            ..Default::default()
        };
        let fm = book_frontmatter("/in/book.epub", &meta);
        assert!(fm.contains("isbn: \"0-8044-2957-X\"\n"));
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("config.txt");
        write_config_txt(&p, "/in/book.epub", "calibre_htmlz", &meta).unwrap();
        let config = std::fs::read_to_string(p).unwrap();
        assert!(config.contains("# Book Metadata\nisbn=0-8044-2957-X\n"));
        assert!(!config.contains("original_title="));
    }
}
