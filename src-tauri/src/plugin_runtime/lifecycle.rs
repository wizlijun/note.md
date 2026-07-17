//! Plugin lifecycle state machine (spec §4.2/§4.3): serialized activation,
//! activation-event matching, crash backoff circuit breaker, idle shutdown.
//!
//! Deliberately free of tauri types so the whole machine is testable without
//! an AppHandle: everything needed to (re)spawn a plugin process lives in
//! [`SpawnCtx`], which commands.rs (Task 8) builds from the app once at
//! registration time. The crash watcher can therefore restart autonomously.
//!
//! Supervision design notes (deviations/refinements over the plan draft):
//! - All phase transitions happen under the `phase` tokio Mutex, and both
//!   watchers re-verify `Arc::ptr_eq` against the process generation they
//!   supervise before acting — a stale watcher from a previous generation can
//!   never touch the current one.
//! - On a deliberate shutdown race (`shutting_down` set while the crash
//!   watcher already holds the phase lock), the watcher does NOT return
//!   immediately: it `continue`s and re-checks next tick. If the deliberate
//!   shutdown completed, the phase is no longer `Active(this proc)` and the
//!   watcher exits silently; if the shutdown was aborted (idle deactivation
//!   raced with fresh activity), the genuine crash is still recorded on the
//!   next tick instead of being lost.

use plugin_protocol as proto;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, Instant};

use super::process::{self, HostSink, PluginProcess};

/// Sliding crash window (spec §4.2): [`CRASH_LIMIT`] crashes within this
/// window trip the circuit breaker to `Disabled("crash-loop")`.
pub const CRASH_WINDOW: Duration = Duration::from_secs(10 * 60);
pub const CRASH_LIMIT: usize = 3;
/// Production restart backoff (spec §4.2); injectable per lifecycle for tests.
pub const DEFAULT_BACKOFF_SECS: [u64; 3] = [0, 5, 30];

// ── Activation events (spec §4.3) ───────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Trigger {
    Startup,
    Command(String),
    Cli(String),
    FileType(String),
}

/// spec §4.3 五类事件。trigger 形如 "startup" / "command:export" / "cli:pdf" / "filetype:.base"。
pub fn matches_activation(events: &[String], trigger: &Trigger) -> bool {
    events.iter().any(|ev| match (ev.as_str(), trigger) {
        ("*", _) => true,
        ("onStartupFinished", Trigger::Startup) => true,
        (e, Trigger::Command(c)) => e.strip_prefix("onCommand:") == Some(c.as_str()),
        (e, Trigger::Cli(s)) => e.strip_prefix("onCli:") == Some(s.as_str()),
        (e, Trigger::FileType(x)) => e.strip_prefix("onFileType:") == Some(x.as_str()),
        _ => false,
    })
}

impl Trigger {
    /// Event name delivered in the `$activate` params (spec §4.3/§4.4).
    pub fn event_name(&self) -> String {
        match self {
            Trigger::Startup => "onStartupFinished".into(),
            Trigger::Command(c) => format!("onCommand:{c}"),
            Trigger::Cli(s) => format!("onCli:{s}"),
            Trigger::FileType(x) => format!("onFileType:{x}"),
        }
    }
}

// ── Phase machine (spec §4.2) ───────────────────────────────────────────

/// Inactive → Activating → Active(process) → (deactivate) Inactive;
/// crash-loop breaker → Disabled(reason).
pub enum Phase {
    Inactive,
    /// Transitional; only observable if activation is ever restructured to
    /// release the phase lock mid-flight (today the lock is held throughout,
    /// which IS the per-plugin activation serialization of spec §4.2).
    Activating,
    Active(Arc<PluginProcess>),
    Disabled(String),
}

/// Inspectable snapshot of [`Phase`] (tests / future status UI).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhaseKind {
    Inactive,
    Activating,
    Active,
    Disabled(String),
}

/// Everything needed to (re)spawn the plugin process without an AppHandle.
pub struct SpawnCtx {
    /// Resolved current-arch binary path (discovery validated its existence).
    pub binary: PathBuf,
    /// Directory holding `<plugin_id>.log` (stderr capture + host.log.*).
    pub log_dir: PathBuf,
    /// plugin→host dispatch callback (host_api::make_sink product; Task 7).
    pub host_sink: HostSink,
    pub host_version: String,
    pub locale: String,
    /// `<app_data>` root. `data_dir = <app_data>/plugin_data/<id>` is only
    /// formatted into InitializeParams here — never created (spec §4.4).
    pub app_data: PathBuf,
}

pub struct PluginLifecycle {
    pub id: String,
    pub manifest: proto::ManifestV2,
    pub install_dir: PathBuf,
    pub ctx: SpawnCtx,
    /// Held across the whole activation ⇒ concurrent triggers for the same
    /// plugin serialize naturally (spec §4.2 activation queue semantics).
    pub phase: tokio::sync::Mutex<Phase>,
    /// Crash instants inside the sliding [`CRASH_WINDOW`].
    pub crash_times: std::sync::Mutex<Vec<Instant>>,
    /// Refreshed on every trigger/execute; drives idle shutdown.
    pub last_activity: std::sync::Mutex<Instant>,
    /// Deliberate shutdown in flight — the crash watcher must not misread the
    /// resulting process exit as a crash (spec §4.2).
    shutting_down: AtomicBool,
    /// 测试注入：崩溃重启退避（生产 [0,5,30] 秒）。
    pub backoff_secs: Vec<u64>,
    /// Crash watcher poll interval (production 500ms; injectable for tests).
    pub crash_poll: Duration,
    /// Idle watcher poll interval (production 5s; injectable for tests).
    pub idle_poll: Duration,
}

impl PluginLifecycle {
    pub fn new(manifest: proto::ManifestV2, install_dir: PathBuf, ctx: SpawnCtx) -> Self {
        Self {
            id: manifest.id.clone(),
            manifest,
            install_dir,
            ctx,
            phase: tokio::sync::Mutex::new(Phase::Inactive),
            crash_times: std::sync::Mutex::new(Vec::new()),
            last_activity: std::sync::Mutex::new(Instant::now()),
            shutting_down: AtomicBool::new(false),
            backoff_secs: DEFAULT_BACKOFF_SECS.to_vec(),
            crash_poll: Duration::from_millis(500),
            idle_poll: Duration::from_secs(5),
        }
    }

    /// Snapshot of the current phase. Note: activation holds the phase lock,
    /// so this waits out an in-flight activation.
    pub async fn phase_kind(&self) -> PhaseKind {
        match &*self.phase.lock().await {
            Phase::Inactive => PhaseKind::Inactive,
            Phase::Activating => PhaseKind::Activating,
            Phase::Active(_) => PhaseKind::Active,
            Phase::Disabled(r) => PhaseKind::Disabled(r.clone()),
        }
    }

    fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    /// Handshake params (spec §4.4). `theme` is empty: no ①期 consumer.
    /// `data_dir` is formatted only — creating it is the plugin's business.
    fn init_params(&self) -> proto::InitializeParams {
        proto::InitializeParams {
            protocol_version: proto::PROTOCOL_VERSION,
            host_version: self.ctx.host_version.clone(),
            locale: self.ctx.locale.clone(),
            theme: String::new(),
            plugin_root: self.install_dir.display().to_string(),
            data_dir: self
                .ctx
                .app_data
                .join("plugin_data")
                .join(&self.id)
                .display()
                .to_string(),
        }
    }

    /// Get the live process, activating lazily if needed (spec §4.2).
    /// Active → returns immediately (refreshing last_activity);
    /// Disabled → rejects with the recorded reason;
    /// Inactive → spawn + `$initialize`/`$activate` handshake + start the
    /// crash watcher and (if configured) the idle watcher.
    pub async fn ensure_active(
        self: &Arc<Self>,
        trigger: &Trigger,
    ) -> Result<Arc<PluginProcess>, String> {
        self.touch();
        let mut phase = self.phase.lock().await;
        match &*phase {
            Phase::Active(proc) => return Ok(proc.clone()),
            Phase::Disabled(reason) => {
                return Err(format!("plugin '{}' is disabled: {reason}", self.id));
            }
            Phase::Inactive | Phase::Activating => {}
        }
        *phase = Phase::Activating;
        let timeout = self
            .manifest
            .request_timeout_seconds
            .unwrap_or(process::DEFAULT_REQUEST_TIMEOUT);
        let activated = async {
            let proc = PluginProcess::spawn(
                &self.ctx.binary,
                &self.id,
                &self.ctx.log_dir,
                timeout,
                self.ctx.host_sink.clone(),
            )
            .await?;
            match process::initialize_and_activate(&proc, &self.init_params(), &trigger.event_name())
                .await
            {
                Ok(()) => Ok(proc),
                Err(e) => {
                    // Handshake failed: don't leave a half-started child
                    // around. shutdown() force-kills if $deactivate fails.
                    proc.shutdown().await;
                    Err(e)
                }
            }
        }
        .await;
        match activated {
            Ok(proc) => {
                *phase = Phase::Active(proc.clone());
                drop(phase);
                self.touch();
                self.spawn_crash_watcher(proc.clone());
                if let Some(n) = self.manifest.idle_shutdown_seconds {
                    self.spawn_idle_watcher(proc.clone(), Duration::from_secs(n));
                }
                Ok(proc)
            }
            Err(e) => {
                *phase = Phase::Inactive;
                Err(format!("plugin '{}' activation failed: {e}", self.id))
            }
        }
    }

    /// Execute a command on the ACTIVE process (callers `ensure_active` first;
    /// spec §4.2 lazy re-activation happens there, not here).
    pub async fn execute(&self, params: proto::ExecuteCommandParams) -> Result<Value, String> {
        self.touch();
        let proc = {
            let phase = self.phase.lock().await;
            match &*phase {
                Phase::Active(p) => p.clone(),
                Phase::Disabled(reason) => {
                    return Err(format!("plugin '{}' is disabled: {reason}", self.id));
                }
                _ => return Err(format!("plugin '{}' is not active", self.id)),
            }
        };
        let out = proc
            .request(
                "command.execute",
                serde_json::to_value(&params).map_err(|e| e.to_string())?,
            )
            .await;
        // A long-running command is activity too: don't idle-reap right after.
        self.touch();
        out
    }

    /// Deliberate shutdown (user-initiated / Task 8 teardown): `$deactivate`
    /// with grace, then Inactive. Flagged so the crash watcher ignores the
    /// resulting exit (spec §4.2: deactivate is not a crash).
    pub async fn deactivate(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        {
            let mut phase = self.phase.lock().await;
            if let Phase::Active(proc) = &*phase {
                let proc = proc.clone();
                proc.shutdown().await;
                *phase = Phase::Inactive;
            }
        }
        self.shutting_down.store(false, Ordering::SeqCst);
    }

    /// Idle-watcher variant of [`deactivate`]: re-verifies under the phase
    /// lock that `proc` is still current AND still idle (an execute may have
    /// raced in). Returns whether the process was actually shut down.
    async fn idle_deactivate(&self, proc: &Arc<PluginProcess>, idle_after: Duration) -> bool {
        self.shutting_down.store(true, Ordering::SeqCst);
        let deactivated = {
            let mut phase = self.phase.lock().await;
            let ours = matches!(&*phase, Phase::Active(p) if Arc::ptr_eq(p, proc));
            let still_idle = self.last_activity.lock().unwrap().elapsed() >= idle_after;
            if ours && still_idle {
                proc.shutdown().await;
                *phase = Phase::Inactive;
                true
            } else {
                false
            }
        };
        self.shutting_down.store(false, Ordering::SeqCst);
        deactivated
    }

    /// Crash supervision (spec §4.2): poll for unexpected exit; restart with
    /// backoff while < CRASH_LIMIT crashes in CRASH_WINDOW; then trip the
    /// breaker to `Disabled("crash-loop")`.
    fn spawn_crash_watcher(self: &Arc<Self>, proc: Arc<PluginProcess>) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(me.crash_poll).await;
                let Some(code) = proc.has_exited().await else {
                    continue;
                };
                // Decide under the phase lock whether this exit is a crash.
                let count;
                {
                    let mut phase = me.phase.lock().await;
                    if !matches!(&*phase, Phase::Active(p) if Arc::ptr_eq(p, &proc)) {
                        return; // superseded generation / already deactivated
                    }
                    if me.shutting_down.load(Ordering::SeqCst) {
                        // Deliberate shutdown in flight: re-check next tick
                        // (see module notes — never lose a real crash here).
                        continue;
                    }
                    // Genuine crash: record it inside the sliding window.
                    count = {
                        let mut ct = me.crash_times.lock().unwrap();
                        let now = Instant::now();
                        ct.retain(|t| now.duration_since(*t) < CRASH_WINDOW);
                        ct.push(now);
                        ct.len()
                    };
                    if count >= CRASH_LIMIT {
                        *phase = Phase::Disabled("crash-loop".into());
                        eprintln!(
                            "[plugin_runtime] plugin '{}' crashed {count}x within 10min (last exit code {code}) — disabled (crash-loop)",
                            me.id
                        );
                        process::append_plugin_log(
                            &me.ctx.log_dir,
                            &me.id,
                            "crash-loop",
                            &format!(
                                "{count} crashes within 10min (last exit code {code}) — plugin disabled"
                            ),
                        );
                        return;
                    }
                    *phase = Phase::Inactive;
                }
                eprintln!(
                    "[plugin_runtime] plugin '{}' crashed (exit code {code}); restart #{count}",
                    me.id
                );
                // Backoff then auto-restart (spec §4.2: [0,5,30]s ladder).
                let idx = (count - 1).min(me.backoff_secs.len().saturating_sub(1));
                let backoff = me.backoff_secs.get(idx).copied().unwrap_or(0);
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                if let Err(e) = me.ensure_active(&Trigger::Startup).await {
                    eprintln!("[plugin_runtime] restart of '{}' failed: {e}", me.id);
                }
                return; // a successful restart spawned its own watcher
            }
        });
    }

    /// Idle shutdown (spec §4.2): with `idle_shutdown_seconds = Some(n)`,
    /// deactivate after n seconds without activity; the next trigger
    /// re-activates lazily via [`ensure_active`].
    fn spawn_idle_watcher(self: &Arc<Self>, proc: Arc<PluginProcess>, idle_after: Duration) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(me.idle_poll).await;
                {
                    let phase = me.phase.lock().await;
                    if !matches!(&*phase, Phase::Active(p) if Arc::ptr_eq(p, &proc)) {
                        return; // superseded generation / already shut down
                    }
                }
                let idle_for = me.last_activity.lock().unwrap().elapsed();
                if idle_for >= idle_after && me.idle_deactivate(&proc, idle_after).await {
                    return;
                }
                // else: raced with fresh activity — keep watching.
            }
        });
    }
}

// ── Runtime registry + startup activation ───────────────────────────────

/// Live per-plugin lifecycles, id → lifecycle. commands.rs (Task 8)
/// populates this from `STATE.plugins` at init.
pub static RUNNING: LazyLock<RwLock<HashMap<String, Arc<PluginLifecycle>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Eagerly activate every plugin whose activation events match `Startup`
/// (`*` / `onStartupFinished`, spec §4.3). Fire-and-forget: failures are
/// logged, never fatal. Task 8 wires this to STATE after discovery.
pub fn startup_activation(lifecycles: Vec<Arc<PluginLifecycle>>) {
    for lc in lifecycles {
        if matches_activation(&lc.manifest.activation.events, &Trigger::Startup) {
            tokio::spawn(async move {
                if let Err(e) = lc.ensure_active(&Trigger::Startup).await {
                    eprintln!(
                        "[plugin_runtime] startup activation of '{}' failed: {e}",
                        lc.id
                    );
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn matches_activation_full_matrix() {
        let star = ev(&["*"]);
        let startup = ev(&["onStartupFinished"]);
        let command = ev(&["onCommand:export"]);
        let cli = ev(&["onCli:pdf"]);
        let filetype = ev(&["onFileType:.base"]);
        let all_triggers = [
            Trigger::Startup,
            Trigger::Command("export".into()),
            Trigger::Cli("pdf".into()),
            Trigger::FileType(".base".into()),
        ];

        // `*` matches every trigger.
        for t in &all_triggers {
            assert!(matches_activation(&star, t), "* should match {t:?}");
        }
        // Each specific event matches exactly its own trigger…
        assert!(matches_activation(&startup, &Trigger::Startup));
        assert!(matches_activation(&command, &Trigger::Command("export".into())));
        assert!(matches_activation(&cli, &Trigger::Cli("pdf".into())));
        assert!(matches_activation(&filetype, &Trigger::FileType(".base".into())));
        // …and nothing else.
        for (events, own) in [(&startup, 0usize), (&command, 1), (&cli, 2), (&filetype, 3)] {
            for (i, t) in all_triggers.iter().enumerate() {
                if i != own {
                    assert!(!matches_activation(events, t), "{events:?} vs {t:?}");
                }
            }
        }
        // Wrong payloads don't match.
        assert!(!matches_activation(&command, &Trigger::Command("other".into())));
        assert!(!matches_activation(&cli, &Trigger::Cli("other".into())));
        assert!(!matches_activation(&filetype, &Trigger::FileType(".md".into())));
        // Empty events match nothing; multi-event lists match any-of.
        assert!(!matches_activation(&[], &Trigger::Startup));
        let multi = ev(&["onCommand:a", "onCli:b"]);
        assert!(matches_activation(&multi, &Trigger::Cli("b".into())));
        assert!(!matches_activation(&multi, &Trigger::Startup));
    }

    #[test]
    fn trigger_event_names() {
        assert_eq!(Trigger::Startup.event_name(), "onStartupFinished");
        assert_eq!(Trigger::Command("export".into()).event_name(), "onCommand:export");
        assert_eq!(Trigger::Cli("pdf".into()).event_name(), "onCli:pdf");
        assert_eq!(Trigger::FileType(".base".into()).event_name(), "onFileType:.base");
    }

    #[test]
    fn init_params_formats_paths_without_creating_them() {
        let manifest: proto::ManifestV2 = serde_json::from_value(serde_json::json!({
            "manifest_version": 2,
            "id": "test.plugin",
            "name": "Test",
            "version": "1.0.0",
            "kind": "native",
            "engines": { "notemd": ">=0.0.0" },
            "activation": { "events": ["*"] },
            "capabilities": []
        }))
        .unwrap();
        let ctx = SpawnCtx {
            binary: PathBuf::from("/nonexistent/bin"),
            log_dir: PathBuf::from("/nonexistent/logs"),
            host_sink: Arc::new(|_| None),
            host_version: "6.716.7".into(),
            locale: "zh-CN".into(),
            app_data: PathBuf::from("/appdata"),
        };
        let lc = PluginLifecycle::new(manifest, PathBuf::from("/plugins/test.plugin/current"), ctx);
        let p = lc.init_params();
        assert_eq!(p.protocol_version, proto::PROTOCOL_VERSION);
        assert_eq!(p.host_version, "6.716.7");
        assert_eq!(p.locale, "zh-CN");
        assert_eq!(p.theme, "");
        assert_eq!(p.plugin_root, "/plugins/test.plugin/current");
        assert_eq!(p.data_dir, "/appdata/plugin_data/test.plugin");
        assert!(!std::path::Path::new(&p.data_dir).exists(), "data_dir must not be created");
    }
}
