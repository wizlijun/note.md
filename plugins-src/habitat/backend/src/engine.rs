use crate::{capture, rpc::Host};
use habitat_core::{extract::Extractor, hash, FocusContext, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub state: String,
    pub phase: String,
    pub message: String,
    pub processed: usize,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_status: Option<String>,
}
struct Run {
    job: Job,
    stop: Arc<AtomicBool>,
}
#[derive(Clone)]
struct Context {
    key: String,
    vault_id: String,
    cache: PathBuf,
}
pub struct Engine {
    data_dir: Mutex<Option<PathBuf>>,
    runs: Mutex<HashMap<String, Run>>,
    previews: Mutex<HashMap<String, Snapshot>>,
}

fn atomic_cache_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("缓存路径缺少父目录")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
// Freeze one local observation day and offset for the whole run. Capture and
// parsing can cross midnight without changing the interpretation halfway through.
fn focus_context(
    params: &Value,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> Result<FocusContext, String> {
    let window_days = match params.get("windowDays") {
        None => 30,
        Some(value) => value
            .as_u64()
            .filter(|n| matches!(n, 7 | 30 | 90))
            .ok_or("关注范围仅支持最近 7、30 或 90 天")? as u32,
    };
    Ok(FocusContext {
        as_of: now.date_naive().to_string(),
        window_days,
        utc_offset_minutes: now.offset().local_minus_utc() / 60,
    })
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
            runs: Mutex::new(HashMap::new()),
            previews: Mutex::new(HashMap::new()),
        }
    }
    pub fn initialize(&self, params: &Value) -> Result<(), String> {
        let data = PathBuf::from(params["data_dir"].as_str().ok_or("缺少插件缓存目录")?);
        if !data.is_absolute() {
            return Err("缓存目录必须为绝对路径".into());
        }
        *self.data_dir.lock().unwrap() = Some(data);
        Ok(())
    }
    pub fn shutdown(&self) {
        for run in self.runs.lock().unwrap().values() {
            run.stop.store(true, Ordering::Release);
        }
    }
    async fn context(&self, host: &dyn Host) -> Result<Context, String> {
        let info = host.request("host.vault.info", json!({})).await?;
        info["root"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("请先打开 Vault")?;
        let key = info["vaultKey"]
            .as_str()
            .filter(|s| habitat_core::codec::valid_hash(s))
            .ok_or("需要包含知识结构接口的新版 note.md 宿主")?
            .to_string();
        let vault_id = capture::read(host, ".notemd/vault-id")
            .await?
            .trim()
            .to_string();
        if vault_id.is_empty() || vault_id.len() > 128 {
            return Err("Vault 持久身份无效".into());
        }
        let data = self
            .data_dir
            .lock()
            .unwrap()
            .clone()
            .ok_or("插件未初始化")?;
        Ok(Context {
            key: key.clone(),
            vault_id,
            cache: data.join(&key),
        })
    }
    async fn same(host: &dyn Host, ctx: &Context) -> Result<(), String> {
        let info = host.request("host.vault.info", json!({})).await?;
        if info["vaultKey"].as_str() != Some(ctx.key.as_str()) {
            return Err("Vault 已切换，本次生成已停止".into());
        }
        Ok(())
    }
    fn job(&self, key: &str) -> Option<Job> {
        self.runs.lock().unwrap().get(key).map(|r| r.job.clone())
    }
    fn preview(&self, ctx: &Context) -> Option<Snapshot> {
        if let Some(snapshot) = self
            .previews
            .lock()
            .unwrap()
            .get(&ctx.key)
            .filter(|s| s.meta.vault_id == ctx.vault_id)
            .cloned()
        {
            return Some(snapshot);
        }
        let id = std::fs::read_to_string(ctx.cache.join("preview-current")).ok()?;
        if !habitat_core::codec::valid_hash(id.trim()) {
            return None;
        }
        let bytes = std::fs::read(
            ctx.cache
                .join("previews")
                .join(format!("{}.jsonl.zst", id.trim())),
        )
        .ok()?;
        let snapshot = habitat_core::decode(&bytes).ok()?;
        if snapshot.meta.vault_id != ctx.vault_id || snapshot.meta.snapshot_id != id.trim() {
            return None;
        }
        self.previews
            .lock()
            .unwrap()
            .insert(ctx.key.clone(), snapshot.clone());
        Some(snapshot)
    }
    fn progress(&self, ctx: &Context, phase: &str, message: &str, processed: usize, total: usize) {
        if let Some(run) = self.runs.lock().unwrap().get_mut(&ctx.key) {
            run.job.phase = phase.into();
            run.job.message = message.into();
            run.job.processed = processed;
            run.job.total = total;
        }
    }
    fn forget_preview(&self, ctx: &Context, id: &str) {
        if !habitat_core::codec::valid_hash(id) {
            return;
        }
        let mut previews = self.previews.lock().unwrap();
        if previews
            .get(&ctx.key)
            .is_some_and(|s| s.meta.snapshot_id == id)
        {
            previews.remove(&ctx.key);
        }
        let pointer = ctx.cache.join("preview-current");
        if std::fs::read_to_string(&pointer).ok().as_deref() == Some(id) {
            let _ = std::fs::remove_file(pointer);
        }
        let _ = std::fs::remove_file(ctx.cache.join("previews").join(format!("{id}.jsonl.zst")));
    }
    async fn load(host: &dyn Host, ctx: &Context) -> Result<Value, String> {
        host.request("host.knowledge.load", json!({"vaultKey":ctx.key}))
            .await
    }
    async fn snapshot(
        host: &dyn Host,
        ctx: &Context,
        commit: Option<&str>,
    ) -> Result<Option<Snapshot>, String> {
        let value = if let Some(commit) = commit {
            host.request(
                "host.knowledge.read",
                json!({"vaultKey":ctx.key,"commit":commit}),
            )
            .await?
        } else {
            Self::load(host, ctx).await?
        };
        if value["snapshot"].is_null() {
            return Ok(None);
        }
        let snapshot: Snapshot = serde_json::from_value(value["snapshot"].clone())
            .map_err(|e| format!("快照格式无效: {e}"))?;
        habitat_core::validate(&snapshot)?;
        if snapshot.meta.vault_id != ctx.vault_id {
            return Err("快照不属于当前 Vault".into());
        }
        Ok(Some(snapshot))
    }
    pub async fn handle(
        self: &Arc<Self>,
        host: Arc<dyn Host>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let ctx = self.context(host.as_ref()).await?;
        let method = method.strip_prefix("plugin.").unwrap_or(method);
        match method {
            "state" => {
                let loaded = Self::load(host.as_ref(), &ctx).await;
                let (snapshot, pending, available, error) = match loaded {
                    Ok(v) => (
                        v["snapshot"].clone(),
                        v["pending"].as_bool().unwrap_or(false),
                        true,
                        None,
                    ),
                    Err(e) => (Value::Null, false, false, Some(e)),
                };
                let preview = self.preview(&ctx).filter(|s| {
                    snapshot["meta"]["snapshotId"].as_str() != Some(s.meta.snapshot_id.as_str())
                });
                Self::same(host.as_ref(), &ctx).await?;
                Ok(
                    json!({"vaultKey":ctx.key,"snapshot":snapshot,"preview":preview,"job":self.job(&ctx.key),"pending":pending,"historyAvailable":available,"historyError":error}),
                )
            }
            "generate" => {
                let focus = focus_context(&params, chrono::Local::now().fixed_offset())?;
                let mut runs = self.runs.lock().unwrap();
                if runs.get(&ctx.key).is_some_and(|r| r.job.state == "running") {
                    return Err("已有一次解析正在运行".into());
                }
                let stop = Arc::new(AtomicBool::new(false));
                let job = Job {
                    id: hash(format!(
                        "{}:{}",
                        ctx.key,
                        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    )),
                    state: "running".into(),
                    phase: "capture".into(),
                    message: "正在捕获来源清单".into(),
                    processed: 0,
                    total: 0,
                    error: None,
                    snapshot_id: None,
                    save_status: None,
                };
                runs.insert(
                    ctx.key.clone(),
                    Run {
                        job: job.clone(),
                        stop: stop.clone(),
                    },
                );
                drop(runs);
                let engine = self.clone();
                tokio::spawn(async move {
                    let result = engine
                        .generate(host.clone(), ctx.clone(), stop.clone(), focus)
                        .await;
                    if let Some(run) = engine.runs.lock().unwrap().get_mut(&ctx.key) {
                        match result {
                            Ok((id, status)) => {
                                run.job.state = "complete".into();
                                run.job.phase = "complete".into();
                                run.job.message = if status == "unchanged" {
                                    "结构没有变化，沿用已有版本"
                                } else {
                                    "知识结构已保存到 Git"
                                }
                                .into();
                                run.job.snapshot_id = Some(id);
                                run.job.save_status = Some(status);
                            }
                            Err(error) => {
                                let cancelled = stop.load(Ordering::Acquire);
                                run.job.state =
                                    if cancelled { "cancelled" } else { "failed" }.into();
                                run.job.message = if cancelled {
                                    "已取消，保留上个已保存版本"
                                } else {
                                    "本次解析未完成保存"
                                }
                                .into();
                                run.job.error = Some(error);
                            }
                        }
                        host.post(json!({"type":"habitat-job","job":run.job}));
                    }
                });
                Ok(json!(job))
            }
            "job" => Ok(json!(self.job(&ctx.key))),
            "cancel" => {
                if let Some(run) = self.runs.lock().unwrap().get_mut(&ctx.key) {
                    if run.job.state == "running" && run.job.phase == "save" {
                        return Err("正在完成 Git 保存事务，请等待保存结果".into());
                    }
                    if run.job.state == "running" {
                        run.stop.store(true, Ordering::Release);
                        run.job.message = "正在停止；已保存版本保持可用".into();
                    }
                }
                Ok(json!(self.job(&ctx.key)))
            }
            "history" => {
                host.request(
                    "host.knowledge.history",
                    json!({"vaultKey":ctx.key,"limit":100}),
                )
                .await
            }
            "read_version" => {
                let snapshot =
                    Self::snapshot(host.as_ref(), &ctx, params["commit"].as_str()).await?;
                Self::same(host.as_ref(), &ctx).await?;
                Ok(json!({"snapshot":snapshot}))
            }
            "diff" => {
                let before = Self::snapshot(
                    host.as_ref(),
                    &ctx,
                    Some(params["fromCommit"].as_str().ok_or("缺少起始版本")?),
                )
                .await?
                .ok_or("起始版本不存在")?;
                let after = Self::snapshot(host.as_ref(), &ctx, params["toCommit"].as_str())
                    .await?
                    .ok_or("目标版本不存在")?;
                Self::same(host.as_ref(), &ctx).await?;
                serde_json::to_value(habitat_core::diff::compare(&before, &after)?)
                    .map_err(|e| e.to_string())
            }
            "retry_save" => {
                let saved = host
                    .request("host.knowledge.recover", json!({"vaultKey":ctx.key}))
                    .await?;
                if matches!(saved["status"].as_str(), Some("saved" | "unchanged")) {
                    if let Some(id) = saved["snapshotId"].as_str() {
                        self.forget_preview(&ctx, id);
                    }
                }
                Ok(saved)
            }
            "discard_pending" => {
                host.request("host.knowledge.discard", json!({"vaultKey":ctx.key}))
                    .await
            }
            "open_source" => {
                let snapshot = if params["preview"].as_bool() == Some(true) {
                    self.preview(&ctx).ok_or("未保存预览已失效")?
                } else {
                    Self::snapshot(host.as_ref(), &ctx, params["commit"].as_str())
                        .await?
                        .ok_or("没有已保存的结构")?
                };
                let id = params["evidenceId"].as_str().ok_or("缺少证据标识")?;
                let evidence = snapshot
                    .evidence
                    .iter()
                    .find(|e| e.id == id)
                    .ok_or("证据不在所选版本中")?;
                let source = snapshot
                    .sources
                    .iter()
                    .find(|s| s.id == evidence.source)
                    .ok_or("来源记录缺失")?;
                let content = capture::read(host.as_ref(), &source.path).await?;
                if hash(&content) != source.hash {
                    return Err(
                        "原文已变化，当前文件不能冒充此版本的证据。请在编辑器查看文件历史。".into(),
                    );
                }
                Self::same(host.as_ref(), &ctx).await?;
                Ok(json!({"path":source.path,"locator":evidence.locator}))
            }
            _ => Err("未知 HABITAT 操作".into()),
        }
    }
    async fn generate(
        self: &Arc<Self>,
        host: Arc<dyn Host>,
        ctx: Context,
        stop: Arc<AtomicBool>,
        focus: FocusContext,
    ) -> Result<(String, String), String> {
        let state = Self::load(host.as_ref(), &ctx).await?;
        if state["pending"].as_bool() == Some(true) {
            return Err("先重试保存待存版本，或保留草稿后重新解析".into());
        }
        let previous: Option<Snapshot> = if state["snapshot"].is_null() {
            None
        } else {
            Some(serde_json::from_value(state["snapshot"].clone()).map_err(|_| "上一版格式无效")?)
        };
        if let Some(old) = &previous {
            habitat_core::validate(old)?;
            if old.meta.vault_id != ctx.vault_id {
                return Err("上一版不属于当前 Vault".into());
            }
        }
        let capture = capture::capture(host.as_ref(), &stop).await?;
        let mut extractor = Extractor::new(&ctx.vault_id, &capture.inputs, previous.as_ref());
        extractor.set_focus(focus)?;
        let total = capture.inputs.len();
        let mut bytes = 0usize;
        for (i, input) in capture.inputs.iter().enumerate() {
            if stop.load(Ordering::Acquire) {
                return Err("已取消".into());
            }
            if i % 25 == 0 {
                self.progress(&ctx, "parse", "正在解析节点、来源和显式联系", i, total);
                Self::same(host.as_ref(), &ctx).await?;
            }
            let content = match capture.prefetched.get(&input.path) {
                Some(s) => Ok(s.clone()),
                None => capture::read(host.as_ref(), &input.path).await,
            };
            match content {
                Ok(content) => {
                    bytes += content.len();
                    if bytes > 2 * 1024 * 1024 * 1024 {
                        return Err("来源总量超过 2 GiB 分析预算，未发布部分结果".into());
                    }
                    if let Err(error) = extractor.add_document(&input.path, &content) {
                        if error.starts_with("SOURCE_STALE") {
                            return Err("生成期间来源变化，请重新解析；旧版仍保留".into());
                        }
                        return Err(error);
                    }
                }
                Err(error) => extractor.mark_unavailable(&input.path, &error),
            }
        }
        if stop.load(Ordering::Acquire) {
            return Err("已取消".into());
        }
        self.progress(
            &ctx,
            "organize",
            "正在识别近期概念、形成社区并匹配历史身份",
            total,
            total,
        );
        let data = extractor.finish()?;
        let vault_id = ctx.vault_id.clone();
        let scope_hash = capture.scope_hash.clone();
        let old = previous.clone();
        let snapshot = tokio::task::spawn_blocking(move || {
            habitat_core::organize::build(&vault_id, &scope_hash, data, old.as_ref())
        })
        .await
        .map_err(|e| e.to_string())??;
        if stop.load(Ordering::Acquire) {
            return Err("已取消".into());
        }
        let encoded = habitat_core::encode(&snapshot)?;
        // Failed drafts retain immutable names; a later generation cannot erase
        // the only complete result from an unsuccessful save.
        let draft = ctx
            .cache
            .join("previews")
            .join(format!("{}.jsonl.zst", snapshot.meta.snapshot_id));
        if std::fs::read(&draft).ok().as_deref() != Some(encoded.as_slice()) {
            atomic_cache_write(&draft, &encoded)?;
        }
        atomic_cache_write(
            &ctx.cache.join("preview-current"),
            snapshot.meta.snapshot_id.as_bytes(),
        )?;
        self.previews
            .lock()
            .unwrap()
            .insert(ctx.key.clone(), snapshot.clone());
        self.progress(&ctx, "save", "正在验证来源并保存 Git 版本", total, total);
        Self::same(host.as_ref(), &ctx).await?;
        if stop.load(Ordering::Acquire) {
            return Err("已取消".into());
        }
        let saved=host.request("host.knowledge.save",json!({"vaultKey":ctx.key,"indexSnapshotId":capture.index_id,"expectedBase":previous.as_ref().map(|s|&s.meta.snapshot_id),"content":habitat_core::codec::transport_encode(&encoded)})).await?;
        let status = saved["status"]
            .as_str()
            .filter(|s| matches!(*s, "saved" | "unchanged"))
            .ok_or("保存回执无效，已保留预览；请检查历史后重试")?;
        if saved["snapshotId"].as_str() != Some(snapshot.meta.snapshot_id.as_str()) {
            return Err("保存回执与本次结构不一致，已保留预览".into());
        }
        self.forget_preview(&ctx, &snapshot.meta.snapshot_id);
        Ok((snapshot.meta.snapshot_id, status.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::RequestFuture;
    use std::collections::BTreeMap;
    struct FakeHost {
        files: Mutex<BTreeMap<String, String>>,
        snapshot: Mutex<Option<Snapshot>>,
        versions: Mutex<usize>,
        pending: AtomicBool,
        fail_save: AtomicBool,
        bad_ack: AtomicBool,
        save_started: AtomicBool,
        hold_save: AtomicBool,
    }
    impl FakeHost {
        fn new() -> Self {
            Self{files:Mutex::new(BTreeMap::from([
            (".notemd/vault-id".into(),"vault-test".into()),
            ("dailynote/day.note.md".into(),"- [[Hemory]] 和 [[note.md]]\n  id:: unit-one\n- [[Bushcraft]]\n  id:: unit-two\n".into()),
            ("wikipage/Hemory.note.md".into(),"---\ntitle: Hemory\n---\n- \n".into()),
            ("wikipage/note.md.note.md".into(),"---\ntitle: note.md\n---\n- \n".into()),
        ])),snapshot:Mutex::new(None),versions:Mutex::new(0),pending:AtomicBool::new(false),fail_save:AtomicBool::new(false),bad_ack:AtomicBool::new(false),save_started:AtomicBool::new(false),hold_save:AtomicBool::new(false)}
        }
    }
    impl Host for FakeHost {
        fn request<'a>(&'a self, method: &'a str, params: Value) -> RequestFuture<'a> {
            Box::pin(async move {
                match method {
                    "host.vault.info" => {
                        Ok(json!({"root":"/test/vault","vaultKey":hash("/test/vault")}))
                    }
                    "host.vault.read" => self
                        .files
                        .lock()
                        .unwrap()
                        .get(params["path"].as_str().unwrap())
                        .map(|s| json!({"content":s}))
                        .ok_or_else(|| "missing".into()),
                    "host.vault.exists" => Ok(
                        json!({"exists":self.files.lock().unwrap().contains_key(params["path"].as_str().unwrap())}),
                    ),
                    "host.index.snapshot" => Ok(
                        json!({"snapshotId":"index-one","configHash":"config-one","asOf":"2026-09-30","indexGeneration":"1","mode":"atlas_metadata","nextCursor":null,"freshness":"current","coverage":{"stale":0},
                "files":self.files.lock().unwrap().iter().filter(|(p,_)|!p.starts_with(".notemd/")).map(|(p,s)|json!({"path":p,"contentHash":hash(s),"indexOrigin":"human"})).collect::<Vec<_>>()}),
                    ),
                    "host.knowledge.load" => Ok(
                        json!({"snapshot":*self.snapshot.lock().unwrap(),"pending":self.pending.load(Ordering::Acquire)}),
                    ),
                    "host.knowledge.recover" => Ok(
                        json!({"status":"saved","snapshotId":self.snapshot.lock().unwrap().as_ref().ok_or("no saved snapshot")?.meta.snapshot_id}),
                    ),
                    "host.knowledge.save" => {
                        self.save_started.store(true, Ordering::Release);
                        while self.hold_save.load(Ordering::Acquire) {
                            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                        }
                        if self.bad_ack.load(Ordering::Acquire) {
                            return Ok(json!({}));
                        }
                        if self.fail_save.load(Ordering::Acquire) {
                            return Err("test commit failed".into());
                        }
                        let snapshot =
                            habitat_core::decode(&habitat_core::codec::transport_decode(
                                params["content"].as_str().unwrap(),
                            )?)?;
                        let mut prior = self.snapshot.lock().unwrap();
                        let unchanged = prior
                            .as_ref()
                            .is_some_and(|s| s.meta.snapshot_id == snapshot.meta.snapshot_id);
                        if !unchanged {
                            *self.versions.lock().unwrap() += 1;
                        }
                        *prior = Some(snapshot.clone());
                        Ok(
                            json!({"status":if unchanged{"unchanged"}else{"saved"},"snapshotId":snapshot.meta.snapshot_id}),
                        )
                    }
                    _ => Err(format!("unexpected {method}")),
                }
            })
        }
        fn post(&self, _: Value) {}
    }
    async fn complete(engine: &Arc<Engine>, host: Arc<FakeHost>) -> Job {
        engine
            .handle(host.clone(), "generate", json!({}))
            .await
            .unwrap();
        for _ in 0..400 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            let value = engine.handle(host.clone(), "job", json!({})).await.unwrap();
            let job: Job = serde_json::from_value(value).unwrap();
            if job.state != "running" {
                return job;
            }
        }
        panic!("job timed out")
    }
    #[test]
    fn focus_window_is_validated_and_local_observation_day_is_frozen() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-02T00:15:00+08:00").unwrap();
        let default = focus_context(&json!({}), now).unwrap();
        assert_eq!(default.as_of, "2026-10-02");
        assert_eq!(default.utc_offset_minutes, 480);
        assert_eq!(default.window_days, 30);
        for days in [7, 30, 90] {
            assert_eq!(
                focus_context(&json!({"windowDays":days}), now)
                    .unwrap()
                    .window_days,
                days
            );
        }
        for value in [
            json!(0),
            json!(-1),
            json!(365),
            json!("30"),
            json!(30.5),
            json!(null),
        ] {
            assert!(focus_context(&json!({"windowDays":value}), now).is_err());
        }
    }

    #[tokio::test]
    async fn actual_capture_extract_encode_save_pipeline_repeats_as_noop() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::new());
        engine.initialize(&json!({"data_dir":dir.path()})).unwrap();
        let host = Arc::new(FakeHost::new());
        let first = complete(&engine, host.clone()).await;
        assert_eq!(first.state, "complete", "{:?}", first.error);
        let second = complete(&engine, host.clone()).await;
        assert_eq!(second.save_status.as_deref(), Some("unchanged"));
        assert_eq!(*host.versions.lock().unwrap(), 1);
        let state = engine
            .handle(host.clone(), "state", json!({}))
            .await
            .unwrap();
        assert!(state["snapshot"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["label"] == "Hemory"));
    }
    #[tokio::test]
    async fn failed_save_is_preview_and_never_a_saved_version() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::new());
        engine.initialize(&json!({"data_dir":dir.path()})).unwrap();
        let host = Arc::new(FakeHost::new());
        host.fail_save.store(true, Ordering::Release);
        let job = complete(&engine, host.clone()).await;
        assert_eq!(job.state, "failed");
        let state = engine
            .handle(host.clone(), "state", json!({}))
            .await
            .unwrap();
        assert!(state["snapshot"].is_null());
        assert!(state["preview"].is_object());
        assert!(state["job"]["saveStatus"].is_null());
        let restarted = Arc::new(Engine::new());
        restarted
            .initialize(&json!({"data_dir":dir.path()}))
            .unwrap();
        assert!(restarted.handle(host, "state", json!({})).await.unwrap()["preview"].is_object());
    }
    #[tokio::test]
    async fn malformed_save_receipt_preserves_preview_and_is_not_success() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::new());
        engine.initialize(&json!({"data_dir":dir.path()})).unwrap();
        let host = Arc::new(FakeHost::new());
        host.bad_ack.store(true, Ordering::Release);
        let job = complete(&engine, host.clone()).await;
        assert_eq!(job.state, "failed");
        assert!(job.error.unwrap().contains("回执无效"));
        let state = engine.handle(host, "state", json!({})).await.unwrap();
        assert!(state["preview"].is_object());
        assert!(state["snapshot"].is_null());
    }
    #[tokio::test]
    async fn recovered_preview_does_not_reappear_after_the_next_saved_version() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::new());
        engine.initialize(&json!({"data_dir":dir.path()})).unwrap();
        let host = Arc::new(FakeHost::new());
        host.fail_save.store(true, Ordering::Release);
        assert_eq!(complete(&engine, host.clone()).await.state, "failed");
        let ctx = engine.context(host.as_ref()).await.unwrap();
        let draft = engine.preview(&ctx).unwrap();
        *host.snapshot.lock().unwrap() = Some(draft.clone());
        engine
            .handle(host.clone(), "retry_save", json!({}))
            .await
            .unwrap();
        assert!(!ctx.cache.join("preview-current").exists());
        assert!(engine.preview(&ctx).is_none());
        let mut advanced = draft.clone();
        advanced.nodes[0].label.push_str(" next");
        habitat_core::finalize(&mut advanced, Some(&draft)).unwrap();
        *host.snapshot.lock().unwrap() = Some(advanced);
        let restarted = Arc::new(Engine::new());
        restarted
            .initialize(&json!({"data_dir":dir.path()}))
            .unwrap();
        assert!(restarted.handle(host, "state", json!({})).await.unwrap()["preview"].is_null());
    }
    #[tokio::test]
    async fn save_transaction_cannot_be_reported_as_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::new());
        engine.initialize(&json!({"data_dir":dir.path()})).unwrap();
        let host = Arc::new(FakeHost::new());
        host.hold_save.store(true, Ordering::Release);
        let (worker_engine, worker_host) = (engine.clone(), host.clone());
        let worker = tokio::spawn(async move { complete(&worker_engine, worker_host).await });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !host.save_started.load(Ordering::Acquire) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(engine
            .handle(host.clone(), "cancel", json!({}))
            .await
            .unwrap_err()
            .contains("Git 保存事务"));
        host.hold_save.store(false, Ordering::Release);
        assert_eq!(worker.await.unwrap().state, "complete");
        assert_eq!(*host.versions.lock().unwrap(), 1);
    }
    #[tokio::test]
    async fn pending_prevents_regeneration_and_stale_source_cannot_open() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::new());
        engine.initialize(&json!({"data_dir":dir.path()})).unwrap();
        let host = Arc::new(FakeHost::new());
        host.pending.store(true, Ordering::Release);
        assert_eq!(complete(&engine, host.clone()).await.state, "failed");
        assert_eq!(*host.versions.lock().unwrap(), 0);
        host.pending.store(false, Ordering::Release);
        assert_eq!(complete(&engine, host.clone()).await.state, "complete");
        let evidence = host.snapshot.lock().unwrap().as_ref().unwrap().evidence[0].clone();
        let source = host
            .snapshot
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .sources
            .iter()
            .find(|s| s.id == evidence.source)
            .unwrap()
            .path
            .clone();
        host.files.lock().unwrap().insert(source, "changed".into());
        assert!(engine
            .handle(host, "open_source", json!({"evidenceId":evidence.id}))
            .await
            .unwrap_err()
            .contains("原文已变化"));
    }
}
