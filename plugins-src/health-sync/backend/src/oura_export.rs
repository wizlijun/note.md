//! Offline Oura V2 and Data Subject Request exports, identified by content.
//! Account binding is explicit; exports never complete an API collection/window.
use crate::{
    providers::{CollectionResult, FetchReport, ProviderRecord},
    store::{hash, valid_day, ExportAttachment, Store},
};
use chrono::{DateTime, NaiveDateTime};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

const MAX_JSON_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TOTAL: u64 = 4 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 100_000;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// Signatures use documented model fields, never localized filenames. An
// ambiguous score/day alone cannot distinguish sleep from readiness/activity.
fn collection(row: &Value) -> Option<&'static str> {
    let has = |key: &str| row.get(key).is_some();
    let contributors = row.get("contributors").and_then(|v| {
        if v.is_object() {
            Some(v.clone())
        } else {
            v.as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
        }
    });
    let contributes = |key: &str| {
        contributors.as_ref().is_some_and(|v| v.get(key).is_some())
            || has(&format!("contributors.{key}"))
    };
    if has("timestamp") && has("bpm") && has("imported_from") && has("origin_source") {
        Some("imported_heartrate")
    } else if has("timestamp") && has("end_time") && has("steps") {
        if has("imported_from") && has("origin_source") {
            Some("imported_step_count")
        } else {
            Some("step_count")
        }
    } else if has("timestamp") && has("skin_temp") {
        Some("temperature")
    } else if has("timestamp")
        && has("acm_average_x")
        && has("acm_average_y")
        && has("acm_average_z")
        && has("motion_seconds")
    {
        Some("motion")
    } else if has("timestamp") && has("stress_value") && has("recovery_value") {
        Some("daytime_stress")
    } else if has("day") && has("average_bp_trend_sleep") && has("bp_change_percentage") {
        Some("daily_cardiovascular_metrics")
    } else if has("day") && has("cardiovascular_age") && has("pulse_wave_velocity") {
        Some("daily_smoothed_cardiovascular_age")
    } else if has("timestamp") && has("vo2max") && has("workout_identifier") {
        Some("vo2_max_workout_estimate")
    } else if has("day") && has("timestamp") && has("vo2max") && has("confidence") {
        Some("daily_vo2_max_estimate")
    } else if has("day") && has("start_time") && has("end_time") && has("predicted_activities") {
        Some("activity_prediction_segment")
    } else if has("start_time") && has("end_time") && has("selected_activity_id") {
        Some("workout_heartrate_session")
    } else if has("timestamp") && has("identifier") && has("offset") {
        Some("timezone")
    } else if has("day") && has("food_item_ids") && has("nutrition_details") && has("start_time") {
        Some("meal")
    } else if has("day")
        && has("threshold1")
        && has("threshold2")
        && has("threshold3")
        && has("threshold4")
    {
        Some("cardio_effort_baselines")
    } else if has("bedtime_start") && has("bedtime_end") {
        Some("sleep")
    } else if has("active_calories") && has("steps") {
        Some("daily_activity")
    } else if has("temperature_deviation") || contributes("hrv_balance") {
        Some("daily_readiness")
    } else if contributes("deep_sleep") && contributes("rem_sleep") {
        Some("daily_sleep")
    } else if has("spo2_percentage") || has("spo2_percentage.average") {
        Some("daily_spo2")
    } else if has("stress_high") && has("recovery_high") {
        Some("daily_stress")
    } else if has("vascular_age") || has("pulse_wave_velocity") {
        Some("daily_cardiovascular_age")
    } else if has("level") && contributes("sleep_recovery") {
        Some("daily_resilience")
    } else if has("vo2_max") {
        Some("vO2_max")
    } else if has("bpm") && has("timestamp") && has("source") {
        Some("heartrate")
    } else if has("level") && has("timestamp") && (has("charging") || has("in_charger")) {
        Some("ring_battery_level")
    } else if has("activity") && has("intensity") && has("start_datetime") {
        Some("workout")
    } else if has("start_datetime") && has("end_datetime") && has("type") {
        Some("session")
    } else if has("optimal_bedtime") || has("optimal_bedtime.start_offset") {
        Some("sleep_time")
    } else if has("tag_type_code") && has("start_day") {
        Some("enhanced_tag")
    } else if has("episodes") && has("start_day") {
        Some("rest_mode_period")
    } else if has("tags") && has("text") && has("day") {
        Some("tag")
    } else if has("firmware_version") && has("hardware_type") {
        Some("ring_configuration")
    } else {
        None
    }
}

fn day(row: &Value, kind: &str) -> Result<String, String> {
    if kind == "ring_configuration" {
        return Ok("_undated".into());
    }
    for field in ["day", "start_day"] {
        if let Some(value) = row
            .get(field)
            .filter(|v| !v.is_null() && v.as_str() != Some(""))
        {
            return value
                .as_str()
                .filter(|s| valid_day(s))
                .map(str::to_owned)
                .ok_or_else(|| format!("Oura export: invalid {field}"));
        }
    }
    for field in ["timestamp", "start_datetime", "bedtime_start", "start_time"] {
        if let Some(value) = row
            .get(field)
            .filter(|v| !v.is_null() && v.as_str() != Some(""))
        {
            let text = value
                .as_str()
                .ok_or_else(|| format!("Oura export: invalid {field}"))?;
            return DateTime::parse_from_rfc3339(text)
                .map(|d| d.date_naive())
                .or_else(|_| {
                    NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").map(|d| d.date())
                })
                .map(|d| d.to_string())
                .map_err(|_| format!("Oura export: invalid {field}"));
        }
    }
    Err("Oura export: recognized record has no day or timestamp".into())
}

fn record(row: Value) -> Result<Option<ProviderRecord>, String> {
    let Some(kind) = collection(&row) else {
        return Ok(None);
    };
    let day = day(&row, kind)?;
    let id = match row.get("id") {
        Some(Value::String(id)) if !id.is_empty() => id.clone(),
        None | Some(Value::Null) | Some(Value::String(_)) => {
            if kind.starts_with("daily_") || kind == "sleep_time" {
                day.clone()
            } else if matches!(kind, "heartrate" | "ring_battery_level") {
                hash(&serde_json::to_vec(&(row.get("timestamp"), row.get("source"))).map_err(err)?)
            } else {
                hash(&serde_json::to_vec(&row).map_err(err)?)
            }
        }
        _ => return Err("Oura export: invalid record id".into()),
    };
    Ok(Some(ProviderRecord {
        source: "oura".into(),
        collection: format!("export_{kind}"),
        day,
        id: Some(id),
        data: row,
    }))
}

// Known API envelopes and direct arrays are supported, with nested collection
// keys allowed only when named in the official API; arbitrary objects stay raw.
fn json_rows(
    value: Value,
    emit: &mut dyn FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    match value {
        Value::Array(items) => {
            for item in items {
                emit(item)?;
            }
        }
        Value::Object(object) => {
            if let Some(Value::Array(items)) = object.get("data") {
                for item in items {
                    emit(item.clone())?;
                }
            } else if object
                .keys()
                .any(|k| crate::oura::COLLECTIONS.contains(&k.as_str()))
            {
                for (key, value) in object {
                    if crate::oura::COLLECTIONS.contains(&key.as_str()) {
                        json_rows(value, emit)?;
                    } else {
                        emit(json!({key: value}))?;
                    }
                }
            } else {
                emit(Value::Object(object))?;
            }
        }
        other => emit(other)?,
    }
    Ok(())
}

// DSR CSVs use semicolons, while V2-shaped CSV exports may use commas.
// Count separators only outside quoted fields so embedded punctuation is not a delimiter.
fn csv_delimiter(header: &[u8]) -> u8 {
    let mut quoted = false;
    let (mut commas, mut semicolons) = (0, 0);
    for &byte in header {
        match byte {
            b'"' => quoted = !quoted,
            b'\n' | b'\r' if !quoted => break,
            b',' if !quoted => commas += 1,
            b';' if !quoted => semicolons += 1,
            _ => {}
        }
    }
    if semicolons > commas {
        b';'
    } else {
        b','
    }
}

fn parse_reader(
    input: impl Read,
    emit: &mut dyn FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let mut input = BufReader::new(input);
    if input
        .fill_buf()
        .map_err(err)?
        .starts_with(&[0xef, 0xbb, 0xbf])
    {
        input.consume(3);
    }
    let prefix = input.fill_buf().map_err(err)?;
    if prefix.is_empty() {
        return Ok(());
    }
    let first = prefix.iter().find(|b| !b.is_ascii_whitespace());
    if matches!(first, Some(b'[' | b'{')) {
        let mut bytes = Vec::new();
        input
            .take(MAX_JSON_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() as u64 > MAX_JSON_BYTES {
            return Err("Oura export JSON exceeds 64 MiB parsing limit".into());
        }
        json_rows(
            serde_json::from_slice(&bytes).map_err(|_| "Invalid Oura export JSON")?,
            emit,
        )
    } else {
        let delimiter = csv_delimiter(prefix);
        let mut csv = csv::ReaderBuilder::new()
            .delimiter(delimiter)
            .from_reader(input);
        let headers = csv
            .headers()
            .map_err(|_| "Invalid Oura export CSV header")?
            .clone();
        // Completely empty/whitespace files carry no records. Header-only exports
        // are common in real DSR archives and remain represented in file_reports.
        if headers.is_empty() {
            return Ok(());
        }
        let unique: BTreeSet<_> = headers.iter().collect();
        if unique.len() != headers.len() || headers.iter().any(str::is_empty) {
            return Err("Oura export CSV has empty or duplicate column names".into());
        }
        for row in csv.records() {
            let row = row.map_err(|_| "Invalid Oura export CSV record")?;
            let fields: Map<String, Value> = headers
                .iter()
                .zip(row.iter())
                .map(|(k, v)| (k.into(), Value::String(v.into())))
                .collect();
            emit(Value::Object(fields))?;
        }
        Ok(())
    }
}

#[cfg(test)]
fn parse(bytes: &[u8], emit: &mut dyn FnMut(Value) -> Result<(), String>) -> Result<(), String> {
    parse_reader(bytes, emit)
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains(['\\', ':'])
        && !name.chars().any(char::is_control)
        && name
            .trim_end_matches('/')
            .split('/')
            .all(|s| !matches!(s, "" | "." | ".."))
}
fn verify_members(file: &mut File, start: u64, expected: usize) -> Result<(), String> {
    file.seek(SeekFrom::Start(start)).map_err(err)?;
    let mut count = 0;
    loop {
        let mut signature = [0; 4];
        file.read_exact(&mut signature).map_err(err)?;
        if signature != *b"PK\x01\x02" {
            break;
        }
        count += 1;
        if count > expected {
            return Err("Oura ZIP has duplicate member names".into());
        }
        let mut header = [0; 42];
        file.read_exact(&mut header).map_err(err)?;
        let length = [24, 26, 28]
            .iter()
            .map(|i| u16::from_le_bytes([header[*i], header[*i + 1]]) as i64)
            .sum();
        file.seek(SeekFrom::Current(length)).map_err(err)?;
    }
    if count != expected {
        return Err("Oura ZIP directory entry count disagrees".into());
    }
    Ok(())
}

pub fn import(
    store: &Store,
    input: &Path,
    account_id: &str,
    dry_run: bool,
    progress: &mut dyn FnMut(&str),
) -> Result<Value, String> {
    if account_id.is_empty() {
        return Err("Oura file import requires an explicit account or offline profile".into());
    }
    let mut source = File::open(input).map_err(|e| format!("Cannot open Oura export: {e}"))?;
    let info = source.metadata().map_err(err)?;
    if !info.is_file() || info.len() > MAX_TOTAL {
        return Err("Oura export must be a regular file smaller than 4 GiB".into());
    }
    let staging = tempfile::Builder::new()
        .prefix("oura-export-")
        .tempdir()
        .map_err(err)?;
    let root = staging.path().canonicalize().map_err(err)?;
    let original = root.join("original");
    let mut copy = File::create(&original).map_err(err)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    let mut size = 0u64;
    loop {
        let n = source.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > MAX_TOTAL {
            return Err("Oura export exceeds 4 GiB".into());
        }
        digest.update(&buffer[..n]);
        copy.write_all(&buffer[..n]).map_err(err)?;
    }
    copy.flush().map_err(err)?;
    let sha256 = format!("{:x}", digest.finalize());
    let filename = input
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("oura-export");
    let records_path = root.join("records.jsonl");
    let mut writer = BufWriter::new(File::create(&records_path).map_err(err)?);
    let mut counts = BTreeMap::<String, u64>::new();
    let mut records = 0u64;
    let mut unrecognized = 0u64;
    let mut since: Option<String> = None;
    let mut until: Option<String> = None;
    let file_parsed = std::cell::Cell::new(0u64);
    let file_unknown = std::cell::Cell::new(0u64);
    let mut last = std::time::Instant::now();
    let mut emit = |row| -> Result<(), String> {
        if let Some(record) = record(row)? {
            if record.day != "_undated" {
                if since.as_ref().is_none_or(|s| &record.day < s) {
                    since = Some(record.day.clone());
                }
                if until.as_ref().is_none_or(|s| &record.day > s) {
                    until = Some(record.day.clone());
                }
            }
            *counts.entry(record.collection.clone()).or_default() += 1;
            serde_json::to_writer(&mut writer, &record).map_err(err)?;
            writer.write_all(b"\n").map_err(err)?;
            records += 1;
            file_parsed.set(file_parsed.get() + 1);
        } else {
            unrecognized += 1;
            file_unknown.set(file_unknown.get() + 1);
        }
        if last.elapsed().as_secs() >= 3 {
            progress(&format!("Reading Oura export: {records} health records; {unrecognized} other rows preserved"));
            last = std::time::Instant::now();
        }
        Ok(())
    };
    let mut header = [0; 4];
    let mut archive = File::open(&original).map_err(err)?;
    let n = archive.read(&mut header).map_err(err)?;
    archive.rewind().map_err(err)?;
    let mut preserved_only = Vec::<String>::new();
    let mut files = 0;
    let mut file_reports = Vec::new();
    if n == 4 && &header[..2] == b"PK" {
        let mut directory = archive.try_clone().map_err(err)?;
        let mut zip = zip::ZipArchive::new(archive).map_err(|_| "Invalid Oura export ZIP")?;
        if zip.len() > MAX_FILES {
            return Err("Oura ZIP has too many entries".into());
        }
        verify_members(&mut directory, zip.central_directory_start(), zip.len())?;
        let mut names = BTreeSet::new();
        let mut total = 0u64;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(err)?;
            let name = entry.name().to_string();
            if !safe_name(&name) || !names.insert(name.trim_end_matches('/').to_owned()) {
                return Err("Oura ZIP contains unsafe or duplicate paths".into());
            }
            if entry
                .unix_mode()
                .is_some_and(|m| !matches!(m & 0o170000, 0 | 0o100000 | 0o040000))
            {
                return Err("Oura ZIP contains a non-regular member".into());
            }
            if entry.is_dir() {
                continue;
            }
            total = total
                .checked_add(entry.size())
                .ok_or("Oura ZIP size overflow")?;
            if total > MAX_TOTAL {
                return Err("Oura ZIP exceeds 4 GiB total limit".into());
            }
            let expected = entry.size();
            files += 1;
            let ext = Path::new(&name)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            file_parsed.set(0);
            file_unknown.set(0);
            let parsed_format = matches!(ext.as_str(), "csv" | "json");
            let mut reader = (&mut entry).take(MAX_TOTAL + 1);
            if parsed_format {
                parse_reader(&mut reader, &mut emit)
                    .map_err(|e| format!("Oura export {name}: {e}"))?;
                if file_parsed.get() == 0 && file_unknown.get() > 0 {
                    preserved_only.push(name.clone());
                }
            } else {
                preserved_only.push(name.clone());
            }
            // Drain unknown members too: a preserved file must still pass ZIP CRC/size checks.
            std::io::copy(&mut reader, &mut std::io::sink())
                .map_err(|_| "Invalid Oura ZIP member data or CRC")?;
            if MAX_TOTAL + 1 - reader.limit() != expected {
                return Err("Oura ZIP member size disagrees".into());
            }
            file_reports.push(json!({"filename":name,"size":expected,
                "parsed_records":file_parsed.get(),"unrecognized_records":file_unknown.get(),
                "status":if !parsed_format {"preserved_only"} else if file_unknown.get()>0 && file_parsed.get()>0 {"partially_parsed"} else if file_unknown.get()>0 {"unrecognized"} else if file_parsed.get()>0 {"parsed"} else {"empty"}}));
        }
    } else {
        parse_reader(&mut archive, &mut emit)?;
        files = 1;
        file_reports.push(json!({"filename":filename,"size":size,
            "parsed_records":file_parsed.get(),"unrecognized_records":file_unknown.get(),
            "status":if file_unknown.get()>0 && file_parsed.get()>0 {"partially_parsed"} else if file_unknown.get()>0 {"unrecognized"} else if file_parsed.get()>0 {"parsed"} else {"empty"}}));
    }
    drop(emit);
    if records == 0 {
        return Err("No recognized Oura health records found; no data was imported".into());
    }
    let metadata = json!({"filename":filename,"sha256":sha256,"size":size,"parsed_records":records,"unrecognized_records":unrecognized,"preserved_only_members":preserved_only,"file_reports":file_reports});
    serde_json::to_writer(
        &mut writer,
        &ProviderRecord {
            source: "oura".into(),
            collection: "export_files".into(),
            day: "_undated".into(),
            id: Some(sha256.clone()),
            data: metadata,
        },
    )
    .map_err(err)?;
    writer.write_all(b"\n").map_err(err)?;
    writer.flush().map_err(err)?;
    counts.insert("export_files".into(), 1);
    let attachments = BTreeMap::from([(
        ("export_files".into(), sha256.clone()),
        ExportAttachment {
            file: original,
            filename: filename.into(),
            sha256,
        },
    )]);
    let report = FetchReport {
        source: "oura".into(),
        since: since.clone().unwrap_or("1970-01-01".into()),
        until: until.clone().unwrap_or("1970-01-01".into()),
        collections: counts
            .into_iter()
            .map(|(collection, records)| CollectionResult {
                collection,
                status: "complete".into(),
                records,
                error: None,
            })
            .collect(),
    };
    progress("Merging Oura export records and original archive");
    let imported = store.apply_export(
        &records_path,
        &report,
        dry_run,
        account_id,
        None,
        &root,
        &attachments,
        progress,
    )?;
    Ok(
        json!({"complete":imported.complete,"dry_run":dry_run,"source":"oura","account_id":account_id,"records":records,"files":files,"unrecognized_records":unrecognized,"preserved_only_members":preserved_only,"file_reports":file_reports,"date_range":{"since":since,"until":until},"import":imported}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::QueryFilter;
    fn setup() -> (tempfile::TempDir, Store) {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        let library = temp.path().join("raw");
        let state = temp.path().canonicalize().unwrap().join("state");
        std::fs::create_dir(&vault).unwrap();
        std::fs::create_dir(&library).unwrap();
        crate::library::configure(&vault, &state, &library).unwrap();
        let store = Store::new(&vault, &state).unwrap();
        (temp, store)
    }
    fn archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }
    fn query(store: &Store, account: &str, metric: &str) -> Value {
        store
            .query_filtered(
                QueryFilter {
                    source: Some("oura"),
                    account_id: Some(account),
                    metric: Some(metric),
                    ..Default::default()
                },
                100,
                0,
            )
            .unwrap()
    }
    #[test]
    fn csv_quoting_bom_dates_and_raw_values() {
        let input = "\u{feff}id,day,active_calories,steps,label\r\nx,2026-10-24,100.010,123,\"line one,\nline two\"\r\n";
        let mut rows = vec![];
        parse(input.as_bytes(), &mut |v| {
            rows.push(record(v)?.unwrap());
            Ok(())
        })
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].collection, "export_daily_activity");
        assert_eq!(rows[0].data["active_calories"], "100.010");
        assert_eq!(rows[0].data["label"], "line one,\nline two");
        assert_eq!(rows[0].day, "2026-10-24");
    }
    #[test]
    fn json_v2_models_nested_values_and_local_timestamp() {
        let cases = [
            (
                json!({"id":"s","day":"2026-10-24","contributors":{"deep_sleep":50,"rem_sleep":70},"score":80,"timestamp":"2026-10-24T00:00:00+08:00"}),
                "daily_sleep",
            ),
            (
                json!({"id":"r","day":"2026-10-24","temperature_deviation":0.05999999999999999,"contributors":{},"timestamp":"2026-10-24T00:00:00+08:00"}),
                "daily_readiness",
            ),
            (
                json!({"timestamp":"2026-10-24T00:01:00+14:00","timestamp_unix":1792749660,"bpm":65,"source":"awake","data":{"untouched":[1,null,true]}}),
                "heartrate",
            ),
        ];
        for (payload, kind) in cases {
            let input = serde_json::to_vec(&json!({"data":[payload],"next_token":null})).unwrap();
            let mut rows = vec![];
            parse(&input, &mut |v| {
                rows.push(record(v)?.unwrap());
                Ok(())
            })
            .unwrap();
            assert_eq!(rows[0].data, payload);
            assert_eq!(rows[0].collection, format!("export_{kind}"));
            assert_eq!(rows[0].day, "2026-10-24");
        }
    }
    #[test]
    fn localized_zip_preview_incremental_accounts_and_one_original() {
        let (temp, store) = setup();
        let input = temp.path().join("我的数据.zip");
        let csv = b"id,day,active_calories,steps\na,2026-10-24,10,100\n";
        let json = br#"[{"id":"sleep1","day":"2026-10-24","bedtime_start":"2026-10-23T22:00:00+08:00","bedtime_end":"2026-10-24T06:00:00+08:00","time_in_bed":28800,"nested":{"a":[1,null]}}]"#;
        archive(
            &input,
            &[
                ("中文根/运动.CSV", csv),
                ("別名/s.json", json),
                ("说明.txt", b"original note"),
            ],
        );
        let account = crate::auth::account_id_for_subject("oura:offline:first");
        let second = crate::auth::account_id_for_subject("oura:offline:second");
        let before = store.status().unwrap();
        let preview = import(&store, &input, &account, true, &mut |_| {}).unwrap();
        assert_eq!(preview["records"], 2);
        assert_eq!(store.status().unwrap(), before);
        let first = import(&store, &input, &account, false, &mut |_| {}).unwrap();
        assert_eq!(first["preserved_only_members"], json!(["说明.txt"]));
        let state = store.status().unwrap();
        import(&store, &input, &account, false, &mut |_| {}).unwrap();
        assert_eq!(store.status().unwrap(), state);
        assert_eq!(
            query(&store, &account, "oura.export_daily_activity")["records"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            query(&store, &account, "oura.export_files")["records"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        import(&store, &input, &second, false, &mut |_| {}).unwrap();
        assert_eq!(
            query(&store, &second, "oura.export_sleep")["records"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            query(&store, &account, "oura.export_sleep")["records"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        // A later overlap updates the same identity, preserving older days and
        // both accounts; it does not overwrite the corresponding API collection.
        let update = temp.path().join("update.csv");
        std::fs::write(
            &update,
            b"id,day,active_calories,steps\na,2026-10-24,11,101\nb,2026-10-25,20,200\n",
        )
        .unwrap();
        import(&store, &update, &account, false, &mut |_| {}).unwrap();
        let values = query(&store, &account, "oura.export_daily_activity");
        assert_eq!(values["records"].as_array().unwrap().len(), 2);
        assert!(values["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["payload"]["steps"] == "101"));
        assert_eq!(
            query(&store, &second, "oura.export_daily_activity")["records"][0]["payload"]["steps"],
            "100"
        );
        assert!(std::fs::read_dir(temp.path().join("vault"))
            .unwrap()
            .next()
            .is_none());
    }
    #[test]
    fn unknown_corrupt_dates_paths_and_empty_identity_do_not_commit() {
        let (temp, store) = setup();
        let input = temp.path().join("input.json");
        let account = crate::auth::account_id_for_subject("oura:offline:test");
        let before = store.status().unwrap();
        for bytes in [
            br#"[{"day":"2026-10-24","score":42}]"#.as_slice(),
            br#"[{"day":"2026-02-30","active_calories":10,"steps":5}]"#,
            br#"{"bad":"#,
        ] {
            std::fs::write(&input, bytes).unwrap();
            assert!(import(&store, &input, &account, false, &mut |_| {}).is_err());
            assert_eq!(store.status().unwrap(), before);
        }
        assert!(import(&store, &input, "", false, &mut |_| {})
            .unwrap_err()
            .contains("explicit account"));
        let input = temp.path().join("bad.zip");
        archive(
            &input,
            &[(
                "../escape.csv",
                b"day,steps,active_calories\n2026-10-24,1,2\n",
            )],
        );
        assert!(import(&store, &input, &account, false, &mut |_| {})
            .unwrap_err()
            .contains("unsafe"));
        assert_eq!(store.status().unwrap(), before);
    }
    #[test]
    fn partial_unknown_records_are_visible_and_original_retained() {
        let (temp, store) = setup();
        let input = temp.path().join("mixed.json");
        std::fs::write(
            &input,
            br#"[{"day":"2026-10-24","active_calories":10,"steps":5},{"unknown":true}]"#,
        )
        .unwrap();
        let account = crate::auth::account_id_for_subject("oura:offline:test");
        let result = import(&store, &input, &account, false, &mut |_| {}).unwrap();
        assert_eq!(result["records"], 1);
        assert_eq!(result["unrecognized_records"], 1);
        assert_eq!(
            query(&store, &account, "oura.export_files")["records"][0]["payload"]["sha256"],
            hash(&std::fs::read(&input).unwrap())
        );
    }
}

#[cfg(test)]
mod dsr_collection_tests {
    use super::*;

    #[test]
    fn dsr_health_fields_keep_their_distinct_collections_and_raw_values() {
        let cases = [
            (
                json!({"timestamp":"2026-10-24T00:10:00.123Z","bpm":"61.00","imported_from":"synthetic-import","origin_source":"device-a"}),
                "imported_heartrate",
            ),
            (
                json!({"timestamp":"2026-10-24T00:10:00Z","end_time":"2026-10-24T00:15:00Z","steps":"12","imported_from":"synthetic-import","origin_source":"device-a"}),
                "imported_step_count",
            ),
            (
                json!({"timestamp":"2026-10-24T00:10:00Z","end_time":"2026-10-24T00:15:00Z","steps":"12"}),
                "step_count",
            ),
            (
                json!({"timestamp":"2026-10-24T00:10:00Z","skin_temp":"32.010"}),
                "temperature",
            ),
            (
                json!({"timestamp":"2026-10-24T00:10:00Z","acm_average_x":"0.01","acm_average_y":"0","acm_average_z":"0.02","motion_seconds":"30"}),
                "motion",
            ),
            (
                json!({"timestamp":"2026-10-24T00:10:00Z","recovery_value":"0.123","stress_value":"0.456"}),
                "daytime_stress",
            ),
            (
                json!({"day":"2026-10-24","average_bp_trend_sleep":"[]","bp_change_percentage":""}),
                "daily_cardiovascular_metrics",
            ),
            (
                json!({"day":"2026-10-24","cardiovascular_age":"40","pulse_wave_velocity":"6.010"}),
                "daily_smoothed_cardiovascular_age",
            ),
            (
                json!({"day":"2026-10-24","timestamp":"2026-10-24T12:00:00+08:00","vo2max":"40.10","confidence":"0.90"}),
                "daily_vo2_max_estimate",
            ),
            (
                json!({"timestamp":"2026-10-24T12:00:00+08:00","vo2max":"40.10","confidence":"0.90","workout_identifier":"workout-a"}),
                "vo2_max_workout_estimate",
            ),
            (
                json!({"day":"2026-10-24","start_time":"2026-10-24T12:00:00+08:00","end_time":"2026-10-24T12:30:00+08:00","predicted_activities":"[{\"activity\":\"walking\",\"value\":0.123}]"}),
                "activity_prediction_segment",
            ),
            (
                json!({"start_time":"2026-10-24T12:00:00+08:00","end_time":"2026-10-24T12:30:00+08:00","selected_activity_id":"walking"}),
                "workout_heartrate_session",
            ),
            (
                json!({"timestamp":"2026-10-24T00:10:00.000+14:00","identifier":"Pacific/Kiritimati","offset":"50400"}),
                "timezone",
            ),
            (
                json!({"day":"2026-10-24","food_item_ids":"[\"food-a\"]","nutrition_details":"{\"unknown\":null}","start_time":"2026-10-24T12:00:00+08:00"}),
                "meal",
            ),
            (
                json!({"day":"2026-10-24","threshold1":"100","threshold2":"120","threshold3":"140","threshold4":"160"}),
                "cardio_effort_baselines",
            ),
        ];
        for (payload, expected) in cases {
            let parsed = record(payload.clone()).unwrap().unwrap();
            assert_eq!(parsed.collection, format!("export_{expected}"));
            assert_eq!(parsed.day, "2026-10-24");
            assert_eq!(parsed.data, payload);
            assert_eq!(record(payload).unwrap().unwrap().id, parsed.id);
        }
    }

    #[test]
    fn dsr_sensor_identity_preserves_simultaneous_sources_and_values() {
        let original = json!({"timestamp":"2026-10-24T00:10:00Z","bpm":"60","imported_from":"device-a","origin_source":"source-a"});
        let first = record(original.clone()).unwrap().unwrap();
        let mut other_source = original.clone();
        other_source["origin_source"] = json!("source-b");
        assert_ne!(first.id, record(other_source).unwrap().unwrap().id);
        let mut other_value = original.clone();
        other_value["bpm"] = json!("61");
        assert_ne!(first.id, record(other_value).unwrap().unwrap().id);
        let mut explicit = original;
        explicit["id"] = json!("stable-id");
        assert_eq!(
            record(explicit).unwrap().unwrap().id.as_deref(),
            Some("stable-id")
        );
        // Existing V2 sample IDs still use timestamp/source identity.
        let old = json!({"timestamp":"2026-10-24T00:10:00Z","bpm":60,"source":"awake"});
        let expected =
            hash(&serde_json::to_vec(&(old.get("timestamp"), old.get("source"))).unwrap());
        assert_eq!(record(old).unwrap().unwrap().id, Some(expected));
    }

    #[test]
    fn dsr_unrelated_rows_stay_raw_and_bad_sensor_dates_are_rejected() {
        for payload in [
            json!({"timestamp":"2026-10-24T00:10:00Z","latitude":"0","longitude":"0","altitude":"0"}),
            json!({"id":"food-a","name":"synthetic-food","weight":"10"}),
            json!({"id":"setting-a","enabled":"true","next_dose_timestamp":"2026-10-24T00:10:00Z","start_timestamp":"2026-10-23T00:10:00Z"}),
            json!({"Contact: ID":"synthetic-id","Contact: First Name":"synthetic"}),
        ] {
            assert!(record(payload).unwrap().is_none());
        }
        for timestamp in ["2026-02-30T12:00:00Z", "", "not-a-date"] {
            let error = record(json!({"timestamp":timestamp,"skin_temp":"32.01"})).unwrap_err();
            assert!(error.contains("timestamp"));
        }
    }
}

#[cfg(test)]
mod dsr_stream_tests {
    use super::*;

    #[test]
    fn semicolon_csv_preserves_nested_json_quotes_and_multiline_cells() {
        let input = "\u{feff}id;day;contributors;score;note\r\ns;2026-10-30;\"{\"\"deep_sleep\"\":80,\"\"rem_sleep\"\":75}\";80.010;\"comma,semicolon;\n第二行\"\r\n";
        let mut rows = vec![];
        parse(input.as_bytes(), &mut |row| {
            rows.push(record(row)?.unwrap());
            Ok(())
        })
        .unwrap();
        assert_eq!(rows[0].collection, "export_daily_sleep");
        assert_eq!(rows[0].day, "2026-10-30");
        assert_eq!(rows[0].data["score"], "80.010");
        assert_eq!(
            rows[0].data["contributors"],
            r#"{"deep_sleep":80,"rem_sleep":75}"#
        );
        assert_eq!(rows[0].data["note"], "comma,semicolon;\n第二行");
        assert_eq!(csv_delimiter(b"id,\"label;a;b\",day\n"), b',');
    }

    #[test]
    fn header_only_empty_and_duplicate_semicolon_headers() {
        for input in ["", "\u{feff}", "id;day;steps;active_calories\r\n"] {
            let mut count = 0;
            parse(input.as_bytes(), &mut |_| {
                count += 1;
                Ok(())
            })
            .unwrap();
            assert_eq!(count, 0);
        }
        assert!(parse(b"id;day;day\nx;2026-10-30;2026-10-30\n", &mut |_| Ok(())).is_err());
        assert!(parse(b"id;day;steps\nx;2026-10-30\n", &mut |_| Ok(())).is_err());
    }

    #[test]
    fn zip_over_64_mib_csv_is_streamed_and_file_coverage_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        let library = temp.path().join("raw");
        let state = temp.path().canonicalize().unwrap().join("state");
        std::fs::create_dir(&vault).unwrap();
        std::fs::create_dir(&library).unwrap();
        crate::library::configure(&vault, &state, &library).unwrap();
        let store = Store::new(&vault, &state).unwrap();
        let input = temp.path().join("国际化导出.zip");
        let mut zip = zip::ZipWriter::new(File::create(&input).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("别名/other.csv", options).unwrap();
        zip.write_all(b"unrecognized_column\n").unwrap();
        let row = format!("{}\n", "x".repeat(1023));
        for _ in 0..65537 {
            zip.write_all(row.as_bytes()).unwrap();
        }
        zip.start_file("更名/睡眠.csv", options).unwrap();
        zip.write_all(b"id;day;bedtime_start;bedtime_end\ns;2026-10-30;2026-10-29T22:00:00+08:00;2026-10-30T06:00:00+08:00\n").unwrap();
        zip.start_file("empty.csv", options).unwrap();
        zip.write_all(b"id;day;steps;active_calories\n").unwrap();
        zip.start_file("events.ndjson", options).unwrap();
        zip.finish().unwrap();
        let before = store.status().unwrap();
        let account = crate::auth::account_id_for_subject("oura:offline:isolated-test");
        let result = import(&store, &input, &account, true, &mut |_| {}).unwrap();
        assert_eq!(store.status().unwrap(), before);
        assert_eq!(result["records"], 1);
        assert_eq!(result["unrecognized_records"], 65537);
        let reports = result["file_reports"].as_array().unwrap();
        assert_eq!(reports.len(), 4);
        assert_eq!(reports[0]["status"], "unrecognized");
        assert_eq!(reports[1]["parsed_records"], 1);
        assert_eq!(reports[2]["status"], "empty");
        assert_eq!(reports[3]["status"], "preserved_only");
        assert!(std::fs::read_dir(&vault).unwrap().next().is_none());
    }
}
