use native::{
    Appearance, Bounds, EventHandler, NativeEvent, RenderDocument, SurfaceCommand, SurfaceConfig,
    TextRange,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_native_editor as native;
#[derive(Default)]
struct Model {
    text: String,
    revision: u64,
    events: Vec<NativeEvent>,
}
struct Probe(Arc<Mutex<Model>>);
static SNAPSHOTS: AtomicUsize = AtomicUsize::new(0);
static CLONE_STRESS_STARTED: AtomicBool = AtomicBool::new(false);
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
async fn resize_probe(window: WebviewWindow, bounds: Bounds) -> Result<(), String> {
    native::command(
        &window,
        "probe".into(),
        1,
        SurfaceCommand::SetBounds { bounds },
    )
    .await
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
    SNAPSHOTS.fetch_add(1, Ordering::Relaxed);
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
fn probe_automation() -> bool {
    std::env::var("SUMI_PROBE_AUTOMATED").as_deref() == Ok("1")
}
#[tauri::command]
fn clone_stress(
    app: tauri::AppHandle,
    window: WebviewWindow,
    start: bool,
) -> Result<serde_json::Value, String> {
    if std::env::var("SUMI_PROBE_CLONE_STRESS").as_deref() != Ok("1") {
        return Ok(serde_json::json!({"enabled":false}));
    }
    if start && !CLONE_STRESS_STARTED.swap(true, Ordering::SeqCst) {
        let baseline = SNAPSHOTS.load(Ordering::Relaxed);
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let app = app.clone();
                let window = window.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for i in 0..20_000 {
                        // Background workers only clone/drop handles, never call GTK.
                        drop(std::hint::black_box(app.clone()));
                        drop(std::hint::black_box(window.clone()));
                        if i % 200 == 0 {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                    }
                    20_000usize
                })
            })
            .collect();
        std::thread::spawn(move || {
            let mut completed = 0;
            let mut iterations = 0;
            for worker in workers {
                if let Ok(count) = worker.join() {
                    completed += 1;
                    iterations += count;
                }
            }
            let snapshots = SNAPSHOTS.load(Ordering::Relaxed).saturating_sub(baseline);
            let result = serde_json::json!({"enabled":true,"complete":true,
                "completedWorkers":completed,"iterations":iterations,"explicitHandleClones":iterations*2,
                "mainSnapshotDelta":snapshots,"passed":completed==8 && snapshots>0});
            let _ = std::fs::write(probe_dir().join("clone-stress.json"), result.to_string());
        });
    }
    match std::fs::read(probe_dir().join("clone-stress.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(serde_json::json!({"enabled":true,"complete":false}))
        }
        Err(error) => Err(error.to_string()),
    }
}
#[tauri::command]
async fn panel_select_all(window: WebviewWindow) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(native::menu_command("input:select_all"));
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())
}
#[cfg(target_os = "linux")]
fn schedule_draw_diagnostics(root: gtk::Widget) {
    use gtk::prelude::*;
    use std::{cell::RefCell, rc::Rc};
    if std::env::var("SUMI_PROBE_DRAW_DIAGNOSTICS").as_deref() != Ok("1") { return; }
    gtk::glib::timeout_add_local_once(std::time::Duration::from_secs(45), move || {
        fn collect(widget: &gtk::Widget, items: &mut Vec<gtk::Widget>) {
            items.push(widget.clone());
            if let Some(container) = widget.downcast_ref::<gtk::Container>() {
                for child in container.children() { collect(&child, items); }
            }
        }
        let mut widgets = Vec::new();
        collect(&root, &mut widgets);
        let data = Rc::new(RefCell::new(Vec::<serde_json::Value>::new()));
        let mut handlers = Vec::new();
        for widget in widgets {
            let a = widget.allocation();
            let describe_window = |window: gtk::gdk::Window| {
                let (x,y,w,h) = window.geometry();
                serde_json::json!({"geometry":[x,y,w,h],"hasNative":window.has_native(),"origin":window.origin()})
            };
            let i = data.borrow().len();
            data.borrow_mut().push(serde_json::json!({"type":widget.type_().name(),
                "allocation":[a.x(),a.y(),a.width(),a.height()],"hasWindow":widget.has_window(),
                "window":widget.window().map(describe_window),
                "parentWindow":widget.parent_window().map(describe_window),
                "draws":0,"clips":[]}));
            let out = data.clone();
            let id = widget.connect_draw(move |_, cr| {
                let mut out=out.borrow_mut();
                let entry=&mut out[i];
                entry["draws"]=serde_json::json!(entry["draws"].as_u64().unwrap()+1);
                if let Ok((x1,y1,x2,y2))=cr.clip_extents() {
                    let clip=serde_json::json!([x1,y1,x2,y2]);
                    let clips=entry["clips"].as_array_mut().unwrap();
                    if !clips.contains(&clip) && clips.len()<8 {clips.push(clip);}
                }
                gtk::glib::Propagation::Proceed
            });
            handlers.push((widget,id));
        }
        gtk::glib::timeout_add_local_once(std::time::Duration::from_secs(2),move || {
            for (widget,id) in handlers {widget.disconnect(id);}
            let result=serde_json::json!({"sampleSeconds":2,"startAfterGeometrySeconds":45,"widgets":*data.borrow()});
            let _=std::fs::write(probe_dir().join("draw-diagnostics.json"),serde_json::to_vec_pretty(&result).unwrap());
        });
    });
}
#[tauri::command]
async fn probe_geometry(window: WebviewWindow) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window.with_webview(move |webview| {
            use gtk::prelude::*;
            use webkit2gtk::WebViewExt;
            let view = webview.inner();
            if let Some(root)=view.toplevel() {schedule_draw_diagnostics(root);}
            // Exercise Tauri's attached touch callback without claiming a
            // physical touchscreen/gesture test. This decorated window must
            // safely resolve its toplevel through the native GTK overlay.
            // Stop after Tauri's previously attached handler: an artificial
            // event has no touch sequence/device for WebKit's default handler.
            let touch_stop = view.connect_touch_event(|_, _| gtk::glib::Propagation::Stop);
            let event = gtk::gdk::Event::new(gtk::gdk::EventType::TouchBegin);
            let touch_handled = view.emit_by_name::<bool>("touch-event", &[&event]);
            view.disconnect(touch_stop);
            let allocation = view.allocation();
            let titlebar = view.toplevel()
                .and_then(|widget| widget.downcast::<gtk::Window>().ok())
                .and_then(|window| window.titlebar())
                .map(|bar| { let a = bar.allocation(); [a.x(), a.y(), a.width(), a.height()] });
            let origin = view.toplevel().and_then(|parent| view.translate_coordinates(&parent, 0, 0));
            let _ = tx.send(serde_json::json!({
                "gtkAllocation": [allocation.x(), allocation.y(), allocation.width(), allocation.height()],
            "gtkScale": view.scale_factor(), "webkitZoom": view.zoom_level(),
                "windowOrigin": origin, "syntheticTouchCallbackCompleted": true,
                "titlebarAllocation": titlebar,
                "syntheticTouchHandled": touch_handled,
            }));
        }).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Ok(serde_json::json!({}))
    }
}
#[tauri::command]
fn probe_report(report: serde_json::Value) -> Result<(), String> {
    std::fs::create_dir_all(probe_dir()).map_err(|e| e.to_string())?;
    std::fs::write(
        probe_dir().join("tauri-acceptance.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn probe_pointer(event: serde_json::Value) -> Result<(), String> {
    std::fs::write(probe_dir().join("web-pointer.json"), event.to_string())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0)
}
fn main() {
    std::fs::create_dir_all(probe_dir()).expect("create isolated probe output");
    let model = Arc::new(Mutex::new(Model {
        text: std::fs::read_to_string(probe_dir().join("probe-draft.txt")).unwrap_or_else(|_| {
            "Sumi 原生写作\n这里是隔离的系统原生编辑区域。\n中文输入、emoji 😀、选区与撤销路由。".into()
        }),
        ..Default::default()
    }));
    tauri::Builder::default()
        .plugin(native::init())
        .manage(Probe(model.clone()))
        .on_menu_event(|_, event| {
            if event.id().as_ref() == "probe-save" {
                let consumed = native::menu_command("save");
                let _ = std::fs::write(
                    probe_dir().join("menu-event.json"),
                    serde_json::json!({"action":"save", "consumed":consumed}).to_string(),
                );
            }
        })
        .invoke_handler(tauri::generate_handler![
            focus_editor,
            resize_probe,
            visibility,
            snapshot,
            remote_edit,
            quit,
            probe_automation,
            clone_stress,
            probe_report,
            panel_select_all,
            probe_geometry,
            probe_pointer
        ])
        .setup(move |app| {
            let menu = tauri::menu::MenuBuilder::new(app)
                .item(
                    &tauri::menu::SubmenuBuilder::new(app, "Probe")
                        .text("probe-save", "Save native surface")
                        .build()?,
                )
                .build()?;
            app.set_menu(menu)?;
            let window = app.get_webview_window("main").unwrap();
            #[cfg(target_os = "linux")]
            window.with_webview(|webview| {
                use gtk::prelude::*;
                webview.inner().connect_button_press_event(|_, event| {
                    let _ = std::fs::write(probe_dir().join("gtk-web-pointer.json"),
                        serde_json::json!({"position":event.position(),"root":event.root(),"button":event.button()}).to_string());
                    gtk::glib::Propagation::Proceed
                });
            })?;
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
            if std::env::var("SUMI_PROBE_WEB_ONLY").as_deref() != Ok("1") {
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
                            width: 760.,
                            height: 290.,
                        },
                        selection: TextRange::default(),
                        viewport: native::Viewport::default(),
                            appearance: Appearance {
                                caret_motion: if std::env::var("SUMI_PROBE_CARET").as_deref()
                                    == Ok("steady")
                                {
                                    native::CaretMotion::Steady
                                } else {
                                    native::CaretMotion::Breathing
                                },
                                ..Appearance::default()
                            },
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
            }
            Ok(())
        })
        .run(tauri::generate_context!("examples/probe/tauri.conf.json"))
        .expect("run native probe");
}
