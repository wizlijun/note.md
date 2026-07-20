# pos-log 插件实施计划（位置记录）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v2 后台插件 notemd.pos-log——每 30 分钟取 macOS 定位，地址变化时向 vault `pos/YYYY-MM-DD-pos.md` 追加 `- YYYY-MM-DD HH:mm 国家-省份-城市 POI`。

**Architecture:** 前置任务先把 `host.vault.*` 接到插件进程 stdio 通道（现状只在 UI 桥实现，进程侧 -32601——host_api `make_sink` 增加可选 `HostServices`，复用 ui_rpc 的 vault 函数体）。插件进程主线程跑 CoreLocation（NSRunLoop 泵；CLGeocoder 完成块落主队列，必须主线程），tokio/SDK serve 挪到副线程；两侧用 std mpsc + tokio oneshot 交接。写盘全走 `Host::request` → host.vault.exists/read/write。

**Tech Stack:** Rust（notemd-plugin-sdk、tokio、chrono、objc2 0.6 + objc2-foundation 0.3 + objc2-core-location 0.3 + block2 0.6）；打包沿用 release-plugins.sh（新增 bin-only 形状）。

**工作目录：全部在 worktree `/Users/bruce/git/mdeditor/.claude/worktrees/core-ize-six-plugins`。** 提交精确 add，绝不 `add -A`。

**Spec:** `docs/superpowers/specs/2026-07-18-pos-log-plugin-design.md`。本计划三处偏离（Task 8 回写 spec）：
1. 取位用 `startUpdatingLocation` + 轮询 `.location` + `stopUpdatingLocation`（几秒内短启停），不用 `requestLocation`——后者必须实现 delegate 类（objc2 `define_class!`），短启停行为等价、免掉整个 delegate；
2. 不调 `host.vault.mkdir`——`vault_write` 本就创建父目录；
3. 新增"运行时扩展：vault.* 上进程通道"一节（spec 写时误以为已可用）。

---

### Task 1: 运行时扩展——host.vault.* 接入进程通道

**Files:**
- Modify: `src-tauri/src/plugin_runtime/ui_rpc.rs`（vault 函数 + `TauriServices` 暴露 pub(crate)）
- Modify: `src-tauri/src/plugin_runtime/host_api.rs`（`make_sink` 增 services 参数 + 路由 + 测试）

- [ ] **Step 1.1: 写失败测试**（host_api.rs `mod tests` 末尾追加；`ServicesStub` 放 tests 顶部 helper 区）

```rust
    /// 最小 HostServices 桩：只有 vault_root 有意义。
    struct ServicesStub(std::path::PathBuf);
    impl crate::plugin_runtime::ui_rpc::HostServices for ServicesStub {
        fn pick_paths(&self, _o: &crate::plugin_runtime::ui_rpc::OpenOptions)
            -> Result<Option<Vec<std::path::PathBuf>>, String> { Err("no dialogs on process channel".into()) }
        fn pick_save(&self, _o: &crate::plugin_runtime::ui_rpc::SaveOptions)
            -> Result<Option<std::path::PathBuf>, String> { Err("no dialogs on process channel".into()) }
        fn vault_root(&self) -> Option<std::path::PathBuf> { Some(self.0.clone()) }
        fn wiki_daily_dirs(&self) -> (Option<String>, Option<String>) { (None, None) }
        fn clipboard_write(&self, _t: &str) -> Result<(), String> { Err("no clipboard on process channel".into()) }
    }

    #[test]
    fn vault_round_trip_on_process_channel_with_services() {
        let log_dir = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let (emitter, _) = recording_emitter();
        let sink = make_sink(
            "pub.test".into(),
            vec!["vault.read".into(), "vault.write".into()],
            log_dir.path().to_path_buf(),
            emitter,
            noop_poster(),
            Some(Arc::new(ServicesStub(vault.path().to_path_buf()))),
        );
        // write → {ok:true}
        let resp = sink(req("host.vault.write", Some(1),
            serde_json::json!({"path": "pos/x.md", "content": "- line\n"}))).unwrap();
        assert!(resp.error.is_none(), "write err: {:?}", resp.error);
        assert_eq!(resp.result.unwrap()["ok"], true);
        // exists → true
        let resp = sink(req("host.vault.exists", Some(2), serde_json::json!({"path": "pos/x.md"}))).unwrap();
        assert_eq!(resp.result.unwrap()["exists"], true);
        // read → 原文
        let resp = sink(req("host.vault.read", Some(3), serde_json::json!({"path": "pos/x.md"}))).unwrap();
        assert_eq!(resp.result.unwrap()["content"], "- line\n");
        // 越权：无 capability 的方法仍被拒
        let resp = sink(req("host.clipboard.write", Some(4), serde_json::json!({"text": "x"}))).unwrap();
        assert_eq!(resp.error.unwrap().code, proto::ERR_CAPABILITY_DENIED);
        // dialog 类持 capability 也仍是 -32601（进程通道不做对话框）
        let sink2 = make_sink("pub.test".into(), vec!["dialog".into()], log_dir.path().to_path_buf(),
            recording_emitter().0, noop_poster(), Some(Arc::new(ServicesStub(vault.path().to_path_buf()))));
        let resp = sink2(req("host.dialog.open", Some(5), serde_json::json!({}))).unwrap();
        assert_eq!(resp.error.unwrap().code, proto::ERR_METHOD_NOT_FOUND);
    }

    #[test]
    fn vault_on_process_channel_without_services_stays_32601() {
        let dir = tempfile::tempdir().unwrap();
        let sink = make_sink("pub.test".into(), vec!["vault.read".into()],
            dir.path().to_path_buf(), recording_emitter().0, noop_poster(), None);
        let resp = sink(req("host.vault.read", Some(1), serde_json::json!({"path": "a.md"}))).unwrap();
        assert_eq!(resp.error.unwrap().code, proto::ERR_METHOD_NOT_FOUND);
    }
```

- [ ] **Step 1.2: 跑测试确认编译失败**（make_sink 还没有第 6 参）

Run: `cd src-tauri && cargo test --lib plugin_runtime::host_api 2>&1 | tail -5`
Expected: 编译错误 `make_sink` 参数个数不符。

- [ ] **Step 1.3: 实现**

ui_rpc.rs——四处小改：
1. `fn vault_info/vault_read/vault_write/vault_exists/vault_list/vault_mkdir` 前加 `pub(crate) `（6 个函数，签名不变）。
2. `TauriServices` 加构造：

```rust
impl<R: tauri::Runtime> TauriServices<R> {
    pub(crate) fn new(app: tauri::AppHandle<R>) -> Self { Self { app } }
}
```

host_api.rs——`make_sink` 加第 6 参并路由 vault：

```rust
pub fn make_sink(
    plugin_id: String,
    capabilities: Vec<String>,
    log_dir: std::path::PathBuf,
    emitter: ToastEmitter,
    ui_poster: UiPoster,
    services: Option<Arc<dyn crate::plugin_runtime::ui_rpc::HostServices>>,
) -> crate::plugin_runtime::process::HostSink {
```

最后一个 match 臂（`_ => match handle_common(...)`）的 `None =>` 分支改为：先试 vault 路由，路由不到再回 -32601：

```rust
            _ => match handle_common(&req.method, req.params.clone(), &plugin_id, &log_dir, &emitter) {
                Some(Ok(_)) => ok(req.id),
                Some(Err(detail)) => req.id.and_then(|id| reply_err(id, proto::ERR_INTERNAL, detail)),
                None => {
                    // vault.* 在进程通道上可用（pos-log 等后台插件的写盘通道），
                    // 前提是宿主给了 services；dialog/fs/clipboard 仍只在 UI 桥。
                    use crate::plugin_runtime::ui_rpc as rpc;
                    let vault_out: Option<Result<serde_json::Value, String>> = services
                        .as_ref()
                        .and_then(|svc| {
                            let s: &dyn rpc::HostServices = svc.as_ref();
                            match req.method.as_str() {
                                "host.vault.info" => Some(Ok(rpc::vault_info(s))),
                                "host.vault.read" => Some(rpc::vault_read(s, &req.params)),
                                "host.vault.write" => Some(rpc::vault_write(s, &req.params)),
                                "host.vault.exists" => Some(rpc::vault_exists(s, &req.params)),
                                "host.vault.list" => Some(rpc::vault_list(s, &req.params)),
                                "host.vault.mkdir" => Some(rpc::vault_mkdir(s, &req.params)),
                                _ => None,
                            }
                        });
                    match vault_out {
                        Some(Ok(v)) => req.id.map(|id| proto::RpcResponse {
                            jsonrpc: "2.0".into(), id, result: Some(v), error: None,
                        }),
                        Some(Err(detail)) => req.id.and_then(|id| reply_err(id, proto::ERR_INTERNAL, detail)),
                        None => req.id.and_then(|id| reply_err(
                            id,
                            proto::ERR_METHOD_NOT_FOUND,
                            format!("method {} is not available on the process channel", req.method),
                        )),
                    }
                }
            },
```

注意 `handle_common(&req.method, req.params.clone(), …)`——原来是 move `req.params`，vault 路由还要用，改成 clone。

`make_sink_for_app`（同文件）：

```rust
    let services: Arc<dyn crate::plugin_runtime::ui_rpc::HostServices> =
        Arc::new(crate::plugin_runtime::ui_rpc::TauriServices::new(app.clone()));
    make_sink(plugin_id, capabilities, log_dir, emitter, ui_poster, Some(services))
```

既有测试修复：
- host_api tests 里 5 处旧 `make_sink(…)` 调用补第 6 参 `None`。
- `ui_only_method_on_process_channel_returns_32601_even_when_authorized`：该测试用 `host.vault.read` 验 -32601 的前提已失效（services=None 时仍 -32601，测试传的就是无 services 的 make_sink——**行为不变，测试应仍绿**；只把测试名与注释改为 `vault_without_services_and_dialogs_return_32601…` 的语义，注释说明 vault 有 services 时已可用）。

- [ ] **Step 1.4: 跑测试确认全绿**

Run: `cd src-tauri && cargo test --lib plugin_runtime:: 2>&1 | tail -5`
Expected: 全部 PASS（host_api 新增 2 个 + 既有全绿）。

- [ ] **Step 1.5: Commit**

```bash
git add src-tauri/src/plugin_runtime/host_api.rs src-tauri/src/plugin_runtime/ui_rpc.rs
git commit -m "feat(plugin-v2): host.vault.* on the process channel (opt-in via HostServices)

Background plugins (pos-log) need vault IO from the process side. make_sink
gains an optional HostServices; vault methods reuse the ui_rpc bodies under
the same capability gate. dialog/fs/clipboard stay UI-bridge-only."
```

---

### Task 2: crate 骨架 + logbook 纯函数（TDD）

**Files:**
- Create: `plugins-src/pos-log/backend/Cargo.toml`
- Create: `plugins-src/pos-log/backend/src/main.rs`（暂为空壳）
- Create: `plugins-src/pos-log/backend/src/logbook.rs`

- [ ] **Step 2.1: Cargo.toml + 空壳 main**

```toml
[package]
name = "notemd-pos-log"
version = "1.0.0"
edition = "2021"

# pos-log v2 backend: a resident background plugin (no idle shutdown). Every
# 30 min it takes one CoreLocation fix + reverse geocode on the MAIN thread
# (CLGeocoder completion blocks land on the main dispatch queue, which only
# the main run loop drains); the SDK serve loop runs on a secondary thread.
# All vault IO goes through Host::request → host.vault.* (Task 1 extension).
[[bin]]
name = "notemd-pos-log"
path = "src/main.rs"

[dependencies]
notemd-plugin-sdk = { path = "../../../notemd-plugin-sdk" }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "io-util", "sync"] }
serde_json = "1"
chrono = "0.4"

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-foundation = "0.3"
objc2-core-location = "0.3"
block2 = "0.6"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

main.rs 空壳（让 crate 可编译可测）：

```rust
//! pos-log v2 plugin entry point（Task 4 填实现）。
mod logbook;

fn main() {}
```

- [ ] **Step 2.2: 写 logbook 失败测试**（logbook.rs，函数体先 `todo!()` 或直接不写函数让编译失败也行——按下面完整文件结构建骨架，测试先行）

logbook.rs 顶部签名 + 测试（先只写测试与空实现声明）：

```rust
//! 纯函数层：行格式化 / 地址比较 / 追加决策。无 IO，全部可单测。

/// 反查得到的一个地点。空串 = 该段缺失。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub country: String,
    pub province: String,
    pub city: String,
    pub poi: String,
}

/// `国家-省份-城市 POI`；空段省略，连字符只连非空段；全空 → 空串（调用方按取位失败跳过）。
pub fn format_address(p: &Place) -> String { todo!() }

/// `- YYYY-MM-DD HH:mm <addr>`（本地时间由调用方传入，便于测试）。
pub fn format_line(ts: &chrono::DateTime<chrono::Local>, addr: &str) -> String { todo!() }

/// 当天文件的 vault 相对路径 `pos/YYYY-MM-DD-pos.md`。
pub fn file_rel_path(ts: &chrono::DateTime<chrono::Local>) -> String { todo!() }

/// 现有文件内容里最后一条记录的地址部分（剥掉 `- YYYY-MM-DD HH:mm ` 前缀）。
/// 无行/行不合形 → None（调用方视为需要追加）。
pub fn last_address(content: &str) -> Option<String> { todo!() }

/// 追加决策：
/// - `existing = None`（当天文件不存在）→ 无条件基线：`Some(line + "\n")`
/// - 最后一条地址 == addr → `None`（跳过）
/// - 否则 → `Some(existing 补齐尾部换行 + line + "\n")`
pub fn decide(existing: Option<&str>, line: &str, addr: &str) -> Option<String> { todo!() }

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn place(c: &str, p: &str, ci: &str, poi: &str) -> Place {
        Place { country: c.into(), province: p.into(), city: ci.into(), poi: poi.into() }
    }
    fn ts() -> chrono::DateTime<chrono::Local> {
        chrono::Local.with_ymd_and_hms(2026, 7, 18, 14, 30, 0).unwrap()
    }

    #[test]
    fn address_full() {
        assert_eq!(format_address(&place("中国", "湖北", "武汉", "光谷软件园")), "中国-湖北-武汉 光谷软件园");
    }
    #[test]
    fn address_missing_province() {
        assert_eq!(format_address(&place("中国", "", "武汉", "光谷软件园")), "中国-武汉 光谷软件园");
    }
    #[test]
    fn address_no_poi() {
        assert_eq!(format_address(&place("中国", "湖北", "武汉", "")), "中国-湖北-武汉");
    }
    #[test]
    fn address_poi_only() {
        assert_eq!(format_address(&place("", "", "", "光谷软件园")), "光谷软件园");
    }
    #[test]
    fn address_all_empty() {
        assert_eq!(format_address(&place("", "", "", "")), "");
    }
    #[test]
    fn line_format() {
        assert_eq!(format_line(&ts(), "中国-湖北-武汉 光谷软件园"),
                   "- 2026-07-18 14:30 中国-湖北-武汉 光谷软件园");
    }
    #[test]
    fn rel_path() {
        assert_eq!(file_rel_path(&ts()), "pos/2026-07-18-pos.md");
    }
    #[test]
    fn last_address_of_normal_file() {
        let c = "- 2026-07-18 09:00 中国-湖北-武汉 A\n- 2026-07-18 12:00 中国-湖北-武汉 B\n";
        assert_eq!(last_address(c).as_deref(), Some("中国-湖北-武汉 B"));
    }
    #[test]
    fn last_address_skips_trailing_blank_lines() {
        let c = "- 2026-07-18 09:00 X\n\n";
        assert_eq!(last_address(c).as_deref(), Some("X"));
    }
    #[test]
    fn last_address_malformed_line_is_none() {
        assert_eq!(last_address("手写的一行\n"), None);
        assert_eq!(last_address(""), None);
        assert_eq!(last_address("- 短\n"), None);
    }
    #[test]
    fn decide_baseline_when_no_file() {
        assert_eq!(decide(None, "- 2026-07-18 14:30 X", "X").as_deref(), Some("- 2026-07-18 14:30 X\n"));
    }
    #[test]
    fn decide_skip_when_same() {
        let c = "- 2026-07-18 09:00 X\n";
        assert_eq!(decide(Some(c), "- 2026-07-18 14:30 X", "X"), None);
    }
    #[test]
    fn decide_append_when_changed() {
        let c = "- 2026-07-18 09:00 X\n";
        assert_eq!(decide(Some(c), "- 2026-07-18 14:30 Y", "Y").as_deref(),
                   Some("- 2026-07-18 09:00 X\n- 2026-07-18 14:30 Y\n"));
    }
    #[test]
    fn decide_append_fixes_missing_trailing_newline() {
        let c = "- 2026-07-18 09:00 X";
        assert_eq!(decide(Some(c), "- 2026-07-18 14:30 Y", "Y").as_deref(),
                   Some("- 2026-07-18 09:00 X\n- 2026-07-18 14:30 Y\n"));
    }
    #[test]
    fn decide_appends_after_malformed_tail() {
        // 手工编辑过的行 → last_address None → 视为变化，照常追加
        let c = "随手一行\n";
        assert_eq!(decide(Some(c), "- 2026-07-18 14:30 Y", "Y").as_deref(),
                   Some("随手一行\n- 2026-07-18 14:30 Y\n"));
    }
    #[test]
    fn decide_baseline_on_empty_existing_file() {
        assert_eq!(decide(Some(""), "- 2026-07-18 14:30 Y", "Y").as_deref(),
                   Some("- 2026-07-18 14:30 Y\n"));
    }
}
```

- [ ] **Step 2.3: 跑测试确认失败**

Run: `cd plugins-src/pos-log/backend && cargo test 2>&1 | tail -5`
Expected: panic `not yet implemented`（todo!）。

- [ ] **Step 2.4: 实现**

```rust
pub fn format_address(p: &Place) -> String {
    let geo: Vec<&str> = [p.country.as_str(), p.province.as_str(), p.city.as_str()]
        .into_iter().filter(|s| !s.is_empty()).collect();
    let geo = geo.join("-");
    match (geo.is_empty(), p.poi.is_empty()) {
        (true, true) => String::new(),
        (true, false) => p.poi.clone(),
        (false, true) => geo,
        (false, false) => format!("{geo} {}", p.poi),
    }
}

pub fn format_line(ts: &chrono::DateTime<chrono::Local>, addr: &str) -> String {
    format!("- {} {addr}", ts.format("%Y-%m-%d %H:%M"))
}

pub fn file_rel_path(ts: &chrono::DateTime<chrono::Local>) -> String {
    format!("pos/{}-pos.md", ts.format("%Y-%m-%d"))
}

pub fn last_address(content: &str) -> Option<String> {
    let line = content.lines().rev().find(|l| !l.trim().is_empty())?;
    // `- YYYY-MM-DD HH:mm addr` → 前缀 "- "(2) + 日期(10) + " "(1) + 时间(5) + " "(1) = 19
    let rest = line.strip_prefix("- ")?;
    if rest.len() < 17 { return None; }
    let (stamp, addr) = rest.split_at(17);
    // 校验戳形：YYYY-MM-DD HH:mm + 尾随空格
    let bytes = stamp.as_bytes();
    let shape_ok = bytes[4] == b'-' && bytes[7] == b'-' && bytes[10] == b' '
        && bytes[13] == b':' && bytes[16] == b' '
        && stamp.chars().enumerate().all(|(i, c)| match i {
            4 | 7 | 10 | 13 | 16 => true,
            _ => c.is_ascii_digit(),
        });
    if !shape_ok || addr.is_empty() { return None; }
    Some(addr.to_string())
}

pub fn decide(existing: Option<&str>, line: &str, addr: &str) -> Option<String> {
    match existing {
        None => Some(format!("{line}\n")),
        Some(c) if c.trim().is_empty() => Some(format!("{line}\n")),
        Some(c) => {
            if last_address(c).as_deref() == Some(addr) { return None; }
            let mut out = c.to_string();
            if !out.ends_with('\n') { out.push('\n'); }
            out.push_str(line);
            out.push('\n');
            Some(out)
        }
    }
}
```

注意 `last_address` 的 `split_at(17)` 按字节——前 19 字节固定 ASCII（"- " 已剥掉后 17）；地址部分可含多字节 UTF-8，`split_at` 在 ASCII 边界安全。

- [ ] **Step 2.5: 跑测试确认全绿**

Run: `cd plugins-src/pos-log/backend && cargo test 2>&1 | tail -5`
Expected: `test result: ok. 16 passed`

- [ ] **Step 2.6: Commit**

```bash
git add plugins-src/pos-log/backend/Cargo.toml plugins-src/pos-log/backend/src/main.rs plugins-src/pos-log/backend/src/logbook.rs
git commit -m "feat(pos-log): crate skeleton + logbook pure functions (format/compare/decide)"
```

---

### Task 3: location.rs——CoreLocation 封装（主线程服务）

**Files:**
- Create: `plugins-src/pos-log/backend/src/location.rs`
- Modify: `plugins-src/pos-log/backend/src/main.rs`（挂 `mod location;`）

- [ ] **Step 3.1: 写 location.rs**

```rust
//! CoreLocation 取位 + 反查，跑在**主线程**（CLGeocoder 完成块落主 dispatch 队列，
//! 只有主线程 run loop 会排干它；NSRunLoop 泵同时驱动 CLLocationManager 回调）。
//! 对外形状：`LocationProvider` trait（测试注入假实现）+ `service_loop`（主线程
//! 消费 FetchJob channel，直到发送端全部关闭）。
#![allow(unused_unsafe)]

use crate::logbook::Place;

pub trait LocationProvider {
    fn fetch(&mut self) -> Result<Place, String>;
}

/// 一次取位请求：主线程做完后经 oneshot 回给 tokio 侧。
pub struct FetchJob {
    pub reply: tokio::sync::oneshot::Sender<Result<Place, String>>,
}

/// 主线程服务循环。`provider` 由调用方注入（生产 = CoreLocationProvider，
/// 测试 = 假实现）。channel 关闭（serve 结束、插件退出）即返回。
pub fn service_loop(rx: std::sync::mpsc::Receiver<FetchJob>, provider: &mut dyn LocationProvider) {
    while let Ok(job) = rx.recv() {
        let _ = job.reply.send(provider.fetch());
    }
}

// ── CoreLocation 实现（仅 macOS）─────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub use mac::CoreLocationProvider;

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_core_location::{CLAuthorizationStatus, CLGeocoder, CLLocationManager, CLPlacemark};
    use objc2_foundation::{NSArray, NSDate, NSError, NSRunLoop};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const AUTH_WAIT_SECS: u64 = 60;   // 首次授权弹窗等待
    const FIX_WAIT_SECS: u64 = 30;    // 定位等待
    const GEO_WAIT_SECS: u64 = 15;    // 反查等待
    const FRESH_SECS: f64 = 300.0;    // 位置新鲜度：5 分钟内

    pub struct CoreLocationProvider {
        manager: Retained<CLLocationManager>,
    }

    impl CoreLocationProvider {
        /// 必须在主线程构造（也在主线程使用）。构造即申请授权（spec §3：启动时申请）。
        pub fn new() -> Self {
            let manager = unsafe { CLLocationManager::new() };
            let me = Self { manager };
            me.ensure_authorization_requested();
            me
        }

        fn status(&self) -> CLAuthorizationStatus {
            unsafe { self.manager.authorizationStatus() }
        }

        fn ensure_authorization_requested(&self) {
            if self.status() == CLAuthorizationStatus::NotDetermined {
                unsafe { self.manager.requestWhenInUseAuthorization() };
            }
        }

        /// 泵一格主 run loop（同时排干主队列上的 GCD block）。
        fn pump(seconds: f64) {
            unsafe {
                let until = NSDate::dateWithTimeIntervalSinceNow(seconds);
                NSRunLoop::currentRunLoop().runUntilDate(&until);
            }
        }

        fn wait_authorized(&self) -> Result<(), String> {
            let t0 = Instant::now();
            loop {
                match self.status() {
                    CLAuthorizationStatus::AuthorizedAlways => return Ok(()),
                    s if s == CLAuthorizationStatus::NotDetermined => {
                        if t0.elapsed() > Duration::from_secs(AUTH_WAIT_SECS) {
                            return Err("authorization prompt timed out".into());
                        }
                        Self::pump(0.2);
                    }
                    s => return Err(format!("location authorization denied/restricted ({s:?})")),
                }
            }
        }
    }

    impl LocationProvider for CoreLocationProvider {
        fn fetch(&mut self) -> Result<Place, String> {
            self.ensure_authorization_requested();
            self.wait_authorized()?;

            // 短启停 + 轮询 .location（spec 偏离①：免 delegate，行为等价 requestLocation）
            unsafe { self.manager.startUpdatingLocation() };
            let t0 = Instant::now();
            let loc = loop {
                let fresh = unsafe { self.manager.location() }.filter(|l| {
                    let age = unsafe { l.timestamp().timeIntervalSinceNow() };
                    age > -FRESH_SECS
                });
                if let Some(l) = fresh { break l; }
                if t0.elapsed() > Duration::from_secs(FIX_WAIT_SECS) {
                    unsafe { self.manager.stopUpdatingLocation() };
                    return Err("location fix timed out".into());
                }
                Self::pump(0.2);
            };
            unsafe { self.manager.stopUpdatingLocation() };

            // 反查（完成块落主队列；pump 排干）
            let slot: Arc<Mutex<Option<Result<Place, String>>>> = Arc::new(Mutex::new(None));
            let slot_in = slot.clone();
            let block = RcBlock::new(move |placemarks: *mut NSArray<CLPlacemark>, error: *mut NSError| {
                let mut out = slot_in.lock().unwrap();
                if !placemarks.is_null() {
                    let arr = unsafe { &*placemarks };
                    if let Some(pm) = arr.firstObject() {
                        *out = Some(Ok(place_of(&pm)));
                        return;
                    }
                }
                let msg = if error.is_null() { "no placemark".to_string() }
                          else { unsafe { (*error).localizedDescription() }.to_string() };
                *out = Some(Err(format!("reverse geocode failed: {msg}")));
            });
            let geocoder = unsafe { CLGeocoder::new() };
            unsafe { geocoder.reverseGeocodeLocation_completionHandler(&loc, &block) };
            let t1 = Instant::now();
            loop {
                if let Some(res) = slot.lock().unwrap().take() { return res; }
                if t1.elapsed() > Duration::from_secs(GEO_WAIT_SECS) {
                    return Err("reverse geocode timed out".into());
                }
                Self::pump(0.2);
            }
        }
    }

    fn opt_str(s: Option<Retained<objc2_foundation::NSString>>) -> String {
        s.map(|v| v.to_string()).unwrap_or_default()
    }

    fn place_of(pm: &CLPlacemark) -> Place {
        let poi = unsafe { pm.areasOfInterest() }
            .and_then(|a| a.firstObject())
            .map(|s| s.to_string())
            .or_else(|| unsafe { pm.name() }.map(|s| s.to_string()))
            .unwrap_or_default();
        Place {
            country: opt_str(unsafe { pm.country() }),
            province: opt_str(unsafe { pm.administrativeArea() }),
            city: opt_str(unsafe { pm.locality() }),
            poi,
        }
    }
}
```

main.rs 加 `mod location;`。

**已知风险（编译期解决，不改形状）**：objc2 框架 crate 的方法名/可空性偏差（如 `authorizationStatus` 在 0.3 的确切签名、`AuthorizedAlways` 枚举值名（macOS 无 `AuthorizedWhenInUse`，只有 `Authorized`/`AuthorizedAlways`——若编译器提示，改用 `CLAuthorizationStatus::Authorized` 常量或按 crate 文档比对）、`RcBlock::new` 闭包参数形状）。原则：**保持函数形状与超时/泵结构不变，只按编译器提示调整 objc 调用名**；如个别 getter 缺 feature，给对应 objc2-* crate 加 features。

- [ ] **Step 3.2: 编译通过 + 既有测试仍绿**

Run: `cd plugins-src/pos-log/backend && cargo build 2>&1 | tail -3 && cargo test 2>&1 | tail -3`
Expected: build OK；16 个 logbook 测试仍 PASS。

- [ ] **Step 3.3: Commit**

```bash
git add plugins-src/pos-log/backend/src/location.rs plugins-src/pos-log/backend/src/main.rs plugins-src/pos-log/backend/Cargo.toml
git commit -m "feat(pos-log): CoreLocation provider on the main thread (auth + fix + reverse geocode)"
```

---

### Task 4: 插件粘合——PosLogPlugin + 主线程分工 + 首轮集成测试

**Files:**
- Create: `plugins-src/pos-log/backend/src/plugin.rs`
- Modify: `plugins-src/pos-log/backend/src/main.rs`

- [ ] **Step 4.1: 写失败的首轮集成测试**（plugin.rs 里 `#[cfg(test)]`；先写测试，plugin 结构体只有骨架）

测试策略：`sdk::serve_io` + `tokio::io::duplex` 假宿主管道 + 假 `LocationProvider` 线程。发 `$initialize`/`$activate`，然后按插件发出的 host 请求脚本化应答：`host.vault.exists` → false，期待收到 `host.vault.write`，其 `content` 恰为一条基线行（地址 `中国-湖北-武汉 光谷软件园`，时间戳取当刻本地时间，逐字段校验前缀与地址、不校验具体分钟值）。

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::location::{FetchJob, service_loop, LocationProvider};
    use crate::logbook::Place;
    use notemd_plugin_sdk as sdk;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    struct FakeProvider;
    impl LocationProvider for FakeProvider {
        fn fetch(&mut self) -> Result<Place, String> {
            Ok(Place { country: "中国".into(), province: "湖北".into(),
                       city: "武汉".into(), poi: "光谷软件园".into() })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn first_round_writes_baseline_line() {
        // 假主线程服务
        let (fetch_tx, fetch_rx) = std::sync::mpsc::channel::<FetchJob>();
        std::thread::spawn(move || service_loop(fetch_rx, &mut FakeProvider));

        // 假宿主管道
        let (host_side, plugin_side) = tokio::io::duplex(64 * 1024);
        let (plug_r, plug_w) = tokio::io::split(plugin_side);
        tokio::spawn(sdk::serve_io(PosLogPlugin::new(fetch_tx), plug_r, plug_w));

        let (host_r, mut host_w) = tokio::io::split(host_side);
        let mut lines = BufReader::new(host_r).lines();

        // $initialize + $activate（id 1/2；参数形状照 plugin_protocol 的 InitializeParams/ActivateParams 最小合法值）
        host_w.write_all(br#"{"jsonrpc":"2.0","id":1,"method":"$initialize","params":{"host_version":"6.717.1","plugin_id":"notemd.pos-log","data_dir":"/tmp","log_dir":"/tmp"}}"#).await.unwrap();
        host_w.write_all(b"\n").await.unwrap();
        host_w.write_all(br#"{"jsonrpc":"2.0","id":2,"method":"$activate","params":{"event":"onStartupFinished"}}"#).await.unwrap();
        host_w.write_all(b"\n").await.unwrap();

        // 读到 host.vault.exists → 回 false；随后必须读到 host.vault.write
        let mut wrote: Option<serde_json::Value> = None;
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(10);
        while wrote.is_none() {
            let line = tokio::time::timeout_at(deadline, lines.next_line()).await
                .expect("timed out").unwrap().expect("pipe closed");
            let v: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
            match v["method"].as_str() {
                Some("host.vault.exists") => {
                    let id = v["id"].as_u64().unwrap();
                    let resp = format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{{"exists":false}}}}"#);
                    host_w.write_all(resp.as_bytes()).await.unwrap();
                    host_w.write_all(b"\n").await.unwrap();
                }
                Some("host.vault.write") => { wrote = Some(v); }
                _ => {} // $initialize/$activate 的应答、日志通知——忽略
            }
        }
        let w = wrote.unwrap();
        let path = w["params"]["path"].as_str().unwrap();
        let content = w["params"]["content"].as_str().unwrap();
        assert!(path.starts_with("pos/") && path.ends_with("-pos.md"), "path: {path}");
        assert!(content.starts_with("- "), "content: {content}");
        assert!(content.trim_end().ends_with("中国-湖北-武汉 光谷软件园"), "content: {content}");
        assert!(content.ends_with('\n'));
        // 回 ok，避免插件侧悬挂
        let id = w["id"].as_u64().unwrap();
        let resp = format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{{"ok":true}}}}"#);
        host_w.write_all(resp.as_bytes()).await.unwrap();
        host_w.write_all(b"\n").await.unwrap();
    }
}
```

如 `$initialize`/`$activate` 的方法名或参数字段与 `plugin_protocol` 定义不符（以 `plugin-protocol/src/lib.rs` 的 `InitializeParams`/`ActivateParams` 为准，`grep -n "initialize\|activate" plugin-protocol/src/lib.rs` 核对），按协议 crate 调整测试常量——**协议为准，不改协议**。

- [ ] **Step 4.2: 跑测试确认失败**（PosLogPlugin 尚不存在）

Run: `cd plugins-src/pos-log/backend && cargo test first_round 2>&1 | tail -5`
Expected: 编译错误 `PosLogPlugin` 未定义。

- [ ] **Step 4.3: 实现 plugin.rs**

```rust
//! SDK 粘合：activate 起 30 分钟循环 task；每轮 fetch（经主线程服务）→
//! logbook 决策 → host.vault.exists/read/write。deactivate 撤销循环。
use crate::location::FetchJob;
use crate::logbook;
use notemd_plugin_sdk::{self as sdk, plugin_protocol as proto};
use serde_json::{json, Value};

const ROUND_SECS: u64 = 30 * 60;

pub struct PosLogPlugin {
    fetch_tx: std::sync::mpsc::Sender<FetchJob>,
    stop_tx: Option<tokio::sync::watch::Sender<bool>>,
}

impl PosLogPlugin {
    pub fn new(fetch_tx: std::sync::mpsc::Sender<FetchJob>) -> Self {
        Self { fetch_tx, stop_tx: None }
    }
}

impl sdk::NotemdPlugin for PosLogPlugin {
    fn activate(&mut self, host: &sdk::Host, _params: &proto::ActivateParams) -> Result<(), String> {
        if self.stop_tx.is_some() { return Ok(()); } // 幂等
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        self.stop_tx = Some(stop_tx);
        let host = host.clone();
        let fetch_tx = self.fetch_tx.clone();
        tokio::spawn(async move {
            let mut warned_once = false;
            loop {
                run_round(&host, &fetch_tx, &mut warned_once).await;
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(ROUND_SECS)) => {}
                    _ = stop_rx.changed() => break,
                }
            }
        });
        Ok(())
    }

    fn deactivate(&mut self, _host: &sdk::Host) {
        if let Some(tx) = self.stop_tx.take() { let _ = tx.send(true); }
    }

    fn execute_command(&mut self, _host: &sdk::Host, params: &proto::ExecuteCommandParams)
        -> Result<Value, String> {
        Err(format!("pos-log has no commands (got {})", params.command))
    }
}

/// 一轮：取位 → 组行 → 决策 → 写盘。所有失败仅告警跳过（spec §8）。
async fn run_round(host: &sdk::Host, fetch_tx: &std::sync::mpsc::Sender<FetchJob>, warned_once: &mut bool) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if fetch_tx.send(FetchJob { reply: reply_tx }).is_err() {
        host.log_warn("pos-log: location service gone");
        return;
    }
    let place = match reply_rx.await {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            if !*warned_once {
                host.toast("warning", "Position Log 无法获取位置", Some(&e));
                *warned_once = true;
            }
            host.log_warn(&format!("pos-log: fetch failed: {e}"));
            return;
        }
        Err(_) => { host.log_warn("pos-log: location service dropped reply"); return; }
    };
    let addr = logbook::format_address(&place);
    if addr.is_empty() {
        host.log_warn("pos-log: empty geocode result, skipping round");
        return;
    }
    let now = chrono::Local::now();
    let path = logbook::file_rel_path(&now);
    let line = logbook::format_line(&now, &addr);

    let existing: Option<String> = match host.request("host.vault.exists", json!({"path": path})).await {
        Ok(v) if v["exists"] == true => {
            match host.request("host.vault.read", json!({"path": path})).await {
                Ok(v) => v["content"].as_str().map(str::to_string),
                Err(e) => { host.log_warn(&format!("pos-log: vault.read failed: {e}")); return; }
            }
        }
        Ok(_) => None,
        Err(e) => {
            // vault 未配置等；首次 toast，之后仅日志
            if !*warned_once {
                host.toast("warning", "Position Log 需要已配置的 vault", Some(&e));
                *warned_once = true;
            }
            host.log_warn(&format!("pos-log: vault.exists failed: {e}"));
            return;
        }
    };
    let Some(new_content) = logbook::decide(existing.as_deref(), &line, &addr) else {
        return; // 地址未变化
    };
    if let Err(e) = host.request("host.vault.write", json!({"path": path, "content": new_content})).await {
        host.log_error(&format!("pos-log: vault.write failed: {e}"));
    }
}
```

main.rs 成品：

```rust
//! pos-log v2 plugin entry point.
//! 线程分工：主线程 = CoreLocation 服务（CLGeocoder 完成块落主队列，见
//! location.rs 模块注释）；SDK serve 循环跑在副线程的 tokio runtime 上。
mod location;
mod logbook;
mod plugin;

fn main() {
    let (fetch_tx, fetch_rx) = std::sync::mpsc::channel::<location::FetchJob>();
    let serve = std::thread::spawn(move || {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(notemd_plugin_sdk::serve(plugin::PosLogPlugin::new(fetch_tx)));
    });
    #[cfg(target_os = "macos")]
    {
        let mut provider = location::CoreLocationProvider::new();
        location::service_loop(fetch_rx, &mut provider);
    }
    #[cfg(not(target_os = "macos"))]
    drop(fetch_rx);
    let _ = serve.join();
}
```

注：`Host::toast` 签名按 SDK（`toast(level, message, detail)`）；`sdk::Host` 已 `Clone`。serve 结束（宿主关管道/`$deactivate`）→ `fetch_tx` 随 plugin 一起 drop → `service_loop` 的 `rx.recv()` Err → 主线程退出，进程干净收尾。

- [ ] **Step 4.4: 跑全部测试**

Run: `cd plugins-src/pos-log/backend && cargo test 2>&1 | tail -5`
Expected: 17 passed（16 logbook + 1 first_round）。

- [ ] **Step 4.5: Commit**

```bash
git add plugins-src/pos-log/backend/src/plugin.rs plugins-src/pos-log/backend/src/main.rs
git commit -m "feat(pos-log): plugin glue — 30-min round loop, decide-and-append via host.vault.*"
```

---

### Task 5: manifest + dev 安装线

**Files:**
- Create: `plugins-src/pos-log/manifest.v2.json`
- Modify: `scripts/dev-install-plugin.sh`

- [ ] **Step 5.1: manifest.v2.json**（spec §6 原文；无 `idle_shutdown_seconds` 即常驻）

```json
{
  "manifest_version": 2,
  "id": "notemd.pos-log",
  "name": "Position Log",
  "version": "1.0.0",
  "kind": "native",
  "engines": { "notemd": ">=6.716.7" },
  "description": "Log your location to the vault: appends country-province-city + POI to pos/YYYY-MM-DD-pos.md whenever the address changes (every 30 min)",
  "binary": {
    "aarch64-apple-darwin": "bin/notemd-pos-log",
    "x86_64-apple-darwin": "bin/notemd-pos-log"
  },
  "activation": { "events": ["onStartupFinished"] },
  "capabilities": ["vault.read", "vault.write", "toast"],
  "request_timeout_seconds": 30
}
```

- [ ] **Step 5.2: dev-install-plugin.sh 加 case**（usage 行、arg case、以及 `exlibris` 分支之后新增分支；模式照 openclaw/exlibris）

```bash
elif [[ "$PLUGIN" == "pos-log" ]]; then
  SRC="plugins-src/pos-log"
  # CURRENT-arch native backend (resident background logger; no UI).
  cargo build $([ "$PROFILE" = release ] && echo --release) \
    --manifest-path "$SRC/backend/Cargo.toml" --bin notemd-pos-log
  VERSION=$(node -e "console.log(require('./$SRC/manifest.v2.json').version)")
  DEST="$ROOT/notemd.pos-log/$VERSION"
  rm -rf "$DEST"
  mkdir -p "$DEST/bin"
  cp "$SRC/backend/target/$PROFILE/notemd-pos-log" "$DEST/bin/notemd-pos-log"
  cp "$SRC/manifest.v2.json" "$DEST/manifest.json"
  ln -sfn "$VERSION" "$ROOT/notemd.pos-log/current"
  mark_installed "notemd.pos-log" "$VERSION"
  echo "✓ installed notemd.pos-log@$VERSION ($PROFILE, $(uname -m)) → $DEST"
  echo "  enable the v2 runtime:  \"plugins_v2.enabled\": true in settings.json, or NOTEMD_PLUGINS_V2=1"
  echo "  it activates on next app startup and logs to <vault>/pos/YYYY-MM-DD-pos.md"
```

同文件两处同步：`Usage:` 注释行与 `case "$arg"` 的合法插件列表加 `pos-log`。

- [ ] **Step 5.3: 验证 dev 安装脚本干跑**

Run: `bash -n scripts/dev-install-plugin.sh && scripts/dev-install-plugin.sh pos-log 2>&1 | tail -3`
Expected: 语法 OK；构建+安装成功，输出 `✓ installed notemd.pos-log@1.0.0`。

- [ ] **Step 5.4: Commit**

```bash
git add plugins-src/pos-log/manifest.v2.json scripts/dev-install-plugin.sh
git commit -m "feat(pos-log): manifest v2 + dev-install wiring"
```

---

### Task 6: 宿主 Info.plist——定位用途声明

**Files:**
- Modify: `src-tauri/Info.plist`

- [ ] **Step 6.1: 加 key**（插入到根 `<dict>` 内任意兄弟位置；两个 key 都放，覆盖 macOS 版本差异）

```xml
	<key>NSLocationUsageDescription</key>
	<string>note.md records your location to your vault when the Position Log plugin is enabled.</string>
	<key>NSLocationWhenInUseUsageDescription</key>
	<string>note.md records your location to your vault when the Position Log plugin is enabled.</string>
```

- [ ] **Step 6.2: 校验 plist**

Run: `plutil -lint src-tauri/Info.plist`
Expected: `src-tauri/Info.plist: OK`

- [ ] **Step 6.3: Commit**

```bash
git add src-tauri/Info.plist
git commit -m "feat(pos-log): NSLocationUsageDescription in host Info.plist (TCC prompt attribution)"
```

---

### Task 7: 发布线——release-plugins.sh bin-only 形状 + 打包上架

**Files:**
- Modify: `scripts/release-plugins.sh`

- [ ] **Step 7.1: 加 `release_native_bin`**（与 `release_native_ui` 并列；差异仅"无 ui/"。头注释、arg case、usage、dispatch 四处同步加 `pos-log`）

```bash
# ── pos-log: native backend only, per-arch packages (no ui/) ─────────────────
release_native_bin() {
  local id="$1" src="$2" bin_name="$3"
  local manifest="$src/manifest.v2.json"
  local version; version="$(manifest_field "$manifest" version)"
  echo "== $id @ $version =="

  export PATH="$HOME/.cargo/bin:$PATH"
  echo "[$id] building dual-arch backend ($bin_name)…"
  for triple in aarch64-apple-darwin x86_64-apple-darwin; do
    rustup target add "$triple" >/dev/null
    cargo build --release --manifest-path "$src/backend/Cargo.toml" \
      --bin "$bin_name" --target "$triple"
  done

  local identity
  identity=$(security find-identity -v -p codesigning \
    | awk -F\" '/Developer ID Application/ {print $2; exit}') || true
  if [[ -n "$identity" ]]; then
    echo "[$id] codesign with: $identity"
    for triple in aarch64-apple-darwin x86_64-apple-darwin; do
      codesign --force --options runtime --timestamp --sign "$identity" \
        "$src/backend/target/$triple/release/$bin_name"
    done
  else
    echo "[$id] WARNING: no Developer ID Application identity — binaries left unsigned"
  fi

  local out_dir="$OUT_ROOT/$id/$version"
  mkdir -p "$out_dir"
  cp "$manifest" "$out_dir/manifest.json"   # for gen-plugin-index.mjs

  for triple in aarch64-apple-darwin x86_64-apple-darwin; do
    local stage; stage="$(mktemp -d)"
    trap 'rm -rf "$stage"' RETURN
    mkdir -p "$stage/bin"
    cp "$manifest" "$stage/manifest.json"
    cp "$src/backend/target/$triple/release/$bin_name" "$stage/bin/$bin_name"
    chmod +x "$stage/bin/$bin_name"

    local pkg="$out_dir/$triple.notemdpkg"
    zip_pkg "$stage" "$pkg"
    sign_pkg "$pkg"
    local sha; sha="$(shasum -a 256 "$pkg" | awk '{print $1}')"
    echo "[$id] $triple.notemdpkg  sha256=$sha  → $pkg"
    rm -rf "$stage"; trap - RETURN
  done
}

release_pos_log() {
  release_native_bin "notemd.pos-log" "$REPO_ROOT/plugins-src/pos-log" "notemd-pos-log"
}
```

dispatch 加 `pos-log) release_pos_log ;;`，arg case 加 `md2pdf|roam-import|openclaw|exlibris|pos-log)`。

- [ ] **Step 7.2: 打包 + 逐项检查**

Run: `bash -n scripts/release-plugins.sh && scripts/release-plugins.sh pos-log 2>&1 | grep -E "codesign with|sha256=|WARNING"`
Expected: codesign 行 + 两条 sha256 行、无 WARNING。

Run（验签+布局）:
```bash
PUB="RWSp4F+TVeWvKxkXXQIfd9pceHoU1UGBbDCC2BYOtOjeUdtf2X+YG2WT"
for a in aarch64-apple-darwin x86_64-apple-darwin; do
  minisign -V -P "$PUB" -m "dist-plugins/notemd.pos-log/1.0.0/$a.notemdpkg" | head -1
  unzip -l "dist-plugins/notemd.pos-log/1.0.0/$a.notemdpkg" | awk 'NR>3 && NF>3 {print $4}'
done
```
Expected: 两包 `Signature and comment signature verified`；条目恰为 `bin/`、`bin/notemd-pos-log`、`manifest.json`。

- [ ] **Step 7.3: 上架（R2 + KV + 线上验证）**

```bash
node scripts/gen-plugin-index.mjs   # 应输出 5 plugin version(s)
cd plugins-registry
for key in notemd.pos-log/1.0.0/aarch64-apple-darwin.notemdpkg notemd.pos-log/1.0.0/x86_64-apple-darwin.notemdpkg; do
  npx wrangler r2 object put "notemd-plugins/$key" --file "../dist-plugins/$key"
  npx wrangler r2 object put "notemd-plugins/$key.minisig" --file "../dist-plugins/$key.minisig"
done
npx wrangler kv key put index --path ../dist-plugins/index.json --binding INDEX
# 线上端到端（注意 --remote 旗标不存在，加了会静默空跑——绝不要加）
curl -sS "https://plugins.notemd.net/api/index.json?v=$(date +%s)" | grep -o "notemd.pos-log"
curl -sS -o /tmp/pl.pkg "https://plugins.notemd.net/api/download/notemd.pos-log/1.0.0/aarch64-apple-darwin"
shasum -a 256 /tmp/pl.pkg   # 与 7.2 的 aarch64 sha 一致
```

- [ ] **Step 7.4: Commit**

```bash
git add scripts/release-plugins.sh
git commit -m "feat(plugin-market): bin-only packaging shape (release_native_bin) + pos-log published"
```

---

### Task 8: spec 回写（三处实现偏离）

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-pos-log-plugin-design.md`

- [ ] **Step 8.1: 修订** §4（`requestLocation` → 短启停轮询 `.location`，并注明"CLGeocoder 完成块落主 dispatch 队列 ⇒ CoreLocation 服务必须占用**主线程** run loop，serve 挪副线程"）；§5（去掉 `host.vault.mkdir`——`vault_write` 自建父目录）；新增 §12"运行时前置：host.vault.* 接入进程通道"（记录 make_sink services 参数与 dialog/fs/clipboard 仍 UI-only 的边界）；§11 非目标同步（"不做持续订阅"改为"不做**常驻**订阅（短启停轮询不算）"）。

- [ ] **Step 8.2: Commit**

```bash
git add docs/superpowers/specs/2026-07-18-pos-log-plugin-design.md
git commit -m "docs(specs): pos-log — record impl deviations (poll fix, no mkdir, vault-on-process-channel)"
```

---

### Task 9: 全量回归 + 收尾

- [ ] **Step 9.1: 运行时 + 插件全量测试**

Run:
```bash
cd src-tauri && cargo test --lib 2>&1 | tail -3
cd ../plugins-src/pos-log/backend && cargo test 2>&1 | tail -3
```
Expected: 两处全绿（src-tauri ~352+，pos-log 17）。已知 flake：`startup_budget` 并行负载下偶发，单跑复核即可。

- [ ] **Step 9.2: 留给用户的真机验证清单**（不自动化，输出到最终汇报）

1. `scripts/dev-install-plugin.sh pos-log` + `NOTEMD_PLUGINS_V2=1 pnpm tauri dev`
2. 启动后应出现系统定位授权弹窗，标题归因 note.md（⚠️ spec §3 风险点：若弹窗不出现/归因错误 → fallback 讨论）
3. 授权后 ≤1 分钟内 `<vault>/pos/YYYY-MM-DD-pos.md` 出现基线行，格式 `- YYYY-MM-DD HH:mm 国家-省-市 POI`
4. 保持运行 30 分钟不动 → 无新行（地址未变）；位置变化（或用"设置→隐私→定位"重置后换网络环境）→ 追加新行
5. Plugin Market 窗口能看到 Position Log 并从市场安装（已上架）

---

## Self-Review 记录

- **Spec 覆盖**：§2 形态→T5 manifest；§3 权限→T3(授权流)+T6(plist)；§4 取位→T3；§5 文件/写盘→T2(decide)+T4(run_round)；§6 manifest→T5；§7 布局→T2-4；§8 错误表→T4 run_round 各分支；§9 发布线→T5(dev)+T7(release)；§10 测试→T2/T4/T9；偏离回写→T8。无缺口。
- **占位符**：无 TBD/TODO；location.rs 的 objc2 签名风险以"形状不变、按编译器调整"显式圈定，非留白。
- **类型一致性**：`Place` 定义在 logbook（T2），location/plugin 均 `use crate::logbook::Place`（T3 顶部 `use` 与 T4 一致）；`FetchJob.reply` 为 `tokio::sync::oneshot::Sender<Result<Place, String>>`，T4 `reply_rx.await` 匹配；`make_sink` 第 6 参 `Option<Arc<dyn HostServices>>` 在 T1 测试与实现一致。
