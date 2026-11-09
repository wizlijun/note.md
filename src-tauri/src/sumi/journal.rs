//! Minimal host-owned crash journal. No projection, sync, or document rendering.
//! An accepted edit is committed here before it is sent to the plugin process.
use super::{CommitReceipt, LocalEdit, Request, Result};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use std::{fs::{File, OpenOptions}, path::Path, sync::Mutex};

pub(super) struct Journal {
    connection: Mutex<Connection>,
    // A second host must not replay or append the same workspace concurrently.
    _lock: File,
}
fn error(error: impl std::fmt::Display) -> String {
    format!("本机输入保护日志不可用，修改尚未获得安全确认：{error}")
}
pub(super) fn receipt(request: &Request) -> Result<CommitReceipt> {
    let (remote, edit) = match request {
        Request::CommitLocal(edit) | Request::ImportLocal { edit, .. } => (false, edit.clone()),
        Request::CommitRemote { incoming, generation, revision } => (true, LocalEdit {
            page_id: incoming.page_id.clone(), epoch: incoming.epoch, generation: *generation,
            revision: *revision, op_id: incoming.op_id.clone(), update: incoming.update.clone(), first_write_date: None,
        }),
        _ => return Err("操作不具备可重放的持久身份".into()),
    };
    let observed = match request { Request::ImportLocal { observed, .. } => Some(observed), _ => None };
    sumi_protocol::durability::edit_receipt(&edit, remote, observed)
}
impl Journal {
    pub(super) fn open(path: &Path) -> Result<Self> {
        let parent = path.parent().ok_or("输入保护日志路径无父目录")?;
        std::fs::create_dir_all(parent).map_err(error)?;
        let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(path.with_extension("lock")).map_err(error)?;
        lock.try_lock_exclusive().map_err(|e| error(format!("另一宿主可能正在使用此写作空间：{e}")))?;
        let connection = Connection::open(path).map_err(error)?;
        connection.busy_timeout(std::time::Duration::from_millis(250)).map_err(error)?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).map_err(error)?;
        if !(0..=1).contains(&version) { return Err(error("输入保护日志版本不兼容；保留原文件")); }
        // WAL + FULL flushes each commit before the positive edit ACK. On macOS,
        // fullfsync also flushes drive caches; checkpoints retain that guarantee.
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;
            CREATE TABLE IF NOT EXISTS host_input_journal (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                op_id TEXT NOT NULL UNIQUE,
                payload BLOB NOT NULL,
                payload_sha256 TEXT NOT NULL,
                receipt BLOB NOT NULL
            ); PRAGMA user_version=1;").map_err(error)?;
        // The schema/version write above creates the WAL before accepting input.
        // Persist its new directory entry too, including on the first-ever open.
        let mut wal = path.as_os_str().to_os_string(); wal.push("-wal");
        File::open(std::path::PathBuf::from(wal)).and_then(|file| file.sync_all()).map_err(error)?;
        File::open(parent).and_then(|directory| directory.sync_all()).map_err(error)?;
        Ok(Self { connection: Mutex::new(connection), _lock: lock })
    }
    /// Keep append and queue publication in the same lock, preserving FIFO order
    /// across producers. The callback runs only after the SQLite commit succeeds.
    pub(super) fn append_then<T>(&self, request: &Request, publish: impl FnOnce() -> T) -> Result<T> {
        let receipt = receipt(request)?;
        let payload = serde_json::to_vec(request).map_err(error)?;
        let encoded_receipt = serde_json::to_vec(&receipt).map_err(error)?;
        let digest = write_core::storage::sha256(&payload);
        let mut connection = self.connection.lock().map_err(error)?;
        let transaction = connection.transaction().map_err(error)?;
        let existing: Option<(Vec<u8>, String, Vec<u8>)> = transaction.query_row(
            "SELECT payload,payload_sha256,receipt FROM host_input_journal WHERE op_id=?1",
            [&receipt.op_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(error)?;
        if let Some(existing) = existing {
            if existing != (payload, digest, encoded_receipt) { return Err(error("输入操作身份重复但内容不同")); }
        } else {
            transaction.execute("INSERT INTO host_input_journal(op_id,payload,payload_sha256,receipt) VALUES(?1,?2,?3,?4)",
                params![receipt.op_id, payload, digest, encoded_receipt]).map_err(error)?;
        }
        transaction.commit().map_err(error)?;
        Ok(publish())
    }
    pub(super) fn pending(&self) -> Result<Vec<Request>> {
        let connection = self.connection.lock().map_err(error)?;
        let mut query = connection.prepare("SELECT op_id,payload,payload_sha256,receipt FROM host_input_journal ORDER BY sequence").map_err(error)?;
        let rows = query.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,Vec<u8>>(1)?, row.get::<_,String>(2)?, row.get::<_,Vec<u8>>(3)?))).map_err(error)?;
        let mut requests = Vec::new();
        for row in rows {
            let (op_id, payload, digest, encoded_receipt) = row.map_err(error)?;
            if write_core::storage::sha256(&payload) != digest { return Err(error("输入日志内容校验失败；保留原日志等待恢复")); }
            let request: Request = serde_json::from_slice(&payload).map_err(error)?;
            let stored: CommitReceipt = serde_json::from_slice(&encoded_receipt).map_err(error)?;
            if stored.op_id != op_id || stored != receipt(&request)? { return Err(error("输入日志身份校验失败；保留原日志等待恢复")); }
            requests.push(request);
        }
        Ok(requests)
    }
    /// Never reclaim on a transport ACK or a revision-only notification.
    pub(super) fn acknowledge(&self, request: &Request, actual: &CommitReceipt) -> Result<()> {
        if receipt(request)? != *actual { return Err(error("后台持久回执与输入日志不一致")); }
        let payload = serde_json::to_vec(request).map_err(error)?;
        let connection = self.connection.lock().map_err(error)?;
        let existing: Option<Vec<u8>> = connection.query_row("SELECT payload FROM host_input_journal WHERE op_id=?1", [&actual.op_id], |row| row.get(0)).optional().map_err(error)?;
        if let Some(existing) = existing {
            if existing != payload { return Err(error("待回收输入日志内容不一致")); }
            connection.execute("DELETE FROM host_input_journal WHERE op_id=?1", [&actual.op_id]).map_err(error)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edit(op_id: &str, revision: u64) -> Request {
        Request::CommitLocal(LocalEdit { page_id: "isolated-page".into(), epoch: 1, generation: 7, revision,
            op_id: op_id.into(), update: "离线写作内容\n第二行".as_bytes().repeat(64), first_write_date: Some("2026-11-09".into()) })
    }
    #[test]
    fn fifo_reopen_and_exact_receipt_reclamation() {
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().join("journal.sqlite3");
        let first = edit("first", 1); let second = edit("second", 2);
        {
            let journal = Journal::open(&path).unwrap();
            journal.append_then(&first, || ()).unwrap();
            journal.append_then(&second, || ()).unwrap();
            journal.append_then(&first, || ()).unwrap(); // Same request is idempotent.
            let mut wrong = receipt(&first).unwrap(); wrong.digest.push('0');
            assert!(journal.acknowledge(&first, &wrong).is_err());
            assert_eq!(journal.pending().unwrap().len(), 2);
            assert!(journal.append_then(&edit("first", 3), || ()).is_err());
        }
        let journal = Journal::open(&path).unwrap();
        assert_eq!(serde_json::to_value(journal.pending().unwrap()).unwrap(), serde_json::to_value([first.clone(), second.clone()]).unwrap());
        journal.acknowledge(&first, &receipt(&first).unwrap()).unwrap();
        journal.acknowledge(&first, &receipt(&first).unwrap()).unwrap();
        assert_eq!(journal.pending().unwrap().len(), 1);
        journal.acknowledge(&second, &receipt(&second).unwrap()).unwrap();
        assert!(journal.pending().unwrap().is_empty());
    }
    #[test]
    fn failed_write_never_publishes_or_acknowledges() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(&temp.path().join("journal.sqlite3")).unwrap();
        journal.connection.lock().unwrap().execute_batch("PRAGMA query_only=ON").unwrap();
        let published = std::cell::Cell::new(false);
        assert!(journal.append_then(&edit("failure", 1), || published.set(true)).is_err());
        assert!(!published.get()); assert!(journal.pending().unwrap().is_empty());
    }
    #[test]
    fn corruption_and_second_host_fail_closed_without_deleting_log() {
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().join("journal.sqlite3");
        let journal = Journal::open(&path).unwrap();
        assert!(Journal::open(&path).is_err());
        journal.append_then(&edit("kept", 1), || ()).unwrap();
        journal.connection.lock().unwrap().execute("UPDATE host_input_journal SET payload_sha256='corrupt'", []).unwrap();
        assert!(journal.pending().is_err());
        let count: i64 = journal.connection.lock().unwrap().query_row("SELECT COUNT(*) FROM host_input_journal", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    #[ignore = "explicit isolated synchronous durability latency measurement"]
    fn measure_synchronous_crdt_journal_latency() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(&temp.path().join("latency.sqlite3")).unwrap();
        let use_wal = std::env::var_os("SUMI_JOURNAL_BENCH_DELETE").is_none();
        if !use_wal {
            journal.connection.lock().unwrap().execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;").unwrap();
            File::open(temp.path()).unwrap().sync_all().unwrap();
        }
        let page = "f8e142a6-0e7a-4a39-a19f-9b5193e9b2f0";
        let mut document = write_core::Document::new(page, 1, 17).unwrap();
        let mut samples = [Vec::<f64>::new(), Vec::<f64>::new()];
        let mut bytes = Vec::new();
        for index in 0..200 {
            let language = index % 2;
            let text = if language == 0 { "a" } else { "字" };
            let update = document.replace(document.revision(), document.body().encode_utf16().count() as u32, 0, text, 1_800_000_000_000 + index as i64).unwrap();
            bytes.push(update.len());
            let request = Request::CommitLocal(LocalEdit { page_id:page.into(), epoch:1, generation:0,
                revision:document.revision(), op_id:format!("latency-{index}"), update, first_write_date:Some("2026-11-09".into()) });
            let start = std::time::Instant::now();
            journal.append_then(&request, || ()).unwrap();
            samples[language].push(start.elapsed().as_secs_f64() * 1000.);
        }
        let connection = journal.connection.lock().unwrap();
        let synchronous: i64 = connection.query_row("PRAGMA synchronous", [], |r|r.get(0)).unwrap();
        let fullfsync: i64 = connection.query_row("PRAGMA fullfsync", [], |r|r.get(0)).unwrap();
        assert_eq!((synchronous, fullfsync), (if use_wal { 2 } else { 3 }, 1));
        println!("journal_mode={} synchronous={} fullfsync=ON(1); genuine CRDT deltas bytes={}..{}; append+hash+SQLite commit, no IPC/projection; temporary local filesystem", if use_wal { "WAL" } else { "DELETE" }, synchronous, bytes.iter().min().unwrap(), bytes.iter().max().unwrap());
        for (name, sample) in ["English", "Chinese"].into_iter().zip(samples.iter_mut()) {
            sample.sort_by(f64::total_cmp);
            println!("{name} n={} p50_ms={:.3} p95_ms={:.3} max_ms={:.3}", sample.len(), sample[49], sample[94], sample[99]);
        }
    }
    #[test]
    #[ignore = "only executed by the isolated crash test parent"]
    fn crash_child() {
        let directory = std::env::var_os("SUMI_JOURNAL_CRASH_DIRECTORY").expect("test-only temporary directory");
        let directory = std::path::PathBuf::from(directory);
        let journal = Journal::open(&directory.join("journal.sqlite3")).unwrap();
        journal.append_then(&edit("before-kill-1", 1), || ()).unwrap();
        journal.append_then(&edit("before-kill-2", 2), || ()).unwrap();
        if std::env::var("SUMI_JOURNAL_CRASH_ACK").as_deref() == Ok("1") {
            let first = edit("before-kill-1", 1);
            journal.acknowledge(&first, &receipt(&first).unwrap()).unwrap();
        }
        // This represents the positive ACK boundary, before any plugin IPC.
        std::fs::write(directory.join("accepted"), "2").unwrap();
        loop { std::thread::park(); }
    }
    fn kill_and_reopen(acknowledge_first: bool) {
        let temp = tempfile::tempdir().unwrap();
        let test_name = format!("{}::crash_child", module_path!().split_once("::").unwrap().1);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg(test_name).args(["--exact", "--ignored", "--nocapture", "--test-threads=1"])
            .env("SUMI_JOURNAL_CRASH_ACK", if acknowledge_first { "1" } else { "0" })
            .env("SUMI_JOURNAL_CRASH_DIRECTORY", temp.path()).stdout(std::process::Stdio::null())
            .spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !temp.path().join("accepted").exists() {
            if child.try_wait().unwrap().is_some() { panic!("crash child exited before accepting input"); }
            if std::time::Instant::now() >= deadline { let _=child.kill(); let _=child.wait(); panic!("crash child timed out"); }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.kill().unwrap(); let status = child.wait().unwrap(); assert!(!status.success());
        let journal = Journal::open(&temp.path().join("journal.sqlite3")).unwrap();
        let pending = journal.pending().unwrap();
        if acknowledge_first {
            assert_eq!(pending.len(), 1, "confirmed journal removal remains durable after SIGKILL");
            assert_eq!(receipt(&pending[0]).unwrap().op_id, "before-kill-2");
        } else {
            assert_eq!(pending.len(), 2);
            assert_eq!(receipt(&pending[0]).unwrap().op_id, "before-kill-1");
            assert_eq!(receipt(&pending[1]).unwrap().op_id, "before-kill-2");
        }
    }
    #[test]
    fn kill_after_accepted_before_ipc_recovers_both_edits() { kill_and_reopen(false); }
    #[test]
    fn kill_after_receipt_reclamation_preserves_only_unacknowledged_input() { kill_and_reopen(true); }
}
