//! Conservative, evidence-backed relation statements between recognized terms.
//! Hearst-inspired fixed-pattern adaptation, not trained OpenIE or fact checking:
//! https://aclanthology.org/C92-2082/
//!
//! Deliberately low recall: quoted/reported, uncertain, negative and interrogative
//! contexts are omitted. Arguments must occupy a complete local statement;
//! influences additionally permits bounded modifiers and object coordination.
//! Co-occurrence never supplies a typed relationship.
use crate::focus::{Occurrence, UserEvent};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone)]
pub(crate) struct RelationClaim {
    pub from: String,
    pub to: String,
    pub relation: String,
    /// The source asserts the relation; this does not mean the assertion is true.
    pub status: String,
    pub occurrence: Occurrence,
}

fn normalized(text: &str) -> String {
    text.nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn unsafe_context(text: &str) -> bool {
    static ENGLISH: OnceLock<Regex> = OnceLock::new();
    text.chars().any(|c| {
        matches!(c, '?' | '？' | '"' | '\'' | '“' | '”' | '‘' | '’' | '「' | '」' | '『' | '』' | '`' | '{' | '}' | '：' | ':' | '《' | '》')
    }) || [
        "是否", "能否", "何为", "如何", "为什么", "怎么", "吗", "么", "是不是",
        "如果", "假如", "假设", "倘若", "除非", "即使", "若是", "当且仅当",
        "可能", "也许", "或许", "似乎", "大概", "未必", "据说", "听说", "传闻",
        "认为", "声称", "宣称", "据称", "提到", "指出", "写道", "原文", "引文",
        "他说", "她说", "作者说", "有人说", "文中说", "材料说", "比较", "相比",
        "而不是", "不是", "并非", "并不", "不能", "不要", "否认", "不意味着",
        "不依赖", "不属于", "不一定", "未证实", "举例", "例如", "譬如",
        "无需", "无须", "不必", "不用", "没有依赖",
        "不影响", "不会影响", "没有影响", "未影响", "不曾影响", "无影响",
        "只要", "只有", "一旦", "前提", "否则", "应该", "应当", "设想",
    ].iter().any(|marker| text.contains(marker))
        || ENGLISH.get_or_init(|| Regex::new(
            r"(?i)\b(if|unless|whether|when|provided|once|only|may|might|could|would|perhaps|possibly|probably|apparently|reportedly|not|never|neither|without|denies|denied|claim|claims|claimed|said|says|reported|suggests|assume|assuming|suppose|supposing|believe|believes|think|thinks|compare|compared|unlike|versus|whereas|why|how|what)\b|\baccording\s+to\b|\bfor\s+example\b"
        ).unwrap()).is_match(text)
}

/// Periods inside note.md, decimal numbers or acronyms are not sentence breaks.
fn sentences(text: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0;
    for (at, ch) in text.char_indices() {
        let end = at + ch.len_utf8();
        let period = ch == '.' && text[end..].chars().next().is_none_or(char::is_whitespace);
        if period || matches!(ch, '。' | '！' | '？' | '!' | '?' | '\n') {
            result.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        result.push(&text[start..]);
    }
    result
}

fn argument<'a>(text: &str, terms: &'a BTreeMap<String, String>) -> Option<&'a String> {
    let key = normalized(text);
    // Articles require a real token boundary: "theIT" must not match "IT".
    terms.get(&key).or_else(|| {
        ["the ", "an ", "a "]
            .iter()
            .find_map(|prefix| key.strip_prefix(prefix).and_then(|rest| terms.get(rest)))
    })
}

fn statement_parts(clause: &str) -> Option<(&str, &str, &'static str, bool)> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str, bool)>> = OnceLock::new();
    // Specific predicates precede their prefixes: “is a component of” must
    // never become an is_a assertion about a spurious “component of B” term.
    let patterns = PATTERNS.get_or_init(|| {
        [
            (" is a kind of ", "", "is_a", false),
            (" is a type of ", "", "is_a", false),
            (" is a component of ", "", "part_of", false),
            (" is part of ", "", "part_of", false),
            (" is also known as ", "", "alias_of", true),
            (" is abbreviated as ", "", "alias_of", true),
            (" is an ", "", "is_a", false),
            (" is a ", "", "is_a", false),
            ("是一种", "", "is_a", false),
            ("属于一种", "", "is_a", false),
            ("是", "的组成部分", "part_of", false),
            ("是", "的一部分", "part_of", false),
            (" depends on ", "", "depends_on", false),
            ("依赖于", "", "depends_on", false),
            ("依赖", "", "depends_on", false),
            (" affects ", "", "influences", false),
            (" influences ", "", "influences", false),
            ("对", "有影响", "influences", false),
            ("影响", "", "influences", false),
            ("又称为", "", "alias_of", true),
            ("又称", "", "alias_of", true),
            ("简称为", "", "alias_of", true),
            ("简称", "", "alias_of", true),
        ]
        .into_iter()
        .map(|(predicate, suffix, relation, reverse)| {
            let predicate = if predicate.is_ascii() {
                format!(
                    r"\s+{}\s+",
                    predicate
                        .split_whitespace()
                        .map(regex::escape)
                        .collect::<Vec<_>>()
                        .join(r"\s+")
                )
            } else {
                regex::escape(predicate)
            };
            (
                Regex::new(&format!(
                    r"(?i)^(.+?){predicate}(.+?){}$",
                    regex::escape(suffix)
                ))
                .unwrap(),
                relation,
                reverse,
            )
        })
        .collect()
    });
    for (pattern, relation, reverse) in patterns {
        let Some(found) = pattern.captures(clause) else {
            continue;
        };
        return Some((
            found.get(1)?.as_str().trim(),
            found.get(2)?.as_str().trim(),
            relation,
            *reverse,
        ));
    }
    None
}

fn influence_endpoint(text: &str) -> &str {
    let text = text.trim();
    let text = text.strip_prefix("用户的").unwrap_or(text);
    text.strip_prefix("当前").unwrap_or(text).trim()
}

fn relation_arguments(clause: &str) -> Vec<(&str, &str, &'static str, bool)> {
    let Some((left, right, relation, reverse)) = statement_parts(clause) else {
        return Vec::new();
    };
    if relation != "influences" {
        return vec![(left, right, relation, reverse)];
    }
    // One explicit subject and one predicate only. No Cartesian expansion of
    // coordinated subjects, inferred verb arguments or pronoun resolution.
    let left = influence_endpoint(left);
    let objects: Vec<_> = right
        .split(" and ")
        .flat_map(|part| part.split(['和', '与', '及', '、']))
        .map(influence_endpoint)
        .collect();
    if !(1..=4).contains(&objects.len())
        || left.contains(['和', '与', '及', '、'])
        || left.contains(" and ")
        || std::iter::once(left)
            .chain(objects.iter().copied())
            .any(|arg| {
                arg.is_empty()
                    || !endpoint_shape(arg)
                    || arg.contains(['，', ',', '；', ';'])
                    || [
                        "影响",
                        "并",
                        "帮助",
                        "改变",
                        "提高",
                        "降低",
                        "导致",
                        "促进",
                        "依赖",
                        " affects ",
                        " influences ",
                    ]
                    .iter()
                    .any(|p| arg.contains(p))
            })
    {
        return Vec::new();
    }
    objects
        .into_iter()
        .map(|right| (left, right, relation, reverse))
        .collect()
}

fn parse_clause<'a>(
    clause: &str,
    terms: &'a BTreeMap<String, String>,
) -> Vec<(&'a String, &'a String, &'static str)> {
    relation_arguments(clause)
        .into_iter()
        .filter_map(|(left, right, relation, reverse)| {
            if !endpoint_shape(left) || !endpoint_shape(right) {
                return None;
            }
            let (from, to) = (argument(left, terms)?, argument(right, terms)?);
            if from == to {
                return None;
            }
            Some(if reverse {
                (to, from, relation)
            } else {
                (from, to, relation)
            })
        })
        .collect()
}

fn delegated_events(events: &[UserEvent]) -> BTreeSet<&str> {
    events
        .iter()
        .filter(|event| {
            let text = event.text.to_ascii_lowercase();
            [
                "begin task from parent agent",
                "task from parent",
                "you are a worker",
                "you are a fact-checker",
                "execute the following assignment",
                "you are a subagent",
                "the following is the codex agent history",
                "你是一个子代理",
                "你是子代理",
            ]
            .iter()
            .any(|marker| text.contains(marker))
        })
        .map(|event| event.event_id.as_str())
        .collect()
}

fn endpoint_shape(endpoint: &str) -> bool {
    !([
        "请", "读取", "更新", "检查", "分析", "创建", "生成", "调用", "执行", "安装", "并把",
    ]
    .iter()
    .any(|prefix| endpoint.starts_with(prefix))
        || endpoint.ends_with('的')
        || [
            "this",
            "this view",
            "that",
            "these",
            "those",
            "we",
            "you",
            "they",
        ]
        .contains(&endpoint.to_ascii_lowercase().as_str()))
}

fn eligible(event: &UserEvent) -> bool {
    let text = event.text.trim();
    matches!(event.signal.as_str(), "agent_user" | "native_human")
        && !event.event_id.is_empty()
        && !text.starts_with(['>', '#', '<'])
        && !text.starts_with("//")
        && !text.starts_with("~~~")
        && !event.text.starts_with("    ")
        && !event.text.starts_with('\t')
}

/// Framing may precede the apparent statement on another line of the same
/// user turn. Keep this scope even when interrogative turns allow local claims.
fn framed_events(events: &[UserEvent]) -> BTreeSet<&str> {
    events
        .iter()
        .filter(|event| {
            let text = event.text.to_lowercase();
            [
                "请验证",
                "请核实",
                "猜测",
                "对吗",
                "正确吗",
                "不确定",
                "以下假设",
                "问题和假设",
                "假设如下",
                "假设",
                "猜想",
                "假如",
                "倘若",
                "除非",
                "如果",
                "据说",
                "资料显示",
                "数据显示",
                "研究表明",
                "作者说",
                "我认为",
                "听说",
                "有人说",
                "写道",
                "引文",
                "引用如下",
                "原文如下",
                "材料说",
                "文中说",
                "他说",
                "她说",
                "according to",
                "verify the following",
                "suppose that",
                "assume that",
                "if ",
                "unless ",
                "~~~",
            ]
            .iter()
            .any(|marker| text.contains(marker))
                || text.contains(['“', '”', '‘', '’', '「', '」', '『', '』', '`', '"', '\''])
        })
        .map(|event| event.event_id.as_str())
        .collect()
}

fn asserted_complement(clause: &str) -> Option<&str> {
    let clause = clause.trim();
    let clause = ["以及", "并且", "而且", "同时"]
        .iter()
        .find_map(|prefix| clause.strip_prefix(prefix))
        .unwrap_or(clause);
    ["我深刻知道", "也深刻知道", "我知道", "我观察到", "我发现"]
        .iter()
        .find_map(|prefix| clause.strip_prefix(prefix))
        .map(str::trim)
}

fn clauses(event: &UserEvent) -> Vec<&str> {
    sentences(event.text.trim())
        .into_iter()
        .flat_map(|sentence| {
            if unsafe_context(sentence) {
                return Vec::new();
            }
            let parts: Vec<_> = sentence
                .split([',', '，', ';', '；'])
                .map(|clause| {
                    clause
                        .trim()
                        .trim_end_matches(['。', '.', '!', '！'])
                        .trim()
                })
                .filter(|clause| !clause.is_empty())
                .collect();
            // A leading report/condition fragment must not be discarded while its
            // subordinate statement is promoted into an unconditional assertion.
            if parts.iter().all(|part| statement_parts(part).is_some()) {
                parts
                    .into_iter()
                    .map(|part| asserted_complement(part).unwrap_or(part))
                    .collect()
            } else {
                // A mixed sentence can contain an explicitly introduced
                // author's assertion. Do not promote arbitrary comma fragments.
                parts
                    .into_iter()
                    .filter_map(asserted_complement)
                    .filter(|part| statement_parts(part).is_some())
                    .collect()
            }
        })
        .collect()
}

/// Raw fixed-pattern endpoints for the caller's common term-quality gate.
/// These are candidates only: this function creates no nodes or relations and
/// preserves original spelling rather than guessing noun/POS eligibility.
pub(crate) fn candidate_endpoints(events: &[UserEvent]) -> Vec<String> {
    let mut candidates = BTreeMap::new();
    let delegated = delegated_events(events);
    let framed = framed_events(events);
    for event in events.iter().filter(|event| {
        eligible(event)
            && !delegated.contains(event.event_id.as_str())
            && !framed.contains(event.event_id.as_str())
    }) {
        for clause in clauses(event) {
            for (left, right, _, _) in relation_arguments(clause) {
                if !endpoint_shape(left) || !endpoint_shape(right) {
                    continue;
                }
                for endpoint in [left, right] {
                    let lower = endpoint.to_ascii_lowercase();
                    let endpoint = ["the ", "an ", "a "]
                        .iter()
                        .find_map(|prefix| {
                            lower.starts_with(prefix).then(|| &endpoint[prefix.len()..])
                        })
                        .unwrap_or(endpoint)
                        .trim();
                    if !endpoint_shape(endpoint)
                        || !(2..=64).contains(&endpoint.chars().count())
                        || endpoint.split_whitespace().count() > 8
                    {
                        continue;
                    }
                    let key = normalized(endpoint);
                    candidates
                        .entry(key)
                        .and_modify(|old: &mut String| {
                            if endpoint < old.as_str() {
                                *old = endpoint.into();
                            }
                        })
                        .or_insert_with(|| endpoint.to_string());
                }
            }
        }
    }
    candidates.into_values().collect()
}

pub(crate) fn extract_relations(
    events: &[UserEvent],
    terms: &BTreeMap<String, String>,
) -> Vec<RelationClaim> {
    // Surface lookup is scoped to admitted concepts. Ambiguous labels abstain
    // rather than joining two identities or selecting one by insertion order.
    let mut surfaces: BTreeMap<String, Option<String>> = BTreeMap::new();
    for (canonical, literal) in terms {
        for spelling in [canonical, literal] {
            let surface = normalized(spelling);
            if surface.is_empty() {
                continue;
            }
            surfaces
                .entry(surface)
                .and_modify(|old| {
                    if old.as_ref() != Some(canonical) {
                        *old = None;
                    }
                })
                .or_insert_with(|| Some(canonical.clone()));
        }
    }
    let lookup = surfaces
        .into_iter()
        .filter_map(|(k, v)| Some((k, v?)))
        .collect();
    let mut ordered: Vec<_> = events.iter().collect();
    ordered.sort_by(|a, b| {
        (&a.date, &a.event_id, &a.path, a.start, a.end, &a.text).cmp(&(
            &b.date,
            &b.event_id,
            &b.path,
            b.start,
            b.end,
            &b.text,
        ))
    });
    let mut claims = BTreeMap::new();
    let delegated = delegated_events(events);
    let framed = framed_events(events);
    for event in ordered {
        if !eligible(event)
            || delegated.contains(event.event_id.as_str())
            || framed.contains(event.event_id.as_str())
        {
            continue;
        }
        for clause in clauses(event) {
            for (from, to, relation) in parse_clause(clause, &lookup) {
                let key = (
                    event.date.clone(),
                    normalized(clause),
                    from.clone(),
                    to.clone(),
                    relation.to_string(),
                );
                claims.entry(key).or_insert_with(|| RelationClaim {
                    from: from.clone(),
                    to: to.clone(),
                    relation: relation.into(),
                    status: "asserted".into(),
                    occurrence: Occurrence {
                        path: event.path.clone(),
                        date: event.date.clone(),
                        start: event.start,
                        end: event.end,
                        text: event.text.clone(),
                        event_id: event.event_id.clone(),
                        signal: event.signal.clone(),
                        date_basis: event.date_basis.clone(),
                    },
                });
            }
        }
    }
    claims.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(text: &str) -> UserEvent {
        UserEvent {
            path: "human.md".into(),
            date: "2026-10-03".into(),
            start: 12,
            end: 12,
            text: text.into(),
            event_id: "e1".into(),
            signal: "native_human".into(),
            date_basis: "explicit_date".into(),
            inquiry: false,
        }
    }
    fn terms() -> BTreeMap<String, String> {
        [
            "工作记忆",
            "记忆",
            "认知系统",
            "注意力",
            "图数据库",
            "数据库",
            "知识图谱",
            "kg",
            "it",
            "system",
            "tool",
            "note.md",
            "情绪",
            "决策",
            "直觉",
            "ai",
            "能动性",
            "生产力",
        ]
        .into_iter()
        .map(|t| (t.into(), t.into()))
        .collect()
    }
    fn triples(events: &[UserEvent]) -> Vec<(String, String, String)> {
        extract_relations(events, &terms())
            .into_iter()
            .map(|c| (c.from, c.relation, c.to))
            .collect()
    }
    #[test]
    fn extracts_only_complete_local_arguments_and_preserves_directions() {
        let claims = extract_relations(&[event("工作记忆是一种记忆。工作记忆是认知系统的组成部分；工作记忆依赖注意力。知识图谱简称KG。")], &terms());
        assert_eq!(claims.len(), 4);
        assert!(claims
            .iter()
            .any(|c| (&*c.from, &*c.relation, &*c.to) == ("kg", "alias_of", "知识图谱")));
        assert!(claims
            .iter()
            .any(|c| (&*c.from, &*c.relation, &*c.to) == ("工作记忆", "is_a", "记忆")));
        assert!(claims
            .iter()
            .any(|c| (&*c.from, &*c.relation, &*c.to) == ("工作记忆", "part_of", "认知系统")));
        assert!(claims
            .iter()
            .all(|c| c.status == "asserted" && c.occurrence.start == 12));
        assert!(claims.iter().all(|c| event("工作记忆是一种记忆。工作记忆是认知系统的组成部分；工作记忆依赖注意力。知识图谱简称KG。").text.contains(&c.occurrence.text)));
    }
    #[test]
    fn rejects_negative_uncertain_questions_conditionals_comparisons_and_reported_speech() {
        for text in [
            "工作记忆不是一种记忆。",
            "工作记忆不依赖注意力。",
            "工作记忆是一种记忆吗？",
            "如果工作记忆是一种记忆，知识图谱依赖数据库。",
            "可能工作记忆依赖注意力。",
            "相比注意力，工作记忆是一种记忆。",
            "作者说，工作记忆是一种记忆。",
            "我认为，工作记忆依赖注意力。",
            "IT is not a tool.",
            "If IT is a tool, system depends on IT.",
            "According to the author, IT is a tool.",
            "IT might be a tool.",
            "Is IT a tool?",
        ] {
            assert!(
                triples(&[event(text)]).is_empty(),
                "unexpected assertion: {text}"
            );
        }
    }
    #[test]
    fn does_not_join_across_predicates_clauses_or_nested_concepts() {
        for text in [
            "工作记忆与注意力有关系。",
            "工作记忆是一种记忆并依赖注意力。",
            "工作记忆是一种记忆依赖注意力。",
            "工作记忆是一种，记忆依赖，注意力。",
            "请解释工作记忆依赖注意力。",
        ] {
            assert!(
                triples(&[event(text)]).is_empty(),
                "unexpected assertion: {text}"
            );
        }
        let claims = triples(&[event("工作记忆依赖注意力，图数据库是一种数据库。")]);
        assert_eq!(claims.len(), 2);
        assert!(!claims.iter().any(|(from, _, _)| from == "记忆"));
    }
    #[test]
    fn english_boundaries_articles_and_dotted_names_are_exact() {
        assert_eq!(
            triples(&[event(
                "The IT is a tool. note.md depends on IT. IT is part of the system."
            )])
            .len(),
            3
        );
        for text in [
            "theIT is a tool.",
            "IT is a tooling.",
            "IT is a toolset.",
            "IT depends on theIT.",
            "IT is a tool and system depends on IT.",
        ] {
            assert!(
                triples(&[event(text)]).is_empty(),
                "unexpected assertion: {text}"
            );
        }
    }
    #[test]
    fn quotations_code_and_untrusted_signals_do_not_become_assertions() {
        for text in [
            "> 工作记忆是一种记忆。",
            "“工作记忆是一种记忆。”",
            "`IT is a tool.`",
            "```text\nIT is a tool.\n```",
            "    IT is a tool.",
            "~~~\nIT is a tool.\n~~~",
            "小说里写道：\n工作记忆是一种记忆。",
        ] {
            assert!(
                triples(&[event(text)]).is_empty(),
                "unexpected assertion: {text}"
            );
        }
        for signal in ["submitted_material", "assistant", "imported", "human", ""] {
            let mut e = event("工作记忆是一种记忆。");
            e.signal = signal.into();
            assert!(triples(&[e]).is_empty());
        }
    }
    #[test]
    fn export_copies_do_not_inflate_support_but_distinct_events_survive() {
        let original = event("工作记忆是一种记忆。");
        let mut copy = original.clone();
        copy.path = "copy.md".into();
        copy.start = 40;
        let mut next = original.clone();
        next.event_id = "e2".into();
        next.date = "2026-10-04".into();
        let first = extract_relations(&[original.clone(), copy.clone(), next.clone()], &terms());
        let reversed = extract_relations(&[next, copy, original], &terms());
        assert_eq!(first.len(), 2);
        assert_eq!(format!("{first:?}"), format!("{reversed:?}"));
    }
    #[test]
    fn ambiguous_surface_and_unknown_endpoint_abstain() {
        let mut known = terms();
        known.insert("information technology".into(), "IT".into());
        assert!(extract_relations(&[event("IT is a tool.")], &known).is_empty());
        assert!(triples(&[event("未收录术语是一种记忆。")]).is_empty());
    }
    #[test]
    fn fresh_definition_endpoints_remain_literal_candidates_until_admitted() {
        let events = [event(
            "认知卸载是一种认知策略。The External Memory is a component of the Cognitive System。",
        )];
        let candidates = candidate_endpoints(&events);
        assert!(candidates.contains(&"认知卸载".to_string()));
        assert!(candidates.contains(&"认知策略".to_string()));
        assert!(candidates.contains(&"External Memory".to_string()));
        assert!(candidates.contains(&"Cognitive System".to_string()));
        assert!(!candidates.iter().any(|c| c.contains("component of")));
        assert!(extract_relations(&events, &terms()).is_empty());
        let admitted = candidates
            .iter()
            .map(|term| (normalized(term), term.clone()))
            .collect();
        let relations = extract_relations(&events, &admitted);
        assert_eq!(relations.len(), 2);
        assert!(relations.iter().any(|c| c.relation == "part_of"
            && c.from == "external memory"
            && c.to == "cognitive system"));
        assert!(candidate_endpoints(&[event("资料显示，工作记忆是一种记忆。")]).is_empty());
        assert!(
            candidate_endpoints(&[event("如果工作记忆是一种记忆，知识图谱依赖数据库。")])
                .is_empty()
        );
    }
    #[test]
    fn delegated_wrappers_and_negative_dependencies_never_supply_definition_seeds() {
        let mut header = event("---BEGIN TASK FROM PARENT AGENT---");
        header.start = 1;
        let claim = event("图数据库是一种数据库。");
        assert!(candidate_endpoints(&[header.clone(), claim.clone()]).is_empty());
        assert!(extract_relations(&[header, claim], &terms()).is_empty());
        for text in [
            "无需依赖注意力。",
            "读取所有依赖及版本约束",
            "类似的依赖问题",
            "This is a tool.",
        ] {
            assert!(
                candidate_endpoints(&[event(text)]).is_empty(),
                "unexpected seed: {text}"
            );
        }
    }

    #[test]
    fn local_statements_survive_an_inquiry_turn_without_promoting_its_questions() {
        let mut e = event("我想研究记忆。工作记忆是一种记忆。情绪影响决策。情绪如何影响记忆？");
        e.inquiry = true;
        let claims = triples(&[e]);
        assert_eq!(claims.len(), 2);
        assert!(claims.contains(&("情绪".into(), "influences".into(), "决策".into())));
        assert!(claims.contains(&("工作记忆".into(), "is_a".into(), "记忆".into())));
    }

    #[test]
    fn real_mixed_research_paragraph_keeps_only_explicit_author_statement() {
        let text = "我有一个直觉，积极心理学代表心理学那一波。不知道我的直觉对不对。 我是个做生产力软件的，期望自己的app能提高人的生产力，但慢慢涉足到使用者的学习、注意力、记忆等领域，以及也深刻知道用户的当前情绪影响直觉和决策，以及专注、浮动注意力等直接影响学习和工作效率等。请深度分析这些问题。";
        let mut e = event(text);
        e.inquiry = true;
        let mut admitted = terms();
        admitted.remove("直觉");
        let claims = extract_relations(&[e], &admitted);
        assert_eq!(claims.len(), 1);
        assert_eq!(
            (&*claims[0].from, &*claims[0].relation, &*claims[0].to),
            ("情绪", "influences", "决策")
        );
        assert_eq!(claims[0].status, "asserted");
        assert_eq!(
            claims[0].occurrence.text, text,
            "keep qualifications and source context"
        );
    }

    #[test]
    fn influences_are_directional_bounded_and_preserve_full_concept_boundaries() {
        let claims = triples(&[event(
            "我知道用户的当前情绪影响直觉和决策。工作记忆对决策有影响。AI affects 生产力。",
        )]);
        assert_eq!(claims.len(), 4);
        assert!(claims.contains(&("工作记忆".into(), "influences".into(), "决策".into())));
        assert!(!claims.iter().any(|(from, _, _)| from == "记忆"));
        for text in [
            "情绪和记忆影响决策和直觉。",
            "情绪影响决策并改变记忆。",
            "情绪影响决策的速度。",
            "AI helps 能动性。",
            "theAI affects 生产力。",
            "情绪影响决策，AI帮助能动性。",
            "情绪影响。决策。",
        ] {
            assert!(triples(&[event(text)]).is_empty(), "must abstain: {text}");
        }
    }

    #[test]
    fn influence_questions_hypotheses_negation_and_reports_never_assert() {
        for text in [
            "情绪如何影响记忆？",
            "请解释情绪为什么影响记忆。",
            "情绪可能影响决策。",
            "情绪不影响决策。",
            "情绪未必影响决策。",
            "如果情绪影响决策，AI就能提高生产力。",
            "据说，情绪影响决策。",
            "请验证：情绪影响决策。",
            "请验证以下猜测。情绪影响决策。",
            "情绪影响决策。这对吗？",
            "情绪影响决策。我不确定。",
            "问题和假设如下。情绪影响决策。",
            "AI如何帮助人，以及如何保护能动性？",
            "人+AI协作工作，需要怎样才能保持生产力正向提升。",
            "材料说，情绪影响决策。",
            "\"引用\n情绪影响决策。\"",
            "假如我知道情绪影响决策。",
            "我认为情绪影响决策。",
        ] {
            assert!(triples(&[event(text)]).is_empty(), "must abstain: {text}");
            assert!(
                candidate_endpoints(&[event(text)]).is_empty(),
                "no seeds: {text}"
            );
        }
    }

    #[test]
    fn framing_on_other_lines_of_same_turn_is_not_lost() {
        let header = event("请验证以下猜测。");
        let mut claim = event("情绪影响决策。");
        claim.start = 13;
        assert!(triples(&[header.clone(), claim.clone()]).is_empty());
        assert!(candidate_endpoints(&[header.clone(), claim.clone()]).is_empty());
        claim.event_id = "independent-turn".into();
        assert_eq!(triples(&[header, claim]).len(), 1);
    }

    #[test]
    fn influence_endpoint_seeds_share_the_same_guard_and_remain_unadmitted() {
        let events = [event("用户的当前压力影响睡眠质量和运动表现。")];
        let seeds = candidate_endpoints(&events);
        assert_eq!(seeds, vec!["压力", "睡眠质量", "运动表现"]);
        assert!(extract_relations(&events, &terms()).is_empty());
        let admitted = seeds.into_iter().map(|s| (normalized(&s), s)).collect();
        assert_eq!(extract_relations(&events, &admitted).len(), 2);
    }

    #[test]
    fn identical_daily_claims_in_different_turns_count_once() {
        let first = event("情绪影响决策。");
        let mut copy = first.clone();
        copy.event_id = "different-wrapper".into();
        copy.path = "copy.md".into();
        let mut next_day = copy.clone();
        next_day.date = "2026-10-04".into();
        assert_eq!(triples(&[first, copy, next_day]).len(), 2);
    }
}
