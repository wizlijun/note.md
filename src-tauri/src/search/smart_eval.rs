//! Offline evaluation of the local lookup baseline (experiment E1).
//!
//! Compiled only for tests and never shipped. E1 costs nothing: it runs the
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
use super::time_group::{group_by_time, time_scoped_query};
use super::time_phrase::detect_time_phrase;
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
/// contains `..`. Accepted target paths are normalised to the index's
/// spelling: forward slashes only, no `.` or empty segments (`./a//b.md` →
/// `a/b.md`).
pub(super) fn load_tasks(json: &str) -> Result<Vec<EvalTask>, String> {
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
