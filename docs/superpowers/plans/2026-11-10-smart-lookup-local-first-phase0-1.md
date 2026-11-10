# 智能查找本地优先（阶段 0 与阶段 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enter 后立即给出本地结果并保留简答；同时备好零费用的本地基线评测（E1）、计时与用量字段（E4）和 Jev 客户端原型，用来判定后续模型增强做不做。

**Architecture:** 前端 `runSmartLookup` 改为先调新的宿主命令 `smart_lookup_local`，展示本地结果并登记查找运行；headless 规划器降为 `enhance.mode = 'agent'` 下的非阻塞增强。评测是 `src-tauri` 里的 `#[cfg(test)]` 模块，复用现有 smart 检索路径，在索引副本上运行。Jev 客户端是独立模块，本计划只在测试里调用它。

**Tech Stack:** Rust（Tauri 2、tokio、reqwest、chrono、searchidx）；Svelte 5 + TypeScript；Vitest（happy-dom）。

**Spec:** `docs/superpowers/specs/2026-11-10-smart-lookup-local-first-feasibility-design.md`

**范围：** 覆盖 spec §8.1 的阶段 0（E1、E4 取数、Jev 客户端原型与延迟探测）和阶段 1。不含 E2、E3、候选判断、查询修复、时间分组的产品接线（阶段 1b）、直连模式的设置界面和密钥存放。这些要等 E1 的预筛结果（spec §9.3）出来后另写计划。Task 2 的时间识别与分组只被评测调用，不接进产品。

## Global Constraints

- 不改 `searchidx` 的 schema、分词、打分、路由；不改 `notemd search` CLI 和 MCP 检索；不改 `src-tauri/src/search/smart.rs` 的融合逻辑（只允许改可见性）；`SearchPlanV1` 线格式与校验不变。
- 不新增任何 Rust 或 npm 依赖。
- `enhance.mode` 默认 `'off'`：默认路径下每次 Enter 的模型调用为 0 次。
- 输入预览行为不变：120ms 与 400ms 防抖、`deep: false`、走 `notemd_smart_search`。
- 评测只在索引副本上运行，不对线上索引调用 `sweep`、`ensure_built`、`rebuild`；任务文件和评测输出不进仓库。
- 本计划不向任何模型发送 Vault 内容。Jev 延迟探测只用合成文本。
- 模型请求时限 3 秒，失败不自动重试。
- Jev 接入点：以 `/systemone` 或 `/decisions` 结尾时原样使用，否则补 `/systemone`，保留查询参数；`authMode` 为 `bearer` 或 `none`；非回环地址的明文 `http` 加 `bearer` 拒绝。
- 新增的 Rust 模块与命令只在桌面端编译，放在 `#[cfg(not(target_os = "ios"))]` 的模块里。
- i18n 新键四个语言文件都要加：`src/lib/i18n/zh.ts`、`en.ts`、`de.ts`、`ja.ts`。
- 用户可见变化写进 `CHANGELOG.md` 与 `CHANGELOG.zh-CN.md` 的「未发布」区；`node scripts/changelog.mjs check` 必须通过。
- 测试命令：前端 `pnpm exec vitest run <文件>`；Rust `cargo test --manifest-path src-tauri/Cargo.toml <过滤词>`。

## Review Focus

1. 索引未就绪时按 Enter（`smart_lookup_local` 返回 `search index not ready`）：应显示可重试的错误状态，输入框仍可用，不能停在转圈。测试在 Task 8。
2. 旧问题的本地查找响应晚于新问题到达：不得覆盖新结果。测试在 Task 8。
3. `agent` 模式下规划失败或超时：本地结果保持可点击，标题仍是「本地结果」，出现提示。测试在 Task 8。
4. 评测任务文件里目标路径写错：该题必须标成「目标不在 vault」并从预筛统计里剔除，不能算成未召回。测试在 Task 3 和 Task 4。
5. Jev 服务返回 200 但内容不合约定（HTML 错误页、缺候选、分数越界）：报 `Invalid`，不 panic；不带 `usage` 时正常返回。测试在 Task 5。

---

### Task 1: 活动记录带计时与用量，可复制

E4 靠它取数：现有规划器的耗时和用量、以及阶段 1 之后本地结果的耗时，都从这里读。

**Files:**
- Modify: `src/lib/smart-search/workflow-log.ts`
- Test: `src/lib/smart-search/workflow-log.test.ts`
- Modify: `src/SmartSearchApp.svelte`（`appendActivity` L580–L595、`runSmartLookup` L703、`scheduleSearch` L377、操作菜单）
- Modify: `src/lib/i18n/zh.ts`、`en.ts`、`de.ts`、`ja.ts`
- Test: `src/SmartSearchApp.test.ts`
- Modify: `CHANGELOG.md`、`CHANGELOG.zh-CN.md`

**Interfaces:**
- Produces:
  - `WorkflowEntry` 新增可选字段 `elapsedMs?: number`、`usage?: unknown`。
  - `formatWorkflowLog(entries: WorkflowEntry[]): string`：每条一行 JSON，键顺序固定为 `stage, level, elapsedMs, usage, message`，缺失的 `elapsedMs`、`usage` 输出 `null`，行间用 `\n`。
  - 组件内 `let lookupStartedAt: number | null`；`appendActivity(stage, level, message, detail: { runId?: string; steps?: number; usage?: unknown } = {})`，在 `lookupStartedAt !== null` 时写入 `elapsedMs = Math.round(performance.now() - lookupStartedAt)`。
  - i18n 键 `smartSearch.copyActivity`：zh「复制活动记录」、en `Copy activity log`、de `Aktivitätsprotokoll kopieren`、ja「アクティビティログをコピー」。

- [ ] **Step 1: 写失败的单元测试**（`workflow-log.test.ts`）

```ts
it('formats entries as one JSON object per line with timing and usage', () => {
  const text = formatWorkflowLog([
    { id: 1, stage: 'search', level: 'success', message: '找到 3 条', elapsedMs: 42 },
    { id: 2, stage: 'plan', level: 'success', message: 'ok', elapsedMs: 9100, usage: { input_tokens: 5 } },
    { id: 3, stage: 'plan', level: 'warning', message: 'no timing' },
  ])
  expect(text.split('\n')).toEqual([
    '{"stage":"search","level":"success","elapsedMs":42,"usage":null,"message":"找到 3 条"}',
    '{"stage":"plan","level":"success","elapsedMs":9100,"usage":{"input_tokens":5},"message":"ok"}',
    '{"stage":"plan","level":"warning","elapsedMs":null,"usage":null,"message":"no timing"}',
  ])
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run src/lib/smart-search/workflow-log.test.ts`
Expected: FAIL，`formatWorkflowLog` 未导出。

- [ ] **Step 3: 在 `workflow-log.ts` 里加两个字段和 `formatWorkflowLog`**

- [ ] **Step 4: 运行，确认通过**

- [ ] **Step 5: 写失败的组件测试**（`SmartSearchApp.test.ts`）

```ts
it('copies an activity log whose entries carry elapsed time and planner usage', async () => {
  mocks.statusResults.push({
    state: 'done',
    record: { status: 'success', usage: { input_tokens: 1200, output_tokens: 80 } },
    terminal_result: { complete: true, content: JSON.stringify(planJson()) },
  })
  const input = await mountReady()
  await typeAndWait(input)
  await pressEnter(input)
  await chooseMenuAction('Copy activity log')
  const lines = String(mocks.writeText.mock.calls.at(-1)?.[0]).split('\n').map((line) => JSON.parse(line))
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.every((line) => typeof line.elapsedMs === 'number' && line.elapsedMs >= 0)).toBe(true)
  expect(lines.some((line) => line.stage === 'plan' && line.usage?.input_tokens === 1200)).toBe(true)
})
```

- [ ] **Step 6: 实现组件改动**
  - `runSmartLookup` 通过开头的守卫后设 `lookupStartedAt = performance.now()`；`scheduleSearch` 里设回 `null`。
  - 规划成功那条 `appendActivity('plan', 'success', …)` 的 detail 带上 `usage: planResult.usage ?? undefined`。
  - 操作菜单里加一行 `menu-row`，仅在 `workflowEntries.length > 0` 时显示，点击执行 `copyText(formatWorkflowLog(workflowEntries))`。

- [ ] **Step 7: 运行两个测试文件，确认通过**

Run: `pnpm exec vitest run src/lib/smart-search/workflow-log.test.ts src/SmartSearchApp.test.ts`
Expected: PASS

- [ ] **Step 8: CHANGELOG 与提交**

「未发布」区各加一条。zh：`- **智能查找可复制活动记录。** 操作菜单新增「复制活动记录」，包含每一步的耗时和模型用量。` en：`- **Smart Lookup can copy its activity log.** The actions menu has a new "Copy activity log" entry with per-step timing and model usage.`

```bash
node scripts/changelog.mjs check
git add src/lib/smart-search/workflow-log.ts src/lib/smart-search/workflow-log.test.ts src/SmartSearchApp.svelte src/SmartSearchApp.test.ts src/lib/i18n CHANGELOG.md CHANGELOG.zh-CN.md
git commit -m "feat(smart-lookup): timed, copyable activity log"
```

---

### Task 2: 时间短语识别与时间分组（纯函数，只供评测）

**Files:**
- Modify: `src-tauri/src/search/plan.rs`（新增类型与函数，测试写进文件已有的 `mod tests`）
- Create: `src-tauri/src/search/time_group.rs`
- Modify: `src-tauri/src/search/mod.rs` L6–L10（加 `mod time_group;`）

**Interfaces:**
- Consumes（`plan.rs` 已有）：`explicit_filters`、`time_anchors`、`anchor_for_source`、`parse_rolling_source`、`parse_iso_date_source`、`parse_explicit_year_source`、`parse_explicit_quarter_source`、`resolve_expression`、`TimeExpression::RollingWindow`。
- Produces:

```rust
// plan.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DetectedTime { pub source_text: String, pub after: NaiveDate, pub before: NaiveDate }
pub(super) fn detect_time_phrase(question: &str, reference: NaiveDate) -> Result<Option<DetectedTime>, String>
const ANCHOR_SOURCES: &[&str]   // anchor_for_source 各分支里的全部字面量

// time_group.rs
pub(super) fn time_scoped_query(question: &str, time: &DetectedTime) -> String
pub(super) struct TimeGrouped { pub hits: Vec<SmartHitDto>, pub in_window: usize }
pub(super) fn group_by_time(in_window: Vec<SmartHitDto>, unfiltered: Vec<SmartHitDto>, limit: usize) -> TimeGrouped
```

`detect_time_phrase` 的规则（签名和测试定不下来的部分）：

1. `explicit_filters(question)?` 已有 `after` 或 `before` 时返回 `Ok(None)`。
2. 在问题里收集候选片段，每个候选是「字节范围 + 起止日期」：

| 扫描 | 片段形态 | 解析 |
| --- | --- | --- |
| 锚点 | `ANCHOR_SOURCES` 里的短语。中文按子串找；英文大小写不敏感，且两侧不能是 ASCII 字母或数字 | `anchor_for_source(片段, &time_anchors(reference)?)` |
| 滚动窗口 | `最近`、`过去`、`近` + 数字 + `天`、`周`、`个月`、`月`、`年`；`last`、`past`、`recent` + 空格 + 数字 + 空格 + 单位词 | `parse_rolling_source` 再 `resolve_expression(&TimeExpression::RollingWindow { .. }, reference)` |
| ISO 日期 | `YYYY-MM-DD` | `parse_iso_date_source` |
| 年份 | 四位数字后紧跟 `年` | `parse_explicit_year_source` |
| 季度 | 四位数字 + 可选的 `-` 或空格 + `Q`/`q` + `1`–`4` | `parse_explicit_quarter_source` |

3. 去掉被更长候选完全包含的候选。
4. 剩下恰好 1 个时返回它；0 个或多于 1 个都返回 `None`。多个时间表达不猜。

`time_scoped_query`：从问题里去掉第一处 `source_text`，把连续空白压成一个空格并去掉首尾空白，再追加 ` after:YYYY-MM-DD before:YYYY-MM-DD`。

`group_by_time`：先放 `in_window`（截到 `limit`），再按原顺序追加 `unfiltered` 里键 `(path, line, line_end)` 不在前一组的命中，直到总数达到 `limit`。`in_window` 字段是第一组的条数。

- [ ] **Step 1: 写失败的测试**（`plan.rs` 的 `mod tests`）

```rust
#[test]
fn every_anchor_source_literal_resolves() {
    let anchors = time_anchors(NaiveDate::from_ymd_opt(2026, 11, 10).unwrap()).unwrap();
    for source in ANCHOR_SOURCES {
        assert!(anchor_for_source(source, &anchors).is_some(), "{source}");
    }
}

#[test]
fn detects_exactly_one_host_resolvable_time_phrase() {
    let today = NaiveDate::from_ymd_opt(2026, 11, 10).unwrap(); // 星期二
    let d = |y, m, day| NaiveDate::from_ymd_opt(y, m, day).unwrap();
    let got = |q: &str| detect_time_phrase(q, today).unwrap();
    assert_eq!(got("上个月关于发布延期的讨论"),
        Some(DetectedTime { source_text: "上个月".into(), after: d(2026, 10, 1), before: d(2026, 10, 31) }));
    assert_eq!(got("最近7天的会议纪要"),
        Some(DetectedTime { source_text: "最近7天".into(), after: d(2026, 11, 4), before: d(2026, 11, 10) }));
    assert_eq!(got("2025年的年度总结"),
        Some(DetectedTime { source_text: "2025年".into(), after: d(2025, 1, 1), before: d(2025, 12, 31) }));
    assert_eq!(got("notes from Last Week about pricing").map(|t| (t.after, t.before)),
        Some((d(2026, 11, 2), d(2026, 11, 8))));
    assert_eq!(got("2026-Q3 roadmap").map(|t| (t.after, t.before)),
        Some((d(2026, 7, 1), d(2026, 9, 30))));
    assert_eq!(got("最近3年的体检报告").map(|t| t.source_text), Some("最近3年".into()));
}

#[test]
fn declines_when_time_is_absent_ambiguous_or_already_explicit() {
    let today = NaiveDate::from_ymd_opt(2026, 11, 10).unwrap();
    for q in ["发布延期的原因", "上周和本月的周报", "after:2026-01-01 上周的周报", "todays standup notes"] {
        assert_eq!(detect_time_phrase(q, today).unwrap(), None, "{q}");
    }
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml time_phrase`
Expected: 编译失败，`detect_time_phrase` 未定义。

- [ ] **Step 3: 在 `plan.rs` 实现 `ANCHOR_SOURCES`、`DetectedTime`、`detect_time_phrase`**

`AnchorRange` 里的日期是字符串，用 `NaiveDate::parse_from_str(.., "%Y-%m-%d")` 转回。

- [ ] **Step 4: 运行，确认三条测试通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- every_anchor_source time_phrase declines_when_time`
Expected: PASS

- [ ] **Step 5: 写 `time_group.rs` 的失败测试**

测试里的命中用 `super::super::hit_to_dto(Hit { .. }, Path::new("/vault"))` 包成 `SmartHitDto`（`fused_score: 1.0`，其余向量为空，`result_id: None`）；`Hit` 的字段照抄 `smart.rs` 测试模块里的 `hit()`，只改 `path`。

```rust
#[test]
fn scoped_query_strips_the_phrase_and_appends_the_inclusive_range() {
    let time = DetectedTime { source_text: "上个月".into(),
        after: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(), before: NaiveDate::from_ymd_opt(2026, 10, 31).unwrap() };
    assert_eq!(time_scoped_query("上个月关于发布延期的讨论", &time),
        "关于发布延期的讨论 after:2026-10-01 before:2026-10-31");
    assert_eq!(time_scoped_query("pricing  notes 上个月", &time),
        "pricing notes after:2026-10-01 before:2026-10-31");
}

#[test]
fn grouping_puts_in_window_hits_first_and_never_drops_or_duplicates() {
    let paths = |g: &TimeGrouped| g.hits.iter().map(|h| h.hit.path.clone()).collect::<Vec<_>>();
    let grouped = group_by_time(vec![dto("b.md"), dto("d.md")], vec![dto("a.md"), dto("b.md"), dto("c.md"), dto("d.md")], 10);
    assert_eq!(paths(&grouped), ["b.md", "d.md", "a.md", "c.md"]);
    assert_eq!(grouped.in_window, 2);
    let capped = group_by_time(vec![dto("b.md"), dto("d.md")], vec![dto("a.md"), dto("b.md"), dto("c.md")], 3);
    assert_eq!(paths(&capped), ["b.md", "d.md", "a.md"]);
}
```

- [ ] **Step 6: 实现 `time_group.rs`，在 `mod.rs` 注册模块，运行确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml time_group`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/search/plan.rs src-tauri/src/search/time_group.rs src-tauri/src/search/mod.rs
git commit -m "feat(search): host time-phrase detection and soft time grouping (eval only)"
```

---

### Task 3: 评测核心：任务文件、位次、预筛判定

**Files:**
- Create: `src-tauri/src/search/smart_eval.rs`
- Modify: `src-tauri/src/search/mod.rs`（加 `#[cfg(test)] mod smart_eval;`，整个模块不进发布产物）

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EvalTarget { pub path: String, pub line: Option<u32> }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Category { Exact, Colloquial, Synonym, Time, Homonym, Bridge, Absent }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Split { Dev, Holdout }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EvalTask {
    pub id: String, pub question: String, pub targets: Vec<EvalTarget>,
    pub category: Category, pub split: Split,
    #[serde(default)] pub needs_inferred_constraint: bool,
}

pub(super) fn load_tasks(json: &str) -> Result<Vec<EvalTask>, String>   // 文件形如 {"tasks":[…]}
pub(super) fn target_rank(hits: &[SmartHitDto], targets: &[EvalTarget]) -> Option<(usize, String)> // (1 起的位次, 块级别)

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct E1Row {
    pub id: String, pub category: Category, pub split: Split,
    pub target_indexed: bool,
    pub rank: Option<usize>, pub level: Option<String>,
    pub line_share_top30: f64, pub local_ms: u64,
    pub deep_rank: Option<usize>, pub deep_ms: Option<u64>,
    pub time_detected: bool, pub grouped_rank: Option<usize>,
    pub needs_inferred_constraint: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreGates {
    pub scored_tasks: usize,
    pub rank_6_to_50: usize, pub c3_worth_testing: bool,
    pub unrecalled_after_deep: usize, pub c4_worth_testing: bool,
    pub rollup_share: f64, pub rollup_excerpt_required: bool,
    pub time_tasks: usize, pub c2_grouping_ok: Option<bool>,
    pub inferred_constraint_tasks: usize, pub constraint_inference_worth_evaluating: bool,
}
pub(super) fn pre_gates(rows: &[E1Row]) -> PreGates
```

`load_tasks` 的校验，报错信息必须带任务 `id`：任务列表为空；`id` 重复；问题为空；`absent` 却带目标；非 `absent` 却没有目标；目标路径为空、是绝对路径、或含 `..`。

`target_rank`：命中与目标匹配的条件是 `hit.hit.path == target.path`，且 `target.line` 为空或落在 `[hit.hit.line, hit.hit.line_end]` 内。多个目标取最小位次。

`pre_gates` 的规则，数值来自 spec §9.3，只统计 `target_indexed == true` 的行：

| 字段 | 规则 |
| --- | --- |
| `scored_tasks` | 参与统计的行数 |
| `rank_6_to_50`、`c3_worth_testing` | `rank` 在 6..=50 的行数；≥ 6 为真 |
| `unrecalled_after_deep`、`c4_worth_testing` | `category != Absent` 且 `rank`、`deep_rank` 都为空的行数；≥ 4 为真 |
| `rollup_share`、`rollup_excerpt_required` | `rank` 非空的行里 `level` 为 `section` 或 `file` 的占比，没有这样的行时为 0.0；≥ 0.25 为真 |
| `time_tasks`、`c2_grouping_ok` | `time_detected` 的行数；为 0 时 `None`，否则 `Some(分组后位次 ≤ 5 的行数 ≥ 分组前位次 ≤ 5 的行数)` |
| `inferred_constraint_tasks`、`constraint_inference_worth_evaluating` | `needs_inferred_constraint` 的行数；≥ 4 为真 |

- [ ] **Step 1: 写失败的测试**

```rust
fn row(id: &str, rank: Option<usize>, level: Option<&str>) -> E1Row {
    E1Row { id: id.into(), category: Category::Exact, split: Split::Dev, target_indexed: true,
        rank, level: level.map(str::to_owned), line_share_top30: 1.0, local_ms: 1,
        deep_rank: None, deep_ms: None, time_detected: false, grouped_rank: None,
        needs_inferred_constraint: false }
}

#[test]
fn load_tasks_rejects_inconsistent_entries_naming_the_task() {
    let wrap = |tasks: &str| format!(r#"{{"tasks":[{tasks}]}}"#);
    let ok = r#"{"id":"t01","question":"q","targets":[{"path":"a.md"}],"category":"exact","split":"dev"}"#;
    assert_eq!(load_tasks(&wrap(ok)).unwrap().len(), 1);
    for (tasks, needle) in [
        (format!("{ok},{ok}"), "t01"),
        (r#"{"id":"t02","question":"q","targets":[{"path":"a.md"}],"category":"absent","split":"dev"}"#.to_string(), "t02"),
        (r#"{"id":"t03","question":"q","targets":[],"category":"exact","split":"dev"}"#.to_string(), "t03"),
        (r#"{"id":"t04","question":"q","targets":[{"path":"../x.md"}],"category":"exact","split":"dev"}"#.to_string(), "t04"),
    ] {
        let error = load_tasks(&wrap(&tasks)).unwrap_err();
        assert!(error.contains(needle), "{error}");
    }
    assert!(load_tasks(r#"{"tasks":[]}"#).is_err());
}

#[test]
fn pre_gates_apply_the_confirmed_thresholds() {
    let mut rows: Vec<E1Row> = [6, 10, 11, 30, 31].iter().map(|r| row("r", Some(*r), Some("line"))).collect();
    assert!(!pre_gates(&rows).c3_worth_testing);
    rows.push(row("r", Some(50), Some("line")));
    rows.push(row("r", Some(51), Some("line")));
    let gates = pre_gates(&rows);
    assert_eq!((gates.rank_6_to_50, gates.c3_worth_testing), (6, true));

    let mut misses: Vec<E1Row> = (0..3).map(|_| row("m", None, None)).collect();
    misses.push(E1Row { deep_rank: Some(2), ..row("deep", None, None) });
    misses.push(E1Row { category: Category::Absent, ..row("absent", None, None) });
    assert_eq!(pre_gates(&misses).unrecalled_after_deep, 3);
    assert!(!pre_gates(&misses).c4_worth_testing);
    misses.push(row("m", None, None));
    assert!(pre_gates(&misses).c4_worth_testing);

    let rollups = vec![row("a", Some(1), Some("section")), row("b", Some(2), Some("line")),
        row("c", Some(3), Some("line")), row("d", Some(4), Some("line")), row("e", None, None)];
    assert_eq!(pre_gates(&rollups).rollup_share, 0.25);
    assert!(pre_gates(&rollups).rollup_excerpt_required);

    let timed = |rank, grouped| E1Row { time_detected: true, grouped_rank: Some(grouped), ..row("t", Some(rank), Some("line")) };
    assert_eq!(pre_gates(&[timed(3, 8), timed(9, 2)]).c2_grouping_ok, Some(true));
    assert_eq!(pre_gates(&[timed(3, 8), timed(4, 9)]).c2_grouping_ok, Some(false));
    assert_eq!(pre_gates(&[row("x", Some(1), Some("line"))]).c2_grouping_ok, None);
}

#[test]
fn rows_whose_target_is_not_in_the_vault_are_excluded_from_every_gate() {
    let typo = E1Row { target_indexed: false, ..row("typo", None, None) };
    let gates = pre_gates(&[typo.clone(), typo.clone(), typo.clone(), typo]);
    assert_eq!(gates.scored_tasks, 0);
    assert_eq!(gates.unrecalled_after_deep, 0);
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml smart_eval`
Expected: 编译失败。

- [ ] **Step 3: 实现类型、`load_tasks`、`target_rank`、`pre_gates`**

- [ ] **Step 4: 运行，确认通过**

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/search/smart_eval.rs src-tauri/src/search/mod.rs
git commit -m "test(search): smart lookup eval core and pre-gate rules"
```

---

### Task 4: E1 本地基线评测（可执行）

**Files:**
- Modify: `src-tauri/src/search/smart_eval.rs`
- Modify: `src-tauri/src/search/smart.rs` L202（`fn smart_search_locked` 改为 `pub(super) fn`，不改逻辑）

**Interfaces:**
- Consumes: Task 2 的 `detect_time_phrase`、`time_scoped_query`、`group_by_time`；Task 3 的全部；`smart::smart_search_locked(&IndexHandle, Instant, &str, Option<usize>, Option<bool>, Option<u64>, &Arc<AtomicU64>, u64) -> Result<SmartSearchResponse, String>`。
- Produces: `pub(super) fn run_e1(handle: &IndexHandle, vault_root: &Path, tasks: &[EvalTask], today: NaiveDate) -> Result<Vec<E1Row>, String>`

`run_e1` 对每个任务固定这样做：

1. `target_indexed`：`absent` 任务为真；其余要求每个目标 `vault_root.join(path).is_file()`。
2. 浅检索：`smart_search_locked(handle, Instant::now(), question, Some(50), Some(false), None, &counter, 1)`，`counter` 是 `Arc::new(AtomicU64::new(1))`。由此得到 `rank`、`level`、`local_ms`（取 `took_ms`）。
3. `line_share_top30`：前 `min(30, 命中数)` 条里 `level == "line"` 的占比，没有命中时为 0.0。
4. `rank` 为空、`target_indexed` 为真且不是 `absent` 时再跑一次 deep：参数同上，改成 `Some(true)`、`Some(4_000)`，得到 `deep_rank`、`deep_ms`。
5. `detect_time_phrase(question, today)?` 有结果时：用 `time_scoped_query` 再做一次浅检索，`group_by_time(带范围的命中, 第 2 步的命中, 50)`，`grouped_rank` 取分组后的位次；`time_detected = true`。

- [ ] **Step 1: 写失败的冒烟测试**

```rust
#[test]
fn e1_scores_a_fixture_vault_end_to_end() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("launch.md"), "# Launch\nQ3Budget launch budget release risk details\n").unwrap();
    std::fs::write(vault.path().join("other.md"), "# Other\nunrelated gardening notes\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut idx = SearchIndex::open_at(vault.path(), &data.path().join("i.db"), "sync").unwrap();
    idx.sweep(&searchidx::ScanOptions::default(), None).unwrap();
    let handle: IndexHandle = Arc::new(std::sync::Mutex::new(Some(idx)));
    let tasks = load_tasks(r#"{"tasks":[
      {"id":"t01","question":"Q3Budget release risk","targets":[{"path":"launch.md","line":2}],"category":"exact","split":"dev"},
      {"id":"t02","question":"quantum pasta","targets":[],"category":"absent","split":"dev"},
      {"id":"t03","question":"release risk","targets":[{"path":"missing.md"}],"category":"exact","split":"holdout"}
    ]}"#).unwrap();

    let rows = run_e1(&handle, vault.path(), &tasks, NaiveDate::from_ymd_opt(2026, 11, 10).unwrap()).unwrap();

    assert_eq!((rows[0].rank, rows[0].level.as_deref(), rows[0].target_indexed), (Some(1), Some("line"), true));
    assert_eq!(rows[0].line_share_top30, 1.0);
    assert_eq!((rows[1].rank, rows[1].target_indexed), (None, true));
    assert!(!rows[2].target_indexed);
    assert_eq!(pre_gates(&rows).scored_tasks, 2);
}
```

- [ ] **Step 2: 运行，确认失败；实现 `run_e1`；运行确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml e1_scores_a_fixture_vault_end_to_end`
Expected: 先 FAIL（`run_e1` 未定义），实现后 PASS。

- [ ] **Step 3: 加上真实 vault 的入口测试**

```rust
#[test]
#[ignore = "reads a real vault; run by hand with NOTEMD_EVAL_* set"]
fn e1_local_baseline()
```

它固定这样做：

- 读环境变量 `NOTEMD_EVAL_VAULT`（vault 根目录）、`NOTEMD_EVAL_TASKS`（任务文件）、`NOTEMD_EVAL_OUT`（输出 JSON 路径）；可选 `NOTEMD_EVAL_INDEX_DB`，缺省取 `searchidx::paths::index_db_path(&vault)`。
- 把索引文件连同存在的 `-wal`、`-shm` 复制到 `tempfile::tempdir()`，用 `SearchIndex::open_at(&vault, &副本, &crate::cli::search::scan_options_for(&vault).source_globs.stamp())` 打开副本。不调用 `sweep`、`ensure_built`、`rebuild`。
- `stats()?.files == 0` 时 panic，信息写明「索引副本为空：stamp 不匹配或索引尚未建立」。
- `run_e1(.., chrono::Local::now().date_naive())`，把 `{"vault": …, "rows": […], "preGates": {…}}` 写到 `NOTEMD_EVAL_OUT`，并把 `preGates` 打印到标准输出。

- [ ] **Step 4: 确认入口测试能编译且默认被跳过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml smart_eval`
Expected: PASS，输出里 `e1_local_baseline ... ignored`。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/search/smart_eval.rs src-tauri/src/search/smart.rs
git commit -m "test(search): E1 local baseline evaluation over an index copy"
```

---

### Task 5: Jev 客户端原型与延迟探测

**Files:**
- Create: `src-tauri/src/smart_model.rs`
- Modify: `src-tauri/src/lib.rs` L64 之后（加 `#[cfg(not(target_os = "ios"))] pub mod smart_model;`）

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode { Bearer, None }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JevConfig { pub url: String, pub model: String, pub auth_mode: AuthMode }

pub fn jev_endpoint(url: &str) -> Result<String, String>
pub fn validate_jev_config(config: &JevConfig) -> Result<(), String>

pub struct NoulQuestion { pub id: String, pub instructions: serde_json::Value, pub criteria_true: String, pub criteria_false: String }
#[derive(Debug, Clone, PartialEq)] pub struct Usage { pub input_tokens: u64, pub output_tokens: u64 }
#[derive(Debug, Clone, PartialEq)] pub struct NoulOutcome { pub scores: Vec<(String, f64)>, pub usage: Option<Usage> }
#[derive(Debug, Clone, PartialEq)] pub enum ModelError { Timeout, Http(u16), Transport(String), Invalid(String) }

pub async fn score_noul(
    client: &reqwest::Client, config: &JevConfig, key: Option<&str>,
    state: &str, questions: &[NoulQuestion], timeout: std::time::Duration,
) -> Result<NoulOutcome, ModelError>
```

定死的行为：

- 请求体：`{"model": config.model, "state": state, "questions": {"<id>": {"type":"noul","instructions": …, "criteria": {"true": …, "false": …}}}}`，发往 `jev_endpoint(&config.url)`。
- 鉴权：`Bearer` 且有 key 时带 `Authorization: Bearer <key>`；`Bearer` 但 key 为空，不发请求，返回 `Invalid`；`None` 时即使传了 key 也不带 `Authorization`。
- 响应校验，任一不符返回 `Invalid`：不是 JSON；没有 `answers` 对象；`answers` 条数与问题数不等；缺某个 `id`；`type` 不是 `noul`；`noul` 不是数字或不在 `[0, 1]`。
- `usage` 可缺省；缺省时 `usage: None`。
- 非 2xx 返回 `Http(状态码)`；超时返回 `Timeout`；任何情况都只发一次。
- `scores` 的顺序与入参 `questions` 一致。
- `validate_jev_config`：`url` 或 `model` 为空、`url` 解析不了时报错；协议是 `http`、主机不是 `localhost`、`127.0.0.0/8` 或 `::1`、且 `Bearer` 时报错，信息里含 `http`；其余通过。

- [ ] **Step 1: 写失败的测试**

测试用一个只应答一次的本地服务：`async fn serve_once(status: u16, body: &'static str, delay: Duration) -> (String, tokio::sync::oneshot::Receiver<String>, Arc<AtomicUsize>)`，返回基地址、收到的原始请求头和已接受的连接数。用 `tokio::net::TcpListener` 绑 `127.0.0.1:0`。

```rust
#[test]
fn endpoint_follows_the_documented_rule() {
    for (input, expected) in [
        ("https://api.typesafe.ai/v1", "https://api.typesafe.ai/v1/systemone"),
        ("https://api.typesafe.ai/v1/", "https://api.typesafe.ai/v1/systemone"),
        ("https://api.typesafe.ai/v1/systemone", "https://api.typesafe.ai/v1/systemone"),
        ("https://openrouter.ai/api/alpha/decisions", "https://openrouter.ai/api/alpha/decisions"),
        ("http://localhost:8000/decisions/?route=local", "http://localhost:8000/decisions?route=local"),
        ("http://localhost:8000/v1?route=local", "http://localhost:8000/v1/systemone?route=local"),
    ] {
        assert_eq!(jev_endpoint(input).unwrap(), expected);
    }
    assert!(jev_endpoint("not a url").is_err());
}

#[test]
fn config_refuses_a_bearer_key_over_plain_http_to_a_remote_host() {
    let config = |url: &str, auth_mode| JevConfig { url: url.into(), model: "jev-latest".into(), auth_mode };
    assert!(validate_jev_config(&config("http://192.168.1.5:8000/v1", AuthMode::Bearer)).unwrap_err().contains("http"));
    assert!(validate_jev_config(&config("http://192.168.1.5:8000/v1", AuthMode::None)).is_ok());
    assert!(validate_jev_config(&config("http://localhost:8000/v1", AuthMode::Bearer)).is_ok());
    assert!(validate_jev_config(&config("http://127.0.0.1:8000/v1", AuthMode::Bearer)).is_ok());
    assert!(validate_jev_config(&config("https://api.typesafe.ai/v1", AuthMode::Bearer)).is_ok());
    assert!(validate_jev_config(&config("", AuthMode::None)).is_err());
}

#[tokio::test]
async fn bearer_sends_the_key_and_none_never_does() {
    // Bearer + Some("k1")：请求头含 "authorization: bearer k1"（比较前转小写），路径是 /v1/systemone
    // None + Some("stale")：请求头不含 "authorization"
    // Bearer + None：返回 Err(Invalid)，连接数为 0
}

#[tokio::test]
async fn rejects_malformed_success_bodies_without_panicking() {
    for body in [
        "<html>502 Bad Gateway</html>",
        r#"{"answers":{}}"#,
        r#"{"answers":{"c1":{"type":"noul","noul":1.2}}}"#,
        r#"{"answers":{"c1":{"type":"choice","choice":"a"}}}"#,
        r#"{"answers":{"other":{"type":"noul","noul":0.5}}}"#,
    ] {
        // 单个问题 id = "c1"；断言 matches!(result, Err(ModelError::Invalid(_)))
    }
}

#[tokio::test]
async fn accepts_a_response_without_usage_and_reads_usage_when_present() {
    // {"answers":{"c1":{"type":"noul","noul":0.93}}} → scores == [("c1", 0.93)]，usage == None
    // 加上 "usage":{"input_tokens":360,"output_tokens":39} → usage == Some(Usage { 360, 39 })
}

#[tokio::test]
async fn a_slow_server_times_out_and_http_errors_are_reported_once() {
    // delay 300ms、timeout 50ms → Err(Timeout)，连接数 == 1
    // status 429 → Err(Http(429))，连接数 == 1
}
```

注释行是该测试必须写出的断言，不是可选项。

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml smart_model`
Expected: 编译失败。

- [ ] **Step 3: 实现 `smart_model.rs` 并在 `lib.rs` 注册**

- [ ] **Step 4: 运行，确认通过**

- [ ] **Step 5: 加延迟探测入口**

```rust
#[tokio::test]
#[ignore = "calls a real Jev endpoint; run by hand with NOTEMD_EVAL_JEV_* set"]
async fn jev_latency_probe()
```

- 环境变量：`NOTEMD_EVAL_JEV_URL`、`NOTEMD_EVAL_JEV_MODEL`、`NOTEMD_EVAL_JEV_AUTH`（`bearer` 或 `none`，缺省 `bearer`）、`NOTEMD_EVAL_JEV_KEY`。
- 先 `validate_jev_config`。
- 对 K = 10 和 K = 30 各顺序发 20 次请求，时限 3 秒。每个候选的 `instructions` 是 `{"question": "这段文字是否在讨论软件发布计划？", "passage": <合成段落>}`，合成段落是固定句子「这是一段用于测量延迟的合成文本，不含任何真实笔记内容。」重复到 400 个字符。`state` 是 `"latency probe"`。
- 每个 K 打印一行：成功数、超时数、成功请求的 P50 与 P95 毫秒、有 `usage` 时的平均 `input_tokens`。

- [ ] **Step 6: 确认入口能编译且默认被跳过，提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml smart_model`
Expected: PASS，`jev_latency_probe ... ignored`。

```bash
git add src-tauri/src/smart_model.rs src-tauri/src/lib.rs
git commit -m "feat(smart-lookup): Jev Noul client prototype with configurable endpoint"
```

---

### Task 6: 查找运行可登记本地结果；新增 `smart_lookup_local` 命令

**Files:**
- Modify: `src-tauri/src/smart_lookup.rs` L205–L260（`retain_planned_search`、`retain_in`）
- Modify: `src-tauri/src/search/mod.rs`（L968 的 `notemd_planned_search` 旁边加新结构和命令）
- Modify: `src-tauri/src/lib.rs` L1703 附近的 `generate_handler!` 列表（加 `search::smart_lookup_local`）
- Test: `src-tauri/src/search/smart.rs` 的 `mod tests`、`src-tauri/src/search/mod.rs` 的测试模块

**Interfaces:**
- Produces:

```rust
// smart_lookup.rs
pub(crate) fn retain_search_in(window_label: &str, root: &Path, original_query: &str,
    search: &mut crate::search::smart::SmartSearchResponse) -> Result<String, String>   // 返回 run id
pub(crate) fn retain_local_search(window: &tauri::Window, original_query: &str,
    search: &mut crate::search::smart::SmartSearchResponse) -> Result<String, String>
#[cfg(test)]
pub(crate) fn summary_prompt_for_run(run_id: &str, window_label: &str) -> Result<String, String>
    // 从登记表取出该运行，返回 prepare_summary_in(&run, &[], 4, 4_000, "bullets") 的 prompt

// search/mod.rs
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLookupResponse {
    pub search: smart::SmartSearchResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lookup_run_id: Option<String>,
}
fn local_lookup_budget(limit: Option<usize>, deep: Option<bool>, timeout_ms: Option<u64>) -> (usize, bool, Option<u64>)
#[tauri::command(async)]
pub fn smart_lookup_local(app: AppHandle, window: tauri::Window, question: String,
    limit: Option<usize>, deep: Option<bool>, timeout_ms: Option<u64>, retain_run: Option<bool>,
) -> Result<LocalLookupResponse, String>
```

与 spec 的一处出入：spec §8.2 把这个命令放在新文件 `smart_enhance.rs`。本计划把它放在 `search/mod.rs`，因为它要调用 `pub(super)` 的 `smart::run_smart_search_command`，而且检索命令的注册路径惯例就在这里（见 `notemd_smart_search` 上方的注释）。`smart_enhance.rs` 留给阶段 2。

定死的行为：

- `retain_in` 改为调用 `retain_search_in` 并把返回值写进 `response.lookup_run_id`，登记逻辑只留一份。
- `local_lookup_budget`：`limit` 在 1..=100 内保留，否则 100；`deep` 缺省 `false`；`deep == false` 时 `timeout_ms` 原样透传；`deep == true` 时 `None` 或 `Some(0)` 取 4_000，其余取 `min(值, 5_000)`。
- `smart_lookup_local`：`question.trim()` 为空返回 `Err("empty question")`；否则调 `smart::run_smart_search_command(app, window.clone(), question.clone(), Some(limit), Some(deep), timeout)`；`retain_run == Some(true)` 时调 `retain_local_search` 并填 `lookup_run_id`。不限制问题长度，与输入预览一致。

- [ ] **Step 1: 写失败的测试**

`search/mod.rs` 测试模块：

```rust
#[test]
fn local_lookup_budget_matches_the_planned_search_limits() {
    assert_eq!(local_lookup_budget(None, None, None), (100, false, None));
    assert_eq!(local_lookup_budget(Some(50), Some(false), Some(900)), (50, false, Some(900)));
    assert_eq!(local_lookup_budget(Some(0), Some(true), None), (100, true, Some(4_000)));
    assert_eq!(local_lookup_budget(Some(500), Some(true), Some(9_000)), (100, true, Some(5_000)));
}
```

`search/smart.rs` 的 `mod tests`，索引搭建照抄同文件的 `planned_executor_uses_typed_multiword_filters`：

```rust
#[test]
fn a_local_smart_search_can_be_retained_as_a_lookup_run() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("a.md"), "# A\nrelease risk details\n").unwrap();
    // …open_at + sweep + handle + counter…
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

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- local_lookup_budget a_local_smart_search_can_be_retained`
Expected: 编译失败。

- [ ] **Step 3: 实现重构、命令并注册**

- [ ] **Step 4: 运行新测试和 `smart_lookup` 原有测试，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- local_lookup_budget a_local_smart_search_can_be_retained smart_lookup`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/smart_lookup.rs src-tauri/src/search/mod.rs src-tauri/src/search/smart.rs src-tauri/src/lib.rs
git commit -m "feat(smart-lookup): smart_lookup_local command retains local results as a lookup run"
```

---

### Task 7: 设置 `enhance.mode`，规划器退出默认路径

**Files:**
- Modify: `src/lib/smart-search/settings.ts`
- Test: `src/lib/smart-search/settings.test.ts`
- Modify: `src/SmartSearchApp.svelte`（L230、L715–L720、L1337、L1562）
- Test: `src/SmartSearchApp.test.ts`（`beforeEach` 和 8 处给 `mocks.storedSmartLookup` 赋值的用例）

**Interfaces:**
- Produces:

```ts
export type EnhanceMode = 'off' | 'agent'
// SmartLookupSettings 新增 enhance: { mode: EnhanceMode }；planner 去掉 enabled，保留 provider、modelByProvider、timeoutMs
// DEFAULT_SMART_LOOKUP_SETTINGS.enhance = { mode: 'off' }
```

定死的行为：

- 本计划只实现 `mode` 的 `'off'` 和 `'agent'`。spec §8.2 列出的 `'direct'` 和 `enhance` 的其余字段留给阶段 2。
- `normalizeSmartLookupSettings`：`enhance.mode` 用 `choice(.., ['off', 'agent'], 'off')`。旧的 `planner.enabled` 无论真假都被忽略，不迁移成 `agent`。
- 规划 Agent 为空不影响简答：`resolveSummaryAgent` 在 `same_as_planner` 且没有规划 Agent 时已会回退到默认 Agent，这段逻辑不用改。
- 组件里所有读 `settings.smartLookup.planner.enabled` 的地方改读 `settings.smartLookup.enhance.mode === 'agent'`。
- 设置面板那个复选框的 `checked` 绑到 `enhance.mode === 'agent'`，切换时写 `'agent'` 或 `'off'`。
- 这一步之后、Task 8 之前，`off` 模式下按 Enter 仍走原来的「预览 + 提示」分支，这是预期的中间状态。

- [ ] **Step 1: 写失败的测试**（`settings.test.ts`）

```ts
it('keeps the planner out of the default path and ignores the legacy switch', () => {
  expect(DEFAULT_SMART_LOOKUP_SETTINGS.enhance.mode).toBe('off')
  expect(normalizeSmartLookupSettings({ planner: { enabled: true } }).enhance.mode).toBe('off')
  expect(normalizeSmartLookupSettings({ enhance: { mode: 'agent' } }).enhance.mode).toBe('agent')
  expect(normalizeSmartLookupSettings({ enhance: { mode: 'direct' } }).enhance.mode).toBe('off')
  expect('enabled' in normalizeSmartLookupSettings(undefined).planner).toBe(false)
})
```

同文件已有用例里的 `expect(normalized.planner).toMatchObject({ enabled: false, … })` 去掉 `enabled`。

- [ ] **Step 2: 运行，确认失败；实现 `settings.ts`；运行确认通过**

Run: `pnpm exec vitest run src/lib/smart-search/settings.test.ts`

- [ ] **Step 3: 调整组件测试的默认设置并加一条新用例**

`beforeEach` 里把 `mocks.storedSmartLookup = undefined` 改成 `mocks.storedSmartLookup = { enhance: { mode: 'agent' } }`，让原有用例继续覆盖 `agent` 模式。自行给 `mocks.storedSmartLookup` 赋值的 8 个用例，在赋的对象里补上 `enhance: { mode: 'agent' }`。新增：

```ts
it('does not start a planner by default', async () => {
  mocks.storedSmartLookup = undefined
  const input = await mountReady()
  await typeAndWait(input)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('.preview-warning')).not.toBeNull())
  expect(taskStarts('search-plan')).toHaveLength(0)
})
```

- [ ] **Step 4: 运行，确认新用例失败；改组件；运行整个文件确认通过**

Run: `pnpm exec vitest run src/SmartSearchApp.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/smart-search/settings.ts src/lib/smart-search/settings.test.ts src/SmartSearchApp.svelte src/SmartSearchApp.test.ts
git commit -m "feat(smart-lookup): enhance.mode setting, planner off by default"
```

---

### Task 8: Enter 先出本地结果

**Files:**
- Modify: `src/lib/smart-search/api.ts`
- Modify: `src/lib/smart-search/store.svelte.ts`；Test: `src/lib/smart-search/store.test.ts`
- Modify: `src/SmartSearchApp.svelte`（`runSmartLookup` L703–L836、`runDeep` L860–L915、`stopWorking` L457、`clearGeneratedState` L360、`hasSummaryCandidates` L171、模板 L1378、L1444、L1518）
- Modify: `src/lib/i18n/zh.ts`、`en.ts`、`de.ts`、`ja.ts`
- Test: `src/SmartSearchApp.test.ts`
- Modify: `CHANGELOG.md`、`CHANGELOG.zh-CN.md`
- Create: `docs/superpowers/reports/2026-11-10-smart-lookup-phase0-1-verification.md`

**Interfaces:**
- Consumes: Task 6 的命令 `smart_lookup_local`，参数 `{ question, limit, deep, timeoutMs, retainRun }`，返回 `{ search: SmartSearchResponse, lookupRunId?: string }`；Task 7 的 `settings.smartLookup.enhance.mode`；Task 1 的 `lookupStartedAt` 与 `appendActivity`。
- Produces:

```ts
// api.ts
smartSearchApi.localLookup(question: string, options?: { limit?: number; deep?: boolean; timeoutMs?: number; retainRun?: boolean })
  : Promise<{ search: SmartSearchResponse; lookupRunId?: string }>
// store.svelte.ts
SmartSearchStore.fail(query: string, message: string): void   // sequence++，hits 清空，error = message，loading = false，query = query
```

i18n 新键：

| 键 | zh | en | de | ja |
| --- | --- | --- | --- | --- |
| `smartSearch.localResults` | 本地结果 | Local results | Lokale Ergebnisse | ローカル結果 |
| `smartSearch.newResultsReady` | 按理解后的条件找到了新结果 | New results are ready | Neue Ergebnisse sind bereit | 新しい結果があります |
| `smartSearch.applyNewResults` | 应用新结果 | Apply new results | Neue Ergebnisse anwenden | 新しい結果を適用 |

组件新状态：`let localResults = $state(false)`、`let enhancing = $state(false)`、`let pendingPlanned = $state<{ planned: PlannedSearchResponse; rawPlan: unknown; referenceTime: string; timezone: string } | null>(null)`、`let resultsTouched = false`。

定死的行为：

1. Enter：守卫不变（`lookupBusy || summaryBusy || handoffBusy` 时不响应；`enhancing` 不在其中，增强期间可以重新提交）。随后 `cancelTimer()`、`mine = supersedeActive()`、各项重置、`lookupStartedAt = performance.now()`、`resultsTouched = false`、`phase = 'searching'`。
2. 调 `localLookup(question, { limit: settings.smartLookup.results.limit, deep: false, retainRun: settings.smartLookup.summary.enabled })`。
   - 成功且仍是当前请求：`store.apply(question, local.search)`；`lookupRunId = local.lookupRunId ?? ''`；`localResults = true`；`authoritativeResults = false`；`activeKey` 取第一条；`phase` 按现有 L819 的规则取 `no_results`、`partial` 或 `ready`；`appendActivity('search', 'success', t('smartSearch.activitySearchDone', …))`。
   - 失败且仍是当前请求：`store.fail(question, 信息)`；`phase = 'preview_only'`；`appendActivity('search', 'error', …)`；返回。现有模板在 `store.error` 时已显示带「重试」的错误块。
3. `enhance.mode !== 'agent'`：到此结束，不显示任何提示。
4. `enhance.mode === 'agent'`：没有可用的规划 Agent 时 `plannerWarning` 取 `plannerUnavailable`；问题超过 2,000 字符或 8 KiB 时取 `questionTooLong`。两种情况都保留本地结果并结束。
5. 其余情况运行现有的规划序列（`planContext` → 启动 → 轮询 → `plannedSearch`），期间 `enhancing = true`，`phase` 保持第 2 步的值，列表可操作。`working` 的定义加上 `enhancing`。
6. 规划结果到达且仍是当前请求：
   - `resultsTouched === false`：按现有方式应用，并设 `authoritativeResults = true`、`localResults = false`。
   - 否则存进 `pendingPlanned`，在 `.pane-header` 正下方显示 `<div class="results-update" role="status">`，内含 `newResultsReady` 文案和一个 `applyNewResults` 按钮；点击后同样应用并清空 `pendingPlanned`。
   - `resultsTouched` 在这些地方置真：点击或选择结果行、键盘移动焦点（`focusResult`）、打开命中、`.results-scroll` 的滚动事件。
7. 规划失败或超时：保留本地结果，`plannerWarning = t('smartSearch.plannerFallback')`，记一条 warning 活动；不再调用 `ensurePreview`。
8. 标题（L1444）：`authoritativeResults` 时用 `intelligentResults`，`localResults` 时用 `localResults`，否则 `quickPreview`。输入提示（L1378）在 `authoritativeResults || localResults` 时隐藏。
9. 简答：`hasSummaryCandidates` 的前置条件由 `authoritativeResults` 改为 `Boolean(lookupRunId)`；L1518 同样改。
10. `clearGeneratedState()` 额外重置 `localResults = false`、`pendingPlanned = null`、`enhancing = false`。`stopWorking()` 里判断用 `authoritativeResults || localResults`。
11. `runDeep()`：在回退到预览的分支之前加一支，`localResults` 为真时调 `localLookup(question, { limit, deep: true, timeoutMs: settings.smartLookup.results.deepTimeoutMs, retainRun })`，按第 2 步应用。

- [ ] **Step 1: 写 `store.fail` 的失败测试，实现，确认通过**

```ts
it('records a failed lookup without keeping stale hits', async () => {
  const store = new SmartSearchStore(async () => response)   // response 用同文件已有的样例
  await store.run('old')
  store.fail('new', 'search index not ready')
  expect(store).toMatchObject({ query: 'new', error: 'search index not ready', loading: false })
  expect(store.hits).toEqual([])
})
```

Run: `pnpm exec vitest run src/lib/smart-search/store.test.ts`

- [ ] **Step 2: 扩充组件测试的 mock**

`mocks` 加 `localGate: null as Promise<void> | null`、`localError: null as string | null`，`beforeEach` 里复位。`installInvokeMock` 加：

```ts
if (command === 'smart_lookup_local') {
  const gate = mocks.localGate
  mocks.localGate = null
  if (gate) await gate
  if (mocks.localError) throw new Error(mocks.localError)
  const question = String(args?.question ?? '')
  const search = searchResponse(args?.deep === true ? 'normal' : mocks.preview)
  if (question === 'new question') search.hits = [hit('new-result', 21)]
  return { search, lookupRunId: `local-run-${question}` }
}
```

- [ ] **Step 3: 写失败的组件测试**

新 `describe('local-first Enter', …)`。前五条先把 `mocks.storedSmartLookup = undefined`（默认 `off`）；后四条用 `beforeEach` 给的 `agent` 模式。

```ts
it('shows local results on Enter with zero model calls by default', async () => {
  // 输入 → Enter → 等到 .pane-header 含 'Local results'
  // smart_lookup_local 被调用 1 次，参数 objectContaining({ question: 'release risk', deep: false, retainRun: true })
  // taskStarts('search-plan') 为 0；.preview-warning 为 null；.result-row 有 3 行
})

it('does not wait for the preview debounce', async () => {
  // 设值 + input 事件后立刻 Enter（不调用 typeAndWait）
  // 等到 3 行结果；notemd_smart_search 的调用数为 0
})

it('offers the summary on local results', async () => {
  // Enter 后 chooseMenuAction('Create answer')
  // smart_lookup_start_summary 被调用，参数 objectContaining({ lookupRunId: 'local-run-release risk' })
})

it('keeps the input usable and offers retry when the index is not ready', async () => {
  // mocks.localError = 'search index not ready' → Enter → 等到 .state.error
  // .query-input 未禁用；没有 .spinner
  // 清掉 localError，点 'Try again' → 3 行结果
})

it('ignores a late local response for a superseded question', async () => {
  // localGate 挂住第一次；输入 'old question' + Enter；再输入 'new question' + Enter；放开 gate
  // 页面含 'new-result'，不含 'alpha'
})

it('shows local results while the planner is still running, then upgrades', async () => {
  // statusResults 先推两个 { state: 'running', steps: 1, last: '' }
  // Enter → 等到标题 'Local results' 且有 3 行，此时 .plan-summary 为 null
  // 随后等到 .plan-summary 出现，标题变为 'Search results'
})

it('does not replace results the user has started using', async () => {
  // 同样先推两个 running；Enter → 有结果后点击第二个 .result-row
  // 等到 notemd_planned_search 被调用：.results-update 存在，标题仍是 'Local results'，.plan-summary 为 null
  // 点 'Apply new results' → .plan-summary 出现，.results-update 消失
})

it('keeps local results when the planner fails', async () => {
  // mocks.planResults.push('not json') → Enter → 等到 .preview-warning
  // 仍有 3 行；标题 'Local results'；taskStarts('search-plan') 为 1
})

it('keeps local results and skips the planner for an oversized question', async () => {
  // 3,000 个字符的问题 → Enter → 3 行结果 + .preview-warning；taskStarts('search-plan') 为 0
})
```

再加一条 `off` 模式的 deep 用例：

```ts
it('expands a local zero-hit lookup with a deep local lookup', async () => {
  // storedSmartLookup = undefined；mocks.preview = 'empty' → Enter → 点 'Expand search'
  // 等到 3 行；smart_lookup_local 有一次调用的参数 objectContaining({ deep: true, timeoutMs: 4000 })
})
```

注释行是该测试必须写出的步骤和断言。

- [ ] **Step 4: 运行，确认这些用例失败**

Run: `pnpm exec vitest run src/SmartSearchApp.test.ts`

- [ ] **Step 5: 实现 `api.ts`、i18n、组件改动**

- [ ] **Step 6: 更新两条受影响的旧用例**
  - 删除 Task 7 加的 `does not start a planner by default`，它的意图已被第一条新用例覆盖。
  - `works without an Agent, never auto-deep-scans, and exposes manual expand/open/copy`：点「Expand search」后断言改为 `smart_lookup_local` 以 `deep: true` 被调用。

- [ ] **Step 7: 运行全部相关测试**

Run: `pnpm exec vitest run src/SmartSearchApp.test.ts src/lib/smart-search && pnpm check`
Expected: PASS，`svelte-check` 无新增错误。

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- search:: smart_lookup smart_model`
Expected: PASS

- [ ] **Step 8: CHANGELOG**

「未发布」区，第一条放在最前。zh：

```markdown
- **智能查找的语言理解默认关闭。** 外部 Agent 规划不再是按 Enter 后的必经步骤。需要时在智能查找设置里重新打开；打开后它在本地结果之后运行，不阻塞查找。
- **智能查找按 Enter 立即出结果。** 不再等待语言理解完成，结果出现后即可打开和选择。
- **本地结果也能生成简答。**
```

en：

```markdown
- **Natural-language understanding in Smart Lookup is now off by default.** The external Agent planner is no longer a required step after Enter. Turn it back on in Smart Lookup settings; it then runs after the local results and never blocks them.
- **Smart Lookup shows results as soon as you press Enter.** Results no longer wait for language understanding and can be opened right away.
- **Answers can be created from local results.**
```

Run: `node scripts/changelog.mjs check`
Expected: 通过。

- [ ] **Step 9: 手动验收（spec §9.3 的 C1 门槛）并记录**

`pnpm tauri dev`，在真实 vault 上、索引就绪后连续做 20 次不同问题的 Enter，每次用「复制活动记录」取第一条 `stage: "search"`、`level: "success"` 的 `elapsedMs`。把 20 个数值、P95、是否 ≤ 500ms 写进 `docs/superpowers/reports/2026-11-10-smart-lookup-phase0-1-verification.md`。同一份报告里再记三项目视检查：结果出现后能立即用键盘选择和打开；`off` 模式下「生成简答」可用；`agent` 模式下本地结果先于规划结果出现。

- [ ] **Step 10: 提交**

```bash
git add src/lib/smart-search src/SmartSearchApp.svelte src/SmartSearchApp.test.ts src/lib/i18n CHANGELOG.md CHANGELOG.zh-CN.md docs/superpowers/reports/2026-11-10-smart-lookup-phase0-1-verification.md
git commit -m "feat(smart-lookup): show local results immediately on Enter"
```

---

## 实施完成后的测量（由你执行，产出决定下一份计划）

这些不是实施任务，不改代码。运行前先退出 note.md，保证索引副本一致。

| 测量 | 命令或做法 | 产出 |
| --- | --- | --- |
| E1 本地基线 | `NOTEMD_EVAL_VAULT=<vault> NOTEMD_EVAL_TASKS=<任务文件> NOTEMD_EVAL_OUT=<输出.json> cargo test --manifest-path src-tauri/Cargo.toml e1_local_baseline -- --ignored --nocapture` | 每题一行，加 `preGates`：C3、C4 值不值得测，汇总块节选要不要做，时间分组是否可用 |
| Jev 延迟 | `NOTEMD_EVAL_JEV_URL=… NOTEMD_EVAL_JEV_MODEL=… NOTEMD_EVAL_JEV_AUTH=… NOTEMD_EVAL_JEV_KEY=… cargo test --manifest-path src-tauri/Cargo.toml jev_latency_probe -- --ignored --nocapture` | K=10 与 K=30 的 P50、P95、超时数。按官方标价约 32 万 token，约 0.013 美元；自建服务无按量费用 |
| E4 现状基线 | 设置里打开语言理解（`agent` 模式），对同一批任务逐个 Enter，每次复制活动记录 | 本地结果时间、规划完成时间、规划用量 |

任务文件格式见 Task 3 的 `EvalTask`，顶层是 `{"tasks": […]}`，`category` 取 `exact`、`colloquial`、`synonym`、`time`、`homonym`、`bridge`、`absent`，`split` 取 `dev` 或 `holdout`。spec §9.1 要求 40 题，各 20。
