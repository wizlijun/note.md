//! File-index V1 projection. Headings own categories; every readable book is one list line.
use super::{compare_books, read_prefix, ScannedBook, Topic, FRONTMATTER_READ_LIMIT};
use serde_yaml::Value;
use std::path::Path;

struct Reading {
    name: String,
    title: String,
    summary: bool,
}

/// Literal text must not introduce Markdown structure or inline index attributes.
fn text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .flat_map(|c| {
            if c.is_ascii_punctuation() {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}

fn destination(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn link(label: &str, rel: &str, file: &str) -> String {
    format!(
        "[{}](<./{}>)",
        text(label),
        destination(&format!("{rel}/{file}"))
    )
}

fn readings(dir: &Path) -> Result<Vec<Reading>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("read {}: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if name.starts_with('.')
            || !lower.ends_with(".md")
            || matches!(
                lower.as_str(),
                "book.md" | "book.note.md" | "book.notes.md" | "index.md" | "log.md"
            )
            || lower.ends_with(".index.md")
            || !crate::library::is_regular_file(&entry.path())
        {
            continue;
        }
        // Prefer the human-readable document over its editor-managed companion.
        if lower.ends_with(".note.md")
            && crate::library::is_regular_file(&dir.join(format!("{}.md", &name[..name.len() - 8])))
        {
            continue;
        }
        let summary = crate::library::is_summary(&lower) || lower == "summary.md";
        let source = read_prefix(&entry.path(), FRONTMATTER_READ_LIMIT)?.replace("\r\n", "\n");
        let metadata = source
            .strip_prefix("---\n")
            .and_then(|body| body.find("\n---").map(|end| &body[..end]))
            .and_then(|yaml| serde_yaml::from_str::<Value>(yaml).ok());
        let title = metadata
            .as_ref()
            .and_then(|meta| meta.get("title"))
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| name.trim_end_matches(".md").to_string());
        result.push(Reading {
            name,
            title,
            summary,
        });
    }
    result.sort_by(|a, b| {
        b.summary
            .cmp(&a.summary)
            .then_with(|| {
                (b.summary && b.name != "summary.md").cmp(&(a.summary && a.name != "summary.md"))
            })
            .then_with(|| {
                if a.summary {
                    b.name.cmp(&a.name)
                } else {
                    a.name.cmp(&b.name)
                }
            })
    });
    Ok(result)
}

pub fn render_index(root: &Path, topic: &Topic, books: &[ScannedBook]) -> Result<String, String> {
    let mut books: Vec<_> = books
        .iter()
        .filter(|book| book.topic_id.as_deref() == Some(&topic.id))
        .collect();
    books.sort_by(|a, b| compare_books(a, b));
    let quote = |value: &str| serde_json::to_string(value).expect("string serialization");
    let mut out = format!("---\ntype: Book Topic Index\ntitle: {}\ndescription: {}\ntags: [ebooks, topic, {}]\nview: gallery\nnotemd_generated: ebook-topic-index/v2\n---\n\n# {}\n\n{}\n\n",
        quote(&topic.label), quote(&topic.description), topic.id, text(&topic.label), text(&topic.description));
    out.push_str("点击书名打开摘要或整理笔记，说明中列出其他阅读入口。\n\n");
    for word in &topic.vocabulary {
        out.push_str(&format!(
            "**{}**：{}\n\n",
            text(&word.term),
            text(&word.description)
        ));
    }
    out.push_str("## 可读摘要与笔记\n\n");
    let mut pending = Vec::new();
    for book in books {
        let dir = root.join(&book.rel);
        let reading = readings(&dir)?;
        let Some(primary) = reading.first() else {
            let mut line = format!("**{}**", text(&book.title));
            if let Some(author) = &book.creator {
                line.push_str(&format!(" — {}", text(author)));
            }
            if let Some(date) = &book.added_at {
                line.push_str(&format!(
                    " · 入库日期 {}",
                    text(date.get(..10).unwrap_or(date))
                ));
            }
            line.push_str("。本目录暂无摘要或整理笔记。\n\n");
            pending.push(line);
            continue;
        };
        out.push_str(&format!(
            "- {}",
            link(&book.title, &book.rel, &primary.name)
        ));
        if let Some(author) = &book.creator {
            out.push_str(&format!(" [作者:: {}]", text(author)));
        }
        if let Some(date) = &book.added_at {
            out.push_str(&format!(
                " [入库日期:: {}]",
                text(date.get(..10).unwrap_or(date))
            ));
        }
        if let Some(cover) = ["cover.jpg", "cover.png", "cover.jpeg"]
            .into_iter()
            .find(|name| crate::library::is_regular_file(&dir.join(name)))
        {
            out.push_str(&format!(" [封面:: !{}]", link("封面", &book.rel, cover)));
        }
        out.push_str(&format!(" {}。阅读：", text(&primary.title)));
        for (i, item) in reading.iter().enumerate() {
            if i > 0 {
                out.push_str(" · ");
            }
            let label = if i == 0 && item.summary {
                "全书摘要"
            } else {
                &item.title
            };
            out.push_str(&link(label, &book.rel, &item.name));
        }
        out.push('\n');
    }
    if !pending.is_empty() {
        out.push_str("\n## 待整理\n\n");
        out.push_str(&pending.concat());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    fn fixture(root: &Path) -> (Topic, Vec<ScannedBook>) {
        let topic = Topic {
            id: "reading".into(),
            label: "阅读 [书籍]".into(),
            description: "说明\n- 列表 <b> HTML #标签 [属性:: 值]".into(),
            index_file: "阅读.index.md".into(),
            vocabulary: vec![super::super::Vocabulary {
                term: "#概念".into(),
                description: "多行\n解释 [[页面]]".into(),
                extra: BTreeMap::new(),
            }],
            extra: BTreeMap::new(),
        };
        let book = ScannedBook {
            rel: "2026-09/A book [1] #100%".into(),
            title: "A [Book] #标签".into(),
            creator: Some("作者 [字段:: 内容]\n第二行".into()),
            publisher: None,
            language: None,
            added_at: Some("2026-09-10T00:00:00Z".into()),
            topic_id: Some(topic.id.clone()),
        };
        let dir = root.join(&book.rel);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in [
            ("book.md", "raw"),
            ("book.note.md", "raw notes"),
            ("summary.md", "undated"),
            ("2026-09-09-summary.md", "old"),
            (
                "2026-09-10-summary.md",
                "---\ntitle: 摘要标题\n---\nReadable",
            ),
            ("实践 [A].md", "---\ntitle: 具体实践\n---\nPractice"),
            ("实践 [A].note.md", "companion"),
            (".hidden.md", "hidden"),
            ("links.index.md", "index"),
            ("cover.jpg", "image"),
        ] {
            std::fs::write(dir.join(name), body).unwrap();
        }
        let mut pending = book.clone();
        pending.rel = "2026-09/Pending".into();
        pending.title = "Pending".into();
        std::fs::create_dir_all(root.join(&pending.rel)).unwrap();
        std::fs::write(root.join(&pending.rel).join("book.md"), "raw").unwrap();
        (topic, vec![book, pending])
    }
    #[test]
    fn gallery_uses_latest_summary_local_cover_and_all_readable_links() {
        let tmp = tempfile::tempdir().unwrap();
        let (topic, books) = fixture(tmp.path());
        let rendered = render_index(tmp.path(), &topic, &books).unwrap();
        assert!(rendered.contains("view: gallery\nnotemd_generated: ebook-topic-index/v2"));
        assert!(!rendered.contains("<!--"));
        assert!(!rendered.contains("/book.md>"));
        assert!(
            rendered.contains("(<./2026-09/A%20book%20%5B1%5D%20%23100%25/2026-09-10-summary.md>)")
        );
        assert!(rendered
            .contains("[封面:: ![封面](<./2026-09/A%20book%20%5B1%5D%20%23100%25/cover.jpg>)]"));
        assert!(rendered.contains("[具体实践]"));
        assert!(!rendered.contains(".note.md>"));
        assert!(!rendered.contains(".hidden.md"));
        assert_eq!(
            rendered
                .lines()
                .filter(|line| line.starts_with("- "))
                .count(),
            1
        );
        assert!(rendered.contains("## 待整理\n\n**Pending**"));
        assert!(super::super::is_generated_index(&rendered));
    }
    #[test]
    fn falls_back_to_other_markdown_without_manufacturing_summary_or_cover() {
        let tmp = tempfile::tempdir().unwrap();
        let (topic, books) = fixture(tmp.path());
        let dir = tmp.path().join(&books[0].rel);
        for name in [
            "summary.md",
            "2026-09-09-summary.md",
            "2026-09-10-summary.md",
            "cover.jpg",
        ] {
            std::fs::remove_file(dir.join(name)).unwrap();
        }
        let rendered = render_index(tmp.path(), &topic, &books).unwrap();
        assert!(rendered.contains("/%E5%AE%9E%E8%B7%B5%20%5BA%5D.md>)"));
        assert!(!rendered.contains("[封面::"));
        assert!(!rendered.contains("[全书摘要]"));
    }
    #[cfg(unix)]
    #[test]
    fn ignores_symlinked_readings_and_covers() {
        let tmp = tempfile::tempdir().unwrap();
        let (topic, books) = fixture(tmp.path());
        let dir = tmp.path().join(&books[0].rel);
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.join("2099-01-01-summary.md")).unwrap();
        std::fs::remove_file(dir.join("cover.jpg")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.join("cover.png")).unwrap();
        let rendered = render_index(tmp.path(), &topic, &books).unwrap();
        assert!(!rendered.contains("2099-01-01"));
        assert!(!rendered.contains("[封面::"));
    }
    #[test]
    fn generated_marker_requires_frontmatter_and_migrates_legacy() {
        assert!(super::super::is_generated_index(
            super::super::GENERATED_MARKER
        ));
        assert!(!super::super::is_generated_index(
            "# My notes\nnotemd_generated: ebook-topic-index/v2"
        ));
        assert!(!super::super::is_generated_index(
            "---\ntype: Book Topic Index\n---\n# Mine"
        ));
    }
    /// Cross-language verifier consumes exactly the Rust-produced Markdown.
    #[test]
    fn export_index_format_fixture() {
        let Ok(output) = std::env::var("NOTEMD_EBOOK_INDEX_FIXTURE") else {
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let (topic, books) = fixture(tmp.path());
        let rendered = render_index(tmp.path(), &topic, &books).unwrap();
        std::fs::write(output,serde_json::to_vec(&serde_json::json!({"content":rendered,"title":topic.label,"bookTitle":books[0].title,"author":books[0].creator,"primary":format!("{}/2026-09-10-summary.md",books[0].rel)})).unwrap()).unwrap();
    }
}
