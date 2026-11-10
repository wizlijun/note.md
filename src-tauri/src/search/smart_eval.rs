//! Offline evaluation: the local lookup baseline (experiment E1, `#[ignore]`
//! tests) and the full-pipeline eval behind `notemd lookup eval` (spec
//! Appendix G.6).
//!
//! E1 costs nothing: it runs the
//! existing local smart search over a copy of a real index and records where
//! each task's target lands, so the pre-gates of feasibility spec §9.3 can
//! decide which paid experiments are worth running at all. Plan Tasks 3–4.
//!
#![allow(dead_code)]

use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Instant;

use chrono::NaiveDate;
use searchidx::query::{Conventions, Weights};
use searchidx::{Limits, Query};
use serde::{Deserialize, Serialize};

use super::smart::{smart_search_locked, SmartHitDto};
use crate::lookup_params::FusionParams;
use super::time_group::{group_by_time, time_scoped_query};
use super::time_phrase::detect_time_phrase;
use super::IndexHandle;

/// Where a task expects its answer. `line` narrows the match to the block
/// that covers that 1-based line; without it any hit in the file counts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EvalTarget {
    pub path: String,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Category {
    Exact,
    Colloquial,
    Synonym,
    Time,
    Homonym,
    Bridge,
    /// The material does not exist in the vault; the right answer is nothing.
    Absent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Split {
    Dev,
    Holdout,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EvalTask {
    pub id: String,
    pub question: String,
    pub targets: Vec<EvalTarget>,
    pub category: Category,
    pub split: Split,
    /// The task only works if a typed constraint (origin, type, tag…) is
    /// inferred from natural language, which the direct mode does not do.
    #[serde(default)]
    pub needs_inferred_constraint: bool,
}

/// Parse and validate a task file shaped `{"tasks":[…]}`.
///
/// Every error names the offending task id. Rejected: an empty list, a
/// duplicate id, an empty question, an `absent` task that lists targets, any
/// other task without targets, and a target path that is empty, absolute or
/// contains `..`. Accepted target paths are normalised to the index's
/// spelling: forward slashes only, no `.` or empty segments (`./a//b.md` →
/// `a/b.md`).
pub(crate) fn load_tasks(json: &str) -> Result<Vec<EvalTask>, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TaskFile {
        tasks: Vec<EvalTask>,
    }
    let mut file: TaskFile = serde_json::from_str(json).map_err(|e| format!("task file: {e}"))?;
    if file.tasks.is_empty() {
        return Err("task file: no tasks".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for task in &mut file.tasks {
        let id = &task.id;
        if !seen.insert(id.clone()) {
            return Err(format!("task {id}: duplicate id"));
        }
        if task.question.trim().is_empty() {
            return Err(format!("task {id}: empty question"));
        }
        match (task.category == Category::Absent, task.targets.is_empty()) {
            (true, false) => return Err(format!("task {id}: an absent task must not list targets")),
            (false, true) => return Err(format!("task {id}: no targets")),
            _ => {}
        }
        for target in &mut task.targets {
            let normalised = normalise_target_path(&target.path);
            let escapes = normalised.split('/').any(|segment| segment == "..");
            if normalised.trim().is_empty()
                || target.path.starts_with(['/', '\\'])
                || Path::new(&target.path).is_absolute()
                || escapes
            {
                return Err(format!(
                    "task {id}: target path {:?} must be a non-empty relative path without `..`",
                    target.path
                ));
            }
            target.path = normalised;
        }
    }
    Ok(file.tasks)
}

/// `./notes//a.md` and `notes\\a.md` → `notes/a.md`: the vault-relative,
/// `/`-separated spelling the index stores. Case and Unicode form are kept
/// as written; a mismatch there is reported by `run_e1` as not indexed.
fn normalise_target_path(path: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/")
}

/// The best 1-based rank among `targets`, with the level of the block that
/// matched. A hit matches when the paths are equal and the target's line is
/// absent or lies inside `[hit.line, hit.line_end]`.
pub(crate) fn target_rank(hits: &[SmartHitDto], targets: &[EvalTarget]) -> Option<(usize, String)> {
    hits.iter().enumerate().find_map(|(index, hit)| {
        let matched = targets.iter().any(|target| {
            target.path == hit.hit.path
                && target
                    .line
                    .map_or(true, |line| hit.hit.line <= line && line <= hit.hit.line_end)
        });
        matched.then(|| (index + 1, hit.hit.level.clone()))
    })
}

/// One task's outcome on the local baseline.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct E1Row {
    pub id: String,
    pub category: Category,
    pub split: Split,
    /// False when a target path is not a file in the index exactly as
    /// written (a typo, wrong case, another Unicode form, or a file the
    /// index excludes): such a target can never match a hit. These rows are
    /// excluded from every gate instead of being counted as "not recalled".
    pub target_indexed: bool,
    pub rank: Option<usize>,
    pub level: Option<String>,
    /// Share of line-level blocks among the first 30 hits.
    pub line_share_top30: f64,
    pub local_ms: u64,
    /// Rank after the bounded deep scan, tried only when the shallow search
    /// missed.
    pub deep_rank: Option<usize>,
    pub deep_ms: Option<u64>,
    pub time_detected: bool,
    /// Rank after soft time grouping, when a time phrase was detected.
    pub grouped_rank: Option<usize>,
    pub needs_inferred_constraint: bool,
}

/// The zero-cost verdicts that decide what is worth a paid experiment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreGates {
    pub scored_tasks: usize,
    pub rank_6_to_50: usize,
    pub c3_worth_testing: bool,
    pub unrecalled_after_deep: usize,
    pub c4_worth_testing: bool,
    pub rollup_share: f64,
    pub rollup_excerpt_required: bool,
    pub time_tasks: usize,
    pub c2_grouping_ok: Option<bool>,
    pub inferred_constraint_tasks: usize,
    pub constraint_inference_worth_evaluating: bool,
}

/// Apply the thresholds confirmed in feasibility spec §9.3 to the rows whose
/// `target_indexed` is true:
///
/// - C3 (candidate judging) is worth testing when ≥ 6 targets rank 6..=50.
/// - C4 (query repair) is worth testing when ≥ 4 non-absent tasks are missed
///   by both the shallow search and the deep scan.
/// - Rollup excerpts are required when ≥ 25% of recalled targets matched as a
///   section- or file-level block.
/// - C2 (time grouping) is acceptable when, among time tasks, at least as
///   many targets are in the top 5 after grouping as before; `None` when
///   there is no time task.
/// - Constraint inference is worth evaluating when ≥ 4 tasks depend on it.
pub(super) fn pre_gates(rows: &[E1Row]) -> PreGates {
    let scored: Vec<&E1Row> = rows.iter().filter(|r| r.target_indexed).collect();
    let rank_6_to_50 = scored
        .iter()
        .filter(|r| r.rank.is_some_and(|rank| (6..=50).contains(&rank)))
        .count();
    let unrecalled_after_deep = scored
        .iter()
        .filter(|r| r.category != Category::Absent && r.rank.is_none() && r.deep_rank.is_none())
        .count();
    let recalled = scored.iter().filter(|r| r.rank.is_some()).count();
    let rolled_up = scored
        .iter()
        .filter(|r| {
            r.rank.is_some() && matches!(r.level.as_deref(), Some("section") | Some("file"))
        })
        .count();
    let rollup_share = if recalled == 0 { 0.0 } else { rolled_up as f64 / recalled as f64 };
    let timed: Vec<&&E1Row> = scored.iter().filter(|r| r.time_detected).collect();
    let within_5 = |rank: Option<usize>| rank.is_some_and(|rank| rank <= 5);
    let c2_grouping_ok = if timed.is_empty() {
        None
    } else {
        let before = timed.iter().filter(|r| within_5(r.rank)).count();
        let after = timed.iter().filter(|r| within_5(r.grouped_rank)).count();
        Some(after >= before)
    };
    let inferred_constraint_tasks = scored.iter().filter(|r| r.needs_inferred_constraint).count();
    PreGates {
        scored_tasks: scored.len(),
        rank_6_to_50,
        c3_worth_testing: rank_6_to_50 >= 6,
        unrecalled_after_deep,
        c4_worth_testing: unrecalled_after_deep >= 4,
        rollup_share,
        rollup_excerpt_required: rollup_share >= 0.25,
        time_tasks: timed.len(),
        c2_grouping_ok,
        inferred_constraint_tasks,
        constraint_inference_worth_evaluating: inferred_constraint_tasks >= 4,
    }
}

/// Whether `path` is a file of the index behind `handle`, spelled exactly as
/// indexed — the same comparison `target_rank` makes. Read-only: a `path:`
/// filter-only query (a substring `LIKE`), then an exact match on the
/// returned paths.
fn indexed_file(handle: &IndexHandle, path: &str) -> Result<bool, String> {
    let guard = handle.lock().map_err(|_| "search index lock poisoned".to_string())?;
    let idx = guard.as_ref().ok_or_else(|| "search index not ready".to_string())?;
    let query = Query { paths: vec![path.to_string()], ..Default::default() };
    let answer = idx.search_query_ranked(
        &query,
        searchidx::NO_LIMIT,
        &Limits { deep: false, abort: None },
        &Weights::default(),
        &Conventions::default(),
    )?;
    Ok(answer.hits.iter().any(|hit| hit.path == path))
}

/// Score every task against the index behind `handle`.
///
/// Per task (plan Task 4): a shallow smart search with limit 50; a deep scan
/// (4 000 ms) only when the shallow search missed an existing target; and,
/// when `detect_time_phrase` finds a phrase, a second shallow search with
/// `time_scoped_query` grouped by `group_by_time`.
pub(super) fn run_e1(
    handle: &IndexHandle,
    tasks: &[EvalTask],
    today: NaiveDate,
) -> Result<Vec<E1Row>, String> {
    let counter = Arc::new(AtomicU64::new(1));
    // E1 measures the local baseline at the default fusion constants.
    let fusion = FusionParams::default();
    let search = |question: &str, deep: bool| {
        smart_search_locked(
            handle,
            Instant::now(),
            question,
            Some(50),
            Some(deep),
            deep.then_some(4_000),
            &counter,
            1,
            &fusion,
        )
    };
    let mut rows = Vec::with_capacity(tasks.len());
    for task in tasks {
        let absent = task.category == Category::Absent;
        let mut target_indexed = true;
        if !absent {
            for target in &task.targets {
                target_indexed &= indexed_file(handle, &target.path)?;
            }
        }

        let shallow = search(&task.question, false)?;
        let found = target_rank(&shallow.hits, &task.targets);
        let top = shallow.hits.len().min(30);
        let line_share_top30 = if top == 0 {
            0.0
        } else {
            shallow.hits[..top].iter().filter(|h| h.hit.level == "line").count() as f64
                / top as f64
        };

        let (mut deep_rank, mut deep_ms) = (None, None);
        if found.is_none() && target_indexed && !absent {
            let deep = search(&task.question, true)?;
            deep_rank = target_rank(&deep.hits, &task.targets).map(|(rank, _)| rank);
            deep_ms = Some(deep.took_ms);
        }

        let (mut time_detected, mut grouped_rank) = (false, None);
        if let Some(time) = detect_time_phrase(&task.question, today)? {
            time_detected = true;
            let scoped = search(&time_scoped_query(&task.question, &time), false)?;
            let grouped = group_by_time(scoped.hits, shallow.hits, 50);
            grouped_rank = target_rank(&grouped.hits, &task.targets).map(|(rank, _)| rank);
        }

        rows.push(E1Row {
            id: task.id.clone(),
            category: task.category,
            split: task.split,
            target_indexed,
            rank: found.as_ref().map(|(rank, _)| *rank),
            level: found.map(|(_, level)| level),
            line_share_top30,
            local_ms: shallow.took_ms,
            deep_rank,
            deep_ms,
            time_detected,
            grouped_rank,
            needs_inferred_constraint: task.needs_inferred_constraint,
        });
    }
    Ok(rows)
}

/// How often the user's correction agreed with the model's tier, from the
/// local feedback log. Only fit and unfit tiers are decided; an unsure tier
/// has no side to agree with, so its corrections are only counted.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FeedbackAgreement {
    pub rows: usize,
    pub decided: usize,
    pub agreed: usize,
    /// (rows the model tiered fit, of which the user also marked fit)
    pub fit: (usize, usize),
    /// (rows the model tiered unfit, of which the user also marked unfit)
    pub unfit: (usize, usize),
    pub unsure_marked_fit: usize,
    pub unsure_marked_unfit: usize,
    pub rate: Option<f64>,
}

/// Blank lines are skipped; a malformed line fails the whole read and names
/// its 1-based line number. Rows are deduped by (question, path, line,
/// lineEnd, endpointHost, model) and the last one wins (ledger ruling, Task
/// 7): a user who clicks twice, or changes their mind, counts once, with
/// their final verdict.
pub(super) fn feedback_agreement(jsonl: &str) -> Result<FeedbackAgreement, String> {
    use crate::smart_enhance::feedback::{FeedbackRow, UserVerdict};
    use crate::smart_enhance::Tier;
    let mut rows: Vec<FeedbackRow> = Vec::new();
    let mut at: std::collections::HashMap<(String, String, u32, u32, String, String), usize> =
        std::collections::HashMap::new();
    for (index, line) in jsonl.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let row: FeedbackRow =
            serde_json::from_str(line).map_err(|e| format!("feedback line {}: {e}", index + 1))?;
        let key = (
            row.question.clone(),
            row.path.clone(),
            row.line,
            row.line_end,
            row.endpoint_host.clone(),
            row.model.clone(),
        );
        match at.get(&key) {
            Some(&i) => rows[i] = row,
            None => {
                at.insert(key, rows.len());
                rows.push(row);
            }
        }
    }
    let mut a = FeedbackAgreement::default();
    for row in rows {
        a.rows += 1;
        let agrees = match (row.model_tier, row.user_verdict) {
            (Tier::Fit, UserVerdict::Fit) | (Tier::Unfit, UserVerdict::Unfit) => true,
            _ => false,
        };
        match row.model_tier {
            Tier::Fit => {
                a.fit.0 += 1;
                a.fit.1 += usize::from(agrees);
            }
            Tier::Unfit => {
                a.unfit.0 += 1;
                a.unfit.1 += usize::from(agrees);
            }
            Tier::Unsure => match row.user_verdict {
                UserVerdict::Fit => a.unsure_marked_fit += 1,
                UserVerdict::Unfit => a.unsure_marked_unfit += 1,
            },
        }
        if row.model_tier != Tier::Unsure {
            a.decided += 1;
            a.agreed += usize::from(agrees);
        }
    }
    a.rate = (a.decided > 0).then(|| a.agreed as f64 / a.decided as f64);
    Ok(a)
}

// ---- the full pipeline: `notemd lookup eval` (spec Appendix G.6) ----------

use crate::lookup_params::LookupParams;
use crate::smart_enhance::pipeline::{run_pipeline, EnhanceSetup, PipelineInput, PipelineRoute};
use crate::smart_enhance::{EnhanceStatus, Tier};

/// The window label every eval run is registered under.
pub(crate) const EVAL_WINDOW: &str = "cli-eval";

/// One task's outcome on the full pipeline; one line of `--out`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LookupEvalRow {
    pub id: String,
    pub category: Category,
    pub split: Split,
    pub target_indexed: bool,
    pub local_rank: Option<usize>,
    pub final_rank: Option<usize>,
    pub route: PipelineRoute,
    pub status: Option<EnhanceStatus>,
    pub request_count: u32,
    pub reused: bool,
    /// 目标块在发送给模型的候选里。
    pub target_in_window: bool,
    pub any_fit: bool,
    pub local_ms: u64,
    pub enhance_ms: Option<u64>,
    pub estimated_tokens: u64,
    pub input_tokens: Option<u64>,
}

/// §9.3's metrics for one split of the rows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LookupMetrics {
    pub split: String,
    pub tasks: usize,
    pub scored: usize,
    pub top5_local: usize,
    pub top5_final: usize,
    pub net_gain: i64,
    pub pushed_out: usize,
    pub absent_tasks: usize,
    pub absent_false_fit: usize,
    pub absent_false_fit_rate: Option<f64>,
    pub top50_coverage: Option<f64>,
    pub window_coverage: Option<f64>,
    pub requests: usize,
    pub timeouts: usize,
    pub timeout_rate: Option<f64>,
    pub local_p50_ms: Option<u64>,
    pub local_p95_ms: Option<u64>,
    pub enhance_p50_ms: Option<u64>,
    pub enhance_p95_ms: Option<u64>,
    pub input_tokens: u64,
    pub usage_unknown: usize,
    pub estimated_tokens: u64,
}

/// The holdout gates of spec §9.3; `None` when no task can be scored.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GateVerdicts {
    pub c3: Option<bool>,
    pub c4: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricDelta {
    pub metric: String,
    pub current: Option<f64>,
    pub baseline: Option<f64>,
    pub delta: Option<f64>,
}

/// 最近秩：升序排序后取第 ceil(p·n) 个（从 1 起）；空集为 None。
pub(crate) fn percentile(values: &[u64], p: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let n = sorted.len();
    let rank = ((p * n as f64).ceil() as usize).clamp(1, n);
    Some(sorted[rank - 1])
}

fn ratio(part: usize, whole: usize) -> Option<f64> {
    (whole > 0).then(|| part as f64 / whole as f64)
}

fn in_top(rank: Option<usize>, n: usize) -> bool {
    rank.is_some_and(|r| r <= n)
}

fn is_scored(row: &LookupEvalRow) -> bool {
    row.category != Category::Absent && row.target_indexed
}

/// `split` is `"all"`, `"dev"` or `"holdout"`. Scored: not `absent` and the
/// target is in the index. Requests: rows with `request_count == 1`; the
/// timeout rate, enhance latencies and token sums are over those. Local
/// latencies are over every row of the split.
pub(crate) fn lookup_metrics(rows: &[LookupEvalRow], split: &str) -> LookupMetrics {
    let rows: Vec<&LookupEvalRow> = rows
        .iter()
        .filter(|r| match split {
            "dev" => r.split == Split::Dev,
            "holdout" => r.split == Split::Holdout,
            _ => true,
        })
        .collect();
    let scored: Vec<&&LookupEvalRow> = rows.iter().filter(|r| is_scored(r)).collect();
    let top5_local = scored.iter().filter(|r| in_top(r.local_rank, 5)).count();
    let top5_final = scored.iter().filter(|r| in_top(r.final_rank, 5)).count();
    let gained = scored.iter().filter(|r| in_top(r.final_rank, 5) && !in_top(r.local_rank, 5)).count();
    let pushed_out = scored.iter().filter(|r| in_top(r.local_rank, 5) && !in_top(r.final_rank, 5)).count();
    let absent: Vec<&&LookupEvalRow> = rows.iter().filter(|r| r.category == Category::Absent).collect();
    let absent_false_fit = absent.iter().filter(|r| r.any_fit).count();
    let judged: Vec<&&&LookupEvalRow> = scored.iter().filter(|r| r.request_count == 1 || r.reused).collect();
    let requests: Vec<&&LookupEvalRow> = rows.iter().filter(|r| r.request_count == 1).collect();
    let timeouts = requests.iter().filter(|r| r.status == Some(EnhanceStatus::Timeout)).count();
    let local_ms: Vec<u64> = rows.iter().map(|r| r.local_ms).collect();
    let enhance_ms: Vec<u64> = requests.iter().filter_map(|r| r.enhance_ms).collect();
    LookupMetrics {
        split: split.to_string(),
        tasks: rows.len(),
        scored: scored.len(),
        top5_local,
        top5_final,
        net_gain: gained as i64 - pushed_out as i64,
        pushed_out,
        absent_tasks: absent.len(),
        absent_false_fit,
        absent_false_fit_rate: ratio(absent_false_fit, absent.len()),
        top50_coverage: ratio(scored.iter().filter(|r| in_top(r.local_rank, 50)).count(), scored.len()),
        window_coverage: ratio(judged.iter().filter(|r| r.target_in_window).count(), judged.len()),
        requests: requests.len(),
        timeouts,
        timeout_rate: ratio(timeouts, requests.len()),
        local_p50_ms: percentile(&local_ms, 0.5),
        local_p95_ms: percentile(&local_ms, 0.95),
        enhance_p50_ms: percentile(&enhance_ms, 0.5),
        enhance_p95_ms: percentile(&enhance_ms, 0.95),
        input_tokens: requests.iter().filter_map(|r| r.input_tokens).sum(),
        usage_unknown: requests.iter().filter(|r| r.input_tokens.is_none()).count(),
        estimated_tokens: requests.iter().map(|r| r.estimated_tokens).sum(),
    }
}

/// Spec §9.3 on the holdout rows. C3: net Top-5 gain ≥ 3, at most one
/// target pushed out, timeouts ≤ 5% of requests, and at most a third of the
/// absent tasks with a candidate judged fit. C4: of the scored tasks the
/// local lookup missed, at least a third end in the first 50, timeouts
/// ≤ 5%. No requests (or no absent task) cannot fail the rate conditions.
pub(crate) fn gate_verdicts(holdout: &[LookupEvalRow]) -> GateVerdicts {
    let m = lookup_metrics(holdout, "all");
    let timeouts_ok = m.timeouts * 20 <= m.requests;
    let c3 = (m.scored > 0).then(|| {
        m.net_gain >= 3 && m.pushed_out <= 1 && timeouts_ok && m.absent_false_fit * 3 <= m.absent_tasks
    });
    let missed: Vec<&LookupEvalRow> = holdout.iter().filter(|r| is_scored(r) && r.local_rank.is_none()).collect();
    let rescued = missed.iter().filter(|r| in_top(r.final_rank, 50)).count();
    let c4 = (!missed.is_empty()).then(|| rescued * 3 >= missed.len() && timeouts_ok);
    GateVerdicts { c3, c4 }
}

/// Every numeric metric, by its JSON name, in display order.
pub(crate) fn metric_values(m: &LookupMetrics) -> Vec<(&'static str, Option<f64>)> {
    let n = |v: usize| Some(v as f64);
    let u = |v: Option<u64>| v.map(|v| v as f64);
    vec![
        ("tasks", n(m.tasks)),
        ("scored", n(m.scored)),
        ("top5Local", n(m.top5_local)),
        ("top5Final", n(m.top5_final)),
        ("netGain", Some(m.net_gain as f64)),
        ("pushedOut", n(m.pushed_out)),
        ("absentTasks", n(m.absent_tasks)),
        ("absentFalseFit", n(m.absent_false_fit)),
        ("absentFalseFitRate", m.absent_false_fit_rate),
        ("top50Coverage", m.top50_coverage),
        ("windowCoverage", m.window_coverage),
        ("requests", n(m.requests)),
        ("timeouts", n(m.timeouts)),
        ("timeoutRate", m.timeout_rate),
        ("localP50Ms", u(m.local_p50_ms)),
        ("localP95Ms", u(m.local_p95_ms)),
        ("enhanceP50Ms", u(m.enhance_p50_ms)),
        ("enhanceP95Ms", u(m.enhance_p95_ms)),
        ("inputTokens", Some(m.input_tokens as f64)),
        ("usageUnknown", n(m.usage_unknown)),
        ("estimatedTokens", Some(m.estimated_tokens as f64)),
    ]
}

/// `current − baseline` per metric; `None` when either side has no value.
pub(crate) fn compare_metrics(current: &LookupMetrics, baseline: &LookupMetrics) -> Vec<MetricDelta> {
    metric_values(current)
        .into_iter()
        .zip(metric_values(baseline))
        .map(|((metric, current), (_, baseline))| MetricDelta {
            metric: metric.to_string(),
            current,
            baseline,
            delta: current.zip(baseline).map(|(c, b)| c - b),
        })
        .collect()
}

/// One row per non-blank line (an earlier `--out`). A bad line is an error
/// naming its 1-based line number.
pub(crate) fn load_eval_rows(jsonl: &str) -> Result<Vec<LookupEvalRow>, String> {
    jsonl
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, line)| serde_json::from_str(line).map_err(|e| format!("eval rows line {}: {e}", index + 1)))
        .collect()
}

/// Run every task through [`run_pipeline`] (window [`EVAL_WINDOW`], deep
/// off, time mode from `params`) and score it. The target ranks come from
/// `target_rank` on the local and the final hit lists; the window coverage
/// from the blocks the judge picked to send.
pub(crate) async fn run_lookup_eval(
    index: &IndexHandle,
    root: &Path,
    tasks: &[EvalTask],
    params: &LookupParams,
    enhance: Option<&EnhanceSetup>,
    today: NaiveDate,
    client: &reqwest::Client,
) -> Result<Vec<LookupEvalRow>, String> {
    let mut rows = Vec::with_capacity(tasks.len());
    for task in tasks {
        let absent = task.category == Category::Absent;
        let mut target_indexed = true;
        if !absent {
            for target in &task.targets {
                target_indexed &= indexed_file(index, &target.path)?;
            }
        }
        let input = PipelineInput {
            question: &task.question,
            vault_root: root,
            index,
            window_label: EVAL_WINDOW,
            params,
            deep: false,
            time_mode: None,
            today,
            enhance,
        };
        let output = run_pipeline(input, client).await.map_err(|e| format!("task {}: {e}", task.id))?;
        let rank = |hits: &[SmartHitDto]| target_rank(hits, &task.targets).map(|(rank, _)| rank);
        let judge = output.judge.as_ref();
        let repair = output.repair.as_ref();
        let local_hits = &output.local.search.hits;
        let target_in_window = judge.is_some_and(|j| {
            j.sent_result_ids.iter().any(|id| {
                local_hits
                    .iter()
                    .find(|h| h.result_id.as_deref() == Some(id.as_str()))
                    .is_some_and(|h| target_rank(std::slice::from_ref(h), &task.targets).is_some())
            })
        });
        let usage = judge.and_then(|j| j.usage.as_ref()).or_else(|| repair.and_then(|r| r.usage.as_ref()));
        rows.push(LookupEvalRow {
            id: task.id.clone(),
            category: task.category,
            split: task.split,
            target_indexed,
            local_rank: rank(local_hits),
            final_rank: rank(&output.hits),
            route: output.route,
            status: judge.map(|j| j.status).or_else(|| repair.map(|r| r.status)),
            request_count: judge.map(|j| j.request_count).or_else(|| repair.map(|r| r.request_count)).unwrap_or(0),
            reused: judge.is_some_and(|j| j.reused),
            target_in_window,
            any_fit: judge.is_some_and(|j| j.verdicts.iter().any(|v| v.tier == Tier::Fit)),
            local_ms: output.local_ms,
            enhance_ms: judge.map(|j| j.elapsed_ms).or_else(|| repair.map(|r| r.elapsed_ms)),
            estimated_tokens: judge.map_or(0, |j| j.estimated_tokens),
            input_tokens: usage.map(|u| u.input_tokens),
        });
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use searchidx::SearchIndex;
    use std::sync::{Arc, Mutex};

    fn row(id: &str, rank: Option<usize>, level: Option<&str>) -> E1Row {
        E1Row {
            id: id.into(),
            category: Category::Exact,
            split: Split::Dev,
            target_indexed: true,
            rank,
            level: level.map(str::to_owned),
            line_share_top30: 1.0,
            local_ms: 1,
            deep_rank: None,
            deep_ms: None,
            time_detected: false,
            grouped_rank: None,
            needs_inferred_constraint: false,
        }
    }

    #[test]
    fn load_tasks_rejects_inconsistent_entries_naming_the_task() {
        let wrap = |tasks: &str| format!(r#"{{"tasks":[{tasks}]}}"#);
        let ok = r#"{"id":"t01","question":"q","targets":[{"path":"a.md"}],"category":"exact","split":"dev"}"#;
        assert_eq!(load_tasks(&wrap(ok)).unwrap().len(), 1);
        for (tasks, needle) in [
            (format!("{ok},{ok}"), "t01"),
            (
                r#"{"id":"t02","question":"q","targets":[{"path":"a.md"}],"category":"absent","split":"dev"}"#
                    .to_string(),
                "t02",
            ),
            (
                r#"{"id":"t03","question":"q","targets":[],"category":"exact","split":"dev"}"#.to_string(),
                "t03",
            ),
            (
                r#"{"id":"t04","question":"q","targets":[{"path":"../x.md"}],"category":"exact","split":"dev"}"#
                    .to_string(),
                "t04",
            ),
        ] {
            let error = load_tasks(&wrap(&tasks)).unwrap_err();
            assert!(error.contains(needle), "{error}");
        }
        assert!(load_tasks(r#"{"tasks":[]}"#).is_err());
    }

    #[test]
    fn pre_gates_apply_the_confirmed_thresholds() {
        let mut rows: Vec<E1Row> = [6, 10, 11, 30, 31]
            .iter()
            .map(|rank| row("r", Some(*rank), Some("line")))
            .collect();
        assert!(!pre_gates(&rows).c3_worth_testing);
        rows.push(row("r", Some(50), Some("line")));
        rows.push(row("r", Some(51), Some("line")));
        let gates = pre_gates(&rows);
        assert_eq!((gates.rank_6_to_50, gates.c3_worth_testing), (6, true));

        let mut misses: Vec<E1Row> = (0..3).map(|_| row("m", None, None)).collect();
        misses.push(E1Row { deep_rank: Some(2), ..row("deep", None, None) });
        misses.push(E1Row { category: Category::Absent, ..row("absent", None, None) });
        assert_eq!(pre_gates(&misses).unrecalled_after_deep, 3);
        assert!(!pre_gates(&misses).c4_worth_testing);
        misses.push(row("m", None, None));
        assert!(pre_gates(&misses).c4_worth_testing);

        let rollups = vec![
            row("a", Some(1), Some("section")),
            row("b", Some(2), Some("line")),
            row("c", Some(3), Some("line")),
            row("d", Some(4), Some("line")),
            row("e", None, None),
        ];
        assert_eq!(pre_gates(&rollups).rollup_share, 0.25);
        assert!(pre_gates(&rollups).rollup_excerpt_required);

        let timed = |rank: usize, grouped: usize| E1Row {
            time_detected: true,
            grouped_rank: Some(grouped),
            ..row("t", Some(rank), Some("line"))
        };
        assert_eq!(pre_gates(&[timed(3, 8), timed(9, 2)]).c2_grouping_ok, Some(true));
        assert_eq!(pre_gates(&[timed(3, 8), timed(4, 9)]).c2_grouping_ok, Some(false));
        assert_eq!(pre_gates(&[row("x", Some(1), Some("line"))]).c2_grouping_ok, None);
    }

    #[test]
    fn rows_whose_target_is_not_in_the_vault_are_excluded_from_every_gate() {
        let typo = E1Row { target_indexed: false, ..row("typo", None, None) };
        let gates = pre_gates(&[typo.clone(), typo.clone(), typo.clone(), typo]);
        assert_eq!(gates.scored_tasks, 0);
        assert_eq!(gates.unrecalled_after_deep, 0);
    }

    #[test]
    fn e1_scores_a_fixture_vault_end_to_end() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(
            vault.path().join("launch.md"),
            "# Launch\nQ3Budget launch budget release risk details\n",
        )
        .unwrap();
        std::fs::write(vault.path().join("other.md"), "# Other\nunrelated gardening notes\n").unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut idx = SearchIndex::open_at(vault.path(), &data.path().join("i.db"), "sync").unwrap();
        idx.sweep(&searchidx::ScanOptions::default(), None).unwrap();
        let handle: IndexHandle = Arc::new(Mutex::new(Some(idx)));
        let tasks = load_tasks(
            r#"{"tasks":[
              {"id":"t01","question":"Q3Budget release risk","targets":[{"path":"launch.md","line":2}],"category":"exact","split":"dev"},
              {"id":"t02","question":"quantum pasta","targets":[],"category":"absent","split":"dev"},
              {"id":"t03","question":"release risk","targets":[{"path":"missing.md"}],"category":"exact","split":"holdout"}
            ]}"#,
        )
        .unwrap();

        let rows = run_e1(
            &handle,
            &tasks,
            NaiveDate::from_ymd_opt(2026, 11, 10).unwrap(),
        )
        .unwrap();

        assert_eq!(
            (rows[0].rank, rows[0].level.as_deref(), rows[0].target_indexed),
            (Some(1), Some("line"), true)
        );
        assert_eq!(rows[0].line_share_top30, 1.0);
        assert_eq!((rows[1].rank, rows[1].target_indexed), (None, true));
        assert!(!rows[2].target_indexed);
        assert_eq!(pre_gates(&rows).scored_tasks, 2);
    }

    #[test]
    fn load_tasks_normalises_target_paths() {
        let tasks = load_tasks(
            r#"{"tasks":[{"id":"t01","question":"q","targets":[
              {"path":"./notes//a.md"},{"path":"notes\\b.md"},{"path":"././c.md"},{"path":"notes/./d.md"}
            ],"category":"exact","split":"dev"}]}"#,
        )
        .unwrap();
        let paths: Vec<&str> = tasks[0].targets.iter().map(|t| t.path.as_str()).collect();
        assert_eq!(paths, ["notes/a.md", "notes/b.md", "c.md", "notes/d.md"]);
        for bad in [r#""./""#, r#""/abs.md""#, r#""\\abs.md""#, r#""a/../../x.md""#] {
            let json = format!(
                r#"{{"tasks":[{{"id":"t09","question":"q","targets":[{{"path":{bad}}}],"category":"exact","split":"dev"}}]}}"#
            );
            assert!(load_tasks(&json).unwrap_err().contains("t09"), "{bad}");
        }
    }

    #[test]
    fn e1_decides_target_indexed_from_the_index_not_the_disk() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(
            vault.path().join("launch.md"),
            "# Launch\nQ3Budget launch budget release risk details\n",
        )
        .unwrap();
        std::fs::create_dir(vault.path().join("private")).unwrap();
        std::fs::write(
            vault.path().join("private/hidden.md"),
            "# Hidden\nQ3Budget release risk hidden copy\n",
        )
        .unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut idx = SearchIndex::open_at(vault.path(), &data.path().join("i.db"), "sync").unwrap();
        let opts = searchidx::ScanOptions { exclude_dirs: vec!["private".into()], ..Default::default() };
        idx.sweep(&opts, None).unwrap();
        let handle: IndexHandle = Arc::new(Mutex::new(Some(idx)));
        let tasks = load_tasks(
            r#"{"tasks":[
              {"id":"dot","question":"Q3Budget release risk","targets":[{"path":"./launch.md","line":2}],"category":"exact","split":"dev"},
              {"id":"excluded","question":"Q3Budget release risk","targets":[{"path":"private/hidden.md"}],"category":"exact","split":"dev"},
              {"id":"case","question":"Q3Budget release risk","targets":[{"path":"Launch.md"}],"category":"exact","split":"dev"}
            ]}"#,
        )
        .unwrap();

        let rows = run_e1(&handle, &tasks, NaiveDate::from_ymd_opt(2026, 11, 10).unwrap()).unwrap();

        assert_eq!((rows[0].target_indexed, rows[0].rank), (true, Some(1)), "{:?}", rows[0]);
        assert!(vault.path().join("private/hidden.md").is_file());
        assert!(!rows[1].target_indexed, "{:?}", rows[1]);
        assert!(!rows[2].target_indexed, "{:?}", rows[2]);
        let gates = pre_gates(&rows);
        assert_eq!((gates.scored_tasks, gates.unrecalled_after_deep), (1, 0));
    }

    fn feedback_row_json(path: &str, tier: &str, verdict: &str) -> String {
        format!(
            r#"{{"ts":"2026-11-10T00:00:00Z","question":"q","path":"{path}","line":1,"lineEnd":2,"modelTier":"{tier}","userVerdict":"{verdict}","endpointHost":"h","model":"m"}}"#
        )
    }

    #[test]
    fn feedback_agreement_counts_decided_tiers_only() {
        let row = feedback_row_json;
        let jsonl = [
            row("a.md", "fit", "fit"),
            row("b.md", "fit", "unfit"),
            row("c.md", "unfit", "unfit"),
            row("d.md", "unsure", "fit"),
            String::new(),
        ]
        .join("\n");
        let a = feedback_agreement(&jsonl).unwrap();
        assert_eq!((a.rows, a.decided, a.agreed, a.fit, a.unfit, a.unsure_marked_fit), (4, 3, 2, (2, 1), (1, 1), 1));
        assert!((a.rate.unwrap() - 2.0 / 3.0).abs() < 1e-9);
        assert!(feedback_agreement("{not json}").unwrap_err().contains("line 1"));
        assert_eq!(feedback_agreement("").unwrap().rate, None);
    }

    #[test]
    fn feedback_agreement_dedupes_repeated_clicks_and_keeps_the_last_verdict() {
        let row = feedback_row_json;
        // Same (question, path, line, lineEnd, host, model): counted once, as
        // the last verdict. Another path is another row.
        let jsonl = [row("a.md", "fit", "unfit"), row("a.md", "fit", "unfit"), row("a.md", "fit", "fit"), row("b.md", "unfit", "fit")]
            .join("\n");
        let a = feedback_agreement(&jsonl).unwrap();
        assert_eq!((a.rows, a.decided, a.agreed, a.fit, a.unfit), (2, 2, 1, (1, 1), (1, 0)));
        let other_model = row("a.md", "fit", "unfit").replace(r#""model":"m""#, r#""model":"n""#);
        let a = feedback_agreement(&[row("a.md", "fit", "fit"), other_model].join("\n")).unwrap();
        assert_eq!((a.rows, a.agreed), (2, 1));
    }

    fn eval_row(id: &str, local: Option<usize>, fin: Option<usize>) -> LookupEvalRow {
        LookupEvalRow {
            id: id.into(),
            category: Category::Exact,
            split: Split::Holdout,
            target_indexed: true,
            local_rank: local,
            final_rank: fin,
            route: PipelineRoute::Judge,
            status: Some(EnhanceStatus::Ok),
            request_count: 1,
            reused: false,
            target_in_window: true,
            any_fit: false,
            local_ms: 10,
            enhance_ms: Some(100),
            estimated_tokens: 50,
            input_tokens: Some(40),
        }
    }

    #[test]
    fn percentiles_use_the_nearest_rank() {
        assert_eq!(percentile(&[400, 100, 300, 200], 0.5), Some(200));
        assert_eq!(percentile(&[400, 100, 300, 200], 0.95), Some(400));
        assert_eq!(percentile(&[], 0.5), None);
        assert_eq!(percentile(&[7], 0.5), Some(7));
    }

    fn section_9_3_rows() -> Vec<LookupEvalRow> {
        vec![
            eval_row("gain", Some(7), Some(2)),
            eval_row("pushed", Some(3), Some(8)),
            eval_row("kept", Some(1), Some(1)),
            LookupEvalRow { category: Category::Absent, any_fit: true, target_in_window: false, ..eval_row("absent", None, None) },
            LookupEvalRow { target_indexed: false, ..eval_row("typo", None, None) },
            LookupEvalRow {
                route: PipelineRoute::Repair,
                target_in_window: false,
                input_tokens: None,
                ..eval_row("rescued", None, Some(30))
            },
            LookupEvalRow {
                status: Some(EnhanceStatus::Timeout),
                target_in_window: false,
                input_tokens: None,
                split: Split::Dev,
                ..eval_row("slow", Some(20), Some(20))
            },
        ]
    }

    #[test]
    fn lookup_metrics_follow_section_9_3() {
        let rows = section_9_3_rows();
        let m = lookup_metrics(&rows, "all");
        assert_eq!((m.scored, m.top5_local, m.top5_final, m.net_gain, m.pushed_out), (5, 2, 2, 0, 1));
        assert_eq!((m.absent_tasks, m.absent_false_fit), (1, 1));
        assert_eq!(m.absent_false_fit_rate, Some(1.0));
        assert_eq!(m.timeouts, 1);
        assert_eq!((m.tasks, m.requests), (7, 7));
        assert_eq!(m.timeout_rate, Some(1.0 / 7.0));
        // local ranks of the 5 scored rows: 7, 3, 1, None, 20 → 4 within 50
        assert_eq!(m.top50_coverage, Some(4.0 / 5.0));
        // judged scored rows: all 5; target in window: gain, pushed, kept
        assert_eq!(m.window_coverage, Some(3.0 / 5.0));
        // input tokens: 5 rows with 40, 2 without
        assert_eq!((m.input_tokens, m.usage_unknown, m.estimated_tokens), (200, 2, 350));
        assert_eq!((m.local_p50_ms, m.enhance_p95_ms), (Some(10), Some(100)));
        let dev = lookup_metrics(&rows, "dev");
        assert_eq!((dev.split.as_str(), dev.tasks, dev.scored, dev.timeouts), ("dev", 1, 1, 1));
        assert_eq!(lookup_metrics(&rows, "holdout").tasks, 6);
        // Rows without a request count for neither the rate nor the latencies.
        let unsent = LookupEvalRow { request_count: 0, enhance_ms: None, ..eval_row("x", Some(1), Some(1)) };
        let m = lookup_metrics(&[unsent], "all");
        assert_eq!((m.requests, m.timeout_rate, m.enhance_p50_ms, m.window_coverage), (0, None, None, None));
    }

    #[test]
    fn gates_follow_the_confirmed_thresholds() {
        let gains: Vec<LookupEvalRow> = (0..3).map(|i| eval_row(&format!("g{i}"), Some(9), Some(1))).collect();
        assert_eq!(gate_verdicts(&gains).c3, Some(true));
        assert_eq!(gate_verdicts(&gains).c4, None);
        assert_eq!(gate_verdicts(&gains[..2]).c3, Some(false));
        let mut pushed = gains.clone();
        pushed.extend([eval_row("p1", Some(1), Some(9)), eval_row("p2", Some(2), None)]);
        pushed.extend((3..5).map(|i| eval_row(&format!("g{i}"), None, Some(2))));
        // gained 5 − pushed 2 = 3, but two pushed out
        assert_eq!(gate_verdicts(&pushed).c3, Some(false));
        let absent = |id: &str, fit: bool| LookupEvalRow { category: Category::Absent, any_fit: fit, ..eval_row(id, None, None) };
        let mut with_absent = gains.clone();
        with_absent.extend([absent("a1", true), absent("a2", false), absent("a3", false)]);
        assert_eq!(gate_verdicts(&with_absent).c3, Some(true));
        with_absent.push(absent("a4", true));
        assert_eq!(gate_verdicts(&with_absent).c3, Some(false));
        let mut slow = gains.clone();
        slow.push(LookupEvalRow { status: Some(EnhanceStatus::Timeout), ..eval_row("t", Some(1), Some(1)) });
        assert_eq!(gate_verdicts(&slow).c3, Some(false));
        let missed = [eval_row("m1", None, Some(40)), eval_row("m2", None, None), eval_row("m3", None, Some(60))];
        assert_eq!(gate_verdicts(&missed).c4, Some(true));
        assert_eq!(gate_verdicts(&missed[1..]).c4, Some(false));
        assert_eq!(gate_verdicts(&[]), GateVerdicts { c3: None, c4: None });
    }

    #[test]
    fn compare_reports_each_metric_delta() {
        let baseline = lookup_metrics(&[eval_row("a", Some(9), Some(1)), eval_row("b", Some(9), Some(9))], "all");
        let current = lookup_metrics(
            &[eval_row("a", Some(9), Some(1)), eval_row("b", Some(9), Some(2)), eval_row("c", Some(9), Some(3))],
            "all",
        );
        let deltas = compare_metrics(&current, &baseline);
        assert!(deltas.iter().any(|d| d.metric == "netGain" && d.delta == Some(2.0)), "{deltas:?}");
        assert!(deltas.iter().any(|d| d.metric == "tasks" && d.current == Some(3.0) && d.baseline == Some(2.0)));
        assert!(deltas.iter().any(|d| d.metric == "absentFalseFitRate" && d.delta.is_none()));
        assert_eq!(deltas.len(), metric_values(&current).len());
    }

    #[test]
    fn eval_rows_round_trip_and_a_bad_line_names_its_number() {
        let rows = section_9_3_rows();
        let jsonl: String = rows.iter().map(|r| serde_json::to_string(r).unwrap() + "\n").collect();
        assert_eq!(load_eval_rows(&format!("{jsonl}\n")).unwrap(), rows);
        let broken = format!("{jsonl}{{\"id\":1}}\n");
        assert!(load_eval_rows(&broken).unwrap_err().contains(&format!("line {}", rows.len() + 1)));
    }

    #[tokio::test]
    async fn lookup_eval_runs_the_pipeline_on_a_fixture_vault() {
        use crate::smart_enhance::JevRequestConfig;
        use crate::smart_model::{endpoint_host, test_support::serve_once, AuthMode};
        use std::sync::atomic::Ordering::SeqCst;
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join("launch.md"), "# Launch\nEvalBudget release risk details\n").unwrap();
        std::fs::write(vault.path().join("other.md"), "# Other\nunrelated gardening notes\n").unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut idx = SearchIndex::open_at(vault.path(), &data.path().join("i.db"), "sync").unwrap();
        idx.sweep(&searchidx::ScanOptions::default(), None).unwrap();
        let handle: IndexHandle = Arc::new(Mutex::new(Some(idx)));
        let tasks = load_tasks(
            r#"{"tasks":[
              {"id":"t01","question":"EvalBudget release risk","targets":[{"path":"launch.md","line":2}],"category":"exact","split":"holdout"},
              {"id":"t02","question":"quantum pasta","targets":[],"category":"absent","split":"holdout"}
            ]}"#,
        )
        .unwrap();
        let (base, _request, accepted) =
            serve_once(200, r#"{"answers":{"c1":{"type":"noul","noul":0.9}},"usage":{"input_tokens":33,"output_tokens":1}}"#, std::time::Duration::ZERO).await;
        let enhance = EnhanceSetup {
            jev: Some(JevRequestConfig {
                url: base.clone(),
                model: "m".into(),
                auth_mode: AuthMode::None,
                consent_host: endpoint_host(&base).unwrap(),
            }),
            jev_key: None,
            chat: None,
            chat_key: None,
        };
        let client = crate::smart_enhance::enhance_client().unwrap();
        let rows = run_lookup_eval(
            &handle,
            vault.path(),
            &tasks,
            &LookupParams::default(),
            Some(&enhance),
            NaiveDate::from_ymd_opt(2026, 11, 10).unwrap(),
            &client,
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 2);
        let exact = &rows[0];
        assert_eq!((exact.route, exact.status, exact.request_count), (PipelineRoute::Judge, Some(EnhanceStatus::Ok), 1), "{exact:?}");
        assert!(exact.target_in_window && exact.any_fit && exact.target_indexed, "{exact:?}");
        assert_eq!((exact.local_rank, exact.final_rank, exact.input_tokens), (Some(1), Some(1), Some(33)));
        let absent = &rows[1];
        assert_eq!((absent.route, absent.request_count, absent.local_rank), (PipelineRoute::Repair, 0, None), "{absent:?}");
        assert_eq!(accepted.load(SeqCst), 1);
        let jsonl: String = rows.iter().map(|r| serde_json::to_string(r).unwrap() + "\n").collect();
        assert_eq!(load_eval_rows(&jsonl).unwrap(), rows);
        let gates = gate_verdicts(&rows);
        assert_eq!(gates.c3, Some(false));
    }

    /// ```text
    /// NOTEMD_EVAL_FEEDBACK=<feedback.jsonl> RUSTUP_TOOLCHAIN=stable \
    ///   cargo test --manifest-path src-tauri/Cargo.toml feedback_agreement_report -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "reads the local feedback log; run by hand with NOTEMD_EVAL_FEEDBACK set"]
    fn feedback_agreement_report() {
        let path = std::env::var("NOTEMD_EVAL_FEEDBACK").expect("NOTEMD_EVAL_FEEDBACK must be set for this run");
        let text = std::fs::read_to_string(&path).expect("read feedback log");
        let report = feedback_agreement(&text).expect("valid feedback log");
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    }

    /// The real run. Quit note.md first so the index copy is consistent.
    ///
    /// ```text
    /// NOTEMD_EVAL_VAULT=<vault root> NOTEMD_EVAL_TASKS=<tasks.json> NOTEMD_EVAL_OUT=<report.json> \
    ///   cargo test --manifest-path src-tauri/Cargo.toml e1_local_baseline -- --ignored --nocapture
    /// ```
    ///
    /// Optional `NOTEMD_EVAL_INDEX_DB` overrides the index location. The
    /// index file (with `-wal` / `-shm` when present) is copied to a temp
    /// directory and only the copy is opened; the live index is never swept,
    /// built or rebuilt. An empty copy means the stamp did not match or the
    /// index was never built, and aborts the run.
    #[test]
    #[ignore = "reads a real vault; run by hand with NOTEMD_EVAL_* set"]
    fn e1_local_baseline() {
        let env = |name: &str| {
            std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for this run"))
        };
        let vault = std::path::PathBuf::from(env("NOTEMD_EVAL_VAULT"));
        let tasks_path = env("NOTEMD_EVAL_TASKS");
        let out_path = env("NOTEMD_EVAL_OUT");
        let source_db = match std::env::var("NOTEMD_EVAL_INDEX_DB") {
            Ok(path) => std::path::PathBuf::from(path),
            Err(_) => searchidx::paths::index_db_path(&vault)
                .expect("no index location for this vault; set NOTEMD_EVAL_INDEX_DB"),
        };
        let tasks = load_tasks(&std::fs::read_to_string(&tasks_path).expect("read tasks file"))
            .expect("valid tasks file");

        let copy_dir = tempfile::tempdir().unwrap();
        let copy_db = copy_dir.path().join(source_db.file_name().expect("index file name"));
        std::fs::copy(&source_db, &copy_db).expect("copy index file");
        for suffix in ["-wal", "-shm"] {
            let mut side = source_db.clone().into_os_string();
            side.push(suffix);
            let side = std::path::PathBuf::from(side);
            if side.exists() {
                let mut dest = copy_db.clone().into_os_string();
                dest.push(suffix);
                std::fs::copy(&side, dest).expect("copy index side file");
            }
        }

        let stamp = crate::cli::search::scan_options_for(&vault).source_globs.stamp();
        let idx = SearchIndex::open_at(&vault, &copy_db, &stamp).expect("open index copy");
        if idx.stats().expect("index stats").files == 0 {
            panic!("索引副本为空：stamp 不匹配或索引尚未建立");
        }
        let handle: IndexHandle = Arc::new(Mutex::new(Some(idx)));

        let rows = run_e1(&handle, &tasks, chrono::Local::now().date_naive())
            .expect("run E1");
        let gates = pre_gates(&rows);
        let report = serde_json::json!({
            "vault": vault.display().to_string(),
            "rows": rows,
            "preGates": gates,
        });
        std::fs::write(&out_path, serde_json::to_string_pretty(&report).unwrap())
            .expect("write report");
        println!("{}", serde_json::to_string_pretty(&gates).unwrap());
    }
}
