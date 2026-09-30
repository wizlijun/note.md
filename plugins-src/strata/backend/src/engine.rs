use crate::{
    cache::{Artifact, Cache, Pending},
    index::{self, IndexSnapshot},
    rpc::Host,
    task,
    types::*,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

struct Running {
    stop: Arc<AtomicBool>,
    job: Arc<Mutex<Job>>,
    handle: tokio::task::JoinHandle<()>,
}
pub struct Engine {
    data_dir: Mutex<Option<PathBuf>>,
    last_context: Mutex<Option<Context>>,
    jobs: Mutex<HashMap<String, Running>>,
    /// Serializes cache publication and atlas validation without holding a lock over RPC.
    cache_gate: Mutex<()>,
}
#[derive(Clone)]
struct Context {
    root: String,
    key: String,
    cache: Cache,
}
impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
impl Engine {
    pub fn new() -> Self {
        Self {
            data_dir: Mutex::new(None),
            last_context: Mutex::new(None),
            jobs: Mutex::new(HashMap::new()),
            cache_gate: Mutex::new(()),
        }
    }
    pub fn initialize(&self, params: &Value) -> Result<(), String> {
        let value = params["data_dir"]
            .as_str()
            .ok_or("Host 未提供插件缓存目录")?;
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err("插件缓存目录必须为绝对路径".into());
        }
        *self.data_dir.lock().unwrap() = Some(path);
        Ok(())
    }
    async fn context(&self, host: &dyn Host) -> Result<Context, String> {
        let info = host.request("host.vault.info", json!({})).await?;
        let root = info["root"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("请先打开 Vault")?
            .to_string();
        let key = task::hash(&root);
        let data = self
            .data_dir
            .lock()
            .unwrap()
            .clone()
            .ok_or("插件尚未初始化")?;
        let cache = Cache::new(&data, &key)?;
        let context = Context { root, key, cache };
        *self.last_context.lock().unwrap() = Some(context.clone());
        Ok(context)
    }
    async fn same_vault(host: &dyn Host, context: &Context) -> Result<(), String> {
        let info = host.request("host.vault.info", json!({})).await?;
        if info["root"].as_str() != Some(context.root.as_str()) {
            return Err("Vault 已切换，本次操作已停止".into());
        }
        Ok(())
    }
    pub fn shutdown(&self) {
        for running in self.jobs.lock().unwrap().values() {
            running.stop.store(true, Ordering::Release);
            running.handle.abort();
        }
    }
    pub async fn handle(
        self: &Arc<Self>,
        host: Arc<dyn Host>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        // Cancellation must not queue a host.vault.info behind a slow Agent
        // launch on the host's serial process-side RPC lane. Stopping the last
        // locally known job neither reads a source nor publishes any result.
        if method.strip_prefix("plugin.").unwrap_or(method) == "stop" {
            if let Some(context) = self.last_context.lock().unwrap().clone() {
                return self.stop(&context);
            }
        }
        let ctx = self.context(host.as_ref()).await?;
        match method.strip_prefix("plugin.").unwrap_or(method) {
            "snapshot" => {
                let range: DateRange =
                    serde_json::from_value(params).map_err(|_| "缺少日期范围")?;
                range.validate()?;
                let index = index::snapshot(host.as_ref(), None).await?;
                Self::same_vault(host.as_ref(), &ctx).await?;
                self.recover(host.clone(), ctx.clone()).await?;
                let checked = self
                    .check_cached_sources(host.as_ref(), &ctx, &index, &range)
                    .await?;
                let _guard = self.cache_gate.lock().unwrap();
                let snapshot =
                    assemble(&ctx, index, range, self.current_job(&ctx)?, Some(&checked))?;
                serde_json::to_value(snapshot).map_err(|_| "无法编码知识快照".into())
            }
            "extract" => {
                let request: ExtractRequest =
                    serde_json::from_value(params).map_err(|_| "深读参数格式无效")?;
                request.range().validate()?;
                request.budget.validate()?;
                if !task::PROVIDERS.contains(&request.harness.as_str()) {
                    return Err("请选择已安装的 Agent provider".into());
                }
                self.recover(host.clone(), ctx.clone()).await?;
                self.start(host, ctx, request).await
            }
            "job" => {
                self.recover(host, ctx.clone()).await?;
                Ok(json!(self.current_job(&ctx)?))
            }
            "stop" => self.stop(&ctx),
            "dismiss_job" => self.dismiss(&ctx, &params),
            "open_source" => self.open_source(host.as_ref(), &ctx, &params).await,
            "atlas.load" | "atlas.save" => {
                if params["vaultKey"].as_str() != Some(ctx.key.as_str()) {
                    return Err("布局所属 Vault 已变化".into());
                }
                let index = index::snapshot(host.as_ref(), None).await?;
                Self::same_vault(host.as_ref(), &ctx).await?;
                let _guard = self.cache_gate.lock().unwrap();
                let snapshot = assemble(
                    &ctx,
                    index,
                    DateRange {
                        from: "0001-01-01".into(),
                        to: "9999-12-31".into(),
                    },
                    None,
                    None,
                )?;
                let allowed: HashSet<_> = snapshot.nodes.into_iter().map(|n| n.id).collect();
                if method.ends_with("load") {
                    Ok(json!({"atlas":ctx.cache.load_atlas(&allowed)?}))
                } else {
                    ctx.cache.save_atlas(params["atlas"].clone(), &allowed)?;
                    Ok(json!({"ok":true}))
                }
            }
            _ => Err("未知 STRATA 操作".into()),
        }
    }
    fn current_job(&self, context: &Context) -> Result<Option<Job>, String> {
        if let Some(running) = self.jobs.lock().unwrap().get(&context.key) {
            return Ok(Some(running.job.lock().unwrap().clone()));
        }
        context.cache.job()
    }
    fn stop(&self, context: &Context) -> Result<Value, String> {
        let _guard = self.cache_gate.lock().unwrap();
        if let Some(running) = self.jobs.lock().unwrap().get(&context.key) {
            running.stop.store(true, Ordering::Release);
            let mut job = running.job.lock().unwrap();
            if job.running() || context.cache.pending()?.is_some() {
                job.stop_requested = true;
                job.state = if running.handle.is_finished() {
                    "cancelled"
                } else {
                    "stopping"
                }
                .into();
                job.message = "已停止后续批次；当前远程批次可能仍在运行，结果将不再发布".into();
                job.updated_at = now();
                context.cache.save_job(&job)?;
            }
            return Ok(json!(*job));
        }
        let Some(mut job) = context.cache.job()? else {
            return Ok(Value::Null);
        };
        if job.running() || context.cache.pending()?.is_some() {
            job.stop_requested = true;
            job.state = "cancelled".into();
            job.message = "已停止恢复与后续批次".into();
            context.cache.save_job(&job)?;
        }
        Ok(json!(job))
    }
    fn dismiss(&self, context: &Context, params: &Value) -> Result<Value, String> {
        let _guard = self.cache_gate.lock().unwrap();
        let mut jobs = self.jobs.lock().unwrap();
        if jobs
            .get(&context.key)
            .is_some_and(|r| !r.handle.is_finished())
        {
            return Err("请先停止正在运行的恢复或深读".into());
        }
        let mut job = context.cache.job()?.ok_or("没有可放弃的任务")?;
        if params["jobId"].as_str() != Some(job.id.as_str()) {
            return Err("任务已变化，请刷新".into());
        }
        if !job.can_dismiss_recovery || context.cache.pending()?.is_none() {
            return Err("此任务没有可放弃的未确认回执".into());
        }
        context.cache.clear_pending()?;
        job.can_dismiss_recovery = false;
        job.state = "cancelled".into();
        job.stop_requested = true;
        job.message = "已放弃本地恢复；未确认的远程批次可能仍运行，其结果不会发布".into();
        job.updated_at = now();
        context.cache.save_job(&job)?;
        jobs.remove(&context.key);
        Ok(json!(job))
    }
    async fn start(
        self: &Arc<Self>,
        host: Arc<dyn Host>,
        ctx: Context,
        request: ExtractRequest,
    ) -> Result<Value, String> {
        if self
            .jobs
            .lock()
            .unwrap()
            .get(&ctx.key)
            .is_some_and(|r| !r.handle.is_finished())
        {
            return Err("已有深读任务正在运行，请等待或停止".into());
        }
        let providers = host.request("host.agent.providers", json!({})).await?;
        let provider = providers["providers"]
            .as_array()
            .and_then(|p| p.iter().find(|p| p["id"] == request.harness))
            .ok_or("所选 Agent 尚未安装")?;
        if provider.pointer("/harness/ok").and_then(Value::as_bool) != Some(true)
            || provider
                .pointer("/harness/capabilities/terminal_result")
                .and_then(Value::as_bool)
                != Some(true)
            || provider
                .pointer("/harness/capabilities/input_only_isolation")
                .and_then(Value::as_bool)
                != Some(true)
            || !provider
                .pointer("/harness/capabilities/tasks")
                .and_then(Value::as_array)
                .is_some_and(|tasks| tasks.iter().any(|t| t == task::TASK))
        {
            return Err(
                "所选 Agent 未就绪或尚不支持 STRATA 无工具抽取，请先更新并配置该插件".into(),
            );
        }
        Self::same_vault(host.as_ref(), &ctx).await?;
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.get(&ctx.key).is_some_and(|r| !r.handle.is_finished()) {
            return Err("已有深读任务正在运行".into());
        }
        if ctx.cache.pending()?.is_some() {
            return Err("上次远程任务状态尚未核实，请等待恢复或在 Agent 中确认结束".into());
        }
        let job = Job {
            id: uuid::Uuid::new_v4().to_string(),
            state: "running".into(),
            range: request.range(),
            harness: request.harness,
            model: None,
            budget: request.budget,
            include_confidential: request.include_confidential,
            selected: 0,
            processed: 0,
            reused: 0,
            skipped: 0,
            failed: 0,
            input_bytes: 0,
            nodes: 0,
            stop_requested: false,
            can_dismiss_recovery: false,
            run_id: None,
            invocation_id: None,
            message: "正在冻结索引范围与预算…".into(),
            error: None,
            started_at: now(),
            updated_at: now(),
        };
        ctx.cache.save_job(&job)?;
        let response = json!(job);
        let shared = Arc::new(Mutex::new(job));
        let stop = Arc::new(AtomicBool::new(false));
        let (engine, worker_job, worker_stop, worker_ctx) =
            (self.clone(), shared.clone(), stop.clone(), ctx.clone());
        let handle = tokio::spawn(async move {
            if let Err(error) = engine
                .run(host.clone(), &worker_ctx, &worker_job, &worker_stop)
                .await
            {
                let _ = update(&worker_ctx.cache, &worker_job, |job| {
                    job.state = if worker_stop.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    job.can_dismiss_recovery = worker_ctx.cache.pending().ok().flatten().is_some();
                    job.error = Some(error);
                    job.message = "本轮未全部完成；已核验批次保留，未核验结果未发布".into();
                });
            }
            host.post(json!({"type":"strata-job","job":worker_job.lock().unwrap().clone()}));
        });
        jobs.insert(
            ctx.key,
            Running {
                stop,
                job: shared,
                handle,
            },
        );
        Ok(response)
    }

    async fn run(
        &self,
        host: Arc<dyn Host>,
        ctx: &Context,
        shared: &Arc<Mutex<Job>>,
        stop: &AtomicBool,
    ) -> Result<(), String> {
        let initial = shared.lock().unwrap().clone();
        let started = Instant::now();
        let frozen = index::snapshot(host.as_ref(), Some(&initial.range)).await?;
        Self::same_vault(host.as_ref(), ctx).await?;
        let mut files = frozen.files.clone();
        files.sort_by(|a, b| {
            b.file_priority
                .total_cmp(&a.file_priority)
                .then_with(|| a.file_key.cmp(&b.file_key))
        });
        update(&ctx.cache, shared, |job| job.selected = files.len())?;
        let mut admitted = 0;
        for file in files {
            if stop.load(Ordering::Acquire) {
                break;
            }
            let current = shared.lock().unwrap().clone();
            if admitted >= current.budget.max_files
                || current.input_bytes >= current.budget.max_bytes
                || started.elapsed().as_secs() >= current.budget.max_seconds
            {
                break;
            }
            if file.confidentiality == Confidentiality::Confidential
                && !current.include_confidential
            {
                update(&ctx.cache, shared, |j| j.skipped += 1)?;
                continue;
            }
            let cached = ctx.cache.source(&file)?;
            if cached
                .as_ref()
                .is_some_and(|c| c.complete && c.harness == current.harness)
            {
                update(&ctx.cache, shared, |j| j.reused += 1)?;
                continue;
            }
            admitted += 1;
            let result = self
                .extract_file(
                    host.clone(),
                    ctx,
                    &frozen.snapshot_id,
                    &frozen.config_hash,
                    file,
                    shared,
                    stop,
                    started,
                )
                .await;
            if let Err(error) = result {
                update(&ctx.cache, shared, |j| {
                    j.failed += 1;
                    j.error = Some(error.clone());
                })?;
                // Uncertain remote jobs keep their receipt and fence a second start.
                if ctx.cache.pending()?.is_some() {
                    return Err(error);
                }
            }
            host.post(json!({"type":"strata-job","job":shared.lock().unwrap().clone()}));
        }
        update(&ctx.cache, shared, |job| {
            job.stop_requested = stop.load(Ordering::Acquire);
            job.state = if job.stop_requested {
                "cancelled"
            } else if job.failed > 0 || job.processed + job.reused + job.skipped < job.selected {
                "partial"
            } else {
                "done"
            }
            .into();
            job.message = if job.stop_requested {
                "已停止后续批次，未发布取消后的结果"
            } else {
                "深读已结束；覆盖计数包含预算、排除和失败"
            }
            .into();
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn extract_file(
        &self,
        host: Arc<dyn Host>,
        ctx: &Context,
        snapshot_id: &str,
        config_hash: &str,
        file: File,
        shared: &Arc<Mutex<Job>>,
        stop: &AtomicBool,
        started: Instant,
    ) -> Result<(), String> {
        let mut cursor = None;
        let mut seen = HashSet::new();
        loop {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let job = shared.lock().unwrap().clone();
            if started.elapsed().as_secs() >= job.budget.max_seconds {
                return Ok(());
            }
            let remaining = job.budget.max_bytes.saturating_sub(job.input_bytes);
            if remaining < 256 {
                return Ok(());
            }
            Self::same_vault(host.as_ref(), ctx).await?;
            let page = index::blocks(
                host.as_ref(),
                snapshot_id,
                std::slice::from_ref(&file.file_key),
                cursor.as_deref(),
                remaining.min(task::MAX_BATCH_BYTES),
            )
            .await?;
            if !page.conflicts.is_empty() {
                return Err("来源变化、无法读取或语义段超过单批预算；本文件未完整深读".into());
            }
            let next = page.next_cursor.clone();
            let previous = ctx.cache.source(&file)?;
            let processed: HashSet<_> = previous
                .as_ref()
                .filter(|a| a.harness == job.harness)
                .map(|a| a.processed_blocks.iter().cloned().collect())
                .unwrap_or_default();
            let units: Vec<_> = page
                .units
                .into_iter()
                .filter(|u| !processed.contains(&u.block_key))
                .collect();
            if units.iter().any(|u| u.content_hash != file.content_hash) {
                return Err("来源 hash 已改变".into());
            }
            if units.iter().any(|u| task::contains_secret(&u.text)) {
                return Err("本批含疑似凭据，未发送 Agent".into());
            }
            let bytes: usize = units.iter().map(|u| u.text.len()).sum();
            if bytes > remaining || bytes > task::MAX_BATCH_BYTES {
                return Err("索引正文超过本次明确预算".into());
            }
            if !units.is_empty() {
                let packet = task::Packet::new(file.clone(), units);
                let mut pending = Pending {
                    job_id: job.id.clone(),
                    snapshot_id: snapshot_id.into(),
                    config_hash: config_hash.into(),
                    packet,
                    run_id: None,
                };
                if stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                ctx.cache.save_pending(&pending)?;
                update(&ctx.cache, shared, |j| {
                    j.input_bytes += bytes;
                    j.invocation_id = Some(pending.packet.invocation_id.clone());
                    j.message = "正在按已选择范围深读原文…".into();
                })?;
                let prompt = pending.packet.prompt()?;
                let response = host.request("host.agent.run",json!({"task":task::TASK,"harness":job.harness,"prompt":prompt,"invocation_id":pending.packet.invocation_id,"input_hash":task::hash(&prompt)})).await
                    .map_err(|_| "Agent 启动回执未确认；未自动重试以避免重复运行".to_string())?;
                let run_id = response["run_id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("Agent 未提供 run_id，启动结果未确认")?
                    .to_string();
                pending.run_id = Some(run_id.clone());
                ctx.cache.save_pending(&pending)?;
                update(&ctx.cache, shared, |j| {
                    j.run_id = Some(run_id);
                    j.model = response["resolved_model"].as_str().map(str::to_string);
                })?;
                let status = self
                    .poll(host.as_ref(), ctx, &pending, shared, stop, started)
                    .await?;
                if stop.load(Ordering::Acquire) {
                    ctx.cache.clear_pending()?;
                    return Ok(());
                }
                let validated = task::terminal_content(&status)
                    .and_then(|text| task::validate_output(text, &pending.packet));
                match validated {
                    Ok((nodes, relations)) => {
                        if let Err(error) = self.revalidate(host.as_ref(), ctx, &pending).await {
                            ctx.cache.clear_pending()?;
                            return Err(error);
                        }
                        if stop.load(Ordering::Acquire) {
                            ctx.cache.clear_pending()?;
                            return Ok(());
                        }
                        let _guard = self.cache_gate.lock().unwrap();
                        if stop.load(Ordering::Acquire) {
                            ctx.cache.clear_pending()?;
                            return Ok(());
                        }
                        let before = ctx.cache.source(&file)?.map(|a| a.nodes.len()).unwrap_or(0);
                        publish(
                            &ctx.cache,
                            &pending.packet,
                            &job.harness,
                            shared.lock().unwrap().model.clone(),
                            nodes,
                            relations,
                            next.is_none(),
                        )?;
                        ctx.cache.clear_pending()?;
                        update(&ctx.cache, shared, |j| {
                            j.nodes += ctx
                                .cache
                                .source(&file)
                                .ok()
                                .flatten()
                                .map(|a| a.nodes.len().saturating_sub(before))
                                .unwrap_or(0);
                            j.run_id = None;
                            j.invocation_id = None;
                        })?;
                    }
                    Err(error) => {
                        ctx.cache.clear_pending()?;
                        return Err(error);
                    }
                }
            }
            if next.is_none() {
                if let Some(mut artifact) = ctx.cache.source(&file)? {
                    artifact.complete = true;
                    ctx.cache.save_source(&artifact)?;
                }
                update(&ctx.cache, shared, |j| j.processed += 1)?;
                return Ok(());
            }
            let value = next.unwrap();
            if !seen.insert(value.clone()) {
                return Err("正文游标重复".into());
            }
            cursor = Some(value);
        }
    }

    async fn poll(
        &self,
        host: &dyn Host,
        ctx: &Context,
        pending: &Pending,
        shared: &Arc<Mutex<Job>>,
        stop: &AtomicBool,
        started: Instant,
    ) -> Result<Value, String> {
        let job = shared.lock().unwrap().clone();
        let run_id = pending
            .run_id
            .as_ref()
            .ok_or("无法恢复缺少 run_id 的远程任务")?;
        loop {
            Self::same_vault(host, ctx).await?;
            let status = host
                .request(
                    "host.agent.status",
                    json!({"task":task::TASK,"harness":job.harness,"run_id":run_id}),
                )
                .await
                .map_err(|_| "远程状态暂不可用；保留回执供下次恢复".to_string())?;
            match status["state"].as_str() {
                Some("done") => return Ok(status),
                Some("running") => {}
                _ => return Err("远程任务状态未知，未启动后续批次".into()),
            }
            if stop.load(Ordering::Acquire) {
                // Retain run_id until its terminal state is known. A restart
                // can poll it, but will never publish a cancelled result.
                return Err("已停止排队；当前 Agent 仍可能运行，已保留回执".into());
            }
            if started.elapsed().as_secs() >= job.budget.max_seconds {
                return Err("已到本次时间预算；远程批次可能仍运行，已保留回执".into());
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    async fn revalidate(
        &self,
        host: &dyn Host,
        ctx: &Context,
        pending: &Pending,
    ) -> Result<(), String> {
        Self::same_vault(host, ctx).await?;
        let mut cursor = None;
        let mut found = HashSet::new();
        let mut seen = HashSet::new();
        loop {
            let page = index::blocks(
                host,
                &pending.snapshot_id,
                std::slice::from_ref(&pending.packet.source.file_key),
                cursor.as_deref(),
                4 * 1024 * 1024,
            )
            .await?;
            if !page.conflicts.is_empty() {
                return Err("来源已变化或失去权限，候选结果已撤回".into());
            }
            for unit in page.units {
                if unit.content_hash != pending.packet.source.content_hash {
                    return Err("来源 hash 已漂移".into());
                }
                if let Some(old) = pending
                    .packet
                    .units
                    .iter()
                    .find(|u| u.block_key == unit.block_key)
                {
                    if old.text != unit.text
                        || old.line_start != unit.line_start
                        || old.line_end != unit.line_end
                    {
                        return Err("冻结原文与当前来源不一致".into());
                    }
                    found.insert(unit.block_key);
                }
            }
            if found.len() == pending.packet.units.len() {
                return Ok(());
            }
            match page.next_cursor {
                Some(next) if seen.insert(next.clone()) => cursor = Some(next),
                _ => return Err("来源不再包含本次证据块".into()),
            }
        }
    }

    async fn recover(self: &Arc<Self>, host: Arc<dyn Host>, ctx: Context) -> Result<(), String> {
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.get(&ctx.key).is_some_and(|r| !r.handle.is_finished()) {
            return Ok(());
        }
        let Some(mut job) = ctx.cache.job()? else {
            return Ok(());
        };
        let Some(pending) = ctx.cache.pending()? else {
            if job.running() {
                job.state = "interrupted".into();
                job.message = "上次进程中断；已完成缓存保留，未自动重启剩余批次".into();
                ctx.cache.save_job(&job)?;
            }
            return Ok(());
        };
        if pending.run_id.is_none() {
            job.state = "interrupted".into();
            job.can_dismiss_recovery = true;
            job.message =
                "上次启动没有取得远程 run_id；请在 Agent 中核实，不能安全自动重复运行".into();
            ctx.cache.save_job(&job)?;
            return Ok(());
        }
        if job.id != pending.job_id {
            return Err("任务恢复回执不匹配".into());
        }
        let was_cancelled = job.stop_requested || job.state == "cancelled";
        job.state = "recovering".into();
        job.can_dismiss_recovery = false;
        job.message = "正在核实上次远程批次；不会重启或发送新原文".into();
        ctx.cache.save_job(&job)?;
        let shared = Arc::new(Mutex::new(job));
        let stop = Arc::new(AtomicBool::new(was_cancelled));
        let (engine, sj, ss, sc) = (self.clone(), shared.clone(), stop.clone(), ctx.clone());
        let handle = tokio::spawn(async move {
            let result = async {
                let status = engine
                    .poll(host.as_ref(), &sc, &pending, &sj, &ss, Instant::now())
                    .await?;
                if ss.load(Ordering::Acquire) {
                    sc.cache.clear_pending()?;
                    return Ok::<_, String>(());
                }
                let validated = task::terminal_content(&status)
                    .and_then(|text| task::validate_output(text, &pending.packet));
                let (nodes, relations) = match validated {
                    Ok(v) => v,
                    Err(e) => {
                        sc.cache.clear_pending()?;
                        return Err(e);
                    }
                };
                if let Err(error) = engine.revalidate(host.as_ref(), &sc, &pending).await {
                    sc.cache.clear_pending()?;
                    return Err(error);
                }

                let j = sj.lock().unwrap().clone();
                let _guard = engine.cache_gate.lock().unwrap();
                if ss.load(Ordering::Acquire) {
                    sc.cache.clear_pending()?;
                    return Ok(());
                }
                publish(
                    &sc.cache,
                    &pending.packet,
                    &j.harness,
                    j.model,
                    nodes,
                    relations,
                    false,
                )?;
                sc.cache.clear_pending()?;
                Ok(())
            }
            .await;
            let _ = update(&sc.cache, &sj, |j| {
                j.state = if ss.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "interrupted"
                }
                .into();
                j.error = result.err();
                j.can_dismiss_recovery = sc.cache.pending().ok().flatten().is_some();
                j.message = if j.error.is_some() {
                    "上次批次未通过核实；已完成缓存保留，未发布此批结果"
                } else {
                    "已核实上次批次；剩余文件需再次选择深读，已完成部分会复用"
                }
                .into();
            });
            host.post(json!({"type":"strata-job","job":sj.lock().unwrap().clone()}));
        });
        jobs.insert(
            ctx.key,
            Running {
                stop,
                job: shared,
                handle,
            },
        );
        Ok(())
    }

    async fn check_cached_sources(
        &self,
        host: &dyn Host,
        ctx: &Context,
        atlas: &IndexSnapshot,
        range: &DateRange,
    ) -> Result<HashSet<String>, String> {
        let mut candidates = Vec::new();
        for file in &atlas.files {
            if file
                .doc_date
                .as_deref()
                .is_some_and(|date| range.contains(date))
                && ctx.cache.source(file)?.is_some()
            {
                candidates.push(file);
            }
        }
        if candidates.is_empty() {
            return Ok(HashSet::new());
        }
        let current = index::snapshot(host, Some(range)).await?;
        if current.config_hash != atlas.config_hash {
            return Err("索引策略已变化，请刷新".into());
        }
        candidates.sort_by(|a, b| {
            b.file_priority
                .total_cmp(&a.file_priority)
                .then_with(|| a.file_key.cmp(&b.file_key))
        });
        let mut proof_bytes = 0;
        let mut checked = HashSet::new();
        for file in candidates.into_iter().take(500) {
            let remaining = (16 * 1024 * 1024usize).saturating_sub(proof_bytes);
            if remaining < 256 {
                break;
            }
            if !current
                .files
                .iter()
                .any(|f| f.file_key == file.file_key && f.content_hash == file.content_hash)
            {
                ctx.cache.invalidate_source(file)?;
                continue;
            }
            let page = index::blocks(
                host,
                &current.snapshot_id,
                std::slice::from_ref(&file.file_key),
                None,
                remaining.min(4 * 1024 * 1024),
            )
            .await?;
            proof_bytes += page.units.iter().map(|u| u.text.len()).sum::<usize>();
            if page.conflicts.iter().any(|c| c["reason"] != "too_large")
                || page
                    .units
                    .iter()
                    .any(|u| u.content_hash != file.content_hash)
            {
                ctx.cache.invalidate_source(file)?;
                continue;
            }
            if page.units.is_empty() {
                continue;
            }
            checked.insert(file.file_key.clone());
        }
        Self::same_vault(host, ctx).await?;
        Ok(checked)
    }

    async fn open_source(
        &self,
        host: &dyn Host,
        ctx: &Context,
        params: &Value,
    ) -> Result<Value, String> {
        let range = DateRange {
            from: params["from"].as_str().ok_or("缺少日期")?.into(),
            to: params["to"].as_str().ok_or("缺少日期")?.into(),
        };
        range.validate()?;
        let index = index::snapshot(host, Some(&range)).await?;
        Self::same_vault(host, ctx).await?;
        let node_id = params["nodeId"].as_str().ok_or("缺少知识点")?;
        let evidence_id = params["evidenceId"].as_str();
        for file in index.files {
            if evidence_id.is_none()
                && (node_id == format!("candidate:{}", &file.content_hash[..24])
                    || ctx
                        .cache
                        .source(&file)?
                        .is_some_and(|a| a.nodes.iter().any(|n| n.id == node_id)))
            {
                let page = index::blocks(
                    host,
                    &index.snapshot_id,
                    std::slice::from_ref(&file.file_key),
                    None,
                    4 * 1024 * 1024,
                )
                .await?;
                if !page.conflicts.is_empty()
                    || page
                        .units
                        .iter()
                        .any(|u| u.content_hash != file.content_hash)
                {
                    return Err("来源已变化，无法打开旧候选".into());
                }
                Self::same_vault(host, ctx).await?;
                return Ok(
                    json!({"path":file.path,"sourceId":file.file_key,"contentHash":file.content_hash}),
                );
            }
            if let Some(artifact) = ctx.cache.source(&file)? {
                if let Some(evidence) =
                    artifact
                        .nodes
                        .iter()
                        .find(|n| n.id == node_id)
                        .and_then(|n| {
                            n.evidence
                                .iter()
                                .find(|e| Some(e.id.as_str()) == evidence_id)
                        })
                {
                    let mut cursor = None;
                    let mut seen = HashSet::new();
                    loop {
                        let page = index::blocks(
                            host,
                            &index.snapshot_id,
                            std::slice::from_ref(&file.file_key),
                            cursor.as_deref(),
                            4 * 1024 * 1024,
                        )
                        .await?;
                        if !page.conflicts.is_empty() {
                            return Err("原文已变化，不能打开旧证据".into());
                        }
                        if let Some(unit) = page
                            .units
                            .iter()
                            .find(|u| u.block_key == evidence.block_key)
                        {
                            if unit.content_hash != evidence.content_hash
                                || !unit.text.contains(&evidence.quote)
                            {
                                return Err("原文引文已过期，请刷新".into());
                            }
                            Self::same_vault(host, ctx).await?;
                            return Ok(json!(evidence));
                        }
                        match page.next_cursor {
                            Some(next) if seen.insert(next.clone()) => cursor = Some(next),
                            _ => return Err("原文证据块已失效".into()),
                        }
                    }
                }
            }
        }
        Err("来源已删除、越出日期范围或没有当前授权".into())
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
fn update(
    cache: &Cache,
    shared: &Arc<Mutex<Job>>,
    change: impl FnOnce(&mut Job),
) -> Result<(), String> {
    let mut job = shared.lock().unwrap();
    change(&mut job);
    job.updated_at = now();
    cache.save_job(&job)
}
fn publish(
    cache: &Cache,
    packet: &task::Packet,
    harness: &str,
    model: Option<String>,
    nodes: Vec<Node>,
    relations: Vec<Relation>,
    complete: bool,
) -> Result<(), String> {
    let mut artifact = cache
        .source(&packet.source)?
        .filter(|a| a.harness == harness)
        .unwrap_or(Artifact {
            schema: "notemd.strata/artifact/v1".into(),
            rule: task::RULE.into(),
            source: packet.source.clone(),
            harness: harness.into(),
            model: model.clone(),
            nodes: Vec::new(),
            relations: Vec::new(),
            processed_blocks: Vec::new(),
            complete: false,
        });
    for node in nodes {
        if let Some(old) = artifact.nodes.iter_mut().find(|n| n.id == node.id) {
            for ev in node.evidence {
                if !old.evidence.iter().any(|e| e.id == ev.id) {
                    old.evidence.push(ev);
                }
            }
        } else {
            artifact.nodes.push(node);
        }
    }
    for relation in relations {
        if !artifact.relations.iter().any(|r| r.id == relation.id) {
            artifact.relations.push(relation);
        }
    }
    for unit in &packet.units {
        if !artifact.processed_blocks.contains(&unit.block_key) {
            artifact.processed_blocks.push(unit.block_key.clone());
        }
    }
    artifact.model = model;
    artifact.complete = complete;
    cache.save_source(&artifact)
}

fn assemble(
    ctx: &Context,
    index: IndexSnapshot,
    range: DateRange,
    job: Option<Job>,
    checked: Option<&HashSet<String>>,
) -> Result<Snapshot, String> {
    let stale = ctx.cache.prune(&index.files)?;
    let mut coverage = Coverage {
        indexed: index.files.len(),
        stale,
        excluded: index.coverage["excluded"].as_u64().unwrap_or(0) as usize,
        ..Coverage::default()
    };
    let mut groups: BTreeMap<String, Vec<(&File, Option<Artifact>)>> = BTreeMap::new();
    for file in &index.files {
        let mut artifact = ctx.cache.source(file)?;
        let proof_current = checked.is_none_or(|set| set.contains(&file.file_key));
        if !proof_current {
            if let Some(a) = artifact.as_mut() {
                for n in &mut a.nodes {
                    n.evidence.clear();
                    n.state = "candidate".into();
                    n.owner_specificity = OwnerSpecificity::Unknown;
                    n.classification_reason = "已有抽取缓存，尚未在本次范围核对来源 SHA".into();
                }
                a.relations.clear();
            }
        }
        if file
            .doc_date
            .as_ref()
            .is_some_and(|date| range.contains(date))
        {
            coverage.selected += 1;
            if !proof_current && artifact.is_some() {
                coverage.proof_deferred += 1;
            }
            if proof_current && artifact.as_ref().is_some_and(|a| a.complete) {
                coverage.processed += 1;
            } else {
                coverage.candidate += 1;
            }
            if file.date_inferred {
                coverage.date_inferred += 1;
            }
            match file.confidentiality {
                Confidentiality::Confidential => coverage.confidential += 1,
                Confidentiality::Unknown => coverage.unknown_confidentiality += 1,
                _ => {}
            }
        }
        groups
            .entry(file.content_hash.clone())
            .or_default()
            .push((file, artifact));
    }
    let mut nodes = Vec::new();
    let mut relations = Vec::new();
    for (hash, files) in groups {
        let mut group_nodes: BTreeMap<String, Node> = BTreeMap::new();
        let mut group_relations: BTreeMap<String, Relation> = BTreeMap::new();
        for (file, artifact) in &files {
            if let Some(a) = artifact {
                for node in &a.nodes {
                    let mut node = node.clone();
                    if file.confidentiality == Confidentiality::Confidential {
                        node.confidentiality = Confidentiality::Confidential;
                    }
                    match group_nodes.get_mut(&node.id) {
                        Some(old) if old.evidence.is_empty() && !node.evidence.is_empty() => {
                            *old = node
                        }
                        Some(old) => {
                            if node.confidentiality == Confidentiality::Confidential {
                                old.confidentiality = Confidentiality::Confidential;
                            }
                        }
                        None => {
                            group_nodes.insert(node.id.clone(), node);
                        }
                    }
                }
                for relation in &a.relations {
                    group_relations
                        .entry(relation.id.clone())
                        .or_insert(relation.clone());
                }
            }
        }
        if group_nodes.is_empty() {
            let file = files[0].0;
            let id = format!("candidate:{}", &hash[..24]);
            let title = file
                .title
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    file.path
                        .rsplit('/')
                        .next()
                        .unwrap_or(&file.path)
                        .trim_end_matches(".md")
                        .to_string()
                });
            group_nodes.insert(
                id.clone(),
                Node {
                    id,
                    title,
                    kind: "document".into(),
                    state: "candidate".into(),
                    features: file.tags.clone(),
                    links: file.links.iter().map(|l| l.target.clone()).collect(),
                    owner_specificity: OwnerSpecificity::Unknown,
                    confidentiality: if files
                        .iter()
                        .any(|(f, _)| f.confidentiality == Confidentiality::Confidential)
                    {
                        Confidentiality::Confidential
                    } else {
                        file.confidentiality
                    },
                    classification_reason: "仅索引标题/标签，尚未核对本人归属".into(),
                    epistemic: "unknown".into(),
                    speaker: None,
                    conditions: Vec::new(),
                    limits: Vec::new(),
                    source_groups: Vec::new(),
                    evidence: Vec::new(),
                },
            );
        }
        let canonical_ids: Vec<_> = group_nodes.keys().cloned().collect();
        let mut dates: Vec<_> = files
            .iter()
            .filter_map(|(f, _)| f.doc_date.clone())
            .collect();
        dates.sort();
        dates.dedup();
        let priority = files
            .iter()
            .map(|(f, _)| f.file_priority)
            .fold(0.0, f64::max);
        let version = task::hash(format!(
            "{}\0{}\0{}\0{:?}",
            task::RULE,
            index.config_hash,
            priority,
            canonical_ids
        ));
        let support = SourceSupport {
            group_id: format!("source:{hash}"),
            group_version: version,
            priority,
            dates,
            canonical_ids,
        };
        for mut node in group_nodes.into_values() {
            if files
                .iter()
                .any(|(f, _)| f.confidentiality == Confidentiality::Confidential)
            {
                node.confidentiality = Confidentiality::Confidential;
            }
            node.source_groups = vec![support.clone()];
            nodes.push(node);
        }
        relations.extend(group_relations.into_values());
    }
    Ok(Snapshot {
        schema: "notemd.strata/snapshot/v1",
        vault_key: ctx.key.clone(),
        snapshot_id: index.snapshot_id,
        config_hash: index.config_hash,
        as_of: index.as_of,
        range,
        files: index.files,
        nodes,
        relations,
        coverage,
        job,
    })
}
