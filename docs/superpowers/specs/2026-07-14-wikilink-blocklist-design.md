# 无效 wikilink 黑名单 — 设计文档

日期：2026-07-14
分支：feat/recall-perf-linkfix

## 目标

在 note.md 里维护一份"无效 wikilink"清单：命中清单的 `[[X]]` 不渲染成链接样式、不可点击、不响应，也不索引为关系、不派生成 note.md 大纲条目。清单存在**用户 vault 的 `wikilink/` 目录**下、**用户可自行编辑**，首次由随版本发布的默认三条（`wikilink` / `链接` / `双链`）播种。

## 背景（探查结论）

- 现状：任何 `[[..]]` 都无条件当链接，**零过滤**。要全覆盖"显示 / sync / 响应"，需在**三套独立的 wikilink 识别器**接入判断：
  - `src/lib/outline/parser.ts` 的 `parseInline`（被大纲显示 `InlineRender.svelte`、索引 `backlinks.ts`、`recall.ts` 消费）
  - `src/lib/outline/derive.ts` 的 `INLINE_RE`（主文档 → 派生大纲自动条目，wikilink 是分组 m[6]）
  - `src/lib/wikilink-plugin.ts` 的 `WIKILINK_RE` + `buildDecorations`（主富文本编辑器装饰 + 点击 `data-wikilink`）
- vault 文件机制（照现有模式）：
  - vault 根：`sotvaultStore.vaultRoot`（`src/lib/sotvault.svelte.ts`）
  - 目录约定：`src/lib/outline/dirs.svelte.ts` 的 `DEFAULT_DIRS`/`outlineDirs`（`wikipage`/`dailynote`）
  - 读：`readTextFile`（`@tauri-apps/plugin-fs`）/ `readMd`（`src/lib/fs.ts`）
  - 播种：`exists` + `writeTextFile`（参照 `src/lib/outline/create.ts` 的 `ensureOutlineFile`）
  - 监听：`watchImmediate`（参照 `src/lib/outline/backlinks-io.svelte.ts` 的 vault 监听 + 300ms 去抖）
  - 响应式 store：`$state` + `bump()`（参照 backlinks-io 的 store 初始化）

## 需求（已与用户确认）

1. 清单存 **`vault/wikilink/blocklist.md`**，**用户可编辑**；首次不存在时用默认三条播种。
2. 默认三条（随版本发，编译进前端常量作播种源）：`wikilink`、`链接`、`双链`。
3. 匹配：**大小写无关的精确匹配**，先剥 `|别名` 和 `#标题` 取页名。
4. 命中"显示"时：**原样显示 `[[X]]` 纯文本**，无链接样式、不可点。
5. 命中还要：不索引为 backlink 关系、不派生成大纲条目、编辑器里不装饰不响应。
6. **未打开 vault 时黑名单为空、不拦截**（安全默认，不误伤）。

## 架构：纯逻辑与 vault I/O 分离（2 个新单元 + 3 接入点）

### 单元 1 — `src/lib/wikilink/blocklist.ts`（纯，零 vault 依赖）

```ts
export const DEFAULT_BLOCKED_WIKILINKS = ['wikilink', '链接', '双链']

/** 剥 |别名 与 #标题，trim，toLowerCase → 规范页名 */
export function normalizeWikilinkTarget(raw: string): string

/** 用给定清单重建模块级 Set（每项 normalize） */
export function setBlockedWikilinks(list: string[]): void

/** normalize(target) 是否在当前 Set 里 */
export function isBlockedWikilink(target: string): boolean

/** markdown 列表文本 → 条目数组（跳过 front-matter/空行/#标题，剥行首 - / *） */
export function parseBlocklistFile(text: string): string[]
```

- 模块级持有 `let blocked = new Set<string>()`，**默认空**。所以现有单测、以及"未加载 vault"时，`isBlockedWikilink` 恒返回 false，行为不变、不误伤。
- 加载器解析清单后调 `setBlockedWikilinks` 灌进去；用户改文件→重载→再灌。
- 全部纯函数，独立单测。

### 单元 2 — `src/lib/wikilink/blocklist-io.svelte.ts`（vault I/O + 响应式）

```ts
export async function ensureWikilinkBlocklist(vaultRoot: string): Promise<void>
```
职责：
1. 路径 `joinPath(vaultRoot, outlineDirs.wikilink, 'blocklist.md')`。
2. 目录/文件不存在 → 用 `DEFAULT_BLOCKED_WIKILINKS` 生成默认 markdown 内容并 `writeTextFile`（`exists` 判断，照 `ensureOutlineFile`；必要时 `mkdir` 目录）。
3. `readTextFile` → `parseBlocklistFile` → `setBlockedWikilinks`。
4. `watchImmediate(该文件, …)`：改动后重读 + `setBlockedWikilinks` + `bump()`（触发重渲染），带去抖。
- 在现有 vault 初始化处调用一次（与 `backlinks-io` 的挂载点同处/相邻）。

### dirs 扩展

`src/lib/outline/dirs.svelte.ts`：`DEFAULT_DIRS` 加 `wikilink: 'wikilink'`，`outlineDirs` 类型同步加 `wikilink: string`。

### 默认文件内容（播种）

```md
# 无效 wikilink 清单（此处列出的不会渲染为链接、不可点、不进关系索引）
- wikilink
- 链接
- 双链
```
解析（`parseBlocklistFile`）：逐行，跳过 `---` front-matter 块、空行、`#` 开头的标题；剥行首 `- ` / `* ` / `+ `；trim；非空即为一条。

### 三个接入点（都调纯函数 `isBlockedWikilink`）

1. **`src/lib/outline/parser.ts` `parseInline`**：`[[` 分支拿到 `target` 后，若 `isBlockedWikilink(target)` → **不产 `page-link`**，而是把字面 `[[` + target + `]]` 并入当前文本缓冲（`text += …`）、推进指针。→ 一处改动自动覆盖大纲显示（InlineRender 只见纯文本）、backlink 索引（无 page-link 不登记）、recall（carriesPage 找不到）。
2. **`src/lib/outline/derive.ts`**：wikilink 分支（`m[6] != null`）里，若 `isBlockedWikilink(m[6])` → `continue`，不 push `source:'wikilink'` 条目。
3. **`src/lib/wikilink-plugin.ts` `buildDecorations`**：对每个 `WIKILINK_RE` 命中的 target，若 `isBlockedWikilink(target)` → 跳过，不加 `.wikilink` 装饰与 `data-wikilink`。→ 无样式、无 `data-wikilink` 则点击不触发 `openWikilink`，天然"不响应"。

## 数据流

```
vault 打开 → ensureWikilinkBlocklist(vaultRoot)
           → 播种/读取 blocklist.md → parseBlocklistFile → setBlockedWikilinks(Set)
           → watchImmediate(blocklist.md)
识别 [[X]] → 提取 target → isBlockedWikilink(X)（剥别名/标题、小写、查 Set）
           → 命中：当纯文本 / 跳过；未命中：照旧当链接
用户编辑 blocklist.md → watch 重载 → setBlockedWikilinks 更新 → bump() → 下次渲染/派生生效
```

## 响应式（reload 后已渲染视图如何更新）

`isBlockedWikilink` 读的是**纯模块级 Set**（非响应式）。若只这样，`InlineRender` 的 `$derived(parseInline(content))` 只依赖 `content`，黑名单变了不会自动重渲染。因此：

- **`blocklist-io.svelte.ts` 额外导出一个响应式版本号** `wikilinkBlocklistVersion = $state(0)`；每次 `setBlockedWikilinks`（首次加载 + watch 重载）后 `wikilinkBlocklistVersion++`。
- **显示消费方订阅它**：`InlineRender` 改为 `$derived.by(() => { void wikilinkBlocklistVersion; return parseInline(content) })`，从而黑名单变化即重渲染（与 `OutlineNode` 里 `void outline.version` 的现有惯例一致）。
- **大纲派生 / backlink 索引**：watch 重载后，除 `wikilinkBlocklistVersion++` 外，调用与 backlinks-io 相同的 `bump()`；打开的大纲在下一次派生/索引刷新时应用新黑名单（沿用现有刷新链路，不新造）。
- **编辑器装饰**：`wikilink-plugin` 的装饰在下一次编辑或重开文档时按新黑名单重建（可接受）；不为它单独做即时刷新（YAGNI）。

## 匹配语义

`[[wikilink]]` / `[[Wikilink]]` / `[[WIKILINK]]` / `[[wikilink|别名]]` / `[[wikilink#节]]` 命中（页名 `wikilink` 小写精确等于清单项）；`[[wikilink2]]` / `[[my wikilink]]` 不命中（整串不等，非子串匹配）。

## 边界 / 错误处理

- **未打开 vault / 加载失败**：Set 保持空，`isBlockedWikilink` 恒 false，不拦截（安全默认）。
- **blocklist.md 读失败/格式乱**：`parseBlocklistFile` 尽量解析，读失败则保留上一次的 Set（`try/catch`，`console.warn`），不崩。
- **黑名单词嵌在 emphasis**（`**[[链接]]**`）：parser 递归解析内部时同样命中 → 渲染成加粗纯文本 `[[链接]]`、不可点。
- **空 / 纯空白 target**：normalize 后为空串，不加入 Set、不命中。
- **blocklist.md 自身**：条目是纯页名（不含 `[[]]`），不会被识别成 wikilink、不产生关系；且它是普通 `.md`，不在 `.note.md`-only 的关系索引范围内。

## 测试

- `src/lib/wikilink/blocklist.test.ts`（纯）：
  - `normalizeWikilinkTarget`：剥 `|别名`、`#标题`、大小写、trim。
  - `parseBlocklistFile`：跳过 front-matter/空行/标题、剥列表符号、多条。
  - `setBlockedWikilinks` + `isBlockedWikilink`：默认空不拦；设入三条后大小写/别名/标题变体命中，非清单词放行；重设覆盖旧集合。
- `src/lib/outline/parser.test.ts`：`setBlockedWikilinks(['wikilink'])` 后 `[[wikilink]]` → `{t:'text', text:'[[wikilink]]'}`；普通 `[[X]]` 仍 `page-link`；用例末 `setBlockedWikilinks([])` 复位避免污染其它用例。
- `src/lib/outline/backlinks.test.ts`：命中项不进 `byTarget` 索引。
- `src/lib/outline/derive.test.ts`：命中的 `[[X]]` 不派生 `source:'wikilink'` 条目。
- blocklist-io（vault I/O + watch）不做纯单测；解析逻辑已抽成 `parseBlocklistFile` 单测覆盖。实现后手动冒烟：改 `vault/wikilink/blocklist.md` 加一条 → 对应 `[[X]]` 变纯文本。

## 非目标（YAGNI）

- 不做专门的黑名单管理 UI（用户直接编辑 `vault/wikilink/blocklist.md`）。
- 不做 Rust 改动（纯前端；默认三条为前端常量作播种源，即"随版本发"）。
- 不改 open/create 流程（命中的不可点，click 到不了 open）。
- 不做正则/通配匹配（只精确页名匹配）。
