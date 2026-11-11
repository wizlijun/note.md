//! Read-only index access for SAG2 multi-round evidence retrieval (spec
//! Appendix H): line-level BM25 candidates, existence checks, document
//! frequencies, the index generation, and the sources of the alias table.
//!
//! Ported in behaviour from SAG-Wiki (MIT, commit 61f63c6),
//! `core/src/store.rs` — the functions are named on each item below. The SQL
//! is our own (spec H.3.3/H.3.4): SAG-Wiki's `chunk_fts` with `sag_bm25` maps
//! onto our `blocks_fts` restricted to `blocks.level = 'line'` with the
//! built-in `bm25()`.
//!
//! A `SagReader` never writes: it holds its own read-only connections, so the
//! host's main index lock is never taken here, and under WAL a reader never
//! blocks the writer (spec H.3.11).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, TryLockError};

use rusqlite::{params, params_from_iter, Connection, OpenFlags};

/// Which block level a count is taken over: `Line` is SAG2's chunk (idf for
/// expansion terms, H.3.4); `File` is its document (idf for `diversify`, H.3.9).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Level {
    Line,
    File,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Line => "line",
            Level::File => "file",
        }
    }
}

/// One BM25 candidate query (SAG-Wiki `store.rs:CandidateQuery`). `expression`
/// ranks; `required`, when present, must also match but does not score.
pub struct CandidateQuery<'a> {
    pub expression: &'a str,
    pub required: Option<&'a str>,
    /// Explicit DSL filters (and the `window`-mode time range), applied through
    /// `query::push_filters` exactly as local search applies them.
    pub filters: &'a crate::query::Query,
    pub excluded: &'a [i64],
    pub limit: usize,
}

/// One line-level block returned by [`SagReader::candidate_query`].
#[derive(Clone, Debug, PartialEq)]
pub struct SagRow {
    /// `blocks.id`.
    pub id: i64,
    pub path: String,
    pub line: u32,
    pub line_end: u32,
    pub breadcrumb: String,
    /// `blocks.text` (the host re-reads the source and compares, H.3.3).
    pub text: String,
    /// FTS5 `bm25(blocks_fts, 1.0, 2.0, 2.0)`; more negative is more relevant.
    pub bm25: f64,
}

/// What the alias table (spec H.3.1) is built from, apart from frontmatter
/// `aliases`, which are not in the index (see [`frontmatter_aliases`]).
#[derive(Debug, Clone, PartialEq)]
pub struct AliasSources {
    /// Every indexed file, ordered by path.
    pub files: Vec<FileTitle>,
    /// Distinct `[[wiki]]` link targets with any `#section` part removed,
    /// ordered by bytes.
    pub wiki_targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileTitle {
    pub path: String,
    /// `files.title`. The index already falls back frontmatter `title` →
    /// first H1 → file stem (`chunk.rs:parse_file`), so this is `None` only
    /// for a row stored without one.
    pub title: Option<String>,
    pub ext: String,
}

/// Document-frequency cache entries above which the cache is emptied (H.3.4).
const DF_CACHE_LIMIT: usize = 200_000;

/// Counts keyed by (level, term), valid for one index generation only — the
/// counterpart of SAG-Wiki `store.rs:QueryCache::frequencies` and `refresh`.
#[derive(Default)]
struct DfCache {
    generation: Option<i64>,
    counts: HashMap<(Level, String), u64>,
}

/// Read-only SAG2 view of one vault index. `Send + Sync`: every connection
/// sits behind its own mutex, so one reader can serve parallel queries.
pub struct SagReader {
    conns: Vec<Mutex<Connection>>,
    df: Mutex<DfCache>,
    /// Test seam: runs once in `frequencies` after the counts are taken and
    /// before the generation is re-read, so a test can land a commit there.
    #[cfg(test)]
    after_counting: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

const CANDIDATE_SQL: &str = "SELECT b.id, f.path, b.line_start, b.line_end, b.breadcrumb, b.text,
       bm25(blocks_fts, 1.0, 2.0, 2.0) AS score
FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid JOIN files f ON f.id = b.file_id
WHERE blocks_fts MATCH ?1
  AND b.level = 'line'
  AND blocks_fts.rowid NOT IN (SELECT value FROM json_each(?2))";

const REQUIRED_SQL: &str = " AND blocks_fts.rowid IN (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?3)";

const HAS_MATCH_SQL: &str = "SELECT EXISTS(SELECT 1
FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid JOIN files f ON f.id = b.file_id
WHERE blocks_fts MATCH ?1
  AND b.level = 'line'
  AND blocks_fts.rowid NOT IN (SELECT value FROM json_each(?2))";

const FREQUENCY_SQL: &str = "SELECT count(*) FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid
WHERE blocks_fts MATCH ?1 AND b.level = ?2";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding a read-only connection leaves nothing half-written.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// FTS5 phrase quoting, SAG-Wiki `core/src/text.rs:quote` (spec H.3.2). A
/// private copy: the public one lives on the host side with the other SAG2
/// text functions.
fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// The excluded ids as an ascending JSON array (spec H.3.3 `?2`), sorted as
/// SAG-Wiki `store.rs:candidate_query` sorts them.
fn excluded_json(excluded: &[i64]) -> Result<String, String> {
    let mut ids = excluded.to_vec();
    ids.sort_unstable();
    serde_json::to_string(&ids).map_err(err)
}

/// `LIMIT` is formatted into the SQL as an integer, as `query.rs:fts_arms`
/// does; a limit too large for SQLite means "no limit".
fn limit_sql(limit: usize) -> i64 {
    i64::try_from(limit).unwrap_or(-1)
}

impl SagReader {
    /// Open `workers` read-only connections (at least one) on an existing
    /// index. Like `SearchIndex::open_existing_at` this never creates or
    /// repairs anything; it checks `schema_version`, `tokenizer_id`,
    /// `source_globs` and `vault_root`, but not `built_at` (pre-flight P6: an
    /// index kept current by `index_one` alone never sets it).
    pub fn open_existing_at(root: &Path, db: &Path, globs_stamp: &str, workers: usize) -> Result<Self, String> {
        let mut conns = Vec::with_capacity(workers.max(1));
        for _ in 0..workers.max(1) {
            let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| format!("INDEX_NOT_READY: {e}"))?;
            conn.busy_timeout(std::time::Duration::from_secs(2)).map_err(err)?;
            if conns.is_empty() {
                crate::snapshot::check_index_meta(&conn, root, globs_stamp)?;
            }
            conns.push(Mutex::new(conn));
        }
        Ok(Self {
            conns,
            df: Mutex::new(DfCache::default()),
            #[cfg(test)]
            after_counting: Mutex::new(None),
        })
    }

    /// The index generation: `PRAGMA data_version` on the first connection.
    /// These connections never write, so any commit by the host or the CLI
    /// changes it (spec H.3.11; SAG-Wiki `store.rs:version`). Only values
    /// from the same reader are comparable.
    pub fn generation(&self) -> Result<i64, String> {
        lock(&self.conns[0]).query_row("PRAGMA data_version", [], |r| r.get(0)).map_err(err)
    }

    /// Number of blocks at `level` — SAG-Wiki `store.rs:chunk_count` for
    /// `Line` (the `N` of H.3.4), the document count for `File` (H.3.9).
    pub fn block_count(&self, level: Level) -> Result<u64, String> {
        let n: i64 = lock(&self.conns[0])
            .query_row("SELECT count(*) FROM blocks WHERE level = ?1", [level.as_str()], |r| r.get(0))
            .map_err(err)?;
        Ok(n as u64)
    }

    /// Document frequency of each term at `level`: the number of blocks whose
    /// `tok_text` matches the quoted term (SAG-Wiki `store.rs:frequencies`,
    /// which counts `body : quote(term)` over chunks). Counts are cached per
    /// generation; missing terms are spread round-robin over the connections
    /// and counted in parallel. Neither changes the result.
    pub fn frequencies(&self, terms: &[String], level: Level) -> Result<HashMap<String, u64>, String> {
        let generation = self.generation()?;
        let mut out = HashMap::with_capacity(terms.len());
        let mut missing: Vec<&str> = Vec::new();
        {
            let mut cache = lock(&self.df);
            if cache.generation != Some(generation) {
                cache.counts.clear();
                cache.generation = Some(generation);
            }
            let mut queued = HashSet::new();
            for term in terms {
                match cache.counts.get(&(level, term.clone())) {
                    Some(&n) => {
                        out.insert(term.clone(), n);
                    }
                    None if queued.insert(term.as_str()) => missing.push(term),
                    None => {}
                }
            }
        }
        if missing.is_empty() {
            return Ok(out);
        }
        let workers = missing.len().min(self.conns.len());
        let counted = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..workers)
                .map(|worker| {
                    let missing = &missing;
                    scope.spawn(move || self.count_terms(worker, missing.iter().skip(worker).step_by(workers), level))
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().map_err(|_| "frequency worker panicked".to_string())?)
                .collect::<Result<Vec<_>, String>>()
        })?;
        #[cfg(test)]
        if let Some(hook) = lock(&self.after_counting).take() {
            hook();
        }
        // The counts are cached only when no commit landed between the first
        // generation read and now: SAG-Wiki reads its version inside the
        // counting transaction, and re-reading here gives the same guarantee
        // (the counts belong to `generation`). The cache must also still be
        // on that generation — a concurrent call may have moved it on.
        let unchanged = self.generation()? == generation;
        let mut cache = lock(&self.df);
        let store = unchanged && cache.generation == Some(generation);
        if store && cache.counts.len() + missing.len() > DF_CACHE_LIMIT {
            cache.counts.clear();
        }
        for (term, n) in counted.into_iter().flatten() {
            if store {
                cache.counts.insert((level, term.to_string()), n);
            }
            out.insert(term.to_string(), n);
        }
        Ok(out)
    }

    /// One worker's share of [`Self::frequencies`], in one read transaction.
    fn count_terms<'t>(
        &self,
        worker: usize,
        terms: impl Iterator<Item = &'t &'t str>,
        level: Level,
    ) -> Result<Vec<(&'t str, u64)>, String> {
        let mut conn = lock(&self.conns[worker]);
        let tx = conn.transaction().map_err(err)?;
        let mut results = Vec::new();
        {
            let mut stmt = tx.prepare_cached(FREQUENCY_SQL).map_err(err)?;
            for &term in terms {
                let n: i64 = stmt
                    .query_row(params![format!("tok_text : {}", quote(term)), level.as_str()], |r| r.get(0))
                    .map_err(err)?;
                results.push((term, n as u64));
            }
        }
        tx.commit().map_err(err)?;
        Ok(results)
    }

    /// An idle connection if there is one, else the first. Lets parallel
    /// callers (one query per required term, as SAG-Wiki
    /// `store.rs:candidate_queries` runs them) use every connection.
    fn any_conn(&self) -> MutexGuard<'_, Connection> {
        for conn in &self.conns {
            match conn.try_lock() {
                Ok(guard) => return guard,
                Err(TryLockError::Poisoned(e)) => return e.into_inner(),
                Err(TryLockError::WouldBlock) => {}
            }
        }
        lock(&self.conns[0])
    }

    /// Line-level BM25 candidates, `ORDER BY score, id` (spec H.3.3, H.3.5;
    /// SAG-Wiki `store.rs:candidate_query_on` / `query_candidate_metadata`).
    /// `required` restricts the rows without scoring: `bm25()` only sees the
    /// ranking expression, as `sag_bm25` only uses the ranking statistics.
    /// Source re-reading (`hydrate_candidate`) is the host's job.
    pub fn candidate_query(&self, q: &CandidateQuery<'_>) -> Result<Vec<SagRow>, String> {
        let mut sql = String::from(CANDIDATE_SQL);
        let mut args = vec![q.expression.to_string(), excluded_json(q.excluded)?];
        if let Some(required) = q.required {
            sql.push_str(REQUIRED_SQL);
            args.push(required.to_string());
        }
        crate::query::push_filters(q.filters, &mut sql, &mut args);
        sql.push_str(&format!(" ORDER BY score ASC, b.id ASC LIMIT {}", limit_sql(q.limit)));
        let conn = self.any_conn();
        let mut stmt = conn.prepare(&sql).map_err(err)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| {
                Ok(SagRow {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    line: r.get::<_, i64>(2)? as u32,
                    line_end: r.get::<_, i64>(3)? as u32,
                    breadcrumb: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    text: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    bm25: r.get(6)?,
                })
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
    }

    /// Whether any line-level block outside `excluded` matches `expression`
    /// under `filters` (SAG-Wiki `store.rs:has_candidate_match`).
    pub fn has_match(&self, expression: &str, filters: &crate::query::Query, excluded: &[i64]) -> Result<bool, String> {
        let mut sql = String::from(HAS_MATCH_SQL);
        let mut args = vec![expression.to_string(), excluded_json(excluded)?];
        crate::query::push_filters(filters, &mut sql, &mut args);
        sql.push_str(" LIMIT 1)");
        let conn = self.any_conn();
        conn.query_row(&sql, params_from_iter(args.iter()), |r| r.get(0)).map_err(err)
    }

    /// `files.confidentiality` for the given paths; the one implementation
    /// shared with `SearchIndex::confidentiality_for_paths`
    /// (`crate::confidentiality_on`), run on this reader's connection
    /// so the main index lock is not taken. Unknown paths are absent.
    pub fn confidentiality_for_paths(&self, paths: &[&str]) -> Result<HashMap<String, String>, String> {
        crate::confidentiality_on(&self.any_conn(), paths)
    }

    /// File titles and wiki targets for the alias table (spec H.3.1; the
    /// index-side half of SAG-Wiki `store.rs:retrieval_statistics`), read in
    /// one transaction. A wiki target keeps only the part before `#`, as the
    /// H.3.4 wiki pattern `\[\[([^\]\|#]+)…` captures it.
    pub fn alias_sources(&self) -> Result<AliasSources, String> {
        let mut conn = self.any_conn();
        let tx = conn.transaction().map_err(err)?;
        let files = {
            let mut stmt = tx.prepare("SELECT path, title, ext FROM files ORDER BY path").map_err(err)?;
            let rows = stmt
                .query_map([], |r| Ok(FileTitle { path: r.get(0)?, title: r.get(1)?, ext: r.get(2)? }))
                .map_err(err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?
        };
        let wiki_targets = {
            let mut stmt = tx
                .prepare("SELECT DISTINCT target FROM links WHERE kind = 'wiki' ORDER BY target")
                .map_err(err)?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
            let mut targets = BTreeSet::new();
            for target in rows {
                let target = target.map_err(err)?;
                let page = target.split('#').next().unwrap_or("").trim();
                if !page.is_empty() {
                    targets.insert(page.to_string());
                }
            }
            targets.into_iter().collect()
        };
        tx.commit().map_err(err)?;
        Ok(AliasSources { files, wiki_targets })
    }
}

/// Bytes of each file read when looking for its frontmatter (spec H.3.1).
const FRONTMATTER_READ_LIMIT: u64 = 64 * 1024;

/// Reads at most the first 64 KiB of each listed markdown file; files that fail to read are skipped.
///
/// Returns `(path, aliases)` in input order, with an empty list for a file
/// without frontmatter `aliases` or whose frontmatter does not close within
/// the first 64 KiB. Bytes are decoded and line endings normalised as the
/// indexer does (`scan.rs:index_one`, `chunk.rs:parse_file`).
pub fn frontmatter_aliases(root: &Path, md_paths: &[String]) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::with_capacity(md_paths.len());
    for rel in md_paths {
        let mut bytes = Vec::new();
        let read = std::fs::File::open(root.join(rel))
            .and_then(|f| f.take(FRONTMATTER_READ_LIMIT).read_to_end(&mut bytes));
        if read.is_err() {
            continue;
        }
        let raw = String::from_utf8_lossy(&bytes);
        let text = crate::norm::strip_cr(&raw);
        let aliases = match crate::frontmatter::split(&text) {
            (Some(fm), _, _) => crate::frontmatter::parse(fm).aliases,
            (None, _, _) => Vec::new(),
        };
        out.push((rel.clone(), aliases));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::{parse, Query};
    use crate::{ScanOptions, SearchIndex};
    use std::path::PathBuf;
    use std::sync::OnceLock;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|x| x.to_string()).collect()
    }

    fn no_filters() -> &'static Query {
        static EMPTY: OnceLock<Query> = OnceLock::new();
        EMPTY.get_or_init(Query::default)
    }

    fn q<'a>(expression: &'a str, required: Option<&'a str>, excluded: &'a [i64], limit: usize) -> CandidateQuery<'a> {
        CandidateQuery { expression, required, filters: no_filters(), excluded, limit }
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        index: SearchIndex,
        reader: SagReader,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "alpha beta\n\nalpha gamma\n").unwrap();
        std::fs::write(root.join("b.md"), "---\ntitle: Bee\naliases: [B1, 别名]\n---\nbeta [[Target Page|tp]]\n").unwrap();
        let db = dir.path().join("i.db");
        let mut index = SearchIndex::open_at(&root, &db, "").unwrap();
        for rel in ["a.md", "b.md"] {
            index.index_one(rel, &ScanOptions::default()).unwrap();
        }
        let reader = SagReader::open_existing_at(&root, &db, "", 2).unwrap();
        Fixture { _dir: dir, root, index, reader }
    }

    #[test]
    fn counts_line_and_file_blocks_and_frequencies() {
        let fx = fixture();
        let r = &fx.reader;
        assert_eq!(r.block_count(Level::Line).unwrap(), 3);
        assert_eq!(r.block_count(Level::File).unwrap(), 2);
        let f = r.frequencies(&s(&["alpha", "beta", "alpha beta", "zeta"]), Level::Line).unwrap();
        assert_eq!((f["alpha"], f["beta"], f["alpha beta"], f["zeta"]), (2, 2, 1, 0));
        let f = r.frequencies(&s(&["alpha", "beta"]), Level::File).unwrap();
        assert_eq!((f["alpha"], f["beta"]), (1, 2));
        // Second call is served from the cache and keys by level: same answers.
        let f = r.frequencies(&s(&["alpha", "alpha"]), Level::Line).unwrap();
        assert_eq!((f.len(), f["alpha"]), (1, 2));
    }

    #[test]
    fn candidate_query_is_line_level_bm25_then_id_with_exclusions_and_required() {
        let fx = fixture();
        let r = &fx.reader;
        let all = r.candidate_query(&q("\"alpha\" OR \"beta\"", None, &[], 10)).unwrap();
        assert!(all.iter().all(|row| row.line == row.line_end)); // 只有行级块
        assert_eq!(all.len(), 3);
        assert!(all.windows(2).all(|w| (w[0].bm25, w[0].id) <= (w[1].bm25, w[1].id)));
        let ex = r.candidate_query(&q("\"alpha\" OR \"beta\"", None, &[all[0].id], 10)).unwrap();
        assert!(!ex.iter().any(|row| row.id == all[0].id));
        let req = r.candidate_query(&q("\"alpha\" OR \"beta\"", Some("\"gamma\""), &[], 10)).unwrap();
        assert_eq!(req.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), vec!["alpha gamma"]);
        // 必含词不参与计分：与只用排序式时该行的 bm25 相同
        assert_eq!(req[0].bm25, all.iter().find(|x| x.text == "alpha gamma").unwrap().bm25);
        // LIMIT applies after ordering.
        let one = r.candidate_query(&q("\"alpha\" OR \"beta\"", None, &[], 1)).unwrap();
        assert_eq!(one, all[..1].to_vec());
    }

    #[test]
    fn has_match_respects_exclusions_and_filters() {
        let fx = fixture();
        let r = &fx.reader;
        assert!(r.has_match("\"gamma\"", no_filters(), &[]).unwrap());
        let gamma = r.candidate_query(&q("\"gamma\"", None, &[], 10)).unwrap();
        assert_eq!(gamma.len(), 1);
        assert!(!r.has_match("\"gamma\"", no_filters(), &[gamma[0].id]).unwrap());
        assert!(!r.has_match("\"alpha\"", &parse("path:b.md"), &[]).unwrap());
        assert!(r.has_match("\"alpha\"", &parse("path:a.md"), &[]).unwrap());
    }

    #[test]
    fn generation_changes_after_another_connection_commits() {
        let mut fx = fixture();
        let g0 = fx.reader.generation().unwrap();
        assert_eq!(fx.reader.generation().unwrap(), g0, "no commit, no change");
        std::fs::write(fx.root.join("a.md"), "alpha delta\n").unwrap();
        fx.index.index_one("a.md", &ScanOptions::default()).unwrap();
        assert_ne!(fx.reader.generation().unwrap(), g0);
        // The frequency cache belongs to the old generation and is dropped.
        let f = fx.reader.frequencies(&s(&["alpha", "delta"]), Level::Line).unwrap();
        assert_eq!((f["alpha"], f["delta"]), (1, 1));
    }

    #[test]
    fn frequencies_cache_is_invalidated_by_a_new_generation() {
        let mut fx = fixture();
        assert_eq!(fx.reader.frequencies(&s(&["alpha"]), Level::Line).unwrap()["alpha"], 2);
        std::fs::write(fx.root.join("a.md"), "alpha delta\n").unwrap();
        fx.index.index_one("a.md", &ScanOptions::default()).unwrap();
        assert_eq!(fx.reader.frequencies(&s(&["alpha"]), Level::Line).unwrap()["alpha"], 1);
    }

    #[test]
    fn alias_sources_and_frontmatter_aliases() {
        let fx = fixture();
        let a = fx.reader.alias_sources().unwrap();
        // Pre-flight P5: the index already falls back title → first H1 → file
        // stem (chunk.rs), so a.md's stored title is its stem.
        assert_eq!(
            a.files.iter().map(|f| (f.path.as_str(), f.title.as_deref())).collect::<Vec<_>>(),
            vec![("a.md", Some("a")), ("b.md", Some("Bee"))]
        );
        assert!(a.files.iter().all(|f| f.ext == "md"));
        assert_eq!(a.wiki_targets, vec!["Target Page".to_string()]);
        assert_eq!(
            frontmatter_aliases(&fx.root, &s(&["a.md", "b.md", "missing.md"])),
            vec![("a.md".into(), vec![]), ("b.md".into(), s(&["B1", "别名"]))]
        );
    }

    #[test]
    fn wiki_targets_drop_the_section_part_and_stay_distinct_and_sorted() {
        let mut fx = fixture();
        std::fs::write(fx.root.join("c.md"), "[[Zed#part]] [[Target Page#x|y]] [[#local]] [[Zed]]\n").unwrap();
        fx.index.index_one("c.md", &ScanOptions::default()).unwrap();
        assert_eq!(fx.reader.alias_sources().unwrap().wiki_targets, s(&["Target Page", "Zed"]));
    }

    #[test]
    fn frontmatter_aliases_only_look_at_the_first_64_kib() {
        let dir = tempfile::tempdir().unwrap();
        let late = format!("---\ntitle: x\n{}aliases: [Late]\n---\nbody\n", "k: v\n".repeat(64 * 1024 / 5));
        std::fs::write(dir.path().join("late.md"), late).unwrap();
        std::fs::write(dir.path().join("crlf.md"), "---\r\naliases:\r\n  - One\r\n  - Two\r\n---\r\nbody\r\n").unwrap();
        assert_eq!(
            frontmatter_aliases(dir.path(), &s(&["late.md", "crlf.md"])),
            vec![("late.md".into(), vec![]), ("crlf.md".into(), s(&["One", "Two"]))]
        );
    }

    #[test]
    fn confidentiality_is_read_from_the_files_table() {
        let mut fx = fixture();
        std::fs::write(fx.root.join("s.md"), "---\nprivate: true\n---\nsecret\n").unwrap();
        fx.index.index_one("s.md", &ScanOptions::default()).unwrap();
        let got = fx.reader.confidentiality_for_paths(&["s.md", "a.md", "gone.md"]).unwrap();
        assert_eq!(got.get("s.md").map(String::as_str), Some("confidential"));
        assert_eq!(got.get("a.md").map(String::as_str), Some("unknown"));
        assert!(!got.contains_key("gone.md"));
    }

    #[test]
    fn open_rejects_a_mismatched_globs_stamp_and_needs_no_built_at() {
        let fx = fixture();
        let db = fx._dir.path().join("i.db");
        // Pre-flight P6: an `index_one`-only index never sets `built_at`.
        assert!(SagReader::open_existing_at(&fx.root, &db, "", 1).is_ok());
        let err = SagReader::open_existing_at(&fx.root, &db, "other", 1).err().unwrap();
        assert!(err.starts_with("INDEX_NOT_READY"), "{err}");
    }

    /// Fix round 1: a commit landing between the first generation read and
    /// the cache store must leave nothing cached — the counts may belong to
    /// either side of the commit.
    #[test]
    fn frequencies_do_not_cache_counts_when_a_commit_lands_before_the_store() {
        let fx = fixture();
        let Fixture { _dir, root, mut index, reader } = fx;
        let rel_root = root.clone();
        *lock(&reader.after_counting) = Some(Box::new(move || {
            std::fs::write(rel_root.join("a.md"), "alpha delta\n").unwrap();
            index.index_one("a.md", &ScanOptions::default()).unwrap();
        }));
        let g0 = reader.generation().unwrap();
        let f = reader.frequencies(&s(&["alpha"]), Level::Line).unwrap();
        assert_eq!(f["alpha"], 2, "counted before the commit");
        assert_ne!(reader.generation().unwrap(), g0, "the hook committed");
        assert!(lock(&reader.df).counts.is_empty(), "nothing from a moved generation is cached");
        // The next call counts afresh under the new generation and caches it.
        assert_eq!(reader.frequencies(&s(&["alpha"]), Level::Line).unwrap()["alpha"], 1);
        assert_eq!(lock(&reader.df).counts.get(&(Level::Line, "alpha".to_string())), Some(&1));
    }

    /// Without a commit the counts are cached under the generation they were
    /// read at.
    #[test]
    fn frequencies_cache_counts_when_the_generation_is_unchanged() {
        let fx = fixture();
        let g = fx.reader.generation().unwrap();
        fx.reader.frequencies(&s(&["alpha", "beta"]), Level::File).unwrap();
        let cache = lock(&fx.reader.df);
        assert_eq!(cache.generation, Some(g));
        assert_eq!(cache.counts.get(&(Level::File, "alpha".to_string())), Some(&1));
        assert_eq!(cache.counts.get(&(Level::File, "beta".to_string())), Some(&2));
    }

    /// Pins `bm25(blocks_fts, 1.0, 2.0, 2.0)` (spec H.3.3; SAG-Wiki
    /// `sag_bm25(chunk_fts, stats, 2, 2, 1)`: title 2, heading 2, body 1).
    ///
    /// FTS5's bm25 adds the column weights into the term frequency before
    /// saturating it: one phrase scores `idf·x(k1+1)/(x+K)` with
    /// `x = Σ weight(column)·hits(column)` and `K = k1(1−b+b·D/avgdl)`, where
    /// `D` is the row's total length. Three line blocks with the same total
    /// length (3 tokens) and the same term therefore differ only in `x`:
    ///
    /// - `body`: term once in the body → `x = 1`
    /// - `heading`: term once in the breadcrumb → `x = 2`
    /// - `both`: once in each → `x = 3`
    ///
    /// `K` is solved from body/heading, and both/body must then equal
    /// `3(1+K)/(3+K)`. Any other weighting (swapped `2,2,1`, flat `1,1,1`,
    /// heading 3, …) breaks either the strict heading-first order or that
    /// equation.
    #[test]
    fn heading_matches_weigh_twice_body_matches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("h.md"), "# Omega\n\nfiller words\n").unwrap();
        std::fs::write(root.join("p.md"), "omega filler words\n").unwrap();
        std::fs::write(root.join("z.md"), "# Omega\n\nomega words\n").unwrap();
        let db = dir.path().join("i.db");
        let mut index = SearchIndex::open_at(&root, &db, "").unwrap();
        for rel in ["h.md", "p.md", "z.md"] {
            index.index_one(rel, &ScanOptions::default()).unwrap();
        }
        let r = SagReader::open_existing_at(&root, &db, "", 1).unwrap();
        let rows = r.candidate_query(&q("\"omega\"", None, &[], 10)).unwrap();
        let row = |text: &str| rows.iter().find(|x| x.text == text).unwrap_or_else(|| panic!("{text}: {rows:?}")).clone();
        let (heading, body, both) = (row("filler words"), row("omega filler words"), row("omega words"));
        assert_eq!((heading.breadcrumb.as_str(), body.breadcrumb.as_str(), both.breadcrumb.as_str()), ("Omega", "", "Omega"));
        assert!(heading.bm25 < body.bm25, "a heading match outranks a body-only match: {rows:?}");
        let pos = |id| rows.iter().position(|x| x.id == id).unwrap();
        assert!(pos(both.id) < pos(heading.id) && pos(heading.id) < pos(body.id));
        let ratio = body.bm25 / heading.bm25; // = (2+K) / (2(1+K))
        let k = (2.0 - 2.0 * ratio) / (2.0 * ratio - 1.0);
        assert!(k > 0.0, "K = {k}");
        let predicted = 3.0 * (1.0 + k) / (3.0 + k);
        let observed = both.bm25 / body.bm25;
        assert!((observed - predicted).abs() < 1e-9, "weights must be body 1, heading 2: {observed} vs {predicted}");
    }

    /// The title column (weight 2) is filled only on file-level blocks
    /// (`store.rs:replace_file`), so a title-only term never yields a
    /// line-level candidate — the accepted H.5 difference from SAG2, where
    /// every chunk carries its document title.
    #[test]
    fn a_title_only_match_is_not_a_line_candidate() {
        let fx = fixture();
        assert!(fx.reader.candidate_query(&q("\"bee\"", None, &[], 10)).unwrap().is_empty());
        assert!(!fx.reader.has_match("\"bee\"", no_filters(), &[]).unwrap());
        assert_eq!(fx.reader.frequencies(&s(&["bee"]), Level::File).unwrap()["bee"], 0, "df counts tok_text only");
    }

    #[test]
    fn candidate_query_applies_path_filters() {
        let fx = fixture();
        let only_b = parse("path:b.md");
        let rows = fx
            .reader
            .candidate_query(&CandidateQuery { expression: "\"alpha\" OR \"beta\"", required: None, filters: &only_b, excluded: &[], limit: 10 })
            .unwrap();
        assert_eq!(rows.iter().map(|x| (x.path.as_str(), x.text.as_str())).collect::<Vec<_>>(), vec![("b.md", "beta [[Target Page|tp]]")]);
        let only_a = parse("path:a.md");
        let rows = fx
            .reader
            .candidate_query(&CandidateQuery { expression: "\"alpha\" OR \"beta\"", required: Some("\"beta\""), filters: &only_a, excluded: &[], limit: 10 })
            .unwrap();
        assert_eq!(rows.iter().map(|x| x.text.as_str()).collect::<Vec<_>>(), vec!["alpha beta"]);
        let none = parse("path:zzz");
        assert!(fx.reader.candidate_query(&CandidateQuery { expression: "\"alpha\"", required: None, filters: &none, excluded: &[], limit: 10 }).unwrap().is_empty());
    }

    /// Both openers answer confidentiality through the one shared helper.
    #[test]
    fn reader_and_index_report_the_same_confidentiality() {
        let mut fx = fixture();
        std::fs::write(fx.root.join("s.md"), "---\nprivate: true\n---\nsecret\n").unwrap();
        fx.index.index_one("s.md", &ScanOptions::default()).unwrap();
        let paths = ["s.md", "a.md", "b.md", "gone.md"];
        assert_eq!(fx.reader.confidentiality_for_paths(&paths).unwrap(), fx.index.confidentiality_for_paths(&paths).unwrap());
    }

    #[test]
    fn alias_sources_are_comparable_and_clonable() {
        let fx = fixture();
        let a = fx.reader.alias_sources().unwrap();
        assert_eq!(a.clone(), a);
        assert_eq!(a.files[1], FileTitle { path: "b.md".into(), title: Some("Bee".into()), ext: "md".into() });
        assert!(format!("{a:?}").contains("Target Page"));
    }

    #[test]
    fn the_reader_is_shareable_across_threads() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<SagReader>();
    }

    #[test]
    fn free_text_drops_filter_tokens_and_keeps_phrases() {
        assert_eq!(crate::query::free_text("tag:x 张三 \"Bob Smith\" after:2026-01-01 born"), "张三 Bob Smith born");
        // Same classification as `parse`: an empty filter value is a term, an
        // unclosed quote degrades to a term, an empty phrase disappears.
        assert_eq!(crate::query::free_text("tag: \"\" ext:md \"unclosed"), "tag: unclosed");
    }

    /// Why the host builds every FTS phrase with its inner stop words kept
    /// (spec H.5 FTS 短语 row): `tok_text` stores every token, so a phrase with
    /// an inner stop word dropped is not adjacent and misses. Inside its edges
    /// the host's `fts_phrase` is `tokens(..).join(" ")`; its `sag_tokens`
    /// drops SAG2's stop words.
    #[test]
    fn phrases_match_only_with_the_stop_words_the_index_keeps() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("c.md"), "I read the lord of the rings\n\n我的世界\n\n读傲慢与偏见\n").unwrap();
        let db = dir.path().join("i.db");
        let mut index = SearchIndex::open_at(&root, &db, "").unwrap();
        index.index_one("c.md", &ScanOptions::default()).unwrap();
        let r = SagReader::open_existing_at(&root, &db, "", 1).unwrap();
        let phrase = |surface: &str| crate::tokenize::tokens(surface).join(" ");
        let kept = [phrase("lord of the rings"), phrase("我的世界"), phrase("傲慢与偏见")];
        assert_eq!(kept, ["lord of the rings", "我 的 世界", "傲慢 与 偏见"]);
        // Stop words dropped ("我 世界" drops only 的, as in the ledger ruling).
        let dropped = s(&["lord rings", "我 世界", "傲慢 偏见"]);
        for p in &kept {
            assert!(r.has_match(&quote(p), no_filters(), &[]).unwrap(), "{p}");
        }
        for p in &dropped {
            assert!(!r.has_match(&quote(p), no_filters(), &[]).unwrap(), "{p}");
        }
        let f = r.frequencies(&[kept.to_vec(), dropped.clone()].concat(), Level::Line).unwrap();
        assert_eq!(kept.iter().map(|p| f[p]).collect::<Vec<_>>(), vec![1, 1, 1]);
        assert_eq!(dropped.iter().map(|p| f[p]).collect::<Vec<_>>(), vec![0, 0, 0]);
    }
}
