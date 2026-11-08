//! Known-page files are projections. Their timestamps never replace the live CRDT.
use super::{err, parse_header, Result};
use std::{fs, path::Path};
use write_core::{
    storage::{self, FilePair, Sidecar},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Observed {
    pub markdown: Option<Vec<u8>>,
    pub metadata: Option<Vec<u8>>,
}
impl Observed {
    pub fn read(md: &Path, meta: &Path) -> Result<Self> {
        fn read(path: &Path) -> Result<Option<Vec<u8>>> {
            match fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(err(e)),
                Ok(info)
                    if !info.is_file()
                        || info.file_type().is_symlink()
                        || info.len() > 64 * 1024 * 1024 =>
                {
                    Err("写作投影必须是受限大小的普通文件，不能跟随符号链接".into())
                }
                Ok(_) => fs::read(path).map(Some).map_err(err),
            }
        }
        Ok(Self {
            markdown: read(md)?,
            metadata: read(meta)?,
        })
    }
    pub fn pair(&self) -> Result<FilePair> {
        let md = self.markdown.as_ref().ok_or("写作正文文件已被外部移除；纸页仍保存在本机。请使用“修复本机文件”恢复原路径，或通过恢复入口处理移动后的文件")?;
        let meta = self.metadata.as_ref().ok_or("写作时间文件缺失；外部正文已保留。请使用“修复本机文件”从本机历史恢复，或将外部稿恢复为新页")?;
        Ok(FilePair {
            markdown: String::from_utf8(md.clone())
                .map_err(|_| "外部正文不是 UTF-8；原文件保留，请使用恢复入口".to_string())?,
            metadata: String::from_utf8(meta.clone())
                .map_err(|_| "时间文件不是 UTF-8；原文件保留，请使用“修复本机文件”".to_string())?,
        })
    }
}

/// Ignore only extension fields. Even coherent old time tables must not roll back
/// the published baseline's protected identity, body digest or line history.
fn protected(sidecar: &Sidecar) -> serde_json::Value {
    let mut value = sidecar.clone();
    value.extra.clear();
    for line in &mut value.lines {
        line.extra.clear();
    }
    serde_json::to_value(value).expect("Sidecar contains only serializable data")
}
pub(super) fn validate(
    pair: &FilePair,
    baseline: &FilePair,
    id: &str,
    epoch: u32,
) -> Result<String> {
    let (_, body) = parse_header(&pair.markdown, id, epoch)?;
    let old = storage::parse_pair(&baseline.markdown, &baseline.metadata).map_err(err)?;
    let sidecar: Sidecar = serde_json::from_str(&pair.metadata).map_err(|_| {
        "写作时间文件损坏或版本不受支持；原文件保留，请使用“修复本机文件”从本机历史恢复".to_string()
    })?;
    if protected(&sidecar) != protected(&old.sidecar) {
        return Err("写作时间文件与可信投影基线不同（可能迟到、被修改或不完整）；不会回滚行时间。请使用“修复本机文件”，原件会保留".into());
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pair() -> FilePair {
        let mut doc =
            write_core::Document::new("8f30fb79-ae3c-4cc9-a01d-1b68b89ed333", 1, 7).unwrap();
        doc.replace(0, 0, 0, "old", 100).unwrap();
        storage::serialize_pair(&doc.snapshot().unwrap(), None, None).unwrap()
    }
    #[test]
    fn external_body_and_unknown_fields_are_allowed_but_history_is_not() {
        let base = pair();
        let id = "8f30fb79-ae3c-4cc9-a01d-1b68b89ed333";
        let mut observed = FilePair {
            markdown: base.markdown.clone(),
            metadata: base.metadata.clone(),
        };
        observed.markdown = observed
            .markdown
            .replacen("type:", "custom: kept\ntype:", 1)
            .replace("old", "new");
        let mut side: serde_json::Value = serde_json::from_str(&observed.metadata).unwrap();
        side["custom"] = serde_json::json!({"retained":true});
        side["lines"][0]["extension"] = serde_json::json!(3);
        observed.metadata = side.to_string();
        assert_eq!(validate(&observed, &base, id, 1).unwrap(), "new");
        side["lines"][0]["first_written_at"] = serde_json::json!("1970-01-01T00:00:00Z");
        observed.metadata = side.to_string();
        assert!(validate(&observed, &base, id, 1)
            .unwrap_err()
            .contains("不会回滚"));
        observed.metadata = "bad".into();
        assert!(validate(&observed, &base, id, 1)
            .unwrap_err()
            .contains("原文件保留"));
    }
    #[test]
    fn missing_metadata_and_deleted_markdown_are_explicit_repair_states() {
        let base = pair();
        let observed = Observed {
            markdown: Some(base.markdown.into_bytes()),
            metadata: None,
        };
        assert!(observed.pair().unwrap_err().contains("时间文件缺失"));
        assert!(Observed {
            markdown: None,
            metadata: Some(base.metadata.into_bytes())
        }
        .pair()
        .unwrap_err()
        .contains("正文文件已被外部移除"));
    }
}
