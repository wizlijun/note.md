//! SAG2 evidence rounds on a lookup run (spec Appendix H.1, H.3, H.6): one
//! `smart_lookup_evidence_step` call runs exactly one round of
//! [`EvidenceState`] on the run's state and writes the state back, so the
//! window can show, stop and resume between rounds. The CLI pipeline loops
//! the same [`evidence_step`].
//!
//! Before anything is sent, every call goes through the checks of the
//! one-round judge (`judge.rs`): the index is ready (the caller checks it
//! with [`ready_reader`] and hands in the reader; else
//! `skipped`/`indexUnavailable`), the run belongs to the active vault,
//! automatic calls need the `judge` route, `gate_jev` (configuration and
//! per-host consent) passes, and the run's automatic slot is claimed for an
//! automatic first round and given back when the call sent nothing. Later
//! rounds of the same evidence run belong to that claim (H.6).
//!
//! What is sent: the free text of the question, the explicit filters and
//! time range as text, earlier evidence, and each candidate's title (file
//! name without extension), heading and passage (`sag::jev`). Never a vault
//! path and never a key. Confidential, stale and overlong blocks are dropped
//! by `ReaderIndex::candidates` before a pool is built.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, TryLockError};
use std::time::{Duration, Instant};

use searchidx::sag::SagReader;
use serde::Serialize;

use super::candidates::{route, tier, Route};
use super::judge::VerdictDto;
use super::keys::{read_key, KeyKind};
use super::sag::jev::{jev_batches, score_round, BatchError, Preset, RoundError, StateExtras, TimeRange};
use super::sag::round::{
    EvidenceState, EvidenceStop, ReaderIndex, RoundSettings, SagIndex, Scorer, Skipped, SkippedIds, StepOutcome,
};
use super::sag::{SagCandidate, Term, TermKind};
use super::{
    cancel_flag_for, claim_auto_request, enhance_client, gate_jev, release_auto_request, status_for, CancelFlag,
    EnhanceStatus, Gate, JevRequestConfig, Missing, SkipReason, Tier, Trigger, UsageDto,
};
use crate::lookup_params::{self, LookupParams, TierParams};
use crate::search::time_group::{run_time_scoped_query, TimeMode};
use crate::search::IndexHandle;
use crate::smart_lookup::{active_root, run_for_window, update_run, LookupRun};
use crate::smart_model::{endpoint_host, jev_endpoint, AuthMode, JevConfig};

/// Read-only connections per [`SagReader`] (SAG2 `query_workers` default, H.3.4).
const READER_WORKERS: usize = 8;

/// One expansion term as the window shows it (`label` is the spelling found
/// in the notes, ruling T4 M4).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceTermDto {
    pub term: String,
    pub label: String,
    pub kind: TermKind,
}

/// One entry of the evidence list: local text only, never remote text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceItemDto {
    /// Opaque, stable for a block within one lookup run.
    pub evidence_id: String,
    pub path: String,
    /// The run's vault root joined with `path`, as for local hits
    /// (`HitDto::abs_path`): what the window opens. Never sent anywhere.
    pub abs_path: String,
    pub line: u32,
    pub line_end: u32,
    pub title: String,
    pub breadcrumb: String,
    pub text: String,
    /// The round in which the block was first a candidate.
    pub found_round: u8,
    /// From the block's latest score (`tiers.*`).
    pub tier: Tier,
    /// The local hit with the same path and line range, if any.
    pub local_result_id: Option<String>,
}

/// What the evidence rounds of one lookup run have sent and left out so far
/// (the F.3 details), cumulative over every call that reached a round,
/// cancelled and failed ones included. Block counts are distinct over the
/// run: a passage sent in two rounds, or dropped in two, counts once.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRunTotals {
    /// The Jev host passages went to; `None` while nothing was sent.
    pub endpoint_host: Option<String>,
    pub requests: u32,
    pub elapsed_ms: u64,
    /// Distinct passages sent: every pool passage in a request and every
    /// earlier evidence passage repeated in `state`.
    pub sent_blocks: usize,
    /// Estimated tokens of the rounds that were sent (`tokens_used`).
    pub tokens: u64,
    pub skipped_confidential: usize,
    pub skipped_stale: usize,
    pub skipped_long: usize,
    pub skipped_oversize: usize,
}

/// What one round did. Counts are this call's; `tokens_used`, `next_hop` and
/// `run` are the run's so far. A call that scores nothing (a stop or a
/// failure) reports the latest scored evidence again. `hop` is the hop this
/// call attempted (the run's `next_hop` when it started), on every path.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceStepResult {
    pub status: EnhanceStatus,
    pub stop: Option<EvidenceStop>,
    pub skip_reason: Option<SkipReason>,
    pub missing: Option<Missing>,
    pub endpoint_host: Option<String>,
    pub status_class: Option<String>,
    pub hop: u8,
    pub terms: Vec<EvidenceTermDto>,
    pub evidence: Vec<EvidenceItemDto>,
    pub local_tiers: Vec<VerdictDto>,
    /// No further round will run without the user.
    pub done: bool,
    pub request_count: u32,
    pub pool_size: usize,
    /// The trace candidate count of the round reported (pre-flight P13).
    pub candidates: usize,
    pub sent_blocks: usize,
    pub skipped_confidential: usize,
    pub skipped_stale: usize,
    pub skipped_long: usize,
    pub skipped_oversize: usize,
    /// This round's budget estimate, also when the budget kept it from being sent.
    pub estimated_tokens: u64,
    pub tokens_used: u64,
    pub usage: Option<UsageDto>,
    pub elapsed_ms: u64,
    /// The hop the run's next call attempts (`EvidenceState::next_hop`); 0
    /// before any round.
    pub next_hop: u8,
    /// The run's totals after this call, also when this call sent nothing.
    pub run: EvidenceRunTotals,
    /// `(path, line, line_end)` of each block this call sent, in send order.
    /// Host-side only (the eval's window coverage); never serialized.
    #[serde(skip)]
    pub sent: Vec<(String, u32, u32)>,
}

/// The evidence rounds kept on a lookup run (`LookupRun.evidence`).
#[derive(Clone)]
pub(crate) struct EvidenceRun {
    pub state: EvidenceState,
    /// Every evidence id handed out on this run and its block id; a block
    /// keeps its id across rounds.
    pub items: Vec<(String /*evidence_id*/, i64 /*block id*/)>,
    /// The Jev host and model that scored the latest sent round.
    pub endpoint_host: String,
    pub model: String,
    /// The run's automatic slot belongs to these rounds.
    pub auto_claimed: bool,
    /// An automatic call sent requests and its round did not finish (a
    /// failure, a cancel, an index change). The automatic rounds of this run
    /// are over; the user can still continue (`Trigger::User`).
    pub auto_ended: bool,
    /// The tier last reported per evidence id and per local result id, for
    /// the user's corrections (F.4).
    pub tiers: HashMap<String, Tier>,
    /// The latest scored round's list, reported again by a call that scores
    /// nothing.
    pub shown: Option<(Vec<EvidenceItemDto>, Vec<VerdictDto>)>,
    pub totals: RunTotals,
}

/// The books behind [`EvidenceRunTotals`]: block ids, so counts stay distinct.
#[derive(Clone, Default)]
pub(crate) struct RunTotals {
    pub endpoint_host: Option<String>,
    pub requests: u32,
    pub elapsed_ms: u64,
    pub sent: BTreeSet<i64>,
    pub confidential: BTreeSet<i64>,
    pub stale: BTreeSet<i64>,
    pub long: BTreeSet<i64>,
    pub oversize: BTreeSet<i64>,
}

impl RunTotals {
    fn dto(&self, tokens: u64) -> EvidenceRunTotals {
        EvidenceRunTotals {
            endpoint_host: self.endpoint_host.clone(),
            requests: self.requests,
            elapsed_ms: self.elapsed_ms,
            sent_blocks: self.sent.len(),
            tokens,
            skipped_confidential: self.confidential.len(),
            skipped_stale: self.stale.len(),
            skipped_long: self.long.len(),
            skipped_oversize: self.oversize.len(),
        }
    }
}

pub(crate) struct EvidenceRequest<'a> {
    pub run_id: &'a str,
    pub window_label: &'a str,
    /// The active vault, canonical.
    pub vault_root: &'a Path,
    pub config: &'a JevRequestConfig,
    pub key: Option<&'a str>,
    pub trigger: Trigger,
    /// An expanded lookup: every round takes `retrieval.deepCandidateK`
    /// candidates instead of `retrieval.candidateK` (spec H.3.10).
    pub deep: bool,
    pub params: &'a LookupParams,
    pub reader: Arc<SagReader>,
}

// ---- readers ---------------------------------------------------------------

/// What a cached reader was opened on: the vault root, the globs stamp and
/// the database file's identity.
#[derive(PartialEq)]
struct ReaderKey {
    root: PathBuf,
    stamp: String,
    file: Option<(u64, u64)>,
}

type Readers = HashMap<PathBuf, (ReaderKey, Arc<SagReader>)>;

static READERS: OnceLock<Mutex<Readers>> = OnceLock::new();

fn readers() -> std::sync::MutexGuard<'static, Readers> {
    READERS.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// `(dev, ino)` of the database file: a file wiped and recreated at the same
/// path (a corrupt or outdated index, possibly by another process) is
/// another file, and a reader on the old one would never see a commit.
#[cfg(unix)]
fn file_identity(db: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(db).ok().map(|m| (m.dev(), m.ino()))
}

/// No cheap file identity here: [`forget_readers`] on every reopen is the
/// only defence.
#[cfg(not(unix))]
fn file_identity(_db: &Path) -> Option<(u64, u64)> {
    None
}

/// One [`SagReader`] per index database for the process, reopened when the
/// vault root, the globs stamp or the database file changes. Kept so the
/// per-reader caches (document frequencies, the alias table) outlive a lookup.
pub(crate) fn reader_for(root: &Path, db: &Path, globs_stamp: &str) -> Result<Arc<SagReader>, String> {
    let key = ReaderKey { root: root.to_path_buf(), stamp: globs_stamp.to_string(), file: file_identity(db) };
    let mut readers = readers();
    if let Some((cached, reader)) = readers.get(db) {
        if *cached == key {
            return Ok(reader.clone());
        }
    }
    readers.remove(db);
    let reader = Arc::new(SagReader::open_existing_at(root, db, globs_stamp, READER_WORKERS)?);
    readers.insert(db.to_path_buf(), (key, reader.clone()));
    Ok(reader)
}

/// Drops every cached reader, so their connections close: called wherever
/// the host reopens its index (`search::open_vault`, a settings change),
/// before the open may wipe the file. A round in flight keeps its own
/// reader and stops on its next generation check.
///
/// A known race: this runs before the caller drops the old `SearchIndex`,
/// so a [`ready_reader`] that took the index lock just before the reopen
/// can cache a reader on the old file again in that window. On unix the
/// `(dev, ino)` in [`ReaderKey`] replaces it on the next call. On Windows
/// there is no file identity, so that reader stays until the next
/// `forget_readers`, and its open handle can make a wipe of the old file
/// fail (the reopen then reports an error and can be retried). Rare, and it
/// never sends anything: every round still checks confidentiality and the
/// source text.
pub(crate) fn forget_readers() {
    readers().clear();
}

/// A reader already cached for `vault_root` (canonical) whose database file
/// is still the one it was opened on. Takes no index lock.
fn cached_reader(vault_root: &Path) -> Option<Arc<SagReader>> {
    let readers = readers();
    readers.iter().find_map(|(db, (key, reader))| {
        let same_root = std::fs::canonicalize(&key.root).is_ok_and(|root| root == vault_root);
        (same_root && key.file == file_identity(db)).then(|| reader.clone())
    })
}

/// The reader for `vault_root`'s index when that index is ready. The first
/// time, with the readiness the local lookup and the judge use: the host
/// holds an open index (not busy: a rebuild holds the lock for minutes and
/// is not waited for) and it belongs to `vault_root`. After that the cached
/// reader for this vault is used without the index lock (review M6: a
/// watcher ingest between rounds no longer ends them); a reopen of the
/// index drops it ([`forget_readers`]). `None` otherwise, which callers
/// report as `skipped`/`indexUnavailable`. The lock is held only to read the
/// index's location, never during a round.
pub(crate) async fn ready_reader(index: &IndexHandle, vault_root: &Path) -> Result<Option<Arc<SagReader>>, String> {
    let handle = index.clone();
    let vault_root = vault_root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        if let Some(reader) = cached_reader(&vault_root) {
            return Some(reader);
        }
        let (root, db, stamp) = {
            let guard = match handle.try_lock() {
                Ok(guard) => guard,
                Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
                Err(TryLockError::WouldBlock) => return None,
            };
            let index = guard.as_ref()?;
            if !std::fs::canonicalize(index.vault_root()).is_ok_and(|root| root == vault_root) {
                return None;
            }
            (index.vault_root().to_path_buf(), index.db_path().to_path_buf(), index.globs_stamp()?)
        };
        reader_for(&root, &db, &stamp).ok()
    })
    .await
    .map_err(|_| "index readiness check failed".to_string())
}

/// `skipped`/`indexUnavailable`: nothing was sent and nothing is counted.
pub(crate) fn unavailable() -> EvidenceStepResult {
    EvidenceStepResult { skip_reason: Some(SkipReason::IndexUnavailable), done: true, ..EvidenceStepResult::default() }
}

// ---- the scorer -----------------------------------------------------------

/// [`Scorer`] over Jev (spec H.3.7, H.6): batches, the lookup budget, then
/// one `score_round` under the round deadline. Records what it did.
struct JevScorer {
    client: reqwest::Client,
    jev: JevConfig,
    key: Option<String>,
    preset: Preset,
    criterion: String,
    context_tokens: u64,
    cjk: u32,
    other: u32,
    deadline: Duration,
    budget: u64,
    tokens_used: u64,
    cancel: Arc<CancelFlag>,
    requests: u32,
    estimated: u64,
    /// The round `step` built: its pool length and candidate count, also when
    /// it was not scored (review M3).
    built: Option<(usize, usize)>,
    /// Ids of the blocks sent, pool and `state` evidence (review M2).
    sent_ids: BTreeSet<i64>,
    oversize: BTreeSet<i64>,
    usage: Option<(u64, u64)>,
    sent: Vec<(String, u32, u32)>,
}

impl Scorer for JevScorer {
    fn built(&mut self, pool_size: usize, candidates: usize) {
        self.built = Some((pool_size, candidates));
    }

    fn score(
        &mut self,
        pool: Vec<SagCandidate>,
        evidence: Vec<SagCandidate>,
        state: String,
    ) -> impl std::future::Future<Output = Result<Vec<SagCandidate>, RoundError>> + Send {
        async move {
            let pool_ids: Vec<i64> = pool.iter().map(|c| c.id).collect();
            let (batches, _) =
                jev_batches(&state, pool, self.preset, &self.criterion, self.context_tokens, self.cjk, self.other)
                    .map_err(|BatchError::EvidenceTooLarge| RoundError::Stop(EvidenceStop::EvidenceTooLarge))?;
            let batched: BTreeSet<i64> = batches.iter().flat_map(|b| b.items.iter().map(|c| c.id)).collect();
            self.oversize = pool_ids.into_iter().filter(|id| !batched.contains(id)).collect();
            self.estimated = batches.iter().map(|b| b.estimated).sum();
            // H.6: the whole round's estimate must fit what is left; else nothing goes out.
            if self.tokens_used + self.estimated > self.budget {
                return Err(RoundError::Stop(EvidenceStop::Budget));
            }
            if self.cancel.is_cancelled() {
                return Err(RoundError::Cancelled);
            }
            // Every request carries `state`, so its evidence goes out with the
            // pool: the distinct union, pool order first.
            let in_state: &[SagCandidate] = if batches.is_empty() { &[] } else { &evidence };
            let mut sent_ids = BTreeSet::new();
            self.sent = batches
                .iter()
                .flat_map(|b| b.items.iter())
                .chain(in_state)
                .filter(|c| sent_ids.insert(c.id))
                .map(|c| (c.path.clone(), c.line, c.line_end))
                .collect();
            self.sent_ids = sent_ids;
            self.requests = batches.len() as u32;
            let round =
                score_round(&self.client, &self.jev, self.key.as_deref(), &state, batches, self.deadline, &self.cancel)
                    .await?;
            self.usage = round.usage;
            Ok(round.scored)
        }
    }
}

// ---- one round off the async workers ----------------------------------------

/// Everything one round needs, owned, so it can run on a blocking thread.
struct Round {
    /// `None`: the first call on the run; `start` runs first.
    state: Option<EvidenceState>,
    free_text: String,
    settings: RoundSettings,
    extras: StateExtras,
    index: ReaderIndex,
    scorer: JevScorer,
}

struct RoundDone {
    /// `None` when `start` failed.
    state: Option<EvidenceState>,
    outcome: Result<StepOutcome, String>,
    /// After a scored round: the list SAG2 would return now (H.3.10).
    evidence: Option<Result<Vec<SagCandidate>, String>>,
    skipped: Skipped,
    skipped_ids: SkippedIds,
    scorer: JevScorer,
}

/// `start` (when needed), `step` and `evidence`: synchronous SQLite and file
/// work, with the scoring awaited through `handle` (Task 7 note: `start` is
/// about 1.9 s cold).
fn run_round(round: Round, handle: tokio::runtime::Handle) -> RoundDone {
    let Round { state, free_text, settings, extras, index, mut scorer } = round;
    let started = match state {
        Some(state) => Ok(state),
        None => EvidenceState::start(&index, &free_text, settings),
    };
    let mut state = match started {
        Ok(state) => state,
        Err(error) => {
            return RoundDone {
                state: None,
                outcome: Err(error),
                evidence: None,
                skipped: index.skipped(),
                skipped_ids: index.skipped_ids(),
                scorer,
            }
        }
    };
    let cancel = scorer.cancel.clone();
    let outcome = handle.block_on(state.step(&index, &mut scorer, &extras, &cancel));
    let evidence = matches!(outcome, Ok(StepOutcome::Scored { .. })).then(|| state.evidence(&index));
    RoundDone { state: Some(state), outcome, evidence, skipped: index.skipped(), skipped_ids: index.skipped_ids(), scorer }
}

/// [`run_round`] on a blocking thread. A cancel of `cancel` reaches the round
/// through its own flag, and the round is always awaited to its end, so the
/// state it returns is consistent (D3).
async fn off_workers(round: Round, cancel: &CancelFlag) -> Result<RoundDone, String> {
    let inner = round.scorer.cancel.clone();
    if cancel.is_cancelled() {
        inner.cancel();
    }
    let handle = tokio::runtime::Handle::current();
    let task = tokio::task::spawn_blocking(move || run_round(round, handle));
    tokio::pin!(task);
    let joined = tokio::select! {
        biased;
        joined = &mut task => joined,
        _ = cancel.cancelled() => {
            inner.cancel();
            task.await
        }
    };
    joined.map_err(|_| "evidence round failed".to_string())
}

// ---- the step ---------------------------------------------------------------

/// The lookup's free text and explicit filters (spec H.3.2): in `window`
/// time mode the time phrase is removed and its range becomes a filter, as in
/// the local search; otherwise the question as typed.
fn lookup_query(run: &LookupRun) -> (String, searchidx::Query) {
    let scoped = match &run.time {
        Some(time) if time.mode == TimeMode::Window => run_time_scoped_query(&run.question, time),
        _ => run.question.clone(),
    };
    let mut filters = searchidx::query::parse(&scoped);
    filters.terms.clear();
    filters.phrases.clear();
    (searchidx::query::free_text(&scoped), filters)
}

/// The fields after SAG2's in `state` (H.3.7): the user's filters, and the
/// time range unless time is ignored.
fn state_extras(run: &LookupRun) -> StateExtras {
    StateExtras {
        explicit_filters: crate::search::explicit_filters(&run.question),
        time_range: run.time.as_ref().filter(|t| t.mode != TimeMode::Ignore).map(|t| TimeRange {
            after: t.after.format("%Y-%m-%d").to_string(),
            before: t.before.format("%Y-%m-%d").to_string(),
            source_text: t.source_text.clone(),
        }),
    }
}

fn round_settings(params: &LookupParams, deep: bool) -> RoundSettings {
    let r = &params.retrieval;
    RoundSettings {
        candidate_k: r.candidate_k_for(deep),
        seed_k: r.seed_k,
        term_limit: r.expansion_term_limit,
        // 0..=2 by the parameter bounds; `start` refuses more.
        max_hops: u8::try_from(r.max_hops).unwrap_or(u8::MAX),
        top_k: r.top_k,
        protected_k: r.protected_k,
    }
}

fn term_dtos(terms: &[Term]) -> Vec<EvidenceTermDto> {
    terms.iter().map(|t| EvidenceTermDto { term: t.term.clone(), label: t.label.clone(), kind: t.kind }).collect()
}

/// The evidence list as DTOs, handing out ids for blocks new to the run.
fn evidence_items(record: &mut EvidenceRun, run: &LookupRun, list: &[SagCandidate], tiers: &TierParams) -> Vec<EvidenceItemDto> {
    list.iter()
        .map(|c| {
            let evidence_id = match record.items.iter().find(|(_, id)| *id == c.id) {
                Some((evidence_id, _)) => evidence_id.clone(),
                None => {
                    let evidence_id = uuid::Uuid::now_v7().to_string();
                    record.items.push((evidence_id.clone(), c.id));
                    evidence_id
                }
            };
            EvidenceItemDto {
                evidence_id,
                path: c.path.clone(),
                abs_path: run.root.join(&c.path).to_string_lossy().to_string(),
                line: c.line,
                line_end: c.line_end,
                title: c.title.clone(),
                breadcrumb: c.heading.clone(),
                text: c.content.clone(),
                found_round: record.state.found_round.get(&c.id).copied().unwrap_or(0),
                tier: tier(c.score, tiers),
                local_result_id: run
                    .hits
                    .iter()
                    .find(|h| h.path == c.path && h.line == c.line && h.line_end == c.line_end)
                    .map(|h| h.result_id.clone()),
            }
        })
        .collect()
}

/// Each local hit whose path and line range equal a block scored on this run,
/// tiered by that block's latest score (H.8).
fn local_tiers(run: &LookupRun, state: &EvidenceState, tiers: &TierParams) -> Vec<VerdictDto> {
    let latest: HashMap<(&str, u32, u32), f64> =
        state.latest.values().map(|c| ((c.path.as_str(), c.line, c.line_end), c.score)).collect();
    run.hits
        .iter()
        .filter_map(|h| {
            let score = latest.get(&(h.path.as_str(), h.line, h.line_end))?;
            Some(VerdictDto { result_id: h.result_id.clone(), tier: tier(*score, tiers) })
        })
        .collect()
}

/// A call that scored nothing reports the latest scored list again: `ok`
/// when there is one, else `skipped`. Its terms are those of the attempted
/// hop's trace entry, which exists only for a round that found no candidates
/// (`candidatesEmpty`; H.3.11 keeps it so the window can show its terms).
fn report_shown(result: &mut EvidenceStepResult, record: &EvidenceRun) {
    if let Some((evidence, local)) = &record.shown {
        result.status = EnhanceStatus::Ok;
        result.evidence = evidence.clone();
        result.local_tiers = local.clone();
    }
    if let Some(trace) = record.state.trace.last().filter(|t| t.hop == result.hop) {
        result.terms = term_dtos(&trace.terms);
        result.candidates = trace.candidates.len();
    }
}

/// The run's totals and next hop as stored, onto a result of this call.
/// Leaves the result as it is when the run has no evidence rounds yet (or
/// expired meanwhile).
fn with_run_totals(mut result: EvidenceStepResult, run_id: &str, window_label: &str) -> EvidenceStepResult {
    if let Some(record) = run_for_window(run_id, window_label).ok().and_then(|run| run.evidence) {
        result.run = record.totals.dto(record.state.tokens_used);
        result.next_hop = record.state.next_hop;
    }
    result
}

/// Holds a lookup run's `evidence_busy` flag: one evidence round per run at
/// a time. Dropping it clears the flag, so every exit path does.
pub(crate) struct StepGuard {
    run_id: String,
    window_label: String,
}

impl Drop for StepGuard {
    fn drop(&mut self) {
        // A run that expired meanwhile has no flag left to clear.
        let _ = update_run(&self.run_id, &self.window_label, |run| run.evidence_busy = false);
    }
}

/// Check-and-set of the run's `evidence_busy` flag (the shape of
/// `claim_auto_request`). `None`: a round is already running on the run.
pub(crate) fn begin_step(run_id: &str, window_label: &str) -> Result<Option<StepGuard>, String> {
    let mut taken = false;
    update_run(run_id, window_label, |run| {
        if !run.evidence_busy {
            run.evidence_busy = true;
            taken = true;
        }
    })?;
    Ok(taken.then(|| StepGuard { run_id: run_id.to_string(), window_label: window_label.to_string() }))
}

/// `skipped`/`roundRunning`: another round holds the run; nothing was sent.
/// Not `done`: the rounds may well go on (the window ignores this result).
fn round_running() -> EvidenceStepResult {
    EvidenceStepResult { skip_reason: Some(SkipReason::RoundRunning), done: false, ..EvidenceStepResult::default() }
}

/// Run one round on the run (see the module docs for the checks before
/// anything is sent), write the state back and report it. A second call
/// while a round runs on the same run returns `skipped`/`roundRunning`.
pub(crate) async fn evidence_step(
    req: EvidenceRequest<'_>,
    client: &reqwest::Client,
    cancel: &CancelFlag,
) -> Result<EvidenceStepResult, String> {
    let Some(guard) = begin_step(req.run_id, req.window_label)? else {
        return Ok(with_run_totals(round_running(), req.run_id, req.window_label));
    };
    evidence_step_held(req, guard, client, cancel).await
}

/// [`evidence_step`] for a caller that already holds the run's guard (the
/// command takes it before it replaces the run's cancel flag).
async fn evidence_step_held(
    req: EvidenceRequest<'_>,
    guard: StepGuard,
    client: &reqwest::Client,
    cancel: &CancelFlag,
) -> Result<EvidenceStepResult, String> {
    let started = Instant::now();
    let (run_id, window_label) = (req.run_id, req.window_label);
    let result = evidence_steps(req, client, cancel, started).await;
    // Read while the guard still holds the run: no other round has changed it.
    let result = result.map(|r| with_run_totals(r, run_id, window_label));
    drop(guard);
    let mut result = result?;
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

async fn evidence_steps(
    req: EvidenceRequest<'_>,
    client: &reqwest::Client,
    cancel: &CancelFlag,
    started: Instant,
) -> Result<EvidenceStepResult, String> {
    let run = run_for_window(req.run_id, req.window_label)?;
    if run.root != req.vault_root {
        return Err("lookup run belongs to another vault; run Smart Lookup again".to_string());
    }
    let params = req.params;
    let ended = |result: EvidenceStepResult| -> Result<EvidenceStepResult, String> {
        Ok(EvidenceStepResult { done: true, ..result })
    };
    if req.trigger == Trigger::Auto {
        let reason = match route(&run.facts, params.routing.few_terms_max) {
            Route::Repair => Some(SkipReason::ZeroHits),
            Route::Skip(reason) => Some(reason),
            Route::Judge => None,
        };
        if let Some(reason) = reason {
            return ended(EvidenceStepResult { skip_reason: Some(reason), ..EvidenceStepResult::default() });
        }
    }
    let jev = match gate_jev(req.config, req.key) {
        Ok(jev) => jev,
        Err(Gate::NotConfigured(missing)) => {
            return ended(EvidenceStepResult {
                status: EnhanceStatus::NotConfigured,
                missing: Some(missing),
                ..EvidenceStepResult::default()
            })
        }
        Err(Gate::NoConsent { endpoint_host }) => {
            return ended(EvidenceStepResult {
                status: EnhanceStatus::NoConsent,
                endpoint_host: Some(endpoint_host),
                ..EvidenceStepResult::default()
            })
        }
    };
    // The gate accepted the URL, so it resolves to an endpoint and a host.
    let host = jev_endpoint(&jev.url).and_then(|e| endpoint_host(&e)).unwrap_or_default();
    let previous = run.evidence.clone();
    // The first round sent automatically takes the run's one automatic slot;
    // the later rounds of the same evidence run belong to it (H.6).
    // An automatic call is refused when the rounds it would continue do not
    // hold the claim (the user started them) or already ended after sending.
    let first = previous.as_ref().map_or(true, |e| e.state.next_hop == 0 && !e.auto_claimed);
    let auto_budget_used = || {
        ended(EvidenceStepResult {
            endpoint_host: Some(host.clone()),
            skip_reason: Some(SkipReason::AutoBudgetUsed),
            ..EvidenceStepResult::default()
        })
    };
    let claim = match req.trigger {
        Trigger::Auto if first => match claim_auto_request(&run.id, req.window_label)? {
            Some(claim) => Some(claim),
            None => return auto_budget_used(),
        },
        Trigger::Auto if previous.as_ref().is_some_and(|e| !e.auto_claimed || e.auto_ended) => {
            return auto_budget_used()
        }
        Trigger::Auto | Trigger::User => None,
    };

    let (free_text, filters) = lookup_query(&run);
    let round = Round {
        state: previous.as_ref().map(|e| e.state.clone()),
        free_text,
        settings: round_settings(params, req.deep),
        extras: state_extras(&run),
        index: ReaderIndex::new(req.reader.clone(), run.root.clone(), filters, params.candidates.max_block_chars),
        scorer: JevScorer {
            client: client.clone(),
            jev: jev.clone(),
            key: req.key.map(str::to_owned),
            preset: params.judge.preset,
            criterion: params.judge.criterion.clone(),
            context_tokens: params.retrieval.jev_context_tokens,
            cjk: params.candidates.cjk_chars_per_token,
            other: params.candidates.other_chars_per_token,
            deadline: params.retrieval.round_timeout(),
            budget: params.budget.max_tokens_per_lookup,
            tokens_used: previous.as_ref().map_or(0, |e| e.state.tokens_used),
            cancel: Arc::new(CancelFlag::new()),
            requests: 0,
            estimated: 0,
            built: None,
            sent_ids: BTreeSet::new(),
            oversize: BTreeSet::new(),
            usage: None,
            sent: vec![],
        },
    };
    // The hop this call attempts, reported on every path (review M4).
    let attempted = previous.as_ref().map_or(0, |e| e.state.next_hop);
    let done = off_workers(round, cancel).await;
    // A failed join (a panic in the round) may have sent: keep the claim.
    let sent = done.as_ref().map_or(true, |d| d.scorer.requests > 0);
    if done.is_err() && req.trigger == Trigger::Auto {
        let _ = update_run(&run.id, req.window_label, |r| {
            if let Some(e) = r.evidence.as_mut() {
                e.auto_ended = true;
            }
        });
    }
    let auto_claimed = match claim {
        Some(claim) if !sent => {
            release_auto_request(claim);
            false
        }
        Some(_) => true,
        None => previous.as_ref().is_some_and(|e| e.auto_claimed),
    };
    let RoundDone { state, outcome, evidence, skipped, skipped_ids, scorer } = done?;

    let mut result = EvidenceStepResult {
        endpoint_host: Some(host.clone()),
        hop: attempted,
        done: true,
        request_count: scorer.requests,
        sent_blocks: scorer.sent_ids.len(),
        skipped_confidential: skipped.confidential,
        skipped_stale: skipped.stale,
        skipped_long: skipped.long,
        skipped_oversize: scorer.oversize.len(),
        estimated_tokens: scorer.estimated,
        usage: scorer.usage.map(|(input_tokens, output_tokens)| UsageDto { input_tokens, output_tokens }),
        sent: scorer.sent,
        ..EvidenceStepResult::default()
    };
    let Some(mut state) = state else {
        crate::log_cat!("search", "warn", "SAG2 evidence: the index could not be read");
        return Ok(EvidenceStepResult { endpoint_host: Some(host), ..unavailable() });
    };
    if scorer.requests > 0 {
        state.tokens_used += scorer.estimated;
    }
    result.tokens_used = state.tokens_used;
    let mut record = previous.unwrap_or_else(|| EvidenceRun {
        state: state.clone(),
        items: vec![],
        endpoint_host: host.clone(),
        model: jev.model.clone(),
        auto_claimed,
        auto_ended: false,
        tiers: HashMap::new(),
        shown: None,
        totals: RunTotals::default(),
    });
    record.state = state;
    record.auto_claimed = auto_claimed;
    let totals = &mut record.totals;
    totals.requests += scorer.requests;
    totals.elapsed_ms += started.elapsed().as_millis() as u64;
    totals.sent.extend(scorer.sent_ids.iter().copied());
    if scorer.requests > 0 {
        totals.endpoint_host = Some(host.clone());
    }
    let index_failed = outcome.is_err() || matches!(evidence, Some(Err(_)));
    if !index_failed {
        // A failed index read counts nothing as dropped (see below).
        totals.confidential.extend(skipped_ids.confidential);
        totals.stale.extend(skipped_ids.stale);
        totals.long.extend(skipped_ids.long);
        totals.oversize.extend(scorer.oversize.iter().copied());
    }
    let scored = matches!((&outcome, &evidence), (Ok(StepOutcome::Scored { .. }), Some(Ok(_))));
    if req.trigger == Trigger::Auto && scorer.requests > 0 && !scored {
        record.auto_ended = true;
    }
    if scorer.requests > 0 {
        record.endpoint_host = host.clone();
        record.model = jev.model.clone();
    }

    match (outcome, evidence) {
        (Err(_), _) | (_, Some(Err(_))) => {
            // An index read failed (confidentiality included): nothing more is
            // sent and nothing is counted as confidential.
            crate::log_cat!("search", "warn", "SAG2 evidence: an index read failed during the round");
            result = EvidenceStepResult {
                endpoint_host: Some(host),
                hop: attempted,
                request_count: result.request_count,
                sent_blocks: result.sent_blocks,
                tokens_used: result.tokens_used,
                sent: std::mem::take(&mut result.sent),
                ..unavailable()
            };
        }
        (Ok(StepOutcome::Scored { hop, terms, pool_size }), Some(Ok(list))) => {
            debug_assert_eq!(hop, attempted);
            result.status = EnhanceStatus::Ok;
            result.hop = hop;
            result.terms = term_dtos(&terms);
            result.pool_size = pool_size;
            result.candidates = record.state.trace.last().map_or(0, |t| t.candidates.len());
            let items = evidence_items(&mut record, &run, &list, &params.tiers);
            let local = local_tiers(&run, &record.state, &params.tiers);
            record.tiers.extend(items.iter().map(|i| (i.evidence_id.clone(), i.tier)));
            record.tiers.extend(local.iter().map(|v| (v.result_id.clone(), v.tier)));
            record.shown = Some((items.clone(), local.clone()));
            result.evidence = items;
            result.local_tiers = local;
            // P14: the round just scored was the last one.
            if record.state.next_hop > record.state.settings.max_hops {
                result.stop = Some(EvidenceStop::MaxHops);
            } else {
                result.done = false;
            }
        }
        (Ok(StepOutcome::Scored { .. }), None) => unreachable!("a scored round always computes its evidence"),
        (Ok(StepOutcome::Stopped(stop)), _) => {
            result.stop = Some(stop);
            report_shown(&mut result, &record);
            // A round the scorer would not send (budget, evidence too large).
            if let Some((pool_size, candidates)) = scorer.built {
                (result.pool_size, result.candidates) = (pool_size, candidates);
            }
        }
        (Ok(StepOutcome::Failed(error)), _) => {
            report_shown(&mut result, &record);
            // The round that failed, not an earlier one (review M3).
            result.terms = vec![];
            (result.pool_size, result.candidates) = scorer.built.unwrap_or((0, 0));
            (result.status, result.status_class) = match error {
                RoundError::Model(error) => status_for(&error),
                RoundError::Cancelled => (EnhanceStatus::Cancelled, None),
                // `step` reports a scorer's stop as `Stopped`.
                RoundError::Stop(stop) => {
                    result.stop = Some(stop);
                    (result.status, None)
                }
            };
        }
    }
    // A run that expired meanwhile still gets its result shown.
    let _ = update_run(&run.id, req.window_label, |r| r.evidence = Some(record));
    Ok(result)
}

#[tauri::command]
pub async fn smart_lookup_evidence_step(
    app: tauri::AppHandle,
    window: tauri::Window,
    lookup_run_id: String,
    jev: JevRequestConfig,
    trigger: Trigger,
    deep: bool,
) -> Result<EvidenceStepResult, String> {
    // An invalid parameter file is an error before anything else: no request.
    let params = lookup_params::for_app(&app)?;
    let vault_root = active_root(&app)?;
    // Before `cancel_flag_for` may replace the run's flag: a round already
    // running keeps the flag a stop reaches.
    let Some(guard) = begin_step(&lookup_run_id, window.label())? else {
        return Ok(with_run_totals(round_running(), &lookup_run_id, window.label()));
    };
    let cancel = cancel_flag_for(trigger, &lookup_run_id);
    let key = match jev.auth_mode {
        AuthMode::Bearer => read_key(&app, KeyKind::Jev),
        AuthMode::None => None,
    };
    let client = enhance_client()?;
    let Some(reader) = ready_reader(&crate::search::handle(&app), &vault_root).await? else {
        return Ok(with_run_totals(unavailable(), &lookup_run_id, window.label()));
    };
    let request = EvidenceRequest {
        run_id: &lookup_run_id,
        window_label: window.label(),
        vault_root: &vault_root,
        config: &jev,
        key: key.as_deref(),
        trigger,
        deep,
        params: &params,
        reader,
    };
    evidence_step_held(request, guard, &client, &cancel).await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::smart_enhance::cancel_flag;
    use crate::smart_model::test_support::{serve_noul, NoulServer};
    use std::sync::atomic::{AtomicU64, Ordering::SeqCst};

    pub(crate) const QUESTION: &str = "anchor budget review meeting";

    /// A vault whose round 0 finds `q.md` and whose round 1 reaches `p.md`
    /// through the name `Alice Paul`; `secret.md` (confidential) is reachable
    /// the same way and must never be sent.
    pub(crate) struct Fixture {
        pub _root: tempfile::TempDir,
        _data: tempfile::TempDir,
        pub root: PathBuf,
        pub index: IndexHandle,
    }

    pub(crate) fn fixture() -> Fixture {
        fixture_with(&[
            ("q.md", "The anchor budget review meeting was chaired by Alice Paul.\n"),
            ("p.md", "Alice Paul signed the contract.\n"),
            ("secret.md", "---\nconfidentiality: confidential\n---\nAlice Paul SECRET_SALARY figures\n"),
            ("other.md", "unrelated gardening notes\n"),
        ])
    }

    /// A vault of `files`, indexed.
    pub(crate) fn fixture_with(files: &[(&str, &str)]) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        for &(name, body) in files {
            std::fs::write(dir.path().join(name), body).unwrap();
        }
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut idx = searchidx::SearchIndex::open_at(&root, &data.path().join("i.db"), "sync").unwrap();
        idx.sweep(&searchidx::ScanOptions::default(), None).unwrap();
        Fixture { _root: dir, _data: data, root, index: Arc::new(Mutex::new(Some(idx))) }
    }

    pub(crate) fn lookup(f: &Fixture, window: &str, params: &LookupParams) -> String {
        let counter = Arc::new(AtomicU64::new(1));
        let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 11).unwrap();
        crate::search::lookup_local_in(&f.index, &f.root, window, QUESTION, None, false, None, None, today, params, &counter, 1)
            .unwrap()
            .lookup_run_id
    }

    /// q.md scores 0.95 (fit), everything else 0.1 (unfit).
    pub(crate) async fn server(delay: impl Fn(usize) -> Duration + Send + Sync + 'static) -> NoulServer {
        serve_noul(
            |q| if q["instructions"]["candidate_passage"].as_str().unwrap_or("").contains("chaired") { 0.95 } else { 0.1 },
            delay,
        )
        .await
    }

    pub(crate) fn config(base: &str) -> JevRequestConfig {
        JevRequestConfig { url: base.into(), model: "m".into(), auth_mode: AuthMode::None, consent_host: endpoint_host(base).unwrap() }
    }

    struct Ctx {
        f: Fixture,
        window: String,
        run: String,
        params: LookupParams,
        reader: Arc<SagReader>,
    }

    async fn ctx(window: &str) -> Ctx {
        let f = fixture();
        let params = LookupParams::default();
        let run = lookup(&f, window, &params);
        let reader = ready_reader(&f.index, &f.root).await.unwrap().expect("the index is ready");
        Ctx { f, window: window.into(), run, params, reader }
    }

    impl Ctx {
        async fn step_with(&self, cfg: &JevRequestConfig, trigger: Trigger, cancel: &CancelFlag) -> EvidenceStepResult {
            let request = EvidenceRequest {
                run_id: &self.run,
                window_label: &self.window,
                vault_root: &self.f.root,
                config: cfg,
                key: None,
                trigger,
                deep: false,
                params: &self.params,
                reader: self.reader.clone(),
            };
            evidence_step(request, &enhance_client().unwrap(), cancel).await.unwrap()
        }

        fn slot(&self) -> (bool, Option<u64>) {
            let run = run_for_window(&self.run, &self.window).unwrap();
            (run.auto_request_used, run.auto_claim)
        }

        fn evidence(&self) -> EvidenceRun {
            run_for_window(&self.run, &self.window).unwrap().evidence.unwrap()
        }
    }

    fn paths(r: &EvidenceStepResult) -> Vec<&str> {
        r.evidence.iter().map(|i| i.path.as_str()).collect()
    }

    #[tokio::test]
    async fn first_step_claims_the_auto_slot_and_later_steps_reuse_it() {
        let c = ctx("test-evidence-claim").await;
        let s = server(|_| Duration::ZERO).await;
        let cfg = config(&s.base);
        let cancel = CancelFlag::new();
        let r1 = c.step_with(&cfg, Trigger::Auto, &cancel).await;
        assert_eq!((r1.status, r1.hop, r1.done), (EnhanceStatus::Ok, 0, false), "{r1:?}");
        assert_eq!((r1.request_count, r1.stop), (1, None));
        assert_eq!(paths(&r1), ["q.md"]);
        assert_eq!(r1.evidence[0].tier, Tier::Fit);
        assert!(c.slot().0 && c.evidence().auto_claimed, "the sent first round keeps the claim");
        let r2 = c.step_with(&cfg, Trigger::Auto, &cancel).await;
        assert_eq!((r2.hop, r2.done, r2.stop), (1, true, Some(EvidenceStop::MaxHops)), "{r2:?}"); // maxHops 1
        assert_eq!((r2.status, r2.request_count), (EnhanceStatus::Ok, 1));
        assert!(r2.terms.iter().any(|t| t.term == "alice paul" && t.label == "Alice Paul"), "{:?}", r2.terms);
        assert!(paths(&r2).contains(&"p.md"), "{r2:?}");
        assert_eq!(r2.evidence.iter().find(|i| i.path == "p.md").unwrap().found_round, 1);
        let r3 = c.step_with(&cfg, Trigger::Auto, &cancel).await;
        assert!(r3.done && r3.request_count == 0, "{r3:?}"); // 超过 maxHops 不再发
        // The hop it attempted (review M4), with no terms of another hop.
        assert_eq!((r3.status, r3.stop, r3.hop, r3.next_hop), (EnhanceStatus::Ok, Some(EvidenceStop::MaxHops), 2, 2));
        assert!(r3.terms.is_empty() && r3.candidates == 0, "{r3:?}");
        assert_eq!((r1.next_hop, r2.next_hop), (1, 2));
        assert_eq!(r3.evidence, r2.evidence);
        assert_eq!(s.accepted.load(SeqCst), 2);
        assert_eq!(r2.tokens_used, r1.estimated_tokens + r2.estimated_tokens);
        // Never a confidential passage, a vault path or a file name with its extension.
        assert!(r2.skipped_confidential >= 1, "{r2:?}");
        let root = c.f.root.to_string_lossy().to_string();
        for body in s.bodies.lock().unwrap().iter() {
            assert!(!body.contains("SECRET_SALARY") && !body.contains(&root) && !body.contains(".md"), "{body}");
        }
    }

    #[tokio::test]
    async fn consent_for_another_host_sends_nothing() {
        let c = ctx("test-evidence-consent").await;
        let s = server(|_| Duration::ZERO).await;
        let cfg = JevRequestConfig { consent_host: "other.example".into(), ..config(&s.base) };
        let r = c.step_with(&cfg, Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!(r.status, EnhanceStatus::NoConsent);
        assert_eq!(r.endpoint_host, endpoint_host(&s.base).ok());
        assert!(r.done && r.request_count == 0 && r.evidence.is_empty());
        assert_eq!(c.slot(), (false, None), "the automatic slot was not taken");
        let run = run_for_window(&c.run, &c.window).unwrap();
        assert!(run.evidence.is_none() && !run.evidence_busy, "an early return clears the busy flag");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(s.accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_round_that_would_exceed_the_lookup_budget_is_not_sent() {
        let mut c = ctx("test-evidence-budget").await;
        let s = server(|_| Duration::ZERO).await;
        let cfg = config(&s.base);
        let cancel = CancelFlag::new();
        let r0 = c.step_with(&cfg, Trigger::Auto, &cancel).await;
        assert_eq!((r0.status, r0.request_count), (EnhanceStatus::Ok, 1), "{r0:?}");
        c.params.budget.max_tokens_per_lookup = r0.estimated_tokens + 1;
        let r1 = c.step_with(&cfg, Trigger::Auto, &cancel).await;
        assert_eq!((r1.stop, r1.request_count, r1.done), (Some(EvidenceStop::Budget), 0, true), "{r1:?}");
        assert_eq!(r1.evidence, r0.evidence);
        assert_eq!(r1.tokens_used, r0.estimated_tokens);
        assert!(r1.estimated_tokens > 1, "the round's estimate is reported: {r1:?}");
        // The round it built, at the hop it attempted; nothing of it was sent.
        assert_eq!((r1.hop, r1.sent_blocks), (1, 0), "{r1:?}");
        assert!(r1.pool_size > 0 && r1.candidates > 0, "{r1:?}");
        assert_eq!((r1.run.requests, r1.run.sent_blocks, r1.run.tokens), (r0.run.requests, r0.run.sent_blocks, r0.run.tokens));
        assert_eq!(s.accepted.load(SeqCst), 1);
        assert!(c.slot().0, "round 0 was sent, so the claim stays");
    }

    #[tokio::test]
    async fn stop_during_round_one_keeps_round_zero_evidence_and_sends_no_more() {
        let c = ctx("test-evidence-stop").await;
        let s = server(|n| if n == 1 { Duration::from_secs(2) } else { Duration::ZERO }).await;
        let cfg = config(&s.base);
        let cancel = cancel_flag(&c.run);
        let r0 = c.step_with(&cfg, Trigger::Auto, &cancel).await;
        assert_eq!(r0.status, EnhanceStatus::Ok, "{r0:?}");
        let canceller = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            canceller.cancel();
        });
        let started = Instant::now();
        let r1 = c.step_with(&cfg, Trigger::Auto, &cancel).await;
        assert!(started.elapsed() < Duration::from_millis(1500), "the stop did not wait for the reply");
        assert_eq!((r1.status, r1.done, r1.request_count), (EnhanceStatus::Cancelled, true, 1), "{r1:?}");
        assert_eq!(r1.evidence, r0.evidence);
        assert_eq!(c.evidence().state.next_hop, 1, "the cancelled round left the state as it was");
        // The automatic rounds ended with the sent, cancelled round: nothing more goes out.
        assert!(c.evidence().auto_ended);
        let again = c.step_with(&cfg, Trigger::Auto, &cancel_flag_for(Trigger::Auto, &c.run)).await;
        assert!(again.done && again.request_count == 0, "{again:?}");
        assert_eq!(again.skip_reason, Some(SkipReason::AutoBudgetUsed));
        assert_eq!(s.accepted.load(SeqCst), 2);
    }

    #[tokio::test]
    async fn local_rows_get_tiers_from_the_latest_score() {
        let c = ctx("test-evidence-local-tiers").await;
        let s = server(|_| Duration::ZERO).await;
        let r = c.step_with(&config(&s.base), Trigger::Auto, &CancelFlag::new()).await;
        let run = run_for_window(&c.run, &c.window).unwrap();
        let q = run.hits.iter().find(|h| h.path == "q.md").expect("q.md is a local hit");
        let tiers: Vec<(&str, Tier)> = r.local_tiers.iter().map(|v| (v.result_id.as_str(), v.tier)).collect();
        assert!(tiers.contains(&(q.result_id.as_str(), Tier::Fit)), "{tiers:?}");
        assert_eq!(r.evidence[0].local_result_id.as_deref(), Some(q.result_id.as_str()));
        // Another tier threshold changes the tier of the same score.
        let mut c = c;
        c.params.tiers.fit = 0.99;
        let again = c.step_with(&config(&s.base), Trigger::Auto, &CancelFlag::new()).await;
        let p = run.hits.iter().find(|h| h.path == "q.md").unwrap();
        assert!(again.local_tiers.iter().any(|v| v.result_id == p.result_id && v.tier == Tier::Unsure), "{again:?}");
    }

    #[tokio::test]
    async fn an_unready_index_is_unavailable_and_a_user_step_needs_no_slot() {
        let f = fixture();
        assert!(ready_reader(&Arc::new(Mutex::new(None)), &f.root).await.unwrap().is_none());
        let other = fixture();
        assert!(ready_reader(&other.index, &f.root).await.unwrap().is_none(), "another vault's index");
        let held = f.index.lock().unwrap();
        assert!(ready_reader(&f.index, &f.root).await.unwrap().is_none(), "a busy index is not waited for");
        drop(held);
        assert!(ready_reader(&f.index, &f.root).await.unwrap().is_some());
        // Review M6: once a reader is cached for the vault, a busy index (a
        // watcher ingest between rounds) no longer makes it unavailable. A
        // parallel test's `forget_readers` can empty the cache between the
        // two calls, so the pair is retried.
        let cached = (0..5).any(|_| {
            let reader = {
                let guard = f.index.lock().unwrap();
                let idx = guard.as_ref().unwrap();
                reader_for(idx.vault_root(), idx.db_path(), &idx.globs_stamp().unwrap()).unwrap()
            };
            let held = f.index.lock().unwrap();
            let got = cached_reader(&f.root);
            drop(held);
            got.is_some_and(|r| Arc::ptr_eq(&r, &reader))
        });
        assert!(cached, "the cached reader is used without the index lock");
        let held = f.index.lock().unwrap();
        let busy = ready_reader(&f.index, &f.root).await.unwrap();
        drop(held);
        assert!(busy.is_some() || cached_reader(&f.root).is_none(), "only a parallel forget makes it unavailable");
        assert_eq!(serde_json::to_value(unavailable()).unwrap()["skipReason"], "indexUnavailable");

        // A user's step on a run whose automatic slot is used still runs.
        let c = ctx("test-evidence-user").await;
        update_run(&c.run, &c.window, |r| r.auto_request_used = true).unwrap();
        let s = server(|_| Duration::ZERO).await;
        let auto = c.step_with(&config(&s.base), Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!(auto.skip_reason, Some(SkipReason::AutoBudgetUsed));
        let user = c.step_with(&config(&s.base), Trigger::User, &CancelFlag::new()).await;
        assert_eq!((user.status, user.request_count), (EnhanceStatus::Ok, 1), "{user:?}");
        assert!(!c.evidence().auto_claimed);
    }

    #[test]
    fn a_recreated_database_gets_a_fresh_reader_and_forget_drops_them() {
        use searchidx::sag::Level;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "alpha\n").unwrap();
        let db = dir.path().join("i.db");
        let build = || {
            let mut idx = searchidx::SearchIndex::open_at(&root, &db, "s").unwrap();
            idx.sweep(&searchidx::ScanOptions::default(), None).unwrap();
        };
        build();
        let first = reader_for(&root, &db, "s").unwrap();
        assert!(Arc::ptr_eq(&first, &reader_for(&root, &db, "s").unwrap()), "one reader per index");
        let before = first.block_count(Level::Line).unwrap();
        // A wipe: the old file leaves the path (still open by the reader, as
        // an unlinked file would be) and a new index is built there.
        for suffix in ["", "-wal", "-shm"] {
            let from = dir.path().join(format!("i.db{suffix}"));
            if from.exists() {
                std::fs::rename(&from, dir.path().join(format!("old.db{suffix}"))).unwrap();
            }
        }
        std::fs::write(root.join("b.md"), "beta\n").unwrap();
        build();
        let fresh = reader_for(&root, &db, "s").unwrap();
        assert!(!Arc::ptr_eq(&first, &fresh), "a recreated file gets a new reader");
        assert!(fresh.block_count(Level::Line).unwrap() > before, "the new reader sees the new file");
        forget_readers();
        assert!(!Arc::ptr_eq(&fresh, &reader_for(&root, &db, "s").unwrap()), "forgotten readers are reopened");
    }

    #[tokio::test]
    async fn user_started_rounds_do_not_continue_automatically() {
        let c = ctx("test-evidence-user-started").await;
        let s = server(|_| Duration::ZERO).await;
        let cfg = config(&s.base);
        let r0 = c.step_with(&cfg, Trigger::User, &CancelFlag::new()).await;
        assert_eq!((r0.status, r0.request_count), (EnhanceStatus::Ok, 1), "{r0:?}");
        let auto = c.step_with(&cfg, Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!((auto.skip_reason, auto.request_count, auto.done), (Some(SkipReason::AutoBudgetUsed), 0, true), "{auto:?}");
        assert_eq!(s.accepted.load(SeqCst), 1);
        assert_eq!(c.slot(), (false, None), "the refused call took no slot");
        let user = c.step_with(&cfg, Trigger::User, &CancelFlag::new()).await;
        assert_eq!((user.status, user.hop, user.request_count), (EnhanceStatus::Ok, 1, 1), "{user:?}");
    }

    #[tokio::test]
    async fn an_automatic_round_that_failed_after_sending_ends_the_automatic_rounds() {
        let mut c = ctx("test-evidence-auto-ended").await;
        c.params.retrieval.round_timeout_ms = 300;
        let s = server(|n| if n == 1 { Duration::from_secs(2) } else { Duration::ZERO }).await;
        let cfg = config(&s.base);
        let r0 = c.step_with(&cfg, Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!(r0.status, EnhanceStatus::Ok, "{r0:?}");
        let r1 = c.step_with(&cfg, Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!((r1.status, r1.request_count), (EnhanceStatus::Timeout, 1), "{r1:?}");
        assert!(c.evidence().auto_ended);
        let retry = c.step_with(&cfg, Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!((retry.skip_reason, retry.request_count), (Some(SkipReason::AutoBudgetUsed), 0), "{retry:?}");
        assert_eq!(s.accepted.load(SeqCst), 2);
        let user = c.step_with(&cfg, Trigger::User, &CancelFlag::new()).await;
        assert_eq!((user.status, user.hop, user.request_count), (EnhanceStatus::Ok, 1, 1), "{user:?}");
        assert_eq!(s.accepted.load(SeqCst), 3);
    }

    #[tokio::test]
    async fn a_second_step_while_one_runs_sends_nothing() {
        let c = ctx("test-evidence-busy").await;
        let s = server(|n| if n == 0 { Duration::from_millis(300) } else { Duration::ZERO }).await;
        let cfg = config(&s.base);
        let (one, two) = (CancelFlag::new(), CancelFlag::new());
        let (first, second) =
            tokio::join!(c.step_with(&cfg, Trigger::Auto, &one), c.step_with(&cfg, Trigger::User, &two));
        assert_eq!((first.status, first.request_count), (EnhanceStatus::Ok, 1), "{first:?}");
        assert_eq!((second.status, second.skip_reason, second.request_count), (EnhanceStatus::Skipped, Some(SkipReason::RoundRunning), 0));
        assert_eq!(serde_json::to_value(&second).unwrap()["skipReason"], "roundRunning");
        assert!(!second.done, "the rounds may go on: {second:?}");
        assert_eq!(s.accepted.load(SeqCst), 1);
        assert!(!run_for_window(&c.run, &c.window).unwrap().evidence_busy, "the guard is cleared");
        let next = c.step_with(&cfg, Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!((next.hop, next.request_count), (1, 1), "{next:?}");
    }

    #[tokio::test]
    async fn max_hops_zero_ends_after_round_zero() {
        let mut c = ctx("test-evidence-hops0").await;
        c.params.retrieval.max_hops = 0;
        let s = server(|_| Duration::ZERO).await;
        let r = c.step_with(&config(&s.base), Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!((r.status, r.hop, r.done, r.stop, r.request_count), (EnhanceStatus::Ok, 0, true, Some(EvidenceStop::MaxHops), 1));
        let again = c.step_with(&config(&s.base), Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!((again.request_count, again.stop), (0, Some(EvidenceStop::MaxHops)));
        assert_eq!(s.accepted.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn the_direct_match_preset_asks_the_criterion_with_the_judge_criteria() {
        let mut c = ctx("test-evidence-direct").await;
        c.params.judge.preset = Preset::DirectMatch;
        c.params.judge.criterion = "只看决定。".into();
        let s = server(|_| Duration::ZERO).await;
        let r = c.step_with(&config(&s.base), Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!(r.status, EnhanceStatus::Ok, "{r:?}");
        let body = s.bodies.lock().unwrap()[0].clone();
        assert!(body.contains("只看决定。") && body.contains(super::super::judge::CRITERIA_TRUE), "{body}");
        assert!(!body.contains(super::super::sag::CRITERION), "{body}");
    }

    #[tokio::test]
    async fn evidence_too_large_sends_nothing_and_gives_the_slot_back() {
        let mut c = ctx("test-evidence-too-large").await;
        c.params.retrieval.jev_context_tokens = 100;
        let s = server(|_| Duration::ZERO).await;
        let r = c.step_with(&config(&s.base), Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!((r.status, r.stop, r.request_count, r.done), (EnhanceStatus::Skipped, Some(EvidenceStop::EvidenceTooLarge), 0, true), "{r:?}");
        assert_eq!(c.slot(), (false, None));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(s.accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn an_automatic_first_round_that_sends_nothing_gives_the_slot_back() {
        let c = ctx("test-evidence-release").await;
        let s = server(|_| Duration::ZERO).await;
        let cancel = CancelFlag::new();
        cancel.cancel();
        let r = c.step_with(&config(&s.base), Trigger::Auto, &cancel).await;
        assert_eq!((r.status, r.request_count, r.done), (EnhanceStatus::Cancelled, 0, true), "{r:?}");
        assert_eq!(c.slot(), (false, None));
        assert!(!c.evidence().auto_claimed);
        // The retry claims again and is sent.
        let retry = c.step_with(&config(&s.base), Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!((retry.status, retry.request_count), (EnhanceStatus::Ok, 1), "{retry:?}");
        assert!(c.slot().0 && c.evidence().auto_claimed);
    }

    #[tokio::test]
    async fn the_wire_result_uses_the_ts_field_names() {
        let c = ctx("test-evidence-wire").await;
        let s = server(|_| Duration::ZERO).await;
        let r = c.step_with(&config(&s.base), Trigger::Auto, &CancelFlag::new()).await;
        let v = serde_json::to_value(&r).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut want = [
            "status", "stop", "skipReason", "missing", "endpointHost", "statusClass", "hop", "terms", "evidence",
            "localTiers", "done", "requestCount", "poolSize", "candidates", "sentBlocks", "skippedConfidential",
            "skippedStale", "skippedLong", "skippedOversize", "estimatedTokens", "tokensUsed", "usage", "elapsedMs",
            "nextHop", "run",
        ];
        want.sort_unstable();
        assert_eq!(keys, want);
        let item = v["evidence"][0].as_object().unwrap();
        let mut item_keys: Vec<&str> = item.keys().map(String::as_str).collect();
        item_keys.sort_unstable();
        assert_eq!(
            item_keys,
            ["absPath", "breadcrumb", "evidenceId", "foundRound", "line", "lineEnd", "localResultId", "path", "text", "tier", "title"]
        );
        assert_eq!(item["absPath"], c.f.root.join("q.md").to_string_lossy().as_ref());
        let mut run_keys: Vec<&str> = v["run"].as_object().unwrap().keys().map(String::as_str).collect();
        run_keys.sort_unstable();
        let run_want = [
            "elapsedMs", "endpointHost", "requests", "sentBlocks", "skippedConfidential", "skippedLong", "skippedOversize",
            "skippedStale", "tokens",
        ];
        assert_eq!(run_keys, run_want);
        // The TS type (Task 10) has every field, `candidates` included.
        const API: &str = include_str!("../../../src/lib/smart-search/api.ts");
        let ts = &API[API.find("export interface EvidenceStepResult").unwrap()..];
        let ts = &ts[..ts.find("\n}").unwrap()];
        for key in want {
            assert!(ts.contains(&format!("{key}:")), "{key} missing from the TS EvidenceStepResult");
        }
        let ts = &API[API.find("export interface EvidenceRunTotals").unwrap()..];
        let ts = &ts[..ts.find("\n}").unwrap()];
        for key in run_want {
            assert!(ts.contains(&format!("{key}:")), "{key} missing from the TS EvidenceRunTotals");
        }
        let ts = &API[API.find("export interface EvidenceItem ").unwrap()..];
        assert!(ts[..ts.find("\n}").unwrap()].contains("absPath:"), "absPath missing from the TS EvidenceItem");
    }

    /// Final-wave item 6: a stop between rounds at hop ≥ 1, before the next
    /// round sends anything.
    #[tokio::test]
    async fn a_cancel_between_rounds_at_hop_one_sends_nothing_and_keeps_the_run() {
        let c = ctx("test-evidence-cancel-between").await;
        let s = server(|_| Duration::ZERO).await;
        let cfg = config(&s.base);
        let r0 = c.step_with(&cfg, Trigger::Auto, &CancelFlag::new()).await;
        assert_eq!((r0.status, r0.request_count, r0.next_hop), (EnhanceStatus::Ok, 1, 1), "{r0:?}");
        let cancel = CancelFlag::new();
        cancel.cancel();
        let r1 = c.step_with(&cfg, Trigger::Auto, &cancel).await;
        assert_eq!((r1.status, r1.request_count, r1.done, r1.hop, r1.next_hop), (EnhanceStatus::Cancelled, 0, true, 1, 1), "{r1:?}");
        assert_eq!(r1.evidence, r0.evidence);
        assert_eq!((r1.sent_blocks, r1.estimated_tokens), (0, 0));
        assert_eq!((r1.run.requests, r1.run.sent_blocks, r1.run.tokens), (1, r0.sent_blocks, r0.tokens_used));
        let e = c.evidence();
        assert_eq!(e.state.next_hop, 1, "the state is as round 0 left it");
        assert!(e.auto_claimed && !e.auto_ended, "nothing was sent, so the automatic rounds did not end");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(s.accepted.load(SeqCst), 1);
    }

    /// Ruling (final review, I2): a stop during round 0 still reports what
    /// went out, in the run's totals, and a later call reports the same.
    #[tokio::test]
    async fn run_totals_include_a_cancelled_round_and_stay_distinct() {
        let c = ctx("test-evidence-run-totals").await;
        let s = server(|n| if n == 0 { Duration::from_secs(2) } else { Duration::ZERO }).await;
        let cfg = config(&s.base);
        let cancel = cancel_flag(&c.run);
        let canceller = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            canceller.cancel();
        });
        let r0 = c.step_with(&cfg, Trigger::User, &cancel).await;
        assert_eq!((r0.status, r0.request_count, r0.hop, r0.next_hop), (EnhanceStatus::Cancelled, 1, 0, 0), "{r0:?}");
        assert!(r0.evidence.is_empty());
        assert!(r0.sent_blocks > 0 && r0.pool_size == r0.sent_blocks && r0.candidates > 0, "review M3: {r0:?}");
        let host = endpoint_host(&s.base).ok();
        assert_eq!(r0.run.endpoint_host, host);
        assert_eq!((r0.run.requests, r0.run.sent_blocks, r0.run.tokens), (1, r0.sent_blocks, r0.estimated_tokens));
        assert!(r0.run.elapsed_ms >= 100, "{r0:?}");
        // The user starts again: round 0 is sent again; the passages are the
        // same blocks, so the run's distinct count does not double.
        let again = c.step_with(&cfg, Trigger::User, &CancelFlag::new()).await;
        assert_eq!((again.status, again.hop, again.next_hop), (EnhanceStatus::Ok, 0, 1), "{again:?}");
        assert_eq!(again.run.requests, 2);
        assert_eq!(again.run.sent_blocks, r0.sent_blocks);
        assert_eq!(again.run.tokens, r0.estimated_tokens + again.estimated_tokens);
        assert!(again.run.elapsed_ms >= r0.run.elapsed_ms);
        let r1 = c.step_with(&cfg, Trigger::User, &CancelFlag::new()).await;
        assert_eq!((r1.status, r1.hop), (EnhanceStatus::Ok, 1), "{r1:?}");
        assert_eq!(r1.run.skipped_confidential, 1, "secret.md, once however often it returns: {r1:?}");
        // A call refused before any round still carries the run's totals.
        let refused = c.step_with(&JevRequestConfig { consent_host: "other.example".into(), ..cfg.clone() }, Trigger::User, &CancelFlag::new()).await;
        assert_eq!(refused.status, EnhanceStatus::NoConsent);
        assert_eq!((refused.run.clone(), refused.next_hop), (EvidenceRunTotals { elapsed_ms: r1.run.elapsed_ms, ..r1.run.clone() }, 2));
        let wire = serde_json::to_value(&refused).unwrap();
        assert_eq!(wire["run"]["requests"], 3);
        assert_eq!(wire["nextHop"], 2);
    }

    /// Review M2: the evidence repeated in `state` is sent with the pool, so
    /// it is counted and recorded once, after the pool.
    #[tokio::test]
    async fn sent_blocks_are_the_union_of_the_pool_and_the_state_evidence() {
        let s = server(|_| Duration::ZERO).await;
        let block = |id: i64, path: &str, text: &str| SagCandidate {
            id,
            path: path.into(),
            line: 1,
            line_end: 1,
            title: path.trim_end_matches(".md").into(),
            heading: String::new(),
            content: text.into(),
            bm25: 0.,
            score: 0.5,
            previous_score: Some(0.5),
            order: 0,
        };
        let mut scorer = JevScorer {
            client: enhance_client().unwrap(),
            jev: gate_jev(&config(&s.base), None).ok().expect("configured"),
            key: None,
            preset: Preset::Sag2V10,
            criterion: String::new(),
            context_tokens: 32_000,
            cjk: 1,
            other: 4,
            deadline: Duration::from_secs(5),
            budget: 200_000,
            tokens_used: 0,
            cancel: Arc::new(CancelFlag::new()),
            requests: 0,
            estimated: 0,
            built: None,
            sent_ids: BTreeSet::new(),
            oversize: BTreeSet::new(),
            usage: None,
            sent: vec![],
        };
        let pool = vec![block(1, "a.md", "alpha"), block(2, "b.md", "beta")];
        let evidence = vec![block(2, "b.md", "beta"), block(3, "c.md", "gamma")];
        let state = super::super::sag::jev::encode_state("q", &evidence, &StateExtras::default());
        scorer.score(pool, evidence, state).await.unwrap();
        assert_eq!(scorer.requests, 1);
        assert_eq!(scorer.sent_ids, BTreeSet::from([1, 2, 3]));
        let sent: Vec<&str> = scorer.sent.iter().map(|(p, _, _)| p.as_str()).collect();
        assert_eq!(sent, ["a.md", "b.md", "c.md"]);
    }

    #[test]
    fn the_step_future_is_send() {
        fn assert_send<T: Send>(_: T) {}
        let f = fixture();
        let reader = {
            let guard = f.index.lock().unwrap();
            let idx = guard.as_ref().unwrap();
            reader_for(idx.vault_root(), idx.db_path(), &idx.globs_stamp().unwrap()).unwrap()
        };
        let cfg = config("http://127.0.0.1:9/v1");
        let params = LookupParams::default();
        let request = EvidenceRequest {
            run_id: "x",
            window_label: "w",
            vault_root: &f.root,
            config: &cfg,
            key: None,
            trigger: Trigger::User,
            deep: false,
            params: &params,
            reader,
        };
        let (client, cancel) = (enhance_client().unwrap(), CancelFlag::new());
        assert_send(evidence_step(request, &client, &cancel));
    }

    #[test]
    fn window_mode_moves_the_time_phrase_into_the_filters() {
        use crate::smart_lookup::RunTime;
        let f = fixture();
        let id = lookup(&f, "test-evidence-time", &LookupParams::default());
        let mut run = run_for_window(&id, "test-evidence-time").unwrap();
        run.question = "tag:work 上周 发布 风险".into();
        run.time = Some(RunTime {
            source_text: "上周".into(),
            after: chrono::NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
            before: chrono::NaiveDate::from_ymd_opt(2026, 11, 8).unwrap(),
            mode: TimeMode::Window,
            in_window: 0,
        });
        let (text, filters) = lookup_query(&run);
        assert_eq!(text, "发布 风险");
        assert_eq!((filters.tags.as_slice(), filters.after.as_deref(), filters.before.as_deref()), (&["work".to_string()][..], Some("2026-11-02"), Some("2026-11-08")));
        assert!(filters.terms.is_empty() && filters.phrases.is_empty());
        let extras = state_extras(&run);
        assert_eq!(extras.explicit_filters, ["tag:work"]);
        assert_eq!(extras.time_range.as_ref().map(|t| t.source_text.as_str()), Some("上周"));
        // Group mode keeps the phrase in the text and sends the range; ignore sends no range.
        run.time.as_mut().unwrap().mode = TimeMode::Group;
        assert_eq!(lookup_query(&run).0, "上周 发布 风险");
        assert!(lookup_query(&run).1.after.is_none());
        run.time.as_mut().unwrap().mode = TimeMode::Ignore;
        assert!(state_extras(&run).time_range.is_none());
    }
}
