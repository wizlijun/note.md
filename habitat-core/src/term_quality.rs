//! Shared term admission for recent and historical graphs. C-value is a
//! corpus statistic, not semantic typing; conservative context rules supply
//! typing without claiming a trained NER or OpenIE model.
use crate::focus::{literal_contains, UserEvent};
use aho_corasick::AhoCorasick;
use jieba_rs::Jieba;
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TermClass {
    Keyword,
    Project,
    Person,
    Tool,
    Resource,
    Entity,
    Candidate,
}
impl TermClass {
    pub fn node_type(self) -> &'static str {
        match self {
            Self::Keyword => "keyword",
            Self::Project => "project",
            Self::Person => "person",
            Self::Tool => "tool",
            Self::Resource => "resource",
            Self::Entity => "entity",
            Self::Candidate => "term_candidate",
        }
    }
    pub fn main(self) -> bool {
        matches!(self, Self::Keyword | Self::Project)
    }
}
#[derive(Debug, Clone)]
pub struct TermAssessment {
    pub class: TermClass,
    pub c_value: f64,
    pub token_length: usize,
    pub frequency: usize,
    pub concept_events: BTreeSet<String>,
    pub background_events: BTreeSet<String>,
}
pub fn normalize(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
pub fn surface_allowed(value: &str) -> bool {
    let original = value;
    let value = normalize(value);
    // A lowercase identifier glued to Han text is code/field naming, not an
    // automatically established noun phrase. Acronyms (AI/LLM) remain eligible.
    let code_mixture = original
        .chars()
        .zip(original.chars().skip(1))
        .any(|(a, b)| a.is_ascii_lowercase() && !b.is_ascii() && b.is_alphabetic())
        && original
            .split(|c: char| !c.is_ascii_alphabetic())
            .filter(|s| !s.is_empty())
            .any(|word| word.len() > 3)
        && !value.contains(' ');
    !code_mixture
        && !crate::focus::lexical_stop(&value)
        && !value.contains("://")
        && !value.contains('/')
        && !value.contains('\\')
        && !value.split_whitespace().any(|w| {
            matches!(w, "the" | "of" | "in" | "for" | "with" | "and" | "or")
                && value.split_whitespace().count() == 1
        })
        && !value.as_bytes().first().is_some_and(u8::is_ascii_digit)
        && !(value.len() <= 4 && value.chars().any(|c| c.is_ascii_digit()))
}
/// Ignore syntax-shaped material, not topics. An actual question about a
/// programming language remains eligible when written as prose.
pub fn prose(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty()
        && !t.starts_with(['{', '}', '[', ']', '<', '>'])
        && !t.starts_with("//")
        && !t.starts_with("- P0")
        && !t.starts_with("- P1")
        && !t.starts_with("- P2")
        && !(t.starts_with('"') && t.contains("\":"))
        && !t.contains(":: ")
        && !t.contains("```")
        && ![
            "references/",
            "SKILL.md",
            "CLAUDE.md",
            "AGENTS.md",
            "/src/",
            ".schema.json",
            "Role / Scope",
            "Role/Scope",
            "Role + Scope",
        ]
        .iter()
        .any(|s| t.contains(s))
        && !(t.contains("skill")
            && ["使用", "调用", "遵循", "输出", "字段"]
                .iter()
                .any(|s| t.contains(s)))
}
fn code_occurrence(text: &str, term: &str) -> bool {
    let lower = text.to_lowercase();
    let term = term.to_lowercase();
    let matches: Vec<_> = lower.match_indices(&term).collect();
    !matches.is_empty()
        && matches.iter().all(|(at, _)| {
            let before = &lower[..*at];
            let after = &lower[*at + term.len()..];
            before
                .chars()
                .next_back()
                .is_some_and(|c| matches!(c, '/' | '_' | '.' | '`' | '-'))
                || after.starts_with(['/', '_', '`', '-'])
                || [".md", ".json", ".py", ".rs", ".ts", ".wav"]
                    .iter()
                    .any(|ext| after.starts_with(ext))
                || before
                    .split_whitespace()
                    .next_back()
                    .is_some_and(|s| s.contains("://"))
        })
}
fn lexical_match(text: &str, term: &str) -> bool {
    if !literal_contains(text, term) {
        return false;
    }
    if term.is_ascii() {
        return true;
    }
    static SEGMENTER: LazyLock<Jieba> = LazyLock::new(Jieba::new);
    let lower = text.to_lowercase();
    let tokens = SEGMENTER.cut(&lower, false);
    let starts: BTreeSet<_> = tokens.iter().map(|t| t.byte_start).collect();
    let ends: BTreeSet<_> = tokens.iter().map(|t| t.byte_end).collect();
    lower
        .match_indices(&term.to_lowercase())
        .any(|(at, _)| starts.contains(&at) && ends.contains(&(at + term.len())))
}
pub fn mention_context(text: &str, term: &str) -> bool {
    prose(text) && lexical_match(text, term) && !code_occurrence(text, term)
}
fn operation(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    [
        "run ",
        "fix ",
        "install ",
        "restart ",
        "reboot ",
        "update ",
        "please update ",
        "please install ",
        "change ",
        "git ",
        "npm ",
        "cargo ",
    ]
    .iter()
    .any(|p| t.starts_with(p))
        || [
            "重启",
            "升级",
            "禁用",
            "启用",
            "部署",
            "编译",
            "打包",
            "切换分支",
            "评审意见",
            "代码已经修改",
            "调试通过",
            "截图",
            "改下",
            "请修复",
            "不允许",
            "请忘掉",
            "不要包含",
            "请删除",
            "请隐藏",
            "重新生成",
            "去掉",
            "重连",
            "连接不上",
            "加载成功",
            "只回复",
            "白盒门禁",
            "ci白盒",
            "门禁",
            "完成协议协商",
        ]
        .iter()
        .any(|p| t.contains(p))
}
fn placeholder(term: &str) -> bool {
    // Referential language: these heads point at an unspecified object or
    // answer; a direct definition can still discuss the head as a concept.
    [
        "事情", "东西", "意思", "方面", "情况", "答案", "结论", "证据", "全书", "全文", "本书",
        "本文",
    ]
    .contains(&term)
}
fn explicit_concept(text: &str, term: &str) -> bool {
    [
        format!("什么是{term}"),
        format!("{term}是什么"),
        format!("{term}的定义"),
        format!("{term}这一概念"),
        format!("理解{term}"),
        format!("研究{term}"),
    ]
    .iter()
    .any(|p| text.contains(p))
}
/// A discussion is local to the term's clause. Formatting requests, operation
/// instructions and field names cannot borrow 'research' from elsewhere.
pub fn concept_context(text: &str, term: &str) -> bool {
    if !prose(text)
        || operation(text)
        || !lexical_match(text, term)
        || code_occurrence(text, term)
        || text.contains("图片")
            && ["修改", "调整", "放大", "缩小", "生成", "背景"]
                .iter()
                .any(|s| text.contains(s))
    {
        return false;
    }
    let term = term.to_lowercase();
    // Parenthetical glosses do not interrupt the surrounding syntactic role.
    static PAREN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"（[^（）]*）|\([^()]*\)").unwrap());
    static POSSESSIVE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?:保护|呵护|提高|提升|保持|增强|影响|理解|关注|对齐)(?:[\p{Han}]{1,8}的)?$")
            .unwrap()
    });
    static ENUM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:[、和与及][\p{Han}A-Za-z]{2,12})*(?:等(?:领域|学科|概念)|(?:则)?(?:是|在|是在)研究)").unwrap()
    });
    let text = PAREN.replace_all(text, "");
    text.split(". ")
        .flat_map(|s| s.split_inclusive(['。', '！', '？', '!', '?', '；', ';', '，', ',']))
        .any(|clause| {
            if !literal_contains(clause, &term) || operation(clause) {
                return false;
            }
            if placeholder(&term) && !explicit_concept(clause, &term) {
                return false;
            }
            if clause.contains(&format!("{term}专家")) || clause.contains(&format!("{term}助手"))
            {
                return false;
            }
            if [
                "格式", "输出", "正文", "标题", "写成", "文件", "目录", "保存", "排版",
            ]
            .iter()
            .any(|s| clause.contains(s))
                && !explicit_concept(clause, &term)
            {
                return false;
            }
            let lower = clause.to_lowercase();
            lower.match_indices(&term).any(|(start, _)| {
                let before = lower[..start].trim_end();
                let after = lower[start + term.len()..].trim_start();
                if POSSESSIVE.is_match(before) {
                    return true;
                }
                if before.ends_with("科学的")
                    && ["工作方式", "实践", "方法"]
                        .iter()
                        .any(|p| after.starts_with(p))
                {
                    return true;
                }
                let short_after: String = after.chars().take(20).collect();
                if ENUM.is_match(after)
                    || ["的作用", "的价值", "的意义", "的重要性"]
                        .iter()
                        .any(|p| after.starts_with(p))
                    || after.starts_with('对')
                        && ["的重要性", "的作用", "的价值", "的意义"]
                            .iter()
                            .any(|p| short_after.contains(p))
                {
                    return true;
                }
                let applied = ["以", "基于", "利用", "运用", "结合", "从"]
                    .iter()
                    .any(|v| before.ends_with(v));
                if applied
                    && ["视角", "角度", "的机制", "理论", "原理"]
                        .iter()
                        .any(|v| after.starts_with(v))
                {
                    return true;
                }
                let prefix = before
                    .trim_end_matches("一下")
                    .trim_end_matches("这个")
                    .trim_end_matches("有关")
                    .trim_end_matches("关于");
                if [
                    "什么是",
                    "为什么",
                    "为何",
                    "理解",
                    "研究",
                    "解释",
                    "比较",
                    "分析",
                    "讨论",
                    "认识",
                    "学习",
                    "关注",
                ]
                .iter()
                .any(|v| prefix.ends_with(v))
                {
                    return true;
                }
                if [
                    "是什么",
                    "是一种",
                    "是指",
                    "定义为",
                    "为什么",
                    "为何",
                    "如何",
                    "怎样",
                    "意味着",
                    "属于",
                    "依赖",
                    "取决于",
                    "影响",
                    "决定",
                    "导致",
                    "包含",
                    "构成",
                    "解释",
                    "帮助",
                    "增强",
                    "抑制",
                    "降低",
                    "提高",
                    "会影响",
                    "能够",
                    "可以",
                    "有助于",
                    "的定义",
                    "的原理",
                    "的机制",
                    "之间的关系",
                    "的关系",
                    "之间的区别",
                    "相关",
                    "具有",
                    "值得",
                ]
                .iter()
                .any(|v| after.starts_with(v))
                {
                    return true;
                }
                let object_prefix = before
                    .trim_end_matches("人的")
                    .trim_end_matches("人类的")
                    .trim_end_matches('了');
                if [
                    "影响",
                    "是一种",
                    "是指",
                    "定义为",
                    "依赖",
                    "取决于",
                    "增强",
                    "抑制",
                    "降低",
                    "提高",
                    "保护",
                    "解释",
                    "模拟",
                    "模仿",
                    "改变",
                    "辅助",
                    "关注",
                ]
                .iter()
                .any(|v| object_prefix.ends_with(v))
                {
                    return true;
                }
                let close_before: String = before
                    .chars()
                    .rev()
                    .take(12)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                if before.ends_with(['和', '与', '及', '、'])
                    && ["影响", "增强", "抑制", "改变", "保护", "关注"]
                        .iter()
                        .any(|v| close_before.contains(v))
                {
                    return true;
                }
                let close_after: String = after.chars().take(20).collect();
                if before.ends_with(['与', '和', '及', '跟'])
                    && ["关系", "区别", "差异", "相关", "比较"]
                        .iter()
                        .any(|v| close_after.contains(v))
                {
                    return true;
                }
                if after.starts_with(['与', '和', '及', '跟'])
                    && ["关系", "区别", "差异", "相同", "不同", "影响", "比较"]
                        .iter()
                        .any(|v| close_after.contains(v))
                {
                    return true;
                }
                if ["以", "用", "运用", "基于"]
                    .iter()
                    .any(|v| before.ends_with(v))
                    && ["分析", "解释", "推导", "思考", "判断", "理解", "建模"]
                        .iter()
                        .any(|v| after.trim_start_matches('来').starts_with(v))
                {
                    return true;
                }
                if [
                    "是研究",
                    "在研究",
                    "则是在研究",
                    "主要研究",
                    "是解释",
                    "是模拟",
                ]
                .iter()
                .any(|v| after.starts_with(v))
                {
                    return true;
                }
                if [
                    "what is",
                    "what are",
                    "understand",
                    "explain",
                    "compare",
                    "why is",
                    "why does",
                    "how does",
                    "how can",
                ]
                .iter()
                .any(|v| before.ends_with(v))
                {
                    return true;
                }
                [
                    "is a ",
                    "refers to ",
                    "depends on ",
                    "affects ",
                    "consists of ",
                    "influences ",
                    "helps ",
                    "causes ",
                ]
                .iter()
                .any(|v| after.starts_with(v))
            })
        })
}

fn direct_term_request(text: &str, term: &str) -> bool {
    let lower = text.to_lowercase();
    let term = term.to_lowercase();
    lower.match_indices(&term).any(|(at, _)| {
        let before = lower[..at].trim_end();
        let after = lower[at + term.len()..].trim_start();
        if before.ends_with(['与', '和', '及', '跟'])
            && ["之间的关系", "的关系", "之间的区别", "的区别"]
                .iter()
                .any(|p| after.starts_with(p))
        {
            return true;
        }
        let nearby_before: String = before
            .chars()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        [
            "什么是",
            "为什么",
            "为何",
            "理解",
            "解释",
            "比较",
            "分析",
            "讨论",
            "what is",
            "why is",
            "explain",
            "understand",
            "compare",
        ]
        .iter()
        .any(|p| before.ends_with(p))
            || nearby_before.contains("为什么")
                && ["能够", "有助于", "可以", "会"]
                    .iter()
                    .any(|p| after.starts_with(p))
            || [
                "是什么",
                "的定义",
                "是一种",
                "是指",
                "定义为",
                "is a ",
                "refers to ",
            ]
            .iter()
            .any(|p| after.starts_with(p))
    })
}
fn nominal_candidate(term: &str, jieba: &Jieba) -> bool {
    let tags = jieba.tag(term, false);
    tags.last().is_some_and(|t| {
        matches!(
            t.tag,
            "n" | "ng" | "nz" | "nt" | "ns" | "nr" | "l" | "eng" | "vn" | "an"
        )
    })
}
fn contextual_class(text: &str, term: &str, jieba: &Jieba) -> Option<TermClass> {
    if text.contains(&format!("《{term}》")) {
        return Some(TermClass::Resource);
    }
    let lower = text.to_lowercase();
    let name = term.to_lowercase();
    if lower.contains(&format!("{name}.app")) || lower.contains(&format!("{name}app")) {
        return Some(TermClass::Tool);
    }
    let tags = jieba.tag(term, false);
    if tags.len() == 1
        && tags[0].tag == "ns"
        && text.match_indices(term).any(|(at, _)| {
            let after: String = text[at + term.len()..].chars().take(12).collect();
            let before = &text[..at];
            ["文化", "国家", "城市", "当地", "社会"]
                .iter()
                .any(|p| after.contains(p))
                || ["前往", "来自", "位于", "住在"]
                    .iter()
                    .any(|p| before.ends_with(p))
        })
    {
        return Some(TermClass::Entity);
    }
    let normalized = normalize(term);
    let low = normalize(text);
    let exact_token_end = jieba
        .tag(text, false)
        .iter()
        .any(|tag| text[..tag.byte_end].to_lowercase().ends_with(&normalized));
    if [
        format!("安装{normalized}"),
        format!("重启{normalized}"),
        format!("升级{normalized}"),
        format!("reboot {normalized}"),
        format!("restart {normalized}"),
        format!("install {normalized}"),
        format!("update {normalized}"),
    ]
    .iter()
    .any(|p| low.replace(' ', "").contains(&p.replace(' ', "")))
        && exact_token_end
    {
        return Some(TermClass::Tool);
    }
    if [
        format!("{term}是一款软件"),
        format!("{term}是一款应用"),
        format!("{term}是一个工具"),
        format!("{term}是一款工具"),
    ]
    .iter()
    .any(|p| text.contains(p))
    {
        return Some(TermClass::Tool);
    }
    let person_shape = jieba
        .tag(term, false)
        .iter()
        .any(|t| t.tag.starts_with("nr"))
        || term.ends_with(['哥', '姐'])
        || (term.is_ascii() && term.chars().next().is_some_and(char::is_uppercase));
    if person_shape
        && [
            format!("{term}说"),
            format!("{term}告诉"),
            format!("和{term}"),
            format!("{term}提到"),
            format!("同事{term}"),
            format!("{term}先生"),
            format!("{term}老师"),
        ]
        .iter()
        .any(|p| text.contains(p))
    {
        return Some(TermClass::Person);
    }
    if [
        format!("{term}说"),
        format!("{term}告诉"),
        format!("同事{term}"),
        format!("{term}先生"),
        format!("{term}老师"),
    ]
    .iter()
    .any(|p| text.contains(p))
    {
        return Some(TermClass::Entity);
    }
    None
}
/// Original C-value: log2(token length) times frequency minus mean frequency
/// of longer candidate terms containing the candidate. All f() count distinct
/// events in one corpus; single-token terms deliberately use another channel.
pub fn c_values(
    tokens: &BTreeMap<String, Vec<String>>,
    frequencies: &BTreeMap<String, usize>,
) -> BTreeMap<String, f64> {
    let mut by_tokens: BTreeMap<Vec<String>, Vec<&String>> = BTreeMap::new();
    for (term, parts) in tokens {
        if frequencies.get(term).copied().unwrap_or(0) > 0 {
            by_tokens.entry(parts.clone()).or_default().push(term);
        }
    }
    let mut nested: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for (longer, parts) in tokens {
        let frequency = frequencies.get(longer).copied().unwrap_or(0);
        if frequency == 0 {
            continue;
        }
        let mut contained = BTreeSet::new();
        for length in 1..parts.len() {
            for window in parts.windows(length) {
                if let Some(terms) = by_tokens.get(window) {
                    contained.extend(terms.iter().map(|s| (*s).clone()));
                }
            }
        }
        for term in contained {
            let entry = nested.entry(term).or_default();
            entry.0 += frequency;
            entry.1 += 1;
        }
    }
    tokens
        .iter()
        .map(|(term, parts)| {
            let f = *frequencies.get(term).unwrap_or(&0) as f64;
            let nested = nested
                .get(term)
                .map(|(sum, count)| *sum as f64 / *count as f64)
                .unwrap_or(0.);
            (
                term.clone(),
                if parts.len() > 1 {
                    (parts.len() as f64).log2() * (f - nested)
                } else {
                    0.
                },
            )
        })
        .collect()
}
/// Candidate spans from the full trusted corpus, not only existing wiki names.
/// Candidate generation is permissive; every output still passes assessment.
pub fn candidate_terms(events: &[UserEvent]) -> BTreeMap<String, String> {
    let jieba = Jieba::new();
    let mut candidates: BTreeMap<String, (String, BTreeSet<String>)> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for event in events {
        if !seen.insert((event.event_id.clone(), normalize(&event.text)))
            || !prose(&event.text)
            || operation(&event.text)
        {
            continue;
        }
        let tags = jieba.tag(&event.text, true);
        for (i, tag) in tags.iter().enumerate() {
            if !matches!(
                tag.tag,
                "n" | "ng" | "nz" | "nt" | "vn" | "an" | "eng" | "l"
            ) || !surface_allowed(tag.word)
                || crate::focus::phrase_operator(tag.word)
            {
                continue;
            }
            let mut spans = vec![tag.word];
            let mut last = tag.byte_end;
            if tag.tag != "l" {
                for next in tags.iter().skip(i + 1).take(2) {
                    if crate::focus::phrase_operator(next.word)
                        || !matches!(next.tag, "n" | "ng" | "nz" | "nt" | "vn" | "an" | "eng")
                        || !event.text[last..next.byte_start].trim().is_empty()
                    {
                        break;
                    }
                    let span = &event.text[tag.byte_start..next.byte_end];
                    if span.chars().count() <= 24 && surface_allowed(span) {
                        spans.push(span);
                    }
                    last = next.byte_end;
                }
            }
            for span in spans {
                if code_occurrence(&event.text, span) || !concept_context(&event.text, span) {
                    continue;
                }
                let key = normalize(span);
                let item = candidates
                    .entry(key)
                    .or_insert_with(|| (span.into(), BTreeSet::new()));
                item.1.insert(event.event_id.clone());
            }
        }
    }
    candidates
        .into_iter()
        .filter(|(_, (_, events))| events.len() >= 2)
        .map(|(key, (label, _))| (key, label))
        .collect()
}
pub fn deduplicate_events(mut events: Vec<UserEvent>) -> Vec<UserEvent> {
    let mut bodies: BTreeMap<String, (String, BTreeSet<String>)> = BTreeMap::new();
    for event in &events {
        let entry = bodies
            .entry(event.event_id.clone())
            .or_insert_with(|| (event.date.clone(), BTreeSet::new()));
        entry.1.insert(normalize(&event.text));
    }
    let identities: BTreeMap<_, _> = bodies
        .into_iter()
        .map(|(id, (date, lines))| {
            (
                id,
                format!(
                    "event:{}",
                    &crate::hash(format!(
                        "{date}\0{}",
                        lines.into_iter().collect::<Vec<_>>().join("\n")
                    ))[..24]
                ),
            )
        })
        .collect();
    for event in &mut events {
        event.event_id = identities[&event.event_id].clone();
    }
    events.sort_by(|a, b| {
        (&a.event_id, &a.path, a.start, &a.text).cmp(&(&b.event_id, &b.path, b.start, &b.text))
    });
    let mut seen = BTreeSet::new();
    events.retain(|e| seen.insert((e.event_id.clone(), normalize(&e.text))));
    events
}
pub fn assess_terms(
    events: &[UserEvent],
    vocabulary: &BTreeMap<String, String>,
    hints: &BTreeMap<String, String>,
) -> BTreeMap<String, TermAssessment> {
    let jieba = Jieba::new();
    let accepted: Vec<_> = vocabulary
        .iter()
        .filter(|(key, label)| {
            surface_allowed(label)
                || hints
                    .get(*key)
                    .is_some_and(|h| h == "project" || h == "strong_context")
        })
        .collect();
    if accepted.is_empty() {
        return BTreeMap::new();
    }
    let nominal: Vec<_> = accepted
        .iter()
        .map(|(_, label)| nominal_candidate(label, &jieba))
        .collect();
    let patterns = AhoCorasick::new(accepted.iter().map(|(key, _)| key.as_str()))
        .expect("bounded literal vocabulary");
    let mut literal_support: BTreeMap<usize, BTreeSet<&str>> = BTreeMap::new();
    for event in events {
        for m in patterns.find_overlapping_iter(&event.text.to_lowercase()) {
            literal_support
                .entry(m.pattern().as_usize())
                .or_default()
                .insert(&event.event_id);
        }
    }
    #[derive(Default)]
    struct Stats {
        all: BTreeSet<String>,
        concept: BTreeSet<String>,
        background: BTreeSet<String>,
        direct: bool,
        types: BTreeMap<&'static str, usize>,
    }
    let mut stats: BTreeMap<String, Stats> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for e in events {
        if !seen.insert((e.event_id.clone(), normalize(&e.text))) || !prose(&e.text) {
            continue;
        }
        let text = e.text.to_lowercase();
        let spans: Vec<_> = patterns
            .find_overlapping_iter(&text)
            .filter(|m| literal_contains(&e.text, accepted[m.pattern().as_usize()].1))
            .collect();
        let matches: BTreeSet<_> = spans.iter().map(|m| m.pattern().as_usize()).collect();
        for i in matches {
            let (key, label) = accepted[i];
            let entry = stats.entry(key.clone()).or_default();
            // Explicit software/file identity can inform background typing even
            // when that code occurrence is ineligible as conceptual attention.
            if let Some(kind) = contextual_class(&e.text, label, &jieba) {
                *entry.types.entry(kind.node_type()).or_default() += 1;
            }
            if !lexical_match(&e.text, label) || code_occurrence(&e.text, label) {
                continue;
            }
            entry.all.insert(e.event_id.clone());
            let independent = spans
                .iter()
                .filter(|m| m.pattern().as_usize() == i)
                .any(|span| {
                    !spans.iter().any(|other| {
                        other.pattern() != span.pattern()
                            && other.start() <= span.start()
                            && other.end() >= span.end()
                            && other.end() - other.start() > span.end() - span.start()
                            && nominal[other.pattern().as_usize()]
                            && (literal_support
                                .get(&other.pattern().as_usize())
                                .is_some_and(|s| s.len() >= 2)
                                || direct_term_request(
                                    &e.text,
                                    accepted[other.pattern().as_usize()].1,
                                ))
                            && concept_context(&e.text, accepted[other.pattern().as_usize()].1)
                    })
                });
            if e.signal != "submitted_material" && independent && concept_context(&e.text, label) {
                entry.concept.insert(e.event_id.clone());
                entry.direct |= direct_term_request(&e.text, label);
            } else {
                entry.background.insert(e.event_id.clone());
            }
        }
    }
    let tokens: BTreeMap<_, _> = accepted
        .iter()
        .map(|(key, _)| {
            (
                (*key).clone(),
                jieba
                    .cut(key, false)
                    .into_iter()
                    .filter(|t| t.word.chars().any(char::is_alphabetic))
                    .map(|t| t.word.to_string())
                    .collect(),
            )
        })
        .collect();
    let frequencies = stats
        .iter()
        .map(|(key, s)| (key.clone(), s.all.len()))
        .collect();
    let values = c_values(&tokens, &frequencies);
    accepted
        .into_iter()
        .filter_map(|(key, label)| {
            let s = stats.remove(key).unwrap_or_default();
            let hint = hints.get(key).map(String::as_str).unwrap_or("");
            let class = if matches!(hint, "project" | "strong_context") {
                TermClass::Project
            } else if matches!(hint, "person" | "tool" | "resource") {
                match hint {
                    "person" => TermClass::Person,
                    "tool" => TermClass::Tool,
                    _ => TermClass::Resource,
                }
            } else if s.types.contains_key("resource") && s.types["resource"] > s.concept.len() {
                TermClass::Resource
            } else if s.types.contains_key("person") && s.types["person"] >= 2 {
                TermClass::Person
            } else if s.types.contains_key("tool")
                && (s.concept.is_empty() || s.types["tool"] >= s.concept.len().max(1))
            {
                TermClass::Tool
            } else if s.types.get("entity").copied().unwrap_or(0) >= 2
                || s.types.contains_key("entity") && {
                    let tags = jieba.tag(label, false);
                    tags.len() == 1 && tags[0].tag == "ns"
                }
            {
                TermClass::Entity
            } else if !s.concept.is_empty()
                && surface_allowed(label)
                && nominal_candidate(label, &jieba)
                && (tokens[key].len() == 1 || s.concept.len() >= 2 || s.direct)
            {
                TermClass::Keyword
            } else if hint == "entity" {
                TermClass::Entity
            } else {
                TermClass::Candidate
            };
            if s.all.is_empty() && class != TermClass::Project {
                return None;
            }
            Some((
                key.clone(),
                TermAssessment {
                    class,
                    c_value: *values.get(key).unwrap_or(&0.),
                    token_length: tokens[key].len(),
                    frequency: s.all.len(),
                    concept_events: s.concept,
                    background_events: s.background,
                },
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(id: &str, date: &str, text: &str) -> UserEvent {
        UserEvent {
            path: format!("agent-sessions/{id}.md"),
            date: date.into(),
            start: 10,
            end: 10,
            text: text.into(),
            event_id: id.into(),
            signal: "agent_user".into(),
            date_basis: "same_day_session".into(),
            inquiry: true,
        }
    }
    fn assess(texts: &[&str], terms: &[&str]) -> BTreeMap<String, TermAssessment> {
        let events: Vec<_> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| event(&i.to_string(), "2026-10-01", t))
            .collect();
        let vocabulary = terms
            .iter()
            .map(|t| (normalize(t), t.to_string()))
            .collect();
        assess_terms(&events, &vocabulary, &BTreeMap::new())
    }
    #[test]
    fn original_cvalue_uses_token_length_and_average_nested_frequency() {
        let tokens = BTreeMap::from([
            (
                "memory system".into(),
                vec!["memory".into(), "system".into()],
            ),
            (
                "episodic memory system".into(),
                vec!["episodic".into(), "memory".into(), "system".into()],
            ),
            (
                "artificial memory system".into(),
                vec!["artificial".into(), "memory".into(), "system".into()],
            ),
            ("心理学".into(), vec!["心理学".into()]),
        ]);
        let f = BTreeMap::from([
            ("memory system".into(), 10),
            ("episodic memory system".into(), 4),
            ("artificial memory system".into(), 2),
            ("心理学".into(), 12),
        ]);
        let values = c_values(&tokens, &f);
        assert_eq!(values["memory system"], 7.);
        assert!((values["episodic memory system"] - 4. * 3f64.log2()).abs() < 1e-9);
        assert_eq!(values["心理学"], 0.);
    }
    #[test]
    fn single_token_concepts_have_an_independent_context_channel() {
        let a = assess(&["为什么心理学能够解释记忆？"], &["心理学", "记忆"]);
        assert_eq!(a["心理学"].class, TermClass::Keyword);
        assert_eq!(a["记忆"].class, TermClass::Keyword);
        assert_eq!(a["心理学"].c_value, 0.);
    }
    #[test]
    fn function_words_fields_paths_and_commands_cannot_borrow_concept_status() {
        let a = assess(
            &[
                "\"title\": \"架构研究\"",
                "Please update the tool.",
                "请按 references/job-story.schema.json 输出字段。",
            ],
            &["the", "title", "架构", "Story"],
        );
        assert!(!a.contains_key("the"));
        assert!(!a.contains_key("title"));
        assert!(!a.values().any(|x| x.class == TermClass::Keyword));
    }
    #[test]
    fn using_a_concept_does_not_make_it_a_tool_or_person() {
        let a = assess(
            &[
                "为什么使用第一性原理能够帮助决策？",
                "如何使用概率论解释不确定性？",
                "为什么体验情绪有助于理解记忆？",
                "AI工具如何帮助人保护能动性？",
            ],
            &["第一性原理", "概率论", "情绪", "AI"],
        );
        for term in ["第一性原理", "概率论", "情绪"] {
            assert_eq!(a[term].class, TermClass::Keyword, "{term}");
        }
        assert_ne!(a["ai"].class, TermClass::Tool);
    }
    #[test]
    fn explicit_background_evidence_and_project_metadata_keep_real_types() {
        let events = vec![
            event("a", "2026-10-01", "Orbit是一款应用。请重启 Orbit。"),
            event("b", "2026-10-02", "林舟说他要理解决策。"),
            event("c", "2026-10-01", "林舟告诉我他关注记忆。"),
            event("d", "2026-10-02", "请阅读《量子世界》。"),
        ];
        let vocabulary = ["Orbit", "林舟", "量子世界"]
            .into_iter()
            .map(|s| (normalize(s), s.into()))
            .collect();
        let a = assess_terms(&events, &vocabulary, &BTreeMap::new());
        assert_eq!(a["orbit"].class, TermClass::Tool);
        assert!(matches!(
            a["林舟"].class,
            TermClass::Person | TermClass::Entity
        ));
        assert_eq!(a["量子世界"].class, TermClass::Resource);
        let a = assess_terms(
            &events,
            &vocabulary,
            &BTreeMap::from([("orbit".into(), "project".into())]),
        );
        assert_eq!(a["orbit"].class, TermClass::Project);
    }
    #[test]
    fn exact_same_day_copies_do_not_buy_frequency_but_cross_day_revisits_survive() {
        let events = deduplicate_events(vec![
            event("a", "2026-10-01", "为什么工作记忆影响决策？"),
            event("copy", "2026-10-01", "为什么工作记忆影响决策？"),
            event("revisit", "2026-10-02", "为什么工作记忆影响决策？"),
        ]);
        assert_eq!(events.len(), 2);
        assert_ne!(events[0].event_id, events[1].event_id);
        let vocab = BTreeMap::from([("工作记忆".into(), "工作记忆".into())]);
        let a = assess_terms(&events, &vocab, &BTreeMap::new());
        assert_eq!(a["工作记忆"].frequency, 2);
    }
    #[test]
    fn an_english_fragment_is_not_promoted_by_its_complete_term() {
        let a = assess(
            &[
                "Why is job story useful?",
                "How does job story explain a need?",
            ],
            &["job story", "Story"],
        );
        assert_eq!(a["job story"].class, TermClass::Keyword);
        assert_eq!(a["story"].class, TermClass::Candidate);
    }
    #[test]
    fn fragments_need_independent_occurrences() {
        assert!(!mention_context("安装客户端", "客户"));
        assert!(mention_context("研究客户端", "客户端"));
        let a = assess(&["请理解第一性原理。"], &["第一性", "第一性原理"]);
        assert_ne!(a["第一性"].class, TermClass::Keyword);
        let b = assess(&["讨论第二性的定义。"], &["第二性"]);
        assert_eq!(b["第二性"].class, TermClass::Keyword);
    }
    #[test]
    fn reviewed_local_arguments_and_coordination_survive() {
        for (text, terms) in [
            (
                "列出记忆对人类的重要性，以及情绪如何影响记忆",
                vec!["记忆", "情绪"],
            ),
            (
                "涉足到使用者的学习、注意力、记忆等领域",
                vec!["注意力", "记忆"],
            ),
            (
                "认知心理学、认知神经科学则是在研究原理",
                vec!["认知心理学", "认知神经科学"],
            ),
            (
                "利用认知心理学（专业技能等）的机制解释一下why",
                vec!["认知心理学"],
            ),
            ("我是个做生产力软件的，提高人的生产力", vec!["生产力"]),
            ("以认知心理学视角分析决策", vec!["认知心理学", "决策"]),
            ("如何保护员工的能动性", vec!["能动性"]),
            (
                "我期望以认知心理学的理论依据设计新的协作方式。以对齐生产力",
                vec!["生产力"],
            ),
            (
                "人+AI协作工作，需要怎样才能保持生产力正向提升",
                vec!["生产力"],
            ),
            ("请根据全书内容给我科学的生产力工作方式", vec!["生产力"]),
        ] {
            for term in terms {
                assert!(concept_context(text, term), "{text}: {term}");
            }
        }
        for (text, term) in [
            ("CI白盒门禁需要覆盖iPhone，解释原因", "iPhone"),
            ("请重连tailscale客户端", "客户端"),
            ("斧头按图2的形状改变", "形状"),
            ("以 Apple 表达风格", "Apple"),
            ("请把服务端连不通作为重连标准", "服务端"),
            ("把需要的字体打包放在服务端，在用户点击时下载", "服务端"),
            ("使用内置的MCP客户端或官方SDK完成协议协商", "客户端"),
            ("https://example.com/apple?tag=AI", "apple"),
        ] {
            assert!(!concept_context(text, term), "{text}: {term}");
        }
    }
    #[test]
    fn noun_phrase_endings_identifiers_hyphens_and_places_have_separate_gates() {
        let a = assess(&["因研究心理学结实老朋友。"], &["心理学结实", "心理学"]);
        assert_ne!(a["心理学结实"].class, TermClass::Keyword);
        assert_eq!(a["心理学"].class, TermClass::Keyword);
        assert!(!surface_allowed("router用户"));
        assert!(surface_allowed("AI协作"));
        assert!(surface_allowed("llm推理"));
        assert!(!mention_context("无需依赖 pi-bridge 服务", "Pi"));
        assert!(mention_context("讨论 pi-bridge 的用途", "pi-bridge"));
        let place = assess(&["深度分析一下日本猜空气文化。"], &["日本", "日本文化"]);
        assert_eq!(place["日本"].class, TermClass::Entity);
        let culture = assess(&["理解日本文化的机制。"], &["日本文化"]);
        assert_eq!(culture["日本文化"].class, TermClass::Keyword);
        let app = assess(
            &["请继续研究星图", "参考/Applications/星图.app的交互。"],
            &["星图"],
        );
        assert_eq!(app["星图"].class, TermClass::Tool);
    }
}
