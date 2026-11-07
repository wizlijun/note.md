use native::{
    Appearance, Bounds, EventHandler, NativeEvent, RenderDocument, SurfaceCommand, SurfaceConfig,
    TextRange,
};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_native_editor as native;
#[derive(Default)]
struct Model {
    text: String,
    revision: u64,
    events: Vec<NativeEvent>,
}
struct Probe(Arc<Mutex<Model>>);
fn probe_dir() -> std::path::PathBuf {
    std::env::var("SUMI_PROBE_DIR")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../tasks/sumi-native").to_owned())
        .into()
}
fn byte_position(text: &str, utf16: u32) -> Option<usize> {
    let mut pos = 0;
    for (i, c) in text.char_indices() {
        if pos == utf16 {
            return Some(i);
        }
        pos += c.len_utf16() as u32;
    }
    if pos == utf16 {
        Some(text.len())
    } else {
        None
    }
}
#[tauri::command]
async fn focus_editor(window: WebviewWindow) -> Result<(), String> {
    native::command(&window, "probe".into(), 1, SurfaceCommand::Focus).await
}
#[tauri::command]
async fn visibility(window: WebviewWindow, visible: bool) -> Result<(), String> {
    native::command(
        &window,
        "probe".into(),
        1,
        SurfaceCommand::SetVisible { visible },
    )
    .await
}
#[tauri::command]
async fn snapshot(
    window: WebviewWindow,
    probe: State<'_, Probe>,
) -> Result<serde_json::Value, String> {
    let surface = native::inspect(&window, "probe".into(), 1).await?;
    let events = probe.0.lock().unwrap().events.clone();
    let value = serde_json::json!({"surface":surface,"events":events});
    {
        let dir = probe_dir();
        std::fs::write(
            std::path::Path::new(&dir).join("tauri-snapshot.json"),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        std::fs::write(dir.join("probe-draft.txt"), &surface.text).map_err(|e| e.to_string())?;
    }
    Ok(value)
}
#[tauri::command]
async fn remote_edit(window: WebviewWindow, probe: State<'_, Probe>) -> Result<(), String> {
    let surface = native::inspect(&window, "probe".into(), 1).await?;
    let document = RenderDocument {
        text: format!("{}\nRemote 同步增量", surface.text),
        runs: vec![],
    };
    native::command(
        &window,
        "probe".into(),
        1,
        SurfaceCommand::ApplyDocument {
            base_revision: surface.revision,
            revision: surface.revision + 1,
            document: document.clone(),
            selection: surface.selection,
        },
    )
    .await?;
    let mut model = probe.0.lock().unwrap();
    model.text = document.text;
    model.revision = surface.revision + 1;
    Ok(())
}
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0)
}
fn main() {
    let model = Arc::new(Mutex::new(Model {
        text: std::fs::read_to_string(probe_dir().join("probe-draft.txt")).unwrap_or_else(|_| {
            "Sumi 原生写作\n这里是隔离的 TextKit 2 编辑区域。\n中文输入、emoji 😀、选区与撤销路由。".into()
        }),
        ..Default::default()
    }));
    tauri::Builder::default()
        .plugin(native::init())
        .manage(Probe(model.clone()))
        .invoke_handler(tauri::generate_handler![
            focus_editor,
            visibility,
            snapshot,
            remote_edit,
            quit
        ])
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();
            let callback_model = model.clone();
            let handler: EventHandler = Arc::new(move |event| {
                let mut model = callback_model.lock().map_err(|e| e.to_string())?;
                model.events.push(event.clone());
                if let NativeEvent::Edit {
                    base_revision,
                    range,
                    replacement,
                    ..
                } = event
                {
                    if base_revision != model.revision {
                        return Err("probe revision mismatch".into());
                    }
                    let start = byte_position(&model.text, range.start).ok_or("invalid start")?;
                    let end = byte_position(&model.text, range.start + range.length)
                        .ok_or("invalid end")?;
                    model.text.replace_range(start..end, &replacement);
                    model.revision += 1;
                }
                Ok(model.revision.into())
            });
            let text = model.lock().unwrap().text.clone();
            tauri::async_runtime::spawn(async move {
                native::mount(
                    &window,
                    SurfaceConfig {
                        surface_id: "probe".into(),
                        generation: 1,
                        revision: 0,
                        bounds: Bounds {
                            x: 0.,
                            y: 56.,
                            width: 960.,
                            height: 500.,
                        },
                        selection: TextRange::default(),
                        viewport: native::Viewport::default(),
                        appearance: Appearance::default(),
                        document: RenderDocument {
                            text,
                            runs: vec![native::StyleRun {
                                range: TextRange {
                                    start: 0,
                                    length: 9,
                                },
                                bold: true,
                                italic: false,
                                strike: false,
                                heading: 1,
                                quote: false,
                                link: None,
                            }],
                        },
                    },
                    handler,
                )
                .await
                .expect("mount native surface");
                native::command(&window, "probe".into(), 1, SurfaceCommand::Focus)
                    .await
                    .expect("focus");
            });
            Ok(())
        })
        .run(tauri::generate_context!("examples/probe/tauri.conf.json"))
        .expect("run native probe");
}
