//! Recent attention is a proxy from explicitly authored, dated events. It is
//! not a diagnosis and never treats source indexing time as an attention date.
use crate::{hash, model::*};
use chrono::{DateTime, Duration, FixedOffset, NaiveDate};
use jieba_rs::Jieba;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserEvent {
    pub path: String,
    pub date: String,
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub event_id: String,
    pub signal: String,
    pub date_basis: String,
    pub inquiry: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub path: String,
    pub date: String,
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub event_id: String,
    pub signal: String,
    pub date_basis: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusCandidate {
    pub term: String,
    pub kind: String,
    pub score: f64,
    pub active_days: usize,
    pub events: usize,
    pub last_observed_at: String,
    pub occurrences: Vec<Occurrence>,
}
fn local_day(s: &str, offset: i32) -> Option<NaiveDate> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .and_then(|d| {
            Some(
                d.with_timezone(&FixedOffset::east_opt(offset * 60)?)
                    .date_naive(),
            )
        })
        .or_else(|| day(s))
}
fn day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()
}
pub fn literal_contains(text: &str, term: &str) -> bool {
    if term.is_empty() {
        return false;
    }
    let text = text.to_lowercase();
    let term = term.to_lowercase();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.match_indices(&term).any(|(at, _)| {
        (!term.chars().next().is_some_and(word)
            || !text[..at].chars().next_back().is_some_and(word))
            && (!term.chars().next_back().is_some_and(word)
                || !text[at + term.len()..].chars().next().is_some_and(word))
    })
}
fn norm(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn inquiry(text: &str) -> bool {
    [
        "为什么",
        "如何",
        "是什么",
        "什么是",
        "为何",
        "研究",
        "思考",
        "原理",
        "理解",
        "概念",
        "本质",
        "逻辑",
        "分析",
        "关系",
        "洞察",
        "方法论",
        "我想知道",
        "我有一个直觉",
        "我认为",
        "比较",
        "差异",
        "意味着",
        "机制",
        "科学",
        "判断",
        "观点",
        "困惑",
    ]
    .iter()
    .any(|s| text.contains(s))
}
fn sensitive(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(||Regex::new(r"(?i)(api[ _-]?(key|token)|secret|password|authorization|bearer |sk-[a-z0-9]|BEGIN .*PRIVATE KEY|密码[:：=]|令牌[:：=])").unwrap()).is_match(text)
}
fn wrapper(text: &str) -> bool {
    [
        "Your previous response had no visible output",
        "The user interrupted the previous turn on purpose",
        "Referenced ChatGPT conversation:",
        "This is an untrusted",
        "你是本次重做的独立提取与分析执行者",
        "你是全新上下文",
        "协调进程",
        "协调者让你",
        "Exit code:",
        "Base directory for this skill:",
        "automatically supplied ambient UI state",
        "[Request interrupted",
        "The following is the Codex agent history",
        "Review Request",
        "Planned action JSON:",
        "chunk_id",
        "wall_time_seconds",
        "original_token_count",
        "# AGENTS.md",
        "AGENTS.md instructions",
        "<environment_context>",
        "<INSTRUCTIONS>",
        "<skills_instructions>",
        "<skill>",
        "<skill ",
        "你是一个外部 Agent",
        "你是一个外部Agent",
        "<system-reminder>",
        "<subagent_notification>",
        "<task>",
        "You are Codex",
        "You are an AI",
        "You are a coding",
        "Task name:",
        "NEW_TASK",
        "BEGIN TASK FROM PARENT AGENT",
        "You are a fact-checker",
        "You are a worker",
        "You are the worker",
        "END TASK FROM PARENT AGENT",
        "Your task is",
        "Your task:",
        "The following is a summary",
        "We need continue",
        "Current task context",
        "请作为子代理",
        "你是子代理",
        "只读审查任务",
        "You have been assigned",
    ]
    .iter()
    .any(|s| text.contains(s))
}
fn operative(text: &str) -> bool {
    let t = text.trim().trim_matches(['。', '！', '!', '.']);
    if t.chars().count() < 4 && !inquiry(t) {
        return true;
    }
    if t.chars().count() <= 28
        && [
            "继续",
            "发布",
            "截图",
            "开始工作",
            "请开始",
            "构建",
            "提交",
            "上传",
            "打包",
            "编译",
            "测试通过",
            "安装插件",
            "重启",
            "修复一下",
            "请修复",
            "更新版本",
            "合并",
        ]
        .iter()
        .any(|s| t.starts_with(s))
    {
        return true;
    }
    false
}
/// Agent role headings are structural boundaries. Only the user's explicit
/// segment is read; tool/assistant text and injected task wrappers are ignored.
pub fn events_from_markdown(path: &str, raw: &str, utc_offset_minutes: i32) -> Vec<UserEvent> {
    let lines: Vec<_> = raw.lines().collect();
    let mut events = Vec::new();
    if !(-840..=840).contains(&utc_offset_minutes) {
        return events;
    }
    if path.contains("The-following-is-the-Codex-agent-history")
        || lines.iter().take(14).any(|l| {
            l.contains("The following is the Codex agent history")
                || l.contains("Review Request")
                || l.contains("codex-auto-review")
        })
    {
        return events;
    }
    if path.starts_with("agent-sessions/") {
        let started_text = lines
            .iter()
            .take(14)
            .find_map(|l| l.strip_prefix("- Started: "))
            .unwrap_or("");
        let session_key = format!(
            "{}|{}|{}",
            started_text,
            lines
                .iter()
                .take(14)
                .find_map(|l| l.strip_prefix("- Project: "))
                .unwrap_or(""),
            lines
                .iter()
                .take(14)
                .find_map(|l| l.strip_prefix("- Source: "))
                .unwrap_or("")
        );
        let started = local_day(started_text, utc_offset_minutes);
        let ended = lines
            .iter()
            .take(14)
            .find_map(|l| l.strip_prefix("- Ended: "))
            .and_then(|s| local_day(s, utc_offset_minutes));
        let (Some(started), Some(ended)) = (started, ended) else {
            return events;
        };
        if ended < started {
            return events;
        }
        let mut section = None;
        let mut user_index = 0;
        let mut fence = false;
        for i in 0..=lines.len() {
            if i < lines.len()
                && (lines[i].trim_start().starts_with("```")
                    || lines[i].trim_start().starts_with("~~~"))
            {
                fence = !fence;
            }
            let boundary = i == lines.len()
                || !fence && (lines[i].starts_with("## 👤 ") || lines[i].starts_with("## 🤖 "));
            if !boundary {
                continue;
            }
            if let Some(start) = section.take() {
                let first = user_index == 1;
                // For sessions spanning dates, only the opening user event is
                // attributable to Started. Later turns have no message dates.
                if started == ended || first {
                    push_event(
                        &mut events,
                        path,
                        &lines,
                        start,
                        i,
                        started,
                        &session_key,
                        "agent_user",
                        if started == ended {
                            "same_day_session"
                        } else {
                            "session_first_turn"
                        },
                    );
                }
            }
            if i < lines.len() && lines[i].trim() == "## 👤 User" {
                section = Some(i + 1);
                user_index += 1;
            }
        }
    } else if path.ends_with(".note.md") {
        // Never trust capture's default origin=human or a Daily Note title.
        // Native units need their own explicit authorship and creation date.
        let front = raw
            .strip_prefix("---\n")
            .and_then(|r| r.split_once("\n---"))
            .map(|(f, _)| f)
            .unwrap_or("");
        let fm: serde_yaml::Value = serde_yaml::from_str(front).unwrap_or_default();
        let daily = path.starts_with("dailynote/") || fm["type"].as_str() == Some("Daily Note");
        let page_day = path
            .rsplit('/')
            .next()
            .and_then(day)
            .or_else(|| fm["date"].as_str().and_then(day))
            .or_else(|| fm["title"].as_str().and_then(day));
        let mut starts = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if line.trim_start().starts_with("- ") {
                starts.push(i);
            }
        }
        for (idx, &start) in starts.iter().enumerate() {
            let end = starts.get(idx + 1).copied().unwrap_or(lines.len());
            let metadata = &lines[start + 1..end];
            let human = metadata
                .iter()
                .filter_map(|l| l.trim().strip_prefix("by:: "))
                .any(|v| matches!(v.trim(), "human" | "human:me"));
            if !human {
                continue;
            }
            let created = metadata
                .iter()
                .filter_map(|l| l.trim().strip_prefix("created:: "))
                .find_map(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| {
                    d.with_timezone(
                        &FixedOffset::east_opt(utc_offset_minutes * 60)
                            .unwrap_or_else(|| FixedOffset::east_opt(0).unwrap()),
                    )
                    .date_naive()
                });
            let created = if daily { page_day } else { created };
            let Some(created) = created else {
                continue;
            };
            push_event(
                &mut events,
                path,
                &lines,
                start,
                end,
                created,
                &created.to_string(),
                "native_human",
                if daily {
                    "daily_date"
                } else {
                    "explicit_unit_created"
                },
            );
        }
    } else if path.ends_with(".md") && raw.starts_with("---\n") {
        let front = raw[4..].split_once("\n---").map(|(s, _)| s).unwrap_or("");
        let fm: serde_yaml::Value = serde_yaml::from_str(front).unwrap_or_default();
        if fm["type"].as_str() == Some("Trace Request")
            && fm["generated"]["by"].as_str() == Some("human:me")
        {
            if let Some(at) = fm["generated"]["at"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            {
                let date = at
                    .with_timezone(
                        &FixedOffset::east_opt(utc_offset_minutes * 60)
                            .unwrap_or_else(|| FixedOffset::east_opt(0).unwrap()),
                    )
                    .date_naive();
                let start = lines
                    .iter()
                    .enumerate()
                    .skip(1)
                    .find(|(_, l)| l.trim() == "---")
                    .map(|(i, _)| i + 1)
                    .unwrap_or(lines.len());
                push_event(
                    &mut events,
                    path,
                    &lines,
                    start,
                    lines.len(),
                    date,
                    &at.to_rfc3339(),
                    "submitted_material",
                    "explicit_human_request_time",
                );
            }
        }
    }
    events
}
fn push_event(
    events: &mut Vec<UserEvent>,
    path: &str,
    lines: &[&str],
    start: usize,
    end: usize,
    date: NaiveDate,
    namespace: &str,
    signal: &str,
    basis: &str,
) {
    let body = lines[start..end].join("\n");
    if wrapper(&body)
        || (["你是一名", "你是 ", "你是一个"]
            .iter()
            .any(|p| body.contains(p))
            && ["你的任务", "唯一任务", "最高优先级规则"]
                .iter()
                .any(|p| body.contains(p)))
        || operative(&body)
        || body.contains("Answers to your questions:")
        || body.chars().count() > 6000
    {
        return;
    }
    let mut fenced = false;
    let mut parts = Vec::new();
    for (offset, line) in lines[start..end].iter().enumerate() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced
            || t.is_empty()
            || (t.starts_with('>') && signal != "submitted_material")
            || t.starts_with('#')
            || t.starts_with('<')
            || t.contains(":: ")
            || sensitive(t)
        {
            continue;
        }
        if t.contains("/Users/")
            || t.contains("/Volumes/")
            || t.starts_with("http")
            || t.starts_with("![")
            || t.starts_with("Exit code:")
            || t.starts_with("Duration:")
            || t.starts_with("Error:")
        {
            continue;
        }
        if t.starts_with("Uploaded file:")
            || t.starts_with("Distinguish instructions in attached documents")
            || t.starts_with("The user mentioned these files")
            || t.starts_with("Files mentioned by the user")
        {
            continue;
        }
        if operative(t)
            || [
                "请只检索",
                "请检索欧美",
                "请参考欧美",
                "请上欧美互联网",
                "只用一个脚注",
                "每个重要结论",
                "正文H1",
                "新摘要适度",
                "请基于这些资料",
                "请使用以下格式",
            ]
            .iter()
            .any(|p| t.starts_with(p))
        {
            continue;
        }
        let clean = t.trim_start_matches("- ").trim_start_matches("> ");
        parts.push((start + offset + 1, clean.to_string()));
    }
    if parts.is_empty() {
        return;
    }
    let canonical = parts
        .iter()
        .map(|(_, s)| s.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    // Same user event copied into another export is the same event, regardless
    // of filename, generated date or archive folder.
    let event_id = format!(
        "event:{}",
        &hash(format!("{namespace}\0{}", norm(&canonical)))[..24]
    );
    let ask = inquiry(&canonical)
        && ![
            "已注册 skill",
            "已注册skill",
            "meeting-archive",
            "重新提取",
            "只用一个脚注",
            "HH:MM:SS",
            "生成派生摘要",
        ]
        .iter()
        .any(|s| canonical.contains(s));
    for (line, text) in parts {
        events.push(UserEvent {
            path: path.into(),
            date: date.to_string(),
            start: line,
            end: line,
            text,
            event_id: event_id.clone(),
            signal: signal.into(),
            date_basis: basis.into(),
            inquiry: ask,
        });
    }
}
pub(crate) fn lexical_stop(term: &str) -> bool {
    let t = norm(term);
    let n = t.chars().count();
    if !(2..=64).contains(&n)
        || !t.chars().any(char::is_alphabetic)
        || t.ends_with(".wav")
        || t.ends_with(".json")
        || t.ends_with(".ts")
        || t.ends_with(".rs")
        || t.ends_with(".png")
        || t.ends_with(".jpg")
        || t.ends_with(".md")
        || t.chars().any(|c| {
            matches!(
                c,
                '/' | '\\' | '<' | '>' | '[' | ']' | '{' | '}' | '=' | '_' | ':' | '：' | '`'
            )
        })
    {
        return true;
    }
    [
        "please",
        "or",
        "into",
        "about",
        "without",
        "through",
        "could",
        "more",
        "most",
        "some",
        "such",
        "them",
        "these",
        "those",
        "been",
        "being",
        "up",
        "down",
        "out",
        "here",
        "why",
        "where",
        "who",
        "what",
        "which",
        "while",
        "also",
        "very",
        "just",
        "now",
        "so",
        "because",
        "between",
        "before",
        "after",
        "again",
        "further",
        "each",
        "few",
        "both",
        "other",
        "same",
        "than",
        "too",
        "my",
        "me",
        "our",
        "his",
        "her",
        "hers",
        "its",
        "us",
        "the",
        "is",
        "are",
        "was",
        "were",
        "to",
        "as",
        "it",
        "and",
        "has",
        "have",
        "of",
        "your",
        "you",
        "we",
        "they",
        "this",
        "that",
        "with",
        "from",
        "not",
        "for",
        "on",
        "in",
        "an",
        "be",
        "by",
        "do",
        "does",
        "can",
        "will",
        "should",
        "would",
        "must",
        "all",
        "any",
        "only",
        "when",
        "what",
        "how",
        "which",
        "there",
        "their",
        "its",
        "if",
        "then",
        "than",
        "no",
        "yes",
        "output",
        "request",
        "result",
        "state",
        "call",
        "json",
        "ssot",
        "transcript",
        "evidence",
        "read",
        "write",
        "file",
        "directory",
        "seconds",
        "line",
        "text",
        "message",
        "messages",
        "input",
        "system",
        "permission",
        "tool",
        "tools",
        "原理",
        "管理",
        "对应",
        "深度",
        "方向",
        "历史",
        "机制",
        "价值",
        "过程",
        "代表",
        "专业",
        "主题",
        "服务",
        "总结",
        "文本",
        "关键",
        "区分",
        "调整",
        "细节",
        "背景",
        "要求",
        "原则",
        "基础",
        "标准",
        "步骤",
        "目的",
        "重点",
        "整体",
        "角度",
        "中心",
        "维度",
        "条件",
        "本书",
        "实践",
        "现实",
        "框架",
        "帮忙",
        "行为",
        "表现",
        "表现形式",
        "具体实践",
        "经验教训",
        "模板",
        "第一眼",
        "数据集",
        "模型",
        "事物",
        "思路",
        "形成",
        "完成",
        "方面",
        "archive",
        "meeting",
        "meetings",
        "分析",
        "洞察",
        "时间",
        "研究",
        "观点",
        "范围",
        "关系",
        "检索",
        "欧美",
        "检查",
        "整理",
        "个人",
        "状态",
        "自动",
        "建议",
        "变化",
        "规则",
        "经验",
        "事实",
        "标题",
        "影响",
        "能力",
        "记录",
        "技术",
        "来源",
        "文章",
        "设计",
        "材料",
        "逻辑",
        "公司",
        "替代",
        "我会",
        "错误",
        "门槛",
        "对话",
        "结构",
        "产品",
        "概念",
        "方面",
        "领域",
        "学术界",
        "互联网",
        "书籍",
        "注意事项",
        "具体",
        "用户",
        "项目",
        "功能",
        "版本",
        "代码",
        "文件",
        "内容",
        "问题",
        "工具",
        "软件",
        "程序",
        "界面",
        "插件",
        "配置",
        "页面",
        "目录",
        "路径",
        "任务",
        "系统",
        "数据",
        "工作",
        "方案",
        "流程",
        "方法",
        "方式",
        "情况",
        "部分",
        "地方",
        "东西",
        "时候",
        "现在",
        "今天",
        "一下",
        "需求",
        "目标",
        "结果",
        "信息",
        "操作",
        "效果",
        "实现",
        "设置",
        "文档",
        "测试",
        "开发",
        "更新",
        "发布",
        "支持",
        "修改",
        "使用",
        "处理",
        "查看",
        "帮我",
        "可以",
        "需要",
        "如何",
        "什么",
        "这个",
        "那个",
        "一些",
        "一个",
        "这些",
        "我的",
        "自己",
        "我们",
        "还有",
        "直接",
        "全部",
        "相关",
        "目前",
        "当前",
        "之前",
        "之后",
        "继续",
        "请问",
        "请给",
        "md",
        "markdown",
        "vault",
        "app",
        "agent",
        "codex",
        "claude",
        "gpt",
        "github",
        "api",
        "url",
        "ui",
        "mcp",
        "todo",
        "git",
        "node",
        "user",
        "assistant",
        "skill",
        "skills",
        "plan",
        "task",
        "context",
        "files",
        "tokens",
        "token",
        "const",
        "let",
        "return",
        "string",
        "true",
        "false",
        "null",
        "id",
        "name",
        "type",
        "title",
        "content",
        "default",
        "object",
        "public",
        "private",
        "action",
        "config",
        "model",
        "prompt",
        "https",
        "http",
        "bruce",
        "openai",
        "hello",
        "ios",
        "mac",
        "macos",
        "windows",
        "docker",
        "pnpm",
        "npm",
    ]
    .contains(&t.as_str())
        || t.chars().filter(char::is_ascii_digit).count() * 2 > n
}
fn noun(tag: &str) -> bool {
    matches!(tag, "n" | "ng" | "nz" | "nt" | "vn" | "an" | "eng" | "l")
}
pub(crate) fn phrase_operator(s: &str) -> bool {
    [
        "代表", "影响", "导致", "对应", "需要", "希望", "进行", "分为", "成为", "现在", "今天",
        "之前", "之后", "这个", "那个", "我的", "可以", "它们", "他们", "我们",
    ]
    .contains(&s)
}
// Relational heads and modifiers need an explicit referent to stand alone.
// These are grammatical roles, not a topic allow/deny list: longer literal
// compounds remain eligible, as do explicit questions about the word itself.
fn independent_term(term: &str, sentence: &str) -> bool {
    let dependent = [
        "核心", "特点", "特征", "原因", "优点", "缺点", "优势", "劣势", "正面", "负面", "人工",
        "手动", "主要", "次要", "基本", "一般", "整体", "局部",
    ];
    if !dependent.contains(&term) {
        return true;
    }
    [
        format!("什么是{term}"),
        format!("{term}是什么"),
        format!("{term}的定义"),
        format!("{term}这一概念"),
        format!("“{term}”"),
        format!("「{term}」"),
    ]
    .iter()
    .any(|pattern| sentence.contains(pattern))
}
fn context_term(term: &str, anchors: &BTreeMap<String, String>) -> bool {
    let t = norm(term);
    anchors
        .get(&t)
        .is_some_and(|v| matches!(v.as_str(), "context" | "strong_context"))
        || [
            "按钮",
            "侧栏",
            "窗口",
            "图标",
            "菜单",
            "字体",
            "快捷键",
            "脚本",
            "服务器",
            "客户端",
            "宿主",
            "截图",
            "渲染",
            "缓存",
            "日志",
            "连接",
            "同步",
            "编译",
            "排版",
            "视频流",
            "摄像头",
            "摄像机",
            "网络",
            "端口",
            "设备",
        ]
        .contains(&t.as_str())
}
/// Candidates are literal contiguous source spans. POS supplies noun phrases;
/// an existing anchor may help segmentation but never invents an absent phrase.
pub fn rank_events(
    mut events: Vec<UserEvent>,
    context: &FocusContext,
    anchors: &BTreeMap<String, String>,
) -> Result<Vec<FocusCandidate>, String> {
    let as_of = day(&context.as_of)
        .filter(|d| d.to_string() == context.as_of)
        .ok_or("关注观察日期无效")?;
    if context.window_days == 0 || context.window_days > 3660 {
        return Err("关注窗口无效".into());
    }
    let first = as_of - Duration::days(context.window_days as i64 - 1);
    events.sort_by(|a, b| {
        (&a.event_id, &a.date, &a.path, a.start, a.end, &a.text).cmp(&(
            &b.event_id,
            &b.date,
            &b.path,
            b.start,
            b.end,
            &b.text,
        ))
    });
    let mut earliest: BTreeMap<String, NaiveDate> = BTreeMap::new();
    for e in &events {
        if let Some(d) = day(&e.date) {
            earliest
                .entry(e.event_id.clone())
                .and_modify(|old| *old = (*old).min(d))
                .or_insert(d);
        }
    }
    let mut seen = BTreeSet::new();
    let mut active = Vec::new();
    for mut e in events {
        let Some(&d) = earliest.get(&e.event_id) else {
            continue;
        };
        if d < first || d > as_of {
            continue;
        }
        e.date = d.to_string();
        if seen.insert((e.event_id.clone(), norm(&e.text))) {
            active.push(e);
        }
    }
    active.sort_by(|a, b| (&a.date, &a.path, a.start).cmp(&(&b.date, &b.path, b.start)));
    let jieba = Jieba::new();
    let project_names: BTreeSet<String> = active
        .iter()
        .flat_map(|e| {
            e.path
                .rsplit('/')
                .nth(1)
                .into_iter()
                .flat_map(|p| std::iter::once(p).chain(p.split('-')))
                .filter(|p| p.len() >= 3)
                .map(str::to_lowercase)
        })
        .collect();
    let mut terms: BTreeMap<String, (String, BTreeMap<String, (Occurrence, bool)>)> =
        BTreeMap::new();
    for e in &active {
        let tags = jieba.tag(&e.text, true);
        let mut found = BTreeMap::new();
        for (i, t) in tags.iter().enumerate() {
            if !noun(t.tag) || phrase_operator(t.word) {
                continue;
            }
            if t.word.is_ascii()
                && (e.text[..t.byte_start]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                    || e.text[t.byte_end..]
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'))
            {
                continue;
            }
            if !lexical_stop(t.word) {
                found.insert(norm(t.word), t.word.to_string());
            }
            // Two or three adjacent nominal tokens form a literal phrase.
            // Token gaps may contain ASCII spaces but never syntax/punctuation.
            let mut last = t.byte_end;
            for next in tags.iter().skip(i + 1).take(2) {
                if t.tag == "l"
                    || next.tag == "l"
                    || !noun(next.tag)
                    || phrase_operator(next.word)
                    || !e.text[last..next.byte_start].trim().is_empty()
                {
                    break;
                }
                let phrase = &e.text[t.byte_start..next.byte_end];
                if !lexical_stop(phrase)
                    && phrase.chars().count() <= 12
                    && (!t.tag.starts_with('v') || !lexical_stop(t.word))
                    && (!next.tag.starts_with('v') || !lexical_stop(next.word))
                    && (!lexical_stop(t.word) || !lexical_stop(next.word))
                    && !matches!(
                        next.word,
                        "问题"
                            | "内容"
                            | "建议"
                            | "领域"
                            | "时候"
                            | "方面"
                            | "方法"
                            | "方式"
                            | "能力"
                            | "事项"
                    )
                {
                    found.insert(norm(phrase), phrase.to_string());
                }
                last = next.byte_end;
            }
        }
        let lower = e.text.to_lowercase();
        for anchor in anchors
            .keys()
            .filter(|a| !lexical_stop(a) && jieba.tag(a, false).iter().any(|t| noun(t.tag)))
        {
            for (at, _) in lower.match_indices(anchor.as_str()) {
                if let Some(literal) = e.text.get(at..at + anchor.len()) {
                    if literal.is_ascii()
                        && (e.text[..at]
                            .chars()
                            .next_back()
                            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                            || e.text[at + literal.len()..]
                                .chars()
                                .next()
                                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'))
                    {
                        continue;
                    }
                    found.insert(norm(literal), literal.to_string());
                }
            }
        }
        for (key, label) in found {
            let Some(local) = e
                .text
                .split(". ")
                .flat_map(|s| s.split_inclusive(['。', '！', '？', '!', '?', '；', ';']))
                .find(|s| literal_contains(s, &label))
            else {
                continue;
            };
            if !literal_contains(local, &label) || !independent_term(&label, local) {
                continue;
            }
            let lower_local = local.trim().to_lowercase();
            let english_operation = [
                "change ", "fix ", "create ", "build ", "start ", "stop ", "run ", "check ",
                "merge ", "publish ", "deploy ", "connect ", "pull ", "install ", "please ",
                "only ", "continue", "git ", "ping ",
            ]
            .iter()
            .any(|p| lower_local.starts_with(p));
            let operational = english_operation
                || [
                    "禁用",
                    "启用",
                    "启动",
                    "升级",
                    "重启",
                    "credential",
                    "configure",
                    "编译",
                    "渲染",
                    "发布",
                    "脚本",
                    "日志",
                    "配置",
                    "端口",
                    "进程",
                    "截图",
                    "打包",
                    "安装",
                    "npm",
                    "pnpm",
                    "cargo",
                    "commit",
                    "实现",
                    "报错",
                    "缓存",
                    "同步",
                    "插件",
                    "标题prompt",
                    "会议摘要",
                ]
                .iter()
                .any(|s| local.contains(s));
            let reflective = [
                "我认为",
                "我觉得",
                "我的直觉",
                "我有一个",
                "我想知道",
                "我发现",
                "我观察",
                "期望",
                "意味着",
                "连续",
                "逐渐",
                "经常",
                "总是",
                "一直",
                "因为",
                "因此",
                "导致",
                "取决于",
            ]
            .iter()
            .any(|s| local.contains(s));
            let english_inquiry = [
                "why ",
                "how ",
                "explain ",
                "compare ",
                "i think ",
                "i wonder ",
                "i noticed ",
                "what is ",
                "what are ",
                "relationship between",
            ]
            .iter()
            .any(|s| lower_local.starts_with(s));
            let method_clause = local
                .split(['，', ','])
                .filter(|clause| literal_contains(clause, &label))
                .any(|clause| {
                    let l = clause.trim().trim_matches('`').to_lowercase();
                    [
                        "请使用",
                        "请用",
                        "请参考",
                        "请查找",
                        "请搜索",
                        "请检索",
                        "使用 ",
                        "search ",
                        "run ",
                        "use ",
                    ]
                    .iter()
                    .any(|prefix| l.starts_with(prefix))
                });
            let ask = e.signal != "submitted_material"
                && !operational
                && !method_clause
                && (inquiry(local) || reflective || english_inquiry || e.signal == "native_human");
            let occurrence = Occurrence {
                path: e.path.clone(),
                date: e.date.clone(),
                start: e.start,
                end: e.end,
                text: local.to_string(),
                event_id: e.event_id.clone(),
                signal: e.signal.clone(),
                date_basis: e.date_basis.clone(),
            };
            terms
                .entry(key)
                .or_insert_with(|| (label, BTreeMap::new()))
                .1
                .entry(e.event_id.clone())
                .and_modify(|existing| {
                    if ask && !existing.1 {
                        *existing = (occurrence.clone(), ask);
                    }
                })
                .or_insert((occurrence, ask));
        }
    }
    let total_events = active
        .iter()
        .map(|e| &e.event_id)
        .collect::<BTreeSet<_>>()
        .len()
        .max(1) as f64;
    let mut result = Vec::new();
    for (_, (term, occurrences)) in terms {
        let mut days: BTreeMap<NaiveDate, f64> = BTreeMap::new();
        let mut inquiry_days = BTreeSet::new();
        for (o, ask) in occurrences.values() {
            let date = day(&o.date).unwrap();
            let contribution = if *ask { 1.0 } else { 0.1 };
            days.entry(date)
                .and_modify(|x| *x = x.max(contribution))
                .or_insert(contribution);
            if *ask {
                inquiry_days.insert(date);
            }
        }
        let kind = if context_term(&term, anchors)
            || project_names.contains(&norm(&term))
            || inquiry_days.is_empty()
            || (inquiry_days.len() < 2
                && occurrences.values().filter(|(_, ask)| *ask).count() * 2 < occurrences.len())
        {
            "context"
        } else {
            "concept"
        };
        // Operational uses of a homonymous word neither erase nor inflate
        // repeated conceptual reflection. A concept keeps only its actual
        // active local observations; background evidence stays in full graph.
        let activation: f64 = days
            .iter()
            .map(|(date, w)| w * 2f64.powf(-(as_of - *date).num_days() as f64 / 10.))
            .sum();
        let support = (1. + days.len() as f64).ln();
        let idf = ((1. + total_events) / (1. + occurrences.len() as f64))
            .ln()
            .clamp(1., 5.);
        let phrase_specificity = 1. + 0.18 * (term.chars().count().min(8).saturating_sub(2)) as f64;
        let score = activation.ln_1p()
            * (1. + support)
            * idf.sqrt()
            * phrase_specificity
            * if kind == "concept" { 1. } else { 0.22 };
        result.push(FocusCandidate {
            term,
            kind: kind.into(),
            score,
            active_days: days.len(),
            events: occurrences.len(),
            last_observed_at: days.keys().next_back().unwrap().to_string(),
            occurrences: occurrences.into_values().map(|(o, _)| o).collect(),
        });
    }
    result.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.term.cmp(&b.term)));
    let vocabulary = result
        .iter()
        .map(|c| (crate::term_quality::normalize(&c.term), c.term.clone()))
        .collect();
    let assessments = crate::term_quality::assess_terms(&active, &vocabulary, anchors);
    Ok(qualify_candidates(
        result,
        &assessments,
        as_of,
        total_events,
    ))
}

/// The final corpus-wide type decision must re-filter observations, not just
/// relabel an earlier background score as a concept. Used by both rank paths.
pub(crate) fn qualify_candidates(
    mut result: Vec<FocusCandidate>,
    assessments: &BTreeMap<String, crate::term_quality::TermAssessment>,
    as_of: NaiveDate,
    total_events: f64,
) -> Vec<FocusCandidate> {
    result.retain_mut(|candidate| {
        let key = crate::term_quality::normalize(&candidate.term);
        let Some(assessment) = assessments.get(&key) else {
            return false;
        };
        if assessment.class == crate::term_quality::TermClass::Candidate {
            return false;
        }
        candidate.kind = if assessment.class == crate::term_quality::TermClass::Keyword {
            "concept"
        } else {
            "context"
        }
        .into();
        candidate.occurrences.retain(|o| {
            crate::term_quality::prose(&o.text)
                && (candidate.kind == "context"
                    || (assessment.concept_events.contains(&o.event_id)
                        && crate::term_quality::concept_context(&o.text, &candidate.term)))
        });
        if candidate.occurrences.is_empty() {
            return false;
        }
        let days: BTreeSet<_> = candidate
            .occurrences
            .iter()
            .map(|o| o.date.clone())
            .collect();
        candidate.active_days = days.len();
        candidate.events = candidate
            .occurrences
            .iter()
            .map(|o| &o.event_id)
            .collect::<BTreeSet<_>>()
            .len();
        candidate.last_observed_at = days.last().unwrap().clone();
        let activation: f64 = days
            .iter()
            .map(|d| 2f64.powf(-(as_of - day(d).unwrap()).num_days() as f64 / 10.))
            .sum();
        let idf = ((1. + total_events) / (1. + candidate.events as f64))
            .ln()
            .clamp(1., 5.);
        let termhood = if assessment.token_length > 1 {
            1. + 0.2 * assessment.c_value.max(0.).ln_1p()
        } else {
            1.
        };
        candidate.score = activation.ln_1p()
            * (1. + (1. + days.len() as f64).ln())
            * idf.sqrt()
            * termhood
            * if candidate.kind == "concept" {
                1.
            } else {
                0.22
            };
        true
    });
    result.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.term.cmp(&b.term)));
    let max = result
        .first()
        .map(|c| c.score)
        .unwrap_or(1.)
        .max(f64::EPSILON);
    for candidate in &mut result {
        candidate.score /= max;
    }
    result
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusAssociation {
    pub a: String,
    pub b: String,
    pub weight: f64,
    pub occurrences: Vec<Occurrence>,
}
/// Conservative recent co-occurrence. The sample is a real short clause, not
/// a whole user prompt, document, graph neighborhood, or generated summary.
pub fn associations(candidates: &[FocusCandidate]) -> Vec<FocusAssociation> {
    #[derive(Default)]
    struct Window {
        terms: BTreeSet<usize>,
        occurrences: BTreeMap<usize, Occurrence>,
    }
    let mut windows: BTreeMap<(String, String), Window> = BTreeMap::new();
    for (i, c) in candidates.iter().enumerate() {
        for o in &c.occurrences {
            for clause in o
                .text
                .split_inclusive(['。', '，', ',', '；', ';', '!', '?', '！', '？'])
            {
                let normalized = norm(clause);
                if !literal_contains(clause, &c.term) || clause.chars().count() > 160 {
                    continue;
                }
                let window = windows.entry((o.event_id.clone(), normalized)).or_default();
                window.terms.insert(i);
                window.occurrences.insert(i, o.clone());
            }
        }
    }
    let windows: Vec<_> = windows
        .into_iter()
        .filter(|(_, w)| !w.terms.is_empty() && w.terms.len() <= 8)
        .collect();
    let total = windows.len() as f64;
    let mut marginal = vec![0usize; candidates.len()];
    let mut pairs: BTreeMap<(usize, usize), (usize, BTreeMap<String, Occurrence>)> =
        BTreeMap::new();
    for ((event, _), window) in &windows {
        let ids: Vec<_> = window.terms.iter().copied().collect();
        for &i in &ids {
            marginal[i] += 1;
        }
        for (at, &a) in ids.iter().enumerate() {
            for &b in &ids[at + 1..] {
                if norm(&candidates[a].term).contains(&norm(&candidates[b].term))
                    || norm(&candidates[b].term).contains(&norm(&candidates[a].term))
                {
                    continue;
                }
                let p = pairs.entry((a, b)).or_default();
                p.0 += 1;
                p.1.entry(event.clone())
                    .or_insert_with(|| window.occurrences[&a].clone());
            }
        }
    }
    pairs
        .into_iter()
        .filter_map(|((a, b), (joint, observations))| {
            let count = observations.len();
            if count < 2 || total == 0. {
                return None;
            }
            let p = joint as f64 / total;
            if p >= 1. {
                return None;
            }
            let npmi =
                (p / ((marginal[a] as f64 / total) * (marginal[b] as f64 / total))).ln() / -p.ln();
            if npmi < 0.05 {
                return None;
            }
            Some(FocusAssociation {
                a: candidates[a].term.clone(),
                b: candidates[b].term.clone(),
                weight: npmi * count as f64 / (count as f64 + 2.),
                occurrences: observations.into_values().collect(),
            })
        })
        .collect()
}

pub const MAX_CONCEPTS: usize = 30;
pub const MAX_CONTEXTS: usize = 8;
pub const MIN_ACTIVE_DAYS: usize = 2;
pub const MAX_EMERGING: usize = 3;
/// The foreground is a supported subset, not a quota. Unselected candidates
/// remain available to the historical graph; weak one-off metaphors are not
/// promoted merely to fill the city.
pub fn foreground(candidates: &[FocusCandidate]) -> Vec<FocusCandidate> {
    let mut concepts = 0;
    let mut contexts = 0;
    let mut emerging = 0;
    let mut selected = Vec::new();
    for candidate in candidates {
        if candidate.score < 0.1 {
            continue;
        }
        if candidate.kind == "context" {
            if contexts >= MAX_CONTEXTS || candidate.active_days < MIN_ACTIVE_DAYS {
                continue;
            }
            contexts += 1;
        } else {
            if concepts >= MAX_CONCEPTS {
                continue;
            }
            if candidate.active_days < MIN_ACTIVE_DAYS {
                if emerging >= MAX_EMERGING
                    || candidate.events < 2
                    || candidate
                        .occurrences
                        .iter()
                        .map(|o| (&o.date, norm(&o.text)))
                        .collect::<BTreeSet<_>>()
                        .len()
                        < 2
                    || candidate.term.chars().count() < 4
                {
                    continue;
                }
                emerging += 1;
            }
            concepts += 1;
        }
        selected.push(candidate.clone());
    }
    selected
}
