# 阅读洞察 · 注意力时间段(start→end)设计

> 状态:设计待评审
> 日期:2026-07-20
> 范围:reading-insights 三层(本人读 md、本人编辑 md、分享受众浏览)全部记录离散的注意力时间段;看板按文档展开列出多段。

## 1. 背景与目标

现状(见 `src/lib/insights/`、`worker/src/audience.ts`):三层都只按 **天 × 文档** 累加**总时长**(`read_ms`/`edit_ms`、受众按小时桶),**不记录每一次阅读/浏览的开始与结束时刻**。

本次目标:在**不破坏现有汇总链路**的前提下,为三层各自补上**离散的注意力时间段**(每段 `start → end`)。同一篇文档多次阅读 = 多条时间段记录。看板里每个文档可展开、列出它的全部时间段(多段全列);汇总值继续沿用,且可由时间段派生。

采用**方案 A**(汇总旁挂 sessions 数组,三层各自最小改造,向后兼容 + 崩溃安全)。

## 2. 术语:一次「时间段 / session」

一段 = 一段**连续的注意力停留**在**同一篇文档**上。

**切段(结束当前段、开启下一段)的触发**(已确认):
- **闲置超时**:本机超过 `IDLE_MS`(60s)无操作;受众端超过 `IDLE`(30s)无操作。
- **失焦 / 切窗口 / 切标签**:窗口失焦、切到别的 app、页面 `visibilitychange` 变 hidden。
- **切换文档**:打开另一个文档时,旧文档当前段结束。

**不切段**:同一文档里 **读↔编模式切换不分段**——一段连续注意力即使中途在阅读与编辑间来回,仍算同一段;段内分别累计 `read_ms` 与 `edit_ms`。

因为闲置/失焦都会切段,一段之内不存在被计入的空档,故恒有:

```
end ≈ start + read_ms + edit_ms
```

`start`/`end` 都以 epoch ms 记录,并**冗余存 end**(用户明确要开始与结束两个时刻,也便于跨设备/离线阅读的可读性)。

## 3. 数据模型

### 3.1 本机(读/编)—— `src/lib/insights/`

新增纯类型(放 `model.ts`):

```ts
/** 一段连续注意力停留在某文档上的时间段。 */
export interface AttentionSession {
  start: number   // epoch ms:该段首个活跃时刻
  end: number     // epoch ms:该段末次计入时刻(= start + read_ms + edit_ms)
  read_ms: number // 段内阅读活跃毫秒
  edit_ms: number // 段内编辑活跃毫秒
}
```

**落盘位置不变**:仍写 `<vault>/.notemd/analytics/<YYYY-MM-DD>.<device_id>.json`,一天一设备一文件。

**`DayFile` 增补一个与 `docs` 平行的顶层键**(向后兼容:老读者忽略未知键,老的 `docs` 计数器一字不动):

```ts
export interface DayFile {
  deviceId: string
  deviceName: string
  day: string
  docs: Record<string, DayCounters>            // 不变:汇总计数器
  sessions?: Record<string, AttentionSession[]> // 新增:docKey -> 该天该文档的时间段列表
}
```

**归属的天**:一段按其 **`start` 的本地日**(`dayKey(start, tz)`)归档。跨午夜的段整体留在 start 所在日文件里(报告按天区间读取,落在 start 日即可)。

### 3.2 内存与持久化(`store.svelte.ts`)

与 `docs` 完全对称地维护 `sessions`:

- 内存新增 `sessionsMem: Record<docKey, Record<day, AttentionSession[]>>`。
- 新 API:
  - `openOrExtendSession(docKey, mode, ms, now)`:若该 docKey 当天无「开着的段」则新开一段 `{start: now-ms? }`(见下)并加时长;否则把 `ms` 累加到当前开着段的对应 mode,并更新 `end`。同时把该天标脏。
  - `closeSession(docKey, now)`:把当前开着的段定稿(清掉「开着」标记),之后再来时长会新开一段。
- **开着的段**用「当天数组的最后一个元素 + 一个 `openKey` 集合(docKey|day)标记它仍开着」表示;定稿即从 `openKey` 移除。flush 直接整份序列化内存数组(**覆盖写**,非追加),开着段以其当前 `end` 落盘——**崩溃最多丢一个 flush 周期(~30s)**。
- **preload/absorb 对称扩展**:`preloadDay` 把磁盘 `sessions` 读进内存(覆盖,发生在累计前);`absorbDiskDay`(跨午夜、未 preload 的天)把磁盘 `sessions` **追加**进内存一次(受 `preloadedDays` 门控,不会重复吸收)。因为 flush 是整份覆盖写,不会重复计入。
- `readAllDevices` 一并读出各设备的 `sessions`,叠加本设备内存中未 flush 的。

> `start` 的取值:开新段时用「该段首个活跃时刻」。实现上在 `applyEvent` 把 `activeSince` 从 null→有值 的那一刻即为段开始;tracker 在派发 accrued 前若发现是新开的活跃段,则以 `activeSince` 作为 `start`。等价地也可由 `now - ms` 反推首段起点——实现时以 `activeSince` 为准。

### 3.3 时间段驱动(`timing.ts` + `tracker.svelte.ts`)

`timing.ts` 已有的状态机足够驱动分段,**核心不动**;在 tracker 层挂接:

- `applyEvent` 返回的 `accrued`(带 `mode` 与 `ms`)驱动 `openOrExtendSession`;返回的新 `state.activeSince`:
  - 从 null→有值:说明进入活跃 → 一段开始(记 `start`)。
  - 从有值→null:说明离开活跃(闲置/失焦/切标签)→ `closeSession`。
- `onActiveDocChanged`(切文档):先 `closeSession(oldDocKey)`,再对新文档按活跃状态开段。
- 读↔编切换(`onModeChanged` → `applyEvent {type:'mode'}`):产生一次 accrued 把旧 mode 时长收口,但 `state.activeSince` 仍有值 → **不 closeSession**,同一段延续,只是后续时长记到新 mode。
- 周期性 tick(~30s flush)会更新开着段的 `end`(通过 accrued 累计),保证崩溃安全。
- 卸载/`pagehide`:`closeSession` 当前文档后 flush。

**纯逻辑抽出**:把「accrued + activeSince 变化 → 开/延/关段」这段规约做成 `sessions.ts` 里的纯函数(输入上一状态 + 事件结果,输出更新后的 session 列表与 open 标记),便于单测,tracker 只做副作用编排。

### 3.4 受众(分享浏览)—— beacon + Worker

**beacon**(`src/lib/plugins/share-beacon.js` 及其纯参考 `beacon-timing.ts`):

- 现有 `/a/hit` 心跳与 delta 累计**保持不变**(汇总不受影响)。
- **新增会话定稿上报**:记录本次 pageload 的 `session_start`(首个活跃时刻)与 `active_ms`(即现有 `total` 累计)。在 `visibilitychange→hidden`、`pagehide` 时,除现有 `send(take())` 外,再 `sendBeacon('/a/session', {slug, session_id, start_ts, end_ts, active_ms})`。`end_ts = Date.now()`。同一 pageload 只定稿一次(用一个 `finalized` 标记防重复);若 hidden 后又 visible 继续浏览,复用同 `session_id` 再次定稿会覆盖(见 DO 的 upsert)。
- 隐私:**不上报 visitor_id 到 session 明细**(明细匿名,仅 `{start,end,ms}`);`unique_readers` 仍走现有 `vd:` 机制。

**Worker `SlugAnalytics` DO**(`worker/src/audience.ts`,每 slug 一实例):

- 新增存储键 `s:<utcDay>` → `AudienceSession[]`,元素 `{ id, start, end, ms }`(`id`=session_id 做 upsert 幂等)。
- 新路由(DO 内)`POST /session`:校验 `active_ms ≤ CAP`、`start/end` 合理;按 `utcDay(start_ts)` 落桶;**单天封顶** `MAX_SESSIONS_PER_DAY = 500`(超出丢弃并记一个 `s_dropped:<day>` 计数,便于诚实告知);同 `id` 则覆盖(upsert)。写入后做**保留期裁剪:只留最近 30 天**——`list({prefix:'s:'})`,删除 `utcDay < today-30` 的键(小时汇总 `h:`/`vd:` 不动,仍是长期汇总)。
- 新路由(DO 内)`GET /sessions?from&to`:返回该 slug 在区间内的 `AudienceSession[]`(按 start 升序,匿名)。

**Worker 顶层路由**(`worker/src/index.ts`):
- `POST /a/session`:转发到对应 slug 的 `SlugAnalytics`(与 `/a/hit` 一样按 slug 路由;无需鉴权,和 hit 对等)。
- `GET /a/sessions?slug&from&to`:用 share 的 `edit_token`/API key 鉴权(同 `/a/stats`),透传 DO 的 `/sessions`。

> 受众明细**只从 per-slug DO 取**,不进 `DayRollup`(避免 rollup 膨胀 + 保持匿名)。`/a/stats-all` 与现有汇总链路**完全不变**。

### 3.5 看板数据(`dashboard.svelte.ts` / `audience.ts` client)

- `DeviceAnalytics`/合并层携带 `sessions`;`assembleRows` 把 owner 在区间内的时间段汇聚进行数据结构。
- `InsightRow` 增字段:

```ts
owner_sessions: Array<{ start: number; end: number; mode: 'read'|'edit'|'mixed'; read_ms: number; edit_ms: number }>
// mode:read_ms/edit_ms 谁为 0 则标 读/编,两者都>0 标 mixed
slugs: string[] // 该行下的分享 slug(用于展开时懒取受众明细)
```

- **owner 时间段随行返回**(同步、便宜,总是带上)。
- **受众时间段懒取**:展开某行时,对该行 `slugs` 逐个调用新的 client `fetchAudienceSessions(baseUrl, apiKey, slug, from, to)` → `GET /a/sessions`,合并展示。`/a/stats-all` 不动,单次汇总加载不变。

## 4. UI(`src/components/InsightsPanel.svelte`)

已有「点击行 → 展开 detail-row」(现展示分享 URL)。在同一 detail-row 内**新增时间段区块**:

- **本人**:列出 `owner_sessions`,每条 `MM-DD HH:mm → HH:mm · 读/编/读+编 · 时长`(时间用设备本地时区渲染)。多段全列;超过 N 条(如 20)折叠为「展开更多」。
- **受众**:展开时懒取,列出匿名浏览段 `MM-DD HH:mm → HH:mm · 时长`;加载中显示占位,失败静默(fail-soft),无数据显示「暂无受众时间段」。
- URL 区块保留。区块用小标题分隔(本人时间段 / 受众时间段 / 链接)。
- i18n:新增键走现有 `i18n` 系统(`en.ts` + t());样例文档不译。

## 5. 报告 / CLI(可选,低优先)

用户已明确「仅存数据不急做图」,报告非本次重点。**最小改动**:`renderDailyReport` 可在每篇文档下**可选**附一小节 owner 时间段列表(数据已在 `owner_sessions`,零额外请求)。受众时间段明细**不进报告**(CLI 逐 slug 拉取成本高),报告仍用受众汇总。若评审认为报告也要,再纳入;默认本期报告仅加 owner 段列表且可通过参数关闭。

## 6. 向后兼容与隐私

- 老 day 文件无 `sessions` 顶层键 → 读取默认 `{}`,该文档汇总照显、时间段列表为空。
- 老受众数据无 session 明细 → `/a/sessions` 返回 `[]`,看板显示汇总但无明细。
- 受众明细**匿名**(无 visitor_id)、**只留 30 天**、**单天封顶 500**、封顶丢弃会计数以便诚实告知(不静默截断)。
- 存储上限:per-slug DO 每天最多 500 段 × 最多 30 天,受控。

## 7. 测试策略

- **纯逻辑**(`sessions.ts`、`timing` 扩展):开段/延段(跨读↔编不分段)/闭段(闲置、失焦、切文档);`end == start + read_ms + edit_ms`;跨午夜归 start 日。
- **持久化**(`store.test.ts` 扩展):sessions 往返序列化;preload 覆盖 + absorb 追加均不重复计;多设备读出。
- **Worker**(`audience.test.ts` 扩展):`/session` upsert 幂等;单天封顶与 dropped 计数;30 天裁剪删旧留新;`/sessions` 区间过滤 + 升序;`/a/stats*` 汇总不受影响。
- **看板**(`dashboard.test.ts` 扩展):owner_sessions 汇聚进行;懒取受众段合并;`/a/stats-all` 调用不变。
- **beacon**(`beacon-timing.ts` 纯参考):session 定稿只一次、start/active_ms 正确、hidden↔visible 复用同 id。

## 8. 改动文件清单(概览)

- `src/lib/insights/model.ts`:`AttentionSession` 类型 + `DayFile.sessions`。
- `src/lib/insights/sessions.ts`(新):开/延/闭段纯规约 + 单测。
- `src/lib/insights/store.svelte.ts`:`sessionsMem` + open/extend/close + preload/absorb/flush/readAllDevices 对称扩展。
- `src/lib/insights/tracker.svelte.ts`:accrued/activeSince 变化 → 开/延/闭段编排;切文档/模式/卸载挂接。
- `src/lib/insights/dashboard.svelte.ts`:`InsightRow.owner_sessions`/`slugs`;汇聚 owner 段。
- `src/lib/insights/audience.ts`(client):`fetchAudienceSessions`。
- `src/components/InsightsPanel.svelte`:展开区时间段区块 + i18n。
- `src/lib/plugins/share-beacon.js` + `beacon-timing.ts`:session 定稿上报。
- `worker/src/audience.ts`:`s:<day>` 存储、`/session` upsert+封顶+裁剪、`/sessions` 查询。
- `worker/src/index.ts`:`/a/session`、`/a/sessions` 路由。
- (可选)`src/lib/insights/report.ts`:owner 段列表小节。
- i18n:`src/lib/i18n/en.ts` 新键。
