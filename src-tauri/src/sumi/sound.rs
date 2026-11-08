//! Ephemeral typing feedback. No text, durable edit, or network sync enters this queue.
use super::*;
use std::{
    sync::Weak,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch};
const CAPACITY: usize = 64;
const TTL: Duration = Duration::from_millis(150);
const CONFIGURE_TTL: Duration = Duration::from_secs(3);
fn deadline_ms(duration: Duration) -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    now.saturating_add(duration.as_millis())
        .min(u64::MAX as u128) as u64
}

// There is one native input monitor per process, across Vault workspaces.
static MONITOR_OWNER: LazyLock<tokio::sync::Mutex<Option<Weak<Workspace>>>> =
    LazyLock::new(Default::default);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Settings {
    pub enabled: bool,
    pub preset: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            preset: "typewriter".into(),
        }
    }
}
impl Settings {
    fn validate(&self) -> Result<()> {
        if !matches!(self.preset.as_str(), "typewriter" | "thock") {
            return Err("Invalid typing sound preset".into());
        }
        Ok(())
    }
}
#[derive(Serialize)]
pub(super) struct State {
    enabled: bool,
    preset: String,
    permission: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
#[derive(Default)]
pub(super) struct Controller {
    serial: tokio::sync::Mutex<()>,
    running: Mutex<Option<Run>>,
    error: Arc<Mutex<Option<String>>>,
}
struct Run {
    input: Arc<Input>,
    task: tauri::async_runtime::JoinHandle<()>,
    settings: Settings,
}
struct Queued {
    event: native::TypingSoundEvent,
    at: Instant,
    expires_at_ms: u64,
    epoch: u64,
}
struct Input {
    sender: mpsc::Sender<Queued>,
    stop: watch::Sender<u64>,
    epoch: AtomicU64,
    accepting: AtomicBool,
}
impl Input {
    fn fence(&self) {
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.stop.send_replace(epoch);
    }
    fn close(&self) {
        self.accepting.store(false, Ordering::Release);
        self.fence();
    }
    fn send(&self, event: native::TypingSoundEvent) {
        if !self.accepting.load(Ordering::Acquire) {
            return;
        }
        if event.role == native::TypingSoundRole::Stop {
            self.fence();
            return;
        }
        let queued = Queued {
            event,
            at: Instant::now(),
            expires_at_ms: deadline_ms(TTL),
            epoch: self.epoch.load(Ordering::Acquire),
        };
        // A lost release event must not leave a pressed-key sound ringing.
        if self.sender.try_send(queued).is_err() {
            self.fence();
        }
    }
    fn fresh(&self, queued: &Queued) -> bool {
        self.accepting.load(Ordering::Acquire)
            && queued.epoch == self.epoch.load(Ordering::Acquire)
            && queued.at.elapsed() <= TTL
    }
}
async fn load(ws: &Workspace) -> Result<Settings> {
    let settings: Settings = ws
        .durable
        .preferences("typingSound".into())
        .await?
        .map(serde_json::from_value)
        .transpose()
        .map_err(err)?
        .unwrap_or_default();
    Settings::validate(&settings)?;
    Ok(settings)
}
fn event_owner(ws: &Workspace, event: &native::TypingSoundEvent) -> Option<String> {
    if ws.phase.load(Ordering::Acquire) != ACTIVE {
        return None;
    }
    ws.papers.lock().ok()?.values().find_map(|paper| {
        let owner = paper.owner.as_ref()?;
        if paper.entry.deleted || owner.suspended || owner.generation != paper.entry.generation {
            return None;
        }
        let surface = owner.surface.as_ref()?;
        (surface.surface_id == event.surface_id && surface.generation == event.generation)
            .then(|| owner.window.clone())
    })
}
fn valid_event<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Workspace,
    event: &native::TypingSoundEvent,
) -> bool {
    if current_native(app, ws).is_err() {
        return false;
    }
    event_owner(ws, event)
        .and_then(|label| app.get_webview_window(&label))
        .is_some_and(|window| {
            window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false)
        })
}
async fn stop_backend(backend: &service::Backend, token: &str) -> Result<()> {
    let _: Value = tokio::time::timeout(
        Duration::from_secs(1),
        backend.call_existing("sound", json!({"operation":"stop","token":token})),
    )
    .await
    .map_err(|_| "Typing sound stop timed out".to_owned())??;
    Ok(())
}
async fn disable_backend(backend: &service::Backend, token: &str) {
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        backend.call_existing::<Value>(
            "sound",
            json!({"operation":"configure","enabled":false,"preset":"typewriter","token":token}),
        ),
    )
    .await;
}
async fn worker<R: Runtime>(
    app: tauri::AppHandle<R>,
    ws: Weak<Workspace>,
    backend: service::Backend,
    token: String,
    input: Arc<Input>,
    mut receiver: mpsc::Receiver<Queued>,
    mut stops: watch::Receiver<u64>,
    error: Arc<Mutex<Option<String>>>,
) {
    let result: Result<()> = async {
        loop {
            tokio::select! { biased;
                changed = stops.changed() => {
                    if changed.is_err() { break; }
                    stop_backend(&backend, &token).await?;
                    if !input.accepting.load(Ordering::Acquire) { break; }
                }
                queued = receiver.recv() => {
                    let Some(queued) = queued else { break; };
                    if !input.fresh(&queued) { continue; }
                    let Some(ws) = ws.upgrade() else { break; };
                    if !valid_event(&app, &ws, &queued.event) { input.fence(); continue; }
                    // Await each response before the next operation. A stop has
                    // priority next, with at most one bounded 150 ms call in flight.
                    let play = backend.call_existing::<Value>("sound", json!({"operation":"play","token":token,"roles":[queued.event.role],"expires_at_ms":queued.expires_at_ms}));
                    let value = tokio::time::timeout(TTL, play).await.map_err(|_| "Typing sound playback timed out".to_owned())??;
                    if value["ready"].as_bool() != Some(true) { return Err("Typing sound engine unavailable".into()); }
                }
            }
        }
        Ok(())
    }.await;
    input.close();
    if let Err(message) = result {
        if let Ok(mut error) = error.lock() {
            *error = Some(message);
        }
    }
    disable_backend(&backend, &token).await;
}
async fn stop_locked<R: Runtime>(app: &tauri::AppHandle<R>, ws: &Workspace, owns_monitor: bool) {
    let running = ws
        .sound
        .running
        .lock()
        .ok()
        .and_then(|mut running| running.take());
    if owns_monitor {
        let _ = native::configure_typing_monitor(app, false, None).await;
    }
    if let Some(run) = running {
        run.input.close();
        let _ = run.task.await;
    }
}
pub(super) async fn stop<R: Runtime>(app: &tauri::AppHandle<R>, ws: &Workspace) {
    if let Ok(run) = ws.sound.running.lock() {
        if let Some(run) = run.as_ref() {
            run.input.close();
        }
    }
    let _serial = ws.sound.serial.lock().await;
    let mut owner = MONITOR_OWNER.lock().await;
    let owns = owner
        .as_ref()
        .and_then(Weak::upgrade)
        .is_some_and(|current| std::ptr::eq(current.as_ref(), ws));
    stop_locked(app, ws, owns).await;
    if owns {
        *owner = None;
    }
}
async fn configure<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    settings: &Settings,
) -> Result<()> {
    current(app, ws)?;
    let mut owner = MONITOR_OWNER.lock().await;
    current(app, ws)?;
    if let Some(previous) = owner.take().and_then(|owner| owner.upgrade()) {
        stop_locked(app, &previous, true).await;
    }
    stop_locked(app, ws, false).await;
    current(app, ws)?;
    *ws.sound.error.lock().map_err(err)? = None;
    if !settings.enabled || !cfg!(target_os = "macos") {
        return Ok(());
    }
    let monitor = native::typing_monitor_status(app).await?;
    if !monitor.permission_granted {
        return Ok(());
    }
    let backend = ws
        .sound_backend
        .clone()
        .ok_or("Typing sound backend unavailable")?;
    let token = Uuid::new_v4().to_string();
    let configured = tokio::time::timeout(
        CONFIGURE_TTL,
        backend.call::<Value>(
            "sound",
            json!({"operation":"configure","enabled":true,"preset":settings.preset,"token":token,"expires_at_ms":deadline_ms(CONFIGURE_TTL)}),
        ),
    )
    .await
    .map_err(|_| "Typing sound configuration timed out".to_owned())
    .and_then(|result| result);
    if !configured
        .as_ref()
        .is_ok_and(|result| result["ready"].as_bool() == Some(true))
    {
        disable_backend(&backend, &token).await;
        return Err(configured
            .err()
            .unwrap_or_else(|| "Typing sound engine unavailable".into()));
    }
    if let Err(error) = current(app, ws) {
        disable_backend(&backend, &token).await;
        return Err(error);
    }
    let (sender, receiver) = mpsc::channel(CAPACITY);
    let (stop, stops) = watch::channel(0);
    let input = Arc::new(Input {
        sender,
        stop,
        epoch: AtomicU64::new(0),
        accepting: AtomicBool::new(true),
    });
    let handler: native::TypingSoundHandler = {
        let input = input.clone();
        Arc::new(move |event| input.send(event))
    };
    let monitor = match native::configure_typing_monitor(app, true, Some(handler)).await {
        Ok(monitor) if monitor.listening => monitor,
        result => {
            input.close();
            disable_backend(&backend, &token).await;
            let _ = native::configure_typing_monitor(app, false, None).await;
            return Err(result
                .err()
                .unwrap_or_else(|| "Typing input monitor unavailable".into()));
        }
    };
    let _ = monitor;
    let task = tauri::async_runtime::spawn(worker(
        app.clone(),
        Arc::downgrade(ws),
        backend,
        token,
        input.clone(),
        receiver,
        stops,
        ws.sound.error.clone(),
    ));
    *ws.sound.running.lock().map_err(err)? = Some(Run {
        input,
        task,
        settings: settings.clone(),
    });
    *owner = Some(Arc::downgrade(ws));
    if current(app, ws).is_err() {
        stop_locked(app, ws, true).await;
        *owner = None;
    }
    Ok(())
}
async fn state_locked<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Workspace,
    settings: Settings,
) -> State {
    let mut error = ws.sound.error.lock().ok().and_then(|error| error.clone());
    let monitor = match native::typing_monitor_status(app).await {
        Ok(status) => Some(status),
        Err(message) => {
            error = Some(message);
            None
        }
    };
    let permission = if !cfg!(target_os = "macos") {
        "unsupported"
    } else if monitor.is_some_and(|status| status.permission_granted) {
        "granted"
    } else {
        "required"
    };
    let running = ws.sound.running.lock().ok().is_some_and(|run| {
        run.as_ref().is_some_and(|run| {
            run.input.accepting.load(Ordering::Acquire) && run.settings == settings
        })
    });
    let mut ready = settings.enabled && running && monitor.is_some_and(|status| status.listening);
    if ready {
        let status = match &ws.sound_backend {
            Some(backend) => tokio::time::timeout(
                TTL,
                backend.call_existing::<Value>("sound", json!({"operation":"status"})),
            )
            .await
            .map_err(|_| "Typing sound status timed out".to_owned())
            .and_then(|result| result),
            None => Err("Typing sound backend unavailable".into()),
        };
        if !status
            .as_ref()
            .is_ok_and(|status| status["ready"].as_bool() == Some(true))
        {
            ready = false;
            error = Some(
                status
                    .err()
                    .unwrap_or_else(|| "Typing sound engine unavailable".into()),
            );
            if let Ok(run) = ws.sound.running.lock() {
                if let Some(run) = run.as_ref() {
                    run.input.close();
                }
            }
            if let Ok(mut saved) = ws.sound.error.lock() {
                *saved = error.clone();
            }
        }
    }
    let status = if !settings.enabled {
        "off"
    } else if error.is_some() || permission == "unsupported" {
        "unavailable"
    } else if permission == "required" {
        "permission_required"
    } else if ready {
        "ready"
    } else {
        "unavailable"
    };
    State {
        enabled: settings.enabled,
        preset: settings.preset,
        permission,
        status,
        error,
    }
}
pub(super) async fn start<R: Runtime>(app: &tauri::AppHandle<R>, ws: &Arc<Workspace>) {
    let _serial = ws.sound.serial.lock().await;
    let result: Result<()> = async {
        current(app, ws)?;
        let settings = load(ws).await?;
        let running = ws
            .sound
            .running
            .lock()
            .map_err(err)?
            .as_ref()
            .is_some_and(|run| {
                run.settings == settings && run.input.accepting.load(Ordering::Acquire)
            });
        if !running {
            configure(app, ws, &settings).await?;
        }
        Ok(())
    }
    .await;
    if let Err(message) = result {
        if let Ok(mut error) = ws.sound.error.lock() {
            *error = Some(message);
        }
    }
}
pub(super) async fn dispatch<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let _serial = ws.sound.serial.lock().await;
    current(app, ws)?;
    let settings = if method == "host.sumi.sound_set" {
        let settings: Settings = serde_json::from_value(params.clone()).map_err(err)?;
        settings.validate()?;
        ws.durable
            .set_preferences(
                "typingSound".into(),
                serde_json::to_value(&settings).map_err(err)?,
            )
            .await?;
        settings
    } else {
        load(ws).await?
    };
    let configured: Result<()> = async {
        current(app, ws)?;
        if method == "host.sumi.sound_request_permission" {
            native::request_typing_permission(app).await?;
        }
        let running = ws
            .sound
            .running
            .lock()
            .map_err(err)?
            .as_ref()
            .is_some_and(|run| {
                run.settings == settings && run.input.accepting.load(Ordering::Acquire)
            });
        if method != "host.sumi.sound_state" || !running {
            configure(app, ws, &settings).await?;
        }
        Ok(())
    }
    .await;
    if let Err(message) = configured {
        *ws.sound.error.lock().map_err(err)? = Some(message);
    }
    Ok(serde_json::to_value(state_locked(app, ws, settings).await).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(role: native::TypingSoundRole) -> native::TypingSoundEvent {
        native::TypingSoundEvent {
            surface_id: "surface".into(),
            generation: 7,
            role,
        }
    }
    fn queue() -> (Input, mpsc::Receiver<Queued>, watch::Receiver<u64>) {
        let (sender, receiver) = mpsc::channel(CAPACITY);
        let (stop, watch) = watch::channel(0);
        (
            Input {
                sender,
                stop,
                epoch: AtomicU64::new(0),
                accepting: AtomicBool::new(true),
            },
            receiver,
            watch,
        )
    }
    #[tokio::test]
    async fn sound_defaults_persist_separately_without_changing_appearance_or_documents() {
        let (_temp, ws, id) = super::super::tests::fixture().await;
        let before = ws.papers.lock().unwrap()[&id].doc.encode_full();
        let appearance = serde_json::to_value(ws.preferences.lock().unwrap().clone()).unwrap();
        assert_eq!(load(&ws).await.unwrap(), Settings::default());
        ws.durable
            .set_preferences("appearance".into(), appearance.clone())
            .await
            .unwrap();
        let settings = Settings {
            enabled: false,
            preset: "thock".into(),
        };
        ws.durable
            .set_preferences(
                "typingSound".into(),
                serde_json::to_value(&settings).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(load(&ws).await.unwrap(), settings);
        assert_eq!(
            ws.durable.preferences("appearance".into()).await.unwrap(),
            Some(appearance)
        );
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.encode_full(), before);
        ws.durable
            .set_preferences(
                "typingSound".into(),
                json!({"enabled":true,"preset":"unknown"}),
            )
            .await
            .unwrap();
        assert!(load(&ws).await.is_err());
        for invalid in [
            json!({"preset":"typewriter"}),
            json!({"enabled":"true","preset":"typewriter"}),
            json!({"enabled":true,"preset":"typewriter","text":"private"}),
        ] {
            assert!(serde_json::from_value::<Settings>(invalid).is_err());
        }
    }
    #[test]
    fn full_queue_stop_cannot_be_dropped_and_new_focus_only_uses_new_epoch() {
        let (input, mut receiver, watch) = queue();
        for _ in 0..CAPACITY {
            input.send(event(native::TypingSoundRole::Key));
        }
        input.send(event(native::TypingSoundRole::KeyUp));
        assert_eq!(
            *watch.borrow(),
            1,
            "overflow must stop, including a lost release"
        );
        input.send(event(native::TypingSoundRole::Stop));
        assert_eq!(*watch.borrow(), 2);
        while let Ok(queued) = receiver.try_recv() {
            assert!(!input.fresh(&queued));
        }
        input.send(event(native::TypingSoundRole::Space));
        assert!(input.fresh(&receiver.try_recv().unwrap()));
        input.close();
        input.send(event(native::TypingSoundRole::Key));
        assert!(receiver.try_recv().is_err());
    }
    #[test]
    fn configuration_and_key_deadlines_have_bounded_backend_expiry() {
        for duration in [TTL, CONFIGURE_TTL] {
            let before = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let deadline = deadline_ms(duration);
            let after = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            assert!(deadline >= before + duration.as_millis() as u64);
            assert!(deadline <= after + duration.as_millis() as u64);
        }
        let (input, mut receiver, _) = queue();
        input.send(event(native::TypingSoundRole::Key));
        assert!(receiver.try_recv().unwrap().expires_at_ms <= deadline_ms(TTL));
    }
    #[test]
    fn expired_or_closed_events_never_play() {
        let (input, mut receiver, _) = queue();
        input.send(event(native::TypingSoundRole::Key));
        let mut queued = receiver.try_recv().unwrap();
        assert!(input.fresh(&queued));
        queued.at = Instant::now() - TTL - Duration::from_millis(1);
        assert!(!input.fresh(&queued));
        queued.at = Instant::now();
        input.close();
        assert!(!input.fresh(&queued));
    }
    #[tokio::test]
    async fn owner_surface_generation_and_lifecycle_are_rechecked() {
        let (_temp, ws, id) = super::super::tests::fixture().await;
        let event = event(native::TypingSoundRole::Key);
        assert!(event_owner(&ws, &event).is_none());
        ws.papers
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .owner
            .as_mut()
            .unwrap()
            .surface = Some(Surface {
            surface_id: "surface".into(),
            generation: 7,
        });
        assert_eq!(event_owner(&ws, &event).as_deref(), Some("main"));
        assert!(event_owner(
            &ws,
            &native::TypingSoundEvent {
                generation: 8,
                ..event.clone()
            }
        )
        .is_none());
        for phase in [QUIESCING, QUIESCED] {
            ws.phase.store(phase, Ordering::Release);
            assert!(event_owner(&ws, &event).is_none());
        }
        ws.phase.store(ACTIVE, Ordering::Release);
        ws.papers
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .owner
            .as_mut()
            .unwrap()
            .suspended = true;
        assert!(event_owner(&ws, &event).is_none());
        ws.papers
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .owner
            .as_mut()
            .unwrap()
            .suspended = false;
        ws.papers
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .entry
            .deleted = true;
        assert!(event_owner(&ws, &event).is_none());
    }
}
