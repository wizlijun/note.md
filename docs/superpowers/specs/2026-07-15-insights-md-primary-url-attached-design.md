# 阅读洞察输出：md 为主、URL 为附属

日期：2026-07-15
状态：已确认，待实施

## 背景与目标

阅读洞察插件（Reading Insights）在面板与日报/CLI 中输出「关键项」。当前问题：

- 溯源不到 md 时，行标识退化成分享 slug（URL 状），主输出变成 URL 而非 md 文件。
- 日报/CLI 表格根本不打印 URL；面板仅能显示单个 `getRecord(path).url`。
- 同一个 md 对应多个 slug/URL（重复分享、旧 slug 的受众数据）时，`assembleRows` 会产出**多行重复**。

目标：让 **md 文件成为主标识**，分享 URL 降为**附属字段**；同一 md 的多个 URL **合并成一行、聚合成列表**；彻底溯源不到的 slug 仍单独成行（附重建 URL）。

## 关键事实（现状）

- `InsightRow`（`src/lib/insights/dashboard.svelte.ts`）无 `url` 字段；`label` 溯源到时为 md basename，溯源不到时为 slug。
- 溯源链：`bySlug`（本地 share 记录）→ `resolveSrc(aud.src)`（服务端源路径）→ fallback `{ docKey: slug, label: slug }`。
- 分享 URL 格式：`${baseUrl}/${slug}`（`src/lib/share/publish.ts:83`）；本地记录里存全量 `ShareRecord.url`。
- 日报由 `renderDailyReport`（`report.ts`）生成，`--stdout` 与写盘 CLI 共用（`run.ts` 的 `generateInsightsReport`）。

## 设计

### 1. 数据模型（`dashboard.svelte.ts`）

- `InsightRow` 新增 `urls: string[]`：映射到该行 md 的所有去重分享 URL；非分享文档为 `[]`。
- `ShareResolution` 新增 `url: string | null`：来自本地记录 `getRecord(path).url`。
- `AssembleDeps` 新增 `resolveSlugUrl(slug: string): string | null`：无本地记录时按 `${baseUrl}/${slug}` 重建；无 baseUrl 返回 `null`。

### 2. 溯源 + 合并（`assembleRows`）

改为「贡献项 → 按 docKey 分组」两步：

- **贡献项**：
  - 每个 owner 文档一条：真实计数器 + 其记录 slug 的受众数据。
  - 每个「仅线上被读」slug 一条（`ownerSlugs` 之外、且 `total_ms>0||unique_readers>0`）：空计数器 + 该 slug 受众数据，沿用 `bySlug`/`resolveSrc` 溯源到 docKey，溯源不到才 fallback 到 slug。
- **按 `docKey` 合并**：
  - 计数器求和（owner 唯一、其余为空计数器）。
  - 受众 `aud_read_ms`/`unique_readers` 跨 slug 相加（跨 slug 无法去重读者，接受近似）。
  - `urls` 取并集（本地记录用 `share.url`，否则 `resolveSlugUrl(slug)`；去重、去 null）。
  - `shared = 任一贡献项有 slug`。
  - `value` 用合并后计数器 + 合并后受众重算。
- 结果按 `value` 降序（与现状一致）。→ 顺带修掉多 slug 同 md 重复成多行的 bug。

### 3. 日报 / CLI（`report.ts`）

- 表格不变：第一列仍是 md 文件名 `label`，`🔗` 标记分享。
- 表格下方新增 `## 链接` 小节，仅列 `urls.length > 0` 的行，md 一级项、多 URL 各占一子行：

  ```
  ## 链接
  - 《label》
    - https://host/slug1
    - https://host/slug2
  ```
- 无任何带 URL 的行时不输出该小节。`--stdout` 与写盘一处改动同时覆盖。

### 4. 面板（`InsightsPanel.svelte`）

展开详情从「`getRecord(r.path).url` 单个」改为渲染 `r.urls` 全部链接，与新模型一致。

## 测试（TDD）

- `dashboard.test.ts`：
  - 多 slug 同 md 合并成一行、`urls` 聚合去重、受众相加。
  - 溯源不到的 slug 仍单独成行且带 `resolveSlugUrl` 重建 URL。
  - 非分享文档 `urls === []`。
- `report.test.ts`：
  - `## 链接` 小节渲染、多 URL 分行。
  - 无分享行时不输出该小节。

## 非目标

- 不改受众采集/存储格式与服务端。
- 不做 vault 全盘搜索兜底。
- 不迁移历史数据。
