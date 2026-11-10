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
    // E1 measures the local baseline at the default params.
    let fusion = FusionParams::default();
    let local = crate::lookup_params::LocalParams::default();
    let search = |question: &str, deep: bool| {
        smart_search_locked(
            handle,
            Instant::now(),
            question,
            Some(local.limit),
            Some(deep),
            deep.then_some(local.deep_timeout_ms),
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
use crate::smart_enhance::evidence::{EvidenceItemDto, EvidenceStepResult};
use crate::smart_enhance::pipeline::{run_pipeline, EnhanceSetup, PipelineInput, PipelineOutput, PipelineRoute};
use crate::smart_enhance::sag::round::EvidenceStop;
use crate::smart_enhance::{EnhanceStatus, Tier};

/// The window label every eval run is registered under.
pub(crate) const EVAL_WINDOW: &str = "cli-eval";

/// The only `enhance.timeoutMs` C4 is decided at (§9.3 "3 秒时限下"); since
/// spec H.10 the evidence gates follow the round limit instead.
pub(crate) const GATE_TIMEOUT_MS: u64 = 3_000;

/// The only round time limit the gates are decided at (spec H.10: the
/// default `retrieval.roundTimeoutMs`).
pub(crate) const GATE_ROUND_TIMEOUT_MS: u64 = 10_000;

/// Fewer scored holdout `bridge` tasks leave C5 n/a (spec H.10, 题量不足).
const C5_MIN_BRIDGE_TASKS: usize = 4;

/// What every row of one eval run records about its parameters.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunSettings {
    pub timeout_ms: u64,
    pub max_hops: Option<u8>,
    pub round_timeout_ms: Option<u64>,
}

impl RunSettings {
    pub(crate) fn of(params: &LookupParams) -> Self {
        Self {
            timeout_ms: params.enhance.timeout_ms,
            max_hops: Some(u8::try_from(params.retrieval.max_hops).unwrap_or(u8::MAX)),
            round_timeout_ms: Some(params.retrieval.round_timeout_ms),
        }
    }
}

/// One task's outcome on the full pipeline; one line of `--out`. Fields
/// added after the first version default when read back, so an older
/// `--out` still works as a `--compare` baseline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LookupEvalRow {
    pub id: String,
    pub category: Category,
    pub split: Split,
    pub target_indexed: bool,
    pub local_rank: Option<usize>,
    pub final_rank: Option<usize>,
    /// `None` only on an error row.
    pub route: Option<PipelineRoute>,
    pub status: Option<EnhanceStatus>,
    pub request_count: u32,
    pub reused: bool,
    /// 目标块在发送给模型的候选里。
    pub target_in_window: bool,
    pub any_fit: bool,
    /// 误匹配 (§9.3): a hit that is not a target was judged fit and is ranked
    /// before the target in the final order (or the target is not in the
    /// final list at all). Scored tasks only; an absent task's fits are
    /// `any_fit` instead.
    #[serde(default)]
    pub mismatch: bool,
    /// 目标被下沉 (§9.3): the judgement's rerank moved the target to a later
    /// rank than the local one.
    #[serde(default)]
    pub demoted: bool,
    /// The target's rank after a local deep pass (no model), run only for
    /// scored tasks the normal local pass missed; the C4 pre-filter of §9.3
    /// ("FTS 和 deep 都未召回").
    #[serde(default)]
    pub deep_rank: Option<usize>,
    #[serde(default)]
    pub deep_ms: Option<u64>,
    /// The local deep pass failed. The pipeline row (paid) is kept; the row
    /// is left out of C4's population, whose filter needs that pass.
    #[serde(default)]
    pub deep_error: Option<String>,
    pub local_ms: u64,
    pub enhance_ms: Option<u64>,
    pub estimated_tokens: u64,
    pub input_tokens: Option<u64>,
    /// `enhance.timeoutMs` of the run.
    #[serde(default)]
    pub timeout_ms: u64,
    /// The task could not be run; every other field is empty and the row
    /// counts only towards `tasks` and `errors`.
    #[serde(default)]
    pub error: Option<String>,
    /// `retrieval.maxHops` of the run (spec H.10).
    #[serde(default)]
    pub max_hops: Option<u8>,
    /// `retrieval.roundTimeoutMs` of the run (pre-flight P13).
    #[serde(default)]
    pub round_timeout_ms: Option<u64>,
    /// 目标在最终证据列表中的名次（1 起）: the latest `ok` round's list.
    #[serde(default)]
    pub evidence_rank: Option<usize>,
    /// 目标段首次进入候选的轮次.
    #[serde(default)]
    pub found_round: Option<u8>,
    /// One entry per evidence round, in the order they ran.
    #[serde(default)]
    pub rounds: Vec<RoundRow>,
}

/// One evidence round of a task (spec H.10), from its `EvidenceStepResult`.
/// A round that scored nothing (a stop, a failure) reports the latest
/// scored evidence list again, and its `evidence_rank` is the target's rank
/// there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoundRow {
    pub hop: u8,
    /// The expansion terms as the window shows them (`label`).
    pub terms: Vec<String>,
    pub candidates: usize,
    pub pool_size: usize,
    pub sent_blocks: usize,
    pub estimated_tokens: u64,
    pub input_tokens: Option<u64>,
    pub request_count: u32,
    pub elapsed_ms: u64,
    pub status: EnhanceStatus,
    pub stop: Option<EvidenceStop>,
    /// 每轮结束时目标在当时证据列表中的名次（1 起）.
    pub evidence_rank: Option<usize>,
}

/// §9.3's metrics for one split of the rows. Error rows count only towards
/// `tasks` and `errors`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LookupMetrics {
    pub split: String,
    pub tasks: usize,
    pub errors: usize,
    pub scored: usize,
    pub top5_local: usize,
    pub top5_final: usize,
    pub net_gain: i64,
    pub pushed_out: usize,
    /// 误匹配: scored tasks with `mismatch` (§9.3).
    pub mismatches: usize,
    /// 目标被下沉: scored tasks with `demoted` (§9.3).
    pub demoted: usize,
    pub absent_tasks: usize,
    /// Absent tasks that were actually judged (a request sent or a verdict
    /// reused); the rate below still divides by every absent task (G.6).
    pub absent_judged: usize,
    pub absent_false_fit: usize,
    pub absent_false_fit_rate: Option<f64>,
    pub top50_coverage: Option<f64>,
    pub window_coverage: Option<f64>,
    pub requests: usize,
    pub timeouts: usize,
    pub timeout_rate: Option<f64>,
    pub judge_requests: usize,
    pub judge_timeouts: usize,
    pub judge_timeout_rate: Option<f64>,
    pub repair_requests: usize,
    pub repair_timeouts: usize,
    pub repair_timeout_rate: Option<f64>,
    pub local_p50_ms: Option<u64>,
    pub local_p95_ms: Option<u64>,
    pub judge_p50_ms: Option<u64>,
    pub judge_p95_ms: Option<u64>,
    pub repair_p50_ms: Option<u64>,
    pub repair_p95_ms: Option<u64>,
    pub input_tokens: u64,
    pub usage_unknown: usize,
    pub estimated_tokens: u64,
    /// `enhance.timeoutMs` shared by every row; `None` when rows differ or
    /// there are none.
    pub timeout_ms: Option<u64>,
    /// `retrieval.maxHops` shared by every row; `None` when rows differ,
    /// predate the field or there are none.
    pub max_hops: Option<u8>,
    /// `retrieval.roundTimeoutMs`, shared like `max_hops`.
    #[serde(default)]
    pub round_timeout_ms: Option<u64>,
    /// Scored tasks whose target is in the final evidence list, as a share
    /// of the scored tasks (spec H.10).
    pub evidence_recall10: Option<f64>,
    /// The same at the end of round 0.
    pub evidence_recall10_round0: Option<f64>,
    /// Scored tasks with an `evidence_rank` and `found_round ≥ 1`.
    pub expansion_only: usize,
    /// Scored tasks in the evidence at the end of round 0 and not at the end.
    pub lost_by_expansion: usize,
    /// Per hop (index = hop): estimated tokens of the rounds that sent.
    pub round_tokens: Vec<u64>,
    /// Per hop: the input tokens the service reported.
    pub round_input_tokens: Vec<u64>,
    /// Per hop: P50 / P95 of the time of the rounds that sent (nearest rank).
    pub round_p50_ms: Vec<Option<u64>>,
    pub round_p95_ms: Vec<Option<u64>>,
    /// Rounds that sent at least one request; of them, the timed-out ones.
    pub round_requests: usize,
    pub round_timeouts: usize,
    pub round_timeout_rate: Option<f64>,
}

/// The holdout gates of spec §9.3 and H.10. A gate is `None` when it has
/// no task to judge by or a rule keeps it from being decided:
///
/// - `note`: every gate is n/a — the round time limit is not the 10 s the
///   gates were fixed for (`"round timeout ≠ 10 s"`);
/// - `c3_note`, `c4_note`, `c5_note`: why that one gate is n/a.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GateVerdicts {
    pub c3: Option<bool>,
    pub c4: Option<bool>,
    pub c5: Option<bool>,
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub round_timeout_ms: Option<u64>,
    pub max_hops: Option<u8>,
    pub note: Option<String>,
    pub c3_note: Option<String>,
    pub c4_note: Option<String>,
    pub c5_note: Option<String>,
    /// C4's population and how many of it ended in the first 50.
    pub c4_tasks: usize,
    pub c4_rescued: usize,
    /// Scored `bridge` tasks in the holdout rows; C5 needs at least 4.
    pub c5_bridge_tasks: usize,
    /// What C5 decides on, over the holdout rows: `expansionOnly`, the
    /// scored tasks in the final evidence minus those in it at the end of
    /// round 0, and `lostByExpansion`.
    pub c5_expansion_only: usize,
    pub c5_recall_gain: i64,
    pub c5_lost: usize,
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
    row.error.is_none() && row.category != Category::Absent && row.target_indexed
}

/// Requests went out on `route` (an evidence row may send several).
fn sent_on(row: &LookupEvalRow, route: PipelineRoute) -> bool {
    row.route == Some(route) && row.request_count > 0
}

/// A judgement exists: sent, or reused from the cache.
fn judged(row: &LookupEvalRow) -> bool {
    row.route == Some(PipelineRoute::Judge) && (row.request_count > 0 || row.reused)
}

/// The target's rank in the evidence list at the end of round 0.
fn round0_rank(row: &LookupEvalRow) -> Option<usize> {
    row.rounds.iter().find(|r| r.hop == 0).and_then(|r| r.evidence_rank)
}

/// The value every row shares; `None` when they differ or there is no row.
fn shared<T: PartialEq + Copy>(rows: &[&LookupEvalRow], f: impl Fn(&LookupEvalRow) -> T) -> Option<T> {
    let first = f(rows.first()?);
    rows.iter().all(|r| f(r) == first).then_some(first)
}

/// Scored tasks whose target is in the final evidence list, and in the list
/// at the end of round 0.
fn evidence_counts(scored: &[&LookupEvalRow]) -> (usize, usize) {
    (
        scored.iter().filter(|r| r.evidence_rank.is_some()).count(),
        scored.iter().filter(|r| round0_rank(r).is_some()).count(),
    )
}

/// C4's population (§9.3 「预筛出的未召回任务」): scored tasks whose target
/// neither the normal local pass nor the local deep pass found.
/// A row whose deep pass failed is left out: whether deep found it is unknown.
fn c4_population(row: &LookupEvalRow) -> bool {
    is_scored(row) && row.local_rank.is_none() && row.deep_rank.is_none() && row.deep_error.is_none()
}

/// `split` is `"all"`, `"dev"` or `"holdout"`.
///
/// - Scored: not `absent`, the target is in the index, no error.
/// - 窗口覆盖 (G.6): among scored tasks with a judgement (Judge route, sent
///   or reused), the share whose target block was among the sent candidates.
/// - Requests: rows with `request_count > 0`. The pooled timeout rate,
///   token sums and the per-route rates and latencies (judge / repair) are
///   over those. Local latencies are over every non-error row.
/// - Evidence (spec H.10): `evidenceRecall10` is the share of scored tasks
///   with an `evidence_rank`, `evidenceRecall10Round0` the same at the end
///   of round 0; the per-round figures are over the rounds that sent at
///   least one request, indexed by hop.
pub(crate) fn lookup_metrics(rows: &[LookupEvalRow], split: &str) -> LookupMetrics {
    let in_split: Vec<&LookupEvalRow> = rows
        .iter()
        .filter(|r| match split {
            "dev" => r.split == Split::Dev,
            "holdout" => r.split == Split::Holdout,
            _ => true,
        })
        .collect();
    let ok: Vec<&LookupEvalRow> = in_split.iter().copied().filter(|r| r.error.is_none()).collect();
    let scored: Vec<&LookupEvalRow> = ok.iter().copied().filter(|r| is_scored(r)).collect();
    let count = |rows: &[&LookupEvalRow], f: &dyn Fn(&LookupEvalRow) -> bool| rows.iter().filter(|r| f(r)).count();
    let gained = count(&scored, &|r| in_top(r.final_rank, 5) && !in_top(r.local_rank, 5));
    let pushed_out = count(&scored, &|r| in_top(r.local_rank, 5) && !in_top(r.final_rank, 5));
    let absent: Vec<&LookupEvalRow> = ok.iter().copied().filter(|r| r.category == Category::Absent).collect();
    let absent_false_fit = count(&absent, &|r| r.any_fit);
    let with_judgement: Vec<&LookupEvalRow> = scored.iter().copied().filter(|r| judged(r)).collect();
    let requests: Vec<&LookupEvalRow> = ok.iter().copied().filter(|r| r.request_count > 0).collect();
    let timed_out = |r: &LookupEvalRow| r.status == Some(EnhanceStatus::Timeout);
    let on = |route| -> Vec<&LookupEvalRow> { requests.iter().copied().filter(|r| sent_on(r, route)).collect() };
    let judge = on(PipelineRoute::Judge);
    let repair = on(PipelineRoute::Repair);
    let latencies = |rows: &[&LookupEvalRow]| -> Vec<u64> { rows.iter().filter_map(|r| r.enhance_ms).collect() };
    let local_ms: Vec<u64> = ok.iter().map(|r| r.local_ms).collect();
    let timeouts = count(&requests, &timed_out);
    let judge_timeouts = count(&judge, &timed_out);
    let repair_timeouts = count(&repair, &timed_out);
    let timeout_ms = shared(&ok, |r| r.timeout_ms);
    let (in_evidence, in_round0) = evidence_counts(&scored);
    // Per-hop figures come from the rounds that sent: a round that sent
    // nothing reports the hop of the latest scored round again.
    let sent_rounds: Vec<&RoundRow> = ok.iter().flat_map(|r| &r.rounds).filter(|r| r.request_count > 0).collect();
    let hops = sent_rounds.iter().map(|r| usize::from(r.hop) + 1).max().unwrap_or(0);
    let at = |hop: usize| -> Vec<&RoundRow> { sent_rounds.iter().copied().filter(|r| usize::from(r.hop) == hop).collect() };
    let round_ms = |hop: usize| -> Vec<u64> { at(hop).iter().map(|r| r.elapsed_ms).collect() };
    let round_timeouts = sent_rounds.iter().filter(|r| r.status == EnhanceStatus::Timeout).count();
    LookupMetrics {
        max_hops: shared(&ok, |r| r.max_hops).flatten(),
        round_timeout_ms: shared(&ok, |r| r.round_timeout_ms).flatten(),
        evidence_recall10: ratio(in_evidence, scored.len()),
        evidence_recall10_round0: ratio(in_round0, scored.len()),
        expansion_only: count(&scored, &|r| r.evidence_rank.is_some() && r.found_round.is_some_and(|h| h >= 1)),
        lost_by_expansion: count(&scored, &|r| round0_rank(r).is_some() && r.evidence_rank.is_none()),
        round_tokens: (0..hops).map(|h| at(h).iter().map(|r| r.estimated_tokens).sum()).collect(),
        round_input_tokens: (0..hops).map(|h| at(h).iter().filter_map(|r| r.input_tokens).sum()).collect(),
        round_p50_ms: (0..hops).map(|h| percentile(&round_ms(h), 0.5)).collect(),
        round_p95_ms: (0..hops).map(|h| percentile(&round_ms(h), 0.95)).collect(),
        round_requests: sent_rounds.len(),
        round_timeouts,
        round_timeout_rate: ratio(round_timeouts, sent_rounds.len()),
        split: split.to_string(),
        tasks: in_split.len(),
        errors: in_split.len() - ok.len(),
        scored: scored.len(),
        top5_local: count(&scored, &|r| in_top(r.local_rank, 5)),
        top5_final: count(&scored, &|r| in_top(r.final_rank, 5)),
        net_gain: gained as i64 - pushed_out as i64,
        pushed_out,
        mismatches: count(&scored, &|r| r.mismatch),
        demoted: count(&scored, &|r| r.demoted),
        absent_tasks: absent.len(),
        absent_judged: count(&absent, &judged),
        absent_false_fit,
        absent_false_fit_rate: ratio(absent_false_fit, absent.len()),
        top50_coverage: ratio(count(&scored, &|r| in_top(r.local_rank, 50)), scored.len()),
        window_coverage: ratio(count(&with_judgement, &|r| r.target_in_window), with_judgement.len()),
        requests: requests.len(),
        timeouts,
        timeout_rate: ratio(timeouts, requests.len()),
        judge_requests: judge.len(),
        judge_timeouts,
        judge_timeout_rate: ratio(judge_timeouts, judge.len()),
        repair_requests: repair.len(),
        repair_timeouts,
        repair_timeout_rate: ratio(repair_timeouts, repair.len()),
        local_p50_ms: percentile(&local_ms, 0.5),
        local_p95_ms: percentile(&local_ms, 0.95),
        judge_p50_ms: percentile(&latencies(&judge), 0.5),
        judge_p95_ms: percentile(&latencies(&judge), 0.95),
        repair_p50_ms: percentile(&latencies(&repair), 0.5),
        repair_p95_ms: percentile(&latencies(&repair), 0.95),
        input_tokens: requests.iter().filter_map(|r| r.input_tokens).sum(),
        usage_unknown: count(&requests, &|r| r.input_tokens.is_none()),
        estimated_tokens: requests.iter().map(|r| r.estimated_tokens).sum(),
        timeout_ms,
    }
}

/// Spec §9.3 and H.10 on the holdout rows. First: every gate is `None`
/// (`note`) unless every row ran with `retrieval.roundTimeoutMs == 10000`.
/// Then, each on its own:
///
/// - C3, only on a `maxHops = 0` run: net Top-5 gain ≥ 3 (the `finalRank`
///   the window shows), at most one target pushed out, round timeouts ≤ 5%
///   of the rounds sent, and at most a third of the absent tasks with fit
///   evidence.
/// - C4, only at `enhance.timeoutMs == 3000`: of the scored tasks that both
///   the normal and the deep local pass missed, at least a third end in the
///   first 50, and repair timeouts ≤ 5% of repair requests.
/// - C5, only on a `maxHops ≥ 1` run with at least 4 scored `bridge` tasks:
///   `expansionOnly ≥ 2`, at least 2 more tasks in the final evidence than
///   at the end of round 0, `lostByExpansion ≤ 1`, round timeouts ≤ 5%.
///
/// No requests (or no absent task) cannot fail a rate condition.
pub(crate) fn gate_verdicts(holdout: &[LookupEvalRow]) -> GateVerdicts {
    let m = lookup_metrics(holdout, "all");
    let population: Vec<&LookupEvalRow> = holdout.iter().filter(|r| c4_population(r)).collect();
    let rescued = population.iter().filter(|r| in_top(r.final_rank, 50)).count();
    let scored: Vec<&LookupEvalRow> = holdout.iter().filter(|r| is_scored(r)).collect();
    let bridge = scored.iter().filter(|r| r.category == Category::Bridge).count();
    let (in_evidence, in_round0) = evidence_counts(&scored);
    let recall_gain = in_evidence as i64 - in_round0 as i64;
    let mut gates = GateVerdicts {
        c3: None,
        c4: None,
        c5: None,
        timeout_ms: m.timeout_ms,
        round_timeout_ms: m.round_timeout_ms,
        max_hops: m.max_hops,
        note: None,
        c3_note: None,
        c4_note: None,
        c5_note: None,
        c4_tasks: population.len(),
        c4_rescued: rescued,
        c5_bridge_tasks: bridge,
        c5_expansion_only: m.expansion_only,
        c5_recall_gain: recall_gain,
        c5_lost: m.lost_by_expansion,
    };
    if m.round_timeout_ms != Some(GATE_ROUND_TIMEOUT_MS) {
        if m.tasks > m.errors {
            gates.note = Some("round timeout ≠ 10 s".to_string());
        }
        return gates;
    }
    let rounds_ok = m.round_timeouts * 20 <= m.round_requests;
    let hops_note = |want: &str| match m.max_hops {
        Some(_) => format!("maxHops {want}"),
        None => "maxHops mixed".to_string(),
    };
    if m.max_hops == Some(0) {
        gates.c3 = (m.scored > 0).then(|| {
            m.net_gain >= 3 && m.pushed_out <= 1 && rounds_ok && m.absent_false_fit * 3 <= m.absent_tasks
        });
    } else {
        gates.c3_note = Some(hops_note("≠ 0"));
    }
    if m.timeout_ms == Some(GATE_TIMEOUT_MS) {
        let repair_ok = m.repair_timeouts * 20 <= m.repair_requests;
        gates.c4 = (!population.is_empty()).then(|| rescued * 3 >= population.len() && repair_ok);
    } else {
        gates.c4_note = Some("timeout ≠ 3 s".to_string());
    }
    if !m.max_hops.is_some_and(|h| h >= 1) {
        gates.c5_note = Some(hops_note("= 0"));
    } else if bridge < C5_MIN_BRIDGE_TASKS {
        gates.c5_note = Some(format!("bridge tasks < {C5_MIN_BRIDGE_TASKS}"));
    } else {
        gates.c5 = Some(m.expansion_only >= 2 && recall_gain >= 2 && m.lost_by_expansion <= 1 && rounds_ok);
    }
    gates
}

/// Every numeric metric, by its JSON name, in display order. A per-round
/// metric gives one entry per hop, named `roundTokens[0]`, `roundTokens[1]`….
pub(crate) fn metric_values(m: &LookupMetrics) -> Vec<(String, Option<f64>)> {
    let n = |v: usize| Some(v as f64);
    let u = |v: Option<u64>| v.map(|v| v as f64);
    let fixed: Vec<(&'static str, Option<f64>)> = vec![
        ("tasks", n(m.tasks)),
        ("errors", n(m.errors)),
        ("scored", n(m.scored)),
        ("top5Local", n(m.top5_local)),
        ("top5Final", n(m.top5_final)),
        ("netGain", Some(m.net_gain as f64)),
        ("pushedOut", n(m.pushed_out)),
        ("mismatches", n(m.mismatches)),
        ("demoted", n(m.demoted)),
        ("absentTasks", n(m.absent_tasks)),
        ("absentJudged", n(m.absent_judged)),
        ("absentFalseFit", n(m.absent_false_fit)),
        ("absentFalseFitRate", m.absent_false_fit_rate),
        ("top50Coverage", m.top50_coverage),
        ("windowCoverage", m.window_coverage),
        ("requests", n(m.requests)),
        ("timeouts", n(m.timeouts)),
        ("timeoutRate", m.timeout_rate),
        ("judgeRequests", n(m.judge_requests)),
        ("judgeTimeouts", n(m.judge_timeouts)),
        ("judgeTimeoutRate", m.judge_timeout_rate),
        ("repairRequests", n(m.repair_requests)),
        ("repairTimeouts", n(m.repair_timeouts)),
        ("repairTimeoutRate", m.repair_timeout_rate),
        ("localP50Ms", u(m.local_p50_ms)),
        ("localP95Ms", u(m.local_p95_ms)),
        ("judgeP50Ms", u(m.judge_p50_ms)),
        ("judgeP95Ms", u(m.judge_p95_ms)),
        ("repairP50Ms", u(m.repair_p50_ms)),
        ("repairP95Ms", u(m.repair_p95_ms)),
        ("inputTokens", Some(m.input_tokens as f64)),
        ("usageUnknown", n(m.usage_unknown)),
        ("estimatedTokens", Some(m.estimated_tokens as f64)),
        ("timeoutMs", u(m.timeout_ms)),
        ("maxHops", m.max_hops.map(f64::from)),
        ("roundTimeoutMs", u(m.round_timeout_ms)),
        ("evidenceRecall10", m.evidence_recall10),
        ("evidenceRecall10Round0", m.evidence_recall10_round0),
        ("expansionOnly", n(m.expansion_only)),
        ("lostByExpansion", n(m.lost_by_expansion)),
        ("roundRequests", n(m.round_requests)),
        ("roundTimeouts", n(m.round_timeouts)),
        ("roundTimeoutRate", m.round_timeout_rate),
    ];
    let mut values: Vec<(String, Option<f64>)> = fixed.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    let per_hop = |name: &str, values: Vec<Option<f64>>| -> Vec<(String, Option<f64>)> {
        values.into_iter().enumerate().map(|(hop, v)| (format!("{name}[{hop}]"), v)).collect()
    };
    values.extend(per_hop("roundTokens", m.round_tokens.iter().map(|&t| Some(t as f64)).collect()));
    values.extend(per_hop("roundInputTokens", m.round_input_tokens.iter().map(|&t| Some(t as f64)).collect()));
    values.extend(per_hop("roundP50Ms", m.round_p50_ms.iter().map(|&t| u(t)).collect()));
    values.extend(per_hop("roundP95Ms", m.round_p95_ms.iter().map(|&t| u(t)).collect()));
    values
}

/// `current − baseline` per metric, matched by name; `None` when either side
/// has no value. A metric only one side has (a hop the other run did not
/// reach, `roundTokens[1]` against a `maxHops = 0` baseline) is listed with
/// the other side empty: the current run's metrics first, then the
/// baseline's extra ones.
pub(crate) fn compare_metrics(current: &LookupMetrics, baseline: &LookupMetrics) -> Vec<MetricDelta> {
    let current = metric_values(current);
    let baseline = metric_values(baseline);
    let find = |values: &[(String, Option<f64>)], name: &str| values.iter().find(|(n, _)| n == name).and_then(|(_, v)| *v);
    let delta = |metric: &str, current: Option<f64>, baseline: Option<f64>| MetricDelta {
        metric: metric.to_string(),
        current,
        baseline,
        delta: current.zip(baseline).map(|(c, b)| c - b),
    };
    let mut deltas: Vec<MetricDelta> = current.iter().map(|(name, c)| delta(name, *c, find(&baseline, name))).collect();
    deltas.extend(
        baseline.iter().filter(|(name, _)| !current.iter().any(|(n, _)| n == name)).map(|(name, b)| delta(name, None, *b)),
    );
    deltas
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

/// The target's rank after a local deep pass with the lookup's own budget
/// (`local.limit`, `local.deepTimeoutMs`) and time mode; no model, no run
/// registered.
fn deep_pass(
    index: &IndexHandle,
    task: &EvalTask,
    params: &LookupParams,
    today: NaiveDate,
) -> Result<(Option<usize>, u64), String> {
    let (limit, deep, timeout) = super::local_lookup_budget(None, Some(true), None, &params.local);
    let counter = Arc::new(AtomicU64::new(1));
    let (response, _) = super::local_lookup_locked(
        index,
        &task.question,
        limit,
        deep,
        timeout,
        params.time.mode,
        today,
        &counter,
        1,
        &params.local.fusion(),
    )?;
    Ok((target_rank(&response.hits, &task.targets).map(|(rank, _)| rank), response.took_ms))
}

fn error_row(task: &EvalTask, settings: RunSettings, error: String) -> LookupEvalRow {
    LookupEvalRow {
        id: task.id.clone(),
        category: task.category,
        split: task.split,
        target_indexed: false,
        local_rank: None,
        final_rank: None,
        route: None,
        status: None,
        request_count: 0,
        reused: false,
        target_in_window: false,
        any_fit: false,
        mismatch: false,
        demoted: false,
        deep_rank: None,
        deep_ms: None,
        deep_error: None,
        local_ms: 0,
        enhance_ms: None,
        estimated_tokens: 0,
        input_tokens: None,
        timeout_ms: settings.timeout_ms,
        error: Some(error),
        max_hops: settings.max_hops,
        round_timeout_ms: settings.round_timeout_ms,
        evidence_rank: None,
        found_round: None,
        rounds: Vec::new(),
    }
}

/// The 1-based rank of the first evidence item that is a target.
fn evidence_rank(evidence: &[EvidenceItemDto], is_target: &dyn Fn(&str, u32, u32) -> bool) -> Option<usize> {
    evidence.iter().position(|i| is_target(&i.path, i.line, i.line_end)).map(|i| i + 1)
}

/// The target's rank as the window shows it top to bottom (spec H.10): the
/// evidence list first, then the local hits not already in it (same path
/// and line range), in their order.
fn window_rank(
    evidence: &[EvidenceItemDto],
    local: &[SmartHitDto],
    is_target: &dyn Fn(&str, u32, u32) -> bool,
) -> Option<usize> {
    if let Some(rank) = evidence_rank(evidence, is_target) {
        return Some(rank);
    }
    let in_evidence = |h: &SmartHitDto| {
        evidence.iter().any(|i| (i.path.as_str(), i.line, i.line_end) == (h.hit.path.as_str(), h.hit.line, h.hit.line_end))
    };
    local
        .iter()
        .filter(|h| !in_evidence(h))
        .position(|h| is_target(&h.hit.path, h.hit.line, h.hit.line_end))
        .map(|i| evidence.len() + i + 1)
}

/// The round the target block was first a candidate in: the `found_round`
/// of a target evidence item, or the hop of a scored round that sent it
/// (a round's pool holds only this and earlier rounds' candidates).
fn found_round(rounds: &[EvidenceStepResult], is_target: &dyn Fn(&str, u32, u32) -> bool) -> Option<u8> {
    rounds
        .iter()
        .filter(|r| r.status == EnhanceStatus::Ok)
        .flat_map(|r| {
            let from_items = r.evidence.iter().filter(|i| is_target(&i.path, i.line, i.line_end)).map(|i| i.found_round);
            let sent = r.sent.iter().any(|(path, line, end)| is_target(path, *line, *end));
            from_items.chain(sent.then_some(r.hop))
        })
        .min()
}

fn round_row(round: &EvidenceStepResult, is_target: &dyn Fn(&str, u32, u32) -> bool) -> RoundRow {
    RoundRow {
        hop: round.hop,
        terms: round.terms.iter().map(|t| t.label.clone()).collect(),
        candidates: round.candidates,
        pool_size: round.pool_size,
        sent_blocks: round.sent_blocks,
        estimated_tokens: round.estimated_tokens,
        input_tokens: round.usage.as_ref().map(|u| u.input_tokens),
        request_count: round.request_count,
        elapsed_ms: round.elapsed_ms,
        status: round.status,
        stop: round.stop,
        evidence_rank: evidence_rank(&round.evidence, is_target),
    }
}

/// Score one task's pipeline output. On the judge route the model's part is
/// the evidence rounds (spec H.10): counts and time are summed over the
/// rounds, the status is the last round's, and a tier is the latest `ok`
/// round's (its evidence items, then its local rows). `final_rank` is the
/// rank the window shows: with an `ok` round, its evidence list then the
/// other local hits; otherwise the pipeline's hits (local or regrouped).
fn score(task: &EvalTask, target_indexed: bool, output: &PipelineOutput, settings: RunSettings) -> LookupEvalRow {
    let matches_target = |path: &str, line: u32, line_end: u32| {
        task.targets.iter().any(|t| t.path == path && t.line.map_or(true, |l| line <= l && l <= line_end))
    };
    let is_target = |hit: &SmartHitDto| matches_target(&hit.hit.path, hit.hit.line, hit.hit.line_end);
    let rank = |hits: &[SmartHitDto]| target_rank(hits, &task.targets).map(|(rank, _)| rank);
    let rounds = &output.evidence_rounds;
    let repair = output.repair.as_ref();
    let local_hits = &output.local.search.hits;
    let local_rank = rank(local_hits);
    let target_in_window = rounds.iter().any(|r| r.sent.iter().any(|(path, line, end)| matches_target(path, *line, *end)));
    let latest = rounds.iter().rev().find(|r| r.status == EnhanceStatus::Ok);
    let final_rank = match latest {
        Some(r) => window_rank(&r.evidence, local_hits, &matches_target),
        None => rank(&output.hits),
    };
    let fit_places: Vec<(&str, u32, u32)> = latest.map_or(Vec::new(), |r| {
        let local = r.local_tiers.iter().filter(|v| v.tier == Tier::Fit).filter_map(|v| {
            let h = local_hits.iter().find(|h| h.result_id.as_deref() == Some(v.result_id.as_str()))?;
            Some((h.hit.path.as_str(), h.hit.line, h.hit.line_end))
        });
        r.evidence
            .iter()
            .filter(|i| i.tier == Tier::Fit)
            .map(|i| (i.path.as_str(), i.line, i.line_end))
            .chain(local)
            .collect()
    });
    let is_fit = |hit: &SmartHitDto| fit_places.contains(&(hit.hit.path.as_str(), hit.hit.line, hit.hit.line_end));
    let scored = task.category != Category::Absent && target_indexed;
    let mismatch = scored
        && output
            .hits
            .iter()
            .enumerate()
            .any(|(i, hit)| is_fit(hit) && !is_target(hit) && final_rank.map_or(true, |target| i + 1 < target));
    let demoted = scored && latest.is_some() && matches!((local_rank, final_rank), (Some(l), Some(f)) if f > l);
    let evidence = (!rounds.is_empty()).then_some(rounds);
    let input_tokens = match evidence {
        Some(rounds) => {
            let reported: Vec<u64> = rounds.iter().filter_map(|r| r.usage.as_ref().map(|u| u.input_tokens)).collect();
            (!reported.is_empty()).then(|| reported.iter().sum())
        }
        None => repair.and_then(|r| r.usage.as_ref()).map(|u| u.input_tokens),
    };
    LookupEvalRow {
        id: task.id.clone(),
        category: task.category,
        split: task.split,
        target_indexed,
        local_rank,
        final_rank,
        route: Some(output.route),
        status: evidence.and_then(|r| r.last()).map(|r| r.status).or_else(|| repair.map(|r| r.status)),
        request_count: evidence
            .map(|r| r.iter().map(|r| r.request_count).sum())
            .or_else(|| repair.map(|r| r.request_count))
            .unwrap_or(0),
        reused: false,
        target_in_window,
        any_fit: !fit_places.is_empty(),
        mismatch,
        demoted,
        deep_rank: None,
        deep_ms: None,
        deep_error: None,
        local_ms: output.local_ms,
        enhance_ms: evidence.map(|r| r.iter().map(|r| r.elapsed_ms).sum()).or_else(|| repair.map(|r| r.elapsed_ms)),
        // Only rounds that went out: a round the budget stopped reports its
        // estimate but sent nothing.
        estimated_tokens: evidence.map_or(0, |r| r.iter().filter(|r| r.request_count > 0).map(|r| r.estimated_tokens).sum()),
        input_tokens,
        timeout_ms: settings.timeout_ms,
        error: None,
        max_hops: settings.max_hops,
        round_timeout_ms: settings.round_timeout_ms,
        evidence_rank: latest.and_then(|r| evidence_rank(&r.evidence, &matches_target)),
        found_round: found_round(rounds, &matches_target),
        rounds: rounds.iter().map(|r| round_row(r, &matches_target)).collect(),
    }
}

async fn eval_task(
    index: &IndexHandle,
    root: &Path,
    task: &EvalTask,
    params: &LookupParams,
    enhance: Option<&EnhanceSetup>,
    today: NaiveDate,
    client: &reqwest::Client,
) -> Result<LookupEvalRow, String> {
    let mut target_indexed = true;
    if task.category != Category::Absent {
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
    let output = run_pipeline(input, client).await?;
    let row = score(task, target_indexed, &output, RunSettings::of(params));
    if is_scored(&row) && row.local_rank.is_none() {
        return Ok(with_deep_pass(row, deep_pass(index, task, params, today)));
    }
    Ok(row)
}

/// Record the local deep pass on a scored row the normal pass missed. A
/// failed pass keeps the (paid) pipeline row and records `deep_error`; the
/// row then leaves C4's population.
fn with_deep_pass(mut row: LookupEvalRow, deep: Result<(Option<usize>, u64), String>) -> LookupEvalRow {
    match deep {
        Ok((deep_rank, deep_ms)) => {
            row.deep_rank = deep_rank;
            row.deep_ms = Some(deep_ms);
        }
        Err(error) => row.deep_error = Some(error),
    }
    row
}

/// Run every task through [`run_pipeline`] (window [`EVAL_WINDOW`], deep
/// off, time mode from `params`) and score it; scored tasks the local pass
/// missed also get a local deep pass. A task that fails becomes an error
/// row and the eval goes on. `on_row` sees each row as soon as it is done
/// (`--out` writes it then); its error stops the eval.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_lookup_eval(
    index: &IndexHandle,
    root: &Path,
    tasks: &[EvalTask],
    params: &LookupParams,
    enhance: Option<&EnhanceSetup>,
    today: NaiveDate,
    client: &reqwest::Client,
    on_row: &mut dyn FnMut(&LookupEvalRow) -> Result<(), String>,
) -> Result<Vec<LookupEvalRow>, String> {
    eval_each(tasks, RunSettings::of(params), |task| eval_task(index, root, task, params, enhance, today, client), on_row).await
}

/// The loop of [`run_lookup_eval`]: one task at a time, an error becomes an
/// error row, each row goes to `on_row` before the next task starts.
async fn eval_each<'t, F, Fut>(
    tasks: &'t [EvalTask],
    settings: RunSettings,
    mut run: F,
    on_row: &mut dyn FnMut(&LookupEvalRow) -> Result<(), String>,
) -> Result<Vec<LookupEvalRow>, String>
where
    F: FnMut(&'t EvalTask) -> Fut,
    Fut: std::future::Future<Output = Result<LookupEvalRow, String>>,
{
    let mut rows = Vec::with_capacity(tasks.len());
    for task in tasks {
        let row = match run(task).await {
            Ok(row) => row,
            Err(error) => error_row(task, settings, error),
        };
        on_row(&row)?;
        rows.push(row);
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
            route: Some(PipelineRoute::Judge),
            status: Some(EnhanceStatus::Ok),
            request_count: 1,
            reused: false,
            target_in_window: true,
            any_fit: false,
            mismatch: false,
            demoted: false,
            deep_rank: None,
            deep_ms: None,
            deep_error: None,
            local_ms: 10,
            enhance_ms: Some(100),
            estimated_tokens: 50,
            input_tokens: Some(40),
            timeout_ms: GATE_TIMEOUT_MS,
            error: None,
            max_hops: Some(0),
            round_timeout_ms: Some(GATE_ROUND_TIMEOUT_MS),
            evidence_rank: None,
            found_round: None,
            rounds: vec![],
        }
    }

    /// A round that sent one request (50 estimated, 40 reported tokens, 100 ms).
    fn round(hop: u8, status: EnhanceStatus, evidence_rank: Option<usize>) -> RoundRow {
        RoundRow {
            hop,
            terms: vec![],
            candidates: 5,
            pool_size: 5,
            sent_blocks: 5,
            estimated_tokens: 50,
            input_tokens: Some(40),
            request_count: 1,
            elapsed_ms: 100,
            status,
            stop: None,
            evidence_rank,
        }
    }

    fn repair_row(id: &str, fin: Option<usize>) -> LookupEvalRow {
        LookupEvalRow {
            route: Some(PipelineRoute::Repair),
            target_in_window: false,
            enhance_ms: Some(700),
            ..eval_row(id, None, fin)
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
            LookupEvalRow { mismatch: true, demoted: true, ..eval_row("pushed", Some(3), Some(8)) },
            eval_row("kept", Some(1), Some(1)),
            LookupEvalRow { category: Category::Absent, any_fit: true, target_in_window: false, ..eval_row("absent", None, None) },
            LookupEvalRow { target_indexed: false, ..eval_row("typo", None, None) },
            LookupEvalRow { input_tokens: None, ..repair_row("rescued", Some(30)) },
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
        assert_eq!((m.absent_tasks, m.absent_judged, m.absent_false_fit), (1, 1, 1));
        assert_eq!(m.absent_false_fit_rate, Some(1.0));
        assert_eq!((m.mismatches, m.demoted), (1, 1));
        assert_eq!(m.timeouts, 1);
        assert_eq!((m.tasks, m.errors, m.requests), (7, 0, 7));
        assert_eq!(m.timeout_rate, Some(1.0 / 7.0));
        // local ranks of the 5 scored rows: 7, 3, 1, None, 20 → 4 within 50
        assert_eq!(m.top50_coverage, Some(4.0 / 5.0));
        // input tokens: 5 rows with 40, 2 without
        assert_eq!((m.input_tokens, m.usage_unknown, m.estimated_tokens), (200, 2, 350));
        assert_eq!(m.local_p50_ms, Some(10));
        assert_eq!(m.timeout_ms, Some(GATE_TIMEOUT_MS));
        let dev = lookup_metrics(&rows, "dev");
        assert_eq!((dev.split.as_str(), dev.tasks, dev.scored, dev.timeouts), ("dev", 1, 1, 1));
        assert_eq!(lookup_metrics(&rows, "holdout").tasks, 6);
        // Rows without a request count for neither the rate nor the latencies.
        let unsent = LookupEvalRow { request_count: 0, enhance_ms: None, ..eval_row("x", Some(1), Some(1)) };
        let m = lookup_metrics(&[unsent], "all");
        assert_eq!((m.requests, m.timeout_rate, m.judge_p50_ms, m.window_coverage), (0, None, None, None));
    }

    #[test]
    fn window_coverage_counts_only_judged_rows() {
        // judged scored rows: gain, pushed, kept, slow (a repair request is no
        // judgement); target in window: gain, pushed, kept.
        assert_eq!(lookup_metrics(&section_9_3_rows(), "all").window_coverage, Some(3.0 / 4.0));
        let reused = LookupEvalRow { request_count: 0, reused: true, target_in_window: false, ..eval_row("r", Some(2), Some(2)) };
        let skipped = LookupEvalRow { request_count: 0, status: Some(EnhanceStatus::NoConsent), ..eval_row("s", Some(2), Some(2)) };
        let m = lookup_metrics(&[eval_row("a", Some(1), Some(1)), reused, skipped, repair_row("p", None)], "all");
        assert_eq!(m.window_coverage, Some(1.0 / 2.0));
    }

    #[test]
    fn timeouts_and_latencies_are_split_by_route() {
        let rows = section_9_3_rows();
        let m = lookup_metrics(&rows, "all");
        assert_eq!((m.judge_requests, m.judge_timeouts, m.repair_requests, m.repair_timeouts), (6, 1, 1, 0));
        assert_eq!((m.judge_timeout_rate, m.repair_timeout_rate), (Some(1.0 / 6.0), Some(0.0)));
        assert_eq!((m.judge_p50_ms, m.judge_p95_ms, m.repair_p50_ms, m.repair_p95_ms), (Some(100), Some(100), Some(700), Some(700)));
    }

    fn gains() -> Vec<LookupEvalRow> {
        (0..3).map(|i| eval_row(&format!("g{i}"), Some(9), Some(1))).collect()
    }

    #[test]
    fn gates_follow_the_confirmed_thresholds() {
        assert_eq!(gate_verdicts(&gains()).c3, Some(true));
        assert_eq!(gate_verdicts(&gains()).c4, None);
        assert_eq!(gate_verdicts(&gains()[..2]).c3, Some(false));
        let mut pushed = gains();
        pushed.extend([eval_row("p1", Some(1), Some(9)), eval_row("p2", Some(2), None)]);
        pushed.extend((3..5).map(|i| eval_row(&format!("g{i}"), None, Some(2))));
        // gained 5 − pushed 2 = 3, but two pushed out
        assert_eq!(gate_verdicts(&pushed).c3, Some(false));
        let absent = |id: &str, fit: bool| LookupEvalRow { category: Category::Absent, any_fit: fit, ..eval_row(id, None, None) };
        let mut with_absent = gains();
        with_absent.extend([absent("a1", true), absent("a2", false), absent("a3", false)]);
        assert_eq!(gate_verdicts(&with_absent).c3, Some(true));
        with_absent.push(absent("a4", true));
        assert_eq!(gate_verdicts(&with_absent).c3, Some(false));
        // One round sent and it timed out: 100% > 5%.
        let mut slow = gains();
        slow.push(LookupEvalRow {
            status: Some(EnhanceStatus::Timeout),
            rounds: vec![round(0, EnhanceStatus::Timeout, None)],
            ..eval_row("t", Some(1), Some(1))
        });
        assert_eq!(gate_verdicts(&slow).c3, Some(false));
        assert_eq!(
            gate_verdicts(&[]),
            GateVerdicts {
                c3: None,
                c4: None,
                c5: None,
                timeout_ms: None,
                round_timeout_ms: None,
                max_hops: None,
                note: None,
                c3_note: None,
                c4_note: None,
                c5_note: None,
                c4_tasks: 0,
                c4_rescued: 0,
                c5_bridge_tasks: 0,
                c5_expansion_only: 0,
                c5_recall_gain: 0,
                c5_lost: 0,
            }
        );
    }

    #[test]
    fn c3_gates_on_round_timeouts_and_c4_on_repair_timeouts() {
        // A slow repair model does not fail C3 ...
        let mut rows = gains();
        rows.push(LookupEvalRow { status: Some(EnhanceStatus::Timeout), ..repair_row("slow repair", None) });
        assert_eq!(gate_verdicts(&rows).c3, Some(true));
        assert_eq!(gate_verdicts(&rows).c4, Some(false));
        // ... and round timeouts do not fail C4.
        let mut rows = vec![repair_row("r1", Some(4)), repair_row("r2", None), repair_row("r3", None)];
        rows.push(LookupEvalRow {
            status: Some(EnhanceStatus::Timeout),
            rounds: vec![round(0, EnhanceStatus::Timeout, None)],
            ..eval_row("slow judge", Some(1), Some(1))
        });
        assert_eq!(gate_verdicts(&rows).c4, Some(true));
        assert_eq!(gate_verdicts(&rows).c3, Some(false));
    }

    #[test]
    fn c4_counts_only_tasks_the_deep_pass_also_missed() {
        let deep_found = LookupEvalRow { deep_rank: Some(3), ..repair_row("deep", None) };
        let rows = [repair_row("m1", Some(40)), repair_row("m2", None), deep_found.clone()];
        let gates = gate_verdicts(&rows);
        assert_eq!((gates.c4_tasks, gates.c4_rescued, gates.c4), (2, 1, Some(true)));
        assert_eq!(gate_verdicts(&[repair_row("m2", None), deep_found]).c4, Some(false));
        let missed = [repair_row("m1", Some(40)), repair_row("m2", None), repair_row("m3", Some(60))];
        assert_eq!(gate_verdicts(&missed).c4, Some(true));
        assert_eq!(gate_verdicts(&missed[1..]).c4, Some(false));
    }

    #[test]
    fn a_failed_deep_pass_keeps_the_paid_row_and_leaves_c4() {
        let paid = LookupEvalRow { input_tokens: Some(120), ..repair_row("t09", Some(4)) };
        let row = with_deep_pass(paid.clone(), Err("index busy".into()));
        assert_eq!(row.error, None, "{row:?}");
        assert_eq!(row.deep_error.as_deref(), Some("index busy"));
        assert_eq!((row.route, row.status, row.request_count), (paid.route, paid.status, 1));
        assert_eq!((row.final_rank, row.input_tokens, row.enhance_ms), (Some(4), Some(120), Some(700)));
        assert_eq!((row.deep_rank, row.deep_ms), (None, None));
        // Its deep pass never ran, so C4's 「deep 也未召回」 is unknown: not counted.
        let gates = gate_verdicts(&[row.clone(), repair_row("m2", None)]);
        assert_eq!((gates.c4_tasks, gates.c4_rescued), (1, 0));
        // Still a scored, paid row everywhere else.
        assert_eq!(lookup_metrics(&[row.clone()], "all").errors, 0);
        let line = serde_json::to_string(&row).unwrap();
        assert!(line.contains(r#""deepError":"index busy""#), "{line}");
        // A finished deep pass is recorded as before.
        let found = with_deep_pass(paid, Ok((Some(9), 40)));
        assert_eq!((found.deep_rank, found.deep_ms, found.deep_error), (Some(9), Some(40), None));
    }

    #[test]
    fn c4_is_only_evaluated_at_the_three_second_limit() {
        // C4 keeps the 3 s rule; C3 now depends on the round limit only.
        let rescued = |r: LookupEvalRow| vec![r, repair_row("r2", Some(5)), repair_row("r3", Some(6))];
        assert_eq!(gate_verdicts(&rescued(repair_row("r1", Some(4)))).c4, Some(true));
        let longer: Vec<LookupEvalRow> =
            gains().into_iter().chain(rescued(repair_row("r1", Some(4)))).map(|r| LookupEvalRow { timeout_ms: 10_000, ..r }).collect();
        let gates = gate_verdicts(&longer);
        assert_eq!((gates.c3, gates.c4, gates.timeout_ms), (Some(true), None, Some(10_000)));
        assert_eq!((gates.note.as_deref(), gates.c4_note.as_deref()), (None, Some("timeout ≠ 3 s")));
        assert_eq!(lookup_metrics(&longer, "all").timeout_ms, Some(10_000));
        let mut mixed = gains();
        mixed.extend(rescued(LookupEvalRow { timeout_ms: 10_000, ..repair_row("r1", Some(4)) }));
        let gates = gate_verdicts(&mixed);
        assert_eq!((gates.c3, gates.c4, gates.c4_note.as_deref()), (Some(true), None, Some("timeout ≠ 3 s")));
        assert_eq!(lookup_metrics(&mixed, "all").timeout_ms, None);
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

    /// A scored holdout bridge task on a `maxHops = 1` run: (evidenceRank,
    /// foundRound, round0Rank); rounds 0 and 1 both sent and finished.
    fn bridge(evidence: Option<usize>, found: Option<u8>, round0: Option<usize>) -> LookupEvalRow {
        LookupEvalRow {
            category: Category::Bridge,
            max_hops: Some(1),
            evidence_rank: evidence,
            found_round: found,
            final_rank: evidence,
            rounds: vec![round(0, EnhanceStatus::Ok, round0), round(1, EnhanceStatus::Ok, evidence)],
            ..eval_row("bridge", None, None)
        }
    }

    fn holdout(rows: &[LookupEvalRow]) -> Vec<LookupEvalRow> {
        rows.iter()
            .enumerate()
            .map(|(i, r)| LookupEvalRow { id: format!("h{i}"), split: Split::Holdout, ..r.clone() })
            .collect()
    }

    #[test]
    fn c5_needs_expansion_only_recall_and_no_regression() {
        let rows = holdout(&[
            bridge(Some(3), Some(1), None),
            bridge(Some(5), Some(2), None),
            bridge(Some(2), Some(0), Some(2)),
            bridge(None, None, None),
        ]);
        let g = gate_verdicts(&rows);
        assert_eq!(g.c5_bridge_tasks, 4);
        assert_eq!(g.c5, Some(true)); // expansionOnly 2，recall 3 vs round0 1（+2），lost 0
        assert_eq!((g.c5_expansion_only, g.c5_recall_gain, g.c5_lost, g.c5_note.clone()), (2, 2, 0, None));
        assert_eq!(gate_verdicts(&rows[..3]).c5, None); // 桥接题不足 4
        assert_eq!(gate_verdicts(&rows[..3]).c5_note.as_deref(), Some("bridge tasks < 4"));
        let m = lookup_metrics(&rows, "holdout");
        assert_eq!((m.evidence_recall10, m.evidence_recall10_round0), (Some(0.75), Some(0.25)));
        assert_eq!((m.expansion_only, m.lost_by_expansion), (2, 0));
        // Only one task found by expansion.
        let one = holdout(&[
            bridge(Some(3), Some(1), None),
            bridge(Some(5), Some(0), None),
            bridge(Some(2), Some(0), Some(2)),
            bridge(None, None, None),
        ]);
        assert_eq!(gate_verdicts(&one).c5, Some(false));
        // The recall gain is only one task.
        let mut flat = rows.clone();
        flat[1].rounds[0].evidence_rank = Some(7);
        assert_eq!((gate_verdicts(&holdout(&flat)).c5_recall_gain, gate_verdicts(&holdout(&flat)).c5), (1, Some(false)));
        // Two targets that round 0 had are lost; two more gained keep the gain at +2.
        let mut lost = rows.to_vec();
        lost.extend([bridge(None, None, Some(1)), bridge(None, None, Some(4))]);
        lost.extend([bridge(Some(1), Some(1), None), bridge(Some(4), Some(1), None)]);
        let g = gate_verdicts(&holdout(&lost));
        assert_eq!((g.c5_expansion_only, g.c5_recall_gain, g.c5_lost, g.c5), (4, 2, 2, Some(false)));
        // One timed-out round of 10 sent: 10% > 5%.
        let mut slow = rows.to_vec();
        slow.push(LookupEvalRow {
            rounds: vec![round(0, EnhanceStatus::Ok, None), round(1, EnhanceStatus::Timeout, None)],
            ..bridge(None, None, None)
        });
        assert_eq!(lookup_metrics(&holdout(&slow), "all").round_timeout_rate, Some(0.1));
        assert_eq!(gate_verdicts(&holdout(&slow)).c5, Some(false));
        // C5 needs maxHops ≥ 1; only scored tasks count as bridge tasks.
        let no_hops: Vec<LookupEvalRow> = rows.iter().map(|r| LookupEvalRow { max_hops: Some(0), ..r.clone() }).collect();
        let g = gate_verdicts(&no_hops);
        assert_eq!((g.c5, g.c5_note.as_deref()), (None, Some("maxHops = 0")));
        let mut unindexed = rows.clone();
        unindexed[3].target_indexed = false;
        assert_eq!(gate_verdicts(&unindexed).c5_bridge_tasks, 3);
        // C3 is the other way round: decided at maxHops 0, n/a at 1.
        assert_eq!((g.c3_note.as_deref(), gate_verdicts(&rows).c3_note.as_deref()), (None, Some("maxHops ≠ 0")));
    }

    fn evidence_item(path: &str, line: u32, found_round: u8) -> EvidenceItemDto {
        EvidenceItemDto {
            evidence_id: format!("e-{path}-{line}"),
            path: path.into(),
            line,
            line_end: line,
            title: String::new(),
            breadcrumb: String::new(),
            text: String::new(),
            found_round,
            tier: Tier::Unsure,
            local_result_id: None,
        }
    }

    fn local_hit(path: &str, line: u32) -> SmartHitDto {
        SmartHitDto {
            hit: crate::search::HitDto {
                path: path.into(),
                abs_path: String::new(),
                line,
                line_end: line,
                text: String::new(),
                breadcrumb: String::new(),
                level: "line".into(),
                score: 0.0,
                doc_date: None,
                source_ref: String::new(),
                agent_by: None,
                human_verified: false,
                origin: String::new(),
                concept_type: None,
                pinned: false,
            },
            fused_score: 0.0,
            relevance_reasons: vec![],
            matched_queries: vec![],
            result_id: None,
        }
    }

    #[test]
    fn final_rank_reads_evidence_first_then_remaining_local_hits() {
        let target = |t: &'static str| move |path: &str, _: u32, _: u32| path == t;
        let evidence = [evidence_item("x.md", 1, 0), evidence_item("t.md", 1, 0)];
        let local = [local_hit("y.md", 1), local_hit("t.md", 1), local_hit("z.md", 1)];
        // 证据 [x,t]、本地 [y,t,z] → t 的 finalRank 2.
        assert_eq!(window_rank(&evidence, &local, &target("t.md")), Some(2));
        assert_eq!(evidence_rank(&evidence, &target("t.md")), Some(2));
        // Not in the evidence: the evidence count plus its rank among the
        // local hits without the evidence ones (y, z): z is 2 + 2.
        assert_eq!(window_rank(&evidence, &local, &target("z.md")), Some(4));
        assert_eq!(window_rank(&evidence, &local, &target("y.md")), Some(3));
        assert_eq!(evidence_rank(&evidence, &target("z.md")), None);
        assert_eq!(window_rank(&evidence, &local, &target("w.md")), None);
        // A local hit is excluded only when the evidence has the same block.
        let other_block = [evidence_item("x.md", 1, 0), evidence_item("y.md", 9, 0)];
        assert_eq!(window_rank(&other_block, &local, &target("t.md")), Some(4));
        // No evidence: the local order.
        assert_eq!(window_rank(&[], &local, &target("t.md")), Some(2));
    }

    #[test]
    fn found_round_and_round_rows_come_from_the_evidence_steps() {
        let is_target = |path: &str, _: u32, _: u32| path == "t.md";
        let step = |hop: u8, status: EnhanceStatus, evidence: Vec<EvidenceItemDto>, sent: &[&str]| EvidenceStepResult {
            hop,
            status,
            evidence,
            sent: sent.iter().map(|p| (p.to_string(), 1, 1)).collect(),
            request_count: 2,
            candidates: 4,
            pool_size: 6,
            sent_blocks: sent.len(),
            estimated_tokens: 300,
            usage: Some(crate::smart_enhance::UsageDto { input_tokens: 250, output_tokens: 9 }),
            elapsed_ms: 70,
            terms: vec![crate::smart_enhance::evidence::EvidenceTermDto {
                term: "alice paul".into(),
                label: "Alice Paul".into(),
                kind: crate::smart_enhance::sag::TermKind::NamePhrase,
            }],
            ..EvidenceStepResult::default()
        };
        // Sent in round 1, never in the evidence: found in round 1.
        let rounds = [
            step(0, EnhanceStatus::Ok, vec![evidence_item("x.md", 1, 0)], &["x.md"]),
            step(1, EnhanceStatus::Ok, vec![evidence_item("x.md", 1, 0)], &["x.md", "t.md"]),
        ];
        assert_eq!(found_round(&rounds, &is_target), Some(1));
        // An evidence item's own found_round wins over a later send.
        let rounds = [
            step(0, EnhanceStatus::Ok, vec![], &["x.md"]),
            step(1, EnhanceStatus::Ok, vec![evidence_item("t.md", 1, 0)], &["t.md"]),
        ];
        assert_eq!(found_round(&rounds, &is_target), Some(0));
        // A failed round's partial send does not count.
        let rounds = [step(0, EnhanceStatus::Ok, vec![], &["x.md"]), step(1, EnhanceStatus::Timeout, vec![], &["t.md"])];
        assert_eq!(found_round(&rounds, &is_target), None);
        let row = round_row(&step(1, EnhanceStatus::Ok, vec![evidence_item("x.md", 1, 0), evidence_item("t.md", 1, 1)], &[]), &is_target);
        assert_eq!(
            row,
            RoundRow {
                hop: 1,
                terms: vec!["Alice Paul".into()],
                candidates: 4,
                pool_size: 6,
                sent_blocks: 0,
                estimated_tokens: 300,
                input_tokens: Some(250),
                request_count: 2,
                elapsed_ms: 70,
                status: EnhanceStatus::Ok,
                stop: None,
                evidence_rank: Some(2),
            }
        );
        let json = serde_json::to_value(&row).unwrap();
        for key in ["hop", "terms", "candidates", "poolSize", "sentBlocks", "estimatedTokens", "inputTokens", "requestCount", "elapsedMs", "status", "stop", "evidenceRank"] {
            assert!(json.get(key).is_some(), "{key}: {json}");
        }
    }

    #[test]
    fn per_round_metrics_and_compare_across_max_hops() {
        let slow = |r: RoundRow| RoundRow { elapsed_ms: 300, ..r };
        // maxHops 0: a found in round 0 (rank 2), b not found.
        let zero = vec![
            LookupEvalRow {
                evidence_rank: Some(2),
                found_round: Some(0),
                rounds: vec![round(0, EnhanceStatus::Ok, Some(2))],
                ..eval_row("a", Some(2), Some(2))
            },
            LookupEvalRow { rounds: vec![round(0, EnhanceStatus::Ok, None)], ..eval_row("b", None, None) },
        ];
        // maxHops 1: round 1 moves a to 1 and finds b (rank 4).
        let one = vec![
            LookupEvalRow {
                max_hops: Some(1),
                evidence_rank: Some(1),
                found_round: Some(0),
                rounds: vec![round(0, EnhanceStatus::Ok, Some(2)), slow(round(1, EnhanceStatus::Ok, Some(1)))],
                ..eval_row("a", Some(2), Some(1))
            },
            LookupEvalRow {
                max_hops: Some(1),
                evidence_rank: Some(4),
                found_round: Some(1),
                rounds: vec![
                    round(0, EnhanceStatus::Ok, None),
                    slow(round(1, EnhanceStatus::Ok, Some(4))),
                    // A round that sent nothing (a stop) reports an earlier hop: not counted.
                    RoundRow { request_count: 0, estimated_tokens: 999, ..round(0, EnhanceStatus::Ok, Some(4)) },
                ],
                ..eval_row("b", None, Some(4))
            },
        ];
        let m = lookup_metrics(&one, "all");
        assert_eq!((m.max_hops, m.round_timeout_ms), (Some(1), Some(GATE_ROUND_TIMEOUT_MS)));
        assert_eq!((m.round_tokens.clone(), m.round_input_tokens.clone()), (vec![100, 100], vec![80, 80]));
        assert_eq!((m.round_p50_ms.clone(), m.round_p95_ms.clone()), (vec![Some(100), Some(300)], vec![Some(100), Some(300)]));
        assert_eq!((m.round_requests, m.round_timeouts, m.round_timeout_rate), (4, 0, Some(0.0)));
        assert_eq!((m.evidence_recall10, m.evidence_recall10_round0), (Some(1.0), Some(0.5)));
        assert_eq!((m.expansion_only, m.lost_by_expansion), (1, 0));
        // Two --out files read back, then compared by name.
        let jsonl = |rows: &[LookupEvalRow]| rows.iter().map(|r| serde_json::to_string(r).unwrap() + "\n").collect::<String>();
        let current = lookup_metrics(&load_eval_rows(&jsonl(&one)).unwrap(), "all");
        let baseline = lookup_metrics(&load_eval_rows(&jsonl(&zero)).unwrap(), "all");
        assert_eq!(baseline.round_tokens, vec![100]);
        let deltas = compare_metrics(&current, &baseline);
        let find = |deltas: &[MetricDelta], name: &str| deltas.iter().find(|d| d.metric == name).cloned().unwrap_or_else(|| panic!("{name}: {deltas:?}"));
        assert_eq!(find(&deltas, "evidenceRecall10").delta, Some(0.5));
        assert_eq!(find(&deltas, "roundTokens[0]").delta, Some(0.0));
        assert_eq!(find(&deltas, "maxHops").delta, Some(1.0));
        let hop1 = find(&deltas, "roundTokens[1]");
        assert_eq!((hop1.current, hop1.baseline, hop1.delta), (Some(100.0), None, None));
        assert_eq!(find(&deltas, "roundP95Ms[1]").current, Some(300.0));
        // The other way round, hop 1 is the baseline's only.
        let back = compare_metrics(&baseline, &current);
        let hop1 = find(&back, "roundTokens[1]");
        assert_eq!((hop1.current, hop1.baseline), (None, Some(100.0)));
        assert_eq!(back.len(), deltas.len());
        assert_eq!(metric_values(&current).iter().filter(|(n, _)| n.starts_with("round") && n.ends_with("[1]")).count(), 4);
    }

    #[test]
    fn gates_are_na_off_the_default_round_timeout() {
        // Checked first: every gate is n/a, whatever else holds.
        let rows: Vec<LookupEvalRow> = gains().into_iter().map(|r| LookupEvalRow { round_timeout_ms: Some(5_000), ..r }).collect();
        let g = gate_verdicts(&rows);
        assert_eq!((g.c3, g.c4, g.c5), (None, None, None));
        assert_eq!(g.note.as_deref(), Some("round timeout ≠ 10 s"));
        assert_eq!((g.round_timeout_ms, g.c3_note.clone(), g.c4_note.clone(), g.c5_note.clone()), (Some(5_000), None, None, None));
        assert_eq!(gate_verdicts(&gains()).c3, Some(true));
        // A bridge run off the default round limit: C5 is n/a too.
        let bridges: Vec<LookupEvalRow> = holdout(&[
            bridge(Some(3), Some(1), None),
            bridge(Some(5), Some(2), None),
            bridge(Some(2), Some(0), Some(2)),
            bridge(None, None, None),
        ])
        .into_iter()
        .map(|r| LookupEvalRow { round_timeout_ms: Some(20_000), ..r })
        .collect();
        let g = gate_verdicts(&bridges);
        assert_eq!((g.c5, g.note.as_deref()), (None, Some("round timeout ≠ 10 s")));
        // Rows from before the field, or a mix of limits, are not the default either.
        let old: Vec<LookupEvalRow> = gains().into_iter().map(|r| LookupEvalRow { round_timeout_ms: None, ..r }).collect();
        assert_eq!(gate_verdicts(&old).note.as_deref(), Some("round timeout ≠ 10 s"));
        let mut mixed = gains();
        mixed.push(rows[0].clone());
        assert_eq!((gate_verdicts(&mixed).c3, gate_verdicts(&mixed).round_timeout_ms), (None, None));
        // At 10 s, C3 still needs maxHops 0.
        let hops: Vec<LookupEvalRow> = gains().into_iter().map(|r| LookupEvalRow { max_hops: Some(1), ..r }).collect();
        let g = gate_verdicts(&hops);
        assert_eq!((g.c3, g.c3_note.as_deref(), g.note.clone()), (None, Some("maxHops ≠ 0"), None));
        let mut mixed_hops = gains();
        mixed_hops.push(hops[0].clone());
        let g = gate_verdicts(&mixed_hops);
        assert_eq!((g.c3_note.as_deref(), g.c5_note.as_deref()), (Some("maxHops mixed"), Some("maxHops mixed")));
    }

    #[test]
    fn eval_rows_round_trip_and_a_bad_line_names_its_number() {
        let mut rows = section_9_3_rows();
        rows.push(error_row(&load_tasks(r#"{"tasks":[{"id":"e","question":"q","targets":[],"category":"absent","split":"dev"}]}"#).unwrap()[0], RunSettings::of(&LookupParams::default()), "boom".into()));
        let jsonl: String = rows.iter().map(|r| serde_json::to_string(r).unwrap() + "\n").collect();
        assert_eq!(load_eval_rows(&format!("{jsonl}\n")).unwrap(), rows);
        let broken = format!("{jsonl}{{\"id\":1}}\n");
        assert!(load_eval_rows(&broken).unwrap_err().contains(&format!("line {}", rows.len() + 1)));
        // A row written before the fix-round fields still reads.
        let old = r#"{"id":"o","category":"exact","split":"dev","targetIndexed":true,"localRank":1,"finalRank":1,"route":"judge","status":"ok","requestCount":1,"reused":false,"targetInWindow":true,"anyFit":true,"localMs":3,"enhanceMs":9,"estimatedTokens":5,"inputTokens":null}"#;
        let old = load_eval_rows(old).unwrap();
        assert_eq!((old[0].route, old[0].timeout_ms, old[0].error.clone()), (Some(PipelineRoute::Judge), 0, None));
        // ... and so does one written before the per-round fields (spec H.10).
        assert_eq!((old[0].max_hops, old[0].round_timeout_ms, old[0].evidence_rank, old[0].found_round), (None, None, None, None));
        assert!(old[0].rounds.is_empty());
        let m = lookup_metrics(&old, "all");
        assert_eq!((m.max_hops, m.round_timeout_ms, m.round_requests), (None, None, 0));
        assert!(m.round_tokens.is_empty());
        assert_eq!((m.evidence_recall10, m.evidence_recall10_round0), (Some(0.0), Some(0.0)));
    }

    #[tokio::test]
    async fn a_failing_task_becomes_an_error_row_and_rows_arrive_one_by_one() {
        let tasks = load_tasks(
            r#"{"tasks":[
              {"id":"a","question":"q","targets":[{"path":"a.md"}],"category":"exact","split":"dev"},
              {"id":"b","question":"q","targets":[{"path":"b.md"}],"category":"exact","split":"holdout"},
              {"id":"c","question":"q","targets":[],"category":"absent","split":"holdout"}
            ]}"#,
        )
        .unwrap();
        let events = std::cell::RefCell::new(Vec::new());
        let mut on_row = |row: &LookupEvalRow| {
            events.borrow_mut().push(format!("row {}", row.id));
            Ok(())
        };
        let rows = eval_each(
            &tasks,
            RunSettings::of(&LookupParams::default()),
            |task| {
                events.borrow_mut().push(format!("run {}", task.id));
                let result = if task.id == "b" { Err("index lock poisoned".to_string()) } else { Ok(eval_row(&task.id, Some(1), Some(1))) };
                async move { result }
            },
            &mut on_row,
        )
        .await
        .unwrap();
        assert_eq!(events.into_inner(), ["run a", "row a", "run b", "row b", "run c", "row c"]);
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[1].error.as_deref(), rows[1].route, rows[1].timeout_ms), (Some("index lock poisoned"), None, 3_000));
        // An error row still records the run's maxHops and round limit.
        assert_eq!((rows[1].max_hops, rows[1].round_timeout_ms), (Some(1), Some(10_000)));
        let m = lookup_metrics(&rows, "all");
        assert_eq!((m.tasks, m.errors, m.scored, m.requests), (3, 1, 2, 2));
        // An error from `on_row` (the --out file) stops the eval.
        let mut failing = |_: &LookupEvalRow| Err("disk full".to_string());
        let err = eval_each(&tasks, RunSettings::of(&LookupParams::default()), |task| { let r = Ok(eval_row(&task.id, None, None)); async move { r } }, &mut failing).await;
        assert_eq!(err.unwrap_err(), "disk full");
    }

    #[tokio::test]
    async fn lookup_eval_runs_the_pipeline_on_a_fixture_vault() {
        use crate::smart_enhance::JevRequestConfig;
        use crate::smart_model::{endpoint_host, AuthMode};
        use std::sync::atomic::Ordering::SeqCst;
        let vault = tempfile::tempdir().unwrap();
        let words = "EvalBudget release risk";
        for (name, extra) in [("a.md", "first"), ("b.md", "second"), ("c.md", "third")] {
            std::fs::write(vault.path().join(name), format!("# {name}\n{words} {extra}\n")).unwrap();
        }
        std::fs::write(vault.path().join("other.md"), "# Other\nunrelated gardening notes\n").unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut idx = SearchIndex::open_at(vault.path(), &data.path().join("i.db"), "sync").unwrap();
        idx.sweep(&searchidx::ScanOptions::default(), None).unwrap();
        let handle: IndexHandle = Arc::new(Mutex::new(Some(idx)));
        let tasks = load_tasks(
            r#"{"tasks":[
              {"id":"t01","question":"EvalBudget release risk","targets":[{"path":"b.md","line":2}],"category":"exact","split":"holdout"},
              {"id":"t02","question":"quantum pasta","targets":[],"category":"absent","split":"holdout"},
              {"id":"t03","question":"zebra quokka lemur","targets":[{"path":"other.md"}],"category":"synonym","split":"holdout"}
            ]}"#,
        )
        .unwrap();
        // a fit, b (the target) unfit, c unsure: the evidence is a, c, b.
        let server = crate::smart_model::test_support::serve_noul(
            |q| {
                let passage = q["instructions"]["candidate_passage"].as_str().unwrap_or("");
                if passage.ends_with("first") {
                    0.95
                } else if passage.ends_with("second") {
                    0.1
                } else {
                    0.5
                }
            },
            |_| std::time::Duration::ZERO,
        )
        .await;
        let (base, accepted) = (server.base.clone(), server.accepted.clone());
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
        let mut seen = Vec::new();
        let rows = run_lookup_eval(
            &handle,
            vault.path(),
            &tasks,
            &LookupParams::default(),
            Some(&enhance),
            NaiveDate::from_ymd_opt(2026, 11, 10).unwrap(),
            &client,
            &mut |row| {
                seen.push(row.id.clone());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(seen, ["t01", "t02", "t03"]);
        let exact = &rows[0];
        // Every round's requests are counted (each answer reports 10 input tokens).
        let requests = accepted.load(SeqCst) as u32;
        assert_eq!((exact.route, exact.status, exact.request_count), (Some(PipelineRoute::Judge), Some(EnhanceStatus::Ok), requests), "{exact:?}");
        assert!(requests >= 1);
        assert!(exact.target_in_window && exact.any_fit && exact.target_indexed, "{exact:?}");
        assert_eq!((exact.local_rank, exact.final_rank, exact.input_tokens), (Some(2), Some(3), Some(10 * requests as u64)), "{exact:?}");
        assert!(exact.mismatch && exact.demoted, "{exact:?}");
        assert!(exact.estimated_tokens > 0 && exact.enhance_ms.is_some());
        assert_eq!((exact.deep_ms, exact.timeout_ms), (None, GATE_TIMEOUT_MS));
        // Spec H.10: the evidence is a, c, b, so the target is third there and
        // on screen; it was a round-0 candidate.
        assert_eq!((exact.max_hops, exact.round_timeout_ms), (Some(1), Some(GATE_ROUND_TIMEOUT_MS)));
        assert_eq!((exact.evidence_rank, exact.found_round), (Some(3), Some(0)), "{exact:?}");
        assert_eq!(exact.rounds[0].hop, 0);
        assert_eq!(exact.rounds[0].evidence_rank, Some(3), "{exact:?}");
        assert_eq!(exact.rounds.iter().map(|r| r.request_count).sum::<u32>(), exact.request_count);
        assert_eq!(exact.rounds.iter().filter_map(|r| r.input_tokens).sum::<u64>(), 10 * requests as u64);
        assert!(exact.rounds[0].candidates > 0 && exact.rounds[0].sent_blocks > 0, "{exact:?}");
        let absent = &rows[1];
        assert_eq!((absent.route, absent.request_count, absent.local_rank), (Some(PipelineRoute::Repair), 0, None), "{absent:?}");
        assert!(!absent.mismatch && absent.deep_ms.is_none());
        // Scored and missed locally: a local deep pass ran (no model) and missed too.
        let missed = &rows[2];
        assert_eq!((missed.local_rank, missed.deep_rank, missed.request_count), (None, None, 0), "{missed:?}");
        assert!(missed.deep_ms.is_some(), "{missed:?}");
        assert_eq!(accepted.load(SeqCst) as u32, requests, "only the judge route sends");
        let jsonl: String = rows.iter().map(|r| serde_json::to_string(r).unwrap() + "\n").collect();
        assert_eq!(load_eval_rows(&jsonl).unwrap(), rows);
        let gates = gate_verdicts(&rows);
        assert_eq!((gates.c4_tasks, gates.c4_rescued, gates.c4), (1, 0, Some(false)));
        // The default maxHops is 1: C3 is for maxHops 0, and there is no bridge task for C5.
        assert_eq!((gates.c3, gates.c3_note.as_deref()), (None, Some("maxHops ≠ 0")));
        assert_eq!((gates.c5, gates.c5_note.as_deref(), gates.c5_bridge_tasks), (None, Some("bridge tasks < 4"), 0));
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
