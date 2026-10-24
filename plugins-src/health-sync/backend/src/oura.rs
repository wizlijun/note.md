//! Oura API V2 collection reader, checked against the official OpenAPI 1.42.
//! Authentication and persistence belong to the caller. Only complete collections
//! may be activated: a later unavailable page invalidates earlier emitted pages.
use crate::providers::{CollectionResult, FetchReport, ProviderRecord, Transport};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime};
use serde_json::Value;
use std::collections::HashSet;

/// All collection routes in https://cloud.ouraring.com/v2/static/json/openapi-1.42.json.
/// Keep the unusual vO2_max capitalization: it is part of the public route.
pub const COLLECTIONS: &[&str] = &[
    "daily_activity",
    "daily_cardiovascular_age",
    "daily_readiness",
    "daily_resilience",
    "daily_sleep",
    "daily_spo2",
    "daily_stress",
    "enhanced_tag",
    "heartrate",
    "personal_info",
    "rest_mode_period",
    "ring_battery_level",
    "ring_configuration",
    "session",
    "sleep",
    "sleep_time",
    "tag",
    "vO2_max",
    "workout",
];
const MAX_PAGES: usize = 10_000;

pub fn collect(
    http: &mut dyn Transport,
    since: &str,
    until: &str,
    emit: &mut dyn FnMut(ProviderRecord) -> Result<(), String>,
    progress: &mut dyn FnMut(&str),
) -> Result<FetchReport, String> {
    let start = date(since)?;
    let end = date(until)?;
    if start > end {
        return Err("Oura since must not be after until".into());
    }
    let mut report = FetchReport {
        source: "oura".into(),
        since: since.into(),
        until: until.into(),
        collections: vec![],
    };
    for &collection in COLLECTIONS {
        let path = format!("/v2/usercollection/{collection}");
        let base_query = query(collection, start, end)?;
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        let mut count = 0;
        let mut result = None;
        for page in 0..MAX_PAGES {
            progress(&format!("Oura {collection}: page {}", page + 1));
            let mut parameters = base_query.clone();
            if let Some(token) = &cursor {
                parameters.push(("next_token", token.clone()));
            }
            let response = http
                .get_json(&path, &parameters)
                .map_err(|e| format!("Oura {collection} request failed: {e}"))?;
            match response.status {
                401 | 429 | 500..=599 => {
                    return Err(format!(
                        "Oura {collection}: HTTP {}; window was not completed",
                        response.status
                    ))
                }
                403 | 404 => {
                    result = Some(CollectionResult {
                        collection: collection.into(),
                        status: "unavailable".into(),
                        records: 0,
                        error: Some(format!(
                            "HTTP {}: collection unavailable; retain previous data",
                            response.status
                        )),
                    });
                    break;
                }
                204 => {
                    result = Some(complete(collection, count));
                    break;
                }
                200 => {}
                status => {
                    result = Some(CollectionResult {
                        collection: collection.into(),
                        status: "failed".into(),
                        records: 0,
                        error: Some(format!("HTTP {status}: collection was not completed")),
                    });
                    break;
                }
            }
            if collection == "personal_info" {
                emit(normalize(collection, response.body)?)?;
                result = Some(complete(collection, 1));
                break;
            }
            let rows = response
                .body
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("Oura {collection}: missing data array"))?;
            // Validate the envelope before emitting. Missing pagination metadata
            // must not be mistaken for a complete response.
            let next = match response.body.get("next_token") {
                Some(Value::Null) => None,
                Some(Value::String(token)) if !token.is_empty() => Some(token.clone()),
                _ => return Err(format!("Oura {collection}: invalid or missing next_token")),
            };
            if let Some(token) = &next {
                if !seen.insert(token.clone()) {
                    return Err(format!("Oura {collection}: repeated pagination token"));
                }
            }
            for row in rows {
                let record = normalize(collection, row.clone())?;
                // Datetime queries deliberately overfetch UTC boundaries to
                // cover every original local offset. Only this completed local
                // day window may replace stored facts; still consume every page.
                if record.day == "_undated"
                    || (record.day.as_str() >= since && record.day.as_str() <= until)
                {
                    emit(record)?;
                    count += 1;
                }
            }
            cursor = next;
            if cursor.is_none() {
                result = Some(complete(collection, count));
                break;
            }
        }
        report.collections.push(
            result.ok_or_else(|| {
                format!("Oura {collection}: pagination exceeds {MAX_PAGES} pages")
            })?,
        );
    }
    Ok(report)
}

fn complete(collection: &str, records: u64) -> CollectionResult {
    CollectionResult {
        collection: collection.into(),
        status: "complete".into(),
        records,
        error: None,
    }
}

fn date(value: &str) -> Result<NaiveDate, String> {
    if value.len() != 10 || value.as_bytes()[4] != b'-' || value.as_bytes()[7] != b'-' {
        return Err("Oura date must use YYYY-MM-DD".into());
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "Oura date is invalid".into())
}

fn query(
    collection: &str,
    since: NaiveDate,
    until: NaiveDate,
) -> Result<Vec<(&'static str, String)>, String> {
    if matches!(collection, "personal_info" | "ring_configuration") {
        return Ok(vec![]);
    }
    let after = until.succ_opt().ok_or("Oura end date is out of range")?;
    if matches!(collection, "heartrate" | "ring_battery_level") {
        // Cover local days across UTC offsets from -12 to +14. Returned raw
        // timestamps retain their own offset; never use the Mac's current zone.
        let start = since
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .checked_sub_signed(Duration::hours(14))
            .ok_or("Oura start date is out of range")?;
        let end = after
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .checked_add_signed(Duration::hours(12))
            .ok_or("Oura end date is out of range")?;
        Ok(vec![
            (
                "start_datetime",
                start.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            ),
            ("end_datetime", end.format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        ])
    } else {
        Ok(vec![
            ("start_date", since.to_string()),
            ("end_date", after.to_string()),
        ])
    }
}

fn normalize(collection: &str, data: Value) -> Result<ProviderRecord, String> {
    if !data.is_object() {
        return Err(format!("Oura {collection}: record is not an object"));
    }
    let id = match data.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if !id.is_empty() => Some(id.clone()),
        _ => return Err(format!("Oura {collection}: invalid record id")),
    };
    let day = if matches!(collection, "personal_info" | "ring_configuration") {
        "_undated".into()
    } else {
        record_day(collection, &data)?
    };
    Ok(ProviderRecord {
        source: "oura".into(),
        collection: collection.into(),
        day,
        id,
        data,
    })
}

fn record_day(collection: &str, data: &Value) -> Result<String, String> {
    // start_day is Oura's authoritative date for enhanced tags / rest mode.
    for key in ["day", "start_day"] {
        match data.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(value)) => return Ok(date(value)?.to_string()),
            _ => return Err(format!("Oura {collection}: invalid {key}")),
        }
    }
    for key in ["timestamp", "start_datetime", "bedtime_start", "start_time"] {
        match data.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(value)) => {
                let day = DateTime::parse_from_rfc3339(value)
                    .map(|d| d.date_naive())
                    .or_else(|_| {
                        NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
                            .map(|d| d.date())
                    })
                    .map_err(|_| format!("Oura {collection}: invalid {key}"))?;
                return Ok(day.to_string());
            }
            _ => return Err(format!("Oura {collection}: invalid {key}")),
        }
    }
    Err(format!(
        "Oura {collection}: dated record has no date or timestamp"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::HttpResponse;
    use serde_json::json;
    use std::collections::{HashMap, VecDeque};

    #[derive(Default)]
    struct Fake {
        replies: HashMap<String, VecDeque<Result<HttpResponse, String>>>,
        requests: Vec<(String, Vec<(String, String)>)>,
    }
    impl Fake {
        fn reply(&mut self, collection: &str, status: u16, body: Value) {
            self.replies
                .entry(collection.into())
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
            self.requests.push((
                path.into(),
                query
                    .iter()
                    .map(|(k, v)| ((*k).into(), v.clone()))
                    .collect(),
            ));
            self.replies
                .get_mut(path.rsplit('/').next().unwrap())
                .and_then(VecDeque::pop_front)
                .unwrap_or({
                    Ok(HttpResponse {
                        status: 204,
                        body: Value::Null,
                    })
                })
        }
        fn get_bytes(&mut self, _: &str, _: &[(&str, String)]) -> Result<(u16, Vec<u8>), String> {
            panic!("Oura uses JSON only")
        }
    }
    fn run(http: &mut Fake) -> Result<(FetchReport, Vec<ProviderRecord>), String> {
        let mut rows = vec![];
        let report = collect(
            http,
            "2026-10-01",
            "2026-10-02",
            &mut |r| {
                rows.push(r);
                Ok(())
            },
            &mut |_| {},
        )?;
        Ok((report, rows))
    }

    #[test]
    fn calls_every_official_collection_with_correct_ranges() {
        let mut http = Fake::default();
        let (report, _) = run(&mut http).unwrap();
        assert_eq!(report.collections.len(), 19);
        assert!(report.collections.iter().all(|c| c.status == "complete"));
        let paths: Vec<_> = http
            .requests
            .iter()
            .map(|(path, _)| path.rsplit('/').next().unwrap())
            .collect();
        assert_eq!(paths, COLLECTIONS);
        for (path, params) in &http.requests {
            if path.ends_with("heartrate") || path.ends_with("ring_battery_level") {
                assert_eq!(
                    params,
                    &vec![
                        ("start_datetime".into(), "2026-09-30T10:00:00Z".into()),
                        ("end_datetime".into(), "2026-10-03T12:00:00Z".into())
                    ]
                );
            } else if path.ends_with("personal_info") || path.ends_with("ring_configuration") {
                assert!(params.is_empty());
            } else {
                assert_eq!(
                    params,
                    &vec![
                        ("start_date".into(), "2026-10-01".into()),
                        ("end_date".into(), "2026-10-03".into())
                    ]
                );
            }
        }
    }

    #[test]
    fn follows_all_pages_and_preserves_raw_fields_and_null_samples() {
        let mut http = Fake::default();
        let row = json!({"id":"one","day":"2026-10-01","heart_rate":{"interval":60,"items":[54,null,73],"timestamp":"2026-10-01T21:30:00+14:00"},"future":{"unknown":true}});
        http.reply(
            "sleep",
            200,
            json!({"data":[row.clone()],"next_token":"opaque+token"}),
        );
        http.reply(
            "sleep",
            200,
            json!({"data":[{"id":"two","day":"2026-10-02"}],"next_token":null}),
        );
        let (report, rows) = run(&mut http).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].data, row);
        assert_eq!(rows[0].source, "oura");
        assert_eq!(
            report
                .collections
                .iter()
                .find(|c| c.collection == "sleep")
                .unwrap()
                .records,
            2
        );
        assert!(http
            .requests
            .iter()
            .any(|(_, q)| q.contains(&("next_token".into(), "opaque+token".into()))));
    }

    #[test]
    fn filters_boundary_overfetch_after_normalizing_each_page() {
        let mut http = Fake::default();
        http.reply(
            "heartrate",
            200,
            json!({"data":[
            {"timestamp":"2026-09-30T23:30:00-12:00","bpm":60}
        ],"next_token":"next"}),
        );
        let first = json!({"timestamp":"2026-10-01T00:00:00+14:00","bpm":61,"unknown":null});
        let last = json!({"timestamp":"2026-10-02T23:59:59-12:00","bpm":62});
        http.reply(
            "heartrate",
            200,
            json!({"data":[
            first.clone(), last.clone(),
            {"timestamp":"2026-10-03T00:00:00+14:00","bpm":63}
        ],"next_token":null}),
        );
        http.reply(
            "daily_sleep",
            200,
            json!({"data":[
            {"id":"next-day","day":"2026-10-03"}
        ],"next_token":null}),
        );
        http.reply(
            "ring_configuration",
            200,
            json!({"data":[
            {"id":"ring","set_up_at":"2025-01-01T00:00:00Z"}
        ],"next_token":null}),
        );
        let (report, rows) = run(&mut http).unwrap();
        let heartrate: Vec<_> = rows
            .iter()
            .filter(|r| r.collection == "heartrate")
            .collect();
        assert_eq!(heartrate.len(), 2);
        assert_eq!(heartrate[0].data, first);
        assert_eq!(heartrate[1].data, last);
        assert!(rows.iter().all(|r| r.day == "_undated"
            || (r.day.as_str() >= "2026-10-01" && r.day.as_str() <= "2026-10-02")));
        assert!(rows
            .iter()
            .any(|r| r.collection == "ring_configuration" && r.day == "_undated"));
        assert_eq!(
            report
                .collections
                .iter()
                .find(|r| r.collection == "heartrate")
                .unwrap()
                .records,
            2
        );
        assert_eq!(
            report
                .collections
                .iter()
                .find(|r| r.collection == "daily_sleep")
                .unwrap()
                .records,
            0
        );
        assert_eq!(
            http.requests
                .iter()
                .filter(|(path, _)| path.ends_with("heartrate"))
                .count(),
            2
        );
        // Exercise the real strict window/count validation, which previously
        // rejected this legitimate padded response and replayed it forever.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let vault = root.join("vault");
        std::fs::create_dir(&vault).unwrap();
        let staged = root.join("records.jsonl");
        let lines = rows
            .iter()
            .map(|r| format!("{}\n", serde_json::to_string(r).unwrap()))
            .collect::<String>();
        std::fs::write(&staged, lines).unwrap();
        let store = crate::store::Store::new(&vault, &root.join("state")).unwrap();
        assert!(
            store
                .apply_provider(&staged, &report, false, &mut |_| {})
                .unwrap()
                .complete
        );
        let saved = store
            .query_filtered(
                crate::store::QueryFilter {
                    since: Some("2026-10-01"),
                    until: Some("2026-10-02"),
                    metric: Some("oura.heartrate"),
                    source: Some("oura"),
                    ..Default::default()
                },
                10,
                0,
            )
            .unwrap();
        assert_eq!(saved["records"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn normalizes_authoritative_dates_and_preserves_offsets() {
        assert_eq!(
            normalize(
                "sleep",
                json!({"day":"2026-10-02","bedtime_start":"2026-10-01T23:00:00-12:00"})
            )
            .unwrap()
            .day,
            "2026-10-02"
        );
        assert_eq!(
            normalize(
                "heartrate",
                json!({"timestamp":"2026-10-01T23:30:00-12:00","bpm":65})
            )
            .unwrap()
            .day,
            "2026-10-01"
        );
        assert_eq!(
            normalize(
                "enhanced_tag",
                json!({"start_day":"2026-10-02","start_time":"2026-10-02T05:00:00"})
            )
            .unwrap()
            .day,
            "2026-10-02"
        );
        assert_eq!(
            normalize("personal_info", json!({"id":"person","age":30}))
                .unwrap()
                .day,
            "_undated"
        );
        assert_eq!(
            normalize(
                "ring_configuration",
                json!({"id":"ring","set_up_at":"2026-01-01T00:00:00Z"})
            )
            .unwrap()
            .day,
            "_undated"
        );
        assert!(normalize("sleep", json!({"day":"2026-02-30"})).is_err());
        assert!(normalize(
            "sleep",
            json!({"day":"bad","timestamp":"2026-10-01T00:00:00Z"})
        )
        .is_err());
        assert!(normalize("sleep", json!({"id":"missing-date"})).is_err());
    }

    #[test]
    fn unavailable_or_failed_collections_are_not_complete() {
        let mut http = Fake::default();
        http.reply(
            "sleep",
            200,
            json!({"data":[{"id":"partial","day":"2026-10-01"}],"next_token":"next"}),
        );
        http.reply("sleep", 403, Value::Null);
        http.reply("workout", 404, Value::Null);
        http.reply("tag", 422, Value::Null);
        let (report, rows) = run(&mut http).unwrap();
        assert_eq!(rows.len(), 1); // Caller discards emitted rows for non-complete collections.
        let status = |name| {
            &report
                .collections
                .iter()
                .find(|c| c.collection == name)
                .unwrap()
                .status
        };
        assert_eq!(status("sleep"), "unavailable");
        assert_eq!(status("workout"), "unavailable");
        assert_eq!(status("tag"), "failed");
        assert_eq!(
            report
                .collections
                .iter()
                .find(|c| c.collection == "sleep")
                .unwrap()
                .records,
            0
        );
    }

    #[test]
    fn transient_auth_and_network_errors_abort_the_window() {
        for status in [401, 429, 500, 502, 503] {
            let mut http = Fake::default();
            http.reply("sleep", status, Value::Null);
            assert!(run(&mut http).is_err());
        }
        let mut http = Fake::default();
        http.replies
            .entry("sleep".into())
            .or_default()
            .push_back(Err("connection interrupted".into()));
        assert!(run(&mut http).is_err());
    }

    #[test]
    fn malformed_envelopes_and_pagination_cycles_abort() {
        for body in [
            json!({"data":[]}),
            json!({"data":[],"next_token":42}),
            json!({"next_token":null}),
            json!({"data":[5],"next_token":null}),
        ] {
            let mut http = Fake::default();
            http.reply("sleep", 200, body);
            assert!(run(&mut http).is_err());
        }
        let mut http = Fake::default();
        for _ in 0..2 {
            http.reply("sleep", 200, json!({"data":[],"next_token":"cycle"}));
        }
        assert!(run(&mut http).unwrap_err().contains("repeated pagination"));
    }

    #[test]
    fn personal_info_is_an_object_not_a_collection_envelope() {
        let mut http = Fake::default();
        http.reply(
            "personal_info",
            200,
            json!({"id":"person","height":1.8,"new_field":[1,2]}),
        );
        let (_, rows) = run(&mut http).unwrap();
        assert_eq!(rows[0].id.as_deref(), Some("person"));
        assert_eq!(rows[0].data["new_field"], json!([1, 2]));
    }
}
