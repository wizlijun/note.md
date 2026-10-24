//! Bounded, resumable provider backfills. The cursor is operational state;
//! committed facts and per-collection coverage live in the external SQLite library.
use crate::{
    auth,
    providers::{FetchReport, ProviderRecord, Transport},
    store::{default_state_base, hash, valid_day, Store},
};
use chrono::{Days, Local, NaiveDate};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Options {
    pub source: String,
    pub account_id: Option<String>,
    pub history: bool,
    pub since: Option<String>,
    pub until: Option<String>,
    pub max_days: usize,
    pub dry_run: bool,
    pub restart: bool,
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    start: String,
    next: String,
    generation: String,
}

fn date(s: &str) -> Result<NaiveDate, String> {
    if !valid_day(s) {
        return Err("Dates must be YYYY-MM-DD".into());
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|e| e.to_string())
}
fn safe(path: &Path) -> Result<(), String> {
    let mut part = PathBuf::new();
    for component in path.components() {
        part.push(component);
        match fs::symlink_metadata(&part) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err("Refusing symlink in health progress state".into())
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(())
}
fn save(path: &Path, state: &Cursor) -> Result<(), String> {
    safe(path)?;
    let mut tmp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut tmp, state).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.to_string())?;
    File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}
fn fetch(
    source: &str,
    http: &mut dyn Transport,
    start: &str,
    end: &str,
    file: &mut File,
    progress: &mut dyn FnMut(&str),
) -> Result<FetchReport, String> {
    let mut emit = |record: ProviderRecord| {
        serde_json::to_writer(&mut *file, &record).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())
    };
    match source {
        "garmin" => crate::garmin::collect(http, start, end, &mut emit, progress),
        "oura" => crate::oura::collect(http, start, end, &mut emit, progress),
        _ => Err("Unknown provider".into()),
    }
}

pub fn run(vault: &Path, opts: &Options, progress: &mut dyn FnMut(&str)) -> Result<Value, String> {
    if !["all", "garmin", "oura"].contains(&opts.source.as_str()) {
        return Err("source must be all, garmin or oura; Apple uses health-import FILE".into());
    }
    if opts.max_days == 0 || opts.max_days > 36600 {
        return Err("max-days must be 1..36600".into());
    }
    if opts
        .account_id
        .as_ref()
        .is_some_and(|id| !valid_account_id(id))
    {
        return Err("account must be a saved account ID".into());
    }
    if (opts.history || opts.account_id.is_some())
        && !["garmin", "oura"].contains(&opts.source.as_str())
    {
        return Err("account/history requires a single Garmin or Oura source".into());
    }
    if opts.history && (opts.since.is_none() || opts.until.is_none() || opts.account_id.is_none()) {
        return Err("History import requires account, since and until".into());
    }
    let store = Store::new(vault, &default_state_base()?)?;
    let mut results = vec![];
    let mut errors = vec![];
    let mut warnings = vec![];
    let mut pending = false;
    let mut retry_required = false;
    let connections = match auth::status(vault) {
        Ok(v) => v,
        Err(e) if opts.source == "all" => {
            errors.push(e);
            json!({})
        }
        Err(e) => return Err(e),
    };
    for source in ["garmin", "oura"] {
        if opts.source != "all" && opts.source != source {
            continue;
        }
        let selected = selected_account(&connections[source], opts)?;
        let Some((account_id, generation)) = selected else {
            if opts.source == source {
                return Err(format!("Connect {source} in the Health Sync window first"));
            }
            continue;
        };
        match run_provider(
            &store,
            vault,
            source,
            &account_id,
            &generation,
            opts,
            progress,
        ) {
            Ok(result) => {
                pending |= result["pending"] == true;
                retry_required |= result["retry_required"] == true;
                if result["complete"] == false {
                    warnings.push(format!(
                        "{source}: some collections need attention; inspect coverage"
                    ));
                }
                results.push(result);
            }
            Err(e) => errors.push(format!("{source}: {e}")),
        }
    }
    if results.is_empty() && errors.is_empty() {
        return Err("Connect Garmin/Oura before API sync; Apple exports use health-import".into());
    }
    Ok(
        json!({"complete":errors.is_empty() && warnings.is_empty(),"dry_run":opts.dry_run,"pending":pending,"retry_required":retry_required || !errors.is_empty(),"sources":results,"errors":errors,"warnings":warnings}),
    )
}

pub fn valid_account_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn selected_account(
    connection: &Value,
    opts: &Options,
) -> Result<Option<(String, String)>, String> {
    let active = connection["active_account_id"].as_str();
    let id = opts.account_id.as_deref().or(active);
    if !opts.history && opts.account_id.is_some() && opts.account_id.as_deref() != active {
        return Err("Current account changed; start sync again".into());
    }
    let Some(id) = id else { return Ok(None) };
    if !valid_account_id(id) {
        return Err("Invalid saved account ID".into());
    }
    let account = connection["accounts"]
        .as_array()
        .and_then(|accounts| accounts.iter().find(|a| a["id"] == id))
        .ok_or("Saved account not found")?;
    if account["connected"] != true {
        if opts.account_id.is_some() {
            return Err("Reconnect the selected account first".into());
        }
        return Ok(None);
    }
    Ok(Some((
        id.into(),
        account["generation"].as_str().unwrap_or("").into(),
    )))
}

fn cursor_filename(source: &str, account_id: &str, opts: &Options) -> String {
    if opts.history {
        let range = hash(
            format!(
                "{}:{}",
                opts.since.as_deref().unwrap_or(""),
                opts.until.as_deref().unwrap_or("")
            )
            .as_bytes(),
        );
        format!("{source}-{account_id}-history-{range}-progress.json")
    } else {
        format!("{source}-{account_id}-progress.json")
    }
}

fn read_cursor(path: &Path) -> Result<Option<Cursor>, String> {
    safe(path)?;
    match fs::read(path) {
        Ok(v) => serde_json::from_slice(&v)
            .map(Some)
            .map_err(|_| "Invalid provider progress state".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
/// Resume only a cursor for this range and authorization. Reconnection revisits
/// history because newly granted collections may have been unavailable before.
fn plan_window(
    start: &str,
    end: NaiveDate,
    previous: Option<&Cursor>,
    generation: &str,
    opts: &Options,
) -> Result<(NaiveDate, NaiveDate), String> {
    let start_day = date(start)?;
    if start_day > end {
        return Err("since must not be after until".into());
    }
    let mut next = if opts.restart {
        start_day
    } else {
        previous
            .filter(|c| c.start == start && c.generation == generation)
            .map(|c| date(&c.next))
            .transpose()?
            .unwrap_or(start_day)
    };
    if next < start_day {
        return Err("Provider progress precedes its start date".into());
    }
    // After backfill, rotate through the recent fortnight on subsequent runs.
    if next > end && !opts.history {
        next = end
            .checked_sub_days(Days::new(13))
            .unwrap_or(start_day)
            .max(start_day);
    }
    let planned_end = next
        .checked_add_days(Days::new((opts.max_days - 1) as u64))
        .unwrap_or(end)
        .min(end);
    Ok((next, planned_end))
}

fn run_provider(
    store: &Store,
    vault: &Path,
    source: &str,
    account_id: &str,
    authorization: &str,
    opts: &Options,
    progress: &mut dyn FnMut(&str),
) -> Result<Value, String> {
    let dir = store.operational_directory().to_path_buf();
    safe(&dir)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let lock_path = dir.join(format!("{source}-{account_id}-fetch.lock"));
    safe(&lock_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| format!("{source} sync is busy; retry later"))?;
    let path = dir.join(cursor_filename(source, account_id, opts));
    // Use the credential generation actually selected by the client. A
    // connection can change after the outer status snapshot was read.
    let mut http = if opts.dry_run {
        None
    } else {
        let client = auth::client_for_account(vault, source, opts.history.then_some(account_id))?;
        if client.account_id() != account_id {
            return Err("Current account changed; start sync again".into());
        }
        Some(client)
    };
    let generation = http
        .as_ref()
        .map(|client| client.generation())
        .unwrap_or(authorization)
        .to_string();
    let previous = read_cursor(&path)?;
    let start = opts
        .since
        .clone()
        .or_else(|| previous.as_ref().map(|c| c.start.clone()))
        .unwrap_or_else(|| (Local::now().date_naive() - Days::new(13)).to_string());
    let until = opts
        .until
        .clone()
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let end = date(&until)?;
    let (mut next, planned_end) = plan_window(&start, end, previous.as_ref(), &generation, opts)?;
    if opts.dry_run {
        return Ok(
            json!({"source":source,"account_id":account_id,"history":opts.history,"complete":true,"dry_run":true,"planned_since":(next<=end).then(||next.to_string()),"planned_until":planned_end.to_string(),"pending":next<=end && planned_end<end}),
        );
    }
    let http = http.as_mut().ok_or("Missing provider client")?;
    let mut windows = vec![];
    let mut complete = true;
    let mut retry_required = false;
    while next <= planned_end {
        // Oura supports range pagination; Garmin's detailed endpoints are daily.
        let window_end = if source == "oura" {
            next.checked_add_days(Days::new(30))
                .unwrap_or(planned_end)
                .min(planned_end)
        } else {
            next
        };
        let from = next.to_string();
        let to = window_end.to_string();
        progress(&format!("Collecting {source}: {from} through {to}"));
        let mut staged = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        let fetched = fetch(source, http, &from, &to, staged.as_file_mut(), progress)?;
        staged.flush().map_err(|e| e.to_string())?;
        // Linearize the commit with disconnect/reconnect in other processes.
        let _authorization = http.commit_guard()?;
        let applied = store.apply_provider_for_account(
            staged.path(),
            &fetched,
            false,
            account_id,
            http.garmin_region(),
            progress,
        )?;
        let failed = fetched.collections.iter().any(|c| c.status == "failed");
        complete &= applied.complete && fetched.collections.iter().all(|c| c.status == "complete");
        windows
            .push(json!({"since":from,"until":to,"coverage":fetched.collections,"import":applied}));
        if failed {
            retry_required = true;
            break;
        }
        next = window_end
            .checked_add_days(Days::new(1))
            .ok_or("Date overflow")?;
        save(
            &path,
            &Cursor {
                start: start.clone(),
                next: next.to_string(),
                generation: generation.clone(),
            },
        )?;
    }
    Ok(
        json!({"source":source,"account_id":account_id,"history":opts.history,"complete":complete,"dry_run":false,"pending":next<=end,"retry_required":retry_required,"next_day":next.to_string(),"requested_until":until,"windows":windows}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options() -> Options {
        Options {
            source: "oura".into(),
            account_id: None,
            history: false,
            since: None,
            until: None,
            max_days: 31,
            dry_run: false,
            restart: false,
        }
    }
    fn cursor(next: &str) -> Cursor {
        Cursor {
            start: "2020-01-01".into(),
            next: next.into(),
            generation: "current".into(),
        }
    }
    #[test]
    fn switching_libraries_cannot_reuse_another_library_cursor() {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path().join("vault");
        let first = root.path().join("first");
        let second = root.path().join("second");
        let state = root.path().join("state");
        for path in [&vault, &first, &second] {
            fs::create_dir(path).unwrap();
        }
        crate::library::configure(&vault, &state, &first).unwrap();
        let first_store = Store::new(&vault, &state).unwrap();
        let first_progress = first_store.operational_directory().to_path_buf();
        fs::create_dir_all(&first_progress).unwrap();
        fs::write(first_progress.join("cursor"), "old history").unwrap();
        crate::library::configure(&vault, &state, &second).unwrap();
        let second_progress = Store::new(&vault, &state)
            .unwrap()
            .operational_directory()
            .to_path_buf();
        assert_eq!(first_store.operational_directory(), first_progress);
        assert_ne!(first_progress, second_progress);
        assert!(!second_progress.join("cursor").exists());
        crate::library::configure(&vault, &state, &first).unwrap();
        assert_eq!(
            first_progress,
            Store::new(&vault, &state)
                .unwrap()
                .operational_directory()
                .to_path_buf()
        );
    }

    #[test]
    fn resume_range_and_reauthorization_do_not_skip_history() {
        let end = date("2026-10-24").unwrap();
        let mut opts = options();
        let c = cursor("2020-02-01");
        assert_eq!(
            plan_window(&c.start, end, Some(&c), "current", &opts).unwrap(),
            (date("2020-02-01").unwrap(), date("2020-03-02").unwrap())
        );
        for (start, generation) in [("2020-01-01", "new-grant"), ("2019-01-01", "current")] {
            assert_eq!(
                plan_window(start, end, Some(&c), generation, &opts)
                    .unwrap()
                    .0,
                date(start).unwrap()
            );
        }
        opts.restart = true;
        assert_eq!(
            plan_window(&c.start, end, Some(&c), "current", &opts)
                .unwrap()
                .0,
            date(&c.start).unwrap()
        );
    }
    #[test]
    fn recent_refresh_is_bounded_and_short_ranges_do_not_expand() {
        let end = date("2026-10-24").unwrap();
        let mut opts = options();
        let c = cursor("2026-10-25");
        assert_eq!(
            plan_window(&c.start, end, Some(&c), "current", &opts).unwrap(),
            (date("2026-10-11").unwrap(), end)
        );
        let short = Cursor {
            start: "2026-10-23".into(),
            ..c
        };
        assert_eq!(
            plan_window(&short.start, end, Some(&short), "current", &opts).unwrap(),
            (date("2026-10-23").unwrap(), end)
        );
        opts.max_days = 1;
        let planned = plan_window(&short.start, end, Some(&short), "current", &opts).unwrap();
        assert_eq!(planned.0, planned.1);
        assert!(plan_window("2026-10-25", end, None, "current", &opts).is_err());
        let bad = cursor("2019-12-31");
        assert!(plan_window(&bad.start, end, Some(&bad), "current", &opts).is_err());
    }
    #[test]
    fn dates_and_progress_are_strict_and_atomic() {
        assert!(date("2026-02-30").is_err());
        assert!(date("2026-2-1").is_err());
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let file = root.join("progress.json");
        save(
            &file,
            &Cursor {
                start: "2016-01-01".into(),
                next: "2016-02-01".into(),
                generation: "test".into(),
            },
        )
        .unwrap();
        let c: Cursor = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_eq!(c.next, "2016-02-01");
    }

    #[test]
    fn history_stops_at_end_and_cursors_are_account_and_range_specific() {
        let a = hash(b"oura:account-a");
        let b = hash(b"oura:account-b");
        let mut opts = options();
        let incremental = cursor_filename("oura", &a, &opts);
        opts.history = true;
        opts.since = Some("2020-01-01".into());
        opts.until = Some("2020-01-31".into());
        let historical = cursor_filename("oura", &a, &opts);
        assert_ne!(incremental, historical);
        assert_ne!(historical, cursor_filename("oura", &b, &opts));
        let c = cursor("2020-02-01");
        let (next, end) = plan_window(
            &c.start,
            date("2020-01-31").unwrap(),
            Some(&c),
            "current",
            &opts,
        )
        .unwrap();
        assert!(
            next > end,
            "completed history must not rotate through recent days"
        );
        opts.until = Some("2020-02-01".into());
        assert_ne!(historical, cursor_filename("oura", &a, &opts));
        opts.restart = true;
        assert_eq!(
            plan_window(
                &c.start,
                date("2020-02-01").unwrap(),
                Some(&c),
                "current",
                &opts
            )
            .unwrap()
            .0,
            date("2020-01-01").unwrap()
        );
    }

    #[test]
    fn history_can_use_saved_noncurrent_account_but_incremental_cannot_switch() {
        let a = hash(b"garmin:china:1");
        let b = hash(b"garmin:china:2");
        let connection = json!({"active_account_id":a,"accounts":[
            {"id":a,"connected":true,"generation":"a"},
            {"id":b,"connected":true,"generation":"b"}
        ]});
        let mut opts = options();
        assert_eq!(
            selected_account(&connection, &opts).unwrap(),
            Some((a.clone(), "a".into()))
        );
        opts.account_id = Some(b.clone());
        assert!(selected_account(&connection, &opts).is_err());
        opts.history = true;
        assert_eq!(
            selected_account(&connection, &opts).unwrap(),
            Some((b, "b".into()))
        );
        assert_eq!(connection["active_account_id"], a);
        assert!(!valid_account_id("../../secret"));
        assert!(!valid_account_id(&"A".repeat(64)));
    }

    #[test]
    fn cursor_uses_only_the_exact_library_account_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let unrelated = root.join("garmin-progress.json");
        let scoped = root.join("garmin-account-progress.json");
        save(&unrelated, &cursor("2020-02-01")).unwrap();
        assert!(read_cursor(&scoped).unwrap().is_none());
        save(&scoped, &cursor("2020-03-01")).unwrap();
        assert_eq!(read_cursor(&scoped).unwrap().unwrap().next, "2020-03-01");
        fs::write(&scoped, r#"{"start":"2020-01-01","next":"2020-02-01"}"#).unwrap();
        assert!(read_cursor(&scoped).is_err());
    }
}
