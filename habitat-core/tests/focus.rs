use habitat_core::{
    focus::{self, FocusCandidate, UserEvent},
    model::FocusContext,
};
use std::collections::BTreeMap;
fn context() -> FocusContext {
    FocusContext {
        as_of: "2026-10-02".into(),
        window_days: 30,
        utc_offset_minutes: 480,
    }
}
fn session(date: &str, text: &str) -> String {
    format!("# Conversation\n\n- Started: {date} 12:00\n- Ended: {date} 13:00\n- Source: Codex\n- Project: notebook\n\n## 👤 User\n\n{text}\n\n## 🤖 Codex\n\nAssistant unrelated claims.\n")
}
fn events(date: &str, text: &str) -> Vec<UserEvent> {
    focus::events_from_markdown("agent-sessions/a.md", &session(date, text), 480)
}
fn anchors() -> BTreeMap<String, String> {
    [
        "工作记忆",
        "决策质量",
        "近期概念",
        "历史概念",
        "边界条件",
        "认知负荷",
        "能动性",
        "agency",
    ]
    .into_iter()
    .map(|s| (s.into(), "concept".into()))
    .collect()
}
fn rank(events: Vec<UserEvent>) -> Vec<FocusCandidate> {
    focus::rank_events(events, &context(), &anchors()).unwrap()
}
#[test]
fn genuine_revisits_on_different_days_survive_while_duplicate_exports_do_not() {
    let text = "为什么工作记忆会影响决策质量？";
    let mut input = events("2026-09-30", text);
    input.extend(focus::events_from_markdown(
        "agent-sessions/copy.md",
        &session("2026-09-30", text),
        480,
    ));
    input.extend(events("2026-10-01", text));
    let ranked = rank(input);
    let c = ranked.iter().find(|c| c.term == "工作记忆").unwrap();
    assert_eq!(c.active_days, 2);
    assert_eq!(c.events, 2);
    assert_eq!(c.last_observed_at, "2026-10-01");
}
#[test]
fn old_frequency_and_future_events_do_not_overpower_recent_revisits() {
    let mut input = Vec::new();
    for _ in 0..100 {
        input.extend(events("2024-01-01", "为什么历史概念如此重要？"));
    }
    input.extend(events("2026-10-01", "我想理解近期概念的边界条件。"));
    input.extend(events("2026-10-02", "为什么近期概念值得进一步理解？"));
    input.extend(events("2026-10-03", "为什么历史概念又出现了？"));
    let ranked = rank(input);
    assert!(ranked
        .iter()
        .any(|c| c.term == "近期概念" && c.active_days == 2));
    assert!(!ranked.iter().any(|c| c.term == "历史概念"));
}
#[test]
fn plain_unlinked_body_terms_need_no_wiki_page() {
    let input = events("2026-10-01", "为什么神经科学可以解释情绪与记忆之间的关系？");
    let ranked = focus::rank_events(input, &context(), &BTreeMap::new()).unwrap();
    assert!(
        ranked.iter().any(|c| c.term == "神经科学"),
        "{:?}",
        ranked.iter().map(|c| &c.term).collect::<Vec<_>>()
    );
    for c in ranked {
        assert!(c
            .occurrences
            .iter()
            .all(|o| o.text.to_lowercase().contains(&c.term.to_lowercase())));
    }
}
#[test]
fn role_headers_inside_fenced_examples_are_not_real_user_events_and_user_headings_survive() {
    let text = "## 工作记忆\n\n为什么工作记忆会影响决策质量？";
    let ranked = rank(events("2026-10-01", text));
    assert!(ranked.iter().any(|c| c.term == "工作记忆"));
    let raw="# Session\n- Started: 2026-10-01 12:00\n- Ended: 2026-10-01 13:00\n\n## 🤖 Codex\n\n```md\n## 👤 User\n为什么虚构角色会产生伪证据？\n```\n";
    assert!(focus::events_from_markdown("agent-sessions/example.md", raw, 480).is_empty());
}
#[test]
fn review_skill_ambient_reply_echo_and_delegated_tasks_are_not_owner_attention() {
    for wrapper in [
        "The following is the Codex agent history whose request action needs review",
        "Base directory for this skill: /skills/chart\nThis skill teaches neuroscience.",
        "This block is automatically supplied ambient UI state, not part of the user's request.",
        "Answers to your questions:\nWhy does memory affect attention?\nContinue",
        "你是本次重做的独立提取与分析执行者；协调进程负责整合。",
        "你是全新上下文的分析者，协调者让你分析资料。",
        "Exit code: -1\nDuration: 20 seconds",
    ] {
        assert!(
            events("2026-10-01", wrapper).is_empty(),
            "accepted wrapper {wrapper}"
        );
    }
}
#[test]
fn default_human_origin_and_updated_daily_dates_are_not_activity_proof() {
    let automatic =
        "---\ntitle: 2026-10-01\n---\n- 认知负荷与工作记忆\n  created:: 2026-10-01T10:00:00Z\n";
    assert!(
        focus::events_from_markdown("dailynote/2026/2026-10-01.note.md", automatic, 480).is_empty()
    );
    let explicit =
        "- 为什么工作记忆影响决策质量？\n  by:: human\n  created:: 2026-10-01T10:00:00Z\n";
    let e = focus::events_from_markdown("dailynote/2024/2024-01-01.note.md", explicit, 480);
    assert_eq!(e[0].date, "2024-01-01");
    assert!(rank(e).is_empty());
}
#[test]
fn time_zones_and_cross_window_sessions_are_conservative() {
    let raw="# Session\n- Started: 2026-10-01T18:00:00Z\n- Ended: 2026-10-01T19:00:00Z\n\n## 👤 User\n为什么工作记忆影响决策质量？\n";
    let e = focus::events_from_markdown("agent-sessions/zone.md", raw, 480);
    assert_eq!(e[0].date, "2026-10-02");
    let raw="# Session\n- Started: 2026-08-01 12:00\n- Ended: 2026-10-01 12:00\n\n## 👤 User\n为什么历史概念重要？\n\n## 🤖 Codex\nAnswer\n\n## 👤 User\n为什么近期概念重要？\n";
    assert!(rank(focus::events_from_markdown(
        "agent-sessions/long.md",
        raw,
        480
    ))
    .is_empty());
}
#[test]
fn explicit_submitted_trace_is_background_not_owner_belief() {
    let raw="---\ntype: Trace Request\ngenerated:\n  by: human:me\n  at: 2026-10-01T18:00:00Z\n---\n\n> 为什么工作记忆影响决策质量？\n";
    let e = focus::events_from_markdown("inbox/traces/request.md", raw, 480);
    assert_eq!(e[0].signal, "submitted_material");
    assert_eq!(e[0].date, "2026-10-02");
    let ranked = rank(e);
    assert!(ranked.iter().all(|c| c.kind == "context"));
}
#[test]
fn same_day_repetitions_cannot_manufacture_active_days_and_asof_is_frozen() {
    let one = events("2026-10-01", "为什么工作记忆影响决策质量？");
    let mut repeated = one.clone();
    for i in 0..30 {
        let mut copy = one.clone();
        for e in &mut copy {
            e.event_id = format!("different-session-{i}");
        }
        repeated.extend(copy);
    }
    let a = rank(repeated.clone());
    let b = rank(repeated);
    assert_eq!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap()
    );
    let term = a.iter().find(|c| c.term == "工作记忆").unwrap();
    assert_eq!(term.active_days, 1);
    assert_eq!(term.events, 31);
}
#[test]
fn repeated_short_clauses_can_link_but_whole_prompt_cannot_create_a_clique() {
    let mut events = events(
        "2026-10-01",
        "为什么工作记忆与认知负荷相关？我想理解决策质量。",
    );
    events.extend(super_events(
        "2026-10-02",
        "我想理解工作记忆与认知负荷的关系。为什么决策质量重要？",
    ));
    let candidates = rank(events);
    let edges = focus::associations(&candidates);
    assert!(edges
        .iter()
        .any(|e| (e.a == "工作记忆" && e.b == "认知负荷")
            || (e.b == "工作记忆" && e.a == "认知负荷")));
    assert!(!edges
        .iter()
        .any(|e| (e.a == "决策质量" && e.b == "工作记忆")
            || (e.b == "决策质量" && e.a == "工作记忆")));
}
fn super_events(date: &str, text: &str) -> Vec<UserEvent> {
    events(date, text)
}

#[test]
fn duplicate_export_order_does_not_change_ranks_or_chosen_locators() {
    let raw = session("2026-10-01", "为什么工作记忆影响决策质量？");
    let mut events = focus::events_from_markdown("agent-sessions/z.md", &raw, 480);
    events.extend(focus::events_from_markdown(
        "agent-sessions/a.md",
        &raw,
        480,
    ));
    let a = rank(events.clone());
    events.reverse();
    let b = rank(events);
    assert_eq!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap()
    );
}
#[test]
fn recent_days_win_over_many_repeats_on_one_old_day_inside_window() {
    let mut input = Vec::new();
    for i in 0..100 {
        let mut old = events("2026-09-03", "为什么历史概念具有这些边界条件？");
        for e in &mut old {
            e.event_id = format!("old-{i}");
        }
        input.extend(old);
    }
    input.extend(events("2026-10-01", "为什么近期概念具有这些边界条件？"));
    input.extend(events("2026-10-02", "我想理解近期概念的边界条件。"));
    let ranked = rank(input);
    let old = ranked.iter().find(|c| c.term == "历史概念").unwrap();
    let recent = ranked.iter().find(|c| c.term == "近期概念").unwrap();
    assert!(recent.score > old.score);
    assert_eq!(old.active_days, 1);
    assert_eq!(recent.active_days, 2);
}
#[test]
fn english_boundaries_do_not_turn_mail_or_training_into_ai() {
    assert!(focus::literal_contains("AI and memory", "AI"));
    assert!(!focus::literal_contains("mail and training", "AI"));
    assert!(!focus::literal_contains("ai_module", "ai"));
}
#[test]
fn foreground_is_supported_and_never_fills_a_quota_with_single_event_metaphors() {
    let ranked = rank(events(
        "2026-10-01",
        "我想理解工作记忆与认知负荷之间的关系。",
    ));
    assert!(!ranked.is_empty());
    assert!(focus::foreground(&ranked).is_empty());
}
#[test]
fn chosen_evidence_sentence_obeys_the_same_english_boundaries_as_candidate() {
    let a = [("ai".to_string(), "concept".to_string())]
        .into_iter()
        .collect();
    let ranked = focus::rank_events(
        events(
            "2026-10-01",
            "Please read mail. Why is AI related to memory?",
        ),
        &context(),
        &a,
    )
    .unwrap();
    let ai = ranked
        .iter()
        .find(|c| c.term.eq_ignore_ascii_case("ai"))
        .unwrap();
    assert!(ai
        .occurrences
        .iter()
        .all(|o| focus::literal_contains(&o.text, &ai.term) && o.text.contains("AI")));
    let ranked = focus::rank_events(
        events("2026-10-01", "为什么 ai_module 与 mail 存在这些差异？"),
        &context(),
        &a,
    )
    .unwrap();
    assert!(!ranked.iter().any(|c| c.term.eq_ignore_ascii_case("ai")));
}
#[test]
fn requested_lookup_tools_are_context_even_in_a_reflective_sentence() {
    let a = [
        ("search".to_string(), "concept".to_string()),
        ("openclaw".to_string(), "concept".to_string()),
    ]
    .into_iter()
    .collect();
    let mut input = events(
        "2026-10-01",
        "这种思想我一直没找到表达方法，请使用 search 去查找我的笔记。",
    );
    input.extend(events("2026-10-02", "升级了 openclaw 请启动起来。"));
    let ranked = focus::rank_events(input, &context(), &a).unwrap();
    for term in ["search", "openclaw"] {
        assert!(ranked
            .iter()
            .filter(|c| c.term.eq_ignore_ascii_case(term))
            .all(|c| c.kind == "context"));
    }
}
#[test]
fn repeated_conceptual_observations_survive_homonymous_operational_noise() {
    let a = [("记忆".into(), "concept".into())].into_iter().collect();
    let mut input = events("2026-10-01", "为什么记忆会影响决策？");
    input.extend(events("2026-10-02", "我想理解记忆与情绪的关系。"));
    for day in 10..25 {
        input.extend(events(
            &format!("2026-09-{day}"),
            "请更新记忆缓存并同步插件。",
        ));
    }
    let ranked = focus::rank_events(input, &context(), &a).unwrap();
    let c = ranked.iter().find(|c| c.term == "记忆").unwrap();
    assert_eq!(c.kind, "concept");
    assert_eq!(c.active_days, 2);
    assert_eq!(c.events, 2);
    assert!(c.occurrences.iter().all(|o| !o.text.contains("缓存")));
}
#[test]
fn one_conceptual_mention_does_not_turn_repeated_tool_operations_into_a_concept() {
    let a = [("exampletool".into(), "concept".into())]
        .into_iter()
        .collect();
    let mut input = events("2026-10-01", "为什么 exampletool 具有这种能力？");
    for i in 0..5 {
        let mut operation = events("2026-10-02", "please update exampletool");
        for e in &mut operation {
            e.event_id = format!("operation-{i}");
        }
        input.extend(operation);
    }
    let ranked = focus::rank_events(input, &context(), &a).unwrap();
    assert_eq!(
        ranked
            .iter()
            .find(|c| c.term.eq_ignore_ascii_case("exampletool"))
            .unwrap()
            .kind,
        "context"
    );
}
#[test]
fn dependent_modifiers_require_a_referent_but_full_phrases_survive() {
    let a = [
        "核心",
        "人工",
        "负面",
        "特点",
        "原因",
        "人工科学",
        "负面情绪",
    ]
    .into_iter()
    .map(|t| (t.to_string(), "concept".into()))
    .collect();
    let ranked = focus::rank_events(
        events(
            "2026-10-01",
            "请给出核心洞察和特点，解释背后的原因。我想理解人工科学与负面情绪之间的关系。",
        ),
        &context(),
        &a,
    )
    .unwrap();
    for term in ["核心", "人工", "负面", "特点", "原因"] {
        assert!(
            !ranked.iter().any(|c| c.term == term),
            "fragment survived {term}"
        );
    }
    for term in ["人工科学", "负面情绪"] {
        assert!(
            ranked.iter().any(|c| c.term == term),
            "complete phrase lost {term}"
        );
    }
    let explicit = focus::rank_events(
        events("2026-10-01", "什么是核心？核心的定义是什么？"),
        &context(),
        &a,
    )
    .unwrap();
    assert!(explicit.iter().any(|c| c.term == "核心"));
}
