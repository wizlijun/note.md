//! Agency's resident SDK transport and its private, headless provider transport.
//! The latter only hosts an installed Agent; it is not a general plugin host.
use notemd_plugin_sdk as sdk;
use sdk::plugin_protocol as proto;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

const TASK_ID: &str = "agency-observe-v1";
const PROVIDERS: [&str; 3] = [
    "notemd.codex-agent",
    "notemd.claude-agent",
    "notemd.deepseek-agent",
];

#[derive(Clone)]
pub struct AgencyHost(Transport);

#[derive(Clone)]
enum Transport {
    Sdk(sdk::Host),
    Standalone(Arc<Standalone>),
}

impl From<sdk::Host> for AgencyHost {
    fn from(host: sdk::Host) -> Self {
        Self(Transport::Sdk(host))
    }
}

impl AgencyHost {
    /// No provider is started until a request actually needs one. Cache hits and
    /// dates without usable sources therefore do not require a harness login.
    pub async fn standalone(root: &Path, harness: &str) -> Result<Self, String> {
        if !PROVIDERS.contains(&harness) {
            return Err("不支持的 Agent provider".into());
        }
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        if !root.is_dir() {
            return Err("Vault 不是目录".into());
        }
        Ok(Self(Transport::Standalone(Arc::new(Standalone {
            root,
            harness: harness.into(),
            client: Mutex::new(None),
            closed: AtomicBool::new(false),
        }))))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        match &self.0 {
            Transport::Sdk(host) => host.request(method, params).await,
            Transport::Standalone(host) => host.request(method, params).await,
        }
    }

    pub fn ui_post(&self, window: &str, value: Value) {
        if let Transport::Sdk(host) = &self.0 {
            host.ui_post(window, value);
        }
    }

    pub async fn close(&self) {
        if let Transport::Standalone(host) = &self.0 {
            host.closed.store(true, Ordering::Release);
            if let Some(client) = host.client.lock().await.take() {
                client.close().await;
            }
        }
    }
}

struct Standalone {
    root: PathBuf,
    harness: String,
    client: Mutex<Option<Arc<ProviderClient>>>,
    closed: AtomicBool,
}

impl Standalone {
    async fn client(&self) -> Result<Arc<ProviderClient>, String> {
        let mut slot = self.client.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err("Agency 后台连接已关闭".into());
        }
        if let Some(client) = slot.as_ref() {
            return Ok(client.clone());
        }
        let installation = resolve_installation(&plugins_root()?, &self.harness)?;
        let client = ProviderClient::spawn(&installation, &self.root).await?;
        *slot = Some(client.clone());
        Ok(client)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        // Validate the route BEFORE starting a process. No generic execute,
        // editor, filesystem, notification, or arbitrary task surface exists.
        let command = match method {
            "host.agent.providers" => "harness-status",
            "host.agent.run" | "host.agent.status" => {
                if params.get("harness").and_then(Value::as_str) != Some(&self.harness)
                    || params.get("task").and_then(Value::as_str) != Some(TASK_ID)
                {
                    return Err("后台调用必须绑定所选 provider 和 Agency 任务".into());
                }
                if method == "host.agent.run" {
                    "run-task"
                } else {
                    "run-status"
                }
            }
            _ => return Err("Agency 后台连接不支持此宿主方法".into()),
        };
        let client = self.client().await?;
        let result = client.execute(command, params).await?;
        if method == "host.agent.providers" {
            Ok(json!({"providers":[{
                "id": self.harness, "name": client.name, "harness": result
            }],"default":self.harness}))
        } else {
            Ok(result)
        }
    }
}

struct Installation {
    id: String,
    name: String,
    directory: PathBuf,
    binary: PathBuf,
    app_data: PathBuf,
    quiet_timeout: Duration,
}

fn plugins_root() -> Result<PathBuf, String> {
    // Installed layout: plugins/<id>/<version>/bin/<binary>. Resolve current/
    // once so a simultaneous installation cannot change this run's executable.
    if let Ok(exe) = std::env::current_exe().and_then(|p| p.canonicalize()) {
        if let Some(id_dir) = exe.parent().and_then(Path::parent).and_then(Path::parent) {
            if id_dir.file_name().and_then(|s| s.to_str()) == Some("notemd.agency") {
                if let Some(root) = id_dir.parent() {
                    return Ok(root.to_path_buf());
                }
            }
        }
    }
    let home = std::env::var_os("HOME").ok_or("无法定位插件安装目录")?;
    Ok(PathBuf::from(home).join("Library/Application Support/net.notemd.app/plugins"))
}

fn resolve_installation(root: &Path, harness: &str) -> Result<Installation, String> {
    if !PROVIDERS.contains(&harness) {
        return Err("不支持的 Agent provider".into());
    }
    let state: Value = serde_json::from_slice(
        &std::fs::read(root.join("state.json")).map_err(|_| "无法读取插件安装状态")?,
    )
    .map_err(|_| "插件安装状态损坏")?;
    let installed = state
        .get("installed")
        .and_then(|v| v.get(harness))
        .ok_or("所选 Agent 尚未安装")?;
    if installed.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Err("所选 Agent 尚未启用".into());
    }
    let plugin_dir = root
        .join(harness)
        .canonicalize()
        .map_err(|_| "Agent 安装目录缺失")?;
    let directory = plugin_dir
        .join("current")
        .canonicalize()
        .map_err(|_| "Agent 当前版本缺失")?;
    if !directory.starts_with(&plugin_dir) || directory == plugin_dir {
        return Err("Agent 当前版本指向安装目录之外".into());
    }
    let manifest: proto::ManifestV2 = serde_json::from_slice(
        &std::fs::read(directory.join("manifest.json")).map_err(|_| "Agent manifest 缺失")?,
    )
    .map_err(|_| "Agent manifest 损坏")?;
    if manifest.manifest_version != 2
        || manifest.id != harness
        || manifest.kind != proto::PluginKind::Native
        || installed.get("version").and_then(Value::as_str) != Some(manifest.version.as_str())
    {
        return Err("Agent manifest 与安装状态不一致".into());
    }
    if let Ok(host_version) = std::env::var("NOTEMD_AGENCY_HOST_VERSION") {
        // The parent native host may supply its real version. The direct
        // standalone adapter otherwise relies on protocol/capability checks;
        // it must not fabricate a desktop version to satisfy engines.notemd.
        proto::validate_manifest(&manifest, &host_version)
            .map_err(|_| "Agent manifest 不兼容当前宿主")?;
    }
    for command in ["harness-status", "run-task", "run-status"] {
        let event = format!("onCommand:{command}");
        if !manifest
            .activation
            .events
            .iter()
            .any(|v| v == &event || v == "*")
        {
            return Err("Agent 未声明所需命令".into());
        }
    }
    let arch = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        _ => return Err("Agency 后台连接暂仅支持 macOS".into()),
    };
    let relative = manifest
        .binary
        .get(arch)
        .ok_or("Agent 缺少当前架构二进制")?;
    if relative.is_empty()
        || !Path::new(relative)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("Agent 二进制路径无效".into());
    }
    let binary = directory
        .join(relative)
        .canonicalize()
        .map_err(|_| "Agent 二进制不存在")?;
    if !binary.starts_with(&directory) || !binary.is_file() {
        return Err("Agent 二进制不在安装目录内".into());
    }
    Ok(Installation {
        id: manifest.id,
        name: manifest.name,
        directory,
        binary,
        app_data: root.parent().ok_or("插件目录无效")?.to_path_buf(),
        quiet_timeout: Duration::from_secs(
            manifest.request_timeout_seconds.unwrap_or(30).clamp(1, 300),
        ),
    })
}

struct RpcState {
    stdin: Mutex<ChildStdin>,
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    last_output: StdMutex<Instant>,
    closed: AtomicBool,
    quiet_timeout: Duration,
}

impl RpcState {
    async fn write(&self, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| "RPC 编码失败")?;
        bytes.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|_| "Agent 连接写入失败")?;
        stdin
            .flush()
            .await
            .map_err(|_| "Agent 连接刷新失败".to_string())
    }

    fn fail_pending(&self) {
        self.closed.store(true, Ordering::Release);
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err("Agent 连接关闭，未取得完整结果".into()));
        }
    }

    async fn request(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("Agent 连接已关闭".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let _remove_on_cancel = PendingRequest {
            state: self.clone(),
            id,
        };
        if self.closed.load(Ordering::Acquire) {
            return Err("Agent 连接已关闭".into());
        }
        self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let sent = Instant::now();
        loop {
            let last = (*self.last_output.lock().unwrap()).max(sent);
            let left = self.quiet_timeout.saturating_sub(last.elapsed());
            if left.is_zero() {
                return Err("Agent 持续无响应，后台连接超时".into());
            }
            match tokio::time::timeout(left, &mut rx).await {
                Ok(Ok(result)) => return result,
                Ok(Err(_)) => return Err("Agent 响应通道关闭".into()),
                Err(_) => continue,
            }
        }
    }
}

struct PendingRequest {
    state: Arc<RpcState>,
    id: u64,
}
impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.state.pending.lock().unwrap().remove(&self.id);
    }
}

struct ProviderClient {
    name: String,
    rpc: Arc<RpcState>,
    child: Mutex<Child>,
    reader: tokio::task::JoinHandle<()>,
    stderr: tokio::task::JoinHandle<()>,
    // Keep the pinned Vault alive for the whole provider lifetime. Its startup
    // synchronously reads this file before asking host.vault.info.
    _shared_config: tempfile::NamedTempFile,
}

impl ProviderClient {
    async fn spawn(installation: &Installation, root: &Path) -> Result<Arc<Self>, String> {
        use std::io::Write;
        let mut config = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut config, &json!({"sotvault":root})).map_err(|e| e.to_string())?;
        config.flush().map_err(|e| e.to_string())?;
        let mut command = tokio::process::Command::new(&installation.binary);
        command.env_clear();
        for key in ["HOME", "PATH", "LANG", "LC_ALL", "TERM", "USER", "TMPDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .env("NOTEMD_SHARED_CONFIG", config.path())
            .current_dir(&installation.directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动 Agent provider：{e}"))?;
        let stdout = child.stdout.take().ok_or("Agent stdout 不可用")?;
        let mut stderr = child.stderr.take().ok_or("Agent stderr 不可用")?;
        let rpc = Arc::new(RpcState {
            stdin: Mutex::new(child.stdin.take().ok_or("Agent stdin 不可用")?),
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            last_output: StdMutex::new(Instant::now()),
            closed: AtomicBool::new(false),
            quiet_timeout: installation.quiet_timeout,
        });
        let reader_rpc = rpc.clone();
        let vault = root.to_path_buf();
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                *reader_rpc.last_output.lock().unwrap() = Instant::now();
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    // Notifications do not block. Never print their payloads:
                    // Agent progress and logs may contain private source text.
                    if let Some(id) = message.get("id").filter(|v| !v.is_null()) {
                        let reply = if method == "host.vault.info" {
                            json!({"jsonrpc":"2.0","id":id,"result":{"root":vault}})
                        } else {
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Agency background host does not authorize this method"}})
                        };
                        if reader_rpc.write(&reply).await.is_err() {
                            break;
                        }
                    }
                } else if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = reader_rpc.pending.lock().unwrap().remove(&id) {
                        let result = if let Some(error) =
                            message.get("error").filter(|e| !e.is_null())
                        {
                            let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32000);
                            Err(format!("Agent provider 请求失败（RPC {code}）"))
                        } else {
                            message
                                .get("result")
                                .cloned()
                                .ok_or_else(|| "Agent 返回空 RPC 响应".into())
                        };
                        let _ = tx.send(result);
                    }
                }
            }
            reader_rpc.fail_pending();
        });
        let stderr = tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
        let client = Arc::new(Self {
            name: installation.name.clone(),
            rpc,
            child: Mutex::new(child),
            reader,
            stderr,
            _shared_config: config,
        });
        let handshake = async {
            client.rpc.request("$initialize", json!({
                "protocol_version":proto::PROTOCOL_VERSION,
                "host_version":std::env::var("NOTEMD_AGENCY_HOST_VERSION").unwrap_or_else(|_| "0.0.0".into()),
                "locale":"zh", "theme":"",
                "plugin_root":installation.directory,
                "data_dir":installation.app_data.join("plugin_data").join(&installation.id)
            })).await?;
            client.rpc.request("$activate", json!({"event":"onCommand:run-task"})).await?;
            Ok::<_, String>(())
        }.await;
        if let Err(error) = handshake {
            client.close().await;
            return Err(error);
        }
        Ok(client)
    }

    async fn execute(&self, command: &str, context: Value) -> Result<Value, String> {
        self.rpc
            .request(
                "command.execute",
                json!({"command":command,"context":context}),
            )
            .await
    }

    async fn close(&self) {
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            self.rpc.request("$deactivate", json!({})),
        )
        .await;
        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.rpc.fail_pending();
        self.reader.abort();
        self.stderr.abort();
    }
}

impl Drop for ProviderClient {
    fn drop(&mut self) {
        self.rpc.fail_pending();
        self.reader.abort();
        self.stderr.abort();
        // Child's kill_on_drop handles abandonment; normal callers use close()
        // so the provider can cancel its harness process groups first.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const FAKE_PROVIDER: &str = r#"#!/usr/bin/env python3
import json, os, sys, time
def send(value):
    print(json.dumps(value), flush=True)
def reply(request, result):
    send({'jsonrpc':'2.0','id':request['id'],'result':result})
for raw in sys.stdin:
    request = json.loads(raw)
    method = request['method']
    if method == '$initialize':
        assert request['params']['protocol_version'] == 2
        assert os.path.isdir(request['params']['plugin_root'])
        with open(os.environ['NOTEMD_SHARED_CONFIG']) as file:
            vault = json.load(file)['sotvault']
        assert os.path.isdir(vault)
        reply(request, {'ok':True})
    elif method == '$activate':
        # Demand host responses before activation can finish: a reader that
        # waits for the original reply before handling callbacks deadlocks.
        send({'jsonrpc':'2.0','id':800,'method':'host.vault.info','params':{}})
        response = json.loads(sys.stdin.readline())
        assert response['id'] == 800 and response['result']['root'] == vault
        send({'jsonrpc':'2.0','id':801,'method':'host.vault.write','params':{'path':'forbidden'}})
        response = json.loads(sys.stdin.readline())
        assert response['id'] == 801 and response['error']['code'] == -32601
        send({'jsonrpc':'2.0','method':'host.ui.post','params':{'private':'never print'}})
        reply(request, {'ok':True})
    elif method == '$deactivate':
        reply(request, {'ok':True})
        break
    elif method == 'command.execute':
        command = request['params']['command']
        context = request['params']['context']
        if command == 'exit':
            sys.exit(0)
        if command == 'slow':
            time.sleep(1.5)
        if command == 'error':
            send({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32000,'message':'private source text'}})
        elif command == 'harness-status':
            reply(request, {'ok':True,'capabilities':{'terminal_result':True,'input_only_isolation':True,'tasks':['agency-observe-v1']}})
        else:
            reply(request, {'run_id':'test-run','command':command,'context':context})
"#;

    fn installed() -> (tempfile::TempDir, Installation, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        let current = root.join("notemd.codex-agent/current");
        std::fs::create_dir_all(current.join("bin")).unwrap();
        let binary = current.join("bin/fake");
        std::fs::write(&binary, FAKE_PROVIDER).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let arch = if std::env::consts::ARCH == "aarch64" {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        };
        let manifest = json!({
            "manifest_version":2,"id":"notemd.codex-agent","name":"Fake Codex",
            "version":"1.0.19","kind":"native","engines":{"notemd":">=6.0.0"},
            "binary":{arch:"bin/fake"},
            "activation":{"events":["onCommand:harness-status","onCommand:run-task","onCommand:run-status"]},
            "capabilities":[],"request_timeout_seconds":2
        });
        std::fs::write(current.join("manifest.json"), manifest.to_string()).unwrap();
        std::fs::write(
            root.join("state.json"),
            json!({"installed":{
                "notemd.codex-agent":{"version":"1.0.19","enabled":true}
            }})
            .to_string(),
        )
        .unwrap();
        let vault = temp.path().join("vault");
        std::fs::create_dir(&vault).unwrap();
        let installation = resolve_installation(&root, "notemd.codex-agent").unwrap();
        (temp, installation, vault)
    }

    #[tokio::test]
    async fn provider_handshake_services_vault_but_denies_other_host_requests() {
        let (_temp, installation, vault) = installed();
        let client = ProviderClient::spawn(&installation, &vault).await.unwrap();
        let host = Standalone {
            root: vault,
            harness: "notemd.codex-agent".into(),
            client: Mutex::new(Some(client.clone())),
            closed: AtomicBool::new(false),
        };
        let providers = host
            .request("host.agent.providers", json!({}))
            .await
            .unwrap();
        assert_eq!(
            providers["providers"][0]["harness"]["capabilities"]["input_only_isolation"],
            true
        );
        let result = host
            .request(
                "host.agent.run",
                json!({
                    "harness":"notemd.codex-agent","task":TASK_ID,"prompt":"fixture"
                }),
            )
            .await
            .unwrap();
        assert_eq!(result["command"], "run-task");
        assert_eq!(result["context"]["prompt"], "fixture");
        let result = host
            .request(
                "host.agent.status",
                json!({
                    "harness":"notemd.codex-agent","task":TASK_ID,"run_id":"test-run"
                }),
            )
            .await
            .unwrap();
        assert_eq!(result["command"], "run-status");
        assert!(host
            .request(
                "host.agent.run",
                json!({"harness":"notemd.claude-agent","task":TASK_ID})
            )
            .await
            .is_err());
        assert!(host
            .request(
                "host.agent.run",
                json!({"harness":"notemd.codex-agent","task":"other"})
            )
            .await
            .is_err());
        assert!(client
            .execute("error", json!({}))
            .await
            .unwrap_err()
            .contains("-32000"));
        client.close().await;
        assert!(client.child.lock().await.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn eof_and_timeout_remove_pending_requests() {
        let (_temp, mut installation, vault) = installed();
        let client = ProviderClient::spawn(&installation, &vault).await.unwrap();
        let error = tokio::time::timeout(Duration::from_secs(2), client.execute("exit", json!({})))
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.contains("关闭"));
        assert!(client.rpc.pending.lock().unwrap().is_empty());
        client.close().await;

        installation.quiet_timeout = Duration::from_millis(150);
        let client = ProviderClient::spawn(&installation, &vault).await.unwrap();
        assert!(client
            .execute("slow", json!({}))
            .await
            .unwrap_err()
            .contains("超时"));
        assert!(client.rpc.pending.lock().unwrap().is_empty());
        client.close().await;
    }

    #[tokio::test]
    async fn cancelled_request_removes_pending_entry_and_constructor_is_lazy() {
        let (_temp, installation, vault) = installed();
        let host = AgencyHost::standalone(&vault, "notemd.codex-agent")
            .await
            .unwrap();
        assert!(host.request("host.vault.write", json!({})).await.is_err());
        let Transport::Standalone(standalone) = &host.0 else {
            panic!("standalone")
        };
        assert!(standalone.client.lock().await.is_none());
        host.close().await;
        assert!(host
            .request("host.agent.providers", json!({}))
            .await
            .is_err());

        let client = ProviderClient::spawn(&installation, &vault).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(60), client.execute("slow", json!({})))
                .await
                .is_err()
        );
        assert!(client.rpc.pending.lock().unwrap().is_empty());
        client.close().await;
    }

    #[test]
    fn installation_requires_enabled_state_and_confined_binary() {
        let (temp, installation, _vault) = installed();
        let root = temp.path().join("plugins");
        let manifest_path = installation.directory.join("manifest.json");
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        for value in manifest["binary"].as_object_mut().unwrap().values_mut() {
            *value = json!("../outside");
        }
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        assert!(resolve_installation(&root, "notemd.codex-agent")
            .err()
            .unwrap()
            .contains("路径"));
        std::fs::write(
            root.join("state.json"),
            json!({"installed":{
                "notemd.codex-agent":{"version":"1.0.19","enabled":false}
            }})
            .to_string(),
        )
        .unwrap();
        assert!(resolve_installation(&root, "notemd.codex-agent")
            .err()
            .unwrap()
            .contains("启用"));
    }
}
