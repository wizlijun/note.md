//! Offline Garmin privacy exports. Keep source bytes, parse known JSON shapes,
//! and merge observed records without claiming that an archive is a full snapshot.
use crate::{
    auth::{account_id_for_subject, GarminRegion},
    providers::{CollectionResult, FetchReport, ProviderRecord},
    store::{hash, valid_day, ExportAttachment, Store},
};
use chrono::DateTime;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

const MAX_FILES: usize = 100_000;
const MAX_FILE: u64 = 1024 * 1024 * 1024;
const MAX_TOTAL: u64 = 64 * 1024 * 1024 * 1024;
const MAX_JSON: u64 = 64 * 1024 * 1024;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
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

// zip 2.x indexes entries by name, silently collapsing duplicate central-directory
// entries. Count physical headers so every source member must remain visible.
fn verify_member_count(mut file: File, start: u64, expected: usize) -> Result<(), String> {
    file.seek(SeekFrom::Start(start)).map_err(err)?;
    let mut count = 0;
    loop {
        let mut signature = [0u8; 4];
        file.read_exact(&mut signature).map_err(err)?;
        if signature != *b"PK\x01\x02" {
            break;
        }
        count += 1;
        if count > expected {
            return Err("Garmin ZIP contains duplicate member names".into());
        }
        let mut header = [0u8; 42];
        file.read_exact(&mut header).map_err(err)?;
        let length = [24, 26, 28]
            .iter()
            .map(|i| u16::from_le_bytes([header[*i], header[*i + 1]]) as i64)
            .sum();
        file.seek(SeekFrom::Current(length)).map_err(err)?;
    }
    if count != expected {
        return Err("Garmin ZIP central directory entry count disagrees".into());
    }
    Ok(())
}

fn profile_id(value: &Value) -> Result<String, String> {
    let id = match value {
        Value::Number(n) => n.as_u64().filter(|n| *n > 0),
        Value::String(s) => s.parse::<u64>().ok().filter(|n| *n > 0),
        _ => None,
    };
    id.map(|n| n.to_string())
        .ok_or_else(|| "Invalid Garmin profile identity in export".into())
}

// Only Garmin profile identifiers are comparable with the Personal API. The
// customer/account GUID, usernames, social profile IDs and device IDs are not.
fn collect_identity(value: &Value, identities: &mut BTreeSet<String>) -> Result<(), String> {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_identity(item, identities)?;
            }
        }
        Value::Object(object) => {
            if collection(value) == Some("export_activities") {
                if let Some(owner) = object.get("ownerId").filter(|v| !v.is_null()) {
                    identities.insert(profile_id(owner)?);
                    if identities.len() > 1 {
                        return Err("Garmin export contains multiple profile identities; no data was imported".into());
                    }
                }
            }
            for (key, value) in object {
                if ["userProfilePK", "userProfilePk", "userProfileId"].contains(&key.as_str())
                    && !value.is_null()
                {
                    identities.insert(profile_id(value)?);
                    if identities.len() > 1 {
                        return Err("Garmin export contains multiple profile identities; no data was imported".into());
                    }
                }
                collect_identity(value, identities)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Recognize content, rather than localized filenames or a particular ZIP root.
fn collection(row: &Value) -> Option<&'static str> {
    let has = |key: &str| row.get(key).is_some();
    if has("activityId") && (has("startTimeLocal") || has("beginTimestamp")) {
        Some("export_activities")
    } else if has("calendarDate")
        && (has("totalSteps") || (has("uuid") && has("durationInMilliseconds")))
    {
        Some("export_daily_summaries")
    } else if has("napStartTimestampGMT") && has("calendarDate") {
        Some("export_sleep_naps")
    } else if has("sleepStartTimestampGMT") && has("calendarDate") {
        Some("export_sleep")
    } else if has("valueInML") && has("hydrationSource") {
        Some("export_hydration")
    } else if has("dailyTrainingLoadAcute") || has("acwrPercent") {
        Some("export_acute_training_load")
    } else if has("trainingStatus") && has("calendarDate") {
        Some("export_training_history")
    } else if has("sleepScoreFactorPercent") && has("calendarDate") {
        Some("export_training_readiness")
    } else if has("hillScoreClassificationId") {
        Some("export_hill_score")
    } else if has("enduranceScoreContributor") {
        Some("export_endurance_score")
    } else if has("heatAcclimationPercentage") || has("altitudeAcclimation") {
        Some("export_acclimation")
    } else if has("vo2MaxValue") && has("calendarDate") {
        Some("export_vo2max")
    } else if has("raceTime5K") {
        Some("export_race_predictions")
    } else if has("abnormalHrEventGMT") {
        Some("export_abnormal_heart_rate")
    } else if has("outliersCount") && has("metrics") && has("calendarDate") {
        Some("export_health_status")
    } else if has("wellnessActivityType") && has("calendarDate") {
        Some("export_wellness_activities")
    } else if has("asOfDateGmt") && has("currentBioAge") {
        Some("export_fitness_age")
    } else if has("personalRecordId") && has("personalRecordType") {
        Some("export_personal_records")
    } else if has("userSetNullForWeight") && has("metaData") {
        Some("export_body_biometrics")
    } else if has("zone1Floor") && has("maxHeartRateUsed") {
        Some("export_heart_rate_zones")
    } else if has("zone1Floor") && has("functionalThresholdPower") {
        Some("export_power_zones")
    } else if has("lactateThresholdHeartRate") || (has("height") && has("weight") && has("vo2Max"))
    {
        Some("export_biometric_profile")
    } else {
        None
    }
}

fn parse_day(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        if s.get(..10).is_some_and(valid_day)
            && (s.len() == 10 || matches!(s.as_bytes()[10], b'T' | b' '))
        {
            return Some(s[..10].into());
        }
    }
    // Garmin JSON local timestamps are also represented as epoch milliseconds.
    // Decode their calendar components as stored, without applying this Mac's zone.
    let millis = value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|n| {
                n.is_finite() && n.fract() == 0.0 && *n >= i64::MIN as f64 && *n < i64::MAX as f64
            })
            .map(|n| n as i64)
    })?;
    if !(0..=253402300799999).contains(&millis) {
        return None;
    }
    DateTime::from_timestamp_millis(millis).map(|d| d.format("%Y-%m-%d").to_string())
}

fn record_day(row: &Value) -> Result<String, String> {
    for key in [
        "calendarDate",
        "startTimeLocal",
        "startTimestampLocal",
        "asOfDateGmt",
        "startTimeGmt",
        "beginTimestamp",
    ] {
        if let Some(value) = row.get(key).filter(|v| !v.is_null()) {
            return parse_day(value)
                .ok_or_else(|| format!("Invalid Garmin export date field: {key}"));
        }
    }
    if let Some(value) = row.pointer("/metaData/calendarDate") {
        return parse_day(value).ok_or_else(|| "Invalid Garmin biometric calendarDate".into());
    }
    // Unknown date formats are retained, not guessed from filenames or import time.
    Ok("_undated".into())
}

fn record_id(row: &Value, collection: &str) -> Result<String, String> {
    let key = match collection {
        "export_activities" => Some("activityId"),
        "export_personal_records" => Some("personalRecordId"),
        "export_daily_summaries" | "export_hydration" => Some("uuid"),
        _ => None,
    };
    if let Some((key, value)) =
        key.and_then(|k| row.get(k).filter(|v| !v.is_null()).map(|v| (k, v)))
    {
        let value = if key == "uuid" && value.is_object() {
            value
                .get("uuid")
                .ok_or("Invalid Garmin export UUID object")?
        } else {
            value
        };
        if value.is_number() || value.as_str().is_some_and(|s| !s.is_empty()) {
            return Ok(format!(
                "{key}:{}",
                serde_json::to_string(value).map_err(err)?
            ));
        }
        return Err(format!("Invalid Garmin export identity field: {key}"));
    }
    Ok(format!(
        "content:{}",
        hash(&serde_json::to_vec(row).map_err(err)?)
    ))
}

fn rows(
    value: &Value,
    emit: &mut dyn FnMut(&Value, &str) -> Result<(), String>,
) -> Result<(u64, u64), String> {
    let mut parsed = 0;
    let mut unknown = 0;
    let items = match value {
        Value::Array(v) => v.as_slice(),
        _ => std::slice::from_ref(value),
    };
    for item in items {
        if let Some(naps) = item.get("napList").filter(|v| !v.is_null()) {
            for nap in naps.as_array().ok_or("Invalid Garmin napList")? {
                if collection(nap) != Some("export_sleep_naps") {
                    return Err("Invalid Garmin nap record".into());
                }
                emit(nap, "export_sleep_naps")?;
                parsed += 1;
            }
        }
        // These wrappers can span several files; none is an account-wide snapshot.
        let wrapper = ["summarizedActivitiesExport", "personalRecords"]
            .into_iter()
            .find(|key| item.get(*key).is_some());
        if let Some(key) = wrapper {
            let wrapped = item[key]
                .as_array()
                .ok_or("Invalid Garmin export collection wrapper")?;
            for row in wrapped {
                let kind =
                    collection(row).ok_or("Unrecognized row in Garmin activity/record wrapper")?;
                emit(row, kind)?;
                parsed += 1;
            }
            // Any additional wrapper fields remain available in the original file.
            if item.as_object().is_some_and(|o| o.len() > 1) {
                unknown += 1;
            }
        } else if let Some(kind) = collection(item) {
            emit(item, kind)?;
            parsed += 1;
        } else if !item.is_null() {
            unknown += 1;
        }
    }
    Ok((parsed, unknown))
}

pub fn import(
    store: &Store,
    input: &Path,
    region: GarminRegion,
    dry_run: bool,
    progress: &mut dyn FnMut(&str),
) -> Result<Value, String> {
    let input = File::open(input).map_err(|e| format!("Cannot open Garmin export: {e}"))?;
    if !input.metadata().map_err(err)?.is_file() {
        return Err("Garmin export must be a regular ZIP file".into());
    }
    let directory_reader = input.try_clone().map_err(err)?;
    let mut zip =
        zip::ZipArchive::new(input).map_err(|e| format!("Invalid Garmin export ZIP: {e}"))?;
    if zip.len() > MAX_FILES {
        return Err("Garmin ZIP has too many entries".into());
    }
    verify_member_count(directory_reader, zip.central_directory_start(), zip.len())?;
    let staging = tempfile::Builder::new()
        .prefix("garmin-export-")
        .tempdir()
        .map_err(err)?;
    let staging_root = staging.path().canonicalize().map_err(err)?;
    let records_path = staging_root.join("records.jsonl");
    let mut output = BufWriter::new(File::create(&records_path).map_err(err)?);
    let mut names = BTreeSet::new();
    let mut identities = BTreeSet::new();
    let mut attachments = BTreeMap::new();
    let mut counts = BTreeMap::<String, u64>::new();
    let mut file_reports = vec![];
    let mut min_day: Option<String> = None;
    let mut max_day: Option<String> = None;
    let mut total = 0u64;
    let mut parsed_files = 0;
    let mut records = 0;
    let mut last = std::time::Instant::now();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(err)?;
        let name = entry.name().to_string();
        if !safe_name(&name) || !names.insert(name.trim_end_matches('/').to_string()) {
            return Err("Garmin ZIP contains an unsafe or duplicate member path".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|m| !matches!(m & 0o170000, 0 | 0o100000 | 0o040000))
        {
            return Err("Garmin ZIP contains a symlink or non-regular member".into());
        }
        if entry.is_dir() {
            continue;
        }
        let size = entry.size();
        total = total.checked_add(size).ok_or("Garmin ZIP size overflow")?;
        if size > MAX_FILE || total > MAX_TOTAL {
            return Err(
                "Garmin ZIP exceeds uncompressed size limit (1 GiB/file, 64 GiB total)".into(),
            );
        }
        let path = staging_root.join(format!("member-{index}"));
        let mut file = File::create(&path).map_err(err)?;
        let mut digest = Sha256::new();
        let mut actual = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let n = entry
                .read(&mut buffer)
                .map_err(|_| "Garmin ZIP member data/CRC is invalid")?;
            if n == 0 {
                break;
            }
            actual += n as u64;
            if actual > size {
                return Err("Garmin ZIP member size disagrees with header".into());
            }
            digest.update(&buffer[..n]);
            file.write_all(&buffer[..n]).map_err(err)?;
        }
        if actual != size {
            return Err("Garmin ZIP member is truncated".into());
        }
        file.flush().map_err(err)?;
        let sha256 = format!("{:x}", digest.finalize());
        let mut parsed = 0;
        let mut unparsed = 0;
        let mut reason = "non-JSON source; original bytes retained";
        if name.to_ascii_lowercase().ends_with(".json") && size <= MAX_JSON {
            let value: Value =
                serde_json::from_reader(BufReader::new(File::open(&path).map_err(err)?))
                    .map_err(|_| "Invalid JSON in Garmin export; no data was imported")?;
            collect_identity(&value, &mut identities)?;
            (parsed, unparsed) = rows(&value, &mut |row, kind| {
                let day = record_day(row)?;
                if day != "_undated" {
                    if min_day.as_ref().is_none_or(|d| day < *d) {
                        min_day = Some(day.clone());
                    }
                    if max_day.as_ref().is_none_or(|d| day > *d) {
                        max_day = Some(day.clone());
                    }
                }
                let record = ProviderRecord {
                    source: "garmin".into(),
                    collection: kind.into(),
                    day,
                    id: Some(record_id(row, kind)?),
                    data: row.clone(),
                };
                serde_json::to_writer(&mut output, &record).map_err(err)?;
                output.write_all(b"\n").map_err(err)?;
                *counts.entry(kind.into()).or_default() += 1;
                records += 1;
                Ok(())
            })?;
            reason = if unparsed > 0 {
                "unrecognized JSON content retained in original file"
            } else {
                "recognized JSON records (empty arrays contain no records)"
            };
            if parsed > 0 {
                parsed_files += 1;
            }
        } else if name.to_ascii_lowercase().ends_with(".json") {
            reason = "JSON exceeds 64 MiB parsing limit; original bytes retained";
        }
        let id = hash(&serde_json::to_vec(&(&name, &sha256)).map_err(err)?);
        let metadata = json!({"filename":name,"sha256":sha256,"size":size,"parsed_records":parsed,"unparsed_items":unparsed,"note":reason});
        let record = ProviderRecord {
            source: "garmin".into(),
            collection: "export_files".into(),
            day: "_undated".into(),
            id: Some(id.clone()),
            data: metadata.clone(),
        };
        serde_json::to_writer(&mut output, &record).map_err(err)?;
        output.write_all(b"\n").map_err(err)?;
        *counts.entry("export_files".into()).or_default() += 1;
        attachments.insert(
            ("export_files".into(), id),
            ExportAttachment {
                file: path,
                filename: name,
                sha256,
            },
        );
        file_reports.push(metadata);
        if last.elapsed().as_secs() >= 5 {
            progress(&format!(
                "Reading Garmin export: {} files, {records} records",
                file_reports.len()
            ));
            last = std::time::Instant::now();
        }
    }
    output.flush().map_err(err)?;
    let identity=identities.into_iter().next().ok_or("No Garmin profile identity found in export; import requires a profile ID, not a name or email")?;
    let subject = match region {
        GarminRegion::China => format!("garmin:china:{identity}"),
        GarminRegion::Global => format!("garmin:{identity}"),
    };
    let account_id = account_id_for_subject(&subject);
    let report = FetchReport {
        source: "garmin".into(),
        since: min_day.clone().unwrap_or("1970-01-01".into()),
        until: max_day.clone().unwrap_or("1970-01-01".into()),
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
    progress("Merging Garmin export records and original files");
    let imported = store.apply_garmin_export(
        &records_path,
        &report,
        dry_run,
        &account_id,
        region,
        &staging_root,
        &attachments,
        progress,
    )?;
    Ok(
        json!({"complete":imported.complete,"dry_run":dry_run,"source":"garmin","account_id":account_id,"region":region,"records":records,"files":file_reports.len(),"parsed_files":parsed_files,"preserved_only_files":file_reports.len()-parsed_files,"date_range":{"since":min_day,"until":max_day},"file_reports":file_reports,"import":imported}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::QueryFilter;
    use zip::write::SimpleFileOptions;

    fn archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, data) in entries {
            zip.start_file(
                *name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }
    fn sample(profile: u64, activity: u64) -> Vec<u8> {
        serde_json::to_vec(&json!([{"summarizedActivitiesExport":[{
            "userProfileId":profile,"activityId":activity,"startTimeLocal":1735689600000.0,
            "startTimeGmt":1735660800000.0,"distance":123.5,
            "nested":{"untouched":[1,"two",null]}
        }]}]))
        .unwrap()
    }
    fn setup() -> (tempfile::TempDir, Store) {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        std::fs::create_dir(&vault).unwrap();
        let state = temp.path().canonicalize().unwrap().join("state");
        let store = Store::new(&vault, &state).unwrap();
        (temp, store)
    }
    #[test]
    fn localized_wrappers_dates_original_files_preview_and_repeat() {
        let (tmp, store) = setup();
        let zip = tmp.path().join("任意名称.zip");
        let activities = sample(42, 7);
        let sleep=br#"[{"calendarDate":"2025-01-02","sleepStartTimestampGMT":"2025-01-01T22:00:00.0","deepSleepSeconds":12}]"#;
        archive(
            &zip,
            &[
                ("不同的根目录/活动.JSON", &activities),
                ("different/sleep.json", sleep),
                ("raw/track.fit", b"original FIT bytes"),
                ("empty.bin", b""),
            ],
        );
        let preview = import(&store, &zip, GarminRegion::China, true, &mut |_| {}).unwrap();
        assert_eq!(preview["records"], 2);
        assert_eq!(preview["files"], 4);
        assert_eq!(
            preview["date_range"],
            json!({"since":"2025-01-01","until":"2025-01-02"})
        );
        assert!(!tmp.path().join("vault/health").exists());
        let first = import(&store, &zip, GarminRegion::China, false, &mut |_| {}).unwrap();
        assert_eq!(
            first["account_id"],
            account_id_for_subject("garmin:china:42")
        );
        assert_eq!(first["preserved_only_files"], 2);
        let result = store
            .query_filtered(
                QueryFilter {
                    source: Some("garmin"),
                    metric: Some("garmin.export_activities"),
                    ..Default::default()
                },
                100,
                0,
            )
            .unwrap();
        assert_eq!(
            result["records"][0]["payload"]["nested"],
            json!({"untouched":[1,"two",null]})
        );
        let before = store.status().unwrap();
        let second = import(&store, &zip, GarminRegion::China, false, &mut |_| {}).unwrap();
        assert_eq!(second["complete"], true);
        assert_eq!(store.status().unwrap(), before);
        let files = store
            .query_filtered(
                QueryFilter {
                    metric: Some("garmin.export_files"),
                    ..Default::default()
                },
                100,
                0,
            )
            .unwrap();
        for row in files["records"].as_array().unwrap() {
            let p = &row["payload"];
            let bytes = std::fs::read(
                tmp.path()
                    .join("vault")
                    .join(p["attachment_path"].as_str().unwrap()),
            )
            .unwrap();
            assert_eq!(hash(&bytes), p["sha256"]);
        }
    }
    #[test]
    fn parts_and_accounts_accumulate_without_touching_current_auth() {
        let (tmp, store) = setup();
        let zip = tmp.path().join("part.zip");
        for (profile, id) in [(42, 7), (42, 8), (99, 7)] {
            let data = sample(profile, id);
            archive(&zip, &[("活动.json", &data)]);
            import(&store, &zip, GarminRegion::China, false, &mut |_| {}).unwrap();
        }
        let id = account_id_for_subject("garmin:china:42");
        let rows = store
            .query_filtered(
                QueryFilter {
                    account_id: Some(&id),
                    metric: Some("garmin.export_activities"),
                    ..Default::default()
                },
                100,
                0,
            )
            .unwrap();
        assert_eq!(rows["records"].as_array().unwrap().len(), 2);
        let id = account_id_for_subject("garmin:china:99");
        let rows = store
            .query_filtered(
                QueryFilter {
                    account_id: Some(&id),
                    metric: Some("garmin.export_activities"),
                    ..Default::default()
                },
                100,
                0,
            )
            .unwrap();
        assert_eq!(rows["records"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn malformed_mixed_identity_and_unsafe_archives_fail_before_commit() {
        let (tmp, store) = setup();
        let zip = tmp.path().join("input.zip");
        let a = sample(42, 7);
        let b = sample(99, 8);
        for entries in [
            vec![("a.json", a.as_slice()), ("b.json", b.as_slice())],
            vec![("../escape.json", a.as_slice())],
            vec![("a.json", b"{".as_slice())],
            vec![("not-garmin.json", b"{\"id\":42}".as_slice())],
        ] {
            archive(&zip, &entries);
            assert!(import(&store, &zip, GarminRegion::China, false, &mut |_| {}).is_err());
            assert!(!tmp.path().join("vault/health").exists());
        }
        let bad = serde_json::to_vec(
            &json!([{"userProfilePK":42,"totalSteps":1,"calendarDate":"非日期非日期"}]),
        )
        .unwrap();
        archive(&zip, &[("bad-date.json", &bad)]);
        assert!(import(&store, &zip, GarminRegion::China, false, &mut |_| {}).is_err());
        let mixed = serde_json::to_vec(&json!([
            {"settings":{"userProfilePk":42}},
            {"activityId":7,"ownerId":99,"startTimeLocal":1735689600000_i64}
        ]))
        .unwrap();
        archive(&zip, &[("owners.json", &mixed)]);
        assert!(
            import(&store, &zip, GarminRegion::China, false, &mut |_| {})
                .unwrap_err()
                .contains("multiple profile")
        );
    }
    #[test]
    fn corrupt_duplicate_and_symlink_members_are_rejected() {
        let (tmp, store) = setup();
        let path = tmp.path().join("unsafe.zip");
        let data = sample(42, 7);
        archive(&path, &[("a.json", &data), ("b.json", &data)]);
        let bytes = std::fs::read(&path).unwrap();
        let bytes = bytes
            .windows(6)
            .enumerate()
            .filter_map(|(i, w)| (w == b"b.json").then_some(i))
            .collect::<Vec<_>>()
            .into_iter()
            .fold(bytes, |mut b, i| {
                b[i] = b'a';
                b
            });
        std::fs::write(&path, bytes).unwrap();
        assert!(
            import(&store, &path, GarminRegion::China, false, &mut |_| {})
                .unwrap_err()
                .contains("duplicate")
        );
        archive(
            &path,
            &[("a.json", &data), ("raw.bin", b"unique raw marker")],
        );
        let mut bytes = std::fs::read(&path).unwrap();
        let pos = bytes
            .windows(17)
            .position(|w| w == b"unique raw marker")
            .unwrap();
        bytes[pos] = b'X';
        std::fs::write(&path, bytes).unwrap();
        assert!(
            import(&store, &path, GarminRegion::China, false, &mut |_| {})
                .unwrap_err()
                .contains("CRC")
        );
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        zip.add_symlink("shortcut", "outside", SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
        assert!(
            import(&store, &path, GarminRegion::China, false, &mut |_| {})
                .unwrap_err()
                .contains("symlink")
        );
        assert!(!tmp.path().join("vault/health").exists());
    }

    #[test]
    fn unknown_json_is_retained_and_dates_never_use_import_time() {
        assert_eq!(
            parse_day(&json!(1735689600000.0)),
            Some("2025-01-01".into())
        );
        assert_eq!(
            parse_day(&json!("2025-01-01T23:30:00-08:00")),
            Some("2025-01-01".into())
        );
        assert_eq!(parse_day(&json!("非日期非日期")), None);
        assert_eq!(
            record_day(&json!({"futureDate":"unknown"})).unwrap(),
            "_undated"
        );
        let (tmp, store) = setup();
        let zip = tmp.path().join("future.zip");
        archive(
            &zip,
            &[(
                "new.json",
                br#"{"settings":{"userProfilePk":42},"unknown":{"doNotDrop":[1,2]}}"#,
            )],
        );
        let result = import(&store, &zip, GarminRegion::Global, false, &mut |_| {}).unwrap();
        assert_eq!(result["records"], 0);
        assert_eq!(result["preserved_only_files"], 1);
        assert_eq!(result["date_range"], json!({"since":null,"until":null}));
    }
    #[test]
    fn decimal_payloads_retain_the_source_float_bits() {
        // Synthetic long decimals exercise the values found in vendor JSON;
        // preserving raw attachments alone must not hide changes in query data.
        for i in 1..1000 {
            let decimal = format!("{:.17}", (i as f64).sqrt());
            let expected = decimal.parse::<f64>().unwrap();
            let parsed: Value = serde_json::from_str(&decimal).unwrap();
            assert_eq!(parsed.as_f64().unwrap().to_bits(), expected.to_bits());
            assert_eq!(
                serde_json::from_str::<Value>(&serde_json::to_string(&parsed).unwrap()).unwrap(),
                parsed
            );
        }
    }

    #[test]
    fn sparse_daily_naps_and_nested_biometric_date_are_not_lost() {
        assert_eq!(
            record_id(&json!({"uuid":{"uuid":"stable"}}), "export_hydration").unwrap(),
            record_id(&json!({"uuid":"stable"}), "export_hydration").unwrap()
        );
        let data = json!([
            {"userProfilePK":42,"uuid":"daily","calendarDate":1735689600000_i64,"durationInMilliseconds":86400000,"bodyBattery":{"arbitrary":1}},
            {"retro":false,"napList":[{"calendarDate":"2025-01-02","napStartTimestampGMT":"2025-01-02T12:00:00.0","napEndTimestampGMT":"2025-01-02T12:10:00.0","napTimeSec":600}]},
            {"userSetNullForWeight":false,"metaData":{"userProfilePK":42,"calendarDate":"2025-01-03T00:00:00.0","sequence":1}}
        ]);
        let mut emitted = vec![];
        rows(&data, &mut |row, kind| {
            emitted.push((kind.to_string(), record_day(row)?));
            Ok(())
        })
        .unwrap();
        assert_eq!(
            emitted,
            vec![
                ("export_daily_summaries".into(), "2025-01-01".into()),
                ("export_sleep_naps".into(), "2025-01-02".into()),
                ("export_body_biometrics".into(), "2025-01-03".into())
            ]
        );
    }
}
