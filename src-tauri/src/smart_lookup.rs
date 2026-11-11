//! Short-lived trusted state for Smart Lookup runs.
//!
//! Normal lookup never reads source files here. Later actions (judge,
//! feedback) resolve opaque result ids back to the run's canonical local
//! lookup hits and re-read the current line block, rejecting stale content.

use chrono::NaiveDate;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::search::time_group::TimeMode;
use crate::smart_enhance::Tier;

const RUN_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_RUNS_PER_WINDOW: usize = 20;
const MAX_SOURCE_CHARS: usize = 3_000;
const MAX_FILE_BYTES: u64 = 52_428_800;

#[derive(Clone)]
pub(crate) struct CanonicalHit {
    pub(crate) result_id: String,
    pub(crate) path: String,
    pub(crate) line: u32,
    pub(crate) line_end: u32,
    pub(crate) level: String,
    pub(crate) indexed_text: String,
    pub(crate) breadcrumb: String,
    pub(crate) pinned: bool,
}

/// What one query arm found, recorded for later routing decisions.
#[derive(Clone)]
pub(crate) struct ArmFact {
    pub(crate) kind: String,
    pub(crate) terms: Vec<String>,
    pub(crate) hit_count: usize,
}

/// Facts about a lookup's result that later routing reads without re-searching.
#[derive(Clone, Default)]
pub(crate) struct RouteFacts {
    pub(crate) hit_count: usize,
    pub(crate) pinned: bool,
    pub(crate) extracted_terms: Vec<String>,
    pub(crate) arms: Vec<ArmFact>,
}

/// The time phrase a lookup grouped (or filtered) by.
#[derive(Clone)]
pub(crate) struct RunTime {
    pub(crate) source_text: String,
    pub(crate) after: NaiveDate,
    pub(crate) before: NaiveDate,
    pub(crate) mode: TimeMode,
    pub(crate) in_window: usize,
}

/// What the model judged on a run, kept for the user's corrections.
#[derive(Clone)]
pub(crate) struct JudgeRecord {
    pub endpoint_host: String,
    pub model: String,
    /// Keyed by `result_id`.
    pub tiers: HashMap<String, Tier>,
}

#[derive(Clone)]
pub(crate) struct LookupRun {
    pub(crate) id: String,
    pub(crate) created_at: Instant,
    pub(crate) window_label: String,
    pub(crate) root: PathBuf,
    pub(crate) question: String,
    pub(crate) hits: Vec<CanonicalHit>,
    pub(crate) facts: RouteFacts,
    pub(crate) time: Option<RunTime>,
    pub(crate) auto_request_used: bool,
    pub(crate) repaired: bool,
    /// The claim that set `auto_request_used`, if a claim did (see
    /// `smart_enhance::claim_auto_request`); a repaired run has none.
    pub(crate) auto_claim: Option<u64>,
    pub(crate) judgement: Option<JudgeRecord>,
    /// The SAG2 evidence rounds of this run (spec H.3.8), written back by
    /// `smart_enhance::evidence::evidence_step` after each round.
    pub(crate) evidence: Option<crate::smart_enhance::evidence::EvidenceRun>,
    /// An evidence round is running on this run (`evidence::begin_step`).
    pub(crate) evidence_busy: bool,
}

#[derive(Default)]
struct LookupRuns {
    runs: HashMap<String, LookupRun>,
    order: VecDeque<String>,
}

static LOOKUP_RUNS: OnceLock<Mutex<LookupRuns>> = OnceLock::new();

pub(crate) fn active_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = crate::sotvault::resolve_vault_root(app)
        .ok_or_else(|| "Vault not configured".to_string())?;
    fs::canonicalize(root).map_err(|error| format!("resolve vault: {error}"))
}

/// Drops runs older than the TTL. Reads use only this.
fn prune_expired(runs: &mut LookupRuns) {
    let now = Instant::now();
    runs.runs
        .retain(|_, run| now.duration_since(run.created_at) <= RUN_TTL);
    runs.order.retain(|id| runs.runs.contains_key(id));
}

/// TTL pruning plus per-window capacity eviction. Insert-only: a read must
/// never evict the run it asks for.
fn prune(runs: &mut LookupRuns, window_label: &str) {
    prune_expired(runs);
    while runs
        .order
        .iter()
        .filter_map(|id| runs.runs.get(id))
        .filter(|run| run.window_label == window_label)
        .count()
        >= MAX_RUNS_PER_WINDOW
    {
        let Some(position) = runs.order.iter().position(|id| {
            runs.runs
                .get(id)
                .is_some_and(|run| run.window_label == window_label)
        }) else {
            break;
        };
        if let Some(id) = runs.order.remove(position) {
            runs.runs.remove(&id);
        }
    }
}

/// Registers a local smart search as a lookup run of `window_label` in
/// `root`, writing a `result_id` onto every hit. Returns the run id.
pub(crate) fn retain_search_in(
    window_label: &str,
    root: &Path,
    original_query: &str,
    search: &mut crate::search::smart::SmartSearchResponse,
    time: Option<RunTime>,
    repaired: bool,
) -> Result<String, String> {
    let root = fs::canonicalize(root).map_err(|error| format!("resolve vault: {error}"))?;
    let run_id = uuid::Uuid::now_v7().to_string();
    let mut hits = Vec::with_capacity(search.hits.len());
    for hit in &mut search.hits {
        let result_id = uuid::Uuid::now_v7().to_string();
        hit.result_id = Some(result_id.clone());
        hits.push(CanonicalHit {
            result_id,
            path: hit.hit.path.clone(),
            line: hit.hit.line,
            line_end: hit.hit.line_end,
            level: hit.hit.level.clone(),
            indexed_text: if hit.hit.level == "line"
                && !hit.hit.text.trim().is_empty()
                && hit.hit.text.chars().count() <= MAX_SOURCE_CHARS
            {
                hit.hit.text.clone()
            } else {
                String::new()
            },
            breadcrumb: hit.hit.breadcrumb.clone(),
            pinned: hit.hit.pinned,
        });
    }
    let facts = RouteFacts {
        hit_count: search.hits.len(),
        pinned: search.hits.iter().any(|hit| hit.hit.pinned),
        extracted_terms: search.extracted_terms.clone(),
        arms: search
            .subqueries
            .iter()
            .map(|arm| ArmFact {
                kind: arm.kind.clone(),
                terms: arm.terms.clone(),
                hit_count: arm.hit_count,
            })
            .collect(),
    };
    let run = LookupRun {
        id: run_id.clone(),
        created_at: Instant::now(),
        window_label: window_label.to_string(),
        root,
        question: original_query.chars().take(2_000).collect(),
        hits,
        facts,
        time,
        auto_request_used: repaired,
        repaired,
        auto_claim: None,
        judgement: None,
        evidence: None,
        evidence_busy: false,
    };
    let mut registry = LOOKUP_RUNS
        .get_or_init(|| Mutex::new(LookupRuns::default()))
        .lock()
        .map_err(|_| "lookup run registry is unavailable".to_string())?;
    prune(&mut registry, window_label);
    registry.order.push_back(run_id.clone());
    registry.runs.insert(run_id.clone(), run);
    Ok(run_id)
}

/// Applies `change` to the window's lookup run in place.
pub(crate) fn update_run(
    run_id: &str,
    window_label: &str,
    change: impl FnOnce(&mut LookupRun),
) -> Result<(), String> {
    let mut registry = LOOKUP_RUNS
        .get_or_init(|| Mutex::new(LookupRuns::default()))
        .lock()
        .map_err(|_| "lookup run registry is unavailable".to_string())?;
    prune_expired(&mut registry);
    let run = registry
        .runs
        .get_mut(run_id)
        .filter(|run| run.window_label == window_label)
        .ok_or_else(|| "lookup run expired; run Smart Lookup again".to_string())?;
    change(run);
    Ok(())
}

/// Returns a clone of the window's lookup run and marks it most recently used.
pub(crate) fn run_for_window(run_id: &str, window_label: &str) -> Result<LookupRun, String> {
    let mut registry = LOOKUP_RUNS
        .get_or_init(|| Mutex::new(LookupRuns::default()))
        .lock()
        .map_err(|_| "lookup run registry is unavailable".to_string())?;
    prune_expired(&mut registry);
    let run = registry
        .runs
        .get(run_id)
        .filter(|run| run.window_label == window_label)
        .cloned()
        .ok_or_else(|| "lookup run expired; run Smart Lookup again".to_string())?;
    registry.order.retain(|id| id != run_id);
    registry.order.push_back(run_id.to_string());
    Ok(run)
}

/// A well-formed vault-relative source path, looked up on disk.
enum SourceLookup {
    Found(PathBuf),
    /// The path is well-formed but nothing regular is there any more: a
    /// component is missing or the target is not a regular file. Carries the
    /// error `canonical_source_path` reports for it.
    Gone(String),
}

fn canonical_source_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    match lookup_source_path(root, relative)? {
        SourceLookup::Found(path) => Ok(path),
        SourceLookup::Gone(error) => Err(error),
    }
}

/// Malformed, absolute, traversing, symlinked, oversized or escaping paths
/// are errors; a well-formed path whose file is gone is `Gone`.
fn lookup_source_path(root: &Path, relative: &str) -> Result<SourceLookup, String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.len() > 2_048
        || relative.contains('\0')
        || relative.contains('\\')
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("invalid lookup source path".to_string());
    }
    let mut current = root.to_path_buf();
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err("invalid lookup source path".to_string());
        };
        current.push(name);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SourceLookup::Gone(format!("inspect lookup source: {error}")));
            }
            Err(error) => return Err(format!("inspect lookup source: {error}")),
        };
        if metadata.file_type().is_symlink() {
            return Err("refusing symlink lookup source".to_string());
        }
    }
    let metadata = fs::symlink_metadata(&current)
        .map_err(|error| format!("inspect lookup source: {error}"))?;
    if !metadata.is_file() {
        return Ok(SourceLookup::Gone("lookup source is not a supported file".to_string()));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("lookup source is not a supported file".to_string());
    }
    let canonical =
        fs::canonicalize(&current).map_err(|error| format!("resolve lookup source: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("lookup source escaped the Vault".to_string());
    }
    Ok(SourceLookup::Found(canonical))
}

/// The current text of `hit`'s line block, read from disk; an error when the
/// hit is not a complete line block or the file no longer holds the indexed
/// text there.
pub(crate) fn current_block(root: &Path, hit: &CanonicalHit) -> Result<String, String> {
    read_source(root, hit).map(|source| source.block)
}

/// A line block as it is on disk now, with what its file says about itself.
pub(crate) struct SourceRead {
    /// Equal to the hit's indexed text.
    pub(crate) block: String,
    /// `files.confidentiality` as the indexer would store it for the file's
    /// current bytes (`searchidx::chunk::confidentiality_of`).
    pub(crate) confidentiality: String,
}

/// [`current_block`] plus the frontmatter's confidentiality, from one read
/// of the file.
pub(crate) fn read_source(root: &Path, hit: &CanonicalHit) -> Result<SourceRead, String> {
    if hit.level != "line"
        || hit.indexed_text.is_empty()
        || hit.line == 0
        || hit.line_end < hit.line
    {
        return Err("lookup result is not a complete line block".to_string());
    }
    let path = canonical_source_path(root, &hit.path)?;
    let body = fs::read_to_string(path).map_err(|error| format!("read lookup source: {error}"))?;
    let start = usize::try_from(hit.line - 1).map_err(|_| "invalid lookup line".to_string())?;
    let count = usize::try_from(hit.line_end - hit.line + 1)
        .map_err(|_| "invalid lookup line range".to_string())?;
    let lines = body.lines().skip(start).take(count).collect::<Vec<_>>();
    if lines.len() != count {
        return Err("lookup source changed after indexing".to_string());
    }
    let text = lines.join("\n");
    if text.is_empty() || text != hit.indexed_text {
        return Err("lookup source changed after indexing".to_string());
    }
    Ok(SourceRead { block: text, confidentiality: searchidx::chunk::confidentiality_of(&hit.path, &body) })
}

/// Why a block may not be sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Dropped {
    /// The index or the file's current frontmatter says it is not
    /// `unknown` or `explicitly_public` (or the index does not know the file).
    Confidential,
    /// The file no longer holds the indexed text (or cannot be read).
    Stale,
}

/// The one "may this block be sent to a model" check (spec H.3.3 checks 1
/// and 2, H.6), shared by the SAG2 rounds, the answer and the one-round
/// judge. In order:
/// 1. the index's `files.confidentiality` for the file (`indexed`; `None`
///    when the index has no row) is `unknown` or `explicitly_public`;
/// 2. `read` (normally [`read_source`]) still finds the indexed text;
/// 3. the file's current frontmatter, parsed as the indexer parses it, is
///    `unknown` or `explicitly_public` too: a file marked confidential on
///    disk is dropped before the index has caught up (fail closed).
///
/// Returns the block's text. `read` is not called for a block the index
/// already refuses.
pub(crate) fn sendable_block(
    indexed: Option<&str>,
    read: impl FnOnce() -> Result<SourceRead, String>,
) -> Result<String, Dropped> {
    let public = |value: &str| matches!(value, "unknown" | "explicitly_public");
    if !indexed.is_some_and(public) {
        return Err(Dropped::Confidential);
    }
    let source = read().map_err(|_| Dropped::Stale)?;
    if !public(&source.confidentiality) {
        return Err(Dropped::Confidential);
    }
    Ok(source.block)
}

/// Registers a hand-built run, for tests elsewhere in the crate.
#[cfg(test)]
pub(crate) fn insert_run_for_test(run: LookupRun) {
    let mut registry = LOOKUP_RUNS
        .get_or_init(|| Mutex::new(LookupRuns::default()))
        .lock()
        .unwrap();
    registry.order.push_back(run.id.clone());
    registry.runs.insert(run.id.clone(), run);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_block_accepts_only_unchanged_complete_line_blocks() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.md"), "one\ntwo\nthree\n").unwrap();
        let root = fs::canonicalize(root.path()).unwrap();
        let hit = |level: &str, line: u32, line_end: u32, text: &str| CanonicalHit {
            result_id: "r".into(),
            path: "a.md".into(),
            line,
            line_end,
            level: level.into(),
            indexed_text: text.into(),
            breadcrumb: String::new(),
            pinned: false,
        };
        assert_eq!(current_block(&root, &hit("line", 2, 3, "two\nthree")).unwrap(), "two\nthree");
        assert!(current_block(&root, &hit("line", 2, 3, "two\nTHREE")).is_err());
        assert!(current_block(&root, &hit("section", 1, 3, "one")).is_err());
        assert!(current_block(&root, &hit("line", 3, 5, "three")).is_err());
    }

    #[test]
    fn sendable_block_checks_the_index_then_the_text_then_the_frontmatter() {
        let root = tempfile::tempdir().unwrap();
        let write = |name: &str, body: &str| fs::write(root.path().join(name), body).unwrap();
        write("plain.md", "one\ntwo\n");
        write("marked.md", "---\nconfidentiality: confidential\n---\nsecret line\n");
        write("private.md", "---\nprivate: true\n---\nsecret line\n");
        write("public.md", "---\nconfidentiality: explicitly_public\n---\nopen line\n");
        // A .txt has no frontmatter, so its `---` block is text (as the indexer reads it).
        write("note.txt", "---\nconfidentiality: confidential\n---\nplain text\n");
        let root = fs::canonicalize(root.path()).unwrap();
        let hit = |path: &str, line: u32, text: &str| CanonicalHit {
            result_id: String::new(),
            path: path.into(),
            line,
            line_end: line,
            level: "line".into(),
            indexed_text: text.into(),
            breadcrumb: String::new(),
            pinned: false,
        };
        let check = |indexed: Option<&str>, h: CanonicalHit| sendable_block(indexed, || read_source(&root, &h));
        assert_eq!(check(Some("unknown"), hit("plain.md", 2, "two")), Ok("two".into()));
        assert_eq!(check(Some("explicitly_public"), hit("public.md", 4, "open line")), Ok("open line".into()));
        assert_eq!(check(Some("unknown"), hit("note.txt", 4, "plain text")), Ok("plain text".into()));
        // The index refuses: the file is not read at all.
        for indexed in [Some("confidential"), None, Some("other")] {
            assert_eq!(sendable_block(indexed, || panic!("read")), Err(Dropped::Confidential));
        }
        assert_eq!(check(Some("unknown"), hit("plain.md", 2, "TWO")), Err(Dropped::Stale));
        assert_eq!(check(Some("unknown"), hit("gone.md", 1, "x")), Err(Dropped::Stale));
        // Marked confidential on disk, not re-indexed yet: dropped as confidential.
        assert_eq!(check(Some("unknown"), hit("marked.md", 4, "secret line")), Err(Dropped::Confidential));
        assert_eq!(check(Some("explicitly_public"), hit("private.md", 4, "secret line")), Err(Dropped::Confidential));
        let read = read_source(&root, &hit("marked.md", 4, "secret line")).unwrap();
        assert_eq!((read.block.as_str(), read.confidentiality.as_str()), ("secret line", "confidential"));
    }

    fn test_run(id: &str, window: &str, created_at: Instant) -> LookupRun {
        LookupRun {
            id: id.into(),
            created_at,
            window_label: window.into(),
            root: PathBuf::new(),
            question: String::new(),
            hits: Vec::new(),
            facts: RouteFacts::default(),
            time: None,
            auto_request_used: false,
            repaired: false,
            auto_claim: None,
            judgement: None,
            evidence: None,
            evidence_busy: false,
        }
    }

    use super::insert_run_for_test as insert_run;

    #[test]
    fn reading_the_oldest_run_of_a_full_window_returns_it() {
        let window = "test-full-window";
        for i in 0..MAX_RUNS_PER_WINDOW {
            insert_run(test_run(&format!("full-{i}"), window, Instant::now()));
        }
        let run = run_for_window("full-0", window).expect("oldest run must not be evicted by a read");
        assert_eq!(run.id, "full-0");
        // all 20 are still readable
        for i in 0..MAX_RUNS_PER_WINDOW {
            assert!(run_for_window(&format!("full-{i}"), window).is_ok());
        }
    }

    #[test]
    fn a_run_older_than_the_ttl_is_reported_expired_on_read() {
        let window = "test-ttl-window";
        let old = Instant::now()
            .checked_sub(RUN_TTL + Duration::from_secs(5))
            .expect("monotonic clock is old enough");
        insert_run(test_run("ttl-old", window, old));
        let error = run_for_window("ttl-old", window).err().expect("expired");
        assert_eq!(error, "lookup run expired; run Smart Lookup again");
    }
}
