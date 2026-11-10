//! Offline evaluation of the local lookup baseline (experiment E1).
//!
//! Compiled only for tests and never shipped. E1 costs nothing: it runs the
//! existing local smart search over a copy of a real index and records where
//! each task's target lands, so the pre-gates of feasibility spec §9.3 can
//! decide which paid experiments are worth running at all. Plan Tasks 3–4.
//!
//! SKELETON: types, signatures and tests are final; the bodies are not
//! written yet. Every test in this file is expected to fail until they are.

#![allow(dead_code)]

use std::path::Path;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::smart::SmartHitDto;
use super::IndexHandle;

/// Where a task expects its answer. `line` narrows the match to the block
/// that covers that 1-based line; without it any hit in the file counts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EvalTarget {
    pub path: String,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Category {
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
pub(super) enum Split {
    Dev,
    Holdout,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EvalTask {
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
/// contains `..`.
pub(super) fn load_tasks(json: &str) -> Result<Vec<EvalTask>, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TaskFile {
        tasks: Vec<EvalTask>,
    }
    let file: TaskFile = serde_json::from_str(json).map_err(|e| format!("task file: {e}"))?;
    if file.tasks.is_empty() {
        return Err("task file: no tasks".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for task in &file.tasks {
        let id = &task.id;
        if !seen.insert(id.as_str()) {
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
        for target in &task.targets {
            let path = Path::new(&target.path);
            let escapes = path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir));
            if target.path.trim().is_empty()
                || target.path.starts_with(['/', '\\'])
                || path.is_absolute()
                || escapes
            {
                return Err(format!(
                    "task {id}: target path {:?} must be a non-empty relative path without `..`",
                    target.path
                ));
            }
        }
    }
    Ok(file.tasks)
}

/// The best 1-based rank among `targets`, with the level of the block that
/// matched. A hit matches when the paths are equal and the target's line is
/// absent or lies inside `[hit.line, hit.line_end]`.
pub(super) fn target_rank(hits: &[SmartHitDto], targets: &[EvalTarget]) -> Option<(usize, String)> {
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
    /// False when a target path is not a file in the vault — a typo in the
    /// task file. Such rows are excluded from every gate instead of being
    /// counted as "not recalled".
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

/// Score every task against the index behind `handle`.
///
/// Per task (plan Task 4): a shallow smart search with limit 50; a deep scan
/// (4 000 ms) only when the shallow search missed an existing target; and,
/// when `detect_time_phrase` finds a phrase, a second shallow search with
/// `time_scoped_query` grouped by `group_by_time`.
pub(super) fn run_e1(
    handle: &IndexHandle,
    vault_root: &Path,
    tasks: &[EvalTask],
    today: NaiveDate,
) -> Result<Vec<E1Row>, String> {
    let _ = (handle, vault_root, tasks, today);
    todo!("plan Task 4 Step 2")
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
            vault.path(),
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
        todo!("plan Task 4 Step 3")
    }
}
