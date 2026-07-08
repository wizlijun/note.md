# Reading Insights — 阅读/编辑价值追踪 设计

- 日期：2026-07-08
- 状态：设计已确认，待写实现计划
- 插件 id：`reading-insights`

## 1. 目标与动机

为每篇 md 文档采集用户的投入与关注，作为"这篇文档是否有价值"的依据。价值由**两部分**共同构成：

1. **本人投入**（跨用户自己的各台设备）：阅读/停留时长、编辑时长、编辑段数、净增字数、标注（mark）数量。
2. **受众热度**（分享链接被他人在 web / 手机上阅读）：匿名阅读时长、独立读者、会话数。

核心诉求是**完整采集**：在移动端弱网、频繁切后台、直接杀进程等情况下，尽最大可能不丢数据。

## 2. 关键决策（已确认）

| 议题 | 决策 |
|---|---|
| 价值主体 | 本人 + 受众都计入 |
| 本人数据归属 | 存 sotvault（git 同步，按设备文件），app 本地 join；中心后端只存匿名受众数据 |
| 编辑量口径 | 编辑=内容变更会话数 + 净增字数 |
| 标注量口径 | 所有 mark 操作数（strong/em/strike/highlight/link/code toggle） |
| 受众识别 | 匿名 + localStorage `visitor_id`（可算独立读者/回访） |
| 功能封装 | 独立 builtin 插件，依赖 vault：未配 vault 不可选中；配好 vault 后默认启用 |
| 时间分桶 | 本人按设备本地时区**日**分桶；受众 DO 按**小时** rollup（保证跨时区日范围精确） |

## 3. 总体架构

```
┌─ App 端（Mac/iOS，本人）──────────────┐      ┌─ Web 端（分享链接，受众）─────────┐
│ 活动追踪器（前台+当前tab+非idle）        │      │ 注入到分享 HTML 的 beacon <script> │
│  · read_ms / edit_ms 停留               │      │  · Page Visibility + 心跳 + idle   │
│  · edit_sessions / 净增字数             │      │  · sendBeacon 兜底                 │
│  · mark_ops（所有 mark 操作）           │      └───────────┬───────────────────────┘
│         ↓ 定期 flush（按天分桶）         │                  │ POST /a/hit（增量, 匿名）
│  sotvault/.mdeditor/analytics/          │                  ↓
│     <device_id>.json（git 同步、按设备）│      ┌─ Cloudflare Worker（中心，仅受众）┐
└───────────────┬─────────────────────────┘      │  DO/slug 聚合: 时长/会话/独立读者   │
                │ 跨自己设备 merge（sum/max）      │  按小时 rollup; GET /a/stats(鉴权) │
                │                                  └───────────┬───────────────────────┘
                ↓                                              │
          ┌─ App join 层 / 报告 binary ────────────────────────┘
          │ 按 share 记录 path↔slug 映射，本人 + 受众合并 → 每篇价值分、看板、日报 md
          └────────────────────────────────────────────────────
```

**身份与 join key**
- 文档标识：vault 相对路径（与 recents / share 记录一致，复用 tombstone 处理改名/删除）。
- 本人跨设备：每设备一个 json，读取时 merge（计数器 sum、时间戳 max），每设备独占文件天然免 git 冲突。
- 本人↔受众桥接：share 记录已有 `path → slug`，用 slug 拉受众聚合；没分享过的文档只有本人数据。
- 受众鉴权：`/a/stats` 用该分享的 `edit_token`（app 本地已存），受众统计不对公众开放。

## 4. 插件封装与 vault 门控

新增 builtin 插件 `reading-insights`。它同时含：
- **host 侧追踪器**（TS，运行采集逻辑、写 sotvault）；
- **报告 binary**（聚合 + 生成日报 md，供 app 内按钮与 CLI 共用）。

三条门控行为：

1. **没配 vault → 不可选中**
   - manifest 新增字段 `available_when: "vaultConfigured"`（区别于 menu 级 `enabled_when`）。
   - `EnabledWhenContext` 顶层补 `vaultConfigured: boolean`（来源 `sotvaultStore.vaultRoot !== null`）。
   - 设置里插件条目：`available_when` 为假时置灰、不可勾选，副标题提示"需先设置 Vault"。
2. **配好 vault → 默认选中可用**
   - 首次检测到 `vaultConfigured` 由 false→true，且 `plugins.enabled['reading-insights']` 尚无显式值时，一次性默认置 enabled。
   - `default_enabled: true` 仅在 `available_when` 满足后才生效。
3. **尊重用户显式选择**
   - 一旦 `plugins.enabled['reading-insights']` 有显式值，后续不再自动改动（与现有语义一致）。

运行期：采集器仅在 `isPluginEnabled('reading-insights') && vaultConfigured` 时挂载；否则完全不启动，零开销零写入。web beacon 是否注入取决于分享时该插件是否启用。

需要的小改动：`plugins/types.ts` 加 `available_when`；`EnabledWhenContext` 加 `vaultConfigured` 并在求值处填充；settings 插件列表按该标志置灰；一处 vault-first-set 的 auto-enable 钩子。

## 5. App 端（本人）采集

**"正在阅读/编辑"定义**：某文档某刻计入时长，当且仅当 `窗口前台` ∧ `该文档是当前 tab` ∧ `用户非 idle`。
- 前台：Tauri 窗口 `focus`/`blur`。
- 当前 tab：复用 `tabs.svelte` active tab。
- idle：键盘/鼠标/滚动/触摸重置计时，静默 60s → 暂停，活动即恢复。
- 读/编：按 read 态 / edit 态分别累加 `read_ms` / `edit_ms`。

**每篇 × 每天 计数器（owner）**

| 字段 | 含义 |
|---|---|
| `read_ms` / `edit_ms` | 前台活跃停留时长（读/编分开） |
| `open_count` | 打开会话数 |
| `edit_sessions` | 编辑爆发段数（连续输入合并为 1，间隔 > N s 断开） |
| `net_chars` | 净增字数（doc 长度前后差累计） |
| `mark_ops` | 所有 mark 操作数 |
| `first_seen_at` / `last_active_at` | 时间戳 |

- `mark_ops`：从 `@moraya/core` `toggleMark` 命令路径埋点，每次 +1。
- `edit_sessions` / `net_chars`：监听 ProseMirror transaction，`docChanged` 按去抖窗口聚合。

**存储与合并**（照搬 recents 的 per-device 文件模式）
- 文件：`sotvault/.mdeditor/analytics/<device_id>.json`
- 结构：`{ [docPath]: { "YYYY-MM-DD": { read_ms, edit_ms, edit_sessions, net_chars, mark_ops, open_count, first_seen_at, last_active_at } } }`
- 按设备**本地时区**日历日分桶。
- flush 时机：去抖 30s + 窗口 blur + tab 切换 + 关闭前；只写 diff。
- 读取合并：所有设备文件按 (docPath, day) 合并，计数器 sum、时间戳 max。改名/删除走 recents 已有 tombstone 逻辑。

## 6. Web 端（受众）beacon

发布时由 app 注入自包含 `<script>` 到分享 HTML（在 `share-baker` / 发布模板），**仅当 `reading-insights` 插件启用时注入**。

可靠性设计（增量 + 三重上报）：

1. **只算真实阅读**：Page Visibility API，仅 `visibilityState==='visible'` ∧ 非 idle（30s 无 scroll/touch/mouse/key 暂停）时累加。防刷：单会话封顶 30 分钟。
2. **心跳（核心保障）**：活跃时每 15s 用 `fetch(url, {keepalive:true})` POST 一个增量 `delta_ms` 到 `/a/hit`。中途杀进程也只丢最后 15s。
3. **卸载兜底**：`visibilitychange→hidden` 与 `pagehide` 用 `navigator.sendBeacon` 补发残余增量。
4. **离线韧性**：发送失败的增量内存累积，下次心跳/可见时合并重发；纯前端无阻塞。

payload（无 PII）：`{ slug, visitor_id, session_id, delta_ms, scroll_depth?, ts }`。
- `visitor_id`：首访随机生成存 localStorage。
- `session_id`：每次页面加载一个。

原理：阅读时长是**可加增量**而非结束时一次性上报，任何单次丢包只损失一个 15s 区间，最大化弱网/切后台下的可采集率。

## 7. 中心 Worker 受众聚合

在现有 `worker/` 内加分析路由（复用同一部署）。

**存储：每 slug 一个 Durable Object 聚合器**
- 内存合并高频增量，每 ~30s 落盘；按 slug 分片无热点、强一致。
- DO 内维护：按小时 rollup（`total_ms`、`sessions`）、`visitor_id` 集合或 HyperLogLog（独立读者/回访）。
- 分享删除 / KV TTL 到期时一并清理对应 DO。

**端点**

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/a/hit` | 无（分享页本就公开）| 收 beacon 增量；按 `slug+IP` 限流；服务端对异常 delta 夹取 |
| GET | `/a/stats?slug=&from=&to=` | `edit_token` | 返回区间内每天/每 slug rollup + 独立读者，仅作者可读 |

## 8. 价值分（薄层、可调）

join 层把本人计数器 + 受众聚合按 slug 合并，逐篇计分，对数阻尼防单维刷爆：

```
value =  w1·log1p(read_min)      + w2·log1p(edit_min)
       + w3·edit_sessions        + w4·mark_ops
       + w5·log1p(aud_read_min)  + w6·log1p(unique_readers)
```

- 权重放插件 settings，给合理默认，可调。
- 没分享过的文档 w5/w6 项为 0，不吃亏。
- 透明可解释：分数旁可展开各维度原始值。

## 9. 统计看板（app 内界面）

insights 面板（gated：插件启用 ∧ vault 已配）：
- **日期选择器**：开始–结束日期；快捷：今天 / 昨天 / 近 7 天 / 近 30 天 / 本月。
- **列表**：一行一个 md 文件（所有数据 source 归到对应 md），列出：
  - 本人各端合计：读时长 / 编辑时长 / 编辑段数 / mark 数
  - web 端：受众阅读时长 / 独立读者 / 会话数
  - 合成价值分；任意列可排序。
- 展开某行：分设备明细（哪台设备贡献多少）+ 每日趋势。

## 10. 日报生成（一键合并）与 CLI

**生成逻辑**（报告 binary）：读 sotvault 天桶 + 拉 `/a/stats` 区间数据 → 按 md 文件 join → 渲染 markdown。
- 输出：vault 根 `stat/YYYY-MM-DD-daily-stat.md`（区间则 `stat/YYYY-MM-DD_YYYY-MM-DD-stat.md`）。
- 内容：一句简短自然语言小结 + 明细表（每 md：本人读/编时长、编辑段数、mark 数、受众阅读时长、独立读者）+ 合计行。
- 报告本身是 md，随 git 同步、可在 app 内打开。

**app 内**：insights 面板"生成本区间报告"按钮 / 对昨天一键。

**CLI**（复用 manifest `cli` 能力，与 app 内按钮共用同一 binary）：

```
mdeditor reading-insights daily                          # 默认昨天
mdeditor reading-insights report --from 2026-07-01 --to 2026-07-07
mdeditor reading-insights report --date yesterday --stdout   # 输出 stdout 不落盘
```

- binary 从磁盘读 `.mdeditor/analytics/*.json`，从 host 传入 settings 拿 share 记录（path↔slug↔edit_token）调 `/a/stats`，写 `stat/…md`。

## 11. 隐私与边界

- 本人数据仅在自有设备 / 自有 vault（git），不上传中心。
- 受众：匿名 `visitor_id`，无 PII、无跨站追踪；聚合仅作者凭 `edit_token` 可读。
- 插件未启用 / vault 未配：追踪器不启动、beacon 不注入、看板与 CLI 不可用。
- 防刷：web 单会话封顶、idle 暂停、隐藏不计、服务端限流与 delta 夹取。

## 12. 主要改动落点

- 新插件目录 `src-tauri/plugins/reading-insights/`（manifest + 报告 binary）。
- host 侧追踪器（TS，`src/lib/` 下新模块），埋点 moraya `toggleMark` 与 ProseMirror transaction、Tauri 窗口 focus/blur、tabs、idle。
- `src/lib/plugins/types.ts` + `enabled-when` 求值：`available_when` / `vaultConfigured`。
- settings 插件列表：按 `available_when` 置灰；vault-first-set auto-enable 钩子。
- `share-baker` / 发布模板：注入 beacon script。
- `worker/src/index.ts` + 新 DO：`/a/hit`、`/a/stats`。
- insights 面板 UI（Svelte 组件）+ 日期选择器 + 列表 + 详情。

## 13. 未决 / 后续

- 价值分默认权重需实测校准。
- 是否需要看板内直接可视化每日趋势图（v1 可先表格）。
- 受众数据保留期与 DO 存储成本随分享量增长的评估。
