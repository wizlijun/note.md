//! Query repair: one OpenAI-compatible request that proposes at most two
//! alternative wordings for a lookup (spec §5.5, Appendix F.6 / F.7).
//!
//! What is sent: the question, its explicit filters and resolved time range
//! as text, and each local arm's terms and hit count. Never a Vault path,
//! a passage, a heading or any other note text. The reply is held to a
//! strict shape; anything else is `Invalid` and nothing is searched. The
//! host strips search operators before the wordings are searched locally.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::keys::{read_key, ConnectionTest, KeyKind};
use super::{
    cancel_flag_for, claim_auto_request, enhance_client, release_auto_request, status_for, CancelFlag,
    ChatRequestConfig, EnhanceStatus, Missing, SkipReason, Trigger, UsageDto,
};
use crate::lookup_params::RepairParams;
use crate::search::time_group::TimeMode;
use crate::smart_lookup::{run_for_window, LookupRun};
use crate::smart_model::{
    chat_complete, chat_endpoint, endpoint_host, sends_key_in_clear_text, validate_chat_config, AuthMode, ChatConfig,
};

/// The system prompt (plan Task 6) with the limits from `repair.*`; at the
/// defaults it is Task 6's fixed text, character for character.
fn repair_system(limits: &RepairParams) -> String {
    format!(
        "你为个人笔记检索提供替代检索词。只输出 JSON：{{\"groups\":[{{\"terms\":[…],\"phrases\":[…]}}]}}。至多 {} 组；每组至多 {} 个词、{} 个短语；每项不超过 {} 个字符。不要输出答案、过滤条件、时间、解释或代码围栏。",
        limits.max_groups, limits.max_terms, limits.max_phrases, limits.item_max_chars
    )
}
const TEST_SYSTEM: &str = "只输出 JSON：{\"ok\":true}";
const TEST_USER: &str = "连接测试";
const INVALID_GROUPS: &str = "invalid term groups";

/// One wording: plain terms and quoted phrases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TermGroup {
    pub terms: Vec<String>,
    #[serde(default)]
    pub phrases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepairSuggestion {
    pub status: EnhanceStatus,
    pub skip_reason: Option<SkipReason>,
    pub missing: Option<Missing>,
    pub endpoint_host: Option<String>,
    pub status_class: Option<String>,
    /// Non-empty only when `status` is `ok`.
    pub groups: Vec<TermGroup>,
    pub request_count: u32,
    pub elapsed_ms: u64,
    pub usage: Option<UsageDto>,
}

/// Strict: after trimming, `content` must be a JSON object whose only key is
/// `"groups"`; `1..=max_groups` groups; each group has only `terms`
/// (required) and `phrases`, at most `max_terms` terms and `max_phrases`
/// phrases; each item is `1..=item_max_chars` characters after trimming
/// (defaults 2 / 6 / 2 / 40). Anything else (a code fence, prose, a group too
/// many, an extra key) is an error. The groups then go through
/// [`sanitize_groups`].
pub(crate) fn parse_repair_groups(content: &str, limits: &RepairParams) -> Result<Vec<TermGroup>, String> {
    let invalid = || "invalid repair output".to_string();
    let value: serde_json::Value = serde_json::from_str(content.trim()).map_err(|_| invalid())?;
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != 1 {
        return Err(invalid());
    }
    let raw = object.get("groups").and_then(|g| g.as_array()).ok_or_else(invalid)?;
    if !(1..=limits.max_groups).contains(&raw.len()) {
        return Err(invalid());
    }
    let groups = raw
        .iter()
        .map(|g| serde_json::from_value::<TermGroup>(g.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid())?;
    for group in &groups {
        if group.terms.len() > limits.max_terms || group.phrases.len() > limits.max_phrases {
            return Err(invalid());
        }
        let in_bounds = |item: &String| (1..=limits.item_max_chars).contains(&item.trim().chars().count());
        if !group.terms.iter().chain(&group.phrases).all(in_bounds) {
            return Err(invalid());
        }
    }
    sanitize_groups(groups, limits)
}

/// The same count and length limits, for model output and user edits alike
/// (more than `max_groups` groups, `max_terms` terms, `max_phrases` phrases,
/// or an item over `item_max_chars` characters is an error); then every item
/// through [`sanitize_item`]. Items that clean to nothing and groups left
/// empty are dropped; no group left is an error.
pub(crate) fn sanitize_groups(groups: Vec<TermGroup>, limits: &RepairParams) -> Result<Vec<TermGroup>, String> {
    let invalid = || INVALID_GROUPS.to_string();
    if groups.len() > limits.max_groups {
        return Err(invalid());
    }
    let mut out = Vec::with_capacity(groups.len());
    for group in groups {
        if group.terms.len() > limits.max_terms || group.phrases.len() > limits.max_phrases {
            return Err(invalid());
        }
        if group.terms.iter().chain(&group.phrases).any(|item| item.trim().chars().count() > limits.item_max_chars) {
            return Err(invalid());
        }
        let terms: Vec<String> = group.terms.iter().filter_map(|t| sanitize_item(t, false)).collect();
        let phrases: Vec<String> = group.phrases.iter().filter_map(|p| sanitize_item(p, true)).collect();
        if !terms.is_empty() || !phrases.is_empty() {
            out.push(TermGroup { terms, phrases });
        }
    }
    if out.is_empty() {
        return Err(invalid());
    }
    Ok(out)
}

/// `name:` with an ASCII-letter/underscore name — the shape of a search
/// filter (`tag:x`, `after:…`).
fn looks_like_filter(item: &str) -> bool {
    item.split_once(':')
        .is_some_and(|(name, _)| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphabetic() || c == '_'))
}

/// Removes `"`, `(`, `)`, `*` and leading `-` / `+`; drops filter forms
/// (`letters_or_underscore:…`) and a bare `AND` / `OR` / `NOT`. A term with
/// whitespace is dropped; a phrase's inner whitespace collapses to one
/// space. Nothing left → `None`.
pub(crate) fn sanitize_item(raw: &str, phrase: bool) -> Option<String> {
    let stripped: String = raw.chars().filter(|c| !matches!(c, '"' | '(' | ')' | '*')).collect();
    let item = stripped.trim().trim_start_matches(['-', '+']).trim();
    if item.is_empty() || matches!(item, "AND" | "OR" | "NOT") || looks_like_filter(item) {
        return None;
    }
    if phrase {
        Some(item.split_whitespace().collect::<Vec<_>>().join(" "))
    } else if item.chars().any(char::is_whitespace) {
        None
    } else {
        Some(item.to_string())
    }
}

/// `(system, user)`. The user message carries only the question, its
/// explicit filters, the resolved time range (none when the lookup ignored
/// it) and each arm's kind, terms and hit count — never a hit's text,
/// heading or path.
pub(crate) fn repair_prompt(run: &LookupRun, limits: &RepairParams) -> (String, String) {
    let filters = crate::search::explicit_filters(&run.question);
    let filters = if filters.is_empty() { "无".to_string() } else { filters.join(" ") };
    let time = match &run.time {
        Some(t) if t.mode != TimeMode::Ignore => format!(
            "{} 至 {}（来自「{}」）",
            t.after.format("%Y-%m-%d"),
            t.before.format("%Y-%m-%d"),
            t.source_text
        ),
        _ => "无".to_string(),
    };
    let mut lines = vec![
        format!("问题：{}", run.question),
        format!("过滤：{filters}"),
        format!("时间：{time}"),
        "本地检索：".to_string(),
    ];
    for arm in &run.facts.arms {
        lines.push(format!("- {} [{}] 命中 {}", arm.kind, arm.terms.join("、"), arm.hit_count));
    }
    (repair_system(limits), lines.join("\n"))
}

/// Terms joined by spaces, phrases in double quotes, then the filters.
pub(crate) fn group_query(group: &TermGroup, filters: &[String]) -> String {
    group
        .terms
        .iter()
        .cloned()
        .chain(group.phrases.iter().map(|p| format!("\"{p}\"")))
        .chain(filters.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The configuration check behind both commands: url empty → Url; model
/// empty → Model; unparseable, not http(s), no host or carrying userinfo →
/// Url; plain http to a non-loopback host → Insecure (the key is always a
/// bearer key); no key → Key.
fn check_chat(config: &ChatRequestConfig, key: Option<&str>) -> Result<ChatConfig, Missing> {
    if config.url.trim().is_empty() {
        return Err(Missing::Url);
    }
    if config.model.trim().is_empty() {
        return Err(Missing::Model);
    }
    let Ok(parsed) = reqwest::Url::parse(config.url.trim()) else {
        return Err(Missing::Url);
    };
    if chat_endpoint(&config.url).is_err() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Missing::Url);
    }
    if sends_key_in_clear_text(&parsed, AuthMode::Bearer) {
        return Err(Missing::Insecure);
    }
    let chat = ChatConfig { url: config.url.clone(), model: config.model.clone() };
    // Every rule it applies was checked above; kept as the final word.
    if validate_chat_config(&chat).is_err() {
        return Err(Missing::Url);
    }
    if key.map_or(true, str::is_empty) {
        return Err(Missing::Key);
    }
    Ok(chat)
}

fn chat_host(chat: &ChatConfig) -> Option<String> {
    chat_endpoint(&chat.url).and_then(|e| endpoint_host(&e)).ok()
}

/// Everything `smart_lookup_repair_suggest` needs once the app-bound values
/// are read.
pub(crate) struct RepairRequest<'a> {
    pub run_id: &'a str,
    pub window_label: &'a str,
    pub chat: &'a ChatRequestConfig,
    pub key: Option<&'a str>,
    pub trigger: Trigger,
    /// `repair.*`: the prompt's limits and the reply's.
    pub limits: &'a RepairParams,
    pub timeout: Duration,
}

/// Ask for alternative wordings for a retained run, in this order:
///
/// 1. a repaired run → `Skipped` / `Repaired`;
/// 2. automatic only: hits on the run → `Err`; its automatic request
///    already used → `Skipped` / `AutoBudgetUsed`;
/// 3. configuration → `NotConfigured` (`Url` / `Model` / `Insecure`), no
///    key → `NotConfigured` / `Key`; no consent is needed (Appendix F.6);
/// 4. automatic only: claim the run's one automatic request (the slot the
///    judge shares) — taken meanwhile → `AutoBudgetUsed`;
/// 5. a cancel before sending → `Cancelled`, `request_count` 0, the claim
///    is given back; otherwise one request, raced against the cancel flag;
/// 6. output that does not pass [`parse_repair_groups`] → `Invalid`.
///
/// A user's 「换个说法」 (`Trigger::User`) is a new action: no slot.
pub(crate) async fn repair_run(
    request: RepairRequest<'_>,
    client: &reqwest::Client,
    cancel: &CancelFlag,
) -> Result<RepairSuggestion, String> {
    let started = Instant::now();
    let mut result = repair_steps(request, client, cancel).await?;
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

async fn repair_steps(
    request: RepairRequest<'_>,
    client: &reqwest::Client,
    cancel: &CancelFlag,
) -> Result<RepairSuggestion, String> {
    let run = run_for_window(request.run_id, request.window_label)?;
    let skipped = |reason| RepairSuggestion { skip_reason: Some(reason), ..RepairSuggestion::default() };
    if run.repaired {
        return Ok(skipped(SkipReason::Repaired));
    }
    let auto = request.trigger == Trigger::Auto;
    if auto {
        if run.facts.hit_count != 0 {
            return Err("automatic repair needs zero hits".to_string());
        }
        if run.auto_request_used {
            return Ok(skipped(SkipReason::AutoBudgetUsed));
        }
    }
    let chat = match check_chat(request.chat, request.key) {
        Ok(chat) => chat,
        Err(missing) => {
            return Ok(RepairSuggestion {
                status: EnhanceStatus::NotConfigured,
                missing: Some(missing),
                ..RepairSuggestion::default()
            })
        }
    };
    // `check_chat` refused an empty key.
    let key = request.key.unwrap_or_default();
    let mut result = RepairSuggestion { endpoint_host: chat_host(&chat), ..RepairSuggestion::default() };

    let claim = if auto {
        match claim_auto_request(&run.id, request.window_label)? {
            Some(claim) => Some(claim),
            None => {
                result.skip_reason = Some(SkipReason::AutoBudgetUsed);
                return Ok(result);
            }
        }
    } else {
        None
    };
    if cancel.is_cancelled() {
        if let Some(claim) = claim {
            release_auto_request(claim);
        }
        result.status = EnhanceStatus::Cancelled;
        return Ok(result);
    }
    // Sent from here on: a held claim is kept, never released.

    let (system, user) = repair_prompt(&run, request.limits);
    result.request_count = 1;
    let answer = tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        answer = chat_complete(client, &chat, key, &system, &user, request.timeout) => Some(answer),
    };
    let outcome = match answer {
        None => {
            result.status = EnhanceStatus::Cancelled;
            return Ok(result);
        }
        Some(Err(error)) => {
            let (status, class) = status_for(&error);
            result.status = status;
            result.status_class = class;
            return Ok(result);
        }
        Some(Ok(outcome)) => outcome,
    };
    result.usage = outcome.usage.map(|u| UsageDto { input_tokens: u.input_tokens, output_tokens: u.output_tokens });
    match parse_repair_groups(&outcome.content, request.limits) {
        Ok(groups) => {
            result.status = EnhanceStatus::Ok;
            result.groups = groups;
        }
        Err(_) => result.status = EnhanceStatus::Invalid,
    }
    Ok(result)
}

/// Testable core of `smart_lookup_test_chat`: synthetic text only, no Vault
/// access. `ok` when the reply's content parses as JSON. Waits at most
/// `timeout` (`enhance.timeoutMs` in the app).
pub(crate) async fn run_chat_test(
    client: &reqwest::Client,
    config: &ChatRequestConfig,
    key: Option<&str>,
    timeout: Duration,
) -> ConnectionTest {
    let started = Instant::now();
    let done = |status, missing, host, class| ConnectionTest {
        status,
        missing,
        endpoint_host: host,
        status_class: class,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    let chat = match check_chat(config, key) {
        Ok(chat) => chat,
        Err(missing) => return done(EnhanceStatus::NotConfigured, Some(missing), None, None),
    };
    let host = chat_host(&chat);
    let key = key.unwrap_or_default();
    match chat_complete(client, &chat, key, TEST_SYSTEM, TEST_USER, timeout).await {
        Ok(outcome) if serde_json::from_str::<serde_json::Value>(outcome.content.trim()).is_ok() => {
            done(EnhanceStatus::Ok, None, host, None)
        }
        Ok(_) => done(EnhanceStatus::Invalid, None, host, None),
        Err(e) => {
            let (status, class) = status_for(&e);
            done(status, None, host, class)
        }
    }
}

#[tauri::command]
pub async fn smart_lookup_repair_suggest(
    app: tauri::AppHandle,
    window: tauri::Window,
    lookup_run_id: String,
    chat: ChatRequestConfig,
    trigger: Trigger,
) -> Result<RepairSuggestion, String> {
    // An invalid parameter file is an error before anything else: no request.
    let params = crate::lookup_params::for_app(&app)?;
    let cancel = cancel_flag_for(trigger, &lookup_run_id);
    let key = read_key(&app, KeyKind::Chat);
    let client = enhance_client()?;
    let request = RepairRequest {
        run_id: &lookup_run_id,
        window_label: window.label(),
        chat: &chat,
        key: key.as_deref(),
        trigger,
        limits: &params.repair,
        timeout: params.enhance.timeout(),
    };
    repair_run(request, &client, &cancel).await
}

#[tauri::command]
pub async fn smart_lookup_test_chat(app: tauri::AppHandle, chat: ChatRequestConfig) -> Result<ConnectionTest, String> {
    let timeout = crate::lookup_params::for_app(&app)?.enhance.timeout();
    let key = read_key(&app, KeyKind::Chat);
    let client = enhance_client()?;
    Ok(run_chat_test(&client, &chat, key.as_deref(), timeout).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::time_group::TimeMode;
    use crate::smart_lookup::{ArmFact, CanonicalHit, RouteFacts, RunTime};
    use crate::smart_model::test_support::serve_once;
    use std::sync::atomic::Ordering::SeqCst;
    use std::time::{Duration, Instant};

    fn parse(content: &str) -> Result<Vec<TermGroup>, String> {
        parse_repair_groups(content, &RepairParams::default())
    }

    fn sanitize(groups: Vec<TermGroup>) -> Result<Vec<TermGroup>, String> {
        sanitize_groups(groups, &RepairParams::default())
    }

    /// Task 6's fixed system prompt, verbatim.
    const TASK_6_SYSTEM: &str = "你为个人笔记检索提供替代检索词。只输出 JSON：{\"groups\":[{\"terms\":[…],\"phrases\":[…]}]}。至多 2 组；每组至多 6 个词、2 个短语；每项不超过 40 个字符。不要输出答案、过滤条件、时间、解释或代码围栏。";

    #[test]
    fn repair_prompt_with_default_params_matches_the_fixed_text() {
        let (system, _) = repair_prompt(&run_for("发布 风险"), &RepairParams::default());
        assert_eq!(system, TASK_6_SYSTEM);
        let custom = RepairParams { max_groups: 1, max_terms: 3, max_phrases: 0, item_max_chars: 20 };
        let (system, _) = repair_prompt(&run_for("发布 风险"), &custom);
        assert!(system.contains("至多 1 组；每组至多 3 个词、0 个短语；每项不超过 20 个字符。"), "{system}");
    }

    #[test]
    fn repair_limits_follow_the_params() {
        let one = RepairParams { max_groups: 1, ..RepairParams::default() };
        let two = r#"{"groups":[{"terms":["a"]},{"terms":["b"]}]}"#;
        assert_eq!(parse(two).unwrap().len(), 2);
        assert!(parse_repair_groups(two, &one).is_err());
        assert!(parse_repair_groups(r#"{"groups":[{"terms":["a"]}]}"#, &one).is_ok());
        let g = |terms: &[&str], phrases: &[&str]| TermGroup {
            terms: terms.iter().map(|s| s.to_string()).collect(),
            phrases: phrases.iter().map(|s| s.to_string()).collect(),
        };
        assert!(sanitize_groups(vec![g(&["a"], &[]), g(&["b"], &[])], &one).is_err());
        let few = RepairParams { max_terms: 2, max_phrases: 0, item_max_chars: 8, ..RepairParams::default() };
        assert!(sanitize_groups(vec![g(&["a", "b", "c"], &[])], &few).is_err());
        assert!(sanitize_groups(vec![g(&["a"], &["x y"])], &few).is_err());
        assert!(sanitize_groups(vec![g(&["123456789"], &[])], &few).is_err());
        assert!(parse_repair_groups(r#"{"groups":[{"terms":["123456789"]}]}"#, &few).is_err());
        assert_eq!(sanitize_groups(vec![g(&["12345678", "b"], &[])], &few).unwrap(), vec![g(&["12345678", "b"], &[])]);
        // The widest limits the params file allows (`repair.maxGroups` ≤ 2).
        let wide = RepairParams { max_groups: 2, max_terms: 12, max_phrases: 4, item_max_chars: 80 };
        let long = "长".repeat(80);
        let terms: Vec<String> = (0..12).map(|i| format!("t{i}")).collect();
        let two = format!(
            r#"{{"groups":[{{"terms":["{long}"],"phrases":["p a","p b","p c","p d"]}},{{"terms":{}}}]}}"#,
            serde_json::to_string(&terms).unwrap()
        );
        assert_eq!(parse_repair_groups(&two, &wide).unwrap().len(), 2);
        assert!(parse(&two).is_err());
        let three = r#"{"groups":[{"terms":["a"]},{"terms":["b"]},{"terms":["c"]}]}"#;
        assert!(parse_repair_groups(three, &wide).is_err());
    }

    #[test]
    fn repair_accepts_two_clean_groups() {
        let groups = parse(
            r#" {"groups":[{"terms":["预算","-延期","tag:x"],"phrases":["发布 计划"]},{"terms":["OR","上线"]}]} "#,
        )
        .unwrap();
        assert_eq!(
            groups,
            vec![
                TermGroup { terms: vec!["预算".into(), "延期".into()], phrases: vec!["发布 计划".into()] },
                TermGroup { terms: vec!["上线".into()], phrases: vec![] },
            ]
        );
    }

    #[test]
    fn repair_rejects_fenced_or_oversized_output() {
        for bad in [
            "```json\n{\"groups\":[{\"terms\":[\"a\"]}]}\n```",
            r#"{"groups":[{"terms":["a"]},{"terms":["b"]},{"terms":["c"]}]}"#,
            r#"{"groups":[{"terms":["1","2","3","4","5","6","7"]}]}"#,
            r#"{"groups":[{"terms":["a"],"phrases":["x","y","z"]}]}"#,
            &format!(r#"{{"groups":[{{"terms":["{}"]}}]}}"#, "长".repeat(41)),
            r#"{"groups":[{"terms":["a"]}],"answer":"…"}"#,
            r#"{"groups":[]}"#,
            r#"{"groups":[{"terms":["AND"]}]}"#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        // Extra keys inside a group, an empty item and a non-object are refused too.
        for bad in [
            r#"{"groups":[{"terms":["a"],"why":"x"}]}"#,
            r#"{"groups":[{"terms":["a","  "]}]}"#,
            r#"[{"terms":["a"]}]"#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        // Exactly at the limits is fine.
        let edge = format!(r#"{{"groups":[{{"terms":["1","2","3","4","5","{}"],"phrases":["x y","z"]}}]}}"#, "长".repeat(40));
        assert_eq!(parse(&edge).unwrap()[0].terms.len(), 6);
    }

    #[test]
    fn items_lose_dsl_operators_and_filters() {
        assert_eq!(sanitize_item(" +\"预算\"* ", false).as_deref(), Some("预算"));
        assert_eq!(sanitize_item("(release)", false).as_deref(), Some("release"));
        assert_eq!(sanitize_item("--延期", false).as_deref(), Some("延期"));
        assert_eq!(sanitize_item("tag:work", false), None);
        assert_eq!(sanitize_item("after_x:2026", false), None);
        assert_eq!(sanitize_item("NOT", false), None);
        assert_eq!(sanitize_item("two words", false), None);
        assert_eq!(sanitize_item("\"\"", false), None);
        assert_eq!(sanitize_item("  发布   计划 ", true).as_deref(), Some("发布 计划"));
        assert_eq!(sanitize_item("-\"发布 计划\"", true).as_deref(), Some("发布 计划"));
        assert_eq!(sanitize_item("path:docs/a", true), None);
        // A colon that is not a filter prefix stays.
        assert_eq!(sanitize_item("12:30", false).as_deref(), Some("12:30"));
    }

    #[test]
    fn edited_groups_get_the_same_limits_and_empty_groups_are_dropped() {
        let g = |terms: &[&str], phrases: &[&str]| TermGroup {
            terms: terms.iter().map(|s| s.to_string()).collect(),
            phrases: phrases.iter().map(|s| s.to_string()).collect(),
        };
        assert_eq!(sanitize(vec![g(&["AND"], &[]), g(&["上线", ""], &[])]).unwrap(), vec![g(&["上线"], &[])]);
        assert_eq!(sanitize(vec![g(&["OR"], &["  "])]).unwrap_err(), "invalid term groups");
        assert!(sanitize(vec![]).is_err());
        assert!(sanitize(vec![g(&["a"], &[]), g(&["b"], &[]), g(&["c"], &[])]).is_err());
        assert!(sanitize(vec![g(&["1", "2", "3", "4", "5", "6", "7"], &[])]).is_err());
        assert!(sanitize(vec![g(&["a"], &["x", "y", "z"])]).is_err());
        assert!(sanitize(vec![g(&[&"长".repeat(41)], &[])]).is_err());
    }

    #[test]
    fn a_group_query_quotes_phrases_and_keeps_the_explicit_filters() {
        let group = TermGroup { terms: vec!["预算".into(), "延期".into()], phrases: vec!["发布 计划".into()] };
        assert_eq!(group_query(&group, &["tag:work".to_string()]), r#"预算 延期 "发布 计划" tag:work"#);
        assert_eq!(group_query(&TermGroup { terms: vec!["a".into()], phrases: vec![] }, &[]), "a");
    }

    fn run_for(question: &str) -> LookupRun {
        LookupRun {
            id: uuid::Uuid::now_v7().to_string(),
            created_at: Instant::now(),
            window_label: "test-repair".into(),
            root: std::path::PathBuf::from("/vault"),
            question: question.into(),
            hits: vec![CanonicalHit {
                result_id: "r1".into(),
                path: "notes/a.md".into(),
                line: 1,
                line_end: 1,
                level: "line".into(),
                indexed_text: "NOTE_BODY secret".into(),
                breadcrumb: "NOTE_HEADING".into(),
                pinned: false,
            }],
            facts: RouteFacts {
                hit_count: 0,
                pinned: false,
                extracted_terms: vec!["发布".into(), "风险".into()],
                arms: vec![
                    ArmFact { kind: "strict".into(), terms: vec!["发布".into(), "风险".into()], hit_count: 0 },
                    ArmFact { kind: "relaxed".into(), terms: vec!["发布".into()], hit_count: 0 },
                ],
            },
            time: None,
            auto_request_used: false,
            repaired: false,
            auto_claim: None,
            judgement: None,
            evidence: None,
            evidence_busy: false,
        }
    }

    #[test]
    fn the_repair_prompt_carries_no_note_text() {
        let mut run = run_for("上周 发布 风险 tag:work");
        run.time = Some(RunTime {
            source_text: "上周".into(),
            after: chrono::NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
            before: chrono::NaiveDate::from_ymd_opt(2026, 11, 8).unwrap(),
            mode: TimeMode::Group,
            in_window: 0,
        });
        let (system, user) = repair_prompt(&run, &RepairParams::default());
        assert!(system.contains("至多 2 组"));
        assert!(user.contains("问题：上周 发布 风险 tag:work") && user.contains("命中 0"));
        assert!(!user.contains("NOTE_BODY") && !user.contains("NOTE_HEADING") && !user.contains(".md"));
        let lines: Vec<&str> = user.lines().collect();
        assert_eq!(
            lines,
            [
                "问题：上周 发布 风险 tag:work",
                "过滤：tag:work",
                "时间：2026-11-02 至 2026-11-08（来自「上周」）",
                "本地检索：",
                "- strict [发布、风险] 命中 0",
                "- relaxed [发布] 命中 0",
            ]
        );
        let (_, plain) = repair_prompt(&run_for("发布 风险"), &RepairParams::default());
        assert!(plain.contains("过滤：无\n时间：无\n"), "{plain}");
        // A lookup told to ignore the phrase searched without the range.
        run.time.as_mut().unwrap().mode = TimeMode::Ignore;
        assert!(repair_prompt(&run, &RepairParams::default()).1.contains("\n时间：无\n"));
    }

    // ---- the command core -------------------------------------------------

    const TIMEOUT: Duration = Duration::from_millis(500);
    const WAIT: Duration = Duration::from_secs(3);

    fn chat(base: &str) -> ChatRequestConfig {
        ChatRequestConfig { url: base.into(), model: "m".into() }
    }

    fn reply(content: &str) -> String {
        serde_json::json!({"choices":[{"message":{"content":content}}],"usage":{"prompt_tokens":40,"completion_tokens":12}})
            .to_string()
    }

    const GOOD: &str = r#"{"groups":[{"terms":["预算"]},{"terms":["记录"],"phrases":["发布 计划"]}]}"#;

    fn register(run: &LookupRun) -> String {
        crate::smart_lookup::insert_run_for_test(run.clone());
        run.id.clone()
    }

    async fn suggest(
        run: &LookupRun,
        cfg: &ChatRequestConfig,
        key: Option<&str>,
        trigger: Trigger,
        cancel: &CancelFlag,
    ) -> Result<RepairSuggestion, String> {
        let request = RepairRequest {
            run_id: &run.id,
            window_label: &run.window_label,
            chat: cfg,
            key,
            trigger,
            limits: &RepairParams::default(),
            timeout: TIMEOUT,
        };
        repair_run(request, &enhance_client().unwrap(), cancel).await
    }

    fn slot(run: &LookupRun) -> (bool, Option<u64>) {
        let r = crate::smart_lookup::run_for_window(&run.id, &run.window_label).unwrap();
        (r.auto_request_used, r.auto_claim)
    }

    #[tokio::test]
    async fn an_automatic_repair_sends_only_the_question_facts_and_takes_the_runs_slot() {
        let run = run_for("上周 发布 风险 tag:work");
        register(&run);
        let (base, request, accepted) = serve_once(200, reply(GOOD), Duration::ZERO).await;
        let r = suggest(&run, &chat(&base), Some("ck"), Trigger::Auto, &CancelFlag::new()).await.unwrap();
        assert_eq!(r.status, EnhanceStatus::Ok);
        assert_eq!(r.groups.len(), 2);
        assert_eq!(r.groups[1].phrases, ["发布 计划"]);
        assert_eq!(r.request_count, 1);
        assert!(r.endpoint_host.unwrap().starts_with("127.0.0.1:"));
        assert_eq!(r.usage.map(|u| (u.input_tokens, u.output_tokens)), Some((40, 12)));
        let request = request.await.unwrap();
        assert!(request.contains("authorization: bearer ck") && request.contains("/chat/completions"), "{request}");
        assert!(request.contains("tag:work") && request.contains("命中 0"), "{request}");
        assert!(!request.contains("note_body") && !request.contains("note_heading") && !request.contains(".md"), "{request}");
        assert!(slot(&run).0, "a sent automatic repair keeps the claim");

        // The run's one automatic request is used: a second automatic one (or
        // a judge) is skipped, a user's 「换个说法」 is not limited.
        let again = suggest(&run, &chat(&base), Some("ck"), Trigger::Auto, &CancelFlag::new()).await.unwrap();
        assert_eq!((again.status, again.skip_reason), (EnhanceStatus::Skipped, Some(SkipReason::AutoBudgetUsed)));
        assert_eq!(again.request_count, 0);
        let user = suggest(&run, &chat(&base), Some("ck"), Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!(user.status, EnhanceStatus::Ok);
        assert_eq!(accepted.load(SeqCst), 2);
    }

    #[tokio::test]
    async fn a_repair_that_sends_nothing_gives_the_automatic_slot_back() {
        let run = run_for("发布 风险");
        register(&run);
        let (base, _request, accepted) = serve_once(200, reply(GOOD), Duration::ZERO).await;

        let insecure = suggest(&run, &chat("http://a.example/v1"), Some("ck"), Trigger::Auto, &CancelFlag::new())
            .await
            .unwrap();
        assert_eq!((insecure.status, insecure.missing), (EnhanceStatus::NotConfigured, Some(Missing::Insecure)));
        let no_model = ChatRequestConfig { model: " ".into(), ..chat(&base) };
        let r = suggest(&run, &no_model, Some("ck"), Trigger::Auto, &CancelFlag::new()).await.unwrap();
        assert_eq!(r.missing, Some(Missing::Model));
        let r = suggest(&run, &chat(""), Some("ck"), Trigger::Auto, &CancelFlag::new()).await.unwrap();
        assert_eq!(r.missing, Some(Missing::Url));
        let no_key = suggest(&run, &chat(&base), None, Trigger::Auto, &CancelFlag::new()).await.unwrap();
        assert_eq!((no_key.status, no_key.missing), (EnhanceStatus::NotConfigured, Some(Missing::Key)));
        assert_eq!(slot(&run), (false, None));

        let cancel = CancelFlag::new();
        cancel.cancel();
        let cancelled = suggest(&run, &chat(&base), Some("ck"), Trigger::Auto, &cancel).await.unwrap();
        assert_eq!((cancelled.status, cancelled.request_count), (EnhanceStatus::Cancelled, 0));
        assert_eq!(slot(&run), (false, None));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn invalid_model_output_or_an_error_returns_no_groups_and_no_detail() {
        let run = run_for("发布 风险");
        register(&run);
        for body in [reply("```json\n{\"groups\":[{\"terms\":[\"a\"]}]}\n```"), reply("not json"), r#"{"choices":[]}"#.to_string()] {
            let (base, _request, _accepted) = serve_once(200, body.clone(), Duration::ZERO).await;
            let r = suggest(&run, &chat(&base), Some("ck"), Trigger::User, &CancelFlag::new()).await.unwrap();
            assert_eq!(r.status, EnhanceStatus::Invalid, "{body}");
            assert!(r.groups.is_empty() && r.request_count == 1);
        }
        let (base, _request, _accepted) = serve_once(401, "<html>LEAK sk-live</html>", Duration::ZERO).await;
        let denied = suggest(&run, &chat(&base), Some("ck"), Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!((denied.status, denied.status_class.as_deref()), (EnhanceStatus::KeyInvalid, Some("4xx")));
        let json = serde_json::to_string(&denied).unwrap();
        assert!(!json.contains("LEAK") && !json.contains("sk-live") && !json.contains("ck"), "{json}");

        let (base, _request, _accepted) = serve_once(200, reply(GOOD), Duration::from_secs(2)).await;
        let slow = suggest(&run, &chat(&base), Some("ck"), Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!(slow.status, EnhanceStatus::Timeout);
    }

    #[tokio::test]
    async fn a_repaired_run_or_an_automatic_repair_with_hits_is_not_repaired() {
        let mut repaired = run_for("发布 风险");
        repaired.repaired = true;
        repaired.auto_request_used = true;
        register(&repaired);
        let (base, _request, accepted) = serve_once(200, reply(GOOD), Duration::ZERO).await;
        for trigger in [Trigger::Auto, Trigger::User] {
            let r = suggest(&repaired, &chat(&base), Some("ck"), trigger, &CancelFlag::new()).await.unwrap();
            assert_eq!((r.status, r.skip_reason), (EnhanceStatus::Skipped, Some(SkipReason::Repaired)));
        }

        let mut found = run_for("发布 风险");
        found.facts.hit_count = 3;
        register(&found);
        let err = suggest(&found, &chat(&base), Some("ck"), Trigger::Auto, &CancelFlag::new()).await.unwrap_err();
        assert_eq!(err, "automatic repair needs zero hits");
        assert_eq!(slot(&found), (false, None));
        // The user's 「换个说法」 after unfit results is allowed.
        let user = suggest(&found, &chat(&base), Some("ck"), Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!(user.status, EnhanceStatus::Ok);
        assert_eq!(accepted.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn a_judge_that_took_the_slot_leaves_no_automatic_repair() {
        let run = run_for("发布 风险");
        register(&run);
        let claim = claim_auto_request(&run.id, &run.window_label).unwrap().expect("free slot");
        let (base, _request, accepted) = serve_once(200, reply(GOOD), Duration::ZERO).await;
        let r = suggest(&run, &chat(&base), Some("ck"), Trigger::Auto, &CancelFlag::new()).await.unwrap();
        assert_eq!(r.skip_reason, Some(SkipReason::AutoBudgetUsed));
        drop(claim);
        assert!(slot(&run).0);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn the_chat_connection_test_sends_synthetic_text_only() {
        let client = enhance_client().unwrap();
        let (base, request, _) = serve_once(200, reply(r#"{"ok":true}"#), Duration::ZERO).await;
        let ok = run_chat_test(&client, &chat(&base), Some("ck"), WAIT).await;
        assert_eq!(ok.status, EnhanceStatus::Ok);
        let request = request.await.unwrap();
        assert!(request.contains("连接测试") && request.contains("authorization: bearer ck"), "{request}");

        let (base, _request, _) = serve_once(200, reply("hello"), Duration::ZERO).await;
        assert_eq!(run_chat_test(&client, &chat(&base), Some("ck"), WAIT).await.status, EnhanceStatus::Invalid);
        let none = run_chat_test(&client, &chat("https://a.example/v1"), None, WAIT).await;
        assert_eq!((none.status, none.missing), (EnhanceStatus::NotConfigured, Some(Missing::Key)));
        let insecure = run_chat_test(&client, &chat("http://a.example/v1"), Some("ck"), WAIT).await;
        assert_eq!(insecure.missing, Some(Missing::Insecure));
    }
}
