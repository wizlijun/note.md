use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::Path,
    time::Instant,
};
use write_core::{
    render::{SourceMap, TextRange},
    storage, Document,
};
extern "C" {
    fn sumi_bench_run(
        config: *const c_char,
        fixture: *const c_char,
        fonts: *const c_char,
        warmup: i32,
        samples: i32,
        interval_ms: i32,
        callback: extern "C" fn(*mut c_void, *const c_char, *mut *mut c_char) -> i64,
        free: extern "C" fn(*mut c_char),
        context: *mut c_void,
    ) -> *mut c_char;
    fn sumi_bench_free(value: *mut c_char);
}
struct Model {
    doc: Document,
    map: SourceMap,
    core_ms: Vec<f64>,
    projection_ms: Vec<f64>,
    error: Option<String>,
}
extern "C" fn free_reply(value: *mut c_char) {
    if !value.is_null() {
        unsafe { drop(CString::from_raw(value)) }
    }
}
extern "C" fn event(context: *mut c_void, raw: *const c_char, projection: *mut *mut c_char) -> i64 {
    let model = unsafe { &mut *(context as *mut Model) };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || -> Result<u64, String> {
            let input: Value = serde_json::from_slice(unsafe { CStr::from_ptr(raw) }.to_bytes())
                .map_err(|e| e.to_string())?;
            if input["kind"] != "edit" {
                return Ok(model.doc.revision());
            }
            if input["base_revision"].as_u64() != Some(model.doc.revision()) {
                return Err("stale revision".into());
            }
            let range: TextRange =
                serde_json::from_value(input["range"].clone()).map_err(|e| e.to_string())?;
            let text = input["replacement"].as_str().ok_or("replacement")?;
            let start = Instant::now();
            model
                .map
                .apply_edit(
                    &mut model.doc,
                    &range,
                    text,
                    1000 + model.core_ms.len() as i64,
                )
                .map_err(|e| e.to_string())?;
            model.map = SourceMap::new(&model.doc.body(), model.doc.revision());
            model.core_ms.push(start.elapsed().as_secs_f64() * 1000.);
            let encoding = Instant::now();
            let reply=CString::new(serde_json::to_vec(&json!({"document":model.map.document,"selection":{"start":range.start+text.encode_utf16().count() as u32,"length":0}})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            unsafe { *projection = reply.into_raw() };
            model
                .projection_ms
                .push(encoding.elapsed().as_secs_f64() * 1000.);
            Ok(model.doc.revision())
        },
    ));
    match outcome {
        Ok(Ok(revision)) => revision as i64,
        Ok(Err(error)) => {
            model.error = Some(error);
            -1
        }
        Err(_) => {
            model.error = Some("panic caught at benchmark callback".into());
            -1
        }
    }
}
fn stats(values: &[f64]) -> Value {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let q = |p: f64| sorted[((sorted.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    json!({"count":sorted.len(),"p50":q(0.5),"p95":q(0.95),"p99":q(0.99),"max":sorted.last()})
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len()>=4,"usage: sumi-native-benchmark corpus.json font-resource-dir output.json [repeats=5] [warmup=1000] [samples=100]");
    let raw = std::fs::read(&args[1]).unwrap();
    let fixture: Value = serde_json::from_slice(&raw).unwrap();
    let markdown = fixture["markdown"].as_str().unwrap();
    assert_eq!(
        storage::sha256(markdown.as_bytes()),
        fixture["sha256"].as_str().unwrap()
    );
    let fonts = Path::new(&args[2]).canonicalize().unwrap();
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(fonts.join("manifest.json")).unwrap()).unwrap();
    for asset in manifest["assets"].as_array().unwrap() {
        let file = asset["file"].as_str().unwrap();
        if file.ends_with(".ttf") || file.ends_with(".otf") {
            assert_eq!(
                storage::sha256(&std::fs::read(fonts.join(file)).unwrap()),
                asset["sha256"].as_str().unwrap()
            )
        }
    }
    let number = |i: usize, default: i32| {
        args.get(i)
            .map(|s| s.parse::<i32>().unwrap())
            .unwrap_or(default)
    };
    let repeats = number(4, 5);
    let warmup = number(5, 1000);
    let samples = number(6, 100);
    assert!(
        (1..=10).contains(&repeats)
            && (0..=10000).contains(&warmup)
            && (1..=1000).contains(&samples)
    );
    let mut reports = vec![];
    for repeat in 0..repeats {
        let open = Instant::now();
        let mut doc = Document::new("87d92d1a-f37d-46e8-b83e-dc3e671fb425", 1, 90).unwrap();
        doc.replace(0, 0, 0, markdown, 1).unwrap();
        let map = SourceMap::new(&doc.body(), doc.revision());
        let core_open_ms = open.elapsed().as_secs_f64() * 1000.;
        let config=CString::new(serde_json::to_vec(&json!({"surface_id":"benchmark","generation":1,"revision":doc.revision(),"bounds":{"x":0,"y":0,"width":900,"height":650},"document":map.document,"selection":{"start":0,"length":0},"appearance":{"font_family":"Sumi Plex","font_size":22.,"line_height":1.6,"foreground":"#cccccc","background":"#111111","max_columns":80,"bottom_inset":0}})).unwrap()).unwrap();
        let fixture_c = CString::new(raw.clone()).unwrap();
        let font_c = CString::new(fonts.to_str().unwrap()).unwrap();
        let mut model = Model {
            doc,
            map,
            core_ms: vec![],
            projection_ms: vec![],
            error: None,
        };
        let ptr = unsafe {
            sumi_bench_run(
                config.as_ptr(),
                fixture_c.as_ptr(),
                font_c.as_ptr(),
                warmup,
                samples,
                100,
                event,
                free_reply,
                &mut model as *mut _ as *mut c_void,
            )
        };
        assert!(!ptr.is_null());
        let mut report: Value =
            serde_json::from_slice(unsafe { CStr::from_ptr(ptr) }.to_bytes()).unwrap();
        unsafe { sumi_bench_free(ptr) };
        assert!(model.error.is_none(), "{:?}", model.error);
        assert_eq!(model.core_ms.len(), (warmup + samples) as usize);
        let text = report
            .as_object_mut()
            .unwrap()
            .remove("final_text")
            .unwrap();
        assert_eq!(text.as_str().unwrap(), model.map.document.text);
        report["final_visible_sha256"] = json!(storage::sha256(text.as_str().unwrap().as_bytes()));
        report["repeat"] = json!(repeat);
        report["core_open_ms"] = json!(core_open_ms);
        report["warmup"] = json!(warmup);
        report["samples"] = json!(samples);
        let core = &model.core_ms[warmup as usize..];
        let encode = &model.projection_ms[warmup as usize..];
        report["core_apply_and_render_ms"] = stats(core);
        report["projection_json_ms"] = stats(encode);
        report["core_raw_ms"] = json!(core);
        report["projection_raw_ms"] = json!(encode);
        for key in [
            "insertText_return_ms",
            "insertText_plus_viewport_layout_ms",
            "viewport_layout_ms",
        ] {
            let values: Vec<f64> = report["raw"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s[key].as_f64().unwrap())
                .collect();
            report[key] = stats(&values);
        }
        eprintln!("repeat {} of {} complete", repeat + 1, repeats);
        reports.push(report);
    }
    let mut fixture = fixture;
    fixture.as_object_mut().unwrap().remove("markdown");
    let report = json!({"schema":1,"mode":"production-editor.m-plus-write-core","measurement_scope":"programmatic NSTextView insertText callback + core + projection; hidden AppKit viewport layout; excludes Tauri host mutex/queue, SQLite, network, event delivery and compositor; NOT physical input-to-frame","physical_input_to_frame_ms":null,"fixture":fixture,"font_manifest":manifest,"build_profile":if cfg!(debug_assertions){"debug"}else{"release"},"repeats":reports});
    std::fs::write(&args[3], serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
