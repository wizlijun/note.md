//! Exports use one frozen durable revision, never two independently read live files.
use super::{durability::Loaded, err, Result};
use std::{
    io::{Read, Write},
    path::Path,
};
use tauri_plugin_dialog::DialogExt;
use write_core::{storage, Document};

fn bytes(loaded: &Loaded, format: &str) -> Result<Vec<u8>> {
    let doc = Document::restore(
        &loaded.entry.id,
        loaded.entry.epoch,
        super::client(),
        &loaded.full_state,
        loaded.revision,
    )
    .map_err(err)?;
    let snapshot = doc.snapshot().map_err(err)?;
    match format {
        "markdown" => Ok(snapshot.body.into_bytes()),
        "archive" => {
            let pair = storage::serialize_pair(
                &snapshot,
                Some(&loaded.frontmatter),
                Some(&loaded.sidecar),
            )
            .map_err(err)?;
            let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, value) in [
                ("page.writing.md", pair.markdown),
                ("page.writing.meta.json", pair.metadata),
            ] {
                archive.start_file(name, options).map_err(err)?;
                archive.write_all(value.as_bytes()).map_err(err)?;
            }
            Ok(archive.finish().map_err(err)?.into_inner())
        }
        _ => Err("未知导出格式".into()),
    }
}

fn writing_header(prefix: &[u8]) -> Result<bool> {
    // Inspect only a bounded frontmatter prefix; ordinary prose is irrelevant.
    let prefix = prefix.strip_prefix(b"\xef\xbb\xbf").unwrap_or(prefix);
    if !prefix.starts_with(b"---\n") && !prefix.starts_with(b"---\r\n") {
        return Ok(false);
    }
    let prefix = String::from_utf8_lossy(prefix).replace("\r\n", "\n");
    let header = prefix.strip_prefix("---\n").unwrap();
    let header = header
        .split_once("\n---\n")
        .map(|(head, _)| head)
        .or_else(|| header.strip_suffix("\n---"))
        .ok_or("无法确认目标文件的头部身份，请使用新的导出文件名")?;
    let header: serde_yaml::Mapping =
        serde_yaml::from_str(header).map_err(|_| "目标文件头部无法解析，请使用新的导出文件名")?;
    let field = |key: &str| header.get(serde_yaml::Value::String(key.into()));
    Ok(
        field("type").and_then(|v| v.as_str()) == Some("Writing Page")
            || field("page_id").is_some()
                && ["write_schema", "write_epoch", "write_metadata"]
                    .iter()
                    .any(|key| field(key).is_some()),
    )
}

fn guard_destination(path: &Path) -> Result<()> {
    if path
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.to_lowercase().ends_with(".writing.md"))
    {
        return Err("请选择独立的导出文件，不能覆盖写作文件".into());
    }
    let info = match std::fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(err(error)),
    };
    if !info.is_file() || info.file_type().is_symlink() {
        return Err("导出目标必须是普通文件，不能是目录或符号链接".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut prefix = Vec::new();
    options
        .open(path)
        .map_err(err)?
        .take(128 * 1024 + 16)
        .read_to_end(&mut prefix)
        .map_err(err)?;
    if writing_header(&prefix)? {
        return Err("目标是带写作身份的页面，即使已改名也不能覆盖；请选择新的导出文件名".into());
    }
    Ok(())
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<()> {
    guard_destination(path)?;
    let parent = path.parent().ok_or("无效导出位置")?;
    let temporary = parent.join(format!(".sumi-export-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(err)?;
        file.write_all(content).map_err(err)?;
        file.sync_all().map_err(err)?;
        guard_destination(path)?;
        std::fs::rename(&temporary, path).map_err(err)?;
        std::fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(err)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub async fn save<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    loaded: Loaded,
    format: String,
) -> Result<bool> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (extension, filename, label) = match format.as_str() {
            "markdown" => ("md", "Sumi.md", "Markdown 正文（不含逐行时间）"),
            "archive" => ("zip", "Sumi.zip", "Sumi 正文与逐行时间"),
            _ => return Err("未知导出格式".into()),
        };
        let content = bytes(&loaded, &format)?;
        let picked = app
            .dialog()
            .file()
            .set_title(label)
            .set_file_name(filename)
            .add_filter(label, &[extension])
            .blocking_save_file();
        let Some(picked) = picked else {
            return Ok(false);
        };
        let path = picked.into_path().map_err(err)?;
        // Exporting a plain Markdown snapshot over a live projection would remove identity.
        if path.extension().and_then(|s| s.to_str()) != Some(extension) {
            return Err("请选择独立的导出文件，不能覆盖正在使用的写作文件".into());
        }
        write_atomic(&path, &content)?;
        Ok(true)
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn writing_identity_survives_rename_and_crlf_headers() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut doc = Document::new(&id, 1, 1).unwrap();
        doc.replace(0, 0, 0, "keep original", 123).unwrap();
        let pair = storage::serialize_pair(&doc.snapshot().unwrap(), None, None).unwrap();
        assert!(writing_header(pair.markdown.as_bytes()).unwrap());
        assert!(writing_header(
            format!("\u{feff}{}", pair.markdown.replace('\n', "\r\n")).as_bytes()
        )
        .unwrap());
        assert!(writing_header(b"---\ntype: Writing Page\n---\n").unwrap());
        assert!(writing_header(b"---\npage_id: retained\nwrite_epoch: 1\n---\n").unwrap());
        assert!(!writing_header(b"---\ntype: Note\n---\nordinary").unwrap());
        assert!(!writing_header(b"ordinary\ntype: Writing Page").unwrap());
        assert!(writing_header(b"---\ntype: [broken\n---\n").is_err());
        let temp = tempfile::tempdir().unwrap();
        let renamed = temp.path().join("renamed.md");
        std::fs::write(&renamed, &pair.markdown).unwrap();
        assert!(write_atomic(&renamed, b"export body").is_err());
        assert_eq!(std::fs::read_to_string(&renamed).unwrap(), pair.markdown);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        assert!(write_atomic(&temp.path().join("PAGE.WRITING.MD"), b"export").is_err());
        let ordinary = temp.path().join("plain.md");
        std::fs::write(&ordinary, "---\ntype: Note\n---\nold").unwrap();
        write_atomic(&ordinary, b"export body").unwrap();
        assert_eq!(std::fs::read(&ordinary).unwrap(), b"export body");
    }

    #[cfg(unix)]
    #[test]
    fn export_does_not_replace_symlinks_or_their_targets() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("source.md");
        let link = temp.path().join("export.md");
        std::fs::write(&target, "original").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(write_atomic(&link, b"replacement").is_err());
        assert!(std::fs::symlink_metadata(link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "original");
    }
    #[test]
    fn archive_keeps_one_revision_and_line_times_plain_export_omits_identity() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut doc = Document::new(&id, 1, 1).unwrap();
        doc.replace(0, 0, 0, "甲\n乙", 123).unwrap();
        let snapshot = doc.snapshot().unwrap();
        let pair = storage::serialize_pair(&snapshot, None, None).unwrap();
        let parsed = storage::parse_pair(&pair.markdown, &pair.metadata).unwrap();
        let loaded = Loaded {
            entry: write_core::catalog::Entry {
                id,
                epoch: 1,
                generation: 0,
                deleted: false,
                local_date: None,
                sequence: None,
                after_id: None,
                registered: false,
            },
            full_state: doc.encode_full(),
            revision: doc.revision(),
            raw_markdown: pair.markdown,
            frontmatter: parsed.frontmatter,
            sidecar: parsed.sidecar,
        };
        assert_eq!(bytes(&loaded, "markdown").unwrap(), "甲\n乙".as_bytes());
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(bytes(&loaded, "archive").unwrap())).unwrap();
        assert_eq!(archive.len(), 2);
        let mut markdown = String::new();
        let mut metadata = String::new();
        archive
            .by_name("page.writing.md")
            .unwrap()
            .read_to_string(&mut markdown)
            .unwrap();
        archive
            .by_name("page.writing.meta.json")
            .unwrap()
            .read_to_string(&mut metadata)
            .unwrap();
        let recovered = storage::parse_pair(&markdown, &metadata).unwrap();
        let mut exported = serde_json::to_value(recovered.sidecar).unwrap();
        let mut original = serde_json::to_value(loaded.sidecar).unwrap();
        // A new paired projection has its own ID while retaining document history.
        exported.as_object_mut().unwrap().remove("projection_id");
        original.as_object_mut().unwrap().remove("projection_id");
        assert_eq!(exported, original);
        assert_eq!(recovered.body, snapshot.body);
    }
}
