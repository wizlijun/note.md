//! Conservative, evidence-backed relation statements between recognized terms.
//! Hearst-inspired fixed-pattern adaptation, not trained OpenIE or fact checking:
//! https://aclanthology.org/C92-2082/
//!
//! Deliberately low recall: quoted/reported, uncertain, negative and interrogative
//! contexts are omitted. Both arguments must occupy the complete clause around
//! a supported predicate. Co-occurrence never supplies a typed relationship.
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

fn parse_clause<'a>(
    clause: &str,
    terms: &'a BTreeMap<String, String>,
) -> Option<(&'a String, &'a String, &'static str)> {
    let (left, right, relation, reverse) = statement_parts(clause)?;
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
        && !event.inquiry
        && !event.event_id.is_empty()
        && !text.starts_with(['>', '#', '<'])
        && !text.starts_with("//")
        && !text.starts_with("~~~")
        && !event.text.starts_with("    ")
        && !event.text.starts_with('\t')
        && !unsafe_context(text)
}

fn clauses(event: &UserEvent) -> Vec<&str> {
    sentences(event.text.trim())
        .into_iter()
        .flat_map(|sentence| {
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
            } else {
                Vec::new()
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
    for event in events
        .iter()
        .filter(|event| eligible(event) && !delegated.contains(event.event_id.as_str()))
    {
        for clause in clauses(event) {
            let Some((left, right, _, _)) = statement_parts(clause) else {
                continue;
            };
            if !endpoint_shape(left) || !endpoint_shape(right) {
                continue;
            }
            for endpoint in [left, right] {
                let lower = endpoint.to_ascii_lowercase();
                let endpoint = ["the ", "an ", "a "]
                    .iter()
                    .find_map(|prefix| lower.starts_with(prefix).then(|| &endpoint[prefix.len()..]))
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
    for event in ordered {
        if !eligible(event) || delegated.contains(event.event_id.as_str()) {
            continue;
        }
        for clause in clauses(event) {
            let Some((from, to, relation)) = parse_clause(clause, &lookup) else {
                continue;
            };
            let key = (
                event.event_id.clone(),
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
                    text: clause.into(),
                    event_id: event.event_id.clone(),
                    signal: event.signal.clone(),
                    date_basis: event.date_basis.clone(),
                },
            });
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
}
