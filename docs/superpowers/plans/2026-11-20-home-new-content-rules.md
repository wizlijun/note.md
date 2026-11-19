# 主页新内容目录规则 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新内容列表支持用户目录规则(排除 / 只看)、第一层目录 × 满 4 次时询问是否排除、两个列表「更多/更少」+ 滚动续显。

**Architecture:** 规则是两个新的库级设置项(`.notemd/settings.json`,沿用 `search_exclude_dirs` 的整条读写链路);判定是 `home-content/model.ts` 里的纯函数;× 计数与询问状态存本机 `home-content.json`(`VaultContent` 新字段);界面在 `HomeContent.svelte` 与 `SettingsDialog.svelte`(搜索页签,搜索排除目录下方)。

**Tech Stack:** Rust(Tauri 命令,`cargo test`)、Svelte 5 runes、TypeScript、vitest + happy-dom。

**Spec:** `docs/superpowers/specs/2026-11-20-home-new-content-rules-design.md`

## Global Constraints

- 字段名(Rust / JSON / TS):`home_new_exclude_dirs` / `homeNewExcludeDirs`,`home_new_include_dirs` / `homeNewIncludeDirs`;类型 `Option<Vec<String>>`,缺省 = 未配置,每项经 `validate_rel_dir`。
- 匹配:库相对路径前缀,覆盖全部子目录;排除优先于只看;只看为空 = 不限。现有 `CONTROL_NAMES` / `PROCESS_DIRS` / `CONTROL_TYPES` 过滤保留。规则只作用于新内容,不作用于继续阅读。
- 计数:只计新内容列表的 ×;按库根下第一层目录;根目录文件不计;已被排除或已选「继续显示」的目录不计。第 4 次(计数 > 3)时询问;一次只问一个,取最近一次 × 的目录。
- 询问文案(zh):「`{dir}/` 里已关掉 {count} 篇,以后不再显示这个目录?」按钮〔不再显示〕〔继续显示〕;en/ja/de 同步。
- 〔不再显示〕保存失败:报错,询问与计数保留。
- 更多/更少:每批 10 条(现有 `PAGE_SIZE`);展开后底部哨兵进视口再加 10;「更少」回到 10;两列表独立。
- 提交信息英文祈使句,末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;`CHANGELOG.md` 与 `CHANGELOG.zh-CN.md` 未发布区各加用户可感知条目。

## Review Focus

1. 手改 `settings.json` 写成 `./agent-sessions/` 或 `agent-sessions/` → 仍按 `agent-sessions` 匹配(Task 2 测 `normalizeDirRule`)。
2. 前缀误伤:排除 `agent` 不得排除 `agent-sessions/x.md`(Task 2)。
3. 〔不再显示〕保存失败 → 询问条仍在、计数不清、错误可见(Task 3)。
4. 切换 vault 后,旧 vault 的规则不得作用于新 vault(Task 3:`installHomeContent` 清规则)。
5. 在「继续阅读」点 × 不计数(Task 2)。

---

### Task 1: 库级设置项(Rust)

**Files:**
- Modify: `src-tauri/src/sotvault/vault_settings.rs`(`VaultSettings` 加两字段;`merge` 末尾加两参数;测试)
- Modify: `src-tauri/src/sotvault/mod.rs`(`persist_vault_settings`、`notemd_vault_settings_set` 透传两参数)

**Interfaces:**
- Produces: `VaultSettings.home_new_exclude_dirs: Option<Vec<String>>`、`.home_new_include_dirs`;`merge(..., search_weights, home_new_exclude_dirs: Option<Vec<String>>, home_new_include_dirs: Option<Vec<String>>)`;命令参数 `homeNewExcludeDirs` / `homeNewIncludeDirs`(Tauri camelCase)。

- [ ] **Step 1: 写失败测试**(`vault_settings.rs` tests 模块)
  - `merge_validates_home_new_dirs`:`merge(VaultSettings::default(), None×9, Some(vec![" agent-sessions/ ".into(), "./project/axe-research".into()]), Some(vec![]))` → `home_new_exclude_dirs == Some(vec!["agent-sessions", "project/axe-research"])`(取值以 `validate_rel_dir` 的实际规范化为准,先读它的尾部再定断言),`home_new_include_dirs == Some(vec![])`。
  - `merge_rejects_escaping_home_new_dir`:exclude `Some(vec!["../x".into()])` → `Err`。
  - `home_new_dirs_round_trip_and_absent_by_default`:默认序列化不含 `homeNewExcludeDirs` 键;写入后 `read` 读回相等。
- [ ] **Step 2:** `cargo +1.99.0 test --manifest-path src-tauri/Cargo.toml --lib sotvault::vault_settings` → 编译失败(参数个数不符)。
- [ ] **Step 3:** 加字段(`#[serde(default, skip_serializing_if = "Option::is_none")]`,doc 注释写明只作用于主页新内容)、`merge` 两参数(同 `search_exclude_dirs` 的逐项校验)、所有现存 `merge(` 调用点补 `None, None`、`mod.rs` 两处透传。
- [ ] **Step 4:** 同 Step 2 命令 → PASS;再跑 `cargo +1.99.0 test --manifest-path src-tauri/Cargo.toml --lib sotvault` → 全绿;`cargo +1.99.0 clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 无新告警。
- [ ] **Step 5:** 提交 `Add home new-content directory rules to vault settings`。

### Task 2: 判定与计数(纯函数)

**Files:**
- Modify: `src/lib/home-content/model.ts`
- Test: `src/lib/home-content/model.test.ts`

**Interfaces:**
- Produces:
  - `interface HomeDirRules { exclude: string[]; include: string[] }`,`const noDirRules: HomeDirRules`
  - `normalizeDirRule(raw: string): string | null` — 去首尾空白、前导 `./`、首尾 `/`;空 / 含 `..` 段 → `null`
  - `passesDirRules(rel: string, rules: HomeDirRules): boolean` — `rel` 为库相对路径
  - `topDir(key: string): string | null` — `rel:a/b/c.md` → `'a'`;`rel:c.md` / `abs:` → `null`
  - `VaultContent` 新增 `dismissCounts: Record<string, number>`、`keepDirs: string[]`、`askDir: string | null`(`normalizeHomeContent` 容错:非法值回落 `{}` / `[]` / `null`;`vaultFor` 初值同)
  - `countNewDismiss(vault: VaultContent, key: string, rules: HomeDirRules): void` — 按 Global Constraints 计数;计数 > 3 时 `vault.askDir = dir`
  - `contentLists(vault, candidates, root, now, limit = 10, unavailable = new Set(), dirRules: HomeDirRules = noDirRules)` — 新内容额外要求 `passesDirRules`

- [ ] **Step 1: 写失败测试**(`describe('directory rules')`)
  - `normalizeDirRule`:`'./agent-sessions/'`→`'agent-sessions'`;`' a/b/ '`→`'a/b'`;`''`→`null`;`'a/../b'`→`null`。
  - `passesDirRules`:exclude `['agent-sessions']` 拒 `agent-sessions/openai/x.md`,放 `agent-sessionsx/y.md`;exclude `['agent']` 放 `agent-sessions/x.md`;include `['project']` 放 `project/rapp/issues/1.md`、拒 `stat/a.md`;exclude `['project/axe-research']` + include `['project']` 拒 `project/axe-research/a.md`、放 `project/rapp/a.md`;规则项写成 `'./stat/'` 也生效。
  - `contentLists` 传 `{ exclude: ['stat'], include: [] }`:`stat/a.md` 不在 `newItems`,但若读过仍在 `continueItems`。
  - `countNewDismiss`:同一第一层目录不同子目录 4 篇 → 第 3 次后 `askDir === null`,第 4 次后 `askDir === 'agent-sessions'`;根目录 `rel:a.md` 不计;`keepDirs: ['stat']` 时 `stat/...` 不计;exclude 规则里的目录不计;两个目录先后到 4,`askDir` 是后一个。
  - `normalizeHomeContent` 读旧数据(无新字段)→ `dismissCounts {}`、`keepDirs []`、`askDir null`。
- [ ] **Step 2:** `pnpm vitest run src/lib/home-content/model.test.ts` → FAIL(未导出)。
- [ ] **Step 3:** 实现上述接口。`passesDirRules` 对每条规则先 `normalizeDirRule`,`null` 跳过;匹配 = `rel === d || rel.startsWith(d + '/')`。
- [ ] **Step 4:** 同命令 → PASS。
- [ ] **Step 5:** 提交 `Filter home new content by directory rules and count dismissals`。

### Task 3: 主页数据层接线

**Files:**
- Modify: `src/lib/home-content/store.svelte.ts`、`src/lib/vault-settings.svelte.ts`
- Test: `src/lib/home-content/store.test.ts`

**Interfaces:**
- Consumes: Task 1 命令参数;Task 2 全部导出。
- Produces:
  - `vault-settings.svelte.ts`:`VaultSettingsDto` 加 `homeNewExcludeDirs?`/`homeNewIncludeDirs?: string[] | null`;`vaultSettings` 加 `homeNewExcludeDirs: string[]`、`homeNewIncludeDirs: string[]`(load 时 `?? []`);`saveHomeNewDirs(patch: { exclude?: string[]; include?: string[] }): Promise<HomeDirRules>`(只发给出的键,返回合并后的规则并更新 `vaultSettings`)。
  - `store.svelte.ts`:`homeContentStore.ask: { dir: string; count: number } | null`;`applyHomeDirRules(rules: HomeDirRules): void`(设置并 `publish()`);`excludeAskedDir(): Promise<void>`;`keepAskedDir(): Promise<void>`。
- 行为:`refreshHomeContent` 与 catalog 并行 `invoke('notemd_vault_settings_get')`,失败/缺字段 → 保留当前规则(首载为 `noDirRules`);`installHomeContent` 重置规则为 `noDirRules`、`ask` 为 `null`;`dismissHomeContent('new', path)` 在同一次 `change` 里调用 `countNewDismiss`;`publish()` 把规则传入两处 `contentLists`,并从 `vault.askDir` 推出 `ask`(该目录已被当前规则排除则视为无询问);`excludeAskedDir` = `saveHomeNewDirs({ exclude: [...current, dir] })` 成功后 `applyHomeDirRules` 并在 `change` 里清 `askDir` 与该目录计数,失败则抛出、本地状态不变;`keepAskedDir` = `change` 里 `keepDirs.push(dir)`、清 `askDir`。

- [ ] **Step 1: 写失败测试**(沿用 store.test.ts 的 `mocks.invoke` 分派:`notemd_vault_settings_get` 返回 `{ homeNewExcludeDirs: ['stat'] }`,`notemd_vault_settings_set` 回显合并结果)
  - 规则载入后,`stat/a.md` 不在 `newItems`,`update_latest_menu` 最后一次调用也不含它。
  - 在 `agent-sessions/...` 下 4 篇各 `dismissHomeContent('new', …)` → `homeContentStore.ask` 为 `{ dir: 'agent-sessions', count: 4 }`;`dismissHomeContent('continue', …)` 不改变计数。
  - `excludeAskedDir()`:`notemd_vault_settings_set` 收到 `{ homeNewExcludeDirs: ['stat', 'agent-sessions'] }`;之后 `ask === null`,该目录条目消失。
  - `excludeAskedDir()` 在 set 抛错时 reject,`ask` 仍是原值,再 `dismiss` 一篇后计数为 5。
  - `keepAskedDir()` → `ask === null`,第 5 篇 × 不再询问。
  - 先 install vault A(规则 `['stat']`),再 install vault B 且 settings_get 抛错 → B 的 `stat/a.md` 出现在 `newItems`。
- [ ] **Step 2:** `pnpm vitest run src/lib/home-content/store.test.ts` → FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 同命令 → PASS;`pnpm vitest run src/lib/home-content` 全绿。
- [ ] **Step 5:** 提交 `Load home directory rules and ask before excluding a dismissed directory`。

### Task 4: 界面、文案与 CHANGELOG

**Files:**
- Modify: `src/components/HomeContent.svelte`、`src/components/SettingsDialog.svelte`、`src/lib/i18n/{zh,en,ja,de}.ts`、`CHANGELOG.md`、`CHANGELOG.zh-CN.md`
- Test: `src/components/HomeContent.test.ts`(mock 增 `excludeAskedDir`、`keepAskedDir`,store 增 `ask`;`../lib/ui-state.svelte` mock `openSettings`)

**Interfaces:**
- Consumes: Task 3 的 `homeContentStore.ask`、`excludeAskedDir`、`keepAskedDir`、`applyHomeDirRules`、`saveHomeNewDirs`、`vaultSettings.homeNew*`。
- i18n 新键:`homeContent.less`(更少)、`homeContent.askExclude`(含 `{dir}` `{count}`)、`homeContent.askExcludeYes`(不再显示)、`homeContent.askExcludeNo`(继续显示)、`homeContent.rules`(目录规则)、`settings.homeNewHeading`(主页新内容)、`settings.homeNewExcludeDirs`(排除目录)、`settings.homeNewIncludeDirs`(只看这些目录)、`settings.homeNewDirsHint`(一行一个库内目录,含子目录;排除优先;只看留空表示不限)。

- [ ] **Step 1: 写失败测试**
  - 25 条新内容:初始 10 条,标题旁按钮文字 `More`;点后按钮变 `Less`,列表底部出现 `[data-content-sentinel="new"]`;手动触发哨兵回调(happy-dom 无 IntersectionObserver:组件经 `globalThis.IntersectionObserver` 取构造器,测试里 stub 一个记录回调的假实现)→ 20 条,再触发 → 25 条且哨兵消失;点 `Less` → 10 条。`continue` 列表状态不受影响。
  - ≤10 条时不显示更多按钮、无哨兵。
  - `store.ask = { dir: 'agent-sessions', count: 4 }` → 显示含 `agent-sessions/` 与 `4` 的 `role="status"` 询问条;点 `Stop showing` 调 `excludeAskedDir`,点 `Keep showing` 调 `keepAskedDir`;`excludeAskedDir` reject 时显示现有错误条。
  - 点新内容标题旁的规则入口 → `openSettings('search')`。
- [ ] **Step 2:** `pnpm vitest run src/components/HomeContent.test.ts` → FAIL。
- [ ] **Step 3:** 实现 HomeContent:`expanded`/`visibleRows` 每列独立;哨兵用 `$effect` + IntersectionObserver;询问条放在新内容 `<ul>` 之前,样式沿用 `content-partial`;规则入口样式沿用 `content-more`。SettingsDialog:搜索页签、`search.index.settingsHeading` 那个 `section.block` 之后新加一个 `section.block`(标题 `settings.homeNewHeading`),两个 textarea + 一个保存按钮,保存走 `saveHomeNewDirs({ exclude, include })` 后 `applyHomeDirRules(result)`,成功/失败 toast 同 `onSaveSearchExcludeDirs`;打开时从 `vaultSettings` 填草稿。四种语言加键(en 文案:`Less`、`Hidden {count} items from {dir}/. Stop showing this folder?`、`Stop showing`、`Keep showing`、`Folder rules`、`Home: new content`、`Exclude folders`、`Only these folders`、`One vault folder per line, including subfolders. Exclusions win; leave "only" empty for no limit.`;ja/de 意译)。CHANGELOG 两份未发布区各加一条(中:「主页新内容可按目录排除或只看指定目录;同一目录关掉 4 篇后会询问是否不再显示;列表「更多」可收起,展开后滚动自动加载。」英文对应)。
- [ ] **Step 4:** `pnpm vitest run src/components/HomeContent.test.ts src/components/DesktopVaultSettings.test.ts src/lib/home-content` → PASS;`pnpm check` 0 errors;`node scripts/changelog.mjs check` 通过。
- [ ] **Step 5:** 提交 `Add folder rules, dismissal prompt and more/less paging to the home lists`。
