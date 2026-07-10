# Wikilink 全局命名空间收窄到 wikipage/dailynote

日期：2026-07-11
分支：`feat/wikilink-page-scope`

## 背景与问题

当前 `[[X]]` 的解析目标是**整个 vault 递归扫描到的每一个 `.md`**（`backlinks.ts` 的 `filePages`）。任意目录下的散落文档只要同名就互相争抢，导致 vault 里出现大量「链接名冲突」（实测 95 组，多为 `commoncog-…` 等外部导入文档）。冲突让 `[[X]]` 可能跳到非预期文件，反链与大纲同步也不准。

wikilink 是大纲/wiki 体系的功能。可解析目标应只限**真正的 wiki 页面**，而非 vault 里任何一个 markdown 文件。

## 目标

把 `[[X]]` 的**可解析目标**收窄到位于 `wikipage/` 或 `dailynote/` 约定目录下的文件，从根上消除散落文档带来的命名冲突。**反链来源**保持扫全 vault 不变。

## 核心决策（已确认）

1. **反链来源（`byTarget`）保持全 vault 扫描**。任意目录的普通 `.md` 里写的 `[[某wiki页]]`，仍会出现在该 wiki 页的 backlinks 面板。（选项 A）
2. **可解析目标包含 `wikipage/` 与 `dailynote/` 两个目录**（日记页也进全局命名空间）。（选项 B）
3. **非 vault 的 FolderView 根同规则收窄**：该根下有 `wikipage/` 子目录才有可解析目标，没有则 `[[X]]` 一律新建。（选项 B）
4. **递归子目录都算**（含 `dailynote/{年}/…` 这类嵌套）。
5. **目录下的普通 `.md` 也算 wiki 页**（不强制 `.note.md` 后缀），宽松、少意外。

## 设计：PageScope

给 `BacklinkIndex` 附带一个作用域：

```ts
interface PageScope { root: string; dirs: string[] }   // dirs 默认 [wikipage, dailynote]，读 outlineDirs（可配置）
```

判定「是不是 wiki 页」（纯函数）：

```
isWikiPagePath(scope, path):
  rel = path 相对 scope.root
  segs = rel.split('/')
  return segs.length >= 2
      && scope.dirs.includes(segs[0])
      && /\.md$/i.test(path)
```

- vault 根：`vault/wikipage/**/*.md`、`vault/dailynote/**/*.md` 都算页面。
- 非 vault 根：同规则套在该根上。
- `scope` 为空（纯逻辑调用 / 老单测）→ 退回「所有 `.md` 都是页面」，向后兼容。

## 改动点

### `src/lib/outline/backlinks.ts`

- `createIndex(scope?: PageScope)`：把 scope 存到 `BacklinkIndex` 上。
- 新增导出纯函数 `isWikiPagePath(scope: PageScope | null, path: string): boolean`。
- `indexFileContent`：
  - `byTarget` 照旧记录**所有**文件的出链（`[[]]` / `#tag`）—— 反链来源不变。
  - **仅当** `isWikiPagePath(idx.scope, file)` 为真时才 `filePages.set(file, pageNameOf(file))`。
- `buildFolderIndex(rootDir, dirs, onMigrate?)`：用 `{ root: rootDir, dirs }` 建带 scope 的索引。
- `refreshFileInIndex`：沿用索引上已存的 scope，增量刷新遵循同一判定（非页面文件只更新 `byTarget`，不进 `filePages`）。
- `resolveTarget` / `detectNameCollisions` / `pageCandidates`：**不改**——它们本就读 `filePages`，随之自动收窄。

### `src/lib/outline/backlinks-io.svelte.ts`

- `ensureIndex` 调 `buildFolderIndex` 时传入 `[outlineDirs.wikipage, outlineDirs.dailynote]`。

## 预期效果

- 那 95 组冲突消失：散落文档不再是 wiki 目标，`detectNameCollisions` 只在 wikipage/dailynote 内检测。
- `[[` 自动补全候选（`pageCandidates`）只列真正的 wiki 页，更干净。
- 反链面板不变：任意文档对 wiki 页的引用仍显示。
- `dailynote/{年}/…` 嵌套页正常纳入。

## 测试

`src/lib/outline/backlinks.test.ts`：

- 现有用例改为在带 scope（root `/v`，dirs `[wikipage, dailynote]`）的索引上运行。
- 新增：
  - `/v/wikipage/x.note.md` 与 `/v/sub/x.md` 并存时，`resolveTarget('x')` → wikipage 那个；`/v/sub/x.md` 不可解析。
  - 两个散落文档同名（`/v/a/foo.md`、`/v/b/foo.md`）→ `detectNameCollisions` **不**报冲突。
  - 两个 wiki 页同名（`/v/wikipage/foo.note.md`、`/v/wikipage/sub/foo.note.md`）→ 报冲突。
  - `/v/dailynote/2026/2026-07-11.note.md` 递归纳入、可解析。
  - `scope` 为空时保持旧行为（所有 `.md` 都是页面）。
  - 散落文档里的 `[[wikipage页]]` 仍进 `byTarget` / 出现在 `backlinksFor`。

`pnpm test`（vitest）+ `pnpm check`（svelte-check）全绿。

## 非目标

- 不改日期链接的路径直达规则（`daily.ts` 的 `ensureDailyNote` 先于索引处理不变）。
- 不改 vault 外「同目录建 `.md`」的新建回退行为。
- 不做冲突清理工具（另议）。
