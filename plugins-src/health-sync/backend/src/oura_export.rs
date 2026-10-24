//! Offline Oura exports use the public V2 data models linked by Membership Hub.
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
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

const MAX_MEMBER: u64 = 64 * 1024 * 1024;
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
    if has("bedtime_start") && has("bedtime_end") {
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

fn parse(bytes: &[u8], emit: &mut dyn FnMut(Value) -> Result<(), String>) -> Result<(), String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "Oura export CSV/JSON must be UTF-8")?
        .trim_start_matches('\u{feff}');
    let trimmed = text.trim_start();
    if trimmed.starts_with('[') || trimmed.starts_with('{') {
        json_rows(
            serde_json::from_str(trimmed).map_err(|_| "Invalid Oura export JSON")?,
            emit,
        )
    } else {
        let mut csv = csv::ReaderBuilder::new().from_reader(text.as_bytes());
        let headers = csv
            .headers()
            .map_err(|_| "Invalid Oura export CSV header")?
            .clone();
        let unique: BTreeSet<_> = headers.iter().collect();
        if headers.is_empty() || unique.len() != headers.len() || headers.iter().any(str::is_empty)
        {
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
            if last.elapsed().as_secs() >= 3 {
                progress(&format!("Reading Oura export: {records} records"));
                last = std::time::Instant::now();
            }
        } else {
            unrecognized += 1;
        }
        Ok(())
    };
    let mut header = [0; 4];
    let mut archive = File::open(&original).map_err(err)?;
    let n = archive.read(&mut header).map_err(err)?;
    archive.rewind().map_err(err)?;
    let mut preserved_only = Vec::<String>::new();
    let mut files = 0;
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
            if total > MAX_TOTAL || entry.size() > MAX_MEMBER {
                return Err("Oura ZIP exceeds 64 MiB/member or 4 GiB total limit".into());
            }
            let mut bytes = Vec::new();
            let expected = entry.size();
            (&mut entry)
                .take(MAX_MEMBER + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Invalid Oura ZIP member data or CRC")?;
            if bytes.len() as u64 != expected {
                return Err("Oura ZIP member size disagrees".into());
            }
            files += 1;
            let ext = Path::new(&name)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if matches!(ext.as_str(), "csv" | "json") {
                parse(&bytes, &mut emit)?;
            } else {
                preserved_only.push(name);
            }
        }
    } else {
        if size > MAX_MEMBER {
            return Err("Oura standalone CSV/JSON exceeds 64 MiB parsing limit".into());
        }
        let mut bytes = Vec::new();
        archive.read_to_end(&mut bytes).map_err(err)?;
        parse(&bytes, &mut emit)?;
        files = 1;
    }
    drop(emit);
    if records == 0 {
        return Err("No recognized Oura V2 records found; no data was imported".into());
    }
    let metadata = json!({"filename":filename,"sha256":sha256,"size":size,"parsed_records":records,"unrecognized_records":unrecognized,"preserved_only_members":preserved_only});
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
        json!({"complete":imported.complete,"dry_run":dry_run,"source":"oura","account_id":account_id,"records":records,"files":files,"unrecognized_records":unrecognized,"preserved_only_members":preserved_only,"date_range":{"since":since,"until":until},"import":imported}),
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
