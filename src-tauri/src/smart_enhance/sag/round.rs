// Ported from SAG-Wiki 61f63c6 `core/src/retrieval.rs` (retrieve_inner), MIT License,
// Copyright (c) 2026 sag contributors. Changes for note.md: see spec Appendix H.

//! The SAG2 round state machine (spec H.3.1–H.3.11): `retrieve_inner`'s
//! preparation as [`EvidenceState::start`], one iteration of its loop body as
//! [`EvidenceState::step`], and its final diversify-and-truncate as
//! [`EvidenceState::evidence`]. [`ReaderIndex`] is the index side: line-level
//! candidates after the H.3.3 source check, existence probes, counts and the
//! alias table, all on the read-only [`SagReader`].
//!
//! Each `step` runs exactly one hop. Its changes are made on a copy and kept
//! only when the round was scored and neither a cancel nor an index commit
//! landed meanwhile, so a failed, cancelled or outdated round leaves the state
//! as it was before the call (spec H.3.7, H.3.8; pre-flight D3).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use indexmap::IndexMap;
use searchidx::query::Query;
use searchidx::sag::{CandidateQuery, Level, SagReader};
use serde::{Deserialize, Serialize};

use super::corpus::{diversify, diversity_idf, AliasMap};
use super::jev::{encode_state, RoundError, StateExtras};
use super::terms::{expansion_terms, interleave, rank, TermStats};
use super::text::{match_query, quote};
use super::{SagCandidate, Term, Trace, HOP2_EVIDENCE, HOP2_INCOMING};
use crate::smart_enhance::candidates::title_of;
use crate::smart_enhance::CancelFlag;
use crate::smart_lookup::{current_block, CanonicalHit};

/// Why the rounds ended (spec H.3.2–H.3.11, H.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EvidenceStop {
    /// The question has no search terms (H.3.2); nothing is sent.
    NoTerms,
    /// Every retained result was already expanded (`hop > 0 && frontier.is_empty()`).
    FrontierEmpty,
    /// The seeds gave no expansion terms.
    TermsEmpty,
    /// The round's query found nothing new.
    CandidatesEmpty,
    /// `next_hop > maxHops` (H.3.8).
    MaxHops,
    /// The lookup's token budget would be exceeded (H.6; decided by the scorer).
    Budget,
    /// The index generation moved (H.3.11).
    IndexChanged,
    /// The evidence alone exceeds the Jev context (H.3.7; decided by the scorer).
    EvidenceTooLarge,
}

/// Distinct blocks dropped by the H.3.3 source check over the life of a
/// [`ReaderIndex`]: a block returned by several term lists or rounds counts once.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Skipped {
    pub confidential: usize,
    pub stale: usize,
    pub long: usize,
}

/// The index as the round state machine sees it. `Sync` so the step future
/// is `Send` and the per-term queries can run on scoped threads (P8).
pub(crate) trait SagIndex: Sync {
    /// The index generation (H.3.11).
    fn generation(&self) -> Result<i64, String>;
    /// Counts at `level`: `total` is the block count, `df` the frequencies.
    fn stats(&self, level: Level) -> &dyn TermStats;
    /// Line-level candidates for `expression` (and `required`), after the
    /// H.3.3 source check; `order` is the SQL row number, gaps included.
    fn candidates(
        &self,
        expression: &str,
        required: Option<&str>,
        excluded: &[i64],
        limit: usize,
    ) -> Result<Vec<SagCandidate>, String>;
    /// Whether any line-level block outside `excluded` matches `expression`
    /// (already quoted) under the lookup's filters.
    fn has_hits(&self, expression: &str, excluded: &[i64]) -> Result<bool, String>;
    /// The alias table of the current generation (H.3.1).
    fn aliases(&self) -> Result<Arc<AliasMap>, String>;
    /// Distinct blocks dropped so far by the source check.
    fn skipped(&self) -> Skipped;
}

/// Scores one round's pool. Batching, the budget check and the requests live
/// in the implementation (Task 8); `step` only builds the pool, the evidence
/// and the `state` string and keeps the books. A round the scorer will not
/// send (`Budget`, `EvidenceTooLarge`) comes back as `RoundError::Stop`.
pub(crate) trait Scorer {
    fn score(
        &mut self,
        pool: Vec<SagCandidate>,
        evidence: Vec<SagCandidate>,
        state: String,
    ) -> impl Future<Output = Result<Vec<SagCandidate>, RoundError>> + Send;
}

/// `protocol/src/types.rs:Retrieval`, the fields the rounds read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RoundSettings {
    pub candidate_k: usize,
    pub seed_k: usize,
    pub term_limit: usize,
    pub max_hops: u8,
    pub top_k: usize,
    pub protected_k: usize,
}

/// The locals of `retrieve_inner`, kept between calls (spec H.3.8).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EvidenceState {
    /// Recorded by `start`; every round compares against it.
    pub generation: i64,
    /// The unrepaired question (`free_text`): `original_question` and the
    /// query of `expansion_terms`.
    pub query: String,
    /// `match_query(repair(query))`.
    pub expression: String,
    pub next_hop: u8,
    pub retained: Vec<SagCandidate>,
    pub frontier: Vec<SagCandidate>,
    pub expanded: BTreeSet<i64>,
    pub seen: BTreeSet<i64>,
    pub carried: IndexMap<i64, SagCandidate>,
    pub protected: IndexMap<i64, SagCandidate>,
    pub latest: IndexMap<i64, SagCandidate>,
    pub trace: Vec<Trace>,
    /// Block id → the hop in which it first was a candidate.
    pub found_round: BTreeMap<i64, u8>,
    pub stop: Option<EvidenceStop>,
    /// Estimated tokens sent so far; kept by the caller's scorer (H.6).
    pub tokens_used: u64,
    pub settings: RoundSettings,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum StepOutcome {
    /// Hop `hop` was scored and its results kept. `next_hop` may now exceed
    /// `max_hops`; the next call reports that as `Stopped(MaxHops)` (P14).
    Scored { hop: u8, terms: Vec<Term>, pool_size: usize },
    Stopped(EvidenceStop),
    /// Scoring failed or was cancelled; the state is unchanged. A scorer's
    /// `RoundError::Stop` is reported as `Stopped` instead.
    Failed(RoundError),
}

impl EvidenceState {
    /// `retrieve_inner` up to the loop (spec H.3.1–H.3.2): the generation,
    /// the alias repair and the round-0 expression. An empty expression stops
    /// with `NoTerms` before anything is sent.
    pub(crate) fn start(index: &dyn SagIndex, question_free_text: &str, settings: RoundSettings) -> Result<Self, String> {
        if settings.max_hops > 2 {
            return Err("SAG2 V10 最多扩展两轮".into());
        }
        let generation = index.generation()?;
        let aliases = index.aliases()?;
        let repaired = aliases.repair(question_free_text, &mut |expression| index.has_hits(expression, &[]))?;
        let expression = match_query(&repaired);
        Ok(Self {
            generation,
            query: question_free_text.to_owned(),
            stop: expression.is_empty().then_some(EvidenceStop::NoTerms),
            expression,
            next_hop: 0,
            retained: vec![],
            frontier: vec![],
            expanded: BTreeSet::new(),
            seen: BTreeSet::new(),
            carried: IndexMap::new(),
            protected: IndexMap::new(),
            latest: IndexMap::new(),
            trace: vec![],
            found_round: BTreeMap::new(),
            tokens_used: 0,
            settings,
        })
    }

    fn stopped(&mut self, stop: EvidenceStop) -> StepOutcome {
        self.stop = Some(stop);
        StepOutcome::Stopped(stop)
    }

    /// One iteration of `retrieve_inner`'s loop, line by line (spec
    /// H.3.4–H.3.8). An `Err` is an index failure; the state is unchanged.
    pub(crate) async fn step<S: Scorer>(
        &mut self,
        index: &dyn SagIndex,
        scorer: &mut S,
        extras: &StateExtras,
        cancel: &CancelFlag,
    ) -> Result<StepOutcome, String> {
        if let Some(stop) = self.stop {
            return Ok(StepOutcome::Stopped(stop));
        }
        let settings = self.settings;
        let hop = self.next_hop;
        // The `for hop in 0..=max_hops` bound.
        if hop > settings.max_hops {
            return Ok(self.stopped(EvidenceStop::MaxHops));
        }
        if cancel.is_cancelled() {
            return Ok(StepOutcome::Failed(RoundError::Cancelled));
        }
        if index.generation()? != self.generation {
            return Ok(self.stopped(EvidenceStop::IndexChanged));
        }
        if hop > 0 && self.frontier.is_empty() {
            return Ok(self.stopped(EvidenceStop::FrontierEmpty));
        }
        let aliases = index.aliases()?;
        let mut terms = if hop > 0 {
            expansion_terms(&self.query, &self.frontier, settings.term_limit, aliases.pattern(), index.stats(Level::Line))?
        } else {
            vec![]
        };
        if hop > 0 && terms.is_empty() {
            return Ok(self.stopped(EvidenceStop::TermsEmpty));
        }
        let excluded: Vec<i64> = self.seen.iter().copied().collect();
        aliases.resolve_terms(&mut terms, &mut |expression| index.has_hits(expression, &excluded))?;
        let mut next = self.clone();
        let candidates = if hop == 0 {
            let hits = index.candidates(&self.expression, None, &excluded, settings.candidate_k)?;
            for c in hits.iter().take(settings.protected_k) {
                next.protected.insert(c.id, c.clone());
            }
            hits
        } else {
            // Every FTS string is the term's phrase, inner stop words kept
            // (spec H.3.5; ruling I1).
            let required: Vec<String> = terms.iter().map(|t| quote(&t.phrase)).collect();
            let ranking = format!("{} OR ({})", required.join(" OR "), self.expression);
            let lists = candidate_lists(index, &ranking, &required, &excluded, settings.candidate_k)?;
            interleave(lists, settings.candidate_k)
        };
        if candidates.is_empty() {
            // SAG2 breaks before its trace entry; the round's terms are kept
            // in ours so the window and the evaluation can show them.
            self.trace.push(Trace { hop, candidates: vec![], terms, evidence: vec![] });
            return Ok(self.stopped(EvidenceStop::CandidatesEmpty));
        }
        for c in &candidates {
            next.found_round.entry(c.id).or_insert(hop);
        }
        for c in &self.frontier {
            next.carried.insert(c.id, c.clone());
        }
        let mut pool: IndexMap<i64, SagCandidate> = IndexMap::new();
        if hop > 0 {
            pool.extend(next.protected.iter().map(|(id, c)| (*id, c.clone())));
            pool.extend(next.carried.iter().map(|(id, c)| (*id, c.clone())));
        }
        pool.extend(candidates.iter().map(|c| (c.id, c.clone())));
        let mut evidence: Vec<SagCandidate> = if hop > 0 {
            let mut e = next.carried.clone();
            e.extend(candidates.iter().take(settings.seed_k).map(|c| (c.id, c.clone())));
            e.into_values().collect()
        } else {
            vec![]
        };
        if hop == 2 {
            let count = pool.len();
            let latest = &next.latest;
            let mut history: IndexMap<i64, SagCandidate> =
                pool.iter().filter(|(id, _)| latest.contains_key(*id)).map(|(id, c)| (*id, c.clone())).collect();
            let incoming: Vec<SagCandidate> =
                pool.values().filter(|c| !latest.contains_key(&c.id)).take(HOP2_INCOMING).cloned().collect();
            let mut previous: Vec<SagCandidate> = latest.values().cloned().collect();
            previous.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
            history.extend(previous.into_iter().map(|c| (c.id, c)));
            pool = history
                .into_iter()
                .take(count - incoming.len())
                .chain(incoming.into_iter().map(|c| (c.id, c)))
                .collect();
            evidence = next
                .retained
                .iter()
                .take(HOP2_EVIDENCE)
                .cloned()
                .map(|mut c| {
                    c.previous_score = Some(c.score);
                    c
                })
                .collect();
        }
        next.trace.push(Trace {
            hop,
            candidates: candidates.iter().map(|c| c.id).collect(),
            terms: terms.clone(),
            evidence: evidence.iter().map(|c| c.id).collect(),
        });
        let state = encode_state(&self.query, &evidence, extras);
        let pool: Vec<SagCandidate> = pool.into_values().collect();
        let pool_size = pool.len();
        let scored = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(StepOutcome::Failed(RoundError::Cancelled)),
            scored = scorer.score(pool, evidence, state) => scored,
        };
        let scored = match scored {
            Ok(scored) => scored,
            // Not sent (budget, evidence too large): the round is discarded
            // and the rounds end.
            Err(RoundError::Stop(stop)) => return Ok(self.stopped(stop)),
            Err(error) => return Ok(StepOutcome::Failed(error)),
        };
        next.retained = rank(scored);
        next.latest.extend(next.retained.iter().map(|c| (c.id, c.clone())));
        // D3: a cancel or a commit after scoring throws the round away, as
        // SAG2 bails here.
        if cancel.is_cancelled() {
            return Ok(StepOutcome::Failed(RoundError::Cancelled));
        }
        if index.generation()? != self.generation {
            return Ok(self.stopped(EvidenceStop::IndexChanged));
        }
        next.seen.extend(next.retained.iter().map(|c| c.id));
        next.frontier =
            next.retained.iter().filter(|c| !next.expanded.contains(&c.id)).take(settings.seed_k).cloned().collect();
        next.expanded.extend(next.frontier.iter().map(|c| c.id));
        next.next_hop = hop + 1;
        *self = next;
        Ok(StepOutcome::Scored { hop, terms, pool_size })
    }

    /// The end of `retrieve_inner` on a copy (spec H.3.9–H.3.10):
    /// `diversify(retained)` truncated to `min(top_k, candidate_k)`, what SAG2
    /// would return if the rounds stopped now. `retained` itself is untouched.
    /// Passages are vectorised with the index tokenizer and weighted by the
    /// file-level idf.
    pub(crate) fn evidence(&self, index: &dyn SagIndex) -> Result<Vec<SagCandidate>, String> {
        let mut list = self.retained.clone();
        if !list.is_empty() {
            let n = list.len().min(10);
            let vocabulary: BTreeSet<String> =
                list[..n].iter().flat_map(|c| searchidx::tokenize::tokens(&c.content)).collect();
            let stats = index.stats(Level::File);
            let documents = stats.total()? as u64;
            let df = stats.df(&vocabulary.into_iter().collect::<Vec<_>>())?;
            diversify(&mut list, &searchidx::tokenize::tokens, &|token| {
                diversity_idf(documents, df.get(token).copied().unwrap_or(0))
            });
        }
        list.truncate(self.settings.top_k.min(self.settings.candidate_k));
        Ok(list)
    }
}

/// `store.rs:candidate_queries`: one query per required term, each ranked by
/// the shared `ranking` expression, run in parallel; the lists come back in
/// term order.
fn candidate_lists(
    index: &dyn SagIndex,
    ranking: &str,
    required: &[String],
    excluded: &[i64],
    limit: usize,
) -> Result<Vec<Vec<SagCandidate>>, String> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = required
            .iter()
            .map(|r| scope.spawn(move || index.candidates(ranking, Some(r), excluded, limit)))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().map_err(|_| "SAG2 candidate query panicked".to_string())?)
            .collect()
    })
}

/// [`TermStats`] over one level of a [`SagReader`].
struct ReaderStats {
    reader: Arc<SagReader>,
    level: Level,
}

impl TermStats for ReaderStats {
    fn total(&self) -> Result<f64, String> {
        Ok(self.reader.block_count(self.level)? as f64)
    }
    /// A count for every requested term, zeros included (`SagReader::frequencies`).
    fn df(&self, terms: &[String]) -> Result<HashMap<String, u64>, String> {
        self.reader.frequencies(terms, self.level)
    }
}

/// One alias table per reader and index generation, shared by every lookup
/// on that reader: compiling the alias pattern can take seconds on a large
/// vault, so it is never built per lookup (spec H.3.1). A dropped reader's
/// entry is never matched again (its `Weak` no longer upgrades).
static ALIAS_CACHE: Mutex<Vec<(Weak<SagReader>, i64, Arc<AliasMap>)>> = Mutex::new(Vec::new());

/// [`SagIndex`] on a [`SagReader`] for one lookup: its explicit filters, the
/// vault root for the source check, and the passage length limit.
pub(crate) struct ReaderIndex {
    reader: Arc<SagReader>,
    root: PathBuf,
    filters: Query,
    max_block_chars: usize,
    line: ReaderStats,
    file: ReaderStats,
    /// Ids of the blocks dropped, per reason (H.5 「跳过数照实返回」).
    confidential: Mutex<BTreeSet<i64>>,
    stale: Mutex<BTreeSet<i64>>,
    long: Mutex<BTreeSet<i64>>,
}

impl ReaderIndex {
    pub(crate) fn new(reader: Arc<SagReader>, root: PathBuf, filters: Query, max_block_chars: usize) -> Self {
        Self {
            line: ReaderStats { reader: reader.clone(), level: Level::Line },
            file: ReaderStats { reader: reader.clone(), level: Level::File },
            reader,
            root,
            filters,
            max_block_chars,
            confidential: Mutex::default(),
            stale: Mutex::default(),
            long: Mutex::default(),
        }
    }

    /// The alias table from the index's titles and wiki targets plus the
    /// frontmatter `aliases` of the markdown files (spec H.3.1). A title that
    /// is missing or empty falls back to the file name without its extension.
    /// Confidential files contribute too: aliases only steer what is searched
    /// here, and confidential passages are dropped in `candidates`.
    fn build_aliases(&self) -> Result<AliasMap, String> {
        let sources = self.reader.alias_sources()?;
        let title_of_file = |path: &str, title: &Option<String>| match title {
            Some(t) if !t.is_empty() => t.clone(),
            _ => Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        };
        let titles: Vec<String> = sources.files.iter().map(|f| title_of_file(&f.path, &f.title)).collect();
        let by_path: HashMap<&str, &str> =
            sources.files.iter().zip(&titles).map(|(f, t)| (f.path.as_str(), t.as_str())).collect();
        let md: Vec<String> = sources.files.iter().filter(|f| f.ext == "md").map(|f| f.path.clone()).collect();
        let mut pairs = vec![];
        for (path, aliases) in searchidx::sag::frontmatter_aliases(&self.root, &md) {
            if let Some(title) = by_path.get(path.as_str()) {
                pairs.extend(aliases.into_iter().map(|a| (a, title.to_string())));
            }
        }
        Ok(AliasMap::build(&titles, &pairs, &sources.wiki_targets))
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl SagIndex for ReaderIndex {
    fn generation(&self) -> Result<i64, String> {
        self.reader.generation()
    }

    fn stats(&self, level: Level) -> &dyn TermStats {
        match level {
            Level::Line => &self.line,
            Level::File => &self.file,
        }
    }

    /// `SagReader::candidate_query`, then the H.3.3 source check in order:
    /// the file is `unknown` or `explicitly_public` (read in one batch; a
    /// failed read fails the call), `current_block` still reads the indexed
    /// text, and the text is at most `max_block_chars` characters. Dropped
    /// rows keep their row number out of `order`.
    fn candidates(
        &self,
        expression: &str,
        required: Option<&str>,
        excluded: &[i64],
        limit: usize,
    ) -> Result<Vec<SagCandidate>, String> {
        let rows = self.reader.candidate_query(&CandidateQuery {
            expression,
            required,
            filters: &self.filters,
            excluded,
            limit,
        })?;
        if rows.is_empty() {
            return Ok(vec![]);
        }
        let paths: BTreeSet<&str> = rows.iter().map(|r| r.path.as_str()).collect();
        let confidentiality = self.reader.confidentiality_for_paths(&paths.into_iter().collect::<Vec<_>>())?;
        let mut out = Vec::with_capacity(rows.len());
        for (order, row) in rows.into_iter().enumerate() {
            if !matches!(confidentiality.get(&row.path).map(String::as_str), Some("unknown" | "explicitly_public")) {
                lock(&self.confidential).insert(row.id);
                continue;
            }
            let hit = CanonicalHit {
                result_id: String::new(),
                path: row.path.clone(),
                line: row.line,
                line_end: row.line_end,
                level: "line".into(),
                indexed_text: row.text.clone(),
                breadcrumb: row.breadcrumb.clone(),
                pinned: false,
            };
            if current_block(&self.root, &hit).is_err() {
                lock(&self.stale).insert(row.id);
                continue;
            }
            if row.text.chars().count() > self.max_block_chars {
                lock(&self.long).insert(row.id);
                continue;
            }
            out.push(SagCandidate {
                id: row.id,
                title: title_of(&row.path),
                path: row.path,
                line: row.line,
                line_end: row.line_end,
                heading: row.breadcrumb,
                content: row.text,
                bm25: row.bm25,
                score: 0.,
                previous_score: None,
                order,
            });
        }
        Ok(out)
    }

    fn has_hits(&self, expression: &str, excluded: &[i64]) -> Result<bool, String> {
        self.reader.has_match(expression, &self.filters, excluded)
    }

    fn aliases(&self) -> Result<Arc<AliasMap>, String> {
        let generation = self.reader.generation()?;
        {
            let mut cache = lock(&ALIAS_CACHE);
            cache.retain(|(reader, _, _)| reader.strong_count() > 0);
            if let Some((_, _, map)) = cache.iter().find(|(reader, g, _)| {
                *g == generation && reader.upgrade().is_some_and(|r| Arc::ptr_eq(&r, &self.reader))
            }) {
                return Ok(map.clone());
            }
        }
        // Built outside the lock: two lookups may build at once, which only
        // costs time.
        let map = Arc::new(self.build_aliases()?);
        let mut cache = lock(&ALIAS_CACHE);
        cache.retain(|(reader, _, _)| reader.upgrade().is_some_and(|r| !Arc::ptr_eq(&r, &self.reader)));
        cache.push((Arc::downgrade(&self.reader), generation, map.clone()));
        Ok(map)
    }

    fn skipped(&self) -> Skipped {
        Skipped {
            confidential: lock(&self.confidential).len(),
            stale: lock(&self.stale).len(),
            long: lock(&self.long).len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart_model::ModelError;
    use serde_json::Value;
    use std::sync::LazyLock;

    static ORACLE: LazyLock<Value> =
        LazyLock::new(|| serde_json::from_str(include_str!("fixtures/sag2_v10_oracle.json")).unwrap());

    /// A temporary vault indexed file by file with `index_one` only (P6).
    struct Vault {
        _dir: tempfile::TempDir,
        root: PathBuf,
        index: searchidx::SearchIndex,
        reader: Arc<SagReader>,
    }

    fn vault(files: &[(String, String)]) -> Vault {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let db = dir.path().join("i.db");
        let mut index = searchidx::SearchIndex::open_at(&root, &db, "").unwrap();
        for (rel, text) in files {
            std::fs::write(root.join(rel), text).unwrap();
            index.index_one(rel, &searchidx::ScanOptions::default()).unwrap();
        }
        let reader = Arc::new(SagReader::open_existing_at(&root, &db, "", 2).unwrap());
        Vault { _dir: dir, root, index, reader }
    }

    impl Vault {
        fn index(&self) -> ReaderIndex {
            ReaderIndex::new(self.reader.clone(), self.root.clone(), Query::default(), 1200)
        }
    }

    /// The oracle corpus, each document written as `<title>.md` in corpus
    /// order, so block ids follow the fixture ids.
    fn oracle_vault() -> Vault {
        let files: Vec<(String, String)> = ORACLE["corpus"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| (format!("{}.md", d["title"].as_str().unwrap()), d["text"].as_str().unwrap().to_owned()))
            .collect();
        vault(&files)
    }

    /// One scoring call as the scorer saw it.
    #[derive(Clone, Debug)]
    struct Call {
        pool: Vec<SagCandidate>,
        state: String,
    }

    /// `frozen_v10_requests_and_rounds`'s scores by title; `fail_on` makes
    /// that call (0-based) fail instead.
    #[derive(Default)]
    struct TitleScorer {
        calls: Vec<Call>,
        fail_on: Option<usize>,
    }

    fn oracle_score(title: &str, evidence: &[String]) -> f64 {
        let has = |t: &str| evidence.iter().any(|e| e == t);
        match title {
            "Anchor" => 0.8,
            "Multiple" => {
                if has("Anchor") {
                    0.95
                } else {
                    0.1
                }
            }
            "Bridge" => {
                if has("Multiple") {
                    0.99
                } else {
                    0.05
                }
            }
            "High" => 0.7,
            "Series" => 0.08,
            _ => 0.01,
        }
    }

    impl Scorer for TitleScorer {
        fn score(
            &mut self,
            pool: Vec<SagCandidate>,
            evidence: Vec<SagCandidate>,
            state: String,
        ) -> impl Future<Output = Result<Vec<SagCandidate>, RoundError>> + Send {
            let titles: Vec<String> = evidence.iter().map(|c| c.title.clone()).collect();
            let fail = self.fail_on == Some(self.calls.len());
            self.calls.push(Call { pool: pool.clone(), state });
            let scored: Vec<SagCandidate> = pool
                .into_iter()
                .map(|mut c| {
                    c.score = oracle_score(&c.title, &titles);
                    c
                })
                .collect();
            async move {
                if fail {
                    Err(RoundError::Model(ModelError::Http(500)))
                } else {
                    Ok(scored)
                }
            }
        }
    }

    fn settings(candidate_k: usize, seed_k: usize, max_hops: u8, term_limit: usize) -> RoundSettings {
        RoundSettings { candidate_k, seed_k, term_limit, max_hops, top_k: 10, protected_k: 5 }
    }

    fn oracle_settings() -> RoundSettings {
        settings(3, 1, 2, 2)
    }

    fn titles(cs: &[SagCandidate]) -> Vec<String> {
        cs.iter().map(|c| c.title.clone()).collect()
    }

    struct Run {
        round_titles: Vec<Vec<String>>,
        round_terms: Vec<Vec<String>>,
        pool_titles: Vec<Vec<String>>,
        states: Vec<String>,
        final_titles: Vec<String>,
        calls: Vec<Call>,
        state: EvidenceState,
        stop: EvidenceStop,
    }

    async fn run_all_rounds(v: &Vault, query: &str, settings: RoundSettings) -> Run {
        let index = v.index();
        let mut state = EvidenceState::start(&index, query, settings).unwrap();
        let mut scorer = TitleScorer::default();
        let cancel = CancelFlag::new();
        let mut round_titles = vec![];
        let mut round_terms = vec![];
        let stop = loop {
            match state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap() {
                StepOutcome::Scored { hop, terms, pool_size } => {
                    let call = scorer.calls.last().unwrap();
                    assert_eq!(pool_size, call.pool.len());
                    let trace = state.trace.last().unwrap();
                    assert_eq!(trace.hop, hop);
                    let title = |id: &i64| call.pool.iter().find(|c| c.id == *id).unwrap().title.clone();
                    round_titles.push(trace.candidates.iter().map(title).collect());
                    round_terms.push(terms.iter().map(|t| t.term.clone()).collect());
                }
                StepOutcome::Stopped(stop) => break stop,
                StepOutcome::Failed(e) => panic!("{query}: {e:?}"),
            }
        };
        Run {
            round_titles,
            round_terms,
            pool_titles: scorer.calls.iter().map(|c| titles(&c.pool)).collect(),
            states: scorer.calls.iter().map(|c| c.state.clone()).collect(),
            final_titles: titles(&state.evidence(&index).unwrap()),
            calls: scorer.calls,
            state,
            stop,
        }
    }

    struct Want {
        round_titles: &'static [&'static [&'static str]],
        round_terms: &'static [&'static [&'static str]],
        pool_titles: &'static [&'static [&'static str]],
        final_titles: &'static [&'static str],
    }

    fn strings(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter().map(|r| r.iter().map(|s| s.to_string()).collect()).collect()
    }

    const EXPECTED: [Want; 4] = [
        Want {
            // "Anchor birthplace depicts"
            round_titles: &[&["Anchor", "Series", "High"], &["Multiple", "Single", "Record 0"], &["Record 1", "Record 2", "Record 3"]],
            round_terms: &[&[], &["alice paul", "bob smith"], &["alice paul", "bob smith"]],
            pool_titles: &[
                &["Anchor", "Series", "High"],
                &["Anchor", "Series", "High", "Multiple", "Single", "Record 0"],
                &["Anchor", "Series", "High", "Multiple", "Record 1", "Record 2", "Record 3"],
            ],
            final_titles: &["Multiple", "High", "Anchor"],
        },
        Want {
            // "Anchor". Pre-flight P21: on our index hop 0 ranks [Series, High,
            // Anchor] (SAG2: [Anchor, Series, High]). SAG2's chunks carry the
            // document title, so the title "Anchor" adds to Anchor's score;
            // our line blocks have no title column (spec H.5 切分 row). The
            // pools follow from that order; terms, states and the final
            // ranking are SAG2's. Like the case-3 exception below.
            round_titles: &[&["Series", "High", "Anchor"], &["Single", "Multiple"], &["Record 1", "Record 3", "Record 5"]],
            round_terms: &[&[], &["depicts", "birthplace"], &["birthplace", "alice paul"]],
            pool_titles: &[
                &["Series", "High", "Anchor"],
                &["Series", "High", "Anchor", "Single", "Multiple"],
                &["Series", "High", "Anchor", "Multiple", "Record 1", "Record 3", "Record 5"],
            ],
            final_titles: &["Multiple", "High", "Anchor"],
        },
        Want {
            // "Where was Alston born?": round 1's terms differ from SAG2's
            // (spec H.5 分词 row), asserted below.
            round_titles: &[&["Initials", "Destination", "René Descartes"]],
            round_terms: &[&[]],
            pool_titles: &[&["Initials", "Destination", "René Descartes"]],
            final_titles: &["Initials", "Destination", "René Descartes"],
        },
        Want {
            // "Where was Rene Descartes born?": found through the alias repair.
            round_titles: &[&["René Descartes", "Destination", "Initials"]],
            round_terms: &[&[]],
            pool_titles: &[&["René Descartes", "Destination", "Initials"]],
            final_titles: &["René Descartes", "Destination", "Initials"],
        },
    ];

    /// Fixture document id → title.
    fn oracle_title(id: i64) -> String {
        ORACLE["corpus"][(id - 1) as usize]["title"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn frozen_v10_requests_and_rounds_on_our_index() {
        let v = oracle_vault();
        let cases = ORACLE["cases"].as_array().unwrap();
        assert_eq!(cases.len(), EXPECTED.len());
        for (case, want) in cases.iter().zip(&EXPECTED) {
            let query = case["query"].as_str().unwrap();
            let o = &case["options"];
            let s = settings(
                o["candidate_k"].as_u64().unwrap() as usize,
                o["seed_k"].as_u64().unwrap() as usize,
                o["max_hops"].as_u64().unwrap() as u8,
                o["expansion_term_limit"].as_u64().unwrap() as usize,
            );
            assert_eq!(s, oracle_settings());
            let run = run_all_rounds(&v, query, s).await;
            assert_eq!(run.round_titles, strings(want.round_titles), "{query}");
            assert_eq!(run.round_terms, strings(want.round_terms), "{query}");
            assert_eq!(run.pool_titles, strings(want.pool_titles), "{query}");
            let requests = case["requests"].as_array().unwrap();
            // Byte for byte.
            assert_eq!(run.states, requests.iter().map(|r| r["state"].as_str().unwrap().to_owned()).collect::<Vec<_>>(), "{query}");
            assert_eq!(run.final_titles, want.final_titles.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{query}");
            // Each request asks about the fixture's candidates (by title, as
            // the ids are ours) with the fixture's instructions and criteria.
            for (call, request) in run.calls.iter().zip(requests) {
                let fixture: HashMap<String, &Value> = request["questions"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, q)| (oracle_title(key.strip_prefix("candidate_").unwrap().parse().unwrap()), q))
                    .collect();
                assert_eq!(call.pool.len(), fixture.len(), "{query}");
                for c in &call.pool {
                    let q = super::super::jev::question_for(c, super::super::jev::Preset::Sag2V10, "");
                    let want = fixture[&c.title];
                    assert_eq!(q.instructions, want["instructions"], "{query}: {}", c.title);
                    assert_eq!(q.criteria_true, want["criteria"]["true"].as_str().unwrap());
                    assert_eq!(q.criteria_false, want["criteria"]["false"].as_str().unwrap());
                }
            }
            // The rounds the fixture records and the final ranking, by title.
            let rounds = case["result"]["rounds"].as_array().unwrap();
            let terms = |hop: usize| run.state.trace[hop].terms.iter().map(|t| t.term.clone()).collect::<Vec<_>>();
            match query {
                "Where was Alston born?" | "Where was Rene Descartes born?" => {
                    // Round 1 found no candidates and sent nothing.
                    assert_eq!(run.stop, EvidenceStop::CandidatesEmpty, "{query}");
                    assert_eq!(run.calls.len(), 1);
                    assert_eq!(run.state.trace.len(), 2);
                    assert!(run.state.trace[1].candidates.is_empty());
                    let want: &[&str] =
                        if query.contains("Alston") { &["g alston", "h"] } else { &["en", "la haye"] };
                    assert_eq!(terms(1), want, "{query}");
                    if query.contains("Rene") {
                        assert_eq!(terms(1), json_strings(&rounds[1]["terms"]), "the same as SAG2");
                    }
                }
                _ => {
                    assert_eq!(run.stop, EvidenceStop::MaxHops, "{query}");
                    for (hop, round) in rounds.iter().enumerate() {
                        assert_eq!(terms(hop), json_strings(&round["terms"]), "{query} hop {hop}");
                    }
                }
            }
            let ranked: Vec<String> =
                case["result"]["ranked_ids"].as_array().unwrap().iter().map(|id| oracle_title(id.as_i64().unwrap())).collect();
            assert_eq!(run.final_titles, ranked, "{query}");
        }
    }

    fn json_strings(v: &Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect()
    }

    #[tokio::test]
    async fn found_round_records_the_hop_of_first_appearance() {
        let v = oracle_vault();
        let run = run_all_rounds(&v, "Anchor birthplace depicts", oracle_settings()).await;
        let round_of = |title: &str| {
            let id = run.state.latest.values().find(|c| c.title == title).unwrap().id;
            run.state.found_round[&id]
        };
        assert_eq!((round_of("Anchor"), round_of("Multiple"), round_of("Record 1")), (0, 1, 2));
        assert_eq!(run.state.next_hop, 3);
    }

    #[tokio::test]
    async fn a_question_without_terms_sends_nothing() {
        let v = vault(&[("a.md".into(), "alpha\n".into())]);
        let index = v.index();
        let mut state = EvidenceState::start(&index, &searchidx::query::free_text("tag:x 的"), oracle_settings()).unwrap();
        assert_eq!(state.stop, Some(EvidenceStop::NoTerms));
        let mut scorer = TitleScorer::default();
        let outcome = state.step(&index, &mut scorer, &StateExtras::default(), &CancelFlag::new()).await.unwrap();
        assert_eq!(outcome, StepOutcome::Stopped(EvidenceStop::NoTerms));
        assert!(scorer.calls.is_empty());
    }

    #[tokio::test]
    async fn an_index_commit_between_rounds_stops_with_index_changed() {
        let mut v = oracle_vault();
        let index = v.index();
        let mut state = EvidenceState::start(&index, "Anchor birthplace depicts", oracle_settings()).unwrap();
        let mut scorer = TitleScorer::default();
        let cancel = CancelFlag::new();
        let first = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert!(matches!(first, StepOutcome::Scored { hop: 0, .. }), "{first:?}");
        let before = state.evidence(&index).unwrap();
        std::fs::write(v.root.join("Bridge.md"), "Bob Smith moved away.").unwrap();
        v.index.index_one("Bridge.md", &searchidx::ScanOptions::default()).unwrap();
        let second = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert_eq!(second, StepOutcome::Stopped(EvidenceStop::IndexChanged));
        assert_eq!(scorer.calls.len(), 1);
        assert_eq!(state.next_hop, 1);
        assert_eq!(state.evidence(&index).unwrap(), before);
    }

    #[tokio::test]
    async fn expansion_candidates_from_confidential_files_are_never_sent() {
        // Round 1 expands "alice paul" from q.md; it matches secret.md and
        // pub.md, and only pub.md may reach the scorer.
        let v = vault(&[
            ("q.md".into(), "Anchor met Alice Paul.\n".into()),
            ("secret.md".into(), "---\nconfidentiality: confidential\n---\nAlice Paul secret\n".into()),
            ("pub.md".into(), "Alice Paul public note.\n".into()),
        ]);
        let index = v.index();
        let mut state = EvidenceState::start(&index, "Anchor", settings(10, 5, 1, 5)).unwrap();
        let mut scorer = TitleScorer::default();
        let cancel = CancelFlag::new();
        let first = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert!(matches!(first, StepOutcome::Scored { hop: 0, .. }), "{first:?}");
        // Round 0 never meets secret.md, so every confidential drop below
        // belongs to the expansion round.
        assert_eq!(index.skipped().confidential, 0);
        let mut outcomes = vec![format!("{first:?}")];
        loop {
            match state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap() {
                StepOutcome::Stopped(stop) => {
                    outcomes.push(format!("{stop:?}"));
                    break;
                }
                other => outcomes.push(format!("{other:?}")),
            }
        }
        assert_eq!(scorer.calls.len(), 2, "{outcomes:?}");
        let round1 = &scorer.calls[1];
        assert!(state.trace[1].terms.iter().any(|t| t.term == "alice paul"), "{:?}", state.trace[1].terms);
        assert!(round1.pool.iter().any(|c| c.path == "pub.md"), "{:?}", round1.pool);
        for call in &scorer.calls {
            assert!(call.pool.iter().all(|c| c.path != "secret.md" && !c.content.contains("secret")), "{:?}", call.pool);
            assert!(!call.state.contains("secret"), "{}", call.state);
        }
        assert!(index.skipped().confidential >= 1, "{:?}", index.skipped());
        let evidence = state.evidence(&index).unwrap();
        assert!(evidence.iter().all(|c| c.path != "secret.md"));
    }

    /// Ported from retrieval.rs:tests::chinese_sentences_do_not_share_expansion_context,
    /// run on our index (TermStats = ReaderIndex::stats(Level::Line)).
    /// Adapted under spec H.5's 名称词 row (pre-flight P22): jieba tags 大运会
    /// as a proper noun, so it is a name phrase ("大运 大运会") here, and the
    /// unrelated terms are found by their label, not by their term.
    #[test]
    fn chinese_sentences_do_not_share_expansion_context() {
        for punctuation in ["。", "！", "？"] {
            let content = ["台风登陆福建，救援人员前往沿海", "成都大运会开幕", "母婴设施建设启动"].join(punctuation);
            let v = vault(&[("news.md".into(), content.clone())]);
            let index = v.index();
            let mut seed = SagCandidate {
                id: 1,
                path: String::new(),
                line: 1,
                line_end: 1,
                title: String::new(),
                heading: String::new(),
                content: String::new(),
                bm25: 0.,
                score: 0.,
                previous_score: None,
                order: 0,
            };
            seed.content = content;
            seed.score = 1.;
            let terms = expansion_terms("台风 福建", &[seed], 100, None, index.stats(Level::Line)).unwrap();
            let rescue = terms.iter().find(|t| t.term == "救援").unwrap();
            for word in ["大运会", "母婴"] {
                let unrelated = terms.iter().find(|t| t.label == word).unwrap_or_else(|| panic!("{word}: {terms:?}"));
                assert!(rescue.score > unrelated.score, "{punctuation}: {word}");
            }
        }
    }

    #[tokio::test]
    async fn a_failed_round_leaves_the_state_as_it_was() {
        let v = oracle_vault();
        let index = v.index();
        let mut state = EvidenceState::start(&index, "Anchor birthplace depicts", oracle_settings()).unwrap();
        let mut scorer = TitleScorer { fail_on: Some(1), ..Default::default() };
        let cancel = CancelFlag::new();
        let first = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert!(matches!(first, StepOutcome::Scored { hop: 0, .. }), "{first:?}");
        let before = state.clone();
        let evidence = state.evidence(&index).unwrap();
        let second = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert_eq!(second, StepOutcome::Failed(RoundError::Model(ModelError::Http(500))));
        assert_eq!(scorer.calls.len(), 2);
        assert_eq!(state.next_hop, 1);
        assert_eq!(state.evidence(&index).unwrap(), evidence);
        assert_eq!(state, before);
        // The same round can be tried again and then succeeds.
        let third = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert!(matches!(third, StepOutcome::Scored { hop: 1, .. }), "{third:?}");
        assert_eq!(scorer.calls[2].state, scorer.calls[1].state);
    }

    #[tokio::test]
    async fn a_cancelled_round_sends_nothing_and_keeps_the_state() {
        let v = oracle_vault();
        let index = v.index();
        let mut state = EvidenceState::start(&index, "Anchor", oracle_settings()).unwrap();
        let before = state.clone();
        let cancel = CancelFlag::new();
        cancel.cancel();
        let mut scorer = TitleScorer::default();
        let outcome = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert_eq!(outcome, StepOutcome::Failed(RoundError::Cancelled));
        assert!(scorer.calls.is_empty());
        assert_eq!(state, before);
    }

    /// A scorer that cancels while it is scoring: the round is discarded
    /// after scoring (D3).
    struct CancellingScorer<'a>(&'a CancelFlag, usize);

    impl Scorer for CancellingScorer<'_> {
        fn score(
            &mut self,
            mut pool: Vec<SagCandidate>,
            _evidence: Vec<SagCandidate>,
            _state: String,
        ) -> impl Future<Output = Result<Vec<SagCandidate>, RoundError>> + Send {
            self.1 += 1;
            self.0.cancel();
            for c in &mut pool {
                c.score = 0.5;
            }
            async move { Ok(pool) }
        }
    }

    #[tokio::test]
    async fn a_cancel_during_scoring_discards_the_round() {
        let v = oracle_vault();
        let index = v.index();
        let mut state = EvidenceState::start(&index, "Anchor", oracle_settings()).unwrap();
        let before = state.clone();
        let cancel = CancelFlag::new();
        let mut scorer = CancellingScorer(&cancel, 0);
        let outcome = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert_eq!(outcome, StepOutcome::Failed(RoundError::Cancelled));
        assert_eq!(scorer.1, 1);
        assert_eq!(state, before);
    }

    /// A scorer during whose scoring the main connection commits (review M2).
    struct CommittingScorer<'a> {
        index: &'a mut searchidx::SearchIndex,
        root: PathBuf,
        calls: usize,
    }

    impl Scorer for CommittingScorer<'_> {
        fn score(
            &mut self,
            mut pool: Vec<SagCandidate>,
            _evidence: Vec<SagCandidate>,
            _state: String,
        ) -> impl Future<Output = Result<Vec<SagCandidate>, RoundError>> + Send {
            self.calls += 1;
            std::fs::write(self.root.join("Bridge.md"), "Bob Smith moved away.").unwrap();
            self.index.index_one("Bridge.md", &searchidx::ScanOptions::default()).unwrap();
            for c in &mut pool {
                c.score = 0.5;
            }
            async move { Ok(pool) }
        }
    }

    #[tokio::test]
    async fn an_index_commit_during_scoring_discards_the_round() {
        let mut v = oracle_vault();
        let index = v.index();
        let mut state = EvidenceState::start(&index, "Anchor", oracle_settings()).unwrap();
        let before = state.clone();
        let cancel = CancelFlag::new();
        let mut scorer = CommittingScorer { index: &mut v.index, root: v.root.clone(), calls: 0 };
        let outcome = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert_eq!(outcome, StepOutcome::Stopped(EvidenceStop::IndexChanged));
        assert_eq!(scorer.calls, 1);
        // The round is thrown away: only the stop is recorded.
        assert_eq!(state, EvidenceState { stop: Some(EvidenceStop::IndexChanged), ..before });
        assert!(state.retained.is_empty() && state.trace.is_empty() && state.seen.is_empty());
    }

    /// A scorer that declines to send the round (Budget, EvidenceTooLarge).
    struct StoppingScorer(EvidenceStop, usize);

    impl Scorer for StoppingScorer {
        fn score(
            &mut self,
            _: Vec<SagCandidate>,
            _: Vec<SagCandidate>,
            _: String,
        ) -> impl Future<Output = Result<Vec<SagCandidate>, RoundError>> + Send {
            self.1 += 1;
            let stop = self.0;
            async move { Err(RoundError::Stop(stop)) }
        }
    }

    #[tokio::test]
    async fn a_scorer_stop_ends_the_rounds_and_discards_the_round() {
        for stop in [EvidenceStop::Budget, EvidenceStop::EvidenceTooLarge] {
            let v = oracle_vault();
            let index = v.index();
            let mut state = EvidenceState::start(&index, "Anchor birthplace depicts", oracle_settings()).unwrap();
            let cancel = CancelFlag::new();
            let mut titles = TitleScorer::default();
            let first = state.step(&index, &mut titles, &StateExtras::default(), &cancel).await.unwrap();
            assert!(matches!(first, StepOutcome::Scored { hop: 0, .. }), "{first:?}");
            let before = state.clone();
            let mut scorer = StoppingScorer(stop, 0);
            let outcome = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
            assert_eq!(outcome, StepOutcome::Stopped(stop));
            assert_eq!(state, EvidenceState { stop: Some(stop), ..before.clone() });
            assert_eq!(state.evidence(&index).unwrap(), before.evidence(&index).unwrap());
            // Later calls report the stop without scoring again.
            let again = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
            assert_eq!(again, StepOutcome::Stopped(stop));
            assert_eq!(scorer.1, 1);
        }
    }

    #[tokio::test]
    async fn max_hops_ends_after_the_last_scored_round() {
        let v = oracle_vault();
        let index = v.index();
        let mut state = EvidenceState::start(&index, "Anchor birthplace depicts", settings(3, 1, 0, 2)).unwrap();
        let mut scorer = TitleScorer::default();
        let cancel = CancelFlag::new();
        let first = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert!(matches!(first, StepOutcome::Scored { hop: 0, .. }), "{first:?}");
        let second = state.step(&index, &mut scorer, &StateExtras::default(), &cancel).await.unwrap();
        assert_eq!(second, StepOutcome::Stopped(EvidenceStop::MaxHops));
        assert_eq!(scorer.calls.len(), 1);
        assert!(EvidenceState::start(&index, "x", settings(3, 1, 3, 2)).is_err());
    }

    #[test]
    fn evidence_stop_serialises_in_camel_case() {
        assert_eq!(serde_json::to_string(&EvidenceStop::CandidatesEmpty).unwrap(), "\"candidatesEmpty\"");
        assert_eq!(serde_json::to_string(&EvidenceStop::IndexChanged).unwrap(), "\"indexChanged\"");
        assert_eq!(serde_json::to_string(&EvidenceStop::EvidenceTooLarge).unwrap(), "\"evidenceTooLarge\"");
    }

    #[test]
    fn the_alias_table_is_built_once_per_reader_and_generation() {
        let mut v = vault(&[("René Descartes.md".into(), "René Descartes was born.\n".into())]);
        let first = v.index().aliases().unwrap();
        // Another ReaderIndex on the same reader (another lookup) reuses it.
        assert!(Arc::ptr_eq(&first, &v.index().aliases().unwrap()));
        let mut hits = |e: &str| Ok(e == "\"rené descartes\"");
        assert_eq!(first.repair("rene descartes", &mut hits).unwrap(), "rené descartes");
        // A commit moves the generation and the table is rebuilt.
        std::fs::write(v.root.join("b.md"), "other\n").unwrap();
        v.index.index_one("b.md", &searchidx::ScanOptions::default()).unwrap();
        assert!(!Arc::ptr_eq(&first, &v.index().aliases().unwrap()));
    }

    #[test]
    fn frontmatter_aliases_name_the_file_title() {
        let v = vault(&[
            ("sag.md".into(), "---\ntitle: Search Augmented Generation\naliases: [SAG]\n---\nbody\n".into()),
        ]);
        let map = v.index().aliases().unwrap();
        let mut hits = |e: &str| Ok(e == "\"search augmented generation\"");
        assert_eq!(map.repair("what is SAG", &mut hits).unwrap(), "what is search augmented generation");
    }

    #[test]
    fn stale_and_overlong_blocks_are_dropped_and_counted() {
        let v = vault(&[
            ("a.md".into(), "alpha one\n".into()),
            ("b.md".into(), format!("alpha {}\n", "x".repeat(50))),
            ("c.md".into(), "alpha three\n".into()),
        ]);
        std::fs::write(v.root.join("a.md"), "changed on disk\n").unwrap();
        let index = ReaderIndex::new(v.reader.clone(), v.root.clone(), Query::default(), 20);
        let got = index.candidates("\"alpha\"", None, &[], 10).unwrap();
        assert_eq!(got.iter().map(|c| (c.path.as_str(), c.title.as_str())).collect::<Vec<_>>(), vec![("c.md", "c")]);
        assert_eq!(index.skipped(), Skipped { confidential: 0, stale: 1, long: 1 });
        // `order` is the SQL row number, gaps included: c.md keeps the
        // position it had before a.md and b.md were dropped.
        let rows = v
            .reader
            .candidate_query(&CandidateQuery { expression: "\"alpha\"", required: None, filters: &Query::default(), excluded: &[], limit: 10 })
            .unwrap();
        assert_eq!(rows.len(), 3);
        let position = rows.iter().position(|r| r.path == "c.md").unwrap();
        assert_eq!(got[0].order, position);
        assert!(position > 0, "c.md must come after a dropped row: {rows:?}");
    }

    /// Review M1: `Skipped` counts distinct blocks, so a block returned by
    /// several term lists or rounds counts once.
    #[test]
    fn skipped_blocks_are_counted_once_however_often_they_return() {
        let v = vault(&[
            ("s.md".into(), "---\nconfidentiality: confidential\n---\nalpha beta secret\n".into()),
            ("a.md".into(), "alpha one\n".into()),
            ("b.md".into(), format!("alpha beta {}\n", "x".repeat(50))),
        ]);
        std::fs::write(v.root.join("a.md"), "changed on disk\n").unwrap();
        let index = ReaderIndex::new(v.reader.clone(), v.root.clone(), Query::default(), 30);
        let once = Skipped { confidential: 1, stale: 1, long: 1 };
        index.candidates("\"alpha\"", None, &[], 10).unwrap();
        assert_eq!(index.skipped(), once);
        // Two term lists of one round, then the next round: the same blocks.
        let ranking = "\"beta\" OR \"one\" OR (\"alpha\")";
        let lists = candidate_lists(&index, ranking, &["\"beta\"".into(), "\"alpha\"".into()], &[], 10).unwrap();
        assert!(lists.iter().all(Vec::is_empty), "{lists:?}");
        index.candidates("\"alpha\"", None, &[], 10).unwrap();
        assert_eq!(index.skipped(), once);
    }

    #[test]
    fn the_step_future_is_send() {
        fn assert_send<T: Send>(_: T) {}
        struct Never;
        impl Scorer for Never {
            fn score(
                &mut self,
                _: Vec<SagCandidate>,
                _: Vec<SagCandidate>,
                _: String,
            ) -> impl Future<Output = Result<Vec<SagCandidate>, RoundError>> + Send {
                async { Err(RoundError::Cancelled) }
            }
        }
        let v = vault(&[("a.md".into(), "alpha\n".into())]);
        let index = v.index();
        let mut state = EvidenceState::start(&index, "alpha", oracle_settings()).unwrap();
        let (cancel, extras, mut scorer) = (CancelFlag::new(), StateExtras::default(), Never);
        assert_send(state.step(&index, &mut scorer, &extras, &cancel));
    }
}
