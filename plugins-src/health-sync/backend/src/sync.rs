//! Bounded, resumable provider backfills. The cursor is operational state;
//! committed facts and per-collection coverage live in the daily manifest.
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
    pub file: Option<PathBuf>,
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
    #[serde(default)]
    generation: String,
}

fn date(s: &str) -> Result<NaiveDate, String> {
    if !valid_day(s) {
        return Err("Dates must be YYYY-MM-DD".into());
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|e| e.to_string())
}
fn local(vault: &Path) -> Result<PathBuf, String> {
    let vault = vault.canonicalize().map_err(|e| e.to_string())?;
    Ok(default_state_base()?.join(hash(vault.to_string_lossy().as_bytes())))
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
    if !["all", "apple-health", "garmin", "oura"].contains(&opts.source.as_str()) {
        return Err("source must be all, apple-health, garmin or oura".into());
    }
    if opts.max_days == 0 || opts.max_days > 36600 {
        return Err("max-days must be 1..36600".into());
    }
    if opts.file.is_some() && !["all", "apple-health"].contains(&opts.source.as_str()) {
        return Err("--file applies only to all or apple-health sources".into());
    }
    let store = Store::new(vault, &default_state_base()?)?;
    if opts.source == "apple-health" {
        return serde_json::to_value(store.sync(opts.file.as_deref(), opts.dry_run, progress)?)
            .map_err(|e| e.to_string());
    }
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
    if opts.source == "all"
        && (opts.file.is_some() || store.status()?["source_file"].as_str().is_some())
    {
        match store.sync(opts.file.as_deref(), opts.dry_run, progress) {
            Ok(r) => {
                if !r.complete {
                    warnings.push("Apple summaries or local state need attention".into());
                }
                results.push(json!({"source":"apple-health","import":r}));
            }
            Err(e) => errors.push(format!("Apple Health: {e}")),
        }
    }
    for source in ["garmin", "oura"] {
        if opts.source != "all" && opts.source != source {
            continue;
        }
        if connections[source]["connected"] != true {
            if opts.source == source {
                return Err(format!("Connect {source} in the Health Sync window first"));
            }
            continue;
        }
        let generation = connections[source]["generation"].as_str().unwrap_or("");
        match run_provider(&store, vault, source, generation, opts, progress) {
            Ok(result) => {
                pending |= result["pending"] == true;
                retry_required |= result["retry_required"] == true;
                if result["complete"] == false {
                    warnings.push(format!(
                        "{source}: some collections or summaries need attention; inspect coverage"
                    ));
                }
                results.push(result);
            }
            Err(e) => errors.push(format!("{source}: {e}")),
        }
    }
    if results.is_empty() && errors.is_empty() {
        return Err("Import an Apple export or connect Garmin/Oura first".into());
    }
    Ok(
        json!({"complete":errors.is_empty() && warnings.is_empty(),"dry_run":opts.dry_run,"pending":pending,"retry_required":retry_required || !errors.is_empty(),"sources":results,"errors":errors,"warnings":warnings}),
    )
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
    if next > end {
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
    generation: &str,
    opts: &Options,
    progress: &mut dyn FnMut(&str),
) -> Result<Value, String> {
    let dir = local(vault)?;
    safe(&dir)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let lock_path = dir.join(format!("{source}-fetch.lock"));
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
    let path = dir.join(format!("{source}-progress.json"));
    safe(&path)?;
    let previous: Option<Cursor> = match fs::read(&path) {
        Ok(v) => Some(serde_json::from_slice(&v).map_err(|_| "Invalid provider progress state")?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let start=opts.since.clone().or_else(||previous.as_ref().map(|c|c.start.clone())).or_else(||store.status().ok().and_then(|v|v["manifest"]["first_day"].as_str().map(str::to_string)))
        .ok_or("Set --since to the first date to collect (or import Apple Health to establish a start date)")?;
    // Use the credential generation actually selected by the client. A
    // connection can change after the outer status snapshot was read.
    let mut http = if opts.dry_run {
        None
    } else {
        Some(auth::client(vault, source)?)
    };
    let generation = http
        .as_ref()
        .map(|client| client.generation())
        .unwrap_or(generation)
        .to_string();
    let until = opts
        .until
        .clone()
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let end = date(&until)?;
    let (mut next, planned_end) = plan_window(&start, end, previous.as_ref(), &generation, opts)?;
    if opts.dry_run {
        return Ok(
            json!({"source":source,"complete":true,"dry_run":true,"planned_since":next.to_string(),"planned_until":planned_end.to_string(),"pending":planned_end<end}),
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
        let applied = store.apply_provider(staged.path(), &fetched, false, progress)?;
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
        json!({"source":source,"complete":complete,"dry_run":false,"pending":next<=end,"retry_required":retry_required,"next_day":next.to_string(),"requested_until":until,"windows":windows}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options() -> Options {
        Options {
            source: "oura".into(),
            file: None,
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
}
