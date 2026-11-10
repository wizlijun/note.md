# 智能查找重构（本地优先，阶段 0 与阶段 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把智能查找重建为全新功能：Enter 立即给出本地结果，简答与交给 Agent 建立在本地结果上；移除外部规划器链路和旧界面；同时备好零费用的本地基线评测（E1）和 Jev 客户端原型，用来判定后续模型增强做不做。

**Architecture:** 宿主新增命令 `smart_lookup_local`：调用现有 smart 多臂检索，并把结果登记为查找运行。新窗口组件 `src/SmartLookupApp.svelte` 从零写起，只调用这一个检索命令以及已有的简答、交接命令。规划器（`plan.rs`、规划任务、规划设置）和旧问答兼容模块整体删除。评测与 Jev 客户端是独立的新模块，只在测试中调用。

**Tech Stack:** Rust（Tauri 2、tokio、reqwest、chrono、searchidx）；Svelte 5 + TypeScript；Vitest（happy-dom）。

**Spec:** `docs/superpowers/specs/2026-11-10-smart-lookup-local-first-feasibility-design.md`（附录 E 是本计划的重构范围）

**取代：** `docs/superpowers/plans/2026-11-10-smart-lookup-local-first-phase0-1.md`。那份计划的任务 1、6、7、8 改旧代码，按附录 E 已不适用。

## Global Constraints

- 不改 `searchidx` 的 schema、分词、打分、路由；不改 `notemd search` CLI、MCP 检索和侧栏搜索。
- `src-tauri/src/search/smart.rs` 的融合逻辑（`compile_query`、`execute_smart_plan_locked`、`merge_arm`、`finish_fusion`）不改；只允许改可见性和删除只为计划执行服务的入口。
- 不新增任何 Rust 或 npm 依赖。
- 每次 Enter 的模型调用为 0 次。简答和交给 Agent 只在用户显式点击时启动。
- 输入预览：IME 组字期间不触发；词边界 120ms、其他 400ms 防抖（`src/lib/search/input-trigger.ts` 的 `decideTrigger`）；`deep: false`；走 `notemd_smart_search`。
- 评测只在索引副本上运行，不对线上索引调用 `sweep`、`ensure_built`、`rebuild`；任务文件和评测输出不进仓库。
- 不向任何模型发送 Vault 内容，简答与交接的既有宿主路径除外。Jev 延迟探测只用合成文本。
- 模型请求时限 3 秒，失败不自动重试。
- Jev 接入点：以 `/systemone` 或 `/decisions` 结尾时原样使用，否则补 `/systemone`，保留查询参数；`authMode` 为 `bearer` 或 `none`；非回环地址的明文 `http` 加 `bearer` 拒绝。
- 新增的 Rust 模块与命令只在桌面端编译（放在 `#[cfg(not(target_os = "ios"))]` 的模块里）。
- 窗口标识、入口文件不变：`smart-search.html`、`src/smart-search-main.ts`、Rust 侧打开窗口的 label。
- i18n 新键四个语言文件都要加：`src/lib/i18n/zh.ts`、`en.ts`、`de.ts`、`ja.ts`。
- 用户可见变化写进 `CHANGELOG.md` 与 `CHANGELOG.zh-CN.md` 的「未发布」区；`node scripts/changelog.mjs check` 必须通过。
- 测试命令（在仓库根目录）：
  - 前端：`./node_modules/.bin/vitest run <文件或目录>`
  - Rust：`RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml <过滤词>`
  - `RUSTUP_TOOLCHAIN=stable` 是必须的：`src-tauri/rust-toolchain.toml` 列了七个交叉编译目标，不覆盖会触发下载。
- 提交信息结尾加：

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xhk51Qro1be96URg7VeNwe
```

## Review Focus

1. 索引未就绪时按 Enter（`smart_lookup_local` 返回 `search index not ready`）：显示可重试的错误，输入框可用，不停在转圈。测试在 Task 7。
2. 旧问题的查找响应晚于新问题到达：不得覆盖新结果。测试在 Task 7。
3. 查找运行过期（10 分钟或每窗口 20 个上限）后点「生成简答」：显示「请重新查找」类的错误，不崩溃、不卡住。测试在 Task 7。
4. 评测任务文件里目标路径写错：该题标成「目标不在 vault」并从预筛统计里剔除，不算未召回。测试在 Task 3、Task 4（骨架里已写好）。
5. Jev 服务返回 200 但内容不合约定（HTML 错误页、缺候选、分数越界）：报 `Invalid`，不 panic；不带 `usage` 时正常返回。测试在 Task 5（骨架里已写好）。

## 起点

分支 `feat/smart-lookup-rebuild`，自 `main` 的 `04134696` 切出。工作区里已有未提交的骨架：

- `src-tauri/src/search/time_phrase.rs`、`time_group.rs`、`smart_eval.rs`、`src-tauri/src/smart_model.rs`：类型与签名已定，函数体是 `todo!()`，测试已写好且全部失败。
- `src-tauri/src/search/mod.rs` 与 `src-tauri/src/lib.rs` 的模块注册。

Task 1 的第一步把骨架和本计划、spec 一起提交。

---

### Task 1: 时间短语识别（`time_phrase.rs`）

**Files:**
- Modify: `src-tauri/src/search/time_phrase.rs`
- 提交时一并加入：`src-tauri/src/search/time_group.rs`、`smart_eval.rs`、`src-tauri/src/smart_model.rs`、`src-tauri/src/search/mod.rs`、`src-tauri/src/lib.rs`、`docs/superpowers/specs/2026-11-10-smart-lookup-local-first-feasibility-design.md`、`docs/superpowers/plans/2026-11-10-smart-lookup-local-first-phase0-1.md`、`docs/superpowers/plans/2026-11-10-smart-lookup-rebuild.md`

**Interfaces:**
- Consumes：无。`plan.rs` 将在 Task 9 删除，本文件不得依赖它。
- Produces（签名已在骨架中）：`DetectedTime { source_text, after, before }`、`detect_time_phrase(question: &str, reference: NaiveDate) -> Result<Option<DetectedTime>, String>`、`const ANCHOR_SOURCES: &[&str]`。

本文件自带时间解析，从 `src-tauri/src/search/plan.rs` 移植以下函数，语义保持一致（含时间优先规格的边界规则：滚动窗口两端包含，N 天是含今天在内的 N 个日历日，N 周是 N×7 个日历日，月和年用半开日历区间再转成包含两端）：`time_anchors`（只需要 `AnchorRange` 的起止日期，可改成直接返回 `NaiveDate` 对）、`anchor_for_source`、`parse_rolling_source`、`parse_iso_date_source`、`parse_explicit_year_source`、`parse_explicit_quarter_source`，以及它们用到的日历计算（周、月、季度、年、滚动窗口）。只移植识别需要的部分，`SearchPlanV1` 相关类型一概不要。显式过滤的判断不能调用 `plan.rs` 的 `explicit_filters`：改用 `searchidx::query::parse(question)`，`after` 或 `before` 任一非空即返回 `None`。

`ANCHOR_SOURCES` 列出 `anchor_for_source` 各分支里的全部字面量。识别规则见骨架里 `detect_time_phrase` 的文档注释（五种扫描、去掉被包含的候选、恰好一个才返回）。

- [ ] **Step 1: 提交骨架与文档**

```bash
git add src-tauri/src/search/time_phrase.rs src-tauri/src/search/time_group.rs src-tauri/src/search/smart_eval.rs src-tauri/src/smart_model.rs src-tauri/src/search/mod.rs src-tauri/src/lib.rs docs/superpowers/specs/2026-11-10-smart-lookup-local-first-feasibility-design.md docs/superpowers/plans/2026-11-10-smart-lookup-local-first-phase0-1.md docs/superpowers/plans/2026-11-10-smart-lookup-rebuild.md
git commit -m "chore(smart-lookup): skeleton modules with failing tests; spec and plans"
```

- [ ] **Step 2: 在骨架的 `mod tests` 里补一条测试**

```rust
#[test]
fn every_anchor_source_literal_resolves() {
    let reference = d(2026, 11, 10);
    for source in ANCHOR_SOURCES {
        assert!(
            detect_time_phrase(&format!("关于 {source} 的记录"), reference).unwrap().is_some(),
            "{source}"
        );
    }
}
```

再补一条滚动窗口边界测试：

```rust
#[test]
fn rolling_windows_include_today_and_count_whole_days() {
    let today = d(2026, 11, 10);
    let got = |q: &str| detect_time_phrase(q, today).unwrap().map(|t| (t.after, t.before));
    assert_eq!(got("最近1天的日志"), Some((d(2026, 11, 10), d(2026, 11, 10))));
    assert_eq!(got("过去2周的周报"), Some((d(2026, 10, 28), d(2026, 11, 10))));
    assert_eq!(got("last 3 months of notes"), Some((d(2026, 8, 11), d(2026, 11, 10))));
}
```

- [ ] **Step 3: 运行，确认失败**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml time_phrase`
Expected: 5 条测试全部 FAIL（`todo!` 或 `ANCHOR_SOURCES` 未定义导致编译失败）。

- [ ] **Step 4: 实现**

- [ ] **Step 5: 运行，确认 5 条通过**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml time_phrase`
Expected: PASS（5 passed）

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/search/time_phrase.rs
git commit -m "feat(search): zero-model time phrase detection"
```

---

### Task 2: 时间分组（`time_group.rs`）

**Files:**
- Modify: `src-tauri/src/search/time_group.rs`

**Interfaces:**
- Consumes：Task 1 的 `DetectedTime`；`super::smart::SmartHitDto`。
- Produces（签名已在骨架中）：`time_scoped_query(question, time) -> String`、`TimeGrouped { hits, in_window }`、`group_by_time(in_window, unfiltered, limit) -> TimeGrouped`。行为见骨架的文档注释。

- [ ] **Step 1: 运行骨架测试，确认失败**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml time_group`
Expected: 2 条 FAIL（`todo!`）。

- [ ] **Step 2: 实现两个函数。去重键是 `(path, line, line_end)`。**

- [ ] **Step 3: 运行，确认通过**

Expected: PASS（2 passed）

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/search/time_group.rs
git commit -m "feat(search): soft time grouping that never drops hits"
```

---

### Task 3: 评测核心（`smart_eval.rs`：`load_tasks`、`target_rank`、`pre_gates`）

**Files:**
- Modify: `src-tauri/src/search/smart_eval.rs`

**Interfaces:**
- Produces（签名与文档已在骨架中）：`EvalTarget`、`Category`、`Split`、`EvalTask`、`load_tasks`、`target_rank`、`E1Row`、`PreGates`、`pre_gates`。阈值来自 spec §9.3，已写在 `pre_gates` 的文档注释里。

`pre_gates` 各字段的计算口径（只统计 `target_indexed == true` 的行）：

| 字段 | 规则 |
| --- | --- |
| `scored_tasks` | 参与统计的行数 |
| `rank_6_to_50`、`c3_worth_testing` | `rank` 在 6..=50 的行数；≥ 6 为真 |
| `unrecalled_after_deep`、`c4_worth_testing` | `category != Absent` 且 `rank`、`deep_rank` 都为空的行数；≥ 4 为真 |
| `rollup_share`、`rollup_excerpt_required` | `rank` 非空的行里 `level` 为 `section` 或 `file` 的占比，没有这样的行时为 0.0；≥ 0.25 为真 |
| `time_tasks`、`c2_grouping_ok` | `time_detected` 的行数；为 0 时 `None`，否则 `Some(grouped_rank ≤ 5 的行数 ≥ rank ≤ 5 的行数)` |
| `inferred_constraint_tasks`、`constraint_inference_worth_evaluating` | `needs_inferred_constraint` 的行数；≥ 4 为真 |

- [ ] **Step 1: 运行，确认三条核心测试失败**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml smart_eval`
Expected: `load_tasks_rejects_…`、`pre_gates_apply_…`、`rows_whose_target_…` FAIL；`e1_scores_…` FAIL；`e1_local_baseline` ignored。

- [ ] **Step 2: 实现 `load_tasks`、`target_rank`、`pre_gates`**

- [ ] **Step 3: 运行，确认三条核心测试通过（`e1_scores_…` 留到 Task 4）**

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/search/smart_eval.rs
git commit -m "test(search): smart lookup eval core and pre-gate rules"
```

---

### Task 4: E1 本地基线评测（`run_e1` 与真实 vault 入口）

**Files:**
- Modify: `src-tauri/src/search/smart_eval.rs`
- Modify: `src-tauri/src/search/smart.rs`（`fn smart_search_locked` 改为 `pub(super) fn`，不改逻辑）

**Interfaces:**
- Consumes：Task 1 的 `detect_time_phrase`；Task 2 的 `time_scoped_query`、`group_by_time`；Task 3 的全部；`smart::smart_search_locked(&IndexHandle, Instant, &str, Option<usize>, Option<bool>, Option<u64>, &Arc<AtomicU64>, u64) -> Result<SmartSearchResponse, String>`。
- Produces：`run_e1`（签名已在骨架中）。

`run_e1` 对每个任务固定这样做：

1. `target_indexed`：`absent` 任务为真；其余要求每个目标 `vault_root.join(path).is_file()`。
2. 浅检索：`smart_search_locked(handle, Instant::now(), question, Some(50), Some(false), None, &counter, 1)`，`counter` 为 `Arc::new(AtomicU64::new(1))`。得到 `rank`、`level`、`local_ms`（取 `took_ms`）。
3. `line_share_top30`：前 `min(30, 命中数)` 条里 `level == "line"` 的占比；没有命中时为 0.0。
4. `rank` 为空、`target_indexed` 为真且不是 `absent` 时再跑一次 deep：同上但 `Some(true)`、`Some(4_000)`；得到 `deep_rank`、`deep_ms`。
5. `detect_time_phrase(question, today)?` 有结果时：用 `time_scoped_query` 再做一次浅检索，`group_by_time(带范围的命中, 第 2 步的命中, 50)`，`grouped_rank` 取分组后的位次；`time_detected = true`。

`e1_local_baseline` 的行为写在骨架的文档注释里，补充：

- 环境变量 `NOTEMD_EVAL_VAULT`、`NOTEMD_EVAL_TASKS`、`NOTEMD_EVAL_OUT`；可选 `NOTEMD_EVAL_INDEX_DB`，缺省取 `searchidx::paths::index_db_path(&vault)`。
- 索引副本用 `SearchIndex::open_at(&vault, &副本路径, &crate::cli::search::scan_options_for(&vault).source_globs.stamp())` 打开。
- `stats()?.files == 0` 时 panic，信息写明「索引副本为空：stamp 不匹配或索引尚未建立」。
- `run_e1(.., chrono::Local::now().date_naive())`，把 `{"vault": …, "rows": […], "preGates": {…}}` 写到 `NOTEMD_EVAL_OUT`，并把 `preGates` 打印到标准输出。

- [ ] **Step 1: 运行 `e1_scores_a_fixture_vault_end_to_end`，确认失败**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml e1_scores_a_fixture_vault_end_to_end`
Expected: FAIL（`todo!`）。

- [ ] **Step 2: 实现 `run_e1`、改 `smart_search_locked` 可见性；运行确认通过**

- [ ] **Step 3: 实现 `e1_local_baseline`**

- [ ] **Step 4: 确认全部评测测试通过、入口默认被跳过**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml smart_eval`
Expected: 4 passed，`e1_local_baseline ... ignored`。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/search/smart_eval.rs src-tauri/src/search/smart.rs
git commit -m "test(search): E1 local baseline evaluation over an index copy"
```

---

### Task 5: Jev 客户端原型与延迟探测（`smart_model.rs`）

**Files:**
- Modify: `src-tauri/src/smart_model.rs`

**Interfaces:**
- Produces（签名与行为已在骨架的文档注释中）：`AuthMode`、`JevConfig`、`jev_endpoint`、`validate_jev_config`、`NoulQuestion`、`Usage`、`NoulOutcome`、`ModelError`、`score_noul`。

补充约定：

- `ModelError` 用 `#[derive(Debug, Clone, PartialEq)]`（骨架已有）。超时判断用 `reqwest::Error::is_timeout()`，也可以用 `tokio::time::timeout` 包住整个请求；读响应体的时间也计入时限。
- 非 2xx 返回 `Http(状态码)`，不读或不校验响应体。
- `scores` 的顺序与入参 `questions` 一致。

`jev_latency_probe` 补充：

- 环境变量 `NOTEMD_EVAL_JEV_URL`、`NOTEMD_EVAL_JEV_MODEL`、`NOTEMD_EVAL_JEV_AUTH`（`bearer` 或 `none`，缺省 `bearer`）、`NOTEMD_EVAL_JEV_KEY`。先 `validate_jev_config`。
- 对 K = 10 和 K = 30 各顺序发 20 次请求，时限 3 秒。每个候选的 `instructions` 是 `{"question": "这段文字是否在讨论软件发布计划？", "passage": <合成段落>}`，合成段落是句子「这是一段用于测量延迟的合成文本，不含任何真实笔记内容。」重复到 400 个字符。`state` 是 `"latency probe"`。
- 每个 K 打印一行：成功数、超时数、成功请求的 P50 与 P95 毫秒、有 `usage` 时的平均 `input_tokens`。

- [ ] **Step 1: 运行，确认 6 条失败**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml smart_model`
Expected: 6 FAIL，1 ignored。

- [ ] **Step 2: 实现；运行确认 6 条通过、探测入口被跳过**

- [ ] **Step 3: 实现 `jev_latency_probe`；再运行一次确认结果不变**

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/smart_model.rs
git commit -m "feat(smart-lookup): Jev Noul client prototype with configurable endpoint"
```

---

### Task 6: 宿主命令 `smart_lookup_local`，本地结果登记为查找运行

**Files:**
- Modify: `src-tauri/src/smart_lookup.rs`（`retain_in` 附近）
- Modify: `src-tauri/src/search/mod.rs`（在 `notemd_smart_search` 旁边加结构和命令）
- Modify: `src-tauri/src/lib.rs`（`generate_handler!` 列表加 `search::smart_lookup_local`）
- Test: `src-tauri/src/search/smart.rs` 的 `mod tests`、`src-tauri/src/search/mod.rs` 的测试模块

**Interfaces:**
- Produces:

```rust
// smart_lookup.rs
pub(crate) fn retain_search_in(window_label: &str, root: &Path, original_query: &str,
    search: &mut crate::search::smart::SmartSearchResponse) -> Result<String, String>   // 返回 run id，并给每条命中写 result_id
pub(crate) fn retain_local_search(window: &tauri::Window, original_query: &str,
    search: &mut crate::search::smart::SmartSearchResponse) -> Result<String, String>
#[cfg(test)]
pub(crate) fn summary_prompt_for_run(run_id: &str, window_label: &str) -> Result<String, String>
    // 从登记表取出该运行（窗口不符时报错），返回 prepare_summary_in(&run, &[], 4, 4_000, "bullets") 的 prompt

// search/mod.rs
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLookupResponse {
    pub search: smart::SmartSearchResponse,
    pub lookup_run_id: String,
}
fn local_lookup_budget(limit: Option<usize>, deep: Option<bool>, timeout_ms: Option<u64>) -> (usize, bool, Option<u64>)
#[tauri::command(async)]
pub fn smart_lookup_local(app: AppHandle, window: tauri::Window, question: String,
    limit: Option<usize>, deep: Option<bool>, timeout_ms: Option<u64>,
) -> Result<LocalLookupResponse, String>
```

定死的行为：

- `retain_in`（现被 `retain_planned_search` 使用）改为调用 `retain_search_in` 并把返回值写进 `response.lookup_run_id`，登记逻辑只留一份。`retain_planned_search` 本任务不删（Task 9 删）。
- `local_lookup_budget`：`limit` 在 1..=100 内保留，否则 100；`deep` 缺省 `false`；`deep == false` 时 `timeout_ms` 原样透传；`deep == true` 时 `None` 或 `Some(0)` 取 4_000，其余取 `min(值, 5_000)`。
- `smart_lookup_local`：`question.trim()` 为空返回 `Err("empty question")`；否则调 `smart::run_smart_search_command(app, window.clone(), question.clone(), Some(limit), Some(deep), timeout)`，再调 `crate::smart_lookup::retain_local_search` 登记（总是登记），返回 run id。

- [ ] **Step 1: 写失败的测试**

`search/mod.rs` 测试模块：

```rust
#[test]
fn local_lookup_budget_bounds_limit_and_deep_timeout() {
    assert_eq!(local_lookup_budget(None, None, None), (100, false, None));
    assert_eq!(local_lookup_budget(Some(50), Some(false), Some(900)), (50, false, Some(900)));
    assert_eq!(local_lookup_budget(Some(0), Some(true), None), (100, true, Some(4_000)));
    assert_eq!(local_lookup_budget(Some(500), Some(true), Some(9_000)), (100, true, Some(5_000)));
}
```

`search/smart.rs` 的 `mod tests`，索引搭建照同文件 `planned_executor_uses_typed_multiword_filters` 的写法：

```rust
#[test]
fn a_local_smart_search_can_be_retained_as_a_lookup_run() {
    // vault 写入 a.md: "# A\nrelease risk details\n"；open_at + sweep；handle；counter
    let mut response = smart_search_locked(&handle, Instant::now(), "release risk",
        Some(20), Some(false), None, &counter, 1).unwrap();

    let run_id = crate::smart_lookup::retain_search_in("smart-search", vault.path(), "release risk", &mut response).unwrap();

    assert!(!run_id.is_empty());
    assert!(!response.hits.is_empty());
    assert!(response.hits.iter().all(|hit| hit.result_id.is_some()));
    let prompt = crate::smart_lookup::summary_prompt_for_run(&run_id, "smart-search").unwrap();
    assert!(prompt.contains("release risk details"));
    assert!(crate::smart_lookup::summary_prompt_for_run(&run_id, "another-window").is_err());
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml -- local_lookup_budget a_local_smart_search_can_be_retained`
Expected: 编译失败。

- [ ] **Step 3: 实现并注册命令**

- [ ] **Step 4: 运行新测试与 `smart_lookup` 原有测试，确认通过**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml -- local_lookup_budget a_local_smart_search_can_be_retained smart_lookup`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/smart_lookup.rs src-tauri/src/search/mod.rs src-tauri/src/search/smart.rs src-tauri/src/lib.rs
git commit -m "feat(smart-lookup): smart_lookup_local command retains local results as a lookup run"
```

---

### Task 7: 全新查找窗口 `SmartLookupApp.svelte`，替换旧窗口

**Files:**
- Create: `src/SmartLookupApp.svelte`
- Create: `src/SmartLookupApp.test.ts`
- Modify: `src/smart-search-main.ts`（改为挂载 `SmartLookupApp`）
- Modify: `src/lib/smart-search/api.ts`（删 `planContext`、`plannedSearch`；加 `localLookup`）
- Modify: `src/lib/smart-search/store.svelte.ts`、`store.test.ts`（加 `fail`）
- Modify: `src/lib/smart-search/workflow-log.ts`、`workflow-log.test.ts`
- Create: `src/lib/smart-search/hit-key.ts`（只导出 `hitKey`，函数体从 `selection.ts` 搬过来）
- Delete: `src/SmartSearchApp.svelte`、`src/SmartSearchApp.test.ts`、`src/lib/smart-search/plan.ts`、`plan.test.ts`、`selection.ts`、`selection.test.ts`
- Modify: `src/lib/i18n/zh.ts`、`en.ts`、`de.ts`、`ja.ts`

**Interfaces:**
- Consumes：Task 6 的命令 `smart_lookup_local`，参数 `{ question, limit, deep, timeoutMs }`，返回 `{ search: SmartSearchResponse, lookupRunId: string }`；已有命令 `notemd_smart_search`（预览）、`smart_lookup_start_summary`、`smart_lookup_start_handoff`、`editor_show_and_reveal_search_hit`、`hide_smart_search_window`；已有模块 `src/lib/search/{grouping,preview,input-trigger}.ts`、`src/lib/ime.ts`、`src/lib/smart-search/{agent,summary,handoff,model-routing,store.svelte}.ts`、`src/lib/settings.svelte.ts`。
- Produces:

```ts
// api.ts
smartSearchApi.localLookup(question: string, options?: { limit?: number; deep?: boolean; timeoutMs?: number })
  : Promise<{ search: SmartSearchResponse; lookupRunId: string }>
// store.svelte.ts
SmartSearchStore.fail(query: string, message: string): void
  // sequence++；query = query；hits = []；error = message；loading = false；truncated = false；deepAvailable = false
// workflow-log.ts
export type WorkflowStage = 'preview' | 'search' | 'summary' | 'handoff'
// WorkflowEntry 新增 elapsedMs?: number、usage?: unknown
export function formatWorkflowLog(entries: WorkflowEntry[]): string
  // 每条一行 JSON，键顺序 stage, level, elapsedMs, usage, message；缺失的 elapsedMs、usage 输出 null；行间 '\n'
// hit-key.ts
export function hitKey(hit: Pick<SearchHit, 'path' | 'line' | 'lineEnd'>): string
```

**窗口行为（新组件从零写，不从旧组件复制结构）：**

1. **启动**：`loadLocale`、`watchLocaleChanges`、`loadSettings`；`loadSearchAgentOptions()` 与 `loadDefaultAgentProvider()` 失败时只禁用简答和交接，不影响查找。窗口获得焦点时选中输入框文本。
2. **输入**：多行 `textarea.query-input`；IME 用 `createImeGuard`，组字期间不预览、不提交。每次输入按 `decideTrigger` 安排预览：`clear` 清空结果，`hold` 不动，`search` 在延迟后调用 `store.run(query, { deep: false, limit })`。预览阶段标题为 `smartSearch.quickPreview`。
3. **Enter（无 Shift）**：取消待执行的预览；递增请求序号；清空简答、交接与活动记录；记下 `startedAt = performance.now()`；调 `localLookup(question, { limit, deep: false })`。
   - 成功且仍是当前请求：`store.apply(question, result.search)`；记住 `lookupRunId`；第一条设为当前项；活动记录追加 `('search', 'success', activitySearchDone)`，带 `elapsedMs`。标题为 `smartSearch.localResults`。
   - 失败且仍是当前请求：`store.fail(question, 信息)`；活动记录追加 `('search', 'error', …)`。列表区显示 `.state.error`，内含 `smartSearch.retry` 按钮，点击重新执行 Enter 流程。输入框始终可用。
   - 迟到的旧响应一律丢弃。
4. **结果列表**：`settings.smartLookup.results.groupBy === 'date'` 时按 `docDate` 的 `YYYY-MM` 分组（无日期的放最后一组），否则用 `groupHits`。每行 `.result-row`，显示标题或面包屑与 `previewLine` 摘要，高亮词取 `parseHighlightTerms(当前问题)`。零结果时显示 `search.noResults` 与 `smartSearch.noResultsHint`。
5. **键盘**：输入框光标在最后一行时 ↓ 进入第一条结果；结果上 ↑↓ 移动、Home/End 到首尾、Enter 打开当前项；Escape 在任何位置都隐藏窗口（先取消在途工作）。
6. **预览区**：显示当前项的路径与行号、`highlightParts` 渲染的原文，一个打开按钮（`.preview-header .text-button`），调用 `editor_show_and_reveal_search_hit`，参数沿用旧窗口的格式 `{ path: absPath, line, … }`。
7. **操作菜单**（`.more-actions` 打开 `.actions-menu[role="menu"]`，菜单项是 `button.menu-row[role="menuitem"]`）：
   - `smartSearch.copyReference`：复制 `path:line`。
   - `smartSearch.expandSearch`：仅在有 `lookupRunId` 且（零结果或 `deepAvailable`）时出现；调 `localLookup(question, { limit, deep: true, timeoutMs: settings.smartLookup.results.deepTimeoutMs })`，按第 3 步应用。
   - `smartSearch.generateSummary`：仅在 `settings.smartLookup.summary.enabled`、有 `lookupRunId`、有可用的简答 Agent、且至少一条可见结果是 `level === 'line'` 且正文非空时可点。调 `smart_lookup_start_summary`（参数同旧窗口：`lookupRunId`、`selectedResultIds: []`、`sourceLimit`、`charLimit`、`style`、`provider`、`invocationId`、模型选择器），再 `pollAgentTask`，最后 `validateSummaryOutput` 后显示在 `.answer-body`。失败（含「lookup run expired」）时在内容区显示 `smartSearch.summaryUnavailable` 与错误信息，按钮恢复可用。新查找会取消在途简答。
   - `smartSearch.handoff`（交给 Agent）：用 `buildHandoffPacket` 与 `smart_lookup_start_handoff`；`settings.smartLookup.handoff.includeSelectedRefs` 为假时不带结果引用。成功后显示可打开该 Agent 窗口的链接。
   - `smartSearch.copyActivity`：仅在有活动记录时出现，复制 `formatWorkflowLog(entries)`。
8. **活动记录**：每条带 `elapsedMs = Math.round(performance.now() - startedAt)`；简答成功那条带 `usage`。
9. **不提供**：多选、移除与撤销、来源筛选、窗口内设置面板。右上角的设置按钮调用已有的打开主设置的命令（沿用旧窗口 `openSettings` 的做法）。
10. **模型调用**：Enter 与预览永不启动 Agent 任务；只有简答和交接按钮会。

i18n 新键（四个语言文件）：

| 键 | zh | en | de | ja |
| --- | --- | --- | --- | --- |
| `smartSearch.localResults` | 本地结果 | Local results | Lokale Ergebnisse | ローカル結果 |
| `smartSearch.copyActivity` | 复制活动记录 | Copy activity log | Aktivitätsprotokoll kopieren | アクティビティログをコピー |

只服务旧窗口、新窗口不再引用的 `smartSearch.*` 键保留不删（它们可能被设置对话框引用，Task 8 再清理）。

- [ ] **Step 1: `workflow-log` 与 `store.fail` 的单元测试先行**

`workflow-log.test.ts` 加：

```ts
it('formats entries as one JSON object per line with timing and usage', () => {
  const text = formatWorkflowLog([
    { id: 1, stage: 'search', level: 'success', message: '找到 3 条', elapsedMs: 42 },
    { id: 2, stage: 'summary', level: 'success', message: 'ok', elapsedMs: 9100, usage: { input_tokens: 5 } },
    { id: 3, stage: 'handoff', level: 'warning', message: 'no timing' },
  ])
  expect(text.split('\n')).toEqual([
    '{"stage":"search","level":"success","elapsedMs":42,"usage":null,"message":"找到 3 条"}',
    '{"stage":"summary","level":"success","elapsedMs":9100,"usage":{"input_tokens":5},"message":"ok"}',
    '{"stage":"handoff","level":"warning","elapsedMs":null,"usage":null,"message":"no timing"}',
  ])
})
```

该文件已有用例里出现的 `stage: 'plan'` 改为 `'summary'`（`plan` 阶段不再存在）。

`store.test.ts` 加：

```ts
it('records a failed lookup without keeping stale hits', async () => {
  // 先用同文件已有样例让 store.run('old') 产生命中
  store.fail('new', 'search index not ready')
  expect(store).toMatchObject({ query: 'new', error: 'search index not ready', loading: false })
  expect(store.hits).toEqual([])
})
```

Run: `./node_modules/.bin/vitest run src/lib/smart-search/workflow-log.test.ts src/lib/smart-search/store.test.ts`
Expected: 新用例 FAIL。实现后 PASS。

- [ ] **Step 2: 写 `SmartLookupApp.test.ts`（先失败）**

mock 结构参照被删除的 `src/SmartSearchApp.test.ts`（先读它再删）：`@tauri-apps/api/core` 的 `invoke`、`@tauri-apps/api/window`、`@tauri-apps/plugin-clipboard-manager`、`@tauri-apps/plugin-store`、`@tauri-apps/api/event`。`invoke` 至少要处理：`get_plugin_manifests`、`plugin_v2_execute`（`harness-status`、`run-task`、`run-status`、`run-cancel`）、`smart_lookup_agent_default`、`notemd_smart_search`、`smart_lookup_local`、`smart_lookup_start_summary`、`smart_lookup_start_handoff`、`plugin_v2_open_window`、`editor_show_and_reveal_search_hit`、`hide_smart_search_window`。`smart_lookup_local` 的 mock 支持：可挂起（gate）、可抛错、`deep: true` 时返回 3 条、问题为 `'new question'` 时返回单条 `new-result`，返回 `lookupRunId: 'run-' + question`。

必须有的用例（名字可以照抄）：

| 用例 | 断言 |
| --- | --- |
| `typing previews locally without any agent task` | 输入后 `notemd_smart_search` 以 `deep: false` 调用 1 次；没有任何 `run-task` |
| `Enter shows local results immediately with zero model calls` | Enter 后标题含 `Local results`，3 行 `.result-row`；`smart_lookup_local` 参数含 `{ question: 'release risk', deep: false }`；没有任何 `run-task` |
| `Enter does not wait for the preview debounce` | 设值后立刻 Enter：3 行结果，`notemd_smart_search` 调用 0 次 |
| `a late response for a superseded question is ignored` | 第一次挂起；提交 `old question` 再提交 `new question`；放开后页面含 `new-result`，不含 `alpha` |
| `index not ready shows retry and keeps the input usable` | 抛 `search index not ready`：出现 `.state.error`，输入框未禁用，没有 `.spinner`；清除错误后点 `Try again` 得到 3 行 |
| `arrow keys navigate results and Enter opens the active hit` | ↓ 进入第一条，再 ↓ 到第二条，Enter 调用 `editor_show_and_reveal_search_hit`，参数 `path` 为第二条的 `absPath` |
| `Escape hides the window` | 调用 `hide_smart_search_window` |
| `copy reference copies path and line` | 剪贴板收到 `notes/alpha.md:4` |
| `expand search runs a deep local lookup on zero results` | 预览与本地都为空；菜单 `Expand search` 后 `smart_lookup_local` 以 `{ deep: true, timeoutMs: 4000 }` 调用，出现 3 行 |
| `summary runs only on click and renders validated output` | Enter 后没有 `search-summary` 的 `run-task`；点 `Create answer` 后 `smart_lookup_start_summary` 参数含 `lookupRunId: 'run-release risk'`，`.answer-body` 出现 |
| `an expired lookup run shows a summary error and re-enables the action` | `smart_lookup_start_summary` 抛 `lookup run expired; run Smart Lookup again`：内容区出现错误，`Create answer` 再次可点 |
| `a new lookup cancels a running summary` | 简答轮询中提交新问题：发出 `run-cancel`；旧简答结果不显示 |
| `handoff sends only relative references` | `smart_lookup_start_handoff` 的 `selectedRefs` 只含相对路径；设置关掉引用时为空 |
| `copy activity log includes elapsed time` | 复制内容每行可 JSON 解析，`stage: 'search'` 那条的 `elapsedMs` 是非负数 |

Run: `./node_modules/.bin/vitest run src/SmartLookupApp.test.ts`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现 `api.ts`、`hit-key.ts`、i18n、`SmartLookupApp.svelte`，改 `smart-search-main.ts`；删除旧窗口、旧测试、`plan.ts`、`selection.ts` 及其测试**

- [ ] **Step 4: 运行，确认通过**

Run: `./node_modules/.bin/vitest run src/SmartLookupApp.test.ts src/lib/smart-search src/lib/search`
Expected: PASS

Run: `./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json --threshold error`
Expected: 0 errors。

- [ ] **Step 5: 提交**

```bash
git add -A src/SmartLookupApp.svelte src/SmartLookupApp.test.ts src/SmartSearchApp.svelte src/SmartSearchApp.test.ts src/smart-search-main.ts src/lib/smart-search src/lib/i18n
git commit -m "feat(smart-lookup): rebuild the lookup window local-first"
```

---

### Task 8: 移除前端规划器设置与代码，更新设置对话框与 CHANGELOG

**Files:**
- Modify: `src/lib/smart-search/settings.ts`、`settings.test.ts`
- Modify: `src/lib/smart-search/agent.ts`、`agent.test.ts`（删 `SEARCH_PLAN_TASK`、`supportsSearchPlanner` 及只为规划任务服务的分支）
- Modify: `src/lib/smart-search/model-routing.ts`、`model-routing.test.ts`（`SearchModelPhase` 只剩 `'summary'`）
- Modify: `src/components/SettingsDialog.svelte`、`src/components/SettingsDialog.search-tab.test.ts`（删规划器服务方与模型选项）
- Modify: `src/lib/i18n/*.ts`（删除已无引用的规划器文案键）
- Modify: `CHANGELOG.md`、`CHANGELOG.zh-CN.md`

**Interfaces:**
- Produces：`SmartLookupSettings = { results, summary, handoff }`，不再有 `planner`。`summary.provider` 的 `'same_as_planner'` 取值删除；旧设置里存的 `'same_as_planner'` 规整为 `'auto'`。

定死的行为：

- `normalizeSmartLookupSettings` 忽略旧的 `planner` 键，不报错。
- 设置对话框保留结果、简答、交接三组选项。
- 全仓 `grep -rn "search-plan\|SEARCH_PLAN\|supportsSearchPlanner\|same_as_planner\|smartLookup.planner" src` 无结果（i18n 文件里的键名不算，只要没有代码引用；删掉的键四个语言文件同步删）。

- [ ] **Step 1: 写失败的测试**（`settings.test.ts`）

```ts
it('has no planner settings and drops legacy planner values', () => {
  const normalized = normalizeSmartLookupSettings({
    planner: { enabled: true, provider: 'notemd.codex-agent', timeoutMs: 30_000 },
    summary: { provider: 'same_as_planner' },
  })
  expect('planner' in normalized).toBe(false)
  expect('planner' in DEFAULT_SMART_LOOKUP_SETTINGS).toBe(false)
  expect(normalized.summary.provider).toBe('auto')
})
```

同文件已有用例中断言 `planner` 的部分删掉。

- [ ] **Step 2: 运行确认失败，实现，运行确认通过**

Run: `./node_modules/.bin/vitest run src/lib/smart-search src/components/SettingsDialog.search-tab.test.ts src/SmartLookupApp.test.ts`
Expected: PASS

Run: `./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json --threshold error`
Expected: 0 errors。

- [ ] **Step 3: CHANGELOG**

「未发布」区，放在最前。zh：

```markdown
- **智能查找重写为本地优先。** 按 Enter 立即显示本地结果，不再先启动外部 Agent 理解问题；输入和查找过程都不调用模型。简答和交给 Agent 改为基于本地结果，仍需手动点击。旧界面的多选、移除与撤销、来源筛选和窗口内设置不再提供，相关设置在设置对话框里。
```

en：

```markdown
- **Smart Lookup is rebuilt local-first.** Pressing Enter shows local results immediately instead of first starting an external Agent to interpret the question; neither typing nor searching calls a model. Answers and Agent handoff now work from the local results and still start only on click. Multi-select, remove and undo, the source filter and the in-window settings panel are gone; the remaining options live in Settings.
```

Run: `node scripts/changelog.mjs check`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add -A src/lib/smart-search src/components/SettingsDialog.svelte src/components/SettingsDialog.search-tab.test.ts src/lib/i18n CHANGELOG.md CHANGELOG.zh-CN.md
git commit -m "refactor(smart-lookup): remove the planner from settings and agent helpers"
```

---

### Task 9: 移除宿主侧规划器与旧问答兼容模块

**Files:**
- Delete: `src-tauri/src/search/plan.rs`、`src-tauri/src/smart_search.rs`
- Modify: `src-tauri/src/search/mod.rs`（删 `mod plan;`、命令 `notemd_planned_search`、`notemd_search_plan_context` 及其测试）
- Modify: `src-tauri/src/search/smart.rs`（删 `planned_search_locked`、`PlannedQueryArm`，以及只为它们服务的 `QueryArm::typed_query`、`render_typed_query`、`json_string` 等；删对应测试）
- Modify: `src-tauri/src/smart_lookup.rs`（删 `retain_planned_search`、`retain_in`）
- Modify: `src-tauri/src/lib.rs`（删 `pub mod smart_search;` 与 7 个命令的注册）
- 若存在：Tauri 权限或能力清单里对这些命令的引用一并删除（`grep -rn "planned_search\|search_plan_context\|smart_search_freeze\|smart_search_archive\|smart_search_record\|smart_search_write\|smart_search_memory" src-tauri` 决定范围）

**Interfaces:**
- Consumes：Task 6 的 `retain_search_in` 已承担登记。

定死的行为：

- 删除后，`grep -rn "plan::\|SearchPlanV1\|planned_search\|search_plan_context\|smart_search::" src-tauri/src` 无结果。
- `smart.rs` 的融合逻辑与其余测试不变。
- 被删命令的前端调用在 Task 7、8 已移除；`grep -rn "notemd_planned_search\|notemd_search_plan_context\|smart_search_freeze\|smart_search_memory_context\|smart_search_archive_answer\|smart_search_record_feedback\|smart_search_write_document" src` 无结果（测试文件里作为「旧命令不得调用」的断言名单除外）。

- [ ] **Step 1: 删除前先跑一次相关测试作基线**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml -- search:: smart_lookup smart_model > /tmp/task9-before.log 2>&1; tail -5 /tmp/task9-before.log`
Expected: PASS，记下通过数。

- [ ] **Step 2: 删除并清理引用**

- [ ] **Step 3: 编译与测试**

Run: `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml -- search:: smart_lookup smart_model`
Expected: PASS；通过数等于基线减去被删测试数。

Run: `RUSTUP_TOOLCHAIN=stable cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 无 error；不新增 warning。

- [ ] **Step 4: 提交**

```bash
git add -A src-tauri
git commit -m "refactor(smart-lookup): remove the host planner and the legacy answer module"
```

---

## 实施完成后的测量（由用户执行，产出决定下一份计划）

| 测量 | 命令或做法 | 产出 |
| --- | --- | --- |
| E1 本地基线 | `NOTEMD_EVAL_VAULT=<vault> NOTEMD_EVAL_TASKS=<任务文件> NOTEMD_EVAL_OUT=<输出.json> RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml e1_local_baseline -- --ignored --nocapture` | 每题一行，加 `preGates` |
| Jev 延迟 | `NOTEMD_EVAL_JEV_URL=… NOTEMD_EVAL_JEV_MODEL=… NOTEMD_EVAL_JEV_AUTH=… NOTEMD_EVAL_JEV_KEY=… RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml jev_latency_probe -- --ignored --nocapture` | K=10 与 K=30 的 P50、P95、超时数 |
| C1 首个结果时间 | 在真实 vault 上连续 20 次不同问题按 Enter，每次「复制活动记录」，取 `stage: "search"` 那条的 `elapsedMs` | P95 是否 ≤ 500ms |

任务文件格式见 `smart_eval.rs` 的 `EvalTask`，顶层 `{"tasks": […]}`；spec §9.1 要求 40 题，dev 与 holdout 各 20。
