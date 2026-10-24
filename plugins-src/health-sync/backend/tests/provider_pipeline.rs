//! Synthetic official response shapes, through the real collectors and archive.
//! No credentials or live account data are needed by these regression tests.
use notemd_health_sync::{
    auth::GarminRegion,
    garmin, oura,
    providers::{HttpResponse, ProviderRecord, Transport},
    store::{hash, QueryFilter, Report, Store},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};

const DAY: &str = "2026-10-01";
const ACTIVITIES: &str = "/activitylist-service/activities/search/activities";
const SLEEP: &str = "/v2/usercollection/sleep";

#[derive(Default)]
struct Api {
    replies: BTreeMap<String, VecDeque<HttpResponse>>,
    files: BTreeMap<String, Vec<u8>>,
    requests: Vec<(String, Vec<(String, String)>)>,
}
impl Api {
    fn reply(&mut self, path: &str, status: u16, body: Value) {
        self.replies
            .entry(path.into())
            .or_default()
            .push_back(HttpResponse { status, body });
    }
}
impl Transport for Api {
    fn get_json(&mut self, path: &str, query: &[(&str, String)]) -> Result<HttpResponse, String> {
        self.requests.push((
            path.into(),
            query
                .iter()
                .map(|(k, v)| ((*k).into(), v.clone()))
                .collect(),
        ));
        match self.replies.get_mut(path) {
            // Exhausting a scripted route is a missing page, never empty success.
            Some(replies) => replies
                .pop_front()
                .ok_or_else(|| format!("missing page: {path}")),
            None => Ok(HttpResponse {
                status: 204,
                body: Value::Null,
            }),
        }
    }
    fn get_bytes(&mut self, path: &str, _: &[(&str, String)]) -> Result<(u16, Vec<u8>), String> {
        Ok(self
            .files
            .get(path)
            .map_or((204, vec![]), |b| (200, b.clone())))
    }
}

struct Archive {
    root: tempfile::TempDir,
    vault: PathBuf,
    library: PathBuf,
    store: Store,
}
impl Archive {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path().canonicalize().unwrap().join("vault");
        fs::create_dir(&vault).unwrap();
        let state = root.path().canonicalize().unwrap().join("state");
        let library = root.path().canonicalize().unwrap().join("library");
        fs::create_dir(&library).unwrap();
        notemd_health_sync::library::configure(&vault, &state, &library).unwrap();
        let store = Store::new(&vault, &state).unwrap();
        Self {
            root,
            vault,
            library,
            store,
        }
    }
    fn import(&self, source: &str, account: &str, api: &mut Api) -> Result<Report, String> {
        let path = self
            .root
            .path()
            .canonicalize()
            .unwrap()
            .join("staged.ndjson");
        let mut file = fs::File::create(&path).unwrap();
        let mut emit = |row: ProviderRecord| {
            serde_json::to_writer(&mut file, &row).map_err(|e| e.to_string())?;
            file.write_all(b"\n").map_err(|e| e.to_string())
        };
        let report = match source {
            "oura" => oura::collect(api, DAY, DAY, &mut emit, &mut |_| {})?,
            "garmin" => garmin::collect(api, DAY, DAY, &mut emit, &mut |_| {})?,
            _ => unreachable!(),
        };
        drop(file);
        self.store.apply_provider_for_account(
            &path,
            &report,
            false,
            account,
            GarminRegion::Global,
            &mut |_| {},
        )
    }
    fn records(&self, account: &str, metric: &str) -> Vec<Value> {
        self.store
            .query_filtered(
                QueryFilter {
                    account_id: Some(account),
                    metric: Some(metric),
                    ..Default::default()
                },
                100,
                0,
            )
            .unwrap()["records"]
            .as_array()
            .unwrap()
            .clone()
    }
}

fn tree(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, SystemTime)> {
    fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, (Vec<u8>, SystemTime)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, out);
            } else {
                out.insert(
                    path.strip_prefix(root).unwrap().into(),
                    (
                        fs::read(&path).unwrap(),
                        fs::metadata(&path).unwrap().modified().unwrap(),
                    ),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}

fn oura_api(score: u64) -> (Api, Value) {
    let mut api = Api::default();
    let sleep = json!({"id":"same-sleep-id","day":DAY,"score":score,
        "bedtime_start":"2026-09-30T23:45:00-12:00",
        "heart_rate":{"interval":300,"items":[54,null,65]},"future_field":{"value":null}});
    api.reply(
        SLEEP,
        200,
        json!({"data":[sleep.clone()],"next_token":"opaque+cursor"}),
    );
    api.reply(
        SLEEP,
        200,
        json!({"data":[{"id":"second","day":DAY,"score":80}],"next_token":null}),
    );
    api.reply(
        "/v2/usercollection/heartrate",
        200,
        json!({"data":[
            {"timestamp":"2026-09-30T23:59:59-12:00","bpm":50},
            {"timestamp":"2026-10-01T23:59:59-12:00","bpm":61,"source":"awake"},
            {"timestamp":"2026-10-02T00:00:00+14:00","bpm":62}
        ]}),
    );
    api.reply(
        "/v2/usercollection/personal_info",
        200,
        json!({"id":"person","age":30,"weight":null}),
    );
    (api, sleep)
}

fn wellness_activity() -> Value {
    json!({"calendarDate":{"localDate":DAY,"date":"2026-09-30T16:00:00Z"},
        "activityUuid":{"baseUUID":"00000000-0000-0000-0000-000000000001"},
        "startTimestampLocal":{"localDate":"2026-09-30","date":"2026-09-30T15:45:00Z"}, "future_field":[null,1]})
}

fn garmin_api(value: u64) -> (Api, Value, Vec<u8>) {
    let mut api = Api::default();
    let summary = json!({"userDailySummaryId":7,"calendarDate":DAY,"totalSteps":value,
        "future_field":{"samples":[1,null,3]}});
    api.reply(
        "/usersummary-service/usersummary/daily",
        200,
        summary.clone(),
    );
    api.reply(
        &format!("/hrv-service/hrv/{DAY}"),
        200,
        json!({"startTimestampLocal":"2026-09-30T22:00:00",
            "endTimestampLocal":"2026-10-01T06:00:00", "hrvReadings":[null,{"hrvValue":42}]}),
    );
    api.reply(
        &format!("/wellnessactivity-service/activity/summary/range/{DAY}/{DAY}"),
        200,
        json!([wellness_activity()]),
    );
    api.reply(
        ACTIVITIES,
        200,
        json!([{"activityId":101,"startTimeLocal":"2026-10-01 23:45:00","distance":null}]),
    );
    api.reply(
        ACTIVITIES,
        200,
        json!([{"activityId":102,"startTimeLocal":"2026-10-01 01:00:00"}]),
    );
    api.reply(ACTIVITIES, 200, json!([]));
    api.reply(
        "/activity-service/activity/101",
        200,
        json!({"activityId":101,
        "summaryDTO":{"startTimeLocal":"2026-10-01 23:45:00"},"samples":[null,12]}),
    );
    api.reply("/activity-service/activity/101/workouts", 200, json!([]));
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("activity.fit", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"synthetic FIT payload\0\xff").unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    api.files
        .insert("/download-service/files/activity/101".into(), bytes.clone());
    (api, summary, bytes)
}

#[test]
fn oura_pages_preserve_documents_local_days_and_accounts_without_rewrites() {
    let archive = Archive::new();
    assert!(tree(&archive.vault).is_empty());
    let a = hash(b"oura:a");
    let b = hash(b"oura:b");
    let (mut api, raw) = oura_api(91);
    assert!(archive.import("oura", &a, &mut api).unwrap().complete);
    assert!(api.requests.iter().any(
        |(path, q)| path == SLEEP && q.contains(&("next_token".into(), "opaque+cursor".into()))
    ));
    let saved = archive.records(&a, "oura.sleep");
    assert_eq!(saved.len(), 2);
    let sleep = saved
        .iter()
        .find(|r| r["payload"]["id"] == "same-sleep-id")
        .unwrap();
    assert_eq!(sleep["payload"], raw);
    assert_eq!(sleep["day"], DAY); // Sleep day wins over bedtime on the previous day.
    let pulse = archive.records(&a, "oura.heartrate");
    assert_eq!(pulse.len(), 1);
    assert_eq!(pulse[0]["day"], DAY); // Timestamp offset is retained, not converted to UTC.
    assert_eq!(pulse[0]["payload"]["bpm"], 61);
    assert_eq!(
        archive.records(&a, "oura.personal_info")[0]["day"],
        "_undated"
    );
    let before = tree(&archive.library);
    assert!(
        !archive
            .import("oura", &a, &mut oura_api(91).0)
            .unwrap()
            .data_changed
    );
    assert_eq!(tree(&archive.library), before);
    assert!(tree(&archive.vault).is_empty());
    archive.import("oura", &b, &mut oura_api(70).0).unwrap();
    let b_before = archive.records(&b, "oura.sleep");
    archive.import("oura", &a, &mut oura_api(99).0).unwrap();
    assert_eq!(archive.records(&b, "oura.sleep"), b_before);
    assert!(archive
        .records(&a, "oura.sleep")
        .iter()
        .any(|r| r["payload"]["score"] == 99));
}

#[test]
fn garmin_pages_and_zip_bytes_reach_the_archive_and_stay_account_scoped() {
    let archive = Archive::new();
    assert!(tree(&archive.vault).is_empty());
    let a = hash(b"garmin:a");
    let b = hash(b"garmin:b");
    let (mut api, raw, bytes) = garmin_api(1234);
    assert!(archive.import("garmin", &a, &mut api).unwrap().complete);
    let offsets: Vec<_> = api
        .requests
        .iter()
        .filter(|(p, _)| p == ACTIVITIES)
        .map(|(_, q)| q.iter().find(|(k, _)| k == "start").unwrap().1.as_str())
        .collect();
    assert_eq!(offsets, ["0", "1", "2"]);
    assert_eq!(
        archive.records(&a, "garmin.daily_summary_legacy")[0]["payload"],
        raw
    );
    let collected: Vec<ProviderRecord> =
        fs::read_to_string(archive.root.path().join("staged.ndjson"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    let wellness = collected
        .iter()
        .find(|r| r.collection == "wellness_activities")
        .unwrap();
    assert_eq!(wellness.day, DAY);
    assert_eq!(
        wellness.id.as_deref(),
        Some("00000000-0000-0000-0000-000000000001")
    );
    assert_eq!(wellness.data, wellness_activity());
    let saved = archive.records(&a, "garmin.wellness_activities");
    assert_eq!(saved[0]["day"], DAY);
    assert_eq!(
        saved[0]["attributes"]["providerId"],
        "00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(saved[0]["payload"], wellness_activity());
    let hrv = archive.records(&a, "garmin.hrv");
    assert_eq!(hrv[0]["day"], DAY);
    let collected_hrv = collected.iter().find(|r| r.collection == "hrv").unwrap();
    assert_eq!(collected_hrv.day, DAY);
    assert_eq!(hrv[0]["payload"], collected_hrv.data);
    assert_eq!(
        hrv[0]["payload"]["hrvReadings"],
        json!([null,{"hrvValue":42}])
    );
    assert_eq!(archive.records(&a, "garmin.activities").len(), 2);
    assert_eq!(
        archive.records(&a, "garmin.activity_details")[0]["day"],
        DAY
    );
    assert_eq!(
        archive.records(&a, "garmin.activity_workouts")[0]["payload"],
        json!([])
    );
    let attachment = archive.records(&a, "garmin.activity_files");
    let payload = &attachment[0]["payload"];
    assert!(payload.get("content_base64").is_none());
    let path = payload["attachment_path"].as_str().unwrap();
    assert_eq!(fs::read(archive.library.join(path)).unwrap(), bytes);
    let before = tree(&archive.library);
    assert!(
        !archive
            .import("garmin", &a, &mut garmin_api(1234).0)
            .unwrap()
            .data_changed
    );
    assert_eq!(tree(&archive.library), before);
    assert!(tree(&archive.vault).is_empty());
    archive
        .import("garmin", &b, &mut garmin_api(4321).0)
        .unwrap();
    let b_before = archive.records(&b, "garmin.daily_summary_legacy");
    archive
        .import("garmin", &a, &mut garmin_api(9999).0)
        .unwrap();
    assert_eq!(archive.records(&b, "garmin.daily_summary_legacy"), b_before);
    let other = archive.records(&b, "garmin.activity_files");
    assert_ne!(other[0]["payload"]["attachment_path"], path);
    assert_eq!(
        archive.store.metadata().unwrap().unwrap().attachments.len(),
        2
    );
}

#[test]
fn missing_or_failed_later_pages_never_activate_staged_records() {
    for source in ["oura", "garmin"] {
        let archive = Archive::new();
        assert!(tree(&archive.vault).is_empty());
        let account = hash(source.as_bytes());
        let mut seed = if source == "oura" {
            oura_api(91).0
        } else {
            garmin_api(1234).0
        };
        archive.import(source, &account, &mut seed).unwrap();
        let before = tree(&archive.library);
        for status in [None, Some(500)] {
            let mut api = Api::default();
            let path = if source == "oura" { SLEEP } else { ACTIVITIES };
            let page = if source == "oura" {
                json!({"data":[{"id":"uncommitted","day":DAY}],"next_token":"missing"})
            } else {
                json!([{"activityId":999,"startTimeLocal":"2026-10-01 12:00:00"}])
            };
            api.reply(path, 200, page);
            if let Some(status) = status {
                api.reply(path, status, Value::Null);
            }
            assert!(archive.import(source, &account, &mut api).is_err());
            assert!(!fs::read(archive.root.path().join("staged.ndjson"))
                .unwrap()
                .is_empty());
            assert_eq!(tree(&archive.library), before);
            assert!(tree(&archive.vault).is_empty());
        }
    }
}

#[test]
fn unavailable_or_failed_later_pages_keep_previous_collection_membership() {
    for source in ["oura", "garmin"] {
        let archive = Archive::new();
        assert!(tree(&archive.vault).is_empty());
        let account = hash(source.as_bytes());
        let mut seed = if source == "oura" {
            oura_api(91).0
        } else {
            garmin_api(1234).0
        };
        archive.import(source, &account, &mut seed).unwrap();
        let metric = if source == "oura" {
            "oura.sleep"
        } else {
            "garmin.activities"
        };
        let old = archive.records(&account, metric);
        let statuses: &[u16] = if source == "oura" {
            &[403, 422]
        } else {
            &[403, 404]
        };
        for &status in statuses {
            let mut api = Api::default();
            let path = if source == "oura" { SLEEP } else { ACTIVITIES };
            let page = if source == "oura" {
                json!({"data":[{"id":"partial","day":DAY}],"next_token":"later"})
            } else {
                json!([{"activityId":999,"startTimeLocal":"2026-10-01 12:00:00"}])
            };
            api.reply(path, 200, page);
            api.reply(path, status, Value::Null);
            assert!(!archive.import(source, &account, &mut api).unwrap().complete);
            assert_eq!(archive.records(&account, metric), old);
            if source == "garmin" {
                assert_eq!(
                    archive.store.metadata().unwrap().unwrap().attachments.len(),
                    1
                );
            }
        }
    }
}
