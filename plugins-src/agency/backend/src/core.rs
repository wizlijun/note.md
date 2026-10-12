//! Evidence-first, local Agency storage. No model scoring or source mutation.
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use fs2::FileExt;
use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tempfile::NamedTempFile;
use uuid::Uuid;

pub const CURRENT_RULE: u32 = 2;
pub const MAX_SOURCES: usize = 40;
pub const MAX_INPUT_CHARS: usize = 180_000;
const MAX_SOURCE_BYTES: u64 = 1_048_576;
const MAX_STORED_BYTES: u64 = 16 * 1_048_576;
const BASE: &str = ".notemd/agency";
const SCHEMA: &str = "notemd.agency/v1";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Scan {
    pub date: String,
    pub considered: usize,
    pub sources: Vec<Source>,
    pub excluded: Vec<Skipped>,
    pub warnings: Vec<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub id: String,
    pub path: String,
    pub sha256: String,
    pub title: String,
    pub started: String,
    pub ended: String,
    pub user_turns: usize,
    pub lines: Vec<SourceLine>,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SourceLine {
    pub n: usize,
    pub role: String,
    pub text: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Signal {
    #[serde(deserialize_with = "signal_state")]
    pub state: String,
    pub note: String,
    pub evidence_indices: Vec<usize>,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub line: usize,
    pub quote: String,
    #[serde(deserialize_with = "evidence_kind")]
    pub kind: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Finding {
    pub note: String,
    pub evidence_indices: Vec<usize>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Experiment {
    pub action: String,
    pub check: String,
    pub evidence_indices: Vec<usize>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Practical {
    pub progress: Option<Finding>,
    pub friction: Option<Finding>,
    pub expansion: Option<Finding>,
    pub experiment: Option<Experiment>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Episode {
    pub id: String,
    pub source_id: String,
    pub title: String,
    #[serde(deserialize_with = "goal_origin")]
    pub goal_origin: String,
    #[serde(deserialize_with = "outcome")]
    pub outcome: String,
    pub efficacy: Signal,
    pub optimism: Signal,
    pub imagination: Signal,
    pub evidence: Vec<Evidence>,
    pub contribution: Vec<String>,
    pub friction: Option<String>,
    #[serde(default)]
    pub practical: Option<Practical>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SkippedSource {
    pub source_id: String,
    pub reason: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    #[serde(default = "legacy_rule", deserialize_with = "supported_rule")]
    pub rule_version: u32,
    #[serde(deserialize_with = "schema")]
    pub schema: String,
    pub invocation_id: String,
    pub date: String,
    pub episodes: Vec<Episode>,
    pub skipped_sources: Vec<SkippedSource>,
    pub suggestion: Option<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    #[serde(default = "legacy_rule", deserialize_with = "supported_rule")]
    pub rule_version: u32,
    pub id: String,
    pub date: String,
    pub created_at: String,
    pub provider: String,
    pub scan: Scan,
    pub episodes: Vec<Episode>,
    pub skipped_sources: Vec<SkippedSource>,
    pub suggestion: Option<String>,
    pub reviews: HashMap<String, Review>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub excluded: bool,
    pub note: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct DaySummary {
    pub date: String,
    pub batch_id: String,
    pub episodes: usize,
    pub observed: usize,
    pub excluded: usize,
    pub created_at: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
struct State {
    schema: String,
    days: BTreeMap<String, String>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            schema: SCHEMA.into(),
            days: BTreeMap::new(),
        }
    }
}

fn legacy_rule() -> u32 {
    1
}
fn supported_rule<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(d)?;
    if matches!(value, 1 | 2) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("unsupported rule version"))
    }
}

fn enum_value<'de, D: Deserializer<'de>>(d: D, values: &[&str]) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if values.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("unsupported enum value"))
    }
}
fn signal_state<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    enum_value(
        d,
        &["observed", "not_observed", "unknown", "not_applicable"],
    )
}
fn evidence_kind<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    enum_value(d, &["user", "assistant"])
}
fn goal_origin<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    enum_value(d, &["user", "adopted", "delegated", "unknown"])
}
fn outcome<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    enum_value(
        d,
        &[
            "ongoing",
            "assistant_reported",
            "user_confirmed",
            "stopped",
            "unknown",
        ],
    )
}
fn schema<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    enum_value(d, &[SCHEMA])
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn date(value: &str) -> Result<NaiveDate, String> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| "日期必须为 YYYY-MM-DD".to_string())?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err("日期必须为 YYYY-MM-DD".into());
    }
    Ok(parsed)
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Resolve only normal relative components and inspect every existing component.
/// `root` is the caller's already selected Vault; it too must be a real directory.
pub fn safe_path(root: &Path, relative: &str, create_parents: bool) -> Result<PathBuf, String> {
    let md = fs::symlink_metadata(root).map_err(|e| format!("无法读取 Vault: {e}"))?;
    if !md.is_dir() || md.file_type().is_symlink() {
        return Err("Vault 必须是非符号链接目录".into());
    }
    let relative_path = Path::new(relative);
    let components: Vec<_> = relative_path.components().collect();
    if components.is_empty()
        || components
            .iter()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("拒绝越界或无效路径".into());
    }
    // On Unix a backslash is legal, but rejecting it keeps stored paths portable.
    if relative.contains('\\') || relative.contains('\0') {
        return Err("无效路径".into());
    }
    let mut path = root.to_path_buf();
    for (i, component) in components.iter().enumerate() {
        path.push(component.as_os_str());
        let parent = i + 1 < components.len();
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || (parent && !metadata.is_dir()) {
                    return Err("拒绝符号链接或非目录路径分量".into());
                }
                if !parent && !metadata.is_file() && !metadata.is_dir() {
                    return Err("拒绝非常规文件".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if parent && create_parents {
                    fs::create_dir(&path)
                        .or_else(|e| {
                            if e.kind() == std::io::ErrorKind::AlreadyExists {
                                Ok(())
                            } else {
                                Err(e)
                            }
                        })
                        .map_err(|e| format!("无法建立目录: {e}"))?;
                    let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
                    if !metadata.is_dir() || metadata.file_type().is_symlink() {
                        return Err("目录创建期间路径已变化".into());
                    }
                }
            }
            Err(e) => return Err(format!("无法检查路径: {e}")),
        }
    }
    Ok(path)
}
fn read_bytes(root: &Path, relative: &str, limit: u64) -> Result<Vec<u8>, String> {
    let path = safe_path(root, relative, false)?;
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("无法读取文件: {e}"))?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("文件过大或不是常规文件".into());
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    safe_path(root, relative, false)?;
    if bytes.len() as u64 > limit {
        return Err("文件超过读取上限".into());
    }
    Ok(bytes)
}
fn optional_json<T: for<'de> Deserialize<'de>>(
    root: &Path,
    relative: &str,
) -> Result<Option<T>, String> {
    let path = safe_path(root, relative, false)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_bytes(root, relative, MAX_STORED_BYTES)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("存储数据无效: {e}"))
}
fn atomic_json<T: Serialize>(root: &Path, relative: &str, value: &T) -> Result<(), String> {
    let path = safe_path(root, relative, true)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_STORED_BYTES {
        return Err("观测批次超过保存上限".into());
    }
    let mut temp =
        NamedTempFile::new_in(path.parent().ok_or("缺少父目录")?).map_err(|e| e.to_string())?;
    temp.write_all(&bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    safe_path(root, relative, false)?;
    temp.persist(&path)
        .map_err(|e| format!("无法原子发布: {}", e.error))?;
    File::open(path.parent().ok_or("缺少父目录")?)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| format!("无法同步发布目录: {e}"))?;
    Ok(())
}
fn lock(root: &Path) -> Result<File, String> {
    let relative = format!("{BASE}/store.lock");
    let path = safe_path(root, &relative, true)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    safe_path(root, &relative, false)?;
    file.try_lock_exclusive()
        .map_err(|_| "Agency 正在保存，请稍后重试".to_string())?;
    Ok(file)
}
fn state(root: &Path) -> Result<State, String> {
    let value = optional_json::<State>(root, &format!("{BASE}/state.json"))?.unwrap_or_default();
    if value.schema != SCHEMA
        || value
            .days
            .iter()
            .any(|(d, id)| date(d).is_err() || !identifier(id))
    {
        return Err("Agency 提交索引无效".into());
    }
    Ok(value)
}

fn walk(
    root: &Path,
    relative: &str,
    files: &mut Vec<String>,
    warnings: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        warnings.push(format!("目录过深，未扫描：{relative}"));
        return Ok(());
    }
    let path = safe_path(root, relative, false)?;
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let relative = format!("{relative}/{name}");
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            warnings.push(format!("跳过符号链接：{relative}"));
        } else if metadata.is_dir() {
            walk(root, &relative, files, warnings, depth + 1)?;
        } else if metadata.is_file() && name.ends_with(".md") {
            files.push(relative);
        }
    }
    Ok(())
}
fn header_value<'a>(header: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("- {key}: ");
    header
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .map(str::trim)
}
fn timestamp(value: &str) -> Option<NaiveDateTime> {
    // Historical export headers are local wall-clock time with no offset.
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .ok()
        .or_else(|| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|v| v.naive_local())
        })
}
fn secret_pattern() -> &'static Regex {
    static SECRET: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    SECRET.get_or_init(|| Regex::new(r#"(?i)(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{16,}|\bBearer\s+[A-Za-z0-9._\-]{20,}|(?:api[_ -]?key|access[_ -]?token|secret|password|authorization)\s*[=:]\s*[\"']?[A-Za-z0-9/+._\-]{16,})"#).expect("static credential expression"))
}
fn suspicious(text: &str) -> bool {
    secret_pattern().is_match(text)
}
fn injected(text: &str) -> bool {
    [
        "<environment_context>",
        "<user_instructions>",
        "# AGENTS.md instructions",
        "<INSTRUCTIONS>",
        "<system-reminder>",
        "<multi_agent_role>",
        "Message Type: NEW_TASK",
        "You are an agent in a team of agents",
        "The following is the Codex agent history whose request action you are assessing",
        "You are a worker agent",
        "You are a subagent",
        "[automated task]",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}
fn parse_lines(text: &str) -> (Vec<SourceLine>, usize, usize, String) {
    // Exported role headings are structural only outside fences/blockquote text.
    // Tool notes and quoted/code content stay context, never owner evidence.
    let mut sections: Vec<(String, Vec<SourceLine>)> = Vec::new();
    let mut role = "context".to_string();
    let mut fence: Option<(char, usize)> = None;
    let mut in_details = false;
    let mut referenced_chatgpt = false;
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        let fence_mark = if trimmed.starts_with("```") {
            Some('`')
        } else if trimmed.starts_with("~~~") {
            Some('~')
        } else {
            None
        };
        if let Some(mark) = fence_mark {
            let length = trimmed.chars().take_while(|c| *c == mark).count();
            match fence {
                None => fence = Some((mark, length)),
                Some((old, count))
                    if old == mark && length >= count && trimmed[length..].trim().is_empty() =>
                {
                    fence = None
                }
                _ => {}
            }
            if let Some((_, lines)) = sections.last_mut() {
                lines.push(SourceLine {
                    n: index + 1,
                    role: "context".into(),
                    text: line.to_string(),
                });
            }
            continue;
        }
        // Codex's ChatGPT handoff wraps cached priorConversation material in
        // a user section. Only the text after the explicit request boundary is
        // the current owner's request; cached roles/headings cannot regain it.
        let reference_heading = fence.is_none()
            && !in_details
            && role == "user"
            && line.trim_end() == "## Referenced ChatGPT conversation:";
        let request_heading = fence.is_none()
            && !in_details
            && referenced_chatgpt
            && line.trim_end() == "## My request:";
        if reference_heading {
            referenced_chatgpt = true;
        }
        if request_heading {
            referenced_chatgpt = false;
        }
        if fence.is_none()
            && !in_details
            && !referenced_chatgpt
            && (line == "## 👤 User" || line.starts_with("## 🤖 "))
        {
            role = if line == "## 👤 User" {
                "user"
            } else {
                "assistant"
            }
            .into();
            sections.push((role.clone(), Vec::new()));
            continue;
        }
        if line.starts_with("<details") {
            in_details = true;
        }
        let context = referenced_chatgpt
            || reference_heading
            || request_heading
            || fence.is_some()
            || in_details
            || trimmed.starts_with('>')
            || line.starts_with("    ")
            || trimmed.starts_with("- 🛠")
            || trimmed.starts_with("🛠")
            || trimmed.contains("tool result (")
            || trimmed.starts_with("**Tool:")
            || trimmed.starts_with("<tool")
            || trimmed.starts_with("<function");
        if !line.trim().is_empty() {
            if let Some((_, lines)) = sections.last_mut() {
                lines.push(SourceLine {
                    n: index + 1,
                    role: if context {
                        "context".into()
                    } else {
                        role.clone()
                    },
                    text: line.to_string(),
                });
            }
        }
        if line.contains("</details>") {
            in_details = false;
        }
    }
    let raw_user_turns = sections.iter().filter(|(role, _)| role == "user").count();
    let mut user_turns = 0;
    let mut first_user = String::new();
    let mut output = Vec::new();
    for (role, mut lines) in sections {
        if role == "user" {
            let joined = lines
                .iter()
                .filter(|l| l.role == "user")
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if injected(&joined) {
                for line in &mut lines {
                    line.role = "context".into();
                }
            } else if lines.iter().any(|l| l.role == "user") {
                user_turns += 1;
                if first_user.is_empty() {
                    first_user = lines
                        .iter()
                        .filter(|l| l.role == "user")
                        .map(|l| l.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                }
            }
        }
        output.extend(lines);
    }
    (output, user_turns, raw_user_turns, first_user)
}

pub fn scan(root: &Path, requested_date: &str) -> Result<Scan, String> {
    let day = date(requested_date)?;
    let mut result = Scan { date: requested_date.into(), considered: 0, sources: Vec::new(), excluded: Vec::new(), warnings: vec!["历史导出未提供逐条消息时间；日期仅表示会话区间与所选日相交，不代表当天新增行为。头部时间按本机导出时区解释。".into()] };
    let mut files = Vec::new();
    walk(root, "agent-sessions", &mut files, &mut result.warnings, 0)?;
    files.sort();
    let mut pending: Vec<(Source, String, bool, usize)> = Vec::new();
    for path in files {
        let name = Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if name.starts_with("index")
            || name == "_project.md"
            || name.contains("conflict")
            || name.contains("冲突")
        {
            continue;
        }
        let disk_path = safe_path(root, &path, false)?;
        let mut prefix = Vec::new();
        File::open(&disk_path)
            .map_err(|e| e.to_string())?
            .take(8192)
            .read_to_end(&mut prefix)
            .map_err(|e| e.to_string())?;
        let prefix = String::from_utf8_lossy(&prefix);
        let header = prefix.split("\n---").next().unwrap_or(&prefix);
        let start_text = header_value(header, "Started").unwrap_or_default();
        let end_text = header_value(header, "Ended").unwrap_or_default();
        let (Some(start), Some(end)) = (timestamp(start_text), timestamp(end_text)) else {
            if name.starts_with(requested_date) {
                result.excluded.push(Skipped {
                    path,
                    reason: "缺少有效 Started / Ended；未按文件名猜测日期".into(),
                });
            }
            continue;
        };
        if start.date() > day || end.date() < day {
            continue;
        }
        result.considered += 1;
        let mut skip = |reason: &str| {
            result.excluded.push(Skipped {
                path: path.clone(),
                reason: reason.into(),
            })
        };
        if end < start {
            skip("会话结束时间早于开始时间");
            continue;
        }
        let lower_header = header.to_lowercase();
        if lower_header.contains("codex-auto-review")
            || lower_header.contains("agency-observe")
            || path.contains("/agency-observe")
        {
            skip("自动审批或 Agency 自身任务，不计为本人互动");
            continue;
        }
        let bytes = match read_bytes(root, &path, MAX_SOURCE_BYTES) {
            Ok(v) => v,
            Err(_) => {
                skip("文件过大、不可读取或路径不安全；整份来源未分析");
                continue;
            }
        };
        let text = match std::str::from_utf8(&bytes) {
            Ok(v) => v,
            Err(_) => {
                skip("来源不是有效 UTF-8");
                continue;
            }
        };
        if suspicious(text) {
            skip("检测到疑似凭证；整份来源已排除，未复制内容");
            continue;
        }
        let (lines, user_turns, raw_turns, first_user) = parse_lines(text);
        if header_value(header, "User turns")
            .and_then(|v| v.parse::<usize>().ok())
            .is_some_and(|n| n != raw_turns)
        {
            skip("正文角色边界与导出轮次数不符，可能含嵌套 transcript");
            continue;
        }
        if user_turns == 0 {
            skip("没有可确定的本人用户轮次；仅系统注入、子任务或上下文");
            continue;
        }
        if first_user.contains("agency-observe")
            || first_user.starts_with("You are a worker")
            || first_user.starts_with("You are a subagent")
        {
            skip("Agency 自身或已知 worker 任务");
            continue;
        }
        // Do not discard later genuine turns just because an injected preamble was present.
        let chars = text.chars().count();
        if chars > MAX_INPUT_CHARS {
            skip("单份来源超过 180000 字符预算；未截断分析");
            continue;
        }
        if start.date() != end.date() {
            result
                .warnings
                .push(format!("跨日会话，仅按区间展示：{path}"));
        }
        let title = text
            .lines()
            .next()
            .and_then(|l| l.strip_prefix("# "))
            .unwrap_or("未命名会话")
            .chars()
            .take(240)
            .collect();
        pending.push((
            Source {
                id: format!("source-{}", &digest(path.as_bytes())[..24]),
                path,
                sha256: digest(&bytes),
                title,
                started: start_text.into(),
                ended: end_text.into(),
                user_turns,
                lines,
            },
            digest(first_user.as_bytes()),
            text.contains("send_message"),
            chars,
        ));
    }
    let mut first_counts: HashMap<String, (usize, bool)> = HashMap::new();
    for (_, first, has_send, _) in &pending {
        let value = first_counts.entry(first.clone()).or_insert((0, false));
        value.0 += 1;
        value.1 |= *has_send;
    }
    // Allocate the bounded input to the most recent starts first, rather than
    // letting provider/account/path spelling give old cross-day sessions priority.
    // Identity checks above still see the entire eligible set before selection.
    pending.sort_by(|a, b| {
        timestamp(&b.0.started)
            .cmp(&timestamp(&a.0.started))
            .then_with(|| a.0.path.cmp(&b.0.path))
    });
    let mut hashes = HashSet::new();
    let mut input_chars = 0;
    for (source, first, _, chars) in pending {
        let counts = first_counts.get(&first).copied().unwrap_or((0, false));
        let reason = if counts.0 > 1 && counts.1 {
            Some("首问重复且含 send_message，疑似父子派生会话，保守排除")
        } else if hashes.contains(&source.sha256) {
            Some("与已纳入来源字节完全重复")
        } else if result.sources.len() >= MAX_SOURCES {
            Some("超过本次 40 份来源上限；覆盖不完整")
        } else if input_chars + chars > MAX_INPUT_CHARS {
            Some("超过本次 180000 字符总预算；整份来源未分析")
        } else {
            None
        };
        if let Some(reason) = reason {
            result.excluded.push(Skipped {
                path: source.path,
                reason: reason.into(),
            });
        } else {
            input_chars += chars;
            hashes.insert(source.sha256.clone());
            result.sources.push(source);
        }
    }
    if result.sources.is_empty() {
        result
            .warnings
            .push("此日期没有可纳入的互动来源；不代表当天没有 AI 互动。".into());
    }
    if !result.excluded.is_empty() {
        result.warnings.push(format!(
            "{} 份候选来源被排除；指标仅覆盖已纳入来源。",
            result.excluded.len()
        ));
    }
    Ok(result)
}

pub fn validate_source(root: &Path, source: &Source) -> Result<(), String> {
    if !source.path.starts_with("agent-sessions/") {
        return Err("来源必须在 agent-sessions 内".into());
    }
    let bytes = read_bytes(root, &source.path, MAX_SOURCE_BYTES)?;
    if digest(&bytes) != source.sha256 {
        return Err(format!("来源已变化，请重新扫描：{}", source.path));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "来源不是有效 UTF-8")?;
    let (lines, user_turns, _, _) = parse_lines(text);
    if source.id != format!("source-{}", &digest(source.path.as_bytes())[..24])
        || source.lines != lines
        || source.user_turns != user_turns
        || suspicious(text)
    {
        return Err("扫描快照身份、角色或内容与来源不匹配".into());
    }
    Ok(())
}
fn bounded(value: &str, max: usize, label: &str, nonempty: bool) -> Result<(), String> {
    if (nonempty && value.trim().is_empty()) || value.chars().count() > max || value.contains('\0')
    {
        return Err(format!("{label} 为空、过长或含无效字符"));
    }
    if suspicious(value) {
        return Err(format!("{label} 含疑似凭证，拒绝保存"));
    }
    Ok(())
}
fn validate_practical_indices(
    indices: &[usize],
    evidence: &[Evidence],
    require_user: bool,
) -> Result<(), String> {
    if indices.is_empty()
        || indices.len() > 40
        || indices.iter().any(|index| *index >= evidence.len())
    {
        return Err("协作复盘必须引用非空、合法的证据索引".into());
    }
    if require_user && !indices.iter().any(|index| evidence[*index].kind == "user") {
        return Err("协作摩擦、可能性与小尝试必须引用用户原话".into());
    }
    Ok(())
}
fn validate_practical(practical: &Practical, evidence: &[Evidence]) -> Result<(), String> {
    for (finding, require_user) in [
        (&practical.progress, false),
        (&practical.friction, true),
        (&practical.expansion, true),
    ] {
        if let Some(finding) = finding {
            bounded(&finding.note, 1000, "协作复盘说明", true)?;
            validate_practical_indices(&finding.evidence_indices, evidence, require_user)?;
        }
    }
    if let Some(experiment) = &practical.experiment {
        bounded(&experiment.action, 600, "小尝试动作", true)?;
        bounded(&experiment.check, 600, "小尝试验证方式", true)?;
        validate_practical_indices(&experiment.evidence_indices, evidence, true)?;
    }
    Ok(())
}

pub fn validate_candidate(
    root: &Path,
    scan: &Scan,
    candidate: &Candidate,
    invocation: &str,
) -> Result<(), String> {
    // Round-trip also validates enum strings constructed by Rust callers.
    let encoded = serde_json::to_vec(candidate).map_err(|e| e.to_string())?;
    let _: Candidate =
        serde_json::from_slice(&encoded).map_err(|e| format!("候选结构或枚举无效: {e}"))?;
    date(&scan.date)?;
    if !identifier(invocation)
        || candidate.invocation_id != invocation
        || candidate.date != scan.date
        || candidate.schema != SCHEMA
    {
        return Err("候选日期、协议或 invocation 不匹配".into());
    }
    if scan.sources.len() > MAX_SOURCES
        || candidate.episodes.len() > 200
        || candidate.skipped_sources.len() > MAX_SOURCES
    {
        return Err("来源或片段数量超过上限".into());
    }
    if candidate.rule_version == CURRENT_RULE {
        if candidate.suggestion.is_some() {
            return Err("规则 2 不接受无证据的顶层 suggestion；请使用 practical.experiment".into());
        }
        if candidate
            .episodes
            .iter()
            .filter(|episode| {
                episode
                    .practical
                    .as_ref()
                    .is_some_and(|practical| practical.experiment.is_some())
            })
            .count()
            > 1
        {
            return Err("每批协作复盘至多一个可选小尝试".into());
        }
    }
    if let Some(suggestion) = &candidate.suggestion {
        bounded(suggestion, 1000, "建议", false)?;
    }
    let sources: HashMap<_, _> = scan.sources.iter().map(|s| (s.id.as_str(), s)).collect();
    if sources.len() != scan.sources.len() {
        return Err("扫描来源 ID 重复".into());
    }
    for source in &scan.sources {
        validate_source(root, source)?;
    }
    let mut episodes = HashSet::new();
    let mut used_sources = HashSet::new();
    let mut episode_counts: HashMap<&str, usize> = HashMap::new();
    for episode in &candidate.episodes {
        if !identifier(&episode.id) || !episodes.insert(episode.id.as_str()) {
            return Err("片段 ID 无效或重复".into());
        }
        let source = sources
            .get(episode.source_id.as_str())
            .ok_or("片段指向本次范围外来源")?;
        used_sources.insert(episode.source_id.as_str());
        let count = episode_counts
            .entry(episode.source_id.as_str())
            .or_default();
        *count += 1;
        if *count > 4 {
            return Err("每份来源最多 4 个片段".into());
        }
        bounded(&episode.title, 300, "片段标题", true)?;
        if episode.evidence.len() > 40 || episode.contribution.len() > 12 {
            return Err("片段证据或作用条目过多".into());
        }
        for item in &episode.contribution {
            bounded(item, 600, "贡献说明", true)?;
        }
        if let Some(friction) = &episode.friction {
            bounded(friction, 1000, "协作负担", false)?;
        }
        for (index, evidence) in episode.evidence.iter().enumerate() {
            bounded(&evidence.quote, 400, "证据引文", true)?;
            let position = format!(
                "片段 {} 的 evidence[{}]（源行 {}）",
                episode.id, index, evidence.line
            );
            let line = source
                .lines
                .iter()
                .find(|l| l.n == evidence.line)
                .ok_or_else(|| format!("{position}：证据行不在本次来源中"))?;
            if line.role != evidence.kind || !line.text.contains(&evidence.quote) {
                return Err(format!("{position}：证据引文或角色与原文不匹配"));
            }
        }
        let has_user = episode.evidence.iter().any(|e| e.kind == "user");
        if !has_user {
            return Err("每个片段必须至少包含一条用户原话证据".into());
        }
        if candidate.rule_version == CURRENT_RULE && episode.practical.is_none() {
            return Err("规则 2 的每个片段必须包含 practical 对象；未知项可为 null".into());
        }
        if let Some(practical) = &episode.practical {
            validate_practical(practical, &episode.evidence)?;
        }
        for signal in [&episode.efficacy, &episode.optimism, &episode.imagination] {
            bounded(&signal.note, 1500, "维度说明", true)?;
            if signal.evidence_indices.len() > 40
                || signal
                    .evidence_indices
                    .iter()
                    .any(|i| *i >= episode.evidence.len())
            {
                return Err("维度证据索引越界".into());
            }
            if signal.state == "observed"
                && !signal
                    .evidence_indices
                    .iter()
                    .any(|i| episode.evidence[*i].kind == "user")
            {
                return Err("observed 维度必须绑定用户原话证据".into());
            }
        }
    }
    let mut skipped = HashSet::new();
    for item in &candidate.skipped_sources {
        bounded(&item.reason, 1000, "跳过原因", true)?;
        if !sources.contains_key(item.source_id.as_str())
            || used_sources.contains(item.source_id.as_str())
            || !skipped.insert(item.source_id.as_str())
        {
            return Err("跳过来源不在范围内、重复或同时存在片段".into());
        }
    }
    if used_sources.len() + skipped.len() != sources.len() {
        return Err("候选未覆盖每份来源；必须给出片段或跳过原因".into());
    }
    Ok(())
}
fn load_id(root: &Path, requested_date: &str, id: &str) -> Result<Batch, String> {
    if !identifier(id) {
        return Err("批次 ID 无效".into());
    }
    let mut batch = optional_json::<Batch>(root, &format!("{BASE}/batches/{id}.json"))?
        .ok_or("提交指针指向缺失批次")?;
    if batch.id != id || batch.date != requested_date || batch.scan.date != requested_date {
        return Err("提交指针与批次身份不一致".into());
    }
    if let Some(reviews) =
        optional_json::<HashMap<String, Review>>(root, &format!("{BASE}/reviews/{id}.json"))?
    {
        for (episode, review) in &reviews {
            if !batch.episodes.iter().any(|e| e.id == *episode) {
                return Err("人工校正指向未知片段".into());
            }
            bounded(&review.note, 4000, "人工校正", false)?;
        }
        batch.reviews = reviews;
    }
    Ok(batch)
}
pub fn load(root: &Path, requested_date: &str) -> Result<Option<Batch>, String> {
    date(requested_date)?;
    let state = state(root)?;
    state
        .days
        .get(requested_date)
        .map(|id| load_id(root, requested_date, id))
        .transpose()
}
/// Same read coverage. Rule-version compatibility is checked separately.
/// Publication-only notices about
/// old review files do not change the source scan and must not trigger reruns.
pub fn same_scan(a: &Scan, b: &Scan) -> bool {
    // Include parsed roles, not just file bytes: a corrected parser must not
    // reuse an old batch that attributed cached transcript to the owner.
    let sources_a: BTreeMap<_, _> = a
        .sources
        .iter()
        .map(|s| (&s.id, (&s.sha256, s.user_turns, &s.lines)))
        .collect();
    let sources_b: BTreeMap<_, _> = b
        .sources
        .iter()
        .map(|s| (&s.id, (&s.sha256, s.user_turns, &s.lines)))
        .collect();
    let warnings_a: Vec<_> = a
        .warnings
        .iter()
        .filter(|s| !s.starts_with("旧批次校正："))
        .collect();
    let warnings_b: Vec<_> = b
        .warnings
        .iter()
        .filter(|s| !s.starts_with("旧批次校正："))
        .collect();
    a.date == b.date
        && a.considered == b.considered
        && a.sources.len() == b.sources.len()
        && sources_a == sources_b
        && warnings_a == warnings_b
        && serde_json::to_value(&a.excluded).ok() == serde_json::to_value(&b.excluded).ok()
}

/// Whether the current product rule can safely reuse this exact coverage.
pub fn reusable(batch: &Batch, scan: &Scan, provider: &str) -> bool {
    batch.rule_version == CURRENT_RULE && batch.provider == provider && same_scan(&batch.scan, scan)
}

pub fn publish(
    root: &Path,
    scan: &Scan,
    candidate: Candidate,
    invocation: &str,
    provider: &str,
) -> Result<Batch, String> {
    let _guard = lock(root)?;
    bounded(provider, 128, "Provider", true)?;
    validate_candidate(root, scan, &candidate, invocation)?;
    let mut state = state(root)?;
    let previous = state
        .days
        .get(&scan.date)
        .map(|id| load_id(root, &scan.date, id))
        .transpose()?;
    // Legacy rule-1 payloads remain readable and testable, but they cannot
    // satisfy a rule-2 request just because the source bytes are unchanged.
    if let Some(previous) = &previous {
        if previous.rule_version == candidate.rule_version
            && previous.provider == provider
            && same_scan(&previous.scan, scan)
        {
            return Ok(previous.clone());
        }
    }
    let mut batch = Batch {
        rule_version: candidate.rule_version,
        id: Uuid::new_v4().to_string(),
        date: scan.date.clone(),
        created_at: Utc::now().to_rfc3339(),
        provider: provider.into(),
        scan: scan.clone(),
        episodes: candidate.episodes,
        skipped_sources: candidate.skipped_sources,
        suggestion: candidate.suggestion,
        reviews: HashMap::new(),
    };
    if let Some(previous) = previous {
        if !previous.reviews.is_empty() {
            batch.scan.warnings.push(format!(
                "旧批次校正：{} 条人工校正仍保留于旧批次 {}；来源或规则上下文已变化，未自动应用。",
                previous.reviews.len(),
                previous.id
            ));
        }
    }
    atomic_json(root, &format!("{BASE}/batches/{}.json", batch.id), &batch)?;
    if !batch.reviews.is_empty() {
        atomic_json(
            root,
            &format!("{BASE}/reviews/{}.json", batch.id),
            &batch.reviews,
        )?;
    }
    // Recheck immediately before the single commit point. Orphan batch files are
    // harmless: readers only follow state.json, never enumerate batches.
    for source in &scan.sources {
        validate_source(root, source)?;
    }
    state.days.insert(scan.date.clone(), batch.id.clone());
    atomic_json(root, &format!("{BASE}/state.json"), &state)?;
    Ok(batch)
}
pub fn history(root: &Path) -> Result<Vec<DaySummary>, String> {
    let state = state(root)?;
    let mut result = Vec::new();
    for (day, id) in state.days.iter().rev() {
        let batch = load_id(root, day, id)?;
        let excluded = batch
            .episodes
            .iter()
            .filter(|e| batch.reviews.get(&e.id).is_some_and(|r| r.excluded))
            .count();
        let observed = batch
            .episodes
            .iter()
            .filter(|e| {
                !batch.reviews.get(&e.id).is_some_and(|r| r.excluded)
                    && [&e.efficacy, &e.optimism, &e.imagination]
                        .iter()
                        .any(|s| s.state == "observed")
            })
            .count();
        result.push(DaySummary {
            date: day.clone(),
            batch_id: id.clone(),
            episodes: batch.episodes.len(),
            observed,
            excluded,
            created_at: batch.created_at,
        });
    }
    Ok(result)
}
pub fn save_review(
    root: &Path,
    requested_date: &str,
    batch_id: &str,
    episode_id: &str,
    excluded: bool,
    note: &str,
) -> Result<Batch, String> {
    date(requested_date)?;
    bounded(note, 4000, "人工校正", false)?;
    let _guard = lock(root)?;
    let state = state(root)?;
    if state.days.get(requested_date).map(String::as_str) != Some(batch_id) {
        return Err("当前批次已变化，请刷新后再校正".into());
    }
    let mut batch = load_id(root, requested_date, batch_id)?;
    if !batch.episodes.iter().any(|e| e.id == episode_id) {
        return Err("不存在该片段".into());
    }
    batch.reviews.insert(
        episode_id.into(),
        Review {
            excluded,
            note: note.into(),
        },
    );
    atomic_json(
        root,
        &format!("{BASE}/reviews/{batch_id}.json"),
        &batch.reviews,
    )?;
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    fn root() -> TempDir {
        tempfile::tempdir().unwrap()
    }
    fn fixture(root: &Path, name: &str, start: &str, end: &str, body: &str) {
        let path = safe_path(root, &format!("agent-sessions/{name}.md"), true).unwrap();
        let users = body.lines().filter(|l| *l == "## 👤 User").count();
        fs::write(path, format!("# Test\n\n- Started: {start}\n- Ended: {end}\n- Model: codex\n- User turns: {users}\n\n---\n\n{body}\n")).unwrap();
    }
    fn seeded() -> (TempDir, Scan) {
        let root = root();
        fixture(
            root.path(),
            "one",
            "2026-09-22 10:00",
            "2026-09-22 10:30",
            "## 👤 User\n请验证结果并报告证据。\n## 🤖 Codex\n已完成。",
        );
        let scan = scan(root.path(), "2026-09-22").unwrap();
        (root, scan)
    }
    fn candidate(scan: &Scan) -> Candidate {
        let source = &scan.sources[0];
        let line = source.lines.iter().find(|l| l.role == "user").unwrap();
        let unknown = Signal {
            state: "unknown".into(),
            note: "没有证据".into(),
            evidence_indices: vec![],
        };
        Candidate {
            rule_version: 1,
            schema: SCHEMA.into(),
            invocation_id: "invocation-1".into(),
            date: scan.date.clone(),
            suggestion: None,
            skipped_sources: vec![],
            episodes: vec![Episode {
                id: "episode-1".into(),
                source_id: source.id.clone(),
                title: "验证结果".into(),
                goal_origin: "user".into(),
                outcome: "ongoing".into(),
                efficacy: Signal {
                    state: "observed".into(),
                    note: "提出验收要求".into(),
                    evidence_indices: vec![0],
                },
                optimism: unknown.clone(),
                imagination: unknown,
                evidence: vec![Evidence {
                    line: line.n,
                    quote: line.text.clone(),
                    kind: "user".into(),
                }],
                contribution: vec!["设定验收".into()],
                friction: None,
                practical: None,
            }],
        }
    }
    #[test]
    fn empty_is_unknown_coverage_and_invalid_date_rejected() {
        let root = root();
        assert!(scan(root.path(), "2026-02-30").is_err());
        let empty = scan(root.path(), "2026-09-22").unwrap();
        assert!(empty.sources.is_empty());
        assert!(empty.warnings.iter().any(|s| s.contains("不代表")));
        assert!(load(root.path(), "2026-09-22").unwrap().is_none());
        assert!(history(root.path()).unwrap().is_empty());
    }
    #[test]
    fn selects_header_interval_not_filename_and_marks_cross_day() {
        let root = root();
        fixture(
            root.path(),
            "old-name",
            "2026-09-21 23:00",
            "2026-09-23 00:10",
            "## 👤 User\n做一件事",
        );
        fixture(
            root.path(),
            "2026-09-22-not-today",
            "2026-09-20 10:00",
            "2026-09-20 10:10",
            "## 👤 User\n另一个任务",
        );
        let scan = scan(root.path(), "2026-09-22").unwrap();
        assert_eq!(scan.sources.len(), 1);
        assert!(scan.sources[0].path.contains("old-name"));
        assert!(scan.warnings.iter().any(|s| s.contains("跨日")));
    }
    #[test]
    fn injected_review_worker_and_own_tasks_excluded() {
        let root = root();
        for (name, body) in [
            (
                "review",
                "The following is the Codex agent history whose request action you are assessing",
            ),
            ("worker", "You are a worker agent"),
            ("system", "<environment_context>"),
            ("own", "agency-observe-v1"),
        ] {
            fixture(
                root.path(),
                name,
                "2026-09-22 10:00",
                "2026-09-22 10:30",
                &format!("## 👤 User\n{body}"),
            );
        }
        let scan = scan(root.path(), "2026-09-22").unwrap();
        assert_eq!(scan.considered, 4);
        assert!(scan.sources.is_empty());
        assert_eq!(scan.excluded.len(), 4);
    }
    #[test]
    fn duplicate_first_prompt_with_send_message_not_counted_as_owner() {
        let root = root();
        for name in ["parent", "child"] {
            fixture(
                root.path(),
                name,
                "2026-09-22 10:00",
                "2026-09-22 10:30",
                "## 👤 User\n相同任务\n## 🤖 Codex\nsend_message to worker",
            );
        }
        let scan = scan(root.path(), "2026-09-22").unwrap();
        assert!(scan.sources.is_empty());
        assert!(scan.excluded.iter().all(|s| s.reason.contains("派生")));
    }
    #[test]
    fn code_quotes_and_tools_cannot_be_user_evidence() {
        let root = root();
        fixture(root.path(), "one", "2026-09-22 10:00", "2026-09-22 10:30", "## 👤 User\n真正的请求\n> 引用内容\n```text\n代码内容\n```\n## 🤖 Codex\n> tool result (ok)");
        let scan = scan(root.path(), "2026-09-22").unwrap();
        let source = &scan.sources[0];
        for marker in ["引用内容", "代码内容", "tool result"] {
            assert_eq!(
                source
                    .lines
                    .iter()
                    .find(|l| l.text.contains(marker))
                    .unwrap()
                    .role,
                "context"
            );
        }
        let mut bad = candidate(&scan);
        let quoted = source
            .lines
            .iter()
            .find(|l| l.text.contains("引用内容"))
            .unwrap();
        bad.episodes[0].evidence[0] = Evidence {
            line: quoted.n,
            quote: "引用内容".into(),
            kind: "user".into(),
        };
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
    }
    #[test]
    fn credentials_excluded_without_echoing_secret() {
        let root = root();
        let secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
        fixture(
            root.path(),
            "one",
            "2026-09-22 10:00",
            "2026-09-22 10:30",
            &format!("## 👤 User\nAPI_KEY={secret}"),
        );
        let scan = scan(root.path(), "2026-09-22").unwrap();
        assert!(scan.sources.is_empty());
        assert!(!serde_json::to_string(&scan).unwrap().contains(secret));
        assert!(scan.excluded[0].reason.contains("凭证"));
    }
    #[test]
    fn budget_excludes_whole_source_and_reports_coverage() {
        let root = root();
        fixture(
            root.path(),
            "huge",
            "2026-09-22 10:00",
            "2026-09-22 10:30",
            &format!("## 👤 User\n{}", "文".repeat(MAX_INPUT_CHARS + 1)),
        );
        let scan = scan(root.path(), "2026-09-22").unwrap();
        assert!(scan.sources.is_empty());
        assert_eq!(scan.excluded.len(), 1);
    }
    #[test]
    fn rejects_forged_quote_assistant_as_user_and_invalid_signal() {
        let (root, scan) = seeded();
        let mut bad = candidate(&scan);
        bad.episodes[0].evidence[0].quote = "不存在的证据".into();
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        let assistant = scan.sources[0]
            .lines
            .iter()
            .find(|l| l.role == "assistant")
            .unwrap();
        let mut bad = candidate(&scan);
        bad.episodes[0].evidence[0] = Evidence {
            line: assistant.n,
            quote: assistant.text.clone(),
            kind: "user".into(),
        };
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        let mut bad = candidate(&scan);
        bad.episodes[0].efficacy.state = "high".into();
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        let mut bad = candidate(&scan);
        bad.episodes[0].efficacy.evidence_indices = vec![];
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
    }
    #[test]
    fn unknown_fields_and_enum_rejected_at_parse() {
        let (_, scan) = seeded();
        let mut value = serde_json::to_value(candidate(&scan)).unwrap();
        value["ignored_field"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Candidate>(value).is_err());
        let mut value = serde_json::to_value(candidate(&scan)).unwrap();
        value["episodes"][0]["outcome"] = serde_json::json!("success");
        assert!(serde_json::from_value::<Candidate>(value).is_err());
    }
    #[test]
    fn coverage_and_invocation_must_match() {
        let (root, scan) = seeded();
        let mut bad = candidate(&scan);
        bad.episodes.clear();
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        let mut bad = candidate(&scan);
        bad.skipped_sources.push(SkippedSource {
            source_id: scan.sources[0].id.clone(),
            reason: "重复".into(),
        });
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        assert!(publish(root.path(), &scan, candidate(&scan), "different", "test").is_err());
    }
    #[test]
    fn drift_rejected_without_changing_committed_batch() {
        let (root, scan) = seeded();
        let batch = publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").unwrap();
        fs::write(root.path().join(&scan.sources[0].path), "changed").unwrap();
        assert!(publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").is_err());
        assert_eq!(load(root.path(), &scan.date).unwrap().unwrap().id, batch.id);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_source_parent_and_state_are_rejected() {
        use std::os::unix::fs::symlink;
        let (root, scan) = seeded();
        let source = root.path().join(&scan.sources[0].path);
        let outside = root.path().join("elsewhere.md");
        fs::rename(&source, &outside).unwrap();
        symlink(&outside, &source).unwrap();
        assert!(validate_source(root.path(), &scan.sources[0]).is_err());
        fs::remove_file(&source).unwrap();
        let outside_dir = root.path().join("outside");
        fs::create_dir(&outside_dir).unwrap();
        symlink(&outside_dir, root.path().join("agent-sessions/link")).unwrap();
        assert!(safe_path(root.path(), "agent-sessions/link/a.md", true).is_err());
        let state_path = safe_path(root.path(), ".notemd/agency/state.json", true).unwrap();
        symlink(&outside, state_path).unwrap();
        assert!(history(root.path()).is_err());
    }
    #[test]
    fn orphan_batches_do_not_publish_and_corrupt_index_fails_closed() {
        let (root, scan) = seeded();
        let batch = publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").unwrap();
        let mut orphan = batch.clone();
        orphan.id = "orphan".into();
        atomic_json(root.path(), ".notemd/agency/batches/orphan.json", &orphan).unwrap();
        assert_eq!(history(root.path()).unwrap().len(), 1);
        assert_eq!(load(root.path(), &scan.date).unwrap().unwrap().id, batch.id);
        fs::write(root.path().join(".notemd/agency/state.json"), "broken").unwrap();
        assert!(publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").is_err());
        assert!(root
            .path()
            .join(format!(".notemd/agency/batches/{}.json", batch.id))
            .exists());
    }
    #[test]
    fn reviews_are_independent_retained_and_stale_writes_rejected() {
        let (root, scan) = seeded();
        let batch = publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").unwrap();
        save_review(
            root.path(),
            &scan.date,
            &batch.id,
            "episode-1",
            true,
            "我不认同这条解释",
        )
        .unwrap();
        assert_eq!(history(root.path()).unwrap()[0].observed, 0);
        let next = publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").unwrap();
        assert!(next.reviews["episode-1"].excluded);
        assert_eq!(
            load(root.path(), &scan.date).unwrap().unwrap().reviews["episode-1"].note,
            "我不认同这条解释"
        );
        assert_eq!(next.id, batch.id);
        // A changed source creates a fresh batch and never inherits a correction
        // just because an LLM reuses the same episode ID.
        fixture(
            root.path(),
            "one",
            "2026-09-22 10:00",
            "2026-09-22 10:30",
            "## 👤 User\n请验证新的结果并报告证据。\n## 🤖 Codex\n已完成。",
        );
        let changed = super::scan(root.path(), &scan.date).unwrap();
        let replacement = publish(
            root.path(),
            &changed,
            candidate(&changed),
            "invocation-1",
            "test",
        )
        .unwrap();
        assert_ne!(replacement.id, batch.id);
        assert!(replacement.reviews.is_empty());
        assert!(replacement
            .scan
            .warnings
            .iter()
            .any(|w| w.contains("未自动应用")));
        assert!(save_review(
            root.path(),
            &scan.date,
            &batch.id,
            "episode-1",
            false,
            "stale"
        )
        .is_err());
        assert!(root
            .path()
            .join(format!(".notemd/agency/reviews/{}.json", batch.id))
            .exists());
    }
    #[test]
    fn unchanged_source_hash_cannot_be_bypassed_by_path_traversal() {
        let (root, mut scan) = seeded();
        scan.sources[0].path = "agent-sessions/../elsewhere.md".into();
        assert!(validate_source(root.path(), &scan.sources[0]).is_err());
    }
    #[test]
    fn altered_scan_lines_cannot_forge_user_evidence() {
        let (root, mut scan) = seeded();
        let line = scan.sources[0]
            .lines
            .iter_mut()
            .find(|l| l.role == "user")
            .unwrap();
        line.text = "凭空编造用户已经验收".into();
        assert!(publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").is_err());
    }
    #[test]
    fn every_episode_needs_user_evidence_and_per_source_limit() {
        let (root, scan) = seeded();
        let mut bad = candidate(&scan);
        bad.episodes[0].goal_origin = "unknown".into();
        bad.episodes[0].efficacy.state = "unknown".into();
        bad.episodes[0].efficacy.evidence_indices.clear();
        bad.episodes[0].evidence.clear();
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        let mut bad = candidate(&scan);
        let episode = bad.episodes[0].clone();
        for i in 2..=5 {
            let mut next = episode.clone();
            next.id = format!("episode-{i}");
            bad.episodes.push(next);
        }
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
    }
    #[test]
    fn changed_exclusions_refresh_coverage_despite_same_included_sources() {
        let (root, scan) = seeded();
        let before = publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").unwrap();
        fixture(
            root.path(),
            "review",
            "2026-09-22 10:00",
            "2026-09-22 10:10",
            "## 👤 User\nYou are a worker agent",
        );
        let updated = super::scan(root.path(), &scan.date).unwrap();
        assert_eq!(scan.sources.len(), updated.sources.len());
        assert!(!same_scan(&scan, &updated));
        let after = publish(
            root.path(),
            &updated,
            candidate(&updated),
            "invocation-1",
            "test",
        )
        .unwrap();
        assert_ne!(before.id, after.id);
        assert_eq!(after.scan.excluded.len(), 1);
        assert_eq!(after.scan.considered, 2);
    }
    #[test]
    fn review_migration_notice_does_not_break_idempotency() {
        let (root, scan) = seeded();
        let first = publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").unwrap();
        save_review(
            root.path(),
            &scan.date,
            &first.id,
            "episode-1",
            true,
            "保留判断",
        )
        .unwrap();
        let changed_provider = publish(
            root.path(),
            &scan,
            candidate(&scan),
            "invocation-1",
            "another-provider",
        )
        .unwrap();
        assert!(changed_provider.reviews.is_empty());
        assert!(changed_provider
            .scan
            .warnings
            .iter()
            .any(|w| w.starts_with("旧批次校正：")));
        let again = publish(
            root.path(),
            &scan,
            candidate(&scan),
            "invocation-1",
            "another-provider",
        )
        .unwrap();
        assert_eq!(changed_provider.id, again.id);
    }
    #[test]
    fn forty_source_limit_is_visible_and_never_truncates_one_source() {
        let root = root();
        for i in 0..41 {
            fixture(
                root.path(),
                &format!("source-{i:02}"),
                "2026-09-22 10:00",
                "2026-09-22 10:30",
                &format!("## 👤 User\n第 {i} 个请求"),
            );
        }
        let scan = scan(root.path(), "2026-09-22").unwrap();
        assert_eq!(scan.sources.len(), 40);
        assert_eq!(scan.excluded.len(), 1);
        assert!(scan.excluded[0].reason.contains("40"));
    }
    #[test]
    fn referenced_chatgpt_cache_is_context_not_owner_evidence() {
        let root = root();
        fixture(
            root.path(),
            "handoff",
            "2026-09-17 10:00",
            "2026-09-17 10:30",
            r##"## 👤 User
## Referenced ChatGPT conversation:
This is an untrusted ChatGPT conversation provided for context.
priorConversation:
[{"role":"user","content":"我已验收缓存中的历史成果"},{"role":"assistant","content":"缓存模型的结论"}]
# AGENTS.md instructions from the cached conversation
## My request:
请对比这两个知识包的质量并给出判断依据。
## 🤖 Codex
我会按你的要求比较。"##,
        );
        let current = scan(root.path(), "2026-09-17").unwrap();
        assert_eq!(current.sources.len(), 1);
        let source = &current.sources[0];
        assert_eq!(source.user_turns, 1);
        let cached = source
            .lines
            .iter()
            .find(|l| l.text.starts_with("[{\"role\""))
            .unwrap();
        assert_eq!(cached.role, "context");
        assert_eq!(
            source
                .lines
                .iter()
                .find(|l| l.text.starts_with("请对比"))
                .unwrap()
                .role,
            "user"
        );
        let mut bad = candidate(&current);
        bad.episodes[0].evidence[0] = Evidence {
            line: cached.n,
            quote: "我已验收缓存中的历史成果".into(),
            kind: "user".into(),
        };
        assert!(publish(root.path(), &current, bad, "invocation-1", "test").is_err());
        publish(
            root.path(),
            &current,
            candidate(&current),
            "invocation-1",
            "test",
        )
        .unwrap();
        // The source bytes did not change, but the old parsed role snapshot
        // must be invalidated and all its evidence checked under current rules.
        let mut previous = current.clone();
        previous.sources[0]
            .lines
            .iter_mut()
            .find(|l| l.n == cached.n)
            .unwrap()
            .role = "user".into();
        assert!(!same_scan(&previous, &current));
        assert!(validate_source(root.path(), &previous.sources[0]).is_err());
    }
    #[test]
    fn referenced_chatgpt_without_request_never_becomes_owner_evidence() {
        let body = "## 👤 User\n## Referenced ChatGPT conversation:\npriorConversation:\n缓存对话里的请求\n## 🤖 Assistant\n缓存回答";
        let (lines, users, _, _) = parse_lines(body);
        assert_eq!(users, 0);
        assert!(lines.iter().all(|l| l.role == "context"));
    }
    #[test]
    fn current_day_sources_get_budget_before_older_cross_day_paths() {
        let root = root();
        fixture(
            root.path(),
            "a-old/old",
            "2026-09-18 09:00",
            "2026-09-19 23:00",
            &format!("## 👤 User\n{}", "old request ".repeat(11_000)),
        );
        fixture(
            root.path(),
            "z-new/today",
            "2026-09-19 10:00",
            "2026-09-19 11:00",
            &format!("## 👤 User\n{}", "new request ".repeat(5_000)),
        );
        let scan = scan(root.path(), "2026-09-19").unwrap();
        assert_eq!(scan.considered, 2);
        assert_eq!(scan.sources.len(), 1);
        assert!(scan.sources[0].path.ends_with("z-new/today.md"));
        assert_eq!(scan.excluded.len(), 1);
        assert!(scan.excluded[0].path.ends_with("a-old/old.md"));
        assert!(scan.excluded[0].reason.contains("180000 字符总预算"));
        assert!(scan.warnings.iter().any(|warning| warning.contains("跨日")));
        assert!(
            scan.sources[0]
                .lines
                .iter()
                .map(|line| line.text.chars().count())
                .sum::<usize>()
                <= MAX_INPUT_CHARS
        );
    }

    #[test]
    fn same_start_time_selection_has_stable_path_tie_breaker() {
        let root = root();
        for name in ["z-source", "a-source"] {
            fixture(
                root.path(),
                name,
                "2026-09-19 10:00",
                "2026-09-19 11:00",
                &format!("## 👤 User\n{name} {}", "request ".repeat(13_000)),
            );
        }
        let scan = scan(root.path(), "2026-09-19").unwrap();
        assert_eq!(scan.sources.len(), 1);
        assert!(scan.sources[0].path.ends_with("a-source.md"));
        assert_eq!(scan.excluded.len(), 1);
        assert!(scan.excluded[0].path.ends_with("z-source.md"));
    }
    fn practical_candidate(scan: &Scan) -> Candidate {
        let mut candidate = candidate(scan);
        candidate.rule_version = CURRENT_RULE;
        let assistant = scan.sources[0]
            .lines
            .iter()
            .find(|line| line.role == "assistant")
            .unwrap();
        candidate.episodes[0].evidence.push(Evidence {
            line: assistant.n,
            quote: assistant.text.clone(),
            kind: "assistant".into(),
        });
        candidate.episodes[0].practical = Some(Practical {
            progress: Some(Finding {
                note: "助手报告已完成，尚待验收".into(),
                evidence_indices: vec![1],
            }),
            friction: Some(Finding {
                note: "验收要求尚未得到具体证据回应".into(),
                evidence_indices: vec![0, 1],
            }),
            expansion: None,
            experiment: Some(Experiment {
                action: "请提供一项验收材料".into(),
                check: "能否根据材料核对原来的要求".into(),
                evidence_indices: vec![0],
            }),
        });
        candidate
    }

    #[test]
    fn legacy_json_without_practical_or_rule_version_remains_readable() {
        let (root, scan) = seeded();
        let mut old_candidate = serde_json::to_value(candidate(&scan)).unwrap();
        old_candidate
            .as_object_mut()
            .unwrap()
            .remove("rule_version");
        old_candidate["episodes"][0]
            .as_object_mut()
            .unwrap()
            .remove("practical");
        let candidate: Candidate = serde_json::from_value(old_candidate).unwrap();
        assert_eq!(candidate.rule_version, 1);
        assert!(candidate.episodes[0].practical.is_none());
        let batch = publish(root.path(), &scan, candidate, "invocation-1", "test").unwrap();
        let mut old_batch = serde_json::to_value(&batch).unwrap();
        old_batch.as_object_mut().unwrap().remove("rule_version");
        old_batch["episodes"][0]
            .as_object_mut()
            .unwrap()
            .remove("practical");
        atomic_json(
            root.path(),
            &format!("{BASE}/batches/{}.json", batch.id),
            &old_batch,
        )
        .unwrap();
        let loaded = load(root.path(), &scan.date).unwrap().unwrap();
        assert_eq!(loaded.rule_version, 1);
        assert!(loaded.episodes[0].practical.is_none());
        assert!(!reusable(&loaded, &scan, "test"));
    }

    #[test]
    fn practical_unknown_object_is_valid_but_missing_object_is_not_rule_two() {
        let (root, scan) = seeded();
        let mut missing = candidate(&scan);
        missing.rule_version = CURRENT_RULE;
        assert!(publish(root.path(), &scan, missing.clone(), "invocation-1", "test").is_err());
        let mut value = serde_json::to_value(missing).unwrap();
        value["episodes"][0]["practical"] = serde_json::json!({});
        let unknown: Candidate = serde_json::from_value(value).unwrap();
        let batch = publish(root.path(), &scan, unknown, "invocation-1", "test").unwrap();
        let practical = batch.episodes[0].practical.as_ref().unwrap();
        assert!(practical.progress.is_none());
        assert!(practical.friction.is_none());
        assert!(practical.expansion.is_none());
        assert!(practical.experiment.is_none());
        assert_eq!(batch.episodes[0].outcome, "ongoing");
        assert_eq!(batch.rule_version, CURRENT_RULE);
    }

    #[test]
    fn practical_findings_require_bounded_notes_and_valid_references() {
        let (root, scan) = seeded();
        for indices in [vec![], vec![2], vec![0; 41]] {
            let mut bad = practical_candidate(&scan);
            bad.episodes[0]
                .practical
                .as_mut()
                .unwrap()
                .progress
                .as_mut()
                .unwrap()
                .evidence_indices = indices;
            assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        }
        for note in [" ".to_string(), "字".repeat(1001)] {
            let mut bad = practical_candidate(&scan);
            bad.episodes[0]
                .practical
                .as_mut()
                .unwrap()
                .progress
                .as_mut()
                .unwrap()
                .note = note;
            assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        }
        // An assistant claim is valid evidence of reported progress, without
        // promoting that claim to user acceptance or an observed human belief.
        let good = practical_candidate(&scan);
        assert_eq!(
            good.episodes[0]
                .practical
                .as_ref()
                .unwrap()
                .progress
                .as_ref()
                .unwrap()
                .evidence_indices,
            vec![1]
        );
        publish(root.path(), &scan, good, "invocation-1", "test").unwrap();
    }

    #[test]
    fn friction_expansion_and_experiment_need_user_evidence() {
        let (root, scan) = seeded();
        for field in ["friction", "expansion", "experiment"] {
            let mut value = serde_json::to_value(practical_candidate(&scan)).unwrap();
            if field == "expansion" {
                value["episodes"][0]["practical"][field] =
                    serde_json::json!({"note":"仅有助手列出的选项","evidence_indices":[1]});
            } else {
                value["episodes"][0]["practical"][field]["evidence_indices"] =
                    serde_json::json!([1]);
            }
            let bad: Candidate = serde_json::from_value(value).unwrap();
            assert!(
                publish(root.path(), &scan, bad, "invocation-1", "test").is_err(),
                "{field}"
            );
        }
        for indices in [vec![], vec![2]] {
            let mut bad = practical_candidate(&scan);
            bad.episodes[0]
                .practical
                .as_mut()
                .unwrap()
                .experiment
                .as_mut()
                .unwrap()
                .evidence_indices = indices;
            assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        }
        for field in ["action", "check"] {
            for text in [" ".to_string(), "字".repeat(601)] {
                let mut value = serde_json::to_value(practical_candidate(&scan)).unwrap();
                value["episodes"][0]["practical"]["experiment"][field] = serde_json::json!(text);
                assert!(publish(
                    root.path(),
                    &scan,
                    serde_json::from_value(value).unwrap(),
                    "invocation-1",
                    "test"
                )
                .is_err());
            }
        }
    }

    #[test]
    fn practical_unknown_fields_and_unsupported_rule_versions_are_rejected() {
        let (root, scan) = seeded();
        for field in ["extra", "progress", "experiment"] {
            let mut value = serde_json::to_value(practical_candidate(&scan)).unwrap();
            if field == "extra" {
                value["episodes"][0]["practical"][field] = serde_json::json!(true);
            } else {
                value["episodes"][0]["practical"][field]["extra"] = serde_json::json!(true);
            }
            assert!(serde_json::from_value::<Candidate>(value).is_err());
        }
        for rule in [0, 3] {
            let mut bad = candidate(&scan);
            bad.rule_version = rule;
            assert!(
                serde_json::from_value::<Candidate>(serde_json::to_value(&bad).unwrap()).is_err()
            );
            assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        }
        let batch = publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").unwrap();
        let mut value = serde_json::to_value(batch).unwrap();
        value["rule_version"] = serde_json::json!(3);
        assert!(serde_json::from_value::<Batch>(value).is_err());
    }

    #[test]
    fn rule_two_allows_at_most_one_experiment_and_no_legacy_suggestion() {
        let (root, scan) = seeded();
        let mut bad = practical_candidate(&scan);
        let mut second = bad.episodes[0].clone();
        second.id = "episode-2".into();
        bad.episodes.push(second);
        assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        for suggestion in ["", "无证据的小建议"] {
            let mut bad = practical_candidate(&scan);
            bad.suggestion = Some(suggestion.into());
            assert!(publish(root.path(), &scan, bad, "invocation-1", "test").is_err());
        }
    }

    #[test]
    fn new_rule_publishes_new_batch_and_preserves_old_exclusion_review() {
        let (root, scan) = seeded();
        let legacy = publish(root.path(), &scan, candidate(&scan), "invocation-1", "test").unwrap();
        save_review(
            root.path(),
            &scan.date,
            &legacy.id,
            "episode-1",
            true,
            "旧规则解释不适用",
        )
        .unwrap();
        assert!(!reusable(&legacy, &scan, "test"));
        let current = publish(
            root.path(),
            &scan,
            practical_candidate(&scan),
            "invocation-1",
            "test",
        )
        .unwrap();
        assert_ne!(legacy.id, current.id);
        assert_eq!(current.rule_version, CURRENT_RULE);
        assert!(current.reviews.is_empty());
        assert!(current
            .scan
            .warnings
            .iter()
            .any(|warning| warning.starts_with("旧批次校正：")));
        let old = load_id(root.path(), &scan.date, &legacy.id).unwrap();
        assert!(old.reviews["episode-1"].excluded);
        assert_eq!(old.reviews["episode-1"].note, "旧规则解释不适用");
        assert!(reusable(&current, &scan, "test"));
        assert!(!reusable(&current, &scan, "different-provider"));
        let reused = publish(
            root.path(),
            &scan,
            practical_candidate(&scan),
            "invocation-1",
            "test",
        )
        .unwrap();
        assert_eq!(current.id, reused.id);
        let mut changed_coverage = scan.clone();
        changed_coverage.warnings.push("新增覆盖缺口".into());
        assert!(!reusable(&current, &changed_coverage, "test"));
    }

    #[test]
    fn rule_two_preserves_source_exclusions_and_explicit_skips() {
        let (root, mut scan) = seeded();
        scan.excluded.push(Skipped {
            path: "agent-sessions/excluded.md".into(),
            reason: "身份未知".into(),
        });
        let mut candidate = practical_candidate(&scan);
        candidate.episodes.clear();
        candidate.skipped_sources.push(SkippedSource {
            source_id: scan.sources[0].id.clone(),
            reason: "缺少清晰的协作复盘证据".into(),
        });
        let batch = publish(root.path(), &scan, candidate, "invocation-1", "test").unwrap();
        assert!(batch.episodes.is_empty());
        assert_eq!(batch.scan.excluded.len(), 1);
        assert_eq!(batch.skipped_sources.len(), 1);
        assert!(batch.suggestion.is_none());
        let loaded = load(root.path(), &scan.date).unwrap().unwrap();
        assert_eq!(loaded.scan.excluded[0].reason, "身份未知");
        assert_eq!(loaded.skipped_sources[0].reason, "缺少清晰的协作复盘证据");
    }
    #[test]
    fn validation_diagnostic_locates_bad_evidence_without_source_text() {
        let (root, scan) = seeded();
        let mut bad = practical_candidate(&scan);
        let actual_line = bad.episodes[0].evidence[0].line;
        bad.episodes[0].evidence[0].quote = "这句话并不存在".into();
        let error = validate_candidate(root.path(), &scan, &bad, "invocation-1").unwrap_err();
        assert!(error.contains("episode-1"));
        assert!(error.contains("evidence[0]"));
        assert!(error.contains(&format!("源行 {actual_line}")));
        assert!(!error.contains("这句话并不存在"));
        assert!(!error.contains("请验证结果并报告证据"));
        let mut bad = practical_candidate(&scan);
        bad.episodes[0].evidence[1].kind = "user".into();
        let error = validate_candidate(root.path(), &scan, &bad, "invocation-1").unwrap_err();
        assert!(error.contains("episode-1"));
        assert!(error.contains("evidence[1]"));
        assert!(!error.contains("已完成"));
    }
}
