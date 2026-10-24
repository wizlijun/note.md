//! Garmin's official Personal API, verified against its October 2026 OpenAPI.
//! https://developer.garmin.com/gc-developer-program/personal/swagger-docs/
//!
//! These are Personal API paths, not the unofficial Connect mobile API. Every
//! response is retained without projecting known fields. The 26 documented GET
//! operations are covered by 24 operations: dailySleep replaces the range of the
//! same DailySleepDTO, and hrv/{date} contains the range endpoint's userProfilePk
//! and hrvSummary plus its readings. Both generations of daily summary and both
//! weight endpoints are retained because their representations differ.
//!
//! Collection status is authoritative: callers must discard staged records for
//! an unavailable collection and retain its previous snapshot. Any Err invalidates
//! the entire requested window, even when emit has already received records.
use crate::providers::{CollectionResult, FetchReport, ProviderRecord, Transport};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Days, NaiveDate};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const SOURCE: &str = "garmin";
const PAGE_SIZE: usize = 99;
const MAX_ACTIVITY_PAGES: usize = 10_000;
const ACTIVITY_COLLECTIONS: [&str; 4] = [
    "activities",
    "activity_details",
    "activity_workouts",
    "activity_files",
];

struct Endpoint {
    collection: &'static str,
    path: String,
    query: Vec<(&'static str, String)>,
}

fn endpoint(
    collection: &'static str,
    path: impl Into<String>,
    query: Vec<(&'static str, String)>,
) -> Endpoint {
    Endpoint {
        collection,
        path: path.into(),
        query,
    }
}

fn daily_endpoints(day: &str) -> Vec<Endpoint> {
    let date = || vec![("date", day.to_string())];
    let range = || vec![("startDate", day.to_string()), ("endDate", day.to_string())];
    vec![
        endpoint(
            "daily_summaries",
            "/usersummary-service/v2/dailysummaries",
            range(),
        ),
        endpoint(
            "daily_summary_legacy",
            "/usersummary-service/usersummary/daily",
            vec![("calendarDate", day.into())],
        ),
        endpoint("sleep", "/sleep-service/sleep/dailySleep", date()),
        endpoint("hrv", format!("/hrv-service/hrv/{day}"), vec![]),
        endpoint(
            "body_battery",
            "/wellness-service/wellness/bodyBattery/reports/daily",
            range(),
        ),
        endpoint(
            "heart_rate",
            "/wellness-service/wellness/dailyHeartRate",
            date(),
        ),
        endpoint(
            "spo2",
            format!("/wellness-service/wellness/daily/spo2acclimation/{day}"),
            vec![],
        ),
        endpoint(
            "stress",
            format!("/usersummary-service/stats/stress/daily/{day}/{day}"),
            vec![],
        ),
        endpoint(
            "steps",
            format!("/usersummary-service/stats/steps/daily/{day}/{day}"),
            vec![],
        ),
        endpoint(
            "hydration",
            format!("/usersummary-service/stats/hydration/daily/{day}/{day}"),
            vec![],
        ),
        endpoint(
            "weight_goals",
            format!("/goal-service/goal/user/effective/weightgoal/{day}/{day}"),
            vec![],
        ),
        endpoint(
            "weight_measurements",
            format!("/weight-service/weight/all/{day}/{day}"),
            vec![],
        ),
        endpoint(
            "weight_range",
            format!("/weight-service/weight/range/{day}/{day}"),
            vec![("includeAll", "true".into())],
        ),
        endpoint(
            "food_logs",
            format!("/nutrition-service/food/logs/{day}"),
            vec![],
        ),
        endpoint(
            "menstrual_cycle",
            format!("/periodichealth-service/menstrualcycle/summary/{day}"),
            vec![],
        ),
        endpoint(
            "menstrual_day",
            format!("/periodichealth-service/menstrualcycle/dayview/{day}"),
            vec![
                (
                    "todayDate",
                    chrono::Local::now().format("%Y-%m-%d").to_string(),
                ),
                ("includeAnalysis", "true".into()),
            ],
        ),
        endpoint(
            "fitness_age",
            format!("/fitnessage-service/fitnessage/v2/{day}"),
            vec![("fullHistoryScan", "true".into())],
        ),
        endpoint(
            "wellness_activities",
            format!("/wellnessactivity-service/activity/summary/range/{day}/{day}"),
            vec![],
        ),
    ]
}

fn parse_day(day: &str) -> Result<NaiveDate, String> {
    if day.len() != 10
        || !day.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        return Err("Garmin dates must be YYYY-MM-DD".into());
    }
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map_err(|_| "Garmin dates must be YYYY-MM-DD")?;
    if date.format("%Y-%m-%d").to_string() != day {
        return Err("Garmin dates must be YYYY-MM-DD".into());
    }
    Ok(date)
}

fn date_prefix(value: &Value) -> Option<String> {
    // Official ConnectDate and ConnectTimestamp wrap the user's calendar day.
    // Their `date` field is UTC and must not override that local attribution.
    let text = value
        .as_str()
        .or_else(|| value.get("localDate")?.as_str())?;
    if text.len() > 10 && !matches!(text.as_bytes()[10], b'T' | b' ') {
        return None;
    }
    let day = text.get(..10)?;
    parse_day(day).ok().map(|_| day.to_string())
}

fn record_day(data: &Value, fallback: &str) -> String {
    // Calendar dates (including sleep's assigned day) take precedence over a
    // start timestamp; do not convert local wall-clock strings through UTC.
    for pointer in [
        "/calendarDate",
        "/hrvSummary/calendarDate",
        "/date",
        "/startTimeLocal",
        "/summaryDTO/startTimeLocal",
        "/startTimestampLocal",
        "/summaryDate",
    ] {
        if let Some(day) = data.pointer(pointer).and_then(date_prefix) {
            return day;
        }
    }
    fallback.into()
}

fn record_id(data: &Value) -> Option<String> {
    for key in [
        "activityId",
        "activityUUID",
        "activityUuid",
        "uuid",
        "id",
        "userDailySummaryId",
    ] {
        match &data[key] {
            Value::String(value) if !value.is_empty() => return Some(value.clone()),
            Value::Number(value) => return Some(value.to_string()),
            Value::Object(value) if matches!(key, "activityUUID" | "activityUuid" | "uuid") => {
                if let Some(uuid) = value
                    .get("baseUUID")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    return Some(uuid.into());
                }
            }
            _ => {}
        }
    }
    None
}

fn initial(collection: &str) -> CollectionResult {
    CollectionResult {
        collection: collection.into(),
        status: "complete".into(),
        records: 0,
        error: None,
    }
}

fn check_status(
    status: u16,
    collection: &str,
    results: &mut BTreeMap<String, CollectionResult>,
) -> Result<bool, String> {
    let result = results
        .entry(collection.into())
        .or_insert_with(|| initial(collection));
    match status {
        204 => Ok(false),
        200..=299 => Ok(true),
        403 | 404 => {
            result.status = "unavailable".into();
            result.error = Some(format!(
                "HTTP {status}; previous collection data must be retained"
            ));
            Ok(false)
        }
        _ => Err(format!(
            "Garmin {collection}: HTTP {status}; no window was completed"
        )),
    }
}

fn emit_record(
    collection: &str,
    fallback: &str,
    data: Value,
    force_id: Option<String>,
    results: &mut BTreeMap<String, CollectionResult>,
    emit: &mut dyn FnMut(ProviderRecord) -> Result<(), String>,
) -> Result<(), String> {
    let day = if fallback == "_undated" {
        fallback.into()
    } else if collection == "hrv" {
        // HrvChartDTO may omit its summary. The overnight start is not the
        // assigned sleep day; in that case the daily request remains authoritative.
        data.pointer("/hrvSummary/calendarDate")
            .and_then(date_prefix)
            .unwrap_or_else(|| fallback.into())
    } else {
        record_day(&data, fallback)
    };
    let id = force_id.or_else(|| record_id(&data));
    emit(ProviderRecord {
        source: SOURCE.into(),
        collection: collection.into(),
        day,
        id,
        data,
    })?;
    results
        .entry(collection.into())
        .or_insert_with(|| initial(collection))
        .records += 1;
    Ok(())
}

fn fetch_endpoint(
    http: &mut dyn Transport,
    endpoint: Endpoint,
    day: &str,
    results: &mut BTreeMap<String, CollectionResult>,
    emit: &mut dyn FnMut(ProviderRecord) -> Result<(), String>,
) -> Result<(), String> {
    let response = http.get_json(&endpoint.path, &endpoint.query)?;
    if !check_status(response.status, endpoint.collection, results)? {
        return Ok(());
    }
    // Splitting a top-level array retains every element, including unknown
    // fields and nulls. Object wrappers stay whole, including range metadata.
    match response.body {
        Value::Array(items) => {
            for item in items {
                emit_record(endpoint.collection, day, item, None, results, emit)?;
            }
        }
        body => emit_record(endpoint.collection, day, body, None, results, emit)?,
    }
    Ok(())
}

fn activity_id(data: &Value) -> Result<String, String> {
    let id = match &data["activityId"] {
        Value::Number(value) => value.as_u64().filter(|v| *v > 0).map(|v| v.to_string()),
        Value::String(value) if !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()) => {
            value
                .parse::<u64>()
                .ok()
                .filter(|v| *v > 0)
                .map(|v| v.to_string())
        }
        _ => None,
    };
    id.ok_or_else(|| "Garmin activity list contains an invalid or missing activityId".into())
}

fn fetch_activities(
    http: &mut dyn Transport,
    day: &str,
    results: &mut BTreeMap<String, CollectionResult>,
    emit: &mut dyn FnMut(ProviderRecord) -> Result<(), String>,
    progress: &mut dyn FnMut(&str),
) -> Result<(), String> {
    for collection in ACTIVITY_COLLECTIONS {
        results
            .entry(collection.into())
            .or_insert_with(|| initial(collection));
    }
    let mut seen = BTreeMap::new();
    let mut offset = 0usize;
    for page in 0..MAX_ACTIVITY_PAGES {
        progress(&format!("Garmin activities {day}, page {}", page + 1));
        let response = http.get_json(
            "/activitylist-service/activities/search/activities",
            &[
                ("start", offset.to_string()),
                ("limit", PAGE_SIZE.to_string()),
                ("startDate", day.into()),
                ("endDate", day.into()),
                ("excludeChildren", "false".into()),
                ("sortBy", "startLocal".into()),
                ("sortOrder", "asc".into()),
            ],
        )?;
        if matches!(response.status, 403 | 404) {
            for collection in ACTIVITY_COLLECTIONS {
                check_status(response.status, collection, results)?;
            }
            return Ok(());
        }
        if !check_status(response.status, "activities", results)? {
            return Ok(());
        }
        let items = response
            .body
            .as_array()
            .ok_or("Garmin activities response must be an array")?;
        if items.is_empty() {
            return Ok(());
        }
        let mut novel = 0;
        for item in items {
            let id = activity_id(item)?;
            let fingerprint: [u8; 32] =
                Sha256::digest(serde_json::to_vec(item).map_err(|e| e.to_string())?).into();
            if let Some(previous) = seen.insert(id.clone(), fingerprint) {
                if previous != fingerprint {
                    return Err(
                        "Conflicting Garmin activity ID across pagination; window is incomplete"
                            .into(),
                    );
                }
                continue;
            }
            novel += 1;
            let activity_day = record_day(item, day);
            emit_record(
                "activities",
                &activity_day,
                item.clone(),
                Some(id.clone()),
                results,
                emit,
            )?;
            for (collection, suffix) in
                [("activity_details", ""), ("activity_workouts", "/workouts")]
            {
                let response =
                    http.get_json(&format!("/activity-service/activity/{id}{suffix}"), &[])?;
                if check_status(response.status, collection, results)? {
                    if collection == "activity_details"
                        && response.body.get("activityId").is_some()
                        && activity_id(&response.body)? != id
                    {
                        return Err(
                            "Garmin activity details returned a different activityId".into()
                        );
                    }
                    // Workouts stay as a complete array under the parent activity
                    // ID, so their order and the explicit empty result survive.
                    emit_record(
                        collection,
                        &activity_day,
                        response.body,
                        Some(id.clone()),
                        results,
                        emit,
                    )?;
                }
            }
            let (status, bytes) =
                http.get_bytes(&format!("/download-service/files/activity/{id}"), &[])?;
            if check_status(status, "activity_files", results)? {
                if bytes.len() < 4
                    || !matches!(&bytes[..4], b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x07\x08")
                {
                    return Err("Garmin activity file response was not a ZIP archive".into());
                }
                emit_record(
                    "activity_files",
                    &activity_day,
                    json!({
                        "content_base64": STANDARD.encode(bytes), "mime": "application/zip", "filename": format!("activity-{id}.zip")
                    }),
                    Some(id),
                    results,
                    emit,
                )?;
            }
        }
        if novel == 0 {
            return Err(
                "Garmin activity pagination repeated an entire page; window is incomplete".into(),
            );
        }
        // Continue until an empty page, rather than trusting a server-specific
        // page cap or treating a partial page as proof there are no more items.
        offset = offset
            .checked_add(items.len())
            .ok_or("Garmin activity pagination overflow")?;
    }
    Err("Garmin activity pagination exceeded its safety limit; window is incomplete".into())
}

pub fn collect(
    http: &mut dyn Transport,
    since: &str,
    until: &str,
    emit: &mut dyn FnMut(ProviderRecord) -> Result<(), String>,
    progress: &mut dyn FnMut(&str),
) -> Result<FetchReport, String> {
    let mut day = parse_day(since)?;
    let end = parse_day(until)?;
    if day > end {
        return Err("Garmin since must not be after until".into());
    }
    let mut results = BTreeMap::new();
    for endpoint in [
        endpoint(
            "profile",
            "/userprofile-service/userprofile/settings",
            vec![],
        ),
        endpoint(
            "heart_rate_zones",
            "/biometric-service/heartRateZones/v2",
            vec![],
        ),
    ] {
        progress(&format!("Garmin {}", endpoint.collection));
        fetch_endpoint(http, endpoint, "_undated", &mut results, emit)?;
    }
    loop {
        let date = day.format("%Y-%m-%d").to_string();
        for endpoint in daily_endpoints(&date) {
            progress(&format!("Garmin {} {date}", endpoint.collection));
            fetch_endpoint(http, endpoint, &date, &mut results, emit)?;
        }
        fetch_activities(http, &date, &mut results, emit, progress)?;
        if day == end {
            break;
        }
        day = day
            .checked_add_days(Days::new(1))
            .ok_or("Garmin date overflow")?;
    }
    Ok(FetchReport {
        source: SOURCE.into(),
        since: since.into(),
        until: until.into(),
        collections: results.into_values().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::HttpResponse;
    use std::collections::VecDeque;

    #[derive(Default)]
    struct Fake {
        calls: Vec<(String, Vec<(String, String)>)>,
        responses: BTreeMap<String, VecDeque<Result<HttpResponse, String>>>,
        files: BTreeMap<String, (u16, Vec<u8>)>,
    }
    impl Fake {
        fn response(&mut self, path: &str, status: u16, body: Value) {
            self.responses
                .entry(path.into())
                .or_default()
                .push_back(Ok(HttpResponse { status, body }));
        }
    }
    impl Transport for Fake {
        fn get_json(
            &mut self,
            path: &str,
            query: &[(&str, String)],
        ) -> Result<HttpResponse, String> {
            self.calls.push((
                path.into(),
                query
                    .iter()
                    .map(|(k, v)| ((*k).into(), v.clone()))
                    .collect(),
            ));
            self.responses
                .get_mut(path)
                .and_then(VecDeque::pop_front)
                .unwrap_or({
                    Ok(HttpResponse {
                        status: 204,
                        body: Value::Null,
                    })
                })
        }
        fn get_bytes(
            &mut self,
            path: &str,
            _: &[(&str, String)],
        ) -> Result<(u16, Vec<u8>), String> {
            self.calls.push((path.into(), vec![]));
            Ok(self.files.remove(path).unwrap_or((204, vec![])))
        }
    }
    fn run(fake: &mut Fake) -> Result<(FetchReport, Vec<ProviderRecord>), String> {
        let mut records = vec![];
        let report = collect(
            fake,
            "2026-10-24",
            "2026-10-24",
            &mut |r| {
                records.push(r);
                Ok(())
            },
            &mut |_| {},
        )?;
        Ok((report, records))
    }

    #[test]
    fn uses_official_paths_and_preserves_schema_documents() {
        let mut fake = Fake::default();
        // Synthetic fields follow the official schema; no real account data.
        let sleep = json!({"id": 11, "calendarDate":"2026-10-24", "sleepScores":{"overall":{"value":83}}, "future":null});
        let summary = json!({"data":[{"calendarDate":"2026-10-24", "movement":{"steps":1234}}], "future": {"x":true}});
        fake.response("/sleep-service/sleep/dailySleep", 200, sleep.clone());
        fake.response(
            "/usersummary-service/v2/dailysummaries",
            200,
            summary.clone(),
        );
        fake.response("/hrv-service/hrv/2026-10-24", 200, json!({"hrvSummary":{"calendarDate":"2026-10-23"}, "hrvReadings":[null,{"hrvValue":42}]}));
        fake.response(
            "/userprofile-service/userprofile/settings",
            200,
            json!({"displayName":"synthetic", "timeZone":"Asia/Tokyo"}),
        );
        let (report, records) = run(&mut fake).unwrap();
        assert_eq!(report.collections.len(), 24);
        assert_eq!(
            records
                .iter()
                .find(|r| r.collection == "sleep")
                .unwrap()
                .data,
            sleep
        );
        assert_eq!(
            records
                .iter()
                .find(|r| r.collection == "daily_summaries")
                .unwrap()
                .data,
            summary
        );
        assert_eq!(
            records.iter().find(|r| r.collection == "hrv").unwrap().day,
            "2026-10-23"
        );
        assert_eq!(
            records
                .iter()
                .find(|r| r.collection == "profile")
                .unwrap()
                .day,
            "_undated"
        );
        let sleep_call = fake
            .calls
            .iter()
            .find(|(p, _)| p == "/sleep-service/sleep/dailySleep")
            .unwrap();
        assert_eq!(sleep_call.1, vec![("date".into(), "2026-10-24".into())]);
        assert!(fake.calls.iter().any(|(p, q)| p
            == "/weight-service/weight/range/2026-10-24/2026-10-24"
            && q.contains(&("includeAll".into(), "true".into()))));
    }

    #[test]
    fn paginates_until_empty_and_fetches_details_workouts_and_files() {
        let mut fake = Fake::default();
        let path = "/activitylist-service/activities/search/activities";
        fake.response(
            path,
            200,
            json!([{"activityId":1,"startTimeLocal":"2026-10-24 01:00:00"}]),
        );
        fake.response(
            path,
            200,
            json!([{"activityId":2,"startTimeLocal":"2026-10-24 02:00:00"}]),
        );
        fake.response(path, 200, json!([]));
        fake.response(
            "/activity-service/activity/1",
            200,
            json!({"activityId":1,"summaryDTO":{"duration":12},"splitSummaries":[{"future":7}]}),
        );
        fake.response("/activity-service/activity/1/workouts", 200, json!([]));
        fake.files.insert(
            "/download-service/files/activity/1".into(),
            (200, b"PK\x03\x04synthetic".to_vec()),
        );
        let (_, records) = run(&mut fake).unwrap();
        let pages: Vec<_> = fake.calls.iter().filter(|(p, _)| p == path).collect();
        assert_eq!(pages.len(), 3);
        for (i, (_, q)) in pages.iter().enumerate() {
            assert!(q.contains(&("start".into(), i.to_string())));
            assert!(q.contains(&("excludeChildren".into(), "false".into())));
        }
        assert_eq!(
            records
                .iter()
                .filter(|r| r.collection == "activities")
                .count(),
            2
        );
        assert_eq!(
            records
                .iter()
                .find(|r| r.collection == "activity_workouts")
                .unwrap()
                .data,
            json!([])
        );
        let file = records
            .iter()
            .find(|r| r.collection == "activity_files")
            .unwrap();
        assert_eq!(file.id.as_deref(), Some("1"));
        assert_eq!(
            STANDARD
                .decode(file.data["content_base64"].as_str().unwrap())
                .unwrap(),
            b"PK\x03\x04synthetic"
        );
    }

    #[test]
    fn unavailable_retains_old_data_and_fatal_statuses_abort_window() {
        let mut fake = Fake::default();
        fake.response(
            "/sleep-service/sleep/dailySleep",
            403,
            json!({"secret":"not surfaced"}),
        );
        fake.response(
            "/activitylist-service/activities/search/activities",
            404,
            Value::Null,
        );
        let (report, records) = run(&mut fake).unwrap();
        assert!(records.is_empty());
        for name in [
            "sleep",
            "activities",
            "activity_details",
            "activity_workouts",
            "activity_files",
        ] {
            assert_eq!(
                report
                    .collections
                    .iter()
                    .find(|c| c.collection == name)
                    .unwrap()
                    .status,
                "unavailable"
            );
        }
        for status in [400, 401, 429, 500, 503] {
            let mut fake = Fake::default();
            fake.response(
                "/sleep-service/sleep/dailySleep",
                status,
                json!({"secret":"not surfaced"}),
            );
            let error = run(&mut fake).err().unwrap();
            assert!(error.contains(&status.to_string()));
            assert!(!error.contains("secret"));
        }
        let mut fake = Fake::default();
        fake.responses.insert(
            "/sleep-service/sleep/dailySleep".into(),
            VecDeque::from([Err("network unavailable".into())]),
        );
        assert_eq!(run(&mut fake).err().as_deref(), Some("network unavailable"));
    }

    #[test]
    fn repeated_page_bad_id_and_wrong_detail_never_complete() {
        for bad in ["repeat", "bad_id", "wrong_detail"] {
            let mut fake = Fake::default();
            let list = "/activitylist-service/activities/search/activities";
            fake.response(
                list,
                200,
                if bad == "bad_id" {
                    json!([{"activityId":"../secret"}])
                } else {
                    json!([{"activityId":1}])
                },
            );
            if bad == "repeat" {
                fake.response(list, 200, json!([{"activityId":1}]));
            }
            if bad == "wrong_detail" {
                fake.response("/activity-service/activity/1", 200, json!({"activityId":2}));
            }
            assert!(run(&mut fake).is_err());
        }
    }

    #[test]
    fn official_object_dates_and_uuids_preserve_local_identity() {
        // ConnectDate/ConnectTimestamp expose both UTC date and localDate.
        let document = json!({
            "calendarDate":{"date":"2026-10-23T16:00:00Z","localDate":"2026-10-24"},
            "activityUuid":{"baseUUID":"00000000-0000-0000-0000-000000000001"}
        });
        assert_eq!(record_day(&document, "2026-10-23"), "2026-10-24");
        assert_eq!(
            record_id(&document).as_deref(),
            Some("00000000-0000-0000-0000-000000000001")
        );
        assert_eq!(
            record_day(
                &json!({"startTimestampLocal":{"localDate":"2026-10-24"}}),
                "2026-10-23"
            ),
            "2026-10-24"
        );
        // Do not substitute the UTC day when the local date is absent.
        assert_eq!(
            record_day(
                &json!({"calendarDate":{"date":"2026-10-23T16:00:00Z"}}),
                "2026-10-24"
            ),
            "2026-10-24"
        );
    }

    #[test]
    fn hrv_without_summary_keeps_the_requested_sleep_day() {
        for start in [
            json!("2026-10-23T22:00:00"),
            json!({"date":"2026-10-23T14:00:00Z","localDate":"2026-10-23"}),
        ] {
            let mut fake = Fake::default();
            let document = json!({
                "startTimestampLocal":start,
                "endTimestampLocal":"2026-10-24T06:00:00",
                "hrvReadings":[{"hrvValue":42}]
            });
            fake.response("/hrv-service/hrv/2026-10-24", 200, document.clone());
            let (_, records) = run(&mut fake).unwrap();
            assert_eq!(records[0].day, "2026-10-24");
            assert_eq!(records[0].data, document);
        }
    }

    #[test]
    fn conflicting_activity_ids_across_pages_abort_the_window() {
        for changed in [
            json!({"activityId":1,"startTimeLocal":"2026-10-24 01:00:00","distance":20}),
            json!({"activityId":1,"startTimeLocal":"2026-10-23 01:00:00","distance":10}),
        ] {
            let mut fake = Fake::default();
            let path = "/activitylist-service/activities/search/activities";
            fake.response(
                path,
                200,
                json!([
                    {"activityId":1,"startTimeLocal":"2026-10-24 01:00:00","distance":10}
                ]),
            );
            fake.response(path, 200, json!([changed, {"activityId":2}]));
            fake.response(path, 200, json!([]));
            let error = run(&mut fake).expect_err("conflicting activity must fail");
            assert!(error.contains("Conflicting Garmin activity ID"));
        }
    }

    #[test]
    fn identical_overlapping_activities_are_imported_once() {
        let mut fake = Fake::default();
        let path = "/activitylist-service/activities/search/activities";
        fake.response(path, 200, json!([{"activityId":1,"distance":10}]));
        fake.response(
            path,
            200,
            json!([{"activityId":1,"distance":10},{"activityId":2}]),
        );
        fake.response(path, 200, json!([]));
        let (report, records) = run(&mut fake).unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|r| r.collection == "activities")
                .count(),
            2
        );
        assert_eq!(
            report
                .collections
                .iter()
                .find(|c| c.collection == "activities")
                .unwrap()
                .records,
            2
        );
        let pages: Vec<_> = fake.calls.iter().filter(|(p, _)| p == path).collect();
        assert!(pages[2].1.contains(&("start".into(), "3".into())));
    }

    #[test]
    fn preserves_null_and_inclusive_days_and_propagates_sink_failure() {
        let mut fake = Fake::default();
        fake.response("/sleep-service/sleep/dailySleep", 200, Value::Null);
        let (_, records) = run(&mut fake).unwrap();
        assert!(records[0].data.is_null());
        let mut fake = Fake::default();
        collect(
            &mut fake,
            "2026-10-23",
            "2026-10-24",
            &mut |_| Ok(()),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(
            fake.calls
                .iter()
                .filter(|(p, _)| p == "/sleep-service/sleep/dailySleep")
                .count(),
            2
        );
        fake.response("/userprofile-service/userprofile/settings", 200, json!({}));
        assert_eq!(
            collect(
                &mut fake,
                "2026-10-24",
                "2026-10-24",
                &mut |_| Err("disk full".into()),
                &mut |_| {}
            )
            .err()
            .as_deref(),
            Some("disk full")
        );
        assert!(collect(
            &mut fake,
            "2026-02-30",
            "2026-10-24",
            &mut |_| Ok(()),
            &mut |_| {}
        )
        .is_err());
    }
}
