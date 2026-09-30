//! Query-independent metadata snapshots. No source bytes or indexed block text
//! are read here; the host verifies current source hashes before serving units.
use crate::{
    query::{priority_factors, PriorityFactors, PriorityInput, Weights},
    Origin, SearchIndex,
};
use serde::Serialize;
use std::collections::HashMap;

/// Freeze the exact civil-day clock used by existing search/attention ranking.
pub fn as_of() -> String {
    crate::today()
}

pub const POLICY_VERSION: &str = "index-priority-v1/nonoverlap-v1/date-doc-inclusive-v1";
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitRef {
    pub block_key: String,
    pub line_start: u32,
    pub line_end: u32,
    pub breadcrumb: String,
    pub level: String,
    pub is_annotation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_by: Option<String>,
    pub priority: f64,
    pub priority_factors: PriorityFactors,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorityBasis {
    pub aggregation: &'static str,
    pub block_key: String,
    pub factors: PriorityFactors,
}
#[derive(Debug, Clone, Serialize)]
pub struct Link {
    pub kind: String,
    pub target: String,
    pub line: u32,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub file_key: String,
    pub path: String,
    pub content_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concept_type: Option<String>,
    pub tags: Vec<String>,
    pub doc_date: Option<String>,
    pub date_inferred: bool,
    pub index_origin: String,
    pub human_verified: bool,
    pub confidentiality: String,
    pub attention_minutes: f64,
    pub links: Vec<Link>,
    pub file_priority: f64,
    pub priority_basis: Option<PriorityBasis>,
    #[serde(skip)]
    pub units: Vec<UnitRef>,
    #[serde(skip)]
    pub mtime: i64,
    #[serde(skip)]
    pub size: u64,
}
pub struct Capture {
    pub files: Vec<File>,
    pub indexed: usize,
    pub undated: usize,
    pub generation: String,
}

impl SearchIndex {
    /// Read-only open for plugin/CLI metadata browsing. Unlike the normal index
    /// opener this never creates, repairs, rebuilds or reads Vault source files.
    pub fn open_existing_at(
        root: &std::path::Path,
        db: &std::path::Path,
        globs: &str,
    ) -> Result<Self, String> {
        let conn =
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| format!("INDEX_NOT_READY: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        for (key, expected) in [
            ("schema_version", crate::store::SCHEMA_VERSION.to_string()),
            ("tokenizer_id", crate::tokenize::TOKENIZER_ID.to_string()),
            ("source_globs", globs.to_string()),
            ("vault_root", crate::paths::normalized_vault_root(root)),
        ] {
            let actual: String = conn
                .query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))
                .map_err(|_| "INDEX_NOT_READY: rebuild index first")?;
            if actual != expected {
                return Err("INDEX_NOT_READY: rebuild index first".into());
            }
        }
        if crate::store::meta_get(&conn, "built_at").is_none() {
            return Err("INDEX_NOT_READY: initial build incomplete".into());
        }
        Ok(Self {
            conn,
            vault_root: root.to_path_buf(),
            db_path: db.to_path_buf(),
        })
    }

    /// One short SQLite read transaction freezes all rows against concurrent
    /// CLI/watcher writes. Bounds stop an unbounded metadata allocation.
    pub fn capture_metadata(
        &mut self,
        from: Option<&str>,
        to: Option<&str>,
        as_of: &str,
        weights: &Weights,
    ) -> Result<Capture, String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        // GUI handles may survive a failed initial build. Check its completion
        // marker in the same read transaction as the metadata, including for
        // legitimately empty vaults; a row count does not prove completion.
        if crate::store::meta_get(&tx, "built_at").is_none() {
            return Err("INDEX_NOT_READY: initial build incomplete".into());
        }
        let indexed: usize = tx
            .query_row("SELECT count(*) FROM files", [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())? as usize;
        let undated: usize = tx
            .query_row(
                "SELECT count(*) FROM files WHERE doc_date IS NULL",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())? as usize;
        let mut files = Vec::new();
        let mut ids = HashMap::new();
        let mut retained_bytes = 0usize;
        {
            let mut stmt = tx.prepare("SELECT f.id,f.path,f.content_hash,f.title,f.concept_type,f.tags_json,f.doc_date,f.date_inferred,f.origin,f.human_verified,f.confidentiality,f.mtime,f.size,coalesce(a.minutes,0),a.as_of FROM files f LEFT JOIN doc_attention a ON a.path=f.path WHERE (?1 IS NULL OR f.doc_date>=?1) AND (?2 IS NULL OR f.doc_date<=?2) ORDER BY f.path").map_err(|e| e.to_string())?;
            let mut rows = stmt
                .query(rusqlite::params![from, to])
                .map_err(|e| e.to_string())?;
            while let Some(r) = rows.next().map_err(|e| e.to_string())? {
                if files.len() >= 50_000 {
                    return Err("SNAPSHOT_LIMIT: more than 50000 files".into());
                }
                let path: String = r.get(1).map_err(|e| e.to_string())?;
                let raw_minutes: f64 = r.get(13).unwrap_or(0.0);
                let attention_date: Option<String> = r.get(14).unwrap_or(None);
                let age = attention_date
                    .as_deref()
                    .and_then(|d| crate::query::days_between(d, as_of))
                    .unwrap_or(0);
                let file = File {
                    file_key: crate::norm::content_hash(path.as_bytes()),
                    path,
                    content_hash: r.get(2).map_err(|e| e.to_string())?,
                    title: r.get(3).map_err(|e| e.to_string())?,
                    concept_type: r.get(4).map_err(|e| e.to_string())?,
                    tags: serde_json::from_str(&r.get::<_, String>(5).unwrap_or_default())
                        .unwrap_or_default(),
                    doc_date: r.get(6).map_err(|e| e.to_string())?,
                    date_inferred: r.get(7).unwrap_or(false),
                    index_origin: r.get(8).map_err(|e| e.to_string())?,
                    human_verified: r.get(9).unwrap_or(false),
                    confidentiality: r.get(10).map_err(|e| e.to_string())?,
                    mtime: r.get(11).unwrap_or(0),
                    size: r.get::<_, i64>(12).unwrap_or(0).max(0) as u64,
                    attention_minutes: raw_minutes.max(0.0) * crate::attention::decay(age),
                    links: vec![],
                    units: vec![],
                    file_priority: 0.0,
                    priority_basis: None,
                };
                retained_bytes += serde_json::to_vec(&file).map_err(|e| e.to_string())?.len();
                if retained_bytes > 32 * 1024 * 1024 {
                    return Err("SNAPSHOT_LIMIT: metadata exceeds 32 MiB".into());
                }
                ids.insert(r.get::<_, i64>(0).map_err(|e| e.to_string())?, files.len());
                files.push(file);
            }
        }
        {
            // Select leaf semantics, never the overlapping File/Section rollups.
            let mut stmt = tx.prepare("SELECT b.file_id,b.line_start,b.line_end,b.breadcrumb,b.level,b.is_annotation,b.agent_by FROM blocks b JOIN files f ON f.id=b.file_id WHERE b.level='line' AND (?1 IS NULL OR f.doc_date>=?1) AND (?2 IS NULL OR f.doc_date<=?2) ORDER BY b.file_id,b.line_start,b.line_end,b.id").map_err(|e|e.to_string())?;
            let mut rows = stmt
                .query(rusqlite::params![from, to])
                .map_err(|e| e.to_string())?;
            let mut unit_count = 0;
            while let Some(r) = rows.next().map_err(|e| e.to_string())? {
                let id: i64 = r.get(0).map_err(|e| e.to_string())?;
                let Some(&i) = ids.get(&id) else { continue };
                let file = &mut files[i];
                let start: u32 = r.get(1).unwrap_or(0);
                let end: u32 = r.get(2).unwrap_or(0);
                if start == 0 || end < start {
                    continue;
                }
                let is_annotation = r.get(5).unwrap_or(false);
                let agent_by: Option<String> = r.get(6).unwrap_or(None);
                let factors = priority_factors(
                    PriorityInput {
                        level: "line",
                        is_annotation,
                        human_verified: file.human_verified,
                        origin: Origin::from_str(&file.index_origin).unwrap_or(Origin::Unlabeled),
                        attention_minutes: file.attention_minutes,
                        agent_authored: agent_by.is_some(),
                        doc_date: file.doc_date.as_deref(),
                    },
                    as_of,
                    weights,
                );
                let unit = UnitRef {
                    block_key: String::new(),
                    line_start: start,
                    line_end: end,
                    breadcrumb: r.get(3).unwrap_or_default(),
                    level: "line".into(),
                    is_annotation,
                    agent_by,
                    priority: factors.apply(1.0),
                    priority_factors: factors,
                };
                // A parser may emit overlapping leaf ranges (e.g. nested lists).
                // Their union is one source interval; retain the strongest basis.
                if let Some(last) = file.units.last_mut().filter(|last| start <= last.line_end) {
                    last.line_end = last.line_end.max(end);
                    if unit.priority > last.priority {
                        last.priority = unit.priority;
                        last.priority_factors = unit.priority_factors;
                        last.is_annotation = unit.is_annotation;
                        last.agent_by = unit.agent_by;
                    }
                } else {
                    retained_bytes +=
                        unit.breadcrumb.len() + unit.agent_by.as_ref().map_or(0, String::len) + 256;
                    unit_count += 1;
                    if unit_count > 500_000 || retained_bytes > 32 * 1024 * 1024 {
                        return Err("SNAPSHOT_LIMIT: unit metadata exceeds budget".into());
                    }
                    file.units.push(unit);
                }
            }
        }
        {
            let mut stmt = tx.prepare("SELECT l.file_id,l.kind,l.target,l.line FROM links l JOIN files f ON f.id=l.file_id WHERE (?1 IS NULL OR f.doc_date>=?1) AND (?2 IS NULL OR f.doc_date<=?2) ORDER BY l.file_id,l.line,l.kind,l.target").map_err(|e|e.to_string())?;
            let mut rows = stmt
                .query(rusqlite::params![from, to])
                .map_err(|e| e.to_string())?;
            while let Some(r) = rows.next().map_err(|e| e.to_string())? {
                let Some(&i) = ids.get(&r.get::<_, i64>(0).map_err(|e| e.to_string())?) else {
                    continue;
                };
                let link = Link {
                    kind: r.get(1).map_err(|e| e.to_string())?,
                    target: r.get(2).map_err(|e| e.to_string())?,
                    line: r.get(3).unwrap_or(0),
                };
                retained_bytes += link.kind.len() + link.target.len() + 32;
                if retained_bytes > 32 * 1024 * 1024 {
                    return Err("SNAPSHOT_LIMIT: link metadata exceeds budget".into());
                }
                files[i].links.push(link);
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        for file in &mut files {
            for unit in &mut file.units {
                unit.block_key = crate::norm::content_hash(
                    format!(
                        "{}\0{}\0{}:{}:line",
                        file.path, file.content_hash, unit.line_start, unit.line_end
                    )
                    .as_bytes(),
                );
                if file.priority_basis.is_none()
                    || unit.priority > file.file_priority
                    || (unit.priority == file.file_priority
                        && unit.block_key < file.priority_basis.as_ref().unwrap().block_key)
                {
                    file.file_priority = unit.priority;
                    file.priority_basis = Some(PriorityBasis {
                        aggregation: "max_nonoverlap_unit",
                        block_key: unit.block_key.clone(),
                        factors: unit.priority_factors,
                    });
                }
            }
        }
        files.sort_by(|a, b| a.file_key.cmp(&b.file_key));
        let generation =
            crate::norm::content_hash(&serde_json::to_vec(&files).map_err(|e| e.to_string())?);
        Ok(Capture {
            files,
            indexed,
            undated,
            generation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_requires_completed_build_but_allows_built_empty_index() {
        let root = tempfile::tempdir().unwrap();
        let mut index =
            SearchIndex::open_at(root.path(), &root.path().join(".index.db"), "").unwrap();
        assert!(matches!(
            index.capture_metadata(None, None, "2026-09-30", &Weights::default()),
            Err(e) if e.starts_with("INDEX_NOT_READY")
        ));

        index.ensure_built(&crate::ScanOptions::default()).unwrap();
        let capture = index
            .capture_metadata(None, None, "2026-09-30", &Weights::default())
            .unwrap();
        assert_eq!(capture.indexed, 0);
        assert!(capture.files.is_empty());

        std::fs::write(root.path().join("2026-09-30-note.md"), "# Note\n\nEvidence.\n").unwrap();
        index.rebuild(&crate::ScanOptions::default()).unwrap();
        index.conn.execute("DELETE FROM meta WHERE key='built_at'", []).unwrap();
        assert!(matches!(
            index.capture_metadata(None, None, "2026-09-30", &Weights::default()),
            Err(e) if e.starts_with("INDEX_NOT_READY")
        ));
    }

    fn fixture() -> (tempfile::TempDir, SearchIndex) {
        let root = tempfile::tempdir().unwrap();
        for (path,body) in [("2026-09-01-a.md","---\ntype: insight\nprivate: true\n---\n# First\n\nUnique secret evidence A.\n\n- Item\n  - Nested\n"),("2026-09-30-b.md","---\nconfidentiality: explicitly_public\n---\n# Last\n\nUnique secret evidence B.\n"),("2026-10-01-c.md","# Next\n\nOutside range.\n")] {
            std::fs::write(root.path().join(path),body).unwrap();
        }
        let mut index =
            SearchIndex::open_at(root.path(), &root.path().join(".index.db"), "").unwrap();
        index.ensure_built(&crate::ScanOptions::default()).unwrap();
        (root, index)
    }
    #[test]
    fn inclusive_dates_metadata_only_and_leafs_do_not_overlap() {
        let (_root, mut index) = fixture();
        let capture = index
            .capture_metadata(
                Some("2026-09-01"),
                Some("2026-09-30"),
                "2026-09-30",
                &Weights::default(),
            )
            .unwrap();
        assert_eq!(capture.indexed, 3);
        assert_eq!(capture.files.len(), 2);
        let json = serde_json::to_string(&capture.files).unwrap();
        assert!(!json.contains("Unique secret"));
        assert!(!json.contains("breadcrumb"));
        assert!(json.contains("confidential"));
        assert!(json.contains("explicitly_public"));
        for file in &capture.files {
            assert!(file
                .units
                .windows(2)
                .all(|w| w[0].line_end < w[1].line_start));
            assert!(file.units.iter().all(|u| u.level == "line"));
            assert_eq!(
                file.file_priority,
                file.units.iter().map(|u| u.priority).fold(0.0, f64::max)
            );
        }
    }
    #[test]
    fn frozen_values_keys_and_generation_survive_sql_row_rebuild() {
        let (root, mut index) = fixture();
        let weights = Weights::default();
        let before = index
            .capture_metadata(None, None, "2026-09-30", &weights)
            .unwrap();
        index.rebuild(&crate::ScanOptions::default()).unwrap();
        let after = index
            .capture_metadata(None, None, "2026-09-30", &weights)
            .unwrap();
        assert_eq!(before.generation, after.generation);
        assert_eq!(
            before.files.iter().map(|f| &f.file_key).collect::<Vec<_>>(),
            after.files.iter().map(|f| &f.file_key).collect::<Vec<_>>()
        );
        std::fs::write(
            root.path().join("2026-09-01-a.md"),
            "# Modified\n\nNew evidence.\n",
        )
        .unwrap();
        index.rebuild(&crate::ScanOptions::default()).unwrap();
        let updated = index
            .capture_metadata(None, None, "2026-09-30", &weights)
            .unwrap();
        assert_ne!(before.generation, updated.generation);
        assert_eq!(
            before.files.iter().map(|f| &f.file_key).collect::<Vec<_>>(),
            updated
                .files
                .iter()
                .map(|f| &f.file_key)
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn readonly_open_refuses_missing_wrong_schema_and_incomplete_without_wiping() {
        let (root, index) = fixture();
        let db = root.path().join(".index.db");
        assert!(SearchIndex::open_existing_at(root.path(), &db, "").is_ok());
        assert!(
            SearchIndex::open_existing_at(root.path(), &root.path().join("missing.db"), "")
                .is_err()
        );
        assert!(!root.path().join("missing.db").exists());
        crate::store::meta_set(&index.conn, "schema_version", "6").unwrap();
        assert!(SearchIndex::open_existing_at(root.path(), &db, "").is_err());
        assert_eq!(
            crate::store::meta_get(&index.conn, "schema_version").as_deref(),
            Some("6")
        );
        assert_eq!(
            index
                .conn
                .query_row("SELECT count(*) FROM files", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
}
