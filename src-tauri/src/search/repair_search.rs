//! Zero-hit diagnosis and local re-search by alternative wordings (spec
//! Appendix F.5–F.7). Nothing here calls a model or reads a source file.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Instant;

use chrono::NaiveDate;
use serde::Serialize;

use super::smart::{self, SmartHitDto};
use super::time_group::{self, TimeMode};
use super::time_phrase::DetectedTime;
use super::{IndexHandle, TimeWindowDto};
use crate::lookup_params::{FusionParams, LookupParams};
use crate::smart_enhance::repair::{group_query, sanitize_groups};
use crate::smart_enhance::TermGroup;
use crate::smart_lookup::{LookupRun, RunTime};

/// Per-term hit counts stop here; `capped` says the real count may be higher.
pub(super) const TERM_COUNT_CAP: usize = 100;
/// Hits per wording, and in the merged answer, when the caller names none.
const DEFAULT_GROUP_LIMIT: usize = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermCount {
    pub term: String,
    pub hits: usize,
    pub capped: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub terms: Vec<TermCount>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupLookupResponse {
    pub search: smart::SmartSearchResponse,
    pub lookup_run_id: String,
    pub time: Option<TimeWindowDto>,
    /// Per wording, how many of the returned hits it found.
    pub group_counts: Vec<usize>,
    /// 与 search.hits 一一对应；每条命中来自哪些说法（从 1 开始）。
    pub hit_groups: Vec<Vec<u8>>,
}

type HitKey = (String, u32, u32);

fn hit_key(hit: &SmartHitDto) -> HitKey {
    (hit.hit.path.clone(), hit.hit.line, hit.hit.line_end)
}

/// One shallow smart search (deep off, no time budget).
fn shallow(
    handle: &IndexHandle,
    query: &str,
    limit: usize,
    fusion: &FusionParams,
    counter: &Arc<AtomicU64>,
    ticket: u64,
) -> Result<smart::SmartSearchResponse, String> {
    smart::smart_search_locked(handle, Instant::now(), query, Some(limit), Some(false), None, counter, ticket, fusion)
}

/// For each of the run's extracted terms (quoted when it has whitespace),
/// with the question's explicit filters, a shallow search capped at
/// [`TERM_COUNT_CAP`] hits. No model is involved.
pub(super) fn diagnose_locked(
    handle: &IndexHandle,
    run: &LookupRun,
    fusion: &FusionParams,
    counter: &Arc<AtomicU64>,
    ticket: u64,
) -> Result<Diagnosis, String> {
    let filters = super::explicit_filters(&run.question);
    let mut terms = Vec::with_capacity(run.facts.extracted_terms.len());
    for term in &run.facts.extracted_terms {
        let bare: String = term.chars().filter(|&c| c != '"').collect();
        let bare = bare.trim();
        let word = if bare.chars().any(char::is_whitespace) { format!("\"{bare}\"") } else { bare.to_string() };
        let query = std::iter::once(word).chain(filters.iter().cloned()).collect::<Vec<_>>().join(" ");
        let hits = shallow(handle, &query, TERM_COUNT_CAP, fusion, counter, ticket)?.hits.len();
        terms.push(TermCount { term: term.clone(), hits, capped: hits == TERM_COUNT_CAP });
    }
    Ok(Diagnosis { terms })
}

/// Reciprocal-rank fusion of one hit list per wording: each list adds
/// `1 / (rrf_k + rank)` (rank from 1; `local.rrfK`, the constant the arms
/// of one search fuse with) to every hit it holds, keyed by
/// `(path, line, line_end)`. Higher sums first; equal sums keep the order of
/// first appearance (wording, then rank). Returns at most `limit` hits, each
/// with its sum as `fused_score`, and per hit the wordings (from 1) that
/// found it.
pub(super) fn merge_groups(
    results: Vec<Vec<SmartHitDto>>,
    limit: usize,
    rrf_k: f64,
) -> (Vec<SmartHitDto>, Vec<Vec<u8>>) {
    struct Merged {
        hit: SmartHitDto,
        score: f64,
        first: (usize, usize),
        groups: Vec<u8>,
    }
    let mut merged: Vec<Merged> = Vec::new();
    let mut at: HashMap<HitKey, usize> = HashMap::new();
    for (group, hits) in results.into_iter().enumerate() {
        let label = u8::try_from(group + 1).unwrap_or(u8::MAX);
        for (offset, hit) in hits.into_iter().enumerate() {
            let rank = offset + 1;
            let contribution = 1.0 / (rrf_k + rank as f64);
            match at.get(&hit_key(&hit)) {
                Some(&i) => {
                    let entry = &mut merged[i];
                    if !entry.groups.contains(&label) {
                        entry.score += contribution;
                        entry.groups.push(label);
                    }
                }
                None => {
                    at.insert(hit_key(&hit), merged.len());
                    merged.push(Merged { hit, score: contribution, first: (group, rank), groups: vec![label] });
                }
            }
        }
    }
    merged.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.first.cmp(&b.first)));
    merged.truncate(limit);
    merged
        .into_iter()
        .map(|m| {
            let mut hit = m.hit;
            hit.fused_score = m.score;
            (hit, m.groups)
        })
        .unzip()
}

/// Prefix wording `n`'s arm ids (and the hits' references to them) with
/// `g{n}:`, so arms of different wordings stay distinct in one response.
fn label_wording(mut search: smart::SmartSearchResponse, n: usize) -> smart::SmartSearchResponse {
    for arm in &mut search.subqueries {
        arm.id = format!("g{n}:{}", arm.id);
    }
    for hit in &mut search.hits {
        for id in &mut hit.matched_queries {
            *id = format!("g{n}:{id}");
        }
    }
    search
}

/// One response from the wordings' own responses (their hits already taken)
/// and the merged hits.
fn combine(parts: Vec<smart::SmartSearchResponse>, hits: Vec<SmartHitDto>, started: Instant) -> smart::SmartSearchResponse {
    let route = if parts.iter().any(|p| p.route == "smart-scan") { "smart-scan" } else { "smart-fts" };
    let mut extracted_terms: Vec<String> = Vec::new();
    for term in parts.iter().flat_map(|p| p.extracted_terms.iter()) {
        if !extracted_terms.contains(term) {
            extracted_terms.push(term.clone());
        }
    }
    smart::SmartSearchResponse {
        route: route.to_string(),
        took_ms: started.elapsed().as_millis() as u64,
        total: parts.iter().map(|p| p.total).max().unwrap_or(0).max(hits.len()),
        truncated: parts.iter().any(|p| p.truncated),
        deep_available: parts.iter().any(|p| p.deep_available),
        extracted_terms,
        subqueries: parts.into_iter().flat_map(|p| p.subqueries).collect(),
        hits,
    }
}

/// Search each wording locally and merge, with `repair.*` limits and
/// `local.*` fusion from `params`. Every wording is
/// `sanitize_groups`-ed and searched as `group_query(group, explicit filters
/// of the question)` (shallow). Time follows the base run's `run.time`:
/// `Group` searches each wording with and without the range, merges each
/// side, then `group_by_time`; `Window` only with the range; `Ignore` or no
/// time only without. `today` is not needed: the run's time is resolved.
///
/// Returns the response, per wording how many returned hits it found, per
/// hit its wordings, and — when the run has a time — that time with the
/// number of leading hits inside the window.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn search_groups_locked(
    handle: &IndexHandle,
    run: &LookupRun,
    groups: &[TermGroup],
    limit: usize,
    _today: NaiveDate,
    counter: &Arc<AtomicU64>,
    ticket: u64,
    params: &LookupParams,
) -> Result<(smart::SmartSearchResponse, Vec<usize>, Vec<Vec<u8>>, Option<(DetectedTime, usize)>), String> {
    let started = Instant::now();
    let groups = sanitize_groups(groups.to_vec(), &params.repair)?;
    let fusion = params.local.fusion();
    let filters = super::explicit_filters(&run.question);
    let queries: Vec<String> = groups.iter().map(|g| group_query(g, &filters)).collect();
    let detected = run
        .time
        .as_ref()
        .map(|t| DetectedTime { source_text: t.source_text.clone(), after: t.after, before: t.before });
    let mode = run.time.as_ref().map(|t| t.mode);

    // One response per wording; `scoped` appends the run's range.
    let search_all = |scoped: bool| -> Result<(Vec<smart::SmartSearchResponse>, Vec<Vec<SmartHitDto>>), String> {
        let mut parts = Vec::with_capacity(queries.len());
        for (i, query) in queries.iter().enumerate() {
            let query = match (&detected, scoped) {
                (Some(t), true) => format!("{query} after:{} before:{}", t.after, t.before),
                _ => query.clone(),
            };
            parts.push(label_wording(shallow(handle, &query, limit, &fusion, counter, ticket)?, i + 1));
        }
        let hits = parts.iter_mut().map(|p| std::mem::take(&mut p.hits)).collect();
        Ok((parts, hits))
    };

    let (parts, hits, labels, in_window) = match mode {
        Some(TimeMode::Group) => {
            let (_, scoped_hits) = search_all(true)?;
            let (parts, unscoped_hits) = search_all(false)?;
            let (scoped, scoped_labels) = merge_groups(scoped_hits, limit, fusion.rrf_k);
            let (unscoped, unscoped_labels) = merge_groups(unscoped_hits, limit, fusion.rrf_k);
            let mut found_by: HashMap<HitKey, Vec<u8>> = HashMap::new();
            for (hit, labels) in scoped.iter().zip(&scoped_labels).chain(unscoped.iter().zip(&unscoped_labels)) {
                let entry = found_by.entry(hit_key(hit)).or_default();
                entry.extend(labels);
                entry.sort_unstable();
                entry.dedup();
            }
            let grouped = time_group::group_by_time(scoped, unscoped, limit);
            let labels = grouped.hits.iter().map(|h| found_by.get(&hit_key(h)).cloned().unwrap_or_default()).collect();
            (parts, grouped.hits, labels, grouped.in_window)
        }
        Some(TimeMode::Window) => {
            let (parts, scoped_hits) = search_all(true)?;
            let (hits, labels) = merge_groups(scoped_hits, limit, fusion.rrf_k);
            let in_window = hits.len();
            (parts, hits, labels, in_window)
        }
        Some(TimeMode::Ignore) | None => {
            let (parts, unscoped_hits) = search_all(false)?;
            let (hits, labels) = merge_groups(unscoped_hits, limit, fusion.rrf_k);
            (parts, hits, labels, 0)
        }
    };
    let group_counts = (1..=groups.len())
        .map(|n| labels.iter().filter(|l: &&Vec<u8>| l.contains(&(n as u8))).count())
        .collect();
    let search = combine(parts, hits, started);
    Ok((search, group_counts, labels, detected.map(|t| (t, in_window))))
}

/// The command's body, shared with its test: searches the wordings for the
/// base `run` and registers the answer as a new, repaired lookup run (no
/// judging, no automatic request) that keeps the base run's question and
/// time mode. `limit` is 1..=100 (default 100).
#[allow(clippy::too_many_arguments)]
pub(super) fn search_groups_in(
    window_label: &str,
    root: &Path,
    handle: &IndexHandle,
    run: &LookupRun,
    groups: &[TermGroup],
    limit: Option<usize>,
    today: NaiveDate,
    counter: &Arc<AtomicU64>,
    ticket: u64,
    params: &LookupParams,
) -> Result<GroupLookupResponse, String> {
    let canonical = std::fs::canonicalize(root).map_err(|error| format!("resolve vault: {error}"))?;
    if canonical != run.root {
        return Err("lookup run belongs to another vault; run Smart Lookup again".to_string());
    }
    let limit = limit.filter(|n| (1..=DEFAULT_GROUP_LIMIT).contains(n)).unwrap_or(DEFAULT_GROUP_LIMIT);
    let (mut search, group_counts, hit_groups, detected) =
        search_groups_locked(handle, run, groups, limit, today, counter, ticket, params)?;
    let run_time = run.time.as_ref().zip(detected).map(|(base, (time, in_window))| RunTime {
        source_text: time.source_text,
        after: time.after,
        before: time.before,
        mode: base.mode,
        in_window,
    });
    let time = run_time.as_ref().map(super::time_window_dto);
    let lookup_run_id =
        crate::smart_lookup::retain_search_in(window_label, root, &run.question, &mut search, run_time, true)?;
    Ok(GroupLookupResponse { search, lookup_run_id, time, group_counts, hit_groups })
}

#[cfg(test)]
mod tests {
    use super::*;
    use searchidx::{Hit, SearchIndex};
    use std::path::Path;
    use std::sync::Mutex;

    fn fixture(files: &[(&str, &str)]) -> (tempfile::TempDir, IndexHandle) {
        let vault = tempfile::tempdir().unwrap();
        for (name, body) in files {
            std::fs::write(vault.path().join(name), body).unwrap();
        }
        let data = tempfile::tempdir().unwrap();
        let mut idx = SearchIndex::open_at(vault.path(), &data.path().join("i.db"), "sync").unwrap();
        idx.rebuild(&searchidx::ScanOptions::default()).unwrap();
        std::mem::forget(data);
        (vault, Arc::new(Mutex::new(Some(idx))))
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, 10).unwrap()
    }

    /// Runs the real lookup and registers it, as `smart_lookup_local` does.
    fn base_run(vault: &Path, handle: &IndexHandle, question: &str, window: &str) -> LookupRun {
        let counter = Arc::new(AtomicU64::new(1));
        let (mut search, detected) = super::super::local_lookup_locked(
            handle,
            question,
            20,
            false,
            None,
            TimeMode::Group,
            today(),
            &counter,
            1,
            &FusionParams::default(),
        )
        .unwrap();
        let time = detected.map(|(t, n)| RunTime {
            source_text: t.source_text,
            after: t.after,
            before: t.before,
            mode: TimeMode::Group,
            in_window: n,
        });
        let id = crate::smart_lookup::retain_search_in(window, vault, question, &mut search, time, false).unwrap();
        crate::smart_lookup::run_for_window(&id, window).unwrap()
    }

    fn counts(d: &Diagnosis) -> Vec<(&str, usize, bool)> {
        d.terms.iter().map(|t| (t.term.as_str(), t.hits, t.capped)).collect()
    }

    #[test]
    fn diagnosis_counts_each_extracted_term_and_marks_misses() {
        let (vault, handle) = fixture(&[("a.md", "# A\n预算 记录\n")]);
        let run = base_run(vault.path(), &handle, "预算 火星", "test-diagnose");
        let d = diagnose_locked(&handle, &run, &FusionParams::default(), &Arc::new(AtomicU64::new(1)), 1).unwrap();
        assert_eq!(counts(&d), [("预算", 1, false), ("火星", 0, false)]);
    }

    #[test]
    fn diagnosis_keeps_the_explicit_filters_and_caps_counts() {
        let mut files: Vec<(String, String)> =
            (0..TERM_COUNT_CAP + 5).map(|i| (format!("n{i}.md"), "# N\n预算 记录\n".to_string())).collect();
        files.push(("t.md".into(), "---\ntags: [work]\n---\n# T\n火星 记录\n".into()));
        let refs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (vault, handle) = fixture(&refs);
        let run = base_run(vault.path(), &handle, "预算 火星", "test-diagnose-cap");
        let d = diagnose_locked(&handle, &run, &FusionParams::default(), &Arc::new(AtomicU64::new(1)), 1).unwrap();
        assert_eq!(counts(&d), [("预算", TERM_COUNT_CAP, true), ("火星", 1, false)]);
        let tagged = base_run(vault.path(), &handle, "预算 火星 tag:work", "test-diagnose-cap");
        let d = diagnose_locked(&handle, &tagged, &FusionParams::default(), &Arc::new(AtomicU64::new(1)), 1).unwrap();
        assert_eq!(counts(&d), [("预算", 0, false), ("火星", 1, false)]);
    }

    fn dto(path: &str) -> SmartHitDto {
        let hit = Hit {
            path: path.to_string(),
            line: 2,
            line_end: 2,
            text: "text".to_string(),
            breadcrumb: path.to_string(),
            level: "line".to_string(),
            score: 1.0,
            doc_date: None,
            agent_by: None,
            human_verified: false,
            origin: searchidx::Origin::Unlabeled,
            concept_type: None,
            pinned: false,
            attention_minutes: 0.0,
        };
        SmartHitDto {
            hit: super::super::hit_to_dto(hit, Path::new("/vault")),
            fused_score: 1.0,
            relevance_reasons: Vec::new(),
            matched_queries: Vec::new(),
            result_id: None,
        }
    }

    /// The default `local.rrfK`.
    const K: f64 = 60.0;

    fn a() -> SmartHitDto {
        dto("a.md")
    }
    fn b() -> SmartHitDto {
        dto("b.md")
    }
    fn c() -> SmartHitDto {
        dto("c.md")
    }

    fn paths(hits: &[SmartHitDto]) -> Vec<&str> {
        hits.iter().map(|h| h.hit.path.as_str()).collect()
    }

    #[test]
    fn merge_groups_fuses_by_rrf_and_labels_groups() {
        let (hits, groups) = merge_groups(vec![vec![a(), b()], vec![b(), c()]], 10, K);
        assert_eq!(paths(&hits), ["b.md", "a.md", "c.md"]);
        assert_eq!(groups, [vec![1, 2], vec![1], vec![2]]);
        assert!((hits[0].fused_score - (1.0 / 62.0 + 1.0 / 61.0)).abs() < 1e-12);
        assert_eq!(K, LookupParams::default().local.rrf_k);
    }

    #[test]
    fn merge_groups_uses_the_rrf_k_it_is_given() {
        let (hits, _) = merge_groups(vec![vec![a(), b()], vec![b(), c()]], 10, 1.0);
        assert!((hits[0].fused_score - (1.0 / 3.0 + 1.0 / 2.0)).abs() < 1e-12);
    }

    #[test]
    fn group_search_follows_the_repair_params() {
        let (vault, handle) = fixture(&[("a.md", "# A\n预算 记录\n")]);
        let base = base_run(vault.path(), &handle, "火星", "test-groups-params");
        let counter = Arc::new(AtomicU64::new(1));
        let repair = crate::lookup_params::RepairParams { max_groups: 1, ..Default::default() };
        let one = LookupParams { repair, ..Default::default() };
        let two = groups(&[&["预算"], &["记录"]]);
        let err = search_groups_locked(&handle, &base, &two, 20, today(), &counter, 1, &one).err().unwrap();
        assert_eq!(err, "invalid term groups");
        assert!(search_groups_locked(&handle, &base, &two, 20, today(), &counter, 1, &LookupParams::default()).is_ok());
    }

    #[test]
    fn merge_groups_breaks_ties_by_first_appearance_and_respects_the_limit() {
        // a and c both rank 1 in their group: a (group 1) comes first.
        let (hits, groups) = merge_groups(vec![vec![a()], vec![c()]], 10, K);
        assert_eq!(paths(&hits), ["a.md", "c.md"]);
        assert_eq!(groups, [vec![1], vec![2]]);
        let (hits, groups) = merge_groups(vec![vec![a(), b()], vec![b(), c()]], 2, K);
        assert_eq!(paths(&hits), ["b.md", "a.md"]);
        assert_eq!(groups.len(), 2);
        // A different line of the same file is a different hit.
        let mut other_line = a();
        other_line.hit.line = 5;
        other_line.hit.line_end = 5;
        let (hits, _) = merge_groups(vec![vec![a(), other_line]], 10, K);
        assert_eq!(hits.len(), 2);
    }

    fn groups(words: &[&[&str]]) -> Vec<TermGroup> {
        words
            .iter()
            .map(|terms| TermGroup { terms: terms.iter().map(|s| s.to_string()).collect(), phrases: vec![] })
            .collect()
    }

    #[test]
    fn group_search_registers_a_repaired_run() {
        let (vault, handle) = fixture(&[("a.md", "# A\n预算 记录\n"), ("b.md", "# B\n别的 内容\n")]);
        let base = base_run(vault.path(), &handle, "火星 计划", "smart-search");
        let response = search_groups_in(
            "smart-search",
            vault.path(),
            &handle,
            &base,
            &groups(&[&["预算"], &["记录"]]),
            None,
            today(),
            &Arc::new(AtomicU64::new(1)),
            1,
            &LookupParams::default(),
        )
        .unwrap();
        let run_id = response.lookup_run_id.clone();
        let run = crate::smart_lookup::run_for_window(&run_id, "smart-search").unwrap();
        assert!(run.repaired && run.auto_request_used);
        assert_eq!(run.question, "火星 计划");
        assert_eq!(response.group_counts, [1, 1]);
        assert_eq!(paths(&response.search.hits), ["a.md"]);
        assert_eq!(response.hit_groups, [vec![1, 2]]);
        assert_eq!(run.hits.len(), 1);
        assert_eq!(response.search.hits[0].result_id.as_deref(), Some(run.hits[0].result_id.as_str()));
        assert!(response.time.is_none());
    }

    #[test]
    fn group_search_drops_dsl_and_refuses_empty_groups() {
        let (vault, handle) = fixture(&[("a.md", "# A\n预算 记录\n")]);
        let base = base_run(vault.path(), &handle, "火星", "test-groups-dsl");
        let counter = Arc::new(AtomicU64::new(1));
        let err = search_groups_locked(&handle, &base, &groups(&[&["AND", "tag:x"]]), 20, today(), &counter, 1, &LookupParams::default())
            .err()
            .unwrap();
        assert_eq!(err, "invalid term groups");
        let (search, counts, labels, time) =
            search_groups_locked(&handle, &base, &groups(&[&["-预算", "OR"]]), 20, today(), &counter, 1, &LookupParams::default()).unwrap();
        assert_eq!((paths(&search.hits), counts, labels), (vec!["a.md"], vec![1], vec![vec![1]]));
        assert!(time.is_none());
        assert!(search.subqueries.iter().all(|q| q.id.starts_with("g1:")), "arm ids carry their wording");
    }

    #[test]
    fn group_search_applies_the_base_runs_time_mode() {
        let (vault, handle) = fixture(&[
            ("2026-11-03-a.md", "# A\n预算 记录\n"),
            ("2026-10-01-b.md", "# B\n预算 旧\n"),
        ]);
        let counter = Arc::new(AtomicU64::new(1));
        let mut base = base_run(vault.path(), &handle, "上周 火星", "test-groups-time");
        let time = base.time.clone().expect("上周 is detected");
        assert_eq!(time.mode, TimeMode::Group);

        let (search, _, _, detected) =
            search_groups_locked(&handle, &base, &groups(&[&["预算"]]), 20, today(), &counter, 1, &LookupParams::default()).unwrap();
        assert_eq!(paths(&search.hits), ["2026-11-03-a.md", "2026-10-01-b.md"]);
        assert_eq!(detected.map(|(t, n)| (t.source_text, n)), Some(("上周".to_string(), 1)));

        base.time = Some(RunTime { mode: TimeMode::Window, ..time.clone() });
        let (search, counts, _, detected) =
            search_groups_locked(&handle, &base, &groups(&[&["预算"]]), 20, today(), &counter, 1, &LookupParams::default()).unwrap();
        assert_eq!((paths(&search.hits), counts), (vec!["2026-11-03-a.md"], vec![1]));
        assert_eq!(detected.map(|(_, n)| n), Some(1));

        base.time = Some(RunTime { mode: TimeMode::Ignore, ..time });
        let (search, _, _, detected) =
            search_groups_locked(&handle, &base, &groups(&[&["预算"]]), 20, today(), &counter, 1, &LookupParams::default()).unwrap();
        assert_eq!(search.hits.len(), 2);
        assert_eq!(detected.map(|(_, n)| n), Some(0));

        // The repaired run keeps the base run's time and mode.
        base.time = Some(RunTime { mode: TimeMode::Window, ..base.time.clone().unwrap() });
        let response = search_groups_in(
            "test-groups-time",
            vault.path(),
            &handle,
            &base,
            &groups(&[&["预算"]]),
            Some(20),
            today(),
            &counter,
            1,
            &LookupParams::default(),
        )
        .unwrap();
        let dto = response.time.expect("time dto");
        assert_eq!((dto.source_text.as_str(), dto.mode, dto.in_window), ("上周", TimeMode::Window, 1));
        let run = crate::smart_lookup::run_for_window(&response.lookup_run_id, "test-groups-time").unwrap();
        assert_eq!(run.time.map(|t| t.mode), Some(TimeMode::Window));
    }
}
