use crate::bridge::AgencyHost;
use fs2::FileExt;
use notemd_agency::{core, task};
use notemd_plugin_sdk as sdk;
use sdk::plugin_protocol as proto;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueueItem {
    date: String,
    state: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    episodes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    id: String,
    date: String,
    pub(crate) state: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    end_date: Option<String>,
    #[serde(default)]
    items: Vec<QueueItem>,
    #[serde(default)]
    stop_requested: bool,
}

#[derive(Debug)]
enum DayOutcome {
    Done(usize),
    Reused(usize),
    Skipped,
}

#[derive(Debug)]
struct DayFailure {
    message: String,
    remote_uncertain: bool,
}
impl From<String> for DayFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            remote_uncertain: false,
        }
    }
}
impl From<&str> for DayFailure {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}
impl DayFailure {
    fn uncertain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            remote_uncertain: true,
        }
    }
}

pub(crate) fn date_range(start: &str, end: &str) -> Result<Vec<String>, String> {
    fn parse(date: &str) -> Result<chrono::NaiveDate, String> {
        if date.len() != 10
            || !date.bytes().enumerate().all(|(i, b)| {
                if i == 4 || i == 7 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            })
        {
            return Err("日期必须为 YYYY-MM-DD".into());
        }
        let parsed = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| "日期必须为 YYYY-MM-DD".to_string())?;
        if parsed.format("%Y-%m-%d").to_string() != date {
            return Err("日期必须为 YYYY-MM-DD".into());
        }
        Ok(parsed)
    }
    let start = parse(start)?;
    let end = parse(end)?;
    let days = (end - start).num_days();
    if days < 0 {
        return Err("开始日期不能晚于结束日期".into());
    }
    if days >= 31 {
        return Err("一次最多处理 31 天（含首尾）".into());
    }
    Ok((0..=days)
        .map(|offset| (start + chrono::Duration::days(offset)).to_string())
        .collect())
}

impl Job {
    fn queued(dates: Vec<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            date: dates[0].clone(),
            state: "running".into(),
            message: "正在准备按日期依次观测…".into(),
            run_id: None,
            error: None,
            start_date: dates.first().cloned(),
            end_date: dates.last().cloned(),
            items: dates
                .into_iter()
                .map(|date| QueueItem {
                    date,
                    state: "pending".into(),
                    message: "等待处理".into(),
                    episodes: None,
                    error: None,
                })
                .collect(),
            stop_requested: false,
        }
    }
    fn cancel_pending(&mut self, reason: &str) {
        for item in &mut self.items {
            if item.state == "pending" {
                item.state = "cancelled".into();
                item.message = reason.into();
            }
        }
    }
    fn next_day(&mut self) -> Option<usize> {
        if self.stop_requested {
            self.cancel_pending("已停止队列，未启动该日观测");
            return None;
        }
        let index = self.items.iter().position(|item| item.state == "pending")?;
        self.date = self.items[index].date.clone();
        self.run_id = None;
        self.message = "正在核对会话来源与覆盖范围…".into();
        self.items[index].state = "running".into();
        self.items[index].message = self.message.clone();
        Some(index)
    }
    fn finish_day(&mut self, index: usize, result: Result<DayOutcome, DayFailure>) -> bool {
        let item = &mut self.items[index];
        match result {
            Ok(DayOutcome::Done(count)) => {
                item.state = "done".into();
                item.episodes = Some(count);
                item.message = format!("已校验并保存 {count} 个互动片段");
            }
            Ok(DayOutcome::Reused(count)) => {
                item.state = "reused".into();
                item.episodes = Some(count);
                item.message = format!("来源与规则未变化，复用 {count} 个互动片段");
            }
            Ok(DayOutcome::Skipped) => {
                item.state = "skipped".into();
                item.message = "没有可分析的会话，未生成空报告；可扫描查看排除原因".into();
            }
            Err(error) => {
                item.state = "failed".into();
                item.message = "该日观测未完成，保留之前的有效结果".into();
                item.error = Some(error.message.clone());
                self.error = Some(error.message);
                if error.remote_uncertain {
                    self.cancel_pending("上一个 Agent 可能仍在运行，为避免重叠未启动该日");
                    return false;
                }
            }
        }
        true
    }
    fn finish(&mut self) {
        let completed = self
            .items
            .iter()
            .filter(|i| matches!(i.state.as_str(), "done" | "reused"))
            .count();
        let failed = self.items.iter().filter(|i| i.state == "failed").count();
        let skipped = self.items.iter().filter(|i| i.state == "skipped").count();
        let cancelled = self.items.iter().filter(|i| i.state == "cancelled").count();
        self.state = if self.stop_requested {
            "cancelled"
        } else if (failed > 0 || cancelled > 0) && completed > 0 {
            "partial"
        } else if failed > 0 || cancelled > 0 {
            "failed"
        } else {
            "done"
        }
        .into();
        self.message = format!("队列已结束：{completed} 天完成或复用，{skipped} 天无来源，{failed} 天失败，{} 天未启动。", self.items.iter().filter(|i| i.state == "cancelled").count());
    }
    fn recover_interrupted(&mut self) {
        for item in &mut self.items {
            if item.state == "running" {
                item.state = "failed".into();
                item.message = "运行中断，请核对该日已有报告".into();
                item.error = Some("运行进程中断；Agent 可能仍在运行，请确认结束后重试".into());
            }
        }
        self.cancel_pending("队列进程中断，未启动该日");
        self.finish();
        if self.items.is_empty() {
            self.state = "failed".into();
        }
        self.message =
            "上次队列中断，已保留完成项；未自动启动剩余日期。请确认 Agent 已结束后重试。".into();
        self.error = Some(self.message.clone());
        // A crash between days also remains an interrupted, rather than successful, run.
        if self.state == "done" {
            self.state = "failed".into();
        }
    }
}

pub struct AgencyPlugin {
    job: Arc<Mutex<Option<(PathBuf, Job)>>>,
    worker: Option<tokio::task::JoinHandle<()>>,
}

impl AgencyPlugin {
    pub fn new() -> Self {
        Self {
            job: Arc::new(Mutex::new(None)),
            worker: None,
        }
    }

    pub(crate) fn current_job(&self, root: &Path) -> Result<Option<Job>, String> {
        let Some(mut job) = read_job(root)? else {
            return Ok(None);
        };
        if job.state == "running" {
            // The queue owns this lock across dates, including scans and cache reuse.
            if let Ok(_run_guard) = run_lock(root) {
                let _receipt_guard = receipt_lock(root)?;
                job = read_job(root)?.unwrap_or(job);
                if job.state == "running" {
                    job.recover_interrupted();
                    persist_job(root, &job)?;
                }
            }
        }
        Ok(Some(job))
    }

    pub(crate) fn stop_queue(&self, root: &Path) -> Result<Value, String> {
        let _receipt_guard = receipt_lock(root)?;
        let Some(mut job) = read_job(root)? else {
            return Ok(Value::Null);
        };
        if job.state == "running" {
            job.stop_requested = true;
            job.message = "已请求停止；当前日期安全结束后，不再启动后续日期。".into();
            persist_job(root, &job)?;
        }
        Ok(json!(job))
    }

    fn snapshot(&self, root: &Path, date: &str) -> Result<Value, String> {
        Ok(without_source_text(json!({
            "batch": core::load(root, date)?, "history": core::history(root)?,
            "job": self.current_job(root)?
        })))
    }

    fn start(
        &mut self,
        host: &AgencyHost,
        root: PathBuf,
        date: String,
        harness: String,
    ) -> Result<Value, String> {
        self.start_range(host, root, date.clone(), date, harness)
    }

    pub(crate) fn start_range(
        &mut self,
        host: &AgencyHost,
        root: PathBuf,
        start_date: String,
        end_date: String,
        harness: String,
    ) -> Result<Value, String> {
        if !task::PROVIDERS.contains(&harness.as_str()) {
            return Err("不支持的 Agent provider".into());
        }
        let dates = date_range(&start_date, &end_date)?;
        if self
            .worker
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
        {
            return Err("已有 Agency 观测正在运行，请等待完成".into());
        }
        let lock = run_lock(&root)?;
        let job = Job::queued(dates);
        {
            let _receipt_guard = receipt_lock(&root)?;
            persist_job(&root, &job)?;
        }
        *self.job.lock().map_err(|e| e.to_string())? = Some((root.clone(), job.clone()));
        let response = serde_json::to_value(&job).map_err(|e| e.to_string())?;
        let state = self.job.clone();
        let host = host.clone();
        self.worker = Some(tokio::spawn(async move {
            let _run_guard = lock;
            let mut job = job;
            if let Err(error) = run_queue(&host, &root, &harness, &mut job, &state).await {
                job.recover_interrupted();
                job.error = Some(format!("无法保存运行进度，请刷新已有报告：{error}"));
                let _ = update_job(&root, &mut job, &state);
            }
            *state.lock().unwrap() = Some((root, job.clone()));
            host.ui_post("main", json!({"type":"agency-job","job":job}));
        }));
        Ok(response)
    }
}

async fn request(host: &AgencyHost, method: &str, params: Value) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(90), host.request(method, params))
        .await
        .map_err(|_| format!("{method} 超时"))?
}

async fn run_queue(
    host: &AgencyHost,
    root: &Path,
    harness: &str,
    job: &mut Job,
    state: &Arc<Mutex<Option<(PathBuf, Job)>>>,
) -> Result<(), String> {
    loop {
        // Selecting a date and observing stop are one receipt transaction.
        let Some(index) = advance_job(root, job, state)? else {
            break;
        };
        host.ui_post("main", json!({"type":"agency-job","job":job}));
        let result = observe(host, root, harness, job, state).await;
        let continue_queue = job.finish_day(index, result);
        update_job(root, job, state)?;
        host.ui_post("main", json!({"type":"agency-job","job":job}));
        if !continue_queue {
            break;
        }
    }
    job.finish();
    update_job(root, job, state)
}

async fn observe(
    host: &AgencyHost,
    root: &Path,
    harness: &str,
    job: &mut Job,
    state: &Arc<Mutex<Option<(PathBuf, Job)>>>,
) -> Result<DayOutcome, DayFailure> {
    let scan_root = root.to_path_buf();
    let scan_date = job.date.clone();
    let scan = tokio::task::spawn_blocking(move || core::scan(&scan_root, &scan_date))
        .await
        .map_err(|e| e.to_string())??;
    if scan.sources.is_empty() {
        return Ok(DayOutcome::Skipped);
    }
    // Reuse the validated batch when inputs and provider match, preserving human reviews.
    if let Some(previous) = core::load(root, &job.date)? {
        if core::reusable(&previous, &scan, harness) {
            for source in &scan.sources {
                core::validate_source(root, source)?;
            }
            return Ok(DayOutcome::Reused(previous.episodes.len()));
        }
    }
    let providers = request(host, "host.agent.providers", json!({})).await?;
    let provider = providers
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(harness))
        })
        .ok_or("所选 Agent 插件尚未安装")?;
    if provider.pointer("/harness/ok").and_then(Value::as_bool) != Some(true) {
        return Err("所选 Agent 不可用，请在 Agent 插件中检查登录与环境".into());
    }
    if provider
        .pointer("/harness/capabilities/terminal_result")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err("所选 Agent 不支持完整结果，请先更新对应插件".into());
    }
    if provider
        .pointer("/harness/capabilities/input_only_isolation")
        .and_then(Value::as_bool)
        != Some(true)
        || !provider
            .pointer("/harness/capabilities/tasks")
            .and_then(Value::as_array)
            .is_some_and(|tasks| tasks.iter().any(|id| id.as_str() == Some(task::TASK_ID)))
    {
        return Err("请更新所选 Agent 插件以支持 Agency 无工具隔离观测".into());
    }
    task::seed(root)?;
    job.message = format!(
        "正在分析 {} 个会话，完成后核对逐条原话…",
        scan.sources.len()
    );
    update_job(root, job, state)?;
    let invocation = format!("{}-{}", job.id, job.date);
    let mut prompt = task::prompt(&scan, &invocation)?;
    for attempt in 0..2 {
        let candidate = run_candidate(host, root, harness, job, state, prompt).await?;
        job.message = "正在验证来源、角色、引文和覆盖完整性…".into();
        update_job(root, job, state)?;
        match core::validate_candidate(root, &scan, &candidate, &invocation) {
            Ok(()) => {
                return Ok(DayOutcome::Done(
                    core::publish(root, &scan, candidate, &invocation, harness)?
                        .episodes
                        .len(),
                ))
            }
            Err(error) if can_repair_citation(attempt, &error) => {
                // Repair only a generated citation, never source drift or storage failures.
                job.message = "发现原话引用不匹配，正在校正一次；仍须通过完整验证…".into();
                update_job(root, job, state)?;
                prompt = task::repair_prompt(&scan, &invocation, &candidate, &error)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err("引用校正后仍未通过验证，保留之前的结果".into())
}

fn can_repair_citation(attempt: usize, error: &str) -> bool {
    attempt == 0 && error.starts_with("片段 ") && error.ends_with("证据引文或角色与原文不匹配")
}

async fn run_candidate(
    host: &AgencyHost,
    root: &Path,
    harness: &str,
    job: &mut Job,
    state: &Arc<Mutex<Option<(PathBuf, Job)>>>,
    prompt: String,
) -> Result<core::Candidate, DayFailure> {
    // A caller-side timeout could lose a successfully started remote job's run_id.
    // The host owns start liveness and process-death handling.
    let result = host
        .request(
            "host.agent.run",
            json!({
                "task":task::TASK_ID, "harness":harness, "prompt":prompt
            }),
        )
        .await
        .map_err(DayFailure::uncertain)?;
    let run_id = result
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            DayFailure::uncertain("Agent 没有返回 run_id；可能已启动，请确认结束后重试")
        })?
        .to_string();
    job.run_id = Some(run_id.clone());
    update_job(root, job, state).map_err(DayFailure::uncertain)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(960);
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if tokio::time::Instant::now() >= deadline {
            return Err(DayFailure::uncertain(
                "Agent 运行超时；尚未发布，稍后重试前请确认 Agent 任务已结束",
            ));
        }
        let status = request(
            host,
            "host.agent.status",
            json!({
                "task":task::TASK_ID, "harness":harness, "run_id":run_id
            }),
        )
        .await
        .map_err(DayFailure::uncertain)?;
        match status.get("state").and_then(Value::as_str) {
            Some("running") => continue,
            Some("done") => {
                // Do not expose stderr/result text on failure: it may contain source material.
                let candidate = task::terminal_candidate(&status)?;
                return Ok(candidate);
            }
            _ => {
                return Err(DayFailure::uncertain(
                    "Agent 运行状态丢失；未发布观测，请确认结束后重试",
                ))
            }
        }
    }
}

fn advance_job(
    root: &Path,
    job: &mut Job,
    state: &Arc<Mutex<Option<(PathBuf, Job)>>>,
) -> Result<Option<usize>, String> {
    let _receipt_guard = receipt_lock(root)?;
    merge_stop(root, job)?;
    let index = job.next_day();
    persist_job(root, job)?;
    *state.lock().map_err(|e| e.to_string())? = Some((root.to_path_buf(), job.clone()));
    Ok(index)
}

fn merge_stop(root: &Path, job: &mut Job) -> Result<(), String> {
    if let Some(saved) = read_job(root)? {
        if saved.id == job.id {
            job.stop_requested |= saved.stop_requested;
        }
    }
    Ok(())
}

fn update_job(
    root: &Path,
    job: &mut Job,
    state: &Arc<Mutex<Option<(PathBuf, Job)>>>,
) -> Result<(), String> {
    let _receipt_guard = receipt_lock(root)?;
    merge_stop(root, job)?;
    // A stop racing with the final receipt still receives a consistent state.
    if job.stop_requested && job.state != "running" {
        job.finish();
    }
    if let Some(item) = job.items.iter_mut().find(|item| item.state == "running") {
        item.message = job.message.clone();
    }
    persist_job(root, job)?;
    *state.lock().map_err(|e| e.to_string())? = Some((root.to_path_buf(), job.clone()));
    Ok(())
}

fn read_job(root: &Path) -> Result<Option<Job>, String> {
    let path = core::safe_path(root, ".notemd/agency/job.json", false)?;
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|e| format!("Agency 运行状态损坏：{e}"))
}

// Separate, short-lived receipt lock permits stop requests from another process
// without taking the queue's whole-run lock, and prevents lost updates.
fn receipt_lock(root: &Path) -> Result<File, String> {
    let path = core::safe_path(root, ".notemd/agency/job.lock", true)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(file)
}

struct RunGuard(File);
impl Drop for RunGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn run_lock(root: &Path) -> Result<RunGuard, String> {
    let path = core::safe_path(root, ".notemd/agency/run.lock", true)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.try_lock_exclusive()
        .map_err(|_| "已有 Agency 观测运行中".to_string())?;
    Ok(RunGuard(file))
}

fn persist_job(root: &Path, job: &Job) -> Result<(), String> {
    let path = core::safe_path(root, ".notemd/agency/job.json", true)?;
    let mut tmp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut tmp, job).map_err(|e| e.to_string())?;
    tmp.flush().map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn vault_root() -> Result<PathBuf, String> {
    let config = if let Ok(path) = std::env::var("NOTEMD_SHARED_CONFIG") {
        PathBuf::from(path)
    } else {
        PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?)
            .join("Library/Application Support/net.notemd.app/shared.json")
    };
    let value: Value =
        serde_json::from_slice(&std::fs::read(config).map_err(|_| "尚未配置 Vault".to_string())?)
            .map_err(|e| e.to_string())?;
    let root = value
        .get("sotvault")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("尚未配置 Vault")?;
    Path::new(root).canonicalize().map_err(|e| e.to_string())
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少 {key}"))
}

pub fn without_source_text(mut value: Value) -> Value {
    fn strip(value: &mut Value) {
        match value {
            Value::Object(obj) => {
                if obj.contains_key("sha256") && obj.contains_key("path") {
                    obj.remove("lines");
                }
                for item in obj.values_mut() {
                    strip(item);
                }
            }
            Value::Array(items) => {
                for item in items {
                    strip(item);
                }
            }
            _ => {}
        }
    }
    strip(&mut value);
    value
}

impl sdk::NotemdPlugin for AgencyPlugin {
    fn activate(
        &mut self,
        _host: &sdk::Host,
        _params: &proto::ActivateParams,
    ) -> Result<(), String> {
        Ok(())
    }
    fn deactivate(&mut self, _host: &sdk::Host) {
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
    }
    fn execute_command(
        &mut self,
        _host: &sdk::Host,
        params: &proto::ExecuteCommandParams,
    ) -> Result<Value, String> {
        let root = vault_root()?;
        let action = params
            .context
            .pointer("/cli/args/action")
            .and_then(Value::as_str)
            .or_else(|| params.context.get("action").and_then(Value::as_str))
            .ok_or("缺少 action")?;
        let date = params
            .context
            .pointer("/cli/flags/date")
            .and_then(Value::as_str)
            .or_else(|| params.context.get("date").and_then(Value::as_str));
        match action {
            "scan" => Ok(without_source_text(json!(core::scan(
                &root,
                date.ok_or("缺少 --date")?
            )?))),
            "snapshot" => self.snapshot(&root, date.ok_or("缺少 --date")?),
            "status" => Ok(json!(self.current_job(&root)?)),
            "run" => crate::cli::spawn(&root, &params.context),
            "stop" => self.stop_queue(&root),
            _ => Err("CLI 支持 run / scan / snapshot / status / stop".into()),
        }
    }
    fn on_ui_request(
        &mut self,
        host: &sdk::Host,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let root = vault_root()?;
        match method.strip_prefix("plugin.").unwrap_or(method) {
            "snapshot" => self.snapshot(&root, required(&params, "date")?),
            "scan" => Ok(without_source_text(json!(core::scan(
                &root,
                required(&params, "date")?
            )?))),
            "observe" => self.start(
                &AgencyHost::from(host.clone()),
                root,
                required(&params, "date")?.into(),
                required(&params, "harness")?.into(),
            ),
            "observe_range" => self.start_range(
                &AgencyHost::from(host.clone()),
                root,
                required(&params, "start_date")?.into(),
                required(&params, "end_date")?.into(),
                required(&params, "harness")?.into(),
            ),
            "stop_queue" => self.stop_queue(&root),
            "job" => Ok(json!(self.current_job(&root)?)),
            "review" => Ok(without_source_text(json!(core::save_review(
                &root,
                required(&params, "date")?,
                required(&params, "batch_id")?,
                required(&params, "episode_id")?,
                params
                    .get("excluded")
                    .and_then(Value::as_bool)
                    .ok_or("缺少 excluded")?,
                params.get("note").and_then(Value::as_str).unwrap_or("")
            )?))),
            "open_source" => {
                let batch = core::load(&root, required(&params, "date")?)?.ok_or("该日尚无观测")?;
                let id = required(&params, "source_id")?;
                let source = batch
                    .scan
                    .sources
                    .iter()
                    .find(|source| source.id == id)
                    .ok_or("未知来源")?;
                core::validate_source(&root, source)?;
                let line = params
                    .get("line")
                    .and_then(Value::as_u64)
                    .filter(|n| *n > 0)
                    .ok_or("缺少 line")?;
                if !source.lines.iter().any(|l| l.n as u64 == line) {
                    return Err("该行不在已核对的来源中".into());
                }
                Ok(json!({"path":source.path,"line":line}))
            }
            _ => Err(format!("unknown ui method: {method}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn queue(start: &str, end: &str) -> Job {
        Job::queued(date_range(start, end).unwrap())
    }
    fn states(job: &Job) -> Vec<&str> {
        job.items.iter().map(|item| item.state.as_str()).collect()
    }
    #[test]
    fn ranges_are_inclusive_and_ordered_across_month_year_and_leap_day() {
        assert_eq!(
            date_range("2026-12-31", "2027-01-02").unwrap(),
            ["2026-12-31", "2027-01-01", "2027-01-02"]
        );
        assert_eq!(
            date_range("2024-02-28", "2024-03-01").unwrap(),
            ["2024-02-28", "2024-02-29", "2024-03-01"]
        );
        assert_eq!(date_range("2026-02-28", "2026-03-01").unwrap().len(), 2);
        assert_eq!(date_range("2026-09-17", "2026-09-17").unwrap().len(), 1);
        assert_eq!(date_range("2026-01-01", "2026-01-31").unwrap().len(), 31);
    }
    #[test]
    fn ranges_reject_invalid_noncanonical_reversed_and_over_limit() {
        for date in [
            "2026-2-01",
            "2026-02-1",
            "2026-02-29",
            "2026-13-01",
            "2026-09-01T00:00:00",
            " 2026-09-01",
            "-0001-01-01",
            "10000-01-01",
        ] {
            assert!(date_range(date, date).is_err(), "{date}");
        }
        assert!(date_range("2026-01-02", "2026-01-01").is_err());
        assert!(date_range("2026-01-01", "2026-02-01").is_err());
    }
    #[test]
    fn mixed_day_results_continue_in_order_and_keep_independent_receipts() {
        let mut job = queue("2026-09-17", "2026-09-21");
        let mut visited = Vec::new();
        let mut outcomes = [
            Ok(DayOutcome::Done(3)),
            Err("invalid candidate".into()),
            Ok(DayOutcome::Skipped),
            Ok(DayOutcome::Reused(2)),
            Ok(DayOutcome::Done(1)),
        ]
        .into_iter();
        while let Some(index) = job.next_day() {
            visited.push(job.date.clone());
            assert!(job.finish_day(index, outcomes.next().unwrap()));
        }
        job.finish();
        assert_eq!(visited, date_range("2026-09-17", "2026-09-21").unwrap());
        assert_eq!(
            states(&job),
            ["done", "failed", "skipped", "reused", "done"]
        );
        assert_eq!(job.state, "partial");
        assert_eq!(job.items[0].episodes, Some(3));
        assert!(job.items[2].episodes.is_none());
        assert_eq!(job.items[1].error.as_deref(), Some("invalid candidate"));
        assert!(job.items[4].error.is_none());
    }
    #[test]
    fn no_source_days_finish_without_claiming_a_report() {
        let mut job = queue("2026-09-17", "2026-09-18");
        while let Some(index) = job.next_day() {
            job.finish_day(index, Ok(DayOutcome::Skipped));
        }
        job.finish();
        assert_eq!(job.state, "done");
        assert_eq!(states(&job), ["skipped", "skipped"]);
        assert!(job.items.iter().all(|i| i.episodes.is_none()));
    }
    #[test]
    fn uncertain_remote_failure_cancels_remaining_dates_without_starting_them() {
        let mut job = queue("2026-09-17", "2026-09-19");
        let index = job.next_day().unwrap();
        job.finish_day(index, Ok(DayOutcome::Done(1)));
        let index = job.next_day().unwrap();
        assert!(!job.finish_day(index, Err(DayFailure::uncertain("status timeout"))));
        assert!(job.next_day().is_none());
        job.finish();
        assert_eq!(states(&job), ["done", "failed", "cancelled"]);
        assert_eq!(job.state, "partial");
        assert!(!job.stop_requested);
    }
    #[test]
    fn stop_waits_for_current_day_and_cancels_only_pending_dates() {
        let mut job = queue("2026-09-17", "2026-09-19");
        let index = job.next_day().unwrap();
        job.stop_requested = true;
        assert_eq!(states(&job), ["running", "pending", "pending"]);
        job.finish_day(index, Ok(DayOutcome::Done(2)));
        assert!(job.next_day().is_none());
        job.finish();
        assert_eq!(states(&job), ["done", "cancelled", "cancelled"]);
        assert_eq!(job.items[0].episodes, Some(2));
        assert_eq!(job.state, "cancelled");
    }
    #[test]
    fn legacy_running_receipt_is_compatible_and_recovers_durably() {
        let root = tempfile::tempdir().unwrap();
        let legacy =
            json!({"id":"old", "date":"2026-09-17", "state":"running", "message":"分析中"});
        let job: Job = serde_json::from_value(legacy).unwrap();
        assert!(job.items.is_empty());
        assert!(!job.stop_requested);
        assert!(job.start_date.is_none());
        persist_job(root.path(), &job).unwrap();
        let plugin = AgencyPlugin::new();
        let recovered = plugin.current_job(root.path()).unwrap().unwrap();
        assert_eq!(recovered.state, "failed");
        assert_eq!(read_job(root.path()).unwrap().unwrap().state, "failed");
    }
    #[test]
    fn interrupted_queue_preserves_completed_results_and_does_not_resume() {
        let root = tempfile::tempdir().unwrap();
        let mut job = queue("2026-09-17", "2026-09-20");
        let index = job.next_day().unwrap();
        job.finish_day(index, Ok(DayOutcome::Done(3)));
        let index = job.next_day().unwrap();
        job.finish_day(index, Ok(DayOutcome::Reused(4)));
        job.next_day().unwrap();
        persist_job(root.path(), &job).unwrap();
        let plugin = AgencyPlugin::new();
        let lock = run_lock(root.path()).unwrap();
        assert_eq!(
            plugin.current_job(root.path()).unwrap().unwrap().state,
            "running"
        );
        drop(lock);
        let recovered = plugin.current_job(root.path()).unwrap().unwrap();
        assert_eq!(recovered.state, "partial");
        assert_eq!(
            states(&recovered),
            ["done", "reused", "failed", "cancelled"]
        );
        assert_eq!(recovered.items[0].episodes, Some(3));
        assert_eq!(recovered.items[1].episodes, Some(4));
        assert_eq!(
            states(&read_job(root.path()).unwrap().unwrap()),
            states(&recovered)
        );
    }
    #[test]
    fn another_process_stop_survives_stale_worker_progress_and_new_jobs_reset_it() {
        let root = tempfile::tempdir().unwrap();
        let mut local = queue("2026-09-17", "2026-09-19");
        let index = local.next_day().unwrap();
        persist_job(root.path(), &local).unwrap();
        let controller = AgencyPlugin::new();
        let stopped = controller.stop_queue(root.path()).unwrap();
        assert_eq!(stopped["stop_requested"], true);
        assert!(!local.stop_requested);
        let state = Arc::new(Mutex::new(None));
        local.message = "still finishing current day".into();
        update_job(root.path(), &mut local, &state).unwrap();
        assert!(local.stop_requested);
        assert!(read_job(root.path()).unwrap().unwrap().stop_requested);
        local.finish_day(index, Ok(DayOutcome::Done(1)));
        assert!(local.next_day().is_none());
        local.finish();
        update_job(root.path(), &mut local, &state).unwrap();
        assert_eq!(
            controller.current_job(root.path()).unwrap().unwrap().state,
            "cancelled"
        );
        let mut fresh = queue("2026-09-17", "2026-09-19");
        update_job(root.path(), &mut fresh, &state).unwrap();
        assert!(!fresh.stop_requested);
    }
    #[test]
    fn stop_between_days_is_merged_before_next_date_can_be_selected() {
        let root = tempfile::tempdir().unwrap();
        let mut job = queue("2026-09-17", "2026-09-18");
        let state = Arc::new(Mutex::new(None));
        let first = advance_job(root.path(), &mut job, &state).unwrap().unwrap();
        job.finish_day(first, Ok(DayOutcome::Done(2)));
        update_job(root.path(), &mut job, &state).unwrap();
        AgencyPlugin::new().stop_queue(root.path()).unwrap();
        assert!(advance_job(root.path(), &mut job, &state)
            .unwrap()
            .is_none());
        assert_eq!(states(&job), ["done", "cancelled"]);
        assert_eq!(job.date, "2026-09-17");
    }
    // Drive the production async coordinator over the SDK protocol, without
    // environment mutation or a model process. Only the provider replies are fake.
    struct TestPlugin {
        root: PathBuf,
        agency: AgencyPlugin,
    }
    impl sdk::NotemdPlugin for TestPlugin {
        fn activate(&mut self, _: &sdk::Host, _: &proto::ActivateParams) -> Result<(), String> {
            Ok(())
        }
        fn deactivate(&mut self, host: &sdk::Host) {
            self.agency.deactivate(host);
        }
        fn execute_command(
            &mut self,
            _: &sdk::Host,
            _: &proto::ExecuteCommandParams,
        ) -> Result<Value, String> {
            Err("unused".into())
        }
        fn on_ui_request(
            &mut self,
            host: &sdk::Host,
            method: &str,
            params: Value,
        ) -> Result<Value, String> {
            match method {
                "start" => self.agency.start_range(
                    &AgencyHost::from(host.clone()),
                    self.root.clone(),
                    required(&params, "start_date")?.into(),
                    required(&params, "end_date")?.into(),
                    task::PROVIDERS[0].into(),
                ),
                "stop" => self.agency.stop_queue(&self.root),
                _ => Err("unexpected test request".into()),
            }
        }
    }
    fn session_fixture(root: &Path, date: &str) {
        let path = core::safe_path(root, &format!("agent-sessions/{date}.md"), true).unwrap();
        std::fs::write(path, format!("# Test\n\n- Started: {date} 10:00\n- Ended: {date} 10:30\n- Model: codex\n- User turns: 1\n\n---\n\n## 👤 User\n请检查结果并提供证据。\n## 🤖 Codex\n检查完毕。\n")).unwrap();
    }
    fn candidate_from_input(input: &Value) -> core::Candidate {
        let mut candidate = input["example"].clone();
        let source = &input["sources"][0];
        let line = source["lines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|line| line["role"] == "user")
            .unwrap();
        candidate["episodes"][0]["source_id"] = source["id"].clone();
        candidate["episodes"][0]["evidence"][0] =
            json!({"line":line["n"], "quote":line["text"], "kind":"user"});
        serde_json::from_value(candidate).unwrap()
    }
    #[derive(Clone, Copy)]
    enum Scenario {
        Mixed,
        Stop,
        Lost,
    }
    async fn protocol_queue(
        root: &Path,
        start: &str,
        end: &str,
        scenario: Scenario,
    ) -> (Job, Vec<String>) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (mut to_plugin, stdin) = tokio::io::duplex(128 * 1024);
        let (stdout, from_plugin) = tokio::io::duplex(128 * 1024);
        let plugin = TestPlugin {
            root: root.to_path_buf(),
            agency: AgencyPlugin::new(),
        };
        let serve = tokio::spawn(sdk::serve_io(plugin, stdin, stdout));
        let mut lines = BufReader::new(from_plugin).lines();
        let initial = json!({"jsonrpc":"2.0", "id":10000, "method":"ui.request", "params":{
            "method":"start", "params":{"start_date":start, "end_date":end}
        }});
        to_plugin
            .write_all(format!("{initial}\n").as_bytes())
            .await
            .unwrap();
        let mut runs = Vec::new();
        let mut active: Option<core::Candidate> = None;
        let mut stop_acknowledged = false;
        let completed = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let message: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                if message["id"] == 10000 { assert!(message.get("error").is_none(), "{message}"); }
                if message["id"] == 10001 {
                    assert_eq!(message["result"]["stop_requested"], true);
                    stop_acknowledged = true;
                }
                let Some(method) = message["method"].as_str() else { continue };
                let result = match method {
                    "host.ui.post" => {
                        let job = &message["params"]["payload"]["job"];
                        if job["state"] != "running" {
                            assert!(active.is_none());
                            if matches!(scenario, Scenario::Stop) { assert!(stop_acknowledged); }
                            break serde_json::from_value::<Job>(job.clone()).unwrap();
                        }
                        continue;
                    }
                    "host.agent.providers" => json!({"providers":[{"id":task::PROVIDERS[0],"harness":{"ok":true,"capabilities":{
                        "terminal_result":true,"input_only_isolation":true,"tasks":[task::TASK_ID]
                    }}}]}),
                    "host.agent.run" => {
                        assert!(active.is_none(), "Agent runs must never overlap");
                        let input: Value = serde_json::from_str(message["params"]["prompt"].as_str().unwrap()).unwrap();
                        runs.push(input["date"].as_str().unwrap().to_string());
                        active = Some(candidate_from_input(&input));
                        json!({"run_id":format!("run-{}", runs.len())})
                    }
                    "host.agent.status" => {
                        let candidate = active.take().expect("poll must follow a run");
                        if matches!(scenario, Scenario::Lost) {
                            let reply = json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32000,"message":"lost remote status"}});
                            to_plugin.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                            continue;
                        }
                        let content = if matches!(scenario, Scenario::Mixed) && candidate.date == "2026-09-18" {
                            "invalid JSON".to_string()
                        } else { serde_json::to_string(&candidate).unwrap() };
                        json!({"state":"done","record":{"status":"success"},"terminal_result":{"complete":true,"content":content}})
                    }
                    _ => panic!("unexpected host request: {method}"),
                };
                let reply = json!({"jsonrpc":"2.0","id":message["id"],"result":result});
                to_plugin.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                if method == "host.agent.run" && matches!(scenario, Scenario::Stop) {
                    let stop = json!({"jsonrpc":"2.0","id":10001,"method":"ui.request","params":{"method":"stop","params":{}}});
                    to_plugin.write_all(format!("{stop}\n").as_bytes()).await.unwrap();
                }
            }
        }).await.expect("queue protocol stalled");
        let shutdown = json!({"jsonrpc":"2.0","id":10002,"method":"$deactivate","params":{}});
        to_plugin
            .write_all(format!("{shutdown}\n").as_bytes())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), serve)
            .await
            .unwrap()
            .unwrap();
        (completed, runs)
    }
    #[tokio::test]
    async fn async_queue_scans_reuses_skips_publishes_and_continues_after_bad_result() {
        let root = tempfile::tempdir().unwrap();
        for date in ["2026-09-17", "2026-09-18", "2026-09-20", "2026-09-21"] {
            session_fixture(root.path(), date);
        }
        let scan = core::scan(root.path(), "2026-09-20").unwrap();
        let input: Value =
            serde_json::from_str(&task::prompt(&scan, "seed-cache").unwrap()).unwrap();
        let cached = core::publish(
            root.path(),
            &scan,
            candidate_from_input(&input),
            "seed-cache",
            task::PROVIDERS[0],
        )
        .unwrap();
        let (job, runs) =
            protocol_queue(root.path(), "2026-09-17", "2026-09-21", Scenario::Mixed).await;
        assert_eq!(runs, ["2026-09-17", "2026-09-18", "2026-09-21"]);
        assert_eq!(
            states(&job),
            ["done", "failed", "skipped", "reused", "done"]
        );
        assert_eq!(job.state, "partial");
        assert!(core::load(root.path(), "2026-09-17").unwrap().is_some());
        assert!(core::load(root.path(), "2026-09-18").unwrap().is_none());
        assert!(core::load(root.path(), "2026-09-19").unwrap().is_none());
        assert_eq!(
            core::load(root.path(), "2026-09-20").unwrap().unwrap().id,
            cached.id
        );
        assert!(core::load(root.path(), "2026-09-21").unwrap().is_some());
        assert_eq!(
            states(&read_job(root.path()).unwrap().unwrap()),
            states(&job)
        );
    }
    #[tokio::test]
    async fn async_stop_finishes_current_model_and_does_not_launch_next_date() {
        let root = tempfile::tempdir().unwrap();
        for date in ["2026-09-17", "2026-09-18"] {
            session_fixture(root.path(), date);
        }
        let (job, runs) =
            protocol_queue(root.path(), "2026-09-17", "2026-09-18", Scenario::Stop).await;
        assert_eq!(runs, ["2026-09-17"]);
        assert_eq!(states(&job), ["done", "cancelled"]);
        assert_eq!(job.state, "cancelled");
        assert!(core::load(root.path(), "2026-09-17").unwrap().is_some());
        assert!(core::load(root.path(), "2026-09-18").unwrap().is_none());
    }
    #[tokio::test]
    async fn async_lost_remote_status_stops_queue_and_publishes_nothing() {
        let root = tempfile::tempdir().unwrap();
        for date in ["2026-09-17", "2026-09-18"] {
            session_fixture(root.path(), date);
        }
        let (job, runs) =
            protocol_queue(root.path(), "2026-09-17", "2026-09-18", Scenario::Lost).await;
        assert_eq!(runs, ["2026-09-17"]);
        assert_eq!(states(&job), ["failed", "cancelled"]);
        assert_eq!(job.state, "failed");
        assert!(core::history(root.path()).unwrap().is_empty());
    }
    #[test]
    fn repair_is_once_and_never_for_source_or_storage_failure() {
        let citation = "片段 e17 的 evidence[5]（源行 1812）：证据引文或角色与原文不匹配";
        assert!(can_repair_citation(0, citation));
        assert!(!can_repair_citation(1, citation));
        assert!(!can_repair_citation(0, &format!("来源已变化：{citation}")));
        assert!(!can_repair_citation(0, "cannot persist batch"));
    }
    #[test]
    fn responses_do_not_ship_the_entire_transcript_to_the_window() {
        let v = without_source_text(
            json!({"batch":{"scan":{"sources":[{"path":"a.md","sha256":"hash","lines":[{"text":"private"}]}]}}}),
        );
        assert!(v["batch"]["scan"]["sources"][0].get("lines").is_none());
    }
    #[test]
    fn run_lock_prevents_overlapping_observers_and_releases() {
        let dir = tempfile::tempdir().unwrap();
        let lock = run_lock(dir.path()).unwrap();
        assert!(run_lock(dir.path()).is_err());
        drop(lock);
        assert!(run_lock(dir.path()).is_ok());
    }
}
