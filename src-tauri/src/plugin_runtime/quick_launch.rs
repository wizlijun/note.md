//! Local, user-configured launch actions shared by the tray and Quick Launch UI.
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::io::{AsyncRead, AsyncReadExt};

pub const PLUGIN_ID: &str = "notemd.quick-launch";
const CAPABILITY: &str = "quick-launch";
const MAX_CONFIG: u64 = 128 * 1024;
const MAX_OUTPUT: usize = 16 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);
static CONFIG_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    App,
    Cli,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub target: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub entries: Vec<Entry>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            entries: vec![
                Entry {
                    id: "cmd1".into(),
                    name: "屏幕重连".into(),
                    kind: Kind::Cli,
                    target: "uc reconnect".into(),
                    enabled: true,
                },
                Entry {
                    id: "cmd2".into(),
                    name: "command2".into(),
                    kind: Kind::Cli,
                    target: String::new(),
                    enabled: false,
                },
            ],
        }
    }
}

fn validate(config: &Config) -> Result<(), String> {
    if config.entries.len() > 20 {
        return Err("最多可保存 20 个启动项".into());
    }
    let mut ids = HashSet::new();
    for entry in &config.entries {
        if entry.id.is_empty()
            || entry.id.len() > 64
            || !entry
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || !ids.insert(&entry.id)
        {
            return Err("启动项 ID 无效或重复".into());
        }
        if entry.name.len() > 240 || entry.name.chars().any(char::is_control) {
            return Err("名称过长或含控制字符".into());
        }
        if entry.target.len() > 8192 || entry.target.contains('\0') {
            return Err("启动目标过长或含无效字符".into());
        }
        if entry.enabled && (entry.name.trim().is_empty() || entry.target.trim().is_empty()) {
            return Err("启用的启动项必须填写名称与启动目标".into());
        }
        if entry.kind == Kind::App
            && !entry.target.is_empty()
            && (entry.target.chars().any(char::is_control)
                || entry.target.starts_with('-')
                || (entry.target.contains('/') && !Path::new(&entry.target).is_absolute()))
        {
            return Err("应用请填写名称或绝对路径".into());
        }
    }
    Ok(())
}

fn path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|root| root.join("quick-launch.json"))
        .map_err(|e| format!("无法取得本机配置目录：{e}"))
}

fn load_at(path: &Path) -> Result<Config, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(error) => return Err(format!("无法读取快捷启动配置：{error}")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("无法读取快捷启动配置：{e}"))?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err("快捷启动配置过大".into());
    }
    let config: Config =
        serde_json::from_slice(&bytes).map_err(|_| "快捷启动配置损坏，请修正配置后重试")?;
    validate(&config)?;
    Ok(config)
}

fn save_at(path: &Path, config: &Config) -> Result<(), String> {
    validate(config)?;
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err("快捷启动配置过大".into());
    }
    let parent = path.parent().ok_or("配置目录无效")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录：{e}"))?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("无法保存配置：{e}"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|e| format!("无法保存配置：{e}"))?;
    temporary
        .persist(path)
        .map_err(|e| format!("无法替换配置：{e}"))?;
    Ok(())
}

fn enabled_in(state: &super::RuntimeState) -> bool {
    state
        .plugins
        .get(PLUGIN_ID)
        .is_some_and(|(manifest, _)| manifest.capabilities.iter().any(|cap| cap == CAPABILITY))
}

pub fn enabled() -> bool {
    super::STATE
        .read()
        .map(|state| enabled_in(&state))
        .unwrap_or(false)
}

pub fn load<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Config, String> {
    let _lock = CONFIG_LOCK.lock().map_err(|_| "快捷启动配置暂不可用")?;
    load_at(&path(app)?)
}

fn check_request(plugin_id: &str, method: &str, params: &Value) -> Result<(), String> {
    if plugin_id != PLUGIN_ID {
        return Err("此接口仅供快捷启动插件使用".into());
    }
    let fields = params.as_object().ok_or("请求必须为对象")?;
    match method {
        "host.quickLaunch.get" if fields.is_empty() => Ok(()),
        "host.quickLaunch.save" if fields.len() == 1 && fields.contains_key("entries") => Ok(()),
        "host.quickLaunch.run"
            if fields.len() == 1 && fields.get("id").and_then(Value::as_str).is_some() =>
        {
            Ok(())
        }
        _ => Err("不支持的快捷启动请求或参数".into()),
    }
}

pub async fn dispatch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_id: &str,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    check_request(plugin_id, method, params)?;
    if !enabled() {
        return Err("快捷启动插件未启用或缺少授权".into());
    }
    match method {
        "host.quickLaunch.get" => serde_json::to_value(load(app)?).map_err(|e| e.to_string()),
        "host.quickLaunch.save" => {
            let config: Config =
                serde_json::from_value(params.clone()).map_err(|_| "启动项配置格式无效")?;
            {
                let _lock = CONFIG_LOCK.lock().map_err(|_| "快捷启动配置暂不可用")?;
                save_at(&path(app)?, &config)?;
            }
            crate::notifications::DIRTY.notify_one();
            serde_json::to_value(config).map_err(|e| e.to_string())
        }
        "host.quickLaunch.run" => run(app, params["id"].as_str().ok_or("缺少启动项 ID")?).await,
        _ => Err("不支持的快捷启动请求".into()),
    }
}

struct RunningGuard(String);
impl RunningGuard {
    fn acquire(id: &str) -> Result<Self, String> {
        if !RUNNING
            .lock()
            .map_err(|_| "执行状态暂不可用")?
            .insert(id.to_owned())
        {
            return Err("此启动项正在执行，请等待完成".into());
        }
        Ok(Self(id.to_owned()))
    }
}
impl Drop for RunningGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING.lock() {
            running.remove(&self.0);
        }
    }
}

fn active_entry(config: &Config, id: &str) -> Result<Entry, String> {
    validate(config)?;
    config
        .entries
        .iter()
        .find(|entry| entry.id == id && entry.enabled)
        .cloned()
        .ok_or_else(|| "启动项已删除或停用，请刷新后重试".into())
}

pub async fn run<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) -> Result<Value, String> {
    if !enabled() {
        return Err("快捷启动插件未启用或缺少授权".into());
    }
    let _running = RunningGuard::acquire(id)?;
    let entry = active_entry(&load(app)?, id)?;
    let command = launch_command(&entry)?;
    execute(command, TIMEOUT).await
}

fn app_command(target: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("/usr/bin/open");
    command.arg("-a").arg(target);
    command
}

fn launch_command(entry: &Entry) -> Result<tokio::process::Command, String> {
    if !cfg!(target_os = "macos") {
        return Err("快捷启动目前仅支持 macOS".into());
    }
    let home = dirs::home_dir().ok_or("无法取得用户主目录")?;
    let mut command = match entry.kind {
        Kind::App => app_command(&entry.target),
        Kind::Cli => {
            let shell = std::env::var_os("SHELL")
                .filter(|value| Path::new(value).is_absolute())
                .unwrap_or_else(|| "/bin/zsh".into());
            cli_command(Path::new(&shell), &home, &entry.target)?
        }
    };
    command.current_dir(home);
    Ok(command)
}

fn cli_command(shell: &Path, home: &Path, target: &str) -> Result<tokio::process::Command, String> {
    // Login startup files may replace PATH. Append the fallback *after* they run;
    // paths travel through an environment value rather than shell interpolation.
    let prefix = match shell.file_name().and_then(|name| name.to_str()) {
        Some("fish") => "set -gx PATH $PATH (string split : -- $NOTEMD_QUICK_LAUNCH_PATH); set -e NOTEMD_QUICK_LAUNCH_PATH;\n",
        Some("zsh" | "bash" | "sh" | "dash" | "ksh") => "export PATH=\"$PATH:$NOTEMD_QUICK_LAUNCH_PATH\"; unset NOTEMD_QUICK_LAUNCH_PATH;\n",
        _ => return Err("当前登录 shell 暂不支持；请使用 zsh、bash、sh 或 fish".into()),
    };
    let paths = [
        home.join(".local/bin"),
        home.join("bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    let mut command = tokio::process::Command::new(shell);
    command.arg("-lc").arg(format!("{prefix}{target}")).env(
        "NOTEMD_QUICK_LAUNCH_PATH",
        std::env::join_paths(paths).map_err(|_| "无法构造命令搜索路径")?,
    );
    Ok(command)
}

async fn drain(mut reader: impl AsyncRead + Unpin) -> std::io::Result<String> {
    let mut saved = Vec::new();
    let mut buffer = [0_u8; 4096];
    let mut truncated = false;
    loop {
        let length = reader.read(&mut buffer).await?;
        if length == 0 {
            break;
        }
        let keep = length.min(MAX_OUTPUT.saturating_sub(saved.len()));
        saved.extend_from_slice(&buffer[..keep]);
        truncated |= keep < length;
    }
    let mut result = String::from_utf8_lossy(&saved).into_owned();
    if truncated {
        result.push_str("\n[输出已截断]");
    }
    Ok(result)
}

// A new process group keeps command children inside the timeout/cancellation boundary.
struct ProcessGroup(Option<u32>);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            // SAFETY: the pid is from our just-spawned child, which leads its own group.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

async fn execute(mut command: tokio::process::Command, timeout: Duration) -> Result<Value, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("无法启动：{e}"))?;
    let mut group = ProcessGroup(child.id());
    let stdout = child.stdout.take().ok_or("无法读取命令输出")?;
    let stderr = child.stderr.take().ok_or("无法读取命令错误")?;
    let result = tokio::time::timeout(timeout, async {
        tokio::join!(child.wait(), drain(stdout), drain(stderr))
    })
    .await;
    let (status, stdout, stderr) = match result {
        Ok(result) => {
            group.0 = None;
            result
        }
        Err(_) => {
            drop(group);
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(format!("执行超时（{} 秒），已停止命令", timeout.as_secs()));
        }
    };
    let status = status.map_err(|e| format!("无法取得执行结果：{e}"))?;
    let stdout = stdout.map_err(|e| format!("读取命令输出失败：{e}"))?;
    let stderr = stderr.map_err(|e| format!("读取命令错误失败：{e}"))?;
    if !status.success() {
        let detail = if stderr.trim().is_empty() {
            &stdout
        } else {
            &stderr
        };
        return Err(format!(
            "命令失败（退出码 {}）：{}",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "信号终止".into()),
            detail.trim()
        ));
    }
    Ok(json!({"ok":true,"exitCode":status.code(),"stdout":stdout,"stderr":stderr}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_persistence_and_empty_config() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut config = load_at(&path).unwrap();
        assert_eq!(config.entries[0].target, "uc reconnect");
        assert!(!config.entries[1].enabled);
        config.entries.reverse();
        save_at(&path, &config).unwrap();
        assert_eq!(load_at(&path).unwrap(), config);
        config.entries.clear();
        save_at(&path, &config).unwrap();
        assert!(load_at(&path).unwrap().entries.is_empty());
    }

    #[test]
    fn invalid_config_never_resets_or_overwrites_saved_config() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        save_at(&path, &Config::default()).unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut config = Config::default();
        config.entries[1].id = "cmd1".into();
        assert!(save_at(&path, &config).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(&path, "{broken").unwrap();
        assert!(load_at(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{broken");
        assert!(save_at(directory.path(), &Config::default()).is_err());
    }

    #[test]
    fn validates_names_targets_ids_and_bounds() {
        for id in ["", "../escape", "a:b", "a b"] {
            let mut config = Config::default();
            config.entries[0].id = id.into();
            assert!(validate(&config).is_err());
        }
        let mut config = Config::default();
        config.entries[0].target.clear();
        assert!(validate(&config).is_err());
        config.entries[0].enabled = false;
        assert!(validate(&config).is_ok());
        config.entries[0].name = "a\nb".into();
        assert!(validate(&config).is_err());
        assert!(serde_json::from_value::<Config>(
            json!({"entries":[{"id":"a","name":"a","kind":"unknown","target":"a","enabled":true}]})
        )
        .is_err());
        let mut config = Config::default();
        config.entries[0].kind = Kind::App;
        for target in ["../App.app", "--args", "a\nb"] {
            config.entries[0].target = target.into();
            assert!(validate(&config).is_err());
        }
        config.entries[0].target = "/Applications/My App.app".into();
        assert!(validate(&config).is_ok());
    }

    #[test]
    fn stale_actions_and_foreign_requests_are_rejected() {
        let config = Config::default();
        assert!(active_entry(&config, "cmd2").is_err());
        assert!(active_entry(&config, "deleted").is_err());
        assert!(check_request("other.plugin", "host.quickLaunch.get", &json!({})).is_err());
        assert!(check_request(
            PLUGIN_ID,
            "host.quickLaunch.run",
            &json!({"id":"cmd1","command":"bad"})
        )
        .is_err());
        assert!(check_request(PLUGIN_ID, "host.quickLaunch.get", &json!({})).is_ok());
    }

    #[test]
    fn enabled_requires_current_installed_manifest_and_execution_capability() {
        let mut state = super::super::RuntimeState {
            plugins: Default::default(),
        };
        assert!(!enabled_in(&state));
        let manifest: plugin_protocol::ManifestV2 = serde_json::from_value(json!({
            "manifest_version":2,"id":PLUGIN_ID,"name":"Quick Launch","version":"1.0.0",
            "kind":"native","engines":{"notemd":">=6.1030.1"},
            "activation":{"events":["onCommand:open"]},"capabilities":[]
        }))
        .unwrap();
        state
            .plugins
            .insert(PLUGIN_ID.into(), (manifest, PathBuf::new()));
        assert!(!enabled_in(&state));
        state
            .plugins
            .get_mut(PLUGIN_ID)
            .unwrap()
            .0
            .capabilities
            .push(CAPABILITY.into());
        assert!(enabled_in(&state));
        state.plugins.remove(PLUGIN_ID);
        assert!(!enabled_in(&state));
    }

    #[test]
    fn excessive_config_and_unknown_fields_are_rejected() {
        let mut config = Config::default();
        config.entries = (0..21)
            .map(|index| Entry {
                id: format!("cmd{index}"),
                name: "fixture".into(),
                kind: Kind::Cli,
                target: "true".into(),
                enabled: true,
            })
            .collect();
        assert!(validate(&config).is_err());
        config = Config::default();
        config.entries[0].target = "x".repeat(8193);
        assert!(validate(&config).is_err());
        config.entries[0].target = "x\0y".into();
        assert!(validate(&config).is_err());
        assert!(serde_json::from_value::<Config>(json!({"entries":[],"extra":true})).is_err());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oversized.json");
        std::fs::write(&path, vec![b' '; MAX_CONFIG as usize + 1]).unwrap();
        assert!(load_at(&path).is_err());
    }

    #[test]
    fn duplicate_running_actions_are_rejected_and_released() {
        let guard = RunningGuard::acquire("fixture-running").unwrap();
        assert!(RunningGuard::acquire("fixture-running").is_err());
        assert!(RunningGuard::acquire("fixture-other").is_ok());
        drop(guard);
        assert!(RunningGuard::acquire("fixture-running").is_ok());
    }

    #[test]
    fn app_targets_are_a_single_argument_and_never_shell_code() {
        let target = "/Applications/My App $(touch forbidden).app";
        let command = app_command(target);
        assert_eq!(command.as_std().get_program(), "/usr/bin/open");
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            ["-a", target]
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn login_shell_keeps_profile_path_and_appends_common_bins_after_startup() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path();
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        std::fs::write(home.join(".zprofile"), "export PATH=/usr/bin:/bin\n").unwrap();
        let binary = home.join(".local/bin/quick-launch-path-fixture");
        std::fs::write(&binary, "#!/bin/sh\nprintf fixture-found\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = cli_command(
            Path::new("/bin/zsh"),
            home,
            "quick-launch-path-fixture; printf '\n%s' \"$PATH\"",
        )
        .unwrap();
        command.env("ZDOTDIR", home).env("PATH", "/bin");
        let result = execute(command, Duration::from_secs(2)).await.unwrap();
        let output = result["stdout"].as_str().unwrap();
        assert!(output.starts_with("fixture-found\n"));
        assert!(output.contains("/opt/homebrew/bin"));
        assert!(output.contains("/usr/local/bin"));
        assert!(output.contains(home.join(".local/bin").to_str().unwrap()));
    }

    #[cfg(unix)]
    fn shell(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_success_failure_and_spawn_failure() {
        let result = execute(
            shell("printf hello; printf warning >&2"),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert_eq!(result["stdout"], "hello");
        assert_eq!(result["stderr"], "warning");
        assert_eq!(result["exitCode"], 0);
        let error = execute(shell("printf failed >&2; exit 7"), Duration::from_secs(2))
            .await
            .unwrap_err();
        assert!(error.contains('7') && error.contains("failed"));
        assert!(execute(
            tokio::process::Command::new("/nonexistent/quick-launch-test"),
            Duration::from_secs(2)
        )
        .await
        .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn drains_large_output_without_blocking_and_retains_a_bound() {
        let result = execute(
            shell("head -c 100000 /dev/zero; head -c 100000 /dev/zero >&2"),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        for field in ["stdout", "stderr"] {
            let output = result[field].as_str().unwrap();
            assert!(output.contains("输出已截断"));
            assert!(output.len() < MAX_OUTPUT + 100);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_descendants_and_covers_inherited_output_pipes() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("should-not-exist");
        let mut command = shell("(sleep 0.3; printf leaked > \"$1\") & wait");
        command.arg("test").arg(&marker);
        let error = execute(command, Duration::from_millis(60))
            .await
            .unwrap_err();
        assert!(error.contains("超时"));
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!marker.exists());
        assert!(
            execute(shell("sleep 10 & exit 0"), Duration::from_millis(60))
                .await
                .unwrap_err()
                .contains("超时")
        );
    }
}
