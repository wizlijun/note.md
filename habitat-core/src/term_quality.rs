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
    /// Proven malformed/discourse-only terms are removed, not demoted to background.
    pub rejected: bool,
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
/// Naming a term deliberately is stronger than requesting an unspecified
/// answer with "X是什么". Used only to preserve explicit metalinguistic uses.
fn named_term_context(text: &str, term: &str) -> bool {
    let text = text.to_lowercase();
    let term = term.to_lowercase();
    [
        format!("什么是{term}"),
        format!("{term}的定义"),
        format!("{term}这一概念"),
        format!("{term}这个术语"),
        format!("{term}是指"),
        format!("{term}定义为"),
        format!("what is {term}"),
        format!("{term} refers to "),
    ]
    .iter()
    .any(|p| text.contains(p))
}
/// Closed-class discourse modifiers plus an unresolved relational head are
/// an answer slot, not a domain noun phrase. Domain modifiers/heads such as
/// "可能世界", "原因分析" and "随机变量" are not covered by this pattern.
fn discourse_phrase(term: &str) -> bool {
    static DISCOURSE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"^(?:可能|主要|具体|相关|当前|实际|潜在|根本|关键|后续|发展|这个|那个|这些|那些|一些|其他|各种|上述|以下|本次|这次|所有|任何)*(?:的)?(?:原因|情况|方面|事情|内容|问题|结果|答案|特点|意思|因素|条件|水平|机制|作用|价值|意义|指标)$"
    ).unwrap()
    });
    DISCOURSE.is_match(term)
}
fn discourse_slot_use(text: &str, term: &str) -> bool {
    if !discourse_phrase(term) {
        return false;
    }
    let text = text.to_lowercase();
    let term = term.to_lowercase();
    text.split(['。', '？', '?', '！', '!', '；', ';', '\n'])
        .any(|clause| {
            clause.match_indices(&term).any(|(at, _)| {
                let before = clause[..at].trim_end();
                let after = clause[at + term.len()..].trim_start();
                (before.trim_start_matches(['-', '#', ' ']).is_empty() && after.is_empty())
                    || after.starts_with([':', '：'])
                    || ["是什么", "有哪些", "如何", "怎样", "怎么样"]
                        .iter()
                        .any(|p| after.starts_with(p))
                    || [
                        "分析", "说明", "介绍", "给出", "解释", "列出", "总结", "概括", "提供",
                        "调查", "检查", "填写", "描述",
                    ]
                    .iter()
                    .any(|p| {
                        before
                            .trim_end_matches("一下")
                            .trim_end_matches('的')
                            .ends_with(p)
                    })
            })
        })
}
fn instruction_phrase(term: &str) -> bool {
    static JIEBA: LazyLock<Jieba> = LazyLock::new(Jieba::new);
    static COPULA: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:这|那|这些|那些|它|它们|他们|我们|我)(?:是|有|会|正在)").unwrap()
    });
    if COPULA.is_match(term) {
        return true;
    }
    let tags = JIEBA.tag(term, false);
    let Some(first) = tags.first() else {
        return false;
    };
    let Some(last) = tags.last() else {
        return false;
    };
    if tags.len() < 2 {
        return false;
    }
    if tags
        .iter()
        .any(|tag| tag.tag == "v" && ["有", "是"].contains(&tag.word))
    {
        return true;
    }
    if !first.tag.starts_with('v') {
        return false;
    }
    // A verb applied to a named ASCII object or a generic output artifact
    // must not be concatenated into a purported noun phrase.
    (first.word.chars().any(|c| !c.is_ascii()) && last.tag == "eng")
        || [
            "文档", "文件", "代码", "目录", "页面", "正文", "报告", "脚本", "输出",
        ]
        .contains(&last.word)
}
// The subject of a quantity evaluation or a concrete execution lookup is
// a whole situation/value slot. Its final noun cannot borrow "是什么".
fn value_slot_use(text: &str, term: &str) -> bool {
    static QUANTITY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[0-9]+(?:\.[0-9]+)?\s*[\p{Han}]{0,3}$").unwrap());
    static IDENTIFIER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[a-z][a-z0-9_-]*\s*$").unwrap());
    let text = text.to_lowercase();
    let term = term.to_lowercase();
    text.split(['。', '？', '?', '！', '!', '；', ';', '\n'])
        .any(|clause| {
            clause.match_indices(&term).any(|(at, _)| {
                let before = clause[..at].trim_end();
                let after = clause[at + term.len()..].trim_start();
                if QUANTITY.is_match(before)
                    && ["是什么水平", "是什么程度", "算什么水平", "算什么程度"]
                        .iter()
                        .any(|p| after.starts_with(p))
                {
                    return true;
                }
                if !["命令", "指令"].contains(&term.as_str()) {
                    return false;
                }
                let specific = IDENTIFIER.is_match(before.trim_end_matches('的').trim_end())
                    || ["运行", "执行", "导入", "刷新", "启动", "停止", "安装"]
                        .iter()
                        .any(|p| before.trim_end_matches('的').ends_with(p));
                specific
                    && ["是什么", "有哪些", "怎么", "如何", "为什么不能", "为何不能"]
                        .iter()
                        .any(|p| after.starts_with(p))
            })
        })
}
// In an imperative, the verb plus its object is not itself the concept.
// Keep the same spelling eligible when it is explicitly discussed as a term
// (e.g. 设计思维 / 优化算法), rather than banning those verbs globally.
fn requested_action_phrase(text: &str, term: &str) -> bool {
    static SEGMENTER: LazyLock<Jieba> = LazyLock::new(Jieba::new);
    let tags = SEGMENTER.tag(term, false);
    if tags.len() < 2
        || ![
            "设计", "改进", "优化", "开发", "实现", "采用", "看到", "描述", "指定",
        ]
        .contains(&tags[0].word)
    {
        return false;
    }
    text.match_indices(term).any(|(at, _)| {
        let before = text[..at].trim_end();
        ["请", "需要", "希望", "深度", "简要", "想要"]
            .iter()
            .any(|prefix| before.ends_with(prefix))
    })
}
fn phrase_integrity(text: &str, term: &str) -> bool {
    (!(discourse_slot_use(text, term)
        || instruction_phrase(term)
        || value_slot_use(text, term)
        || requested_action_phrase(text, term))
        || named_term_context(text, term))
        && lexical_match(text, term)
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
    lower.match_indices(&term.to_lowercase()).any(|(at, _)| {
        starts.contains(&at)
            && ends.contains(&(at + term.len()))
            && !lower[..at]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_digit())
    })
}
pub fn mention_context(text: &str, term: &str) -> bool {
    prose(text) && phrase_integrity(text, term) && !code_occurrence(text, term)
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
// A requested analytical persona is an instruction to the assistant, not an
// observation of interest in that persona's discipline. Test each occurrence
// so a later substantive use in the same clause can still qualify.
fn perspective_occurrence(before: &str, after: &str) -> bool {
    static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?:以|从|作为|扮演|你是)(?:一个|一名|专业的|资深的)?$|(?:from|as)(?: a| an)?\s*$",
        )
        .unwrap()
    });
    static EXPERTISE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^(?:的)?(?:[\p{Han}]{2,6}的)?(?:知识|经验)(?:帮我|帮助我|来)?(?:分析|解释|判断)",
        )
        .unwrap()
    });
    PREFIX.is_match(before)
        && (EXPERTISE.is_match(after)
            || [
                "视角",
                "角度",
                "专家",
                "学家",
                "科学家",
                "perspective",
                "expert",
            ]
            .iter()
            .any(|suffix| {
                after
                    .trim_start_matches('的')
                    .trim_start()
                    .starts_with(suffix)
            }))
}
// Practical investigation is not restricted to abstract 'why' questions.
// A complete noun phrase serving as the subject of an algorithm/process or
// requested design has the same status in any field. Bare UI/output nouns
// and operational verbs cannot inherit this admission.
fn applied_topic(before: &str, after: &str, term: &str) -> bool {
    static METHOD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:生成|提取|识别|匹配|检索|组织|分类)?的(?:算法|模型|机制|原理|流程|架构|策略|方法)").unwrap()
    });
    static SEGMENTER: LazyLock<Jieba> = LazyLock::new(Jieba::new);
    let tags = SEGMENTER.tag(term, false);
    let full_term = term.chars().count() >= 4
        // One ASCII identifier is more often the implementation/tool than
        // the concept being developed. It needs the existing direct inquiry
        // or explicit entity typing, not this compound-application shortcut.
        && (!term.is_ascii() || term.split_whitespace().count() > 1)
        && !discourse_phrase(term)
        && !instruction_phrase(term)
        && tags.iter().all(|tag| {
            matches!(
                tag.tag,
                "n" | "ng" | "nz" | "nt" | "ns" | "eng" | "vn" | "an" | "a" | "v" | "f"
            )
        });
    if !full_term {
        return false;
    }
    let application = METHOD.is_match(after)
        || ["设计", "改进", "优化", "开发", "实现", "采用"]
            .iter()
            .any(|verb| before.ends_with(verb))
            && (after.is_empty()
                || after.starts_with(['。', '，', '？', '?'])
                || ["的", "功能", "算法", "模型", "流程"]
                    .iter()
                    .any(|p| after.starts_with(p)));
    // Segmentation boundaries alone do not make a suffix a complete phrase:
    // 后/端云服务 and 模糊/时间解析 must retain their attached modifier. This
    // guard belongs only to the new application channel; explicit discussion
    // of a nested concept still uses the existing independent-context rules.
    application
        && !SEGMENTER.tag(before, false).last().is_some_and(|tag| {
            tag.byte_end == before.len()
                && matches!(tag.tag, "n" | "ng" | "nz" | "nt" | "ns" | "a" | "an" | "f")
        })
}
/// A discussion is local to the term's clause. Formatting requests, operation
/// instructions and field names cannot borrow 'research' from elsewhere.
pub fn concept_context(text: &str, term: &str) -> bool {
    if !prose(text)
        || !phrase_integrity(text, term)
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
            if !phrase_integrity(clause, &term) || operation(clause) {
                return false;
            }
            if placeholder(&term) && !explicit_concept(clause, &term) {
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
                if perspective_occurrence(before, after) {
                    return false;
                }
                if applied_concept_goal(clause, &term)
                    || applied_topic(before, after, &term)
                    || POSSESSIVE.is_match(before)
                {
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
                    && ["的机制", "理论", "原理"]
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

/// Strong nominal slots permit a verbal dictionary entry to name a domain or
/// capacity. This is syntactic nominalization, not a topic dictionary.
pub(crate) fn nominal_slot(text: &str, term: &str) -> bool {
    let lower = text.to_lowercase();
    let term = term.to_lowercase();
    static DOMAIN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:[、和与及][\p{Han}A-Za-z]{2,12})*等(?:领域|学科|概念)").unwrap()
    });
    lower.match_indices(&term).any(|(at, _)| {
        let before = lower[..at].trim_end();
        let after = lower[at + term.len()..].trim_start();
        DOMAIN.is_match(after) || before.ends_with("培养") && after.starts_with("的能力")
    })
}
/// A one-day seed must be the explicit object of inquiry, a named domain,
/// an applied conceptual goal, or an argument of a substantive causal claim.
/// It is an observed new focus, not evidence of long-term investment.
pub(crate) fn strong_seed_context(text: &str, term: &str) -> bool {
    if !concept_context(text, term)
        || [
            "溯源",
            "以下内容",
            "以下观点",
            "引用",
            "转述",
            "原文",
            "翻译",
            "海报",
            "作图",
        ]
        .iter()
        .any(|p| text.contains(p))
    {
        return false;
    }
    let lower = text.to_lowercase();
    let term = term.to_lowercase();
    static CAUSAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"^(?:[、和与及][\p{Han}A-Za-z]{2,12})*(?:(?:则|会|直接|显著|如何|怎样|能够|可以|是|在|是在))*?(?:影响|导致|决定|取决于|依赖|研究|是一种|是指|定义为)"
    ).unwrap()
    });
    if nominal_slot(text, &term) || applied_concept_goal(text, &term) {
        return true;
    }
    lower
        .split(['。', '！', '？', '!', '?', '；', ';', '，', ','])
        .any(|clause| {
            if !lexical_match(clause, &term) {
                return false;
            }
            clause.match_indices(&term).any(|(at, _)| {
                let before = clause[..at].trim_end();
                let after = clause[at + term.len()..].trim_start();
                let definition = before.ends_with("什么是")
                    || before.ends_with("定义")
                    || after.starts_with("的定义")
                    || after.starts_with("是指")
                    || after.starts_with("定义为");
                let beneficiary = before.ends_with('对');
                definition
                    || applied_topic(before, after, &term)
                    || CAUSAL.is_match(after)
                    || ["影响", "导致", "取决于", "依赖"]
                        .iter()
                        .any(|v| before.ends_with(v))
                    || (!beneficiary
                        && ["的作用", "的机制", "的重要性"]
                            .iter()
                            .any(|p| after.starts_with(p)))
            })
        })
}
fn applied_concept_goal(text: &str, term: &str) -> bool {
    let lower = text.to_lowercase();
    let term = term.to_lowercase();
    static GOAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"(?:呈现|提取|理解|研究)(?:当前)?(?:[a-zA-Z]{1,16}|[\p{Han}]{1,6})?(?:中的|的)?$|培养(?:[\p{Han}]{1,6}的)?$"
    ).unwrap()
    });
    lower.match_indices(&term).any(|(at, _)| {
        let before = lower[..at].trim_end();
        let after = lower[at + term.len()..].trim_start();
        before.ends_with("培养") && after.starts_with("的能力")
            || GOAL.is_match(before) && term.ends_with("结构")
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
        && nominal_candidate(term, jieba)
        && !jieba
            .tag(term, false)
            .last()
            .is_some_and(|t| t.tag.starts_with('v'))
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
    let mut strong = BTreeSet::new();
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
                "n" | "ng" | "nz" | "nt" | "vn" | "an" | "eng" | "l" | "v"
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
                        || !matches!(
                            next.tag,
                            "n" | "ng" | "nz" | "nt" | "vn" | "an" | "eng" | "l"
                        )
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
                if (!nominal_candidate(span, &jieba) && !nominal_slot(&event.text, span))
                    || code_occurrence(&event.text, span)
                    || !concept_context(&event.text, span)
                {
                    continue;
                }
                let key = normalize(span);
                if strong_seed_context(&event.text, span) {
                    strong.insert(key.clone());
                }
                let item = candidates
                    .entry(key)
                    .or_insert_with(|| (span.into(), BTreeSet::new()));
                item.1.insert(event.event_id.clone());
            }
        }
    }
    candidates
        .into_iter()
        .filter(|(key, (_, events))| events.len() >= 2 || strong.contains(key))
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
        rejected_occurrence: bool,
        nominal_slot: bool,
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
            if !phrase_integrity(&e.text, label) {
                entry.rejected_occurrence = true;
                continue;
            }
            if code_occurrence(&e.text, label) {
                continue;
            }
            let substantive_occurrence = text.match_indices(key.as_str()).any(|(at, _)| {
                !perspective_occurrence(text[..at].trim_end(), text[at + key.len()..].trim_start())
            });
            if !substantive_occurrence {
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
                                )
                                || strong_seed_context(
                                    &e.text,
                                    accepted[other.pattern().as_usize()].1,
                                ))
                            && concept_context(&e.text, accepted[other.pattern().as_usize()].1)
                    })
                });
            if e.signal != "submitted_material" && independent && concept_context(&e.text, label) {
                entry.concept.insert(e.event_id.clone());
                entry.direct |=
                    direct_term_request(&e.text, label) || strong_seed_context(&e.text, label);
                entry.nominal_slot |= nominal_slot(&e.text, label);
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
                && (nominal_candidate(label, &jieba) || s.nominal_slot)
                && (tokens[key].len() == 1 || s.concept.len() >= 2 || s.direct)
            {
                TermClass::Keyword
            } else if hint == "entity" {
                TermClass::Entity
            } else {
                TermClass::Candidate
            };
            let rejected = s.all.is_empty() && s.rejected_occurrence && class != TermClass::Project;
            if s.all.is_empty() && class != TermClass::Project && !rejected {
                return None;
            }
            Some((
                key.clone(),
                TermAssessment {
                    class,
                    rejected,
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
    fn analysis_persona_is_not_the_discussion_subject() {
        for domain in ["认知心理学", "经济学", "计算机科学"] {
            for text in [
                format!("请以{domain}的视角分析决策"),
                format!("请从{domain}角度解释决策"),
                format!("请以{domain}专家的视角理解决策"),
                format!("请以专业的{domain}的知识帮我分析决策"),
                format!("请以专业的{domain}的架构时的知识帮我分析决策"),
            ] {
                assert!(!concept_context(&text, domain), "{text}");
                assert!(!strong_seed_context(&text, domain), "{text}");
                assert!(concept_context(&text, "决策"), "{text}");
            }
            assert!(concept_context(&format!("我想理解{domain}的机制"), domain));
            assert!(concept_context(
                &format!("请以{domain}视角分析决策以及{domain}的机制"),
                domain
            ));
        }
    }
    #[test]
    fn conceptual_application_is_local_and_topic_neutral() {
        for term in ["知识图谱", "智能搜索", "工作记忆", "风险管理"] {
            for text in [
                format!("请解释{term}的算法，最后重新生成文件。"),
                format!("能不能采用{term}的模型？"),
                format!("我们需要优化{term}的流程。"),
            ] {
                assert!(concept_context(&text, term), "{text}");
                assert!(strong_seed_context(&text, term), "{text}");
            }
        }
        for (text, term) in [
            ("请优化可能原因的算法", "可能原因"),
            ("请重新生成知识图谱文件", "知识图谱"),
            ("请设计融入文档的方法", "融入文档"),
            ("我希望看到方法的原理是什么", "看到方法"),
            ("请简要描述关键概念的流程", "描述关键概念"),
            ("深度实现一版设计文档", "一版设计文档"),
            ("因为加密时需要指定目标平台的架构", "指定目标平台"),
            ("领导在批示时有专门的方法", "时有专门"),
            ("优化 M4ARepairService 的恢复逻辑", "M4ARepairService"),
            ("当前代码中wespeaker的模型从哪里加载", "wespeaker"),
            ("能不能保持和ouraring的算法一致", "ouraring"),
            ("优先实现macapp", "macapp"),
        ] {
            assert!(!concept_context(text, term), "{text}");
        }
    }
    #[test]
    fn application_suffixes_cannot_discard_attached_nominal_modifiers() {
        for (text, full, suffix) in [
            (
                "请以专业的后端云服务的架构知识帮我分析。",
                "后端云服务",
                "端云服务",
            ),
            ("请分析模糊时间解析的算法。", "模糊时间解析", "时间解析"),
        ] {
            assert!(
                applied_topic(
                    text.split(full).next().unwrap(),
                    text.split(full).nth(1).unwrap(),
                    full
                ),
                "{full}"
            );
            assert!(
                !applied_topic(
                    text.split(suffix).next().unwrap(),
                    text.split(suffix).nth(1).unwrap(),
                    suffix
                ),
                "{suffix}"
            );
        }
        assert!(!concept_context(
            "请以专业的后端云服务的架构知识帮我分析。",
            "端云服务"
        ));
        assert!(concept_context("请解释时间解析的算法。", "时间解析"));
        assert!(concept_context("请分析整个记忆系统的架构。", "记忆系统"));
        assert!(strong_seed_context(
            "请分析整个记忆系统的架构。",
            "记忆系统"
        ));
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
            ("以认知心理学视角分析决策", vec!["决策"]),
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
    #[test]
    fn installing_an_action_is_not_entity_typing() {
        let a = assess(&["请重启启动流程。", "请安装启动服务。"], &["启动"]);
        assert!(a.get("启动").is_none_or(|v| v.class != TermClass::Tool));
    }
    #[test]
    fn discourse_slots_are_not_technical_terms_even_after_repetition() {
        let a = assess(
            &[
                "请问可能原因是什么",
                "服务端没有移动。可能原因是什么",
                "请分析主要原因",
                "说明具体情况",
                "这件事的根本原因是什么",
                "关键指标是什么",
                "请描述后续发展情况",
                "原因是什么",
                "请分析原因",
                "情况如何",
                "结果是什么",
            ],
            &[
                "可能原因",
                "主要原因",
                "具体情况",
                "根本原因",
                "关键指标",
                "后续发展情况",
            ],
        );
        for term in [
            "可能原因",
            "主要原因",
            "具体情况",
            "根本原因",
            "关键指标",
            "后续发展情况",
        ] {
            assert!(a[term].rejected, "{term}: {:?}", a[term]);
        }
    }
    #[test]
    fn bare_discourse_heads_are_rejected_in_value_or_output_slots() {
        for (text, term) in [
            ("原因是什么", "原因"),
            ("请分析原因", "原因"),
            ("情况如何", "情况"),
            ("结果是什么", "结果"),
        ] {
            let a = assess(&[text], &[term]);
            assert!(a.get(term).is_none_or(|a| a.rejected), "{text}: {a:?}");
            assert!(!concept_context(text, term));
        }
    }
    #[test]
    fn quantity_truncation_and_instruction_concatenation_are_rejected() {
        let a = assess(
            &[
                "ai生成视频 抽卡：1.5卡定稿 是什么水平",
                "把安装wespeacker依赖的方法备注在文档",
                "请把讨论融入文档",
                "生成完整分析思考md",
                "这是hemory",
                "请表述hemory的价值",
            ],
            &[
                "卡定稿",
                "安装wespeacker",
                "融入文档",
                "思考md",
                "这是hemory",
                "表述hemory",
            ],
        );
        for term in [
            "卡定稿",
            "安装wespeacker",
            "融入文档",
            "思考md",
            "这是hemory",
            "表述hemory",
        ] {
            assert!(a[term].rejected, "{term}: {:?}", a[term]);
        }
    }
    #[test]
    fn value_queries_do_not_promote_suffixes_after_longer_terms_are_rejected() {
        let samples = [
            ("ai生成视频 抽卡：1.5卡定稿 是什么水平", "定稿"),
            ("3年经验是什么水平", "经验"),
            ("运行命令是什么", "命令"),
            ("导入init db 的命令是什么", "命令"),
            ("opsx-continue 命令为什么不能直接带change id", "命令"),
            ("刷新指令是什么", "指令"),
        ];
        for (text, term) in samples {
            let a = assess(&[text], &[term]);
            assert!(a.get(term).is_none_or(|a| a.rejected), "{text}: {a:?}");
            assert!(!concept_context(text, term));
            assert!(!strong_seed_context(text, term));
        }
    }
    #[test]
    fn genuine_domain_compounds_definitions_and_parenthetical_aliases_survive() {
        let samples = [
            ("什么是可能世界？", "可能世界"),
            ("什么是原因？", "原因"),
            ("原因是指引起结果的因素。", "原因"),
            ("什么是命令？", "命令"),
            ("命令与事件的区别是什么？", "命令"),
            ("请解释命令模式的机制。", "命令模式"),
            ("定稿的定义是什么？", "定稿"),
            ("什么是根本原因？", "根本原因"),
            ("关键指标的定义是什么？", "关键指标"),
            ("请解释关键路径的机制。", "关键路径"),
            ("什么是指标体系？", "指标体系"),
            ("请解释原因分析的机制。", "原因分析"),
            ("什么是随机变量？", "随机变量"),
            ("什么是设计思维？", "设计思维"),
            ("请解释优化算法的机制。", "优化算法"),
            ("我想理解软件开发的流程。", "软件开发"),
            ("什么是证据？", "证据"),
            ("结论的定义是什么？", "结论"),
            ("请解释工作记忆（working memory）的机制。", "工作记忆"),
            ("请解释working memory（工作记忆）的机制。", "working memory"),
            ("认知心理学、认知神经科学则是在研究原理。", "认知神经科学"),
            ("为什么CLIP特征影响检索质量？", "CLIP特征"),
        ];
        for (text, term) in samples {
            let a = assess(&[text], &[term]);
            assert!(a.contains_key(&normalize(term)), "missing {term} in {text}");
            assert!(!a[&normalize(term)].rejected, "{term}");
            assert_eq!(a[&normalize(term)].class, TermClass::Keyword, "{term}");
        }
    }
}
