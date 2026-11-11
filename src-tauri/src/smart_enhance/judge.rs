//! Candidate judging: at most one Jev Noul request per lookup run, cached,
//! applied as an in-place rerank (spec §5.4, §5.6, Appendix F.3).
//!
//! What is sent: the question, the parsed time range and explicit filters as
//! text, and each candidate's title, breadcrumb and re-read passage. Never a
//! Vault path, and never a block from a confidential, stale or roll-up hit.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::candidates::{rerank, route, select_candidates, tier, top_ten_unfit, Candidate, Route};
use super::keys::{read_key, KeyKind};
use super::{
    cancel_flag_for, claim_auto_request, enhance_client, gate_jev, release_auto_request, status_for, CancelFlag,
    EnhanceStatus, Gate, JevRequestConfig, Missing, SkipReason, Tier, Trigger, UsageDto,
};
use crate::lookup_params::{self, LookupParams};
use crate::search::time_group::TimeMode;
use crate::search::IndexHandle;
use crate::smart_lookup::{
    active_root, read_source, run_for_window, update_run, CanonicalHit, JudgeRecord, LookupRun,
};
use crate::smart_model::{endpoint_host, jev_endpoint, score_noul, AuthMode, NoulQuestion};

/// Also the `directMatch` preset's true/false criteria for SAG2 rounds (spec H.3.7).
pub(crate) const CRITERIA_TRUE: &str = "候选直接符合用户这次要找的对象或内容。";
pub(crate) const CRITERIA_FALSE: &str = "候选不符合用户这次要找的对象或内容，或只是主题相近。";

const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const CACHE_CAPACITY: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictDto {
    pub result_id: String,
    pub tier: Tier,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JudgeResult {
    pub status: EnhanceStatus,
    pub skip_reason: Option<SkipReason>,
    pub missing: Option<Missing>,
    pub endpoint_host: Option<String>,
    pub status_class: Option<String>,
    pub verdicts: Vec<VerdictDto>,
    /// 重排后的完整展示顺序（result_id）；只有 status == ok 时非空。
    pub order: Vec<String>,
    pub judged_count: usize,
    pub reranked_count: usize,
    pub top_ten_unfit: bool,
    pub request_count: u32,
    pub reused: bool,
    pub elapsed_ms: u64,
    pub pool_size: usize,
    pub sent_blocks: usize,
    pub estimated_tokens: u64,
    pub skipped_rollups: usize,
    pub skipped_confidential: usize,
    pub skipped_stale: usize,
    pub skipped_long: usize,
    pub usage: Option<UsageDto>,
    /// The result ids of the blocks that were picked to send (or that a
    /// reused verdict covered), in send order. Host-side only (the eval's
    /// window coverage); never serialized.
    #[serde(skip)]
    pub sent_result_ids: Vec<String>,
}

pub(crate) struct JudgeInput<'a> {
    pub run: &'a LookupRun,
    pub display_order: &'a [String],
    pub section_breaks: &'a [usize],
    pub config: &'a JevRequestConfig,
    pub key: Option<&'a str>,
    pub trigger: Trigger,
    /// `files.confidentiality` keyed exactly like `CanonicalHit.path`.
    pub confidentiality: &'a HashMap<String, String>,
    /// Routing, candidate limits, tiers and the criterion. The wait is
    /// `timeout`, not `params.enhance` (tests pass a short one).
    pub params: &'a LookupParams,
    pub timeout: Duration,
}

/// The shared Noul `state`: question, time range and filters when present,
/// then the criterion (`judge.criterion`, spec §5.4 by default), verbatim.
/// The 时间范围 line goes out when the run has a time in Group or Window mode
/// (ledger ruling: §5.4 sends the parsed time, and Window mode is a filter on
/// it), not in Ignore mode: the user chose to ignore time, as repair's
/// 「时间：无」.
fn build_state(run: &LookupRun, criterion: &str) -> String {
    let mut lines = vec![format!("用户要找的内容：{}", run.question)];
    if let Some(time) = run.time.as_ref().filter(|t| t.mode != TimeMode::Ignore) {
        lines.push(format!(
            "时间范围：{} 至 {}（来自「{}」）",
            time.after.format("%Y-%m-%d"),
            time.before.format("%Y-%m-%d"),
            time.source_text
        ));
    }
    let filters = crate::search::explicit_filters(&run.question);
    if !filters.is_empty() {
        lines.push(format!("过滤条件：{}", filters.join(" ")));
    }
    lines.push(format!("判断准则：{criterion}"));
    lines.join("\n")
}

fn question_for(id: String, candidate: &Candidate) -> NoulQuestion {
    NoulQuestion {
        id,
        instructions: serde_json::json!({
            "title": candidate.title,
            "breadcrumb": candidate.breadcrumb,
            "passage": candidate.passage,
        }),
        criteria_true: CRITERIA_TRUE.to_string(),
        criteria_false: CRITERIA_FALSE.to_string(),
    }
}

/// The run's hits in display order. `display_order` must be a permutation of
/// the run's result ids; `section_breaks` strictly increasing inside `1..len`.
fn ordered_hits<'a>(
    run: &'a LookupRun,
    display_order: &[String],
    section_breaks: &[usize],
) -> Result<Vec<&'a CanonicalHit>, String> {
    let invalid = || "invalid display order".to_string();
    if display_order.len() != run.hits.len() {
        return Err(invalid());
    }
    let by_id: HashMap<&str, &CanonicalHit> = run.hits.iter().map(|h| (h.result_id.as_str(), h)).collect();
    let mut seen = HashSet::new();
    let mut ordered = Vec::with_capacity(display_order.len());
    for id in display_order {
        let hit = by_id.get(id.as_str()).ok_or_else(invalid)?;
        if !seen.insert(id.as_str()) {
            return Err(invalid());
        }
        ordered.push(*hit);
    }
    let len = ordered.len();
    if !section_breaks.iter().all(|&b| (1..len).contains(&b)) || !section_breaks.windows(2).all(|w| w[0] < w[1]) {
        return Err(invalid());
    }
    Ok(ordered)
}

// ---- judgement cache -------------------------------------------------------

struct CachedVerdicts {
    key: [u8; 32],
    stored_at: Instant,
    /// The service's score per question, in question order.
    scores: Vec<f64>,
}

static JUDGE_CACHE: OnceLock<Mutex<VecDeque<CachedVerdicts>>> = OnceLock::new();

/// SHA-256 over exactly what the request carries: the resolved endpoint URL,
/// the model, the auth mode, the `state`, and every question's id,
/// instructions and criteria, each field length-prefixed. Another route on
/// the same host, a changed time-range or filter line, another criterion, or
/// another candidate set (K, budget, block or per-file limits) is a different
/// key. Parameters that do not change the request (tiers) do not change it:
/// the cache keeps the service's scores and they are tiered on every use.
fn cache_key(endpoint: &str, model: &str, auth_mode: AuthMode, state: &str, questions: &[NoulQuestion]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    let mut field = |bytes: &[u8]| {
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    };
    field(endpoint.as_bytes());
    field(model.as_bytes());
    field(match auth_mode {
        AuthMode::Bearer => b"bearer".as_slice(),
        AuthMode::None => b"none".as_slice(),
    });
    field(state.as_bytes());
    for q in questions {
        field(q.id.as_bytes());
        field(q.instructions.to_string().as_bytes());
        field(q.criteria_true.as_bytes());
        field(q.criteria_false.as_bytes());
    }
    hasher.finalize().into()
}

fn judge_cache() -> MutexGuard<'static, VecDeque<CachedVerdicts>> {
    JUDGE_CACHE
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn cache_lookup(cache: &mut VecDeque<CachedVerdicts>, key: &[u8; 32], count: usize, now: Instant) -> Option<Vec<f64>> {
    cache.retain(|e| now.duration_since(e.stored_at) <= CACHE_TTL);
    cache.iter().find(|e| e.key == *key && e.scores.len() == count).map(|e| e.scores.clone())
}

/// Insert-only capacity bound: the oldest entries go first.
fn cache_store(cache: &mut VecDeque<CachedVerdicts>, key: [u8; 32], scores: Vec<f64>, now: Instant) {
    cache.retain(|e| e.key != key && now.duration_since(e.stored_at) <= CACHE_TTL);
    while cache.len() >= CACHE_CAPACITY {
        cache.pop_front();
    }
    cache.push_back(CachedVerdicts { key, stored_at: now, scores });
}

// ---- core ------------------------------------------------------------------

/// Fill the ok-result fields from one tier per selected candidate; returns
/// the record to keep on the run.
fn apply_tiers(
    result: &mut JudgeResult,
    picked: &[Candidate],
    tiers: &[Tier],
    display_order: &[String],
    section_breaks: &[usize],
    host: &str,
    model: &str,
) -> JudgeRecord {
    let judged: Vec<(usize, Tier)> = picked.iter().zip(tiers).map(|(c, &t)| (c.position, t)).collect();
    let len = display_order.len();
    // permutation[new position] = old position
    let permutation = rerank(len, &judged, section_breaks);
    result.status = EnhanceStatus::Ok;
    result.order = permutation.iter().map(|&i| display_order[i].clone()).collect();
    result.verdicts = picked
        .iter()
        .zip(tiers)
        .map(|(c, &tier)| VerdictDto { result_id: c.result_id.clone(), tier })
        .collect();
    result.judged_count = judged.len();
    result.reranked_count = judged.iter().filter(|&&(p, _)| permutation[p] != p).count();
    result.top_ten_unfit = top_ten_unfit(len, &judged);
    JudgeRecord {
        endpoint_host: host.to_string(),
        model: model.to_string(),
        tiers: result.verdicts.iter().map(|v| (v.result_id.clone(), v.tier)).collect(),
    }
}

/// 可测的核心；返回结果，以及要写回运行的 (JudgeRecord, 是否发出了请求)。
///
/// Each step that does not hold returns its status without sending anything.
///
/// Cancellation (ledger ruling, overriding brief step 8): a cancel noticed
/// before the request starts — checked before the cache lookup too, so it
/// also wins over a reused verdict — returns `Cancelled` with
/// `request_count` 0 and sends nothing. A cancel during the request stops
/// the wait and reports `request_count` 1 (the service may still bill it).
pub(crate) async fn judge_core(
    input: JudgeInput<'_>,
    client: &reqwest::Client,
    cancel: &CancelFlag,
) -> Result<(JudgeResult, Option<JudgeRecord>, bool), String> {
    let started = Instant::now();
    let mut outcome = judge_steps(input, client, cancel).await?;
    outcome.0.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(outcome)
}

async fn judge_steps(
    input: JudgeInput<'_>,
    client: &reqwest::Client,
    cancel: &CancelFlag,
) -> Result<(JudgeResult, Option<JudgeRecord>, bool), String> {
    let run = input.run;
    let params = input.params;
    let ordered = ordered_hits(run, input.display_order, input.section_breaks)?;
    let skipped = |reason| JudgeResult { skip_reason: Some(reason), ..JudgeResult::default() };
    if run.repaired {
        return Ok((skipped(SkipReason::Repaired), None, false));
    }
    match route(&run.facts, params.routing.few_terms_max) {
        Route::Repair => return Ok((skipped(SkipReason::ZeroHits), None, false)),
        Route::Skip(reason) => return Ok((skipped(reason), None, false)),
        Route::Judge => {}
    }
    let jev = match gate_jev(input.config, input.key) {
        Ok(jev) => jev,
        Err(Gate::NotConfigured(missing)) => {
            let result = JudgeResult { status: EnhanceStatus::NotConfigured, missing: Some(missing), ..JudgeResult::default() };
            return Ok((result, None, false));
        }
        Err(Gate::NoConsent { endpoint_host }) => {
            let result =
                JudgeResult { status: EnhanceStatus::NoConsent, endpoint_host: Some(endpoint_host), ..JudgeResult::default() };
            return Ok((result, None, false));
        }
    };
    // The gate accepted the URL, so it resolves to an endpoint and a host.
    let endpoint = jev_endpoint(&jev.url).unwrap_or_default();
    let host = endpoint_host(&endpoint).unwrap_or_default();
    let mut result = JudgeResult { endpoint_host: Some(host.clone()), ..JudgeResult::default() };
    if input.trigger == Trigger::Auto && run.auto_request_used {
        result.skip_reason = Some(SkipReason::AutoBudgetUsed);
        return Ok((result, None, false));
    }

    let limits = params.candidates.limits();
    let selection = select_candidates(&ordered, input.confidentiality, |hit| read_source(&run.root, hit), &limits);
    result.pool_size = selection.pool_size;
    result.sent_blocks = selection.picked.len();
    result.estimated_tokens = selection.estimated_tokens;
    result.skipped_rollups = selection.skipped_rollups;
    result.skipped_confidential = selection.skipped_confidential;
    result.skipped_stale = selection.skipped_stale;
    result.skipped_long = selection.skipped_long;
    let picked = selection.picked;
    result.sent_result_ids = picked.iter().map(|c| c.result_id.clone()).collect();
    if picked.is_empty() {
        result.skip_reason = Some(SkipReason::NoCandidates);
        return Ok((result, None, false));
    }
    if cancel.is_cancelled() {
        result.status = EnhanceStatus::Cancelled;
        return Ok((result, None, false));
    }

    let questions: Vec<NoulQuestion> =
        picked.iter().enumerate().map(|(i, c)| question_for(format!("c{}", i + 1), c)).collect();
    let state = build_state(run, &params.judge.criterion);
    let key = cache_key(&endpoint, &jev.model, jev.auth_mode, &state, &questions);
    let to_tiers = |scores: &[f64]| -> Vec<Tier> { scores.iter().map(|&noul| tier(noul, &params.tiers)).collect() };
    let cached = cache_lookup(&mut judge_cache(), &key, questions.len(), Instant::now());
    if let Some(scores) = cached {
        result.reused = true;
        let tiers = to_tiers(&scores);
        let record =
            apply_tiers(&mut result, &picked, &tiers, input.display_order, input.section_breaks, &host, &jev.model);
        return Ok((result, Some(record), false));
    }

    result.request_count = 1;
    let answer = tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        answer = score_noul(client, &jev, input.key, &state, &questions, input.timeout) => Some(answer),
    };
    let outcome = match answer {
        None => {
            result.status = EnhanceStatus::Cancelled;
            return Ok((result, None, true));
        }
        Some(Err(error)) => {
            let (status, class) = status_for(&error);
            result.status = status;
            result.status_class = class;
            return Ok((result, None, true));
        }
        Some(Ok(outcome)) => outcome,
    };
    // `score_noul` returns one score per question, in question order.
    let scores: Vec<f64> = outcome.scores.iter().map(|&(_, noul)| noul).collect();
    let tiers = to_tiers(&scores);
    result.usage = outcome.usage.map(|u| UsageDto { input_tokens: u.input_tokens, output_tokens: u.output_tokens });
    cache_store(&mut judge_cache(), key, scores, Instant::now());
    let record = apply_tiers(&mut result, &picked, &tiers, input.display_order, input.section_breaks, &host, &jev.model);
    Ok((result, Some(record), true))
}

// ---- the retained run ------------------------------------------------------

/// What the index said about the pool: its vault root and the map it
/// returned. `None` when there is no index or it is busy.
type IndexAnswer = Option<(PathBuf, HashMap<String, String>)>;

/// The map to judge with: the index's answer only when that index belongs to
/// the run's vault. `None` — no index, a busy one, another vault's — means
/// confidentiality is unknown and nothing may be judged.
fn scoped_confidentiality(answer: IndexAnswer, run_root: &Path) -> Option<HashMap<String, String>> {
    match answer {
        Some((index_root, found)) if std::fs::canonicalize(&index_root).is_ok_and(|root| root == run_root) => Some(found),
        _ => None,
    }
}

/// The index's answer for one query.
/// A failed query is unavailable like a busy index: an empty map would count
/// every candidate as confidential and over-report 保密笔记.
fn index_answer(root: PathBuf, found: Result<HashMap<String, String>, String>) -> IndexAnswer {
    Some((root, found.ok()?))
}

/// `files.confidentiality` for the pool's paths, keyed exactly like
/// `CanonicalHit.path`, for the first `pool` hits in display order. One query
/// on a blocking thread under a `try_lock` of the index: a busy index (a
/// rebuild holds it for minutes) is not waited for. `None` when the map is
/// unavailable (see [`scoped_confidentiality`]).
async fn pool_confidentiality(
    index: &IndexHandle,
    run: &LookupRun,
    display_order: &[String],
    pool: usize,
) -> Result<Option<HashMap<String, String>>, String> {
    let by_id: HashMap<&str, &str> = run.hits.iter().map(|h| (h.result_id.as_str(), h.path.as_str())).collect();
    let mut paths: Vec<String> = Vec::new();
    for id in display_order.iter().take(pool) {
        if let Some(path) = by_id.get(id.as_str()) {
            if !paths.iter().any(|p| p == path) {
                paths.push(path.to_string());
            }
        }
    }
    let handle = index.clone();
    let answer: IndexAnswer = tokio::task::spawn_blocking(move || {
        let guard = match handle.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return None,
        };
        let index = guard.as_ref()?;
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        index_answer(index.vault_root().to_path_buf(), index.confidentiality_for_paths(&refs))
    })
    .await
    .map_err(|_| "confidentiality lookup failed".to_string())?;
    Ok(scoped_confidentiality(answer, &run.root))
}

/// Everything `smart_lookup_judge` needs once the app-bound values are read.
pub(crate) struct JudgeRequest<'a> {
    pub run_id: &'a str,
    pub window_label: &'a str,
    /// The active vault, canonical.
    pub vault_root: &'a Path,
    pub display_order: &'a [String],
    pub section_breaks: &'a [usize],
    pub config: &'a JevRequestConfig,
    pub key: Option<&'a str>,
    pub trigger: Trigger,
    pub params: &'a LookupParams,
    pub timeout: Duration,
}

/// Judge a retained run: check it belongs to the active vault and the order
/// is valid (before touching the index), read confidentiality, claim the
/// run's automatic request when `trigger` is `Auto`, judge, give the claim
/// back when nothing was sent, and keep the judgement on the run.
///
/// When confidentiality cannot be read (busy, missing or other-vault index)
/// it returns `Skipped` / `IndexUnavailable` at once: nothing is sent, no
/// claim is taken, and nothing is counted as confidential.
pub(crate) async fn judge_run(
    request: JudgeRequest<'_>,
    index: &IndexHandle,
    client: &reqwest::Client,
    cancel: &CancelFlag,
) -> Result<JudgeResult, String> {
    let mut run = run_for_window(request.run_id, request.window_label)?;
    if run.root != request.vault_root {
        return Err("lookup run belongs to another vault; run Smart Lookup again".to_string());
    }
    ordered_hits(&run, request.display_order, request.section_breaks)?;
    let pool = request.params.candidates.pool;
    let Some(confidentiality) = pool_confidentiality(index, &run, request.display_order, pool).await? else {
        return Ok(JudgeResult { skip_reason: Some(SkipReason::IndexUnavailable), ..JudgeResult::default() });
    };
    let claim = match request.trigger {
        Trigger::Auto => {
            let claim = claim_auto_request(&run.id, request.window_label)?;
            run.auto_request_used = claim.is_none();
            claim
        }
        Trigger::User => None,
    };
    let input = JudgeInput {
        run: &run,
        display_order: request.display_order,
        section_breaks: request.section_breaks,
        config: request.config,
        key: request.key,
        trigger: request.trigger,
        confidentiality: &confidentiality,
        params: request.params,
        timeout: request.timeout,
    };
    let outcome = judge_core(input, client, cancel).await;
    let sent = matches!(outcome, Ok((_, _, true)));
    if let Some(claim) = claim {
        if !sent {
            release_auto_request(claim);
        }
    }
    let (result, record, _) = outcome?;
    if let Some(record) = record {
        // A run that expired meanwhile still gets its result shown.
        let _ = update_run(&run.id, request.window_label, |r| r.judgement = Some(record));
    }
    Ok(result)
}

/// The one-round judge as it was a Tauri command. No longer registered
/// (spec H.7): the window and the CLI use the evidence rounds, so this is
/// not reachable over IPC and sends nothing. The code stays, with its
/// tests, until the cleanup that also removes `candidates.pool`/`k`/
/// `perFile`/`tokenBudget`.
#[allow(dead_code)]
pub async fn smart_lookup_judge(
    app: tauri::AppHandle,
    window: tauri::Window,
    lookup_run_id: String,
    display_order: Vec<String>,
    section_breaks: Vec<usize>,
    jev: JevRequestConfig,
    trigger: Trigger,
) -> Result<JudgeResult, String> {
    // An invalid parameter file is an error before anything else: no request.
    let params = lookup_params::for_app(&app)?;
    let vault_root = active_root(&app)?;
    let cancel = cancel_flag_for(trigger, &lookup_run_id);
    let key = match jev.auth_mode {
        AuthMode::Bearer => read_key(&app, KeyKind::Jev),
        AuthMode::None => None,
    };
    let client = enhance_client()?;
    let request = JudgeRequest {
        run_id: &lookup_run_id,
        window_label: window.label(),
        vault_root: &vault_root,
        display_order: &display_order,
        section_breaks: &section_breaks,
        config: &jev,
        key: key.as_deref(),
        trigger,
        params: &params,
        timeout: params.enhance.timeout(),
    };
    judge_run(request, &crate::search::handle(&app), &client, &cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lookup_params::DEFAULT_CRITERION;
    use crate::search::time_group::TimeMode;
    use crate::smart_enhance::{cancel_flag, cancel_flag_for, fresh_cancel_flag, smart_lookup_cancel};
    use crate::smart_lookup::{ArmFact, RouteFacts, RunTime};
    use crate::smart_model::test_support::serve_once;
    use std::fs;
    use std::sync::atomic::Ordering::SeqCst;

    const TIMEOUT: Duration = Duration::from_millis(200);

    struct Fixture {
        _dir: tempfile::TempDir,
        run: LookupRun,
        confidentiality: HashMap<String, String>,
        params: LookupParams,
        root_string: String,
    }

    /// `a.md`…`d.md` with one line each; the run is built by hand (no index).
    /// `question` keeps each test's cache entries apart.
    fn fixture(question: &str) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let bodies = [("a", "A_BODY alpha"), ("b", "B_SECRET beta"), ("c", "C_ORIGINAL gamma"), ("d", "D_BODY delta")];
        for (name, body) in bodies {
            fs::write(dir.path().join(format!("{name}.md")), format!("{body}\n")).unwrap();
        }
        let root = fs::canonicalize(dir.path()).unwrap();
        let hits = bodies
            .iter()
            .enumerate()
            .map(|(i, (name, body))| CanonicalHit {
                result_id: format!("r{}", i + 1),
                path: format!("{name}.md"),
                line: 1,
                line_end: 1,
                level: "line".into(),
                indexed_text: body.to_string(),
                breadcrumb: format!("Heading {name}"),
                pinned: false,
            })
            .collect();
        let run = LookupRun {
            id: uuid::Uuid::now_v7().to_string(),
            created_at: Instant::now(),
            window_label: "test-judge".into(),
            root: root.clone(),
            question: question.into(),
            hits,
            facts: RouteFacts {
                hit_count: 4,
                pinned: false,
                extracted_terms: vec!["x".into(), "y".into(), "z".into()],
                arms: vec![ArmFact { kind: "strict".into(), terms: vec![], hit_count: 4 }],
            },
            time: None,
            auto_request_used: false,
            repaired: false,
            auto_claim: None,
            judgement: None,
            evidence: None,
            evidence_busy: false,
        };
        let confidentiality =
            ["a.md", "b.md", "c.md", "d.md"].iter().map(|p| (p.to_string(), "unknown".to_string())).collect();
        Fixture {
            _dir: dir,
            run,
            confidentiality,
            params: LookupParams::default(),
            root_string: root.to_string_lossy().into_owned(),
        }
    }

    fn config(base: &str) -> JevRequestConfig {
        JevRequestConfig {
            url: base.into(),
            model: "m".into(),
            auth_mode: AuthMode::None,
            consent_host: endpoint_host(base).unwrap(),
        }
    }

    fn answers(scores: &[f64]) -> String {
        let inner: Vec<String> = scores
            .iter()
            .enumerate()
            .map(|(i, s)| format!(r#""c{}":{{"type":"noul","noul":{s}}}"#, i + 1))
            .collect();
        format!(r#"{{"answers":{{{}}}}}"#, inner.join(","))
    }

    const ALL: [&str; 4] = ["r1", "r2", "r3", "r4"];

    async fn judge_with(
        f: &Fixture,
        cfg: &JevRequestConfig,
        order: &[&str],
        breaks: &[usize],
        trigger: Trigger,
        cancel: &CancelFlag,
    ) -> Result<(JudgeResult, Option<JudgeRecord>, bool), String> {
        let order: Vec<String> = order.iter().map(|s| s.to_string()).collect();
        let input = JudgeInput {
            run: &f.run,
            display_order: &order,
            section_breaks: breaks,
            config: cfg,
            key: None,
            trigger,
            confidentiality: &f.confidentiality,
            params: &f.params,
            timeout: TIMEOUT,
        };
        judge_core(input, &enhance_client().unwrap(), cancel).await
    }

    #[tokio::test]
    async fn judge_sends_one_request_and_reranks_within_sections() {
        let f = fixture("judge sends one request");
        let (base, request, accepted) = serve_once(200, answers(&[0.1, 0.9, 0.5, 0.95]), Duration::ZERO).await;
        let (result, record, sent) =
            judge_with(&f, &config(&base), &ALL, &[2], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!(result.status, EnhanceStatus::Ok);
        assert_eq!(result.order, ["r2", "r1", "r4", "r3"]);
        assert_eq!((result.judged_count, result.reranked_count, result.request_count), (4, 4, 1));
        assert_eq!((result.pool_size, result.sent_blocks), (4, 4));
        assert!(!result.reused && sent);
        assert_eq!(accepted.load(SeqCst), 1);
        let request = request.await.unwrap();
        assert!(request.contains("\"type\":\"noul\"") && request.contains("判断准则"), "{request}");
        assert!(request.contains("a_body alpha") && request.contains("heading a"), "{request}");
        assert!(!request.contains("a.md") && !request.contains(&f.root_string.to_lowercase()), "{request}");
        let record = record.unwrap();
        assert_eq!(record.endpoint_host, endpoint_host(&base).unwrap());
        assert_eq!(record.model, "m");
        assert_eq!(record.tiers.get("r2"), Some(&Tier::Fit));
        assert_eq!(record.tiers.get("r1"), Some(&Tier::Unfit));
        assert_eq!(record.tiers.get("r3"), Some(&Tier::Unsure));
        let tiers: Vec<_> = result.verdicts.iter().map(|v| (v.result_id.as_str(), v.tier)).collect();
        assert_eq!(tiers, [("r1", Tier::Unfit), ("r2", Tier::Fit), ("r3", Tier::Unsure), ("r4", Tier::Fit)]);
        assert!(!result.top_ten_unfit);
    }

    #[tokio::test]
    async fn consent_for_another_host_sends_nothing() {
        let f = fixture("consent for another host");
        let (base, _request, accepted) = serve_once(200, answers(&[0.9; 4]), Duration::ZERO).await;
        let cfg = JevRequestConfig { consent_host: "other.example".into(), ..config(&base) };
        let (result, record, sent) =
            judge_with(&f, &cfg, &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        let port = reqwest::Url::parse(&base).unwrap().port().unwrap();
        assert_eq!(result.status, EnhanceStatus::NoConsent);
        assert_eq!(result.endpoint_host.as_deref(), Some(format!("127.0.0.1:{port}").as_str()));
        assert!(record.is_none() && !sent);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn http_errors_map_to_status_without_body_text() {
        for (code, status, class) in [(401, EnhanceStatus::KeyInvalid, "4xx"), (503, EnhanceStatus::Unreachable, "5xx")] {
            let f = fixture(&format!("http error {code}"));
            let (base, _request, _accepted) = serve_once(code, "<html>LEAK sk-live-123</html>", Duration::ZERO).await;
            let (result, record, sent) =
                judge_with(&f, &config(&base), &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
            let json = serde_json::to_string(&result).unwrap();
            assert_eq!((result.status, result.status_class.as_deref()), (status, Some(class)));
            assert!(!json.contains("LEAK") && !json.contains("sk-live") && result.order.is_empty(), "{json}");
            assert!(record.is_none() && sent && result.request_count == 1);
        }
    }

    #[tokio::test]
    async fn a_slow_service_times_out_and_keeps_the_local_order() {
        let f = fixture("a slow service");
        let (base, _request, _accepted) = serve_once(200, answers(&[0.9; 4]), Duration::from_secs(1)).await;
        let (result, record, _) =
            judge_with(&f, &config(&base), &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!(result.status, EnhanceStatus::Timeout);
        assert!(result.order.is_empty() && record.is_none());
    }

    #[tokio::test]
    async fn a_second_identical_judge_reuses_the_cached_verdicts() {
        let f = fixture("a second identical judge");
        let (base, _request, accepted) = serve_once(200, answers(&[0.1, 0.9, 0.5, 0.95]), Duration::ZERO).await;
        let cfg = config(&base);
        let (first, _, _) = judge_with(&f, &cfg, &ALL, &[2], Trigger::User, &CancelFlag::new()).await.unwrap();
        let (second, record, sent) =
            judge_with(&f, &cfg, &ALL, &[2], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!(second.status, EnhanceStatus::Ok);
        assert!(second.reused && second.request_count == 0 && !sent);
        assert_eq!(second.order, first.order);
        assert!(record.is_some());
        assert_eq!(accepted.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn an_auto_judge_after_the_runs_request_is_skipped_but_a_user_retry_is_sent() {
        let mut f = fixture("an auto judge after the run's request");
        f.run.auto_request_used = true;
        let (base, _request, accepted) = serve_once(200, answers(&[0.9; 4]), Duration::ZERO).await;
        let cfg = config(&base);
        let (auto, _, auto_sent) = judge_with(&f, &cfg, &ALL, &[], Trigger::Auto, &CancelFlag::new()).await.unwrap();
        assert_eq!((auto.status, auto.skip_reason), (EnhanceStatus::Skipped, Some(SkipReason::AutoBudgetUsed)));
        assert!(!auto_sent);
        let (user, _, _) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!(user.status, EnhanceStatus::Ok);
        assert_eq!(accepted.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn a_cancel_before_the_request_starts_still_cancels() {
        let f = fixture("a cancel before the request");
        let (base, _request, accepted) = serve_once(200, answers(&[0.9; 4]), Duration::from_secs(1)).await;
        let cancel = CancelFlag::new();
        cancel.cancel();
        let (result, record, sent) = judge_with(&f, &config(&base), &ALL, &[], Trigger::User, &cancel).await.unwrap();
        assert_eq!(result.status, EnhanceStatus::Cancelled);
        assert!(record.is_none() && !sent && result.request_count == 0);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_cancel_during_the_request_stops_waiting_for_it() {
        let f = fixture("a cancel during the request");
        let (base, _request, accepted) = serve_once(200, answers(&[0.9; 4]), Duration::from_secs(1)).await;
        let cancel = std::sync::Arc::new(CancelFlag::new());
        let canceller = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            canceller.cancel();
        });
        let cfg = config(&base);
        let order: Vec<String> = ALL.iter().map(|s| s.to_string()).collect();
        let input = JudgeInput {
            run: &f.run,
            display_order: &order,
            section_breaks: &[],
            config: &cfg,
            key: None,
            trigger: Trigger::User,
            confidentiality: &f.confidentiality,
            params: &f.params,
            timeout: Duration::from_secs(3),
        };
        let started = Instant::now();
        let (result, record, sent) = judge_core(input, &enhance_client().unwrap(), &cancel).await.unwrap();
        assert_eq!(result.status, EnhanceStatus::Cancelled);
        assert!(record.is_none() && sent && result.request_count == 1);
        assert!(started.elapsed() < Duration::from_millis(900));
        assert_eq!(accepted.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn a_retry_after_a_cancel_on_the_same_run_is_not_cancelled() {
        let f = fixture("a retry after a cancel");
        let (base, _request, _accepted) = serve_once(200, answers(&[0.9; 4]), Duration::ZERO).await;
        let cfg = config(&base);
        smart_lookup_cancel(f.run.id.clone());
        let stale = cancel_flag(&f.run.id);
        let (first, _, _) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &stale).await.unwrap();
        assert_eq!(first.status, EnhanceStatus::Cancelled);
        // What the command does at the start of every call.
        let fresh = fresh_cancel_flag(&f.run.id);
        let (second, _, _) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &fresh).await.unwrap();
        assert_eq!(second.status, EnhanceStatus::Ok);
        // A cancel now reaches the flag the new call holds.
        smart_lookup_cancel(f.run.id.clone());
        assert!(fresh.is_cancelled());
    }

    #[tokio::test]
    async fn confidential_stale_and_rollup_blocks_are_never_sent() {
        let mut f = fixture("confidential stale and rollup blocks");
        f.confidentiality.insert("b.md".into(), "confidential".into());
        fs::write(f.run.root.join("c.md"), "C_CHANGED gamma\n").unwrap();
        f.run.hits[3].level = "section".into();
        f.run.hits[3].indexed_text = String::new();
        let (base, request, _accepted) = serve_once(200, answers(&[0.1]), Duration::ZERO).await;
        let (result, _, _) = judge_with(&f, &config(&base), &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        let request = request.await.unwrap();
        // The fake server lower-cases what it receives.
        assert!(!request.contains("b_secret") && !request.contains("c_changed") && !request.contains("d_body"), "{request}");
        assert!(request.contains("a_body"), "{request}");
        assert_eq!(result.status, EnhanceStatus::Ok);
        assert_eq!((result.skipped_confidential, result.skipped_stale, result.skipped_rollups), (1, 1, 1));
        assert_eq!((result.judged_count, result.sent_blocks, result.reranked_count), (1, 1, 0));
        assert_eq!(result.order[1..], ["r2", "r3", "r4"]); // 未判断的位置不变
        assert_eq!(result.order[0], "r1");
    }

    #[tokio::test]
    async fn nothing_to_send_skips_without_a_request_and_fills_the_counts() {
        let mut f = fixture("nothing to send");
        for v in f.confidentiality.values_mut() {
            *v = "confidential".into();
        }
        let (base, _request, accepted) = serve_once(200, answers(&[0.9; 4]), Duration::ZERO).await;
        let (result, record, sent) =
            judge_with(&f, &config(&base), &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!((result.status, result.skip_reason), (EnhanceStatus::Skipped, Some(SkipReason::NoCandidates)));
        assert_eq!((result.pool_size, result.skipped_confidential, result.sent_blocks), (4, 4, 0));
        assert!(record.is_none() && !sent && result.order.is_empty());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn repaired_pinned_and_unconfigured_runs_send_nothing() {
        let (base, _request, accepted) = serve_once(200, answers(&[0.9; 4]), Duration::ZERO).await;
        let cfg = config(&base);

        let mut f = fixture("repaired run");
        f.run.repaired = true;
        let (r, _, _) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!((r.status, r.skip_reason), (EnhanceStatus::Skipped, Some(SkipReason::Repaired)));

        let mut f = fixture("pinned run");
        f.run.facts.pinned = true;
        let (r, _, _) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!((r.status, r.skip_reason), (EnhanceStatus::Skipped, Some(SkipReason::Pinned)));

        let mut f = fixture("zero-hit run");
        f.run.facts.hit_count = 0;
        let (r, _, _) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!((r.status, r.skip_reason), (EnhanceStatus::Skipped, Some(SkipReason::ZeroHits)));

        let f = fixture("unconfigured run");
        let unconfigured = JevRequestConfig { model: String::new(), ..cfg.clone() };
        let (r, _, _) = judge_with(&f, &unconfigured, &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!((r.status, r.missing), (EnhanceStatus::NotConfigured, Some(Missing::Model)));
        assert!(r.endpoint_host.is_none());

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_display_order_that_is_not_a_permutation_is_an_error() {
        let f = fixture("not a permutation");
        let cfg = config("http://127.0.0.1:9/v1");
        let flag = CancelFlag::new();
        for order in [&["r1", "r2", "r3"][..], &["r1", "r1", "r2", "r3"], &["r1", "r2", "r3", "r9"]] {
            assert!(judge_with(&f, &cfg, order, &[], Trigger::User, &flag).await.is_err(), "{order:?}");
        }
        let bad_breaks: [&[usize]; 4] = [&[0], &[4], &[2, 2], &[3, 1]];
        for breaks in bad_breaks {
            assert!(judge_with(&f, &cfg, &ALL, breaks, Trigger::User, &flag).await.is_err(), "{breaks:?}");
        }
        // Any permutation with breaks strictly inside 1..len is accepted (a
        // repaired run stops before anything could be sent).
        let mut repaired = fixture("a valid permutation");
        repaired.run.repaired = true;
        assert!(judge_with(&repaired, &cfg, &["r4", "r3", "r2", "r1"], &[1, 3], Trigger::User, &flag).await.is_ok());
    }

    #[test]
    fn the_cache_keeps_a_hundred_entries_for_ten_minutes_and_drops_the_oldest() {
        let mut cache = VecDeque::new();
        let start = Instant::now();
        let key = |i: u8| [i; 32];
        for i in 0..=100u8 {
            cache_store(&mut cache, key(i), vec![0.9], start);
        }
        assert_eq!(cache.len(), CACHE_CAPACITY);
        assert!(cache_lookup(&mut cache, &key(0), 1, start).is_none());
        assert_eq!(cache_lookup(&mut cache, &key(1), 1, start), Some(vec![0.9]));
        assert!(cache_lookup(&mut cache, &key(1), 2, start).is_none(), "candidate count must match");
        let later = start + CACHE_TTL + Duration::from_secs(1);
        assert!(cache_lookup(&mut cache, &key(100), 1, later).is_none());
        assert!(cache.is_empty());
    }

    #[test]
    fn the_cache_key_covers_everything_that_is_sent() {
        let f = fixture("cache key");
        let read = |h: &CanonicalHit| read_source(&f.run.root, h);
        let refs: Vec<&CanonicalHit> = f.run.hits.iter().collect();
        let picked = select_candidates(&refs, &f.confidentiality, read, &f.params.candidates.limits()).picked;
        let questions: Vec<NoulQuestion> =
            picked.iter().enumerate().map(|(i, c)| question_for(format!("c{}", i + 1), c)).collect();
        let key = |e: &str, m: &str, a: AuthMode, s: &str, q: &[NoulQuestion]| cache_key(e, m, a, s, q);
        let base = key("http://h/v1/systemone", "m", AuthMode::None, "s", &questions);
        assert_eq!(base, key("http://h/v1/systemone", "m", AuthMode::None, "s", &questions));
        assert_ne!(base, key("http://h/v2/systemone", "m", AuthMode::None, "s", &questions));
        assert_ne!(base, key("http://h/v1/systemone", "m2", AuthMode::None, "s", &questions));
        assert_ne!(base, key("http://h/v1/systemone", "m", AuthMode::Bearer, "s", &questions));
        assert_ne!(base, key("http://h/v1/systemone", "m", AuthMode::None, "s2", &questions));
        assert_ne!(base, key("http://h/v1/systemone", "m", AuthMode::None, "s", &questions[..3]));
        let mut changed = questions.clone();
        changed[0].instructions["breadcrumb"] = serde_json::json!("Renamed heading");
        assert_ne!(base, key("http://h/v1/systemone", "m", AuthMode::None, "s", &changed));
        let mut renumbered = questions.clone();
        renumbered[0].id = "c9".into();
        assert_ne!(base, key("http://h/v1/systemone", "m", AuthMode::None, "s", &renumbered));
    }

    #[tokio::test]
    async fn another_route_on_the_same_host_or_another_time_range_is_not_a_cache_hit() {
        let mut f = fixture("cache misses on what is sent");
        let (base, _request, accepted) = serve_once(200, answers(&[0.9, 0.1, 0.5, 0.2]), Duration::ZERO).await;
        let v1 = config(&base);
        let v2 = JevRequestConfig { url: base.replace("/v1", "/v2"), ..config(&base) };
        let flag = CancelFlag::new();
        let (first, _, _) = judge_with(&f, &v1, &ALL, &[], Trigger::User, &flag).await.unwrap();
        let (other_route, _, sent) = judge_with(&f, &v2, &ALL, &[], Trigger::User, &flag).await.unwrap();
        assert!(!first.reused && !other_route.reused && sent);
        assert_eq!(other_route.status, EnhanceStatus::Ok);
        assert_eq!(accepted.load(SeqCst), 2);
        f.run.time = Some(RunTime {
            source_text: "上周".into(),
            after: chrono::NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
            before: chrono::NaiveDate::from_ymd_opt(2026, 11, 9).unwrap(),
            mode: TimeMode::Window,
            in_window: 4,
        });
        let (timed, _, sent) = judge_with(&f, &v1, &ALL, &[], Trigger::User, &flag).await.unwrap();
        assert!(!timed.reused && sent);
        assert_eq!(accepted.load(SeqCst), 3);
        let (again, _, sent) = judge_with(&f, &v1, &ALL, &[], Trigger::User, &flag).await.unwrap();
        assert!(again.reused && !sent);
        assert_eq!(accepted.load(SeqCst), 3);
    }

    // ---- judge_run: the retained run, the automatic-request slot, the index

    fn index_for(root: &Path) -> (tempfile::TempDir, IndexHandle) {
        let db = tempfile::tempdir().unwrap();
        let mut index = searchidx::SearchIndex::open_at(root, &db.path().join("i.db"), "sync").unwrap();
        index.rebuild(&searchidx::ScanOptions::default()).unwrap();
        (db, std::sync::Arc::new(Mutex::new(Some(index))))
    }

    fn no_index() -> IndexHandle {
        std::sync::Arc::new(Mutex::new(None))
    }

    /// Registers the fixture's run (under a fresh id) and returns that id.
    fn register(f: &Fixture) -> String {
        let id = uuid::Uuid::now_v7().to_string();
        crate::smart_lookup::insert_run_for_test(LookupRun { id: id.clone(), created_at: Instant::now(), ..f.run.clone() });
        id
    }

    async fn run_judge(
        f: &Fixture,
        run_id: &str,
        cfg: &JevRequestConfig,
        order: &[&str],
        trigger: Trigger,
        index: &IndexHandle,
    ) -> Result<JudgeResult, String> {
        let order: Vec<String> = order.iter().map(|s| s.to_string()).collect();
        let request = JudgeRequest {
            run_id,
            window_label: &f.run.window_label,
            vault_root: &f.run.root,
            display_order: &order,
            section_breaks: &[],
            config: cfg,
            key: None,
            trigger,
            params: &f.params,
            timeout: TIMEOUT,
        };
        judge_run(request, index, &enhance_client().unwrap(), &CancelFlag::new()).await
    }

    fn slot(f: &Fixture, run_id: &str) -> (bool, Option<u64>) {
        let run = run_for_window(run_id, &f.run.window_label).unwrap();
        (run.auto_request_used, run.auto_claim)
    }

    #[tokio::test]
    async fn an_automatic_send_keeps_the_claim_and_a_second_automatic_request_is_skipped() {
        let f = fixture("an automatic send keeps the claim");
        let (_db, index) = index_for(&f.run.root);
        let (base, _request, accepted) = serve_once(200, answers(&[0.1, 0.9, 0.5, 0.95]), Duration::ZERO).await;
        let cfg = config(&base);
        let id = register(&f);

        let auto = run_judge(&f, &id, &cfg, &ALL, Trigger::Auto, &index).await.unwrap();
        assert_eq!(auto.status, EnhanceStatus::Ok);
        assert_eq!(auto.sent_blocks, 4, "the index's own confidentiality map is keyed like CanonicalHit.path");
        assert!(slot(&f, &id).0, "a sent automatic request keeps its claim");
        let judgement = run_for_window(&id, &f.run.window_label).unwrap().judgement.unwrap();
        assert_eq!(judgement.tiers.len(), 4);
        assert_eq!(judgement.tiers.get("r2"), Some(&Tier::Fit));

        let second = run_judge(&f, &id, &cfg, &ALL, Trigger::Auto, &index).await.unwrap();
        assert_eq!((second.status, second.skip_reason), (EnhanceStatus::Skipped, Some(SkipReason::AutoBudgetUsed)));
        assert!(slot(&f, &id).0);

        // The user's own retry is not automatic: allowed while the slot is used.
        let user = run_judge(&f, &id, &cfg, &ALL, Trigger::User, &index).await.unwrap();
        assert_eq!((user.status, user.skip_reason), (EnhanceStatus::Ok, None));
        assert!(slot(&f, &id).0);
        assert_eq!(accepted.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn an_automatic_judge_that_sends_nothing_gives_the_claim_back() {
        let f = fixture("an automatic judge that sends nothing");
        let (_db, index) = index_for(&f.run.root);
        let (base, _request, accepted) = serve_once(200, answers(&[0.9; 4]), Duration::ZERO).await;
        let cfg = config(&base);

        // Confidentiality unavailable (no index): no claim is left behind.
        let id = register(&f);
        let unavailable = run_judge(&f, &id, &cfg, &ALL, Trigger::Auto, &no_index()).await.unwrap();
        assert_eq!(unavailable.skip_reason, Some(SkipReason::IndexUnavailable));
        assert_eq!(slot(&f, &id), (false, None));

        // Nothing to send (every file confidential).
        let mut secret = fixture("an automatic judge with only secrets");
        for name in ["a", "b", "c", "d"] {
            fs::write(secret.run.root.join(format!("{name}.md")), "---\nprivate: true\n---\nsecret\n").unwrap();
        }
        secret.run.window_label = f.run.window_label.clone();
        let (_secret_db, secret_index) = index_for(&secret.run.root);
        let secret_id = register(&secret);
        let none = run_judge(&secret, &secret_id, &cfg, &ALL, Trigger::Auto, &secret_index).await.unwrap();
        assert_eq!((none.skip_reason, none.skipped_confidential), (Some(SkipReason::NoCandidates), 4));
        assert_eq!(slot(&secret, &secret_id), (false, None));

        // Gated.
        let gated = JevRequestConfig { consent_host: "other.example".into(), ..cfg.clone() };
        let refused = run_judge(&f, &id, &gated, &ALL, Trigger::Auto, &index).await.unwrap();
        assert_eq!(refused.status, EnhanceStatus::NoConsent);
        assert_eq!(slot(&f, &id), (false, None));

        // A reused verdict: the user's judge sent, the automatic one did not.
        let user = run_judge(&f, &id, &cfg, &ALL, Trigger::User, &index).await.unwrap();
        assert!(!user.reused);
        assert_eq!(slot(&f, &id), (false, None), "a user request does not touch the slot");
        let reused = run_judge(&f, &id, &cfg, &ALL, Trigger::Auto, &index).await.unwrap();
        assert!(reused.reused);
        assert_eq!(slot(&f, &id), (false, None));
        assert_eq!(accepted.load(SeqCst), 1);
    }

    #[test]
    fn a_release_only_undoes_its_own_claim() {
        let f = fixture("a release only undoes its own claim");
        let label = f.run.window_label.clone();

        let id = register(&f);
        let first = claim_auto_request(&id, &label).unwrap().expect("a fresh run's slot is free");
        assert!(claim_auto_request(&id, &label).unwrap().is_none(), "a second automatic request is refused");
        release_auto_request(first);
        assert_eq!(slot(&f, &id), (false, None));
        let again = claim_auto_request(&id, &label).unwrap().expect("a released slot can be claimed again");

        // The slot was taken over meanwhile (another claim holds it): a stale
        // release must leave it used.
        update_run(&id, &label, |r| r.auto_claim = Some(u64::MAX)).unwrap();
        release_auto_request(again);
        assert_eq!(slot(&f, &id), (true, Some(u64::MAX)));

        // A repaired run's slot is used from the start and no claim holds it.
        let mut repaired = fixture("a repaired run");
        repaired.run.repaired = true;
        repaired.run.auto_request_used = true;
        let repaired_id = register(&repaired);
        assert!(claim_auto_request(&repaired_id, &label).unwrap().is_none());
        assert_eq!(slot(&repaired, &repaired_id), (true, None));
    }

    #[tokio::test]
    async fn another_vaults_index_a_missing_index_or_a_busy_index_is_unavailable_and_sends_nothing() {
        let f = fixture("another vault's index");
        // Same file names, another vault: the paths would match, the root does not.
        let other = fixture("the other vault");
        let (_db, other_index) = index_for(&other.run.root);
        let (base, _request, accepted) = serve_once(200, answers(&[0.9; 4]), Duration::ZERO).await;
        let cfg = config(&base);
        let id = register(&f);

        let unavailable = |r: &JudgeResult| {
            assert_eq!((r.status, r.skip_reason), (EnhanceStatus::Skipped, Some(SkipReason::IndexUnavailable)));
            assert_eq!((r.skipped_confidential, r.sent_blocks, r.request_count, r.pool_size), (0, 0, 0, 0));
            assert!(r.order.is_empty() && r.verdicts.is_empty());
        };
        for index in [other_index, no_index()] {
            unavailable(&run_judge(&f, &id, &cfg, &ALL, Trigger::User, &index).await.unwrap());
        }

        // Busy: another holder has the lock (as a rebuild does); not waited for.
        let (_db, index) = index_for(&f.run.root);
        let held = index.lock().unwrap();
        let started = Instant::now();
        unavailable(&run_judge(&f, &id, &cfg, &ALL, Trigger::User, &index).await.unwrap());
        assert!(started.elapsed() < Duration::from_secs(1));
        // A bad order is refused before the index is looked at.
        assert_eq!(
            run_judge(&f, &id, &cfg, &["r1", "r2"], Trigger::User, &index).await.unwrap_err(),
            "invalid display order"
        );
        drop(held);

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(accepted.load(SeqCst), 0);
        assert_eq!(scoped_confidentiality(None, &f.run.root), None);
        assert_eq!(serde_json::to_string(&SkipReason::IndexUnavailable).unwrap(), "\"indexUnavailable\"");
    }

    #[tokio::test]
    async fn a_confidential_file_in_the_index_is_still_counted_as_confidential() {
        let f = fixture("a confidential file in the index");
        fs::write(f.run.root.join("b.md"), "---\nprivate: true\n---\nB_SECRET beta\n").unwrap();
        let (_db, index) = index_for(&f.run.root);
        let (base, request, accepted) = serve_once(200, answers(&[0.9, 0.5, 0.1]), Duration::ZERO).await;
        let id = register(&f);
        let r = run_judge(&f, &id, &config(&base), &ALL, Trigger::User, &index).await.unwrap();
        assert_eq!(r.status, EnhanceStatus::Ok);
        assert_eq!((r.skipped_confidential, r.sent_blocks, r.request_count), (1, 3, 1));
        let request = request.await.unwrap();
        assert!(!request.contains("b_secret") && request.contains("a_body"), "{request}");
        assert_eq!(accepted.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn a_run_from_another_vault_or_window_is_refused() {
        let f = fixture("a run from another vault");
        let other = fixture("the active vault");
        let id = register(&f);
        let cfg = config("http://127.0.0.1:9/v1");
        let order: Vec<String> = ALL.iter().map(|s| s.to_string()).collect();
        let make = |vault_root: &Path, window_label: &str| {
            let params = f.params.clone();
            let order = order.clone();
            let cfg = cfg.clone();
            let id = id.clone();
            let vault_root = vault_root.to_path_buf();
            let window_label = window_label.to_string();
            async move {
                let request = JudgeRequest {
                    run_id: &id,
                    window_label: &window_label,
                    vault_root: &vault_root,
                    display_order: &order,
                    section_breaks: &[],
                    config: &cfg,
                    key: None,
                    trigger: Trigger::User,
                    params: &params,
                    timeout: TIMEOUT,
                };
                judge_run(request, &no_index(), &enhance_client().unwrap(), &CancelFlag::new()).await
            }
        };
        assert!(make(&other.run.root, &f.run.window_label).await.unwrap_err().contains("another vault"));
        assert!(make(&f.run.root, "another-window").await.unwrap_err().contains("expired"));
    }

    #[test]
    fn the_state_carries_the_question_time_filters_and_criterion() {
        let mut f = fixture("tag:work 发布 风险 评审");
        f.run.time = Some(RunTime {
            source_text: "上周".into(),
            after: chrono::NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
            before: chrono::NaiveDate::from_ymd_opt(2026, 11, 9).unwrap(),
            mode: TimeMode::Group,
            in_window: 2,
        });
        let state = build_state(&f.run, DEFAULT_CRITERION);
        let lines: Vec<&str> = state.lines().collect();
        assert_eq!(lines[0], "用户要找的内容：tag:work 发布 风险 评审");
        assert_eq!(lines[1], "时间范围：2026-11-02 至 2026-11-09（来自「上周」）");
        assert_eq!(lines[2], "过滤条件：tag:work");
        assert!(lines[3].starts_with("判断准则：仅依据候选的标题、层级和提供的原文"));
        assert_eq!(lines.len(), 4);

        // Ignore mode: the user chose to ignore time, so no 时间范围 line
        // (as repair sends 「时间：无」).
        let mut ignored = fixture("tag:work 发布 风险 评审");
        ignored.run.time = f.run.time.clone().map(|t| RunTime { mode: TimeMode::Ignore, ..t });
        let ignored = build_state(&ignored.run, DEFAULT_CRITERION);
        assert!(!ignored.contains("时间范围"), "{ignored}");
        assert_eq!(ignored.lines().collect::<Vec<_>>(), [lines[0], lines[2], lines[3]]);
        // Window mode is a filter on the time: the line goes out.
        let mut window = fixture("发布 风险 评审");
        window.run.time = f.run.time.clone().map(|t| RunTime { mode: TimeMode::Window, ..t });
        assert!(build_state(&window.run, DEFAULT_CRITERION).lines().nth(1).unwrap().starts_with("时间范围："));

        let plain = build_state(&fixture("发布 风险 评审").run, DEFAULT_CRITERION);
        assert_eq!(plain.lines().count(), 2);
        assert_eq!(lines[3], format!("判断准则：{DEFAULT_CRITERION}"));
        let custom = build_state(&fixture("发布").run, "只看决定。");
        assert_eq!(custom.lines().last(), Some("判断准则：只看决定。"));
    }

    /// The Settings page shows `JEV_REQUEST_EXAMPLE` as what is sent: its
    /// `state` has the lines `build_state` writes, in the same order, and the
    /// criterion is `DEFAULT_CRITERION`.
    #[test]
    fn the_settings_request_example_has_the_state_lines_in_build_state_order() {
        let mut f = fixture("tag:work 发布");
        f.run.time = Some(RunTime {
            source_text: "上周".into(),
            after: chrono::NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
            before: chrono::NaiveDate::from_ymd_opt(2026, 11, 9).unwrap(),
            mode: TimeMode::Group,
            in_window: 1,
        });
        let prefix = |line: &str| line.split_once('：').map(|(p, _)| p.to_string()).unwrap();
        let sent: Vec<String> = build_state(&f.run, DEFAULT_CRITERION).lines().map(prefix).collect();
        assert_eq!(sent, ["用户要找的内容", "时间范围", "过滤条件", "判断准则"]);

        const API: &str = include_str!("../../../src/lib/smart-search/api.ts");
        let start = API.find("state: `").expect("JEV_REQUEST_EXAMPLE.state") + "state: `".len();
        let body = &API[start..];
        let state = &body[..body.find('`').unwrap()];
        let shown: Vec<String> = state
            .split("\\n")
            .map(|line| prefix(line.trim_start_matches('[').trim_end_matches(']')))
            .collect();
        assert_eq!(shown, sent, "{state}");
        assert!(state.ends_with("判断准则：${CRITERION}"), "{state}");
        assert!(API.contains(&format!("const CRITERION = '{DEFAULT_CRITERION}'")), "the example's criterion is DEFAULT_CRITERION");
    }

    #[test]
    fn an_index_that_cannot_answer_is_unavailable_not_all_unknown() {
        let root = PathBuf::from("/v");
        assert_eq!(index_answer(root.clone(), Err("no such table: files".into())), None);
        let found: HashMap<String, String> = [("a.md".to_string(), "unknown".to_string())].into();
        assert_eq!(index_answer(root.clone(), Ok(found.clone())), Some((root, found)));
    }

    #[tokio::test]
    async fn an_automatic_judge_after_a_cancel_stays_cancelled_and_sends_nothing() {
        let f = fixture("an automatic judge after a cancel");
        let (base, _request, accepted) = serve_once(200, answers(&[0.9; 4]), Duration::ZERO).await;
        let cfg = config(&base);
        // 停止 reaches the host before the automatic judge registers its flag.
        smart_lookup_cancel(f.run.id.clone());
        let auto = cancel_flag_for(Trigger::Auto, &f.run.id);
        assert!(auto.is_cancelled());
        let (r, _, sent) = judge_with(&f, &cfg, &ALL, &[], Trigger::Auto, &auto).await.unwrap();
        assert_eq!((r.status, r.request_count, sent), (EnhanceStatus::Cancelled, 0, false));
        // The user's own retry starts from a fresh flag.
        assert!(!cancel_flag_for(Trigger::User, &f.run.id).is_cancelled());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_changed_criterion_or_candidate_set_is_a_new_request_but_new_tiers_reuse_the_scores() {
        let mut f = fixture("params and the judge cache");
        let (base, request, accepted) = serve_once(200, answers(&[0.1, 0.65, 0.5, 0.95]), Duration::ZERO).await;
        let cfg = config(&base);
        let flag = CancelFlag::new();
        let (first, _, _) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &flag).await.unwrap();
        assert_eq!((first.status, first.reused), (EnhanceStatus::Ok, false));
        assert_eq!(first.verdicts[1].tier, Tier::Unsure);

        // Tiers are not part of the request: the cached scores are re-tiered.
        f.params.tiers.fit = 0.6;
        let (retiered, _, sent) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &flag).await.unwrap();
        assert!(retiered.reused && !sent);
        assert_eq!(retiered.verdicts[1].tier, Tier::Fit);
        assert_eq!(accepted.load(SeqCst), 1);

        // Another criterion changes the state that is sent.
        f.params.judge.criterion = "只看决定。".into();
        let (other, _, sent) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &flag).await.unwrap();
        assert!(!other.reused && sent);
        assert_eq!(accepted.load(SeqCst), 2);
        let first_request = request.await.unwrap();
        assert!(first_request.contains("判断准则：仅依据候选的标题"), "{first_request}");

        // A smaller K sends fewer candidates: a new request (the fake answers
        // four, so it is Invalid, but it went out).
        f.params.candidates.k = 2;
        let (fewer, _, sent) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &flag).await.unwrap();
        assert!(!fewer.reused && sent && fewer.sent_blocks == 2);
        assert_eq!(accepted.load(SeqCst), 3);

        // A budget that still fits every block sends the same request: reused.
        f.params.candidates.k = 10;
        f.params.candidates.token_budget = 500;
        let (same, _, sent) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &flag).await.unwrap();
        assert!(same.reused && !sent);
        assert_eq!(accepted.load(SeqCst), 3);
        // One that cuts the candidate set (6 tokens a block here) is a new request.
        f.params.candidates.token_budget = 12;
        let (cut, _, sent) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &flag).await.unwrap();
        assert!(!cut.reused && sent && cut.sent_blocks == 2);
        assert_eq!(accepted.load(SeqCst), 4);
    }

    #[tokio::test]
    async fn routing_follows_the_few_terms_param() {
        let mut f = fixture("few terms param");
        f.run.facts.extracted_terms = vec!["x".into(), "y".into(), "z".into()];
        f.params.routing.few_terms_max = 3;
        let cfg = config("http://127.0.0.1:9/v1");
        let (r, _, sent) = judge_with(&f, &cfg, &ALL, &[], Trigger::User, &CancelFlag::new()).await.unwrap();
        assert_eq!((r.status, r.skip_reason, sent), (EnhanceStatus::Skipped, Some(SkipReason::FewTerms), false));
    }
}
