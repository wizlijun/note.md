//! Relational, durable raw health records. Large payloads are stored once per record.
use crate::store::{
    AccountState, AttachmentRef, Coverage, Day, LibraryMetadata, Shard, SourceState,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS days(day TEXT PRIMARY KEY,sha256 TEXT NOT NULL,record_count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shards(day TEXT NOT NULL,source TEXT NOT NULL,metric TEXT NOT NULL,category TEXT NOT NULL,sha256 TEXT NOT NULL,record_count INTEGER NOT NULL,PRIMARY KEY(day,source,metric,category));
CREATE TABLE IF NOT EXISTS sources(source TEXT PRIMARY KEY,input_sha256 TEXT,export_date TEXT);
CREATE TABLE IF NOT EXISTS accounts(source TEXT NOT NULL,account_id TEXT NOT NULL,region TEXT,label TEXT,PRIMARY KEY(source,account_id));
CREATE TABLE IF NOT EXISTS coverage(source TEXT NOT NULL,account_id TEXT NOT NULL,collection TEXT NOT NULL,day TEXT NOT NULL,status TEXT NOT NULL,error TEXT,record_count INTEGER NOT NULL,PRIMARY KEY(source,account_id,collection,day));
CREATE TABLE IF NOT EXISTS attachments(path TEXT PRIMARY KEY,source TEXT NOT NULL,account_id TEXT,sha256 TEXT NOT NULL,collection TEXT);
CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY,day TEXT NOT NULL,source TEXT NOT NULL,metric TEXT NOT NULL,category TEXT NOT NULL,account_id TEXT,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_by_day ON records(day,source,metric,category,id);
CREATE INDEX IF NOT EXISTS records_by_source ON records(source,day,metric,category,id);
CREATE INDEX IF NOT EXISTS records_by_metric ON records(metric,day,source,category,id);
CREATE INDEX IF NOT EXISTS records_by_category ON records(category,day,source,metric,id);
CREATE INDEX IF NOT EXISTS records_by_account ON records(account_id,day,source,metric,category,id);
";
pub(crate) fn initialize(path: &Path) -> Result<()> {
    // Reserve the exact file; a concurrent or existing library must never be overwritten.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(err)?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(err)?;
    db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
        .map_err(err)?;
    db.execute_batch(SCHEMA).map_err(err)?;
    db.execute_batch("PRAGMA user_version=1; PRAGMA application_id=1313360945;")
        .map_err(err)?;
    Ok(())
}
pub(crate) fn open(path: &Path, write: bool) -> Result<Connection> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(path, flags).map_err(err)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(err)?;
    let version: i64 = match db.query_row("PRAGMA user_version", [], |r| r.get(0)) {
        Ok(version) => version,
        Err(rusqlite::Error::SqliteFailure(code, _))
            if !write && code.extended_code == rusqlite::ffi::SQLITE_READONLY_ROLLBACK =>
        {
            // After an interrupted write, SQLite must roll back its hot journal
            // before even a read can proceed. Recover only this precise condition;
            // ordinary queries remain read-only and missing files are never created.
            drop(db);
            drop(open(path, true)?);
            return open(path, false);
        }
        Err(error) => return Err(err(error)),
    };
    let application_id: i64 = db
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .map_err(err)?;
    if version != 1 || application_id != 1313360945 {
        return Err("Unsupported health SQLite schema version".into());
    }
    if write {
        db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
            .map_err(err)?;
    }
    Ok(db)
}
pub(crate) fn load(db: &Connection) -> Result<Option<LibraryMetadata>> {
    let initialized: Option<String> = db
        .query_row("SELECT value FROM metadata WHERE key='header'", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)?;
    let Some(header) = initialized else {
        return Ok(None);
    };
    let mut m: LibraryMetadata = serde_json::from_str(&header).map_err(err)?;
    let mut stmt = db
        .prepare("SELECT day,sha256,record_count FROM days ORDER BY day")
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    while let Some(r) = rows.next().map_err(err)? {
        m.days.insert(
            r.get(0).map_err(err)?,
            Day {
                sha256: r.get(1).map_err(err)?,
                record_count: u64::try_from(r.get::<_, i64>(2).map_err(err)?).map_err(err)?,
                shards: vec![],
            },
        );
    }
    let mut stmt=db.prepare("SELECT day,source,metric,category,sha256,record_count FROM shards ORDER BY day,source,metric,category").map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    while let Some(r) = rows.next().map_err(err)? {
        let day: String = r.get(0).map_err(err)?;
        m.days
            .get_mut(&day)
            .ok_or("Orphan database shard")?
            .shards
            .push(Shard {
                source: r.get(1).map_err(err)?,
                metric: r.get(2).map_err(err)?,
                category: r.get(3).map_err(err)?,
                sha256: r.get(4).map_err(err)?,
                record_count: u64::try_from(r.get::<_, i64>(5).map_err(err)?).map_err(err)?,
            });
    }
    let mut stmt = db
        .prepare("SELECT source,input_sha256,export_date FROM sources")
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    while let Some(r) = rows.next().map_err(err)? {
        m.sources.insert(
            r.get(0).map_err(err)?,
            SourceState {
                input_sha256: r.get(1).map_err(err)?,
                export_date: r.get(2).map_err(err)?,
                ..Default::default()
            },
        );
    }
    let mut stmt = db
        .prepare("SELECT source,account_id,region,label FROM accounts")
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    while let Some(r) = rows.next().map_err(err)? {
        let source: String = r.get(0).map_err(err)?;
        let region: Option<String> = r.get(2).map_err(err)?;
        m.sources
            .get_mut(&source)
            .ok_or("Orphan account")?
            .accounts
            .insert(
                r.get(1).map_err(err)?,
                AccountState {
                    label: r.get(3).map_err(err)?,
                    garmin_region: region
                        .map(|v| serde_json::from_str(&v))
                        .transpose()
                        .map_err(err)?,
                    ..Default::default()
                },
            );
    }
    let mut stmt = db
        .prepare("SELECT source,account_id,collection,day,status,error,record_count FROM coverage")
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    while let Some(r) = rows.next().map_err(err)? {
        let source: String = r.get(0).map_err(err)?;
        let account: String = r.get(1).map_err(err)?;
        let state = m.sources.get_mut(&source).ok_or("Orphan coverage")?;
        let collections = &mut state
            .accounts
            .get_mut(&account)
            .ok_or("Coverage requires an existing account")?
            .collections;
        collections
            .entry(r.get(2).map_err(err)?)
            .or_default()
            .insert(
                r.get(3).map_err(err)?,
                Coverage {
                    status: r.get(4).map_err(err)?,
                    error: r.get(5).map_err(err)?,
                    record_count: u64::try_from(r.get::<_, i64>(6).map_err(err)?).map_err(err)?,
                },
            );
    }
    let mut stmt = db
        .prepare("SELECT path,source,account_id,sha256,collection FROM attachments")
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    while let Some(r) = rows.next().map_err(err)? {
        m.attachments.insert(
            r.get(0).map_err(err)?,
            AttachmentRef {
                source: r.get(1).map_err(err)?,
                account_id: r.get(2).map_err(err)?,
                sha256: r.get(3).map_err(err)?,
                collection: r.get(4).map_err(err)?,
            },
        );
    }
    Ok(Some(m))
}
pub(crate) fn commit(
    db: &mut Connection,
    m: &LibraryMetadata,
    candidate: &Path,
    touched: &BTreeSet<String>,
) -> Result<()> {
    db.execute(
        "ATTACH DATABASE ?1 AS candidate",
        [candidate.to_string_lossy().as_ref()],
    )
    .map_err(err)?;
    let tx = db.transaction().map_err(err)?;
    for day in touched {
        tx.execute("DELETE FROM records WHERE day=?1", [day])
            .map_err(err)?;
        tx.execute("INSERT INTO records(day,source,metric,category,account_id,payload) SELECT day,source,metric,category,CASE WHEN source IN ('garmin','oura') THEN json_extract(payload,'$.attributes.accountId') END,payload FROM candidate.records WHERE day=?1 ORDER BY source,metric,category,payload",[day]).map_err(err)?;
    }
    tx.execute_batch("DELETE FROM days; DELETE FROM shards; DELETE FROM sources; DELETE FROM accounts; DELETE FROM coverage; DELETE FROM attachments;").map_err(err)?;
    for (day, entry) in &m.days {
        tx.execute(
            "INSERT INTO days VALUES(?1,?2,?3)",
            params![
                day,
                entry.sha256,
                i64::try_from(entry.record_count).map_err(err)?
            ],
        )
        .map_err(err)?;
        for shard in &entry.shards {
            tx.execute(
                "INSERT INTO shards VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    day,
                    shard.source,
                    shard.metric,
                    shard.category,
                    shard.sha256,
                    i64::try_from(shard.record_count).map_err(err)?
                ],
            )
            .map_err(err)?;
        }
    }
    for (source, state) in &m.sources {
        tx.execute(
            "INSERT INTO sources VALUES(?1,?2,?3)",
            params![source, state.input_sha256, state.export_date],
        )
        .map_err(err)?;
        fn coverage(
            tx: &rusqlite::Transaction<'_>,
            source: &str,
            account: &str,
            collections: &BTreeMap<String, BTreeMap<String, Coverage>>,
        ) -> Result<()> {
            for (collection, dates) in collections {
                for (day, c) in dates {
                    tx.execute(
                        "INSERT INTO coverage VALUES(?1,?2,?3,?4,?5,?6,?7)",
                        params![
                            source,
                            account,
                            collection,
                            day,
                            c.status,
                            c.error,
                            i64::try_from(c.record_count).map_err(err)?
                        ],
                    )
                    .map_err(err)?;
                }
            }
            Ok(())
        }
        for (id, a) in &state.accounts {
            tx.execute(
                "INSERT INTO accounts VALUES(?1,?2,?3,?4)",
                params![
                    source,
                    id,
                    a.garmin_region.map(|v| serde_json::to_string(&v).unwrap()),
                    a.label
                ],
            )
            .map_err(err)?;
            coverage(&tx, source, id, &a.collections)?;
        }
    }
    for (path, a) in &m.attachments {
        tx.execute(
            "INSERT INTO attachments VALUES(?1,?2,?3,?4,?5)",
            params![path, a.source, a.account_id, a.sha256, a.collection],
        )
        .map_err(err)?;
    }
    // The header contains only constant-size import metadata, never record/day/account indexes.
    let mut header = m.clone();
    header.days.clear();
    header.sources.clear();
    header.attachments.clear();
    tx.execute(
        "INSERT OR REPLACE INTO metadata VALUES('header',?1)",
        [serde_json::to_string(&header).map_err(err)?],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(())
}
