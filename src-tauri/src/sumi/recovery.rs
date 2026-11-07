//! Portable files recover into a NEW page, never an old CRDT epoch. This module
//! only reads source files; the host commits a new document through durability.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, io::Read, path::Path};
use uuid::Uuid;
use write_core::{
    storage::{self, FilePair, Sidecar},
    Document,
};

type Result<T> = std::result::Result<T, String>;
const MAX_MD: u64 = 8 * 1024 * 1024;
const MAX_META: u64 = 64 * 1024 * 1024;
const MAX_SCAN_FILES: usize = 2048;
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
pub const OP_FIELD: &str = "_sumi_recovery_operation";
pub const SOURCE_FIELD: &str = "_sumi_recovery_source";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Evidence {
    pub vault: String,
    pub path: String,
    pub markdown_sha256: String,
    pub metadata_path: String,
    pub metadata_sha256: Option<String>,
}
impl Evidence {
    pub fn fingerprint(&self) -> String {
        storage::sha256(&serde_json::to_vec(self).expect("serializable evidence"))
    }
    pub fn verify_vault(&self, root: &Path) -> Result<()> {
        let root = fs::canonicalize(root).map_err(error)?;
        if self.vault != root.to_string_lossy()
            || !Path::new(&self.path).starts_with(&root)
            || !Path::new(&self.metadata_path).starts_with(&root)
        {
            return Err("恢复证据不属于当前 Vault，请重新检查源文件".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    MatchingPair,
    MarkdownOnly,
    DamagedMetadata,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Probe {
    pub evidence: Evidence,
    pub status: Status,
    pub source_page_id: Option<String>,
    pub source_epoch: Option<u32>,
    pub known_page: bool,
    pub body_units: usize,
    pub logical_lines: usize,
    pub body_preview: String,
    pub preserve_line_times: bool,
    pub normalize_crlf: bool,
    pub warnings: Vec<String>,
    pub metadata_candidates: Vec<String>,
}
pub struct Prepared {
    pub document: Document,
    pub pair: FilePair,
    pub probe: Probe,
}
struct Inspected {
    probe: Probe,
    normalized_raw: String,
    body: String,
    header: serde_yaml::Mapping,
    metadata: Option<String>,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// The file descriptor and final named file must identify the same regular
/// file. This detects ordinary concurrent replacements, not arbitrary-writer CAS.
fn read_regular(root: &Path, path: &Path, limit: u64, optional: bool) -> Result<Option<Vec<u8>>> {
    let named = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if optional && e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(error(e)),
    };
    if !named.is_file() || named.file_type().is_symlink() {
        return Err("恢复源必须是普通文件，不能是符号链接或目录".into());
    }
    if named.len() > limit {
        return Err("恢复源文件超过容量限制".into());
    }
    let canonical = fs::canonicalize(path).map_err(error)?;
    if !canonical.starts_with(root) {
        return Err("恢复源不在当前 Vault 中".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&canonical).map_err(error)?;
    let before = file.metadata().map_err(error)?;
    let mut bytes = Vec::new();
    (&file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    let after = file.metadata().map_err(error)?;
    let final_named = fs::symlink_metadata(path).map_err(error)?;
    if bytes.len() as u64 > limit
        || !final_named.is_file()
        || final_named.file_type().is_symlink()
        || before.len() != after.len()
        || after.len() != bytes.len() as u64
        || before.modified().ok() != after.modified().ok()
        || fs::canonicalize(path).map_err(error)? != canonical
    {
        return Err("源文件正在变化，请重新检查后恢复".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != final_named.dev()
            || before.ino() != final_named.ino()
            || before.dev() != named.dev()
            || before.ino() != named.ino()
            || after.mtime() != final_named.mtime()
            || after.mtime_nsec() != final_named.mtime_nsec()
        {
            return Err("源文件在读取期间被替换，请重新检查".into());
        }
    }
    Ok(Some(bytes))
}
fn header_and_body(raw: &str) -> (serde_yaml::Mapping, String, bool) {
    if let Some(rest) = raw.strip_prefix("---\n") {
        if let Some((header, body)) = rest.split_once("\n---\n") {
            if header.len() <= 128 * 1024 {
                if let Ok(header) = serde_yaml::from_str::<serde_yaml::Mapping>(header) {
                    return (header, body.into(), true);
                }
            }
        }
        return (Default::default(), raw.into(), false);
    }
    (Default::default(), raw.into(), true)
}
fn valid_pair(raw: &str, metadata: &str, source_id: &Option<String>, epoch: Option<u32>) -> bool {
    if source_id.is_none() || epoch.is_none() {
        return false;
    }
    let pair = FilePair {
        markdown: raw.into(),
        metadata: metadata.into(),
    };
    // fork_pair also validates timestamp ranges/source labels, beyond hashes.
    storage::fork_pair(&pair, &Uuid::new_v4().to_string(), fresh_actor()).is_ok()
}
fn fresh_actor() -> u64 {
    Uuid::new_v4().as_u128() as u32 as u64
}
fn inspect(root: &Path, path: &Path) -> Result<Inspected> {
    let root = fs::canonicalize(root).map_err(error)?;
    let raw_bytes = read_regular(&root, path, MAX_MD, false)?.ok_or("源文件不存在")?;
    let path = fs::canonicalize(path).map_err(error)?;
    if path
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| !s.eq_ignore_ascii_case("md"))
    {
        return Err("请选择 Markdown 源文件".into());
    }
    let raw = String::from_utf8(raw_bytes.clone()).map_err(|_| "Markdown 不是有效 UTF-8 文本")?;
    let normalize_crlf = raw.contains('\r');
    let normalized_raw = raw.replace("\r\n", "\n").replace('\r', "\n");
    let (header, body, header_valid) = header_and_body(&normalized_raw);
    let body_units = body.encode_utf16().count();
    if body_units > write_core::MAX_BODY_UTF16 as usize {
        return Err("正文超过写作容量限制".into());
    }
    let source_page_id = header
        .get(serde_yaml::Value::String("page_id".into()))
        .and_then(|v| v.as_str())
        .and_then(|id| Uuid::parse_str(id).ok())
        .map(|id| id.to_string());
    let source_epoch = header
        .get(serde_yaml::Value::String("write_epoch".into()))
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0);
    let expected_meta = path.with_extension("meta.json");
    let mut meta_path = expected_meta.clone();
    let direct = read_regular(&root, &expected_meta, MAX_META, true)?;
    let direct_present = direct.is_some();
    let mut meta_bytes = direct;
    let mut metadata = meta_bytes
        .as_ref()
        .and_then(|bytes| String::from_utf8(bytes.clone()).ok());
    let mut warnings = Vec::new();
    let mut candidates = Vec::new();
    if !header_valid {
        warnings.push("头部格式损坏，已将完整源文保留为正文；不会猜测或删除其中内容。".into())
    }
    if normalize_crlf {
        warnings
            .push("源文件含 CR/CRLF；恢复前需明确同意在新纸页中规范为 LF，原文件保持不变。".into())
    }
    let mut status = if direct_present {
        Status::DamagedMetadata
    } else {
        Status::MarkdownOnly
    };
    if metadata
        .as_ref()
        .is_some_and(|m| valid_pair(&normalized_raw, m, &source_page_id, source_epoch))
    {
        status = Status::MatchingPair;
    } else if !direct_present && source_page_id.is_some() && source_epoch.is_some() {
        let mut directories = BTreeSet::new();
        directories.insert(path.parent().unwrap().to_owned());
        let fixed = root.join("inbox/writings");
        if let Ok(fixed) = fs::canonicalize(&fixed) {
            if fixed.starts_with(&root) {
                directories.insert(fixed);
            }
        }
        let mut matches = Vec::new();
        let mut count = 0;
        let mut total = 0u64;
        let mut complete = true;
        'search: for directory in directories {
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => {
                        complete = false;
                        continue;
                    }
                };
                if !entry.file_name().to_string_lossy().ends_with(".meta.json") {
                    continue;
                }
                count += 1;
                if count > MAX_SCAN_FILES {
                    complete = false;
                    break 'search;
                }
                let size = match entry.metadata() {
                    Ok(m) => m.len(),
                    Err(_) => {
                        complete = false;
                        continue;
                    }
                };
                total = total.saturating_add(size);
                if total > MAX_SCAN_BYTES {
                    complete = false;
                    break 'search;
                }
                let bytes = match read_regular(&root, &entry.path(), MAX_META, false) {
                    Ok(Some(b)) => b,
                    _ => {
                        complete = false;
                        continue;
                    }
                };
                let Ok(text) = String::from_utf8(bytes.clone()) else {
                    continue;
                };
                let Ok(sidecar) = serde_json::from_str::<Sidecar>(&text) else {
                    continue;
                };
                if Uuid::parse_str(&sidecar.page_id)
                    .ok()
                    .map(|id| id.to_string())
                    .as_deref()
                    != source_page_id.as_deref()
                    || Some(sidecar.epoch) != source_epoch
                {
                    continue;
                }
                if valid_pair(&normalized_raw, &text, &source_page_id, source_epoch) {
                    let candidate = fs::canonicalize(entry.path()).map_err(error)?;
                    candidates.push(candidate.to_string_lossy().into_owned());
                    matches.push((candidate, bytes, text));
                }
            }
        }
        if complete && matches.len() == 1 {
            let (candidate, bytes, text) = matches.pop().unwrap();
            meta_path = candidate;
            meta_bytes = Some(bytes);
            metadata = Some(text);
            status = Status::MatchingPair;
            warnings.push("同名元数据缺失，已按页面身份、版本及全文摘要找到唯一匹配文件；恢复不会移动或删除它。".into());
        } else if !complete || matches.len() > 1 {
            status = Status::DamagedMetadata;
            warnings.push(
                if !complete {
                    "候选元数据搜索未能完整验证；新纸页将保留正文，行时间标为未知。"
                } else {
                    "存在多个匹配元数据候选，无法唯一配对；新纸页行时间将标为未知。"
                }
                .into(),
            );
        }
    }
    if status != Status::MatchingPair {
        warnings.push(
            "没有可验证的唯一时间快照；正文可恢复，首次/最后书写时间均标为未知，不会伪造历史。"
                .into(),
        )
    }
    // Recheck both selected files before returning one frozen evidence record.
    if read_regular(&root, &path, MAX_MD, false)?.as_deref() != Some(raw_bytes.as_slice())
        || read_regular(&root, &meta_path, MAX_META, true)? != meta_bytes
    {
        return Err("文件对在检查期间发生变化，请重新检查".into());
    }
    let probe = Probe {
        evidence: Evidence {
            vault: root.to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            markdown_sha256: storage::sha256(&raw_bytes),
            metadata_path: meta_path.to_string_lossy().into_owned(),
            metadata_sha256: meta_bytes.as_ref().map(|b| storage::sha256(b)),
        },
        preserve_line_times: status == Status::MatchingPair,
        status,
        source_page_id,
        source_epoch,
        known_page: false,
        body_units,
        logical_lines: body.split('\n').count(),
        body_preview: body.chars().take(160).collect(),
        normalize_crlf,
        warnings,
        metadata_candidates: candidates,
    };
    Ok(Inspected {
        probe,
        normalized_raw,
        body,
        header,
        metadata,
    })
}
pub fn probe(root: &Path, path: &Path) -> Result<Probe> {
    Ok(inspect(root, path)?.probe)
}

/// The request UUID is the new page identity, making retries stable across a
/// lost response or process restart. Existing-page collision is checked by host.
pub fn prepare(
    root: &Path,
    evidence: &Evidence,
    request_id: &str,
    normalize_crlf: bool,
) -> Result<Prepared> {
    evidence.verify_vault(root)?;
    let id = Uuid::parse_str(request_id)
        .map_err(|_| "恢复操作标识不是有效 UUID")?
        .to_string();
    let inspected = inspect(root, Path::new(&evidence.path))?;
    if &inspected.probe.evidence != evidence {
        return Err("源文件或元数据配对已变化，请重新检查后恢复".into());
    }
    if inspected.probe.source_page_id.as_deref() == Some(id.as_str()) {
        return Err("恢复必须使用新纸页身份，不能重建原 UUID/epoch".into());
    }
    if inspected.probe.normalize_crlf && !normalize_crlf {
        return Err("请先明确确认换行规范化；源文件不会被更改".into());
    }
    let document = if inspected.probe.preserve_line_times {
        storage::fork_pair(
            &FilePair {
                markdown: inspected.normalized_raw.clone(),
                metadata: inspected.metadata.clone().unwrap(),
            },
            &id,
            fresh_actor(),
        )
        .map_err(error)?
    } else {
        Document::import_unknown(&inspected.body, &id, fresh_actor()).map_err(error)?
    };
    let mut header = inspected.header;
    header.insert(OP_FIELD.into(), id.clone().into());
    header.insert(SOURCE_FIELD.into(), evidence.fingerprint().into());
    header.insert(
        "_sumi_recovery_preserved_line_times".into(),
        inspected.probe.preserve_line_times.into(),
    );
    header.insert(
        "_sumi_recovery_normalized_crlf".into(),
        inspected.probe.normalize_crlf.into(),
    );
    let mut prior = if inspected.probe.preserve_line_times {
        Some(serde_json::from_str::<Sidecar>(inspected.metadata.as_ref().unwrap()).map_err(error)?)
    } else {
        None
    };
    if let Some(prior) = prior.as_mut() {
        prior.page_id = id;
        prior.epoch = 1;
    }
    let pair = storage::serialize_pair(
        &document.snapshot().map_err(error)?,
        Some(&header),
        prior.as_ref(),
    )
    .map_err(error)?;
    Ok(Prepared {
        document,
        pair,
        probe: inspected.probe,
    })
}
pub fn same_operation(header: &serde_yaml::Mapping, request_id: &str, evidence: &Evidence) -> bool {
    header
        .get(serde_yaml::Value::String(OP_FIELD.into()))
        .and_then(|v| v.as_str())
        == Some(request_id)
        && header
            .get(serde_yaml::Value::String(SOURCE_FIELD.into()))
            .and_then(|v| v.as_str())
            == Some(evidence.fingerprint().as_str())
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
