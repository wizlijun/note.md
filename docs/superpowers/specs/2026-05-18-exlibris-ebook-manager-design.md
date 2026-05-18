# ExLibris — Ebook Manager App — Design

**Status**: Brainstorm complete; pending implementation plan
**Date**: 2026-05-18
**Owner**: bruce.extra@hemory.com
**Related**: `2026-05-08-plugin-system-design.md`（参考但不复用其插件模型）、`2026-05-12-vaultgitsync-integration-design.md`（sotvault git 同步）

## Goal

引入一个**独立的 macOS app `ExLibris`**，用于管理 ebook 库：

- 用户拖入 ebook 文件（epub/mobi/azw/azw3/pdf/...）→ 调用本机 calibre 抽取元数据、转换为 markdown → 写入两个 vault：
  - **rawvault**：二进制 archive，按时间分桶稳定布局
  - **sotvault**：markdown + 元数据，按用户可配置的规则组织，与 mdeditor 共享、走 git 同步
- 与 mdeditor **完全独立的进程、独立的安装包、独立的发布周期**；只通过共享 config 文件和 mdeditor tray 的一个 launcher 项相关联。

本 spec 同时包含 mdeditor 侧最小化改动（tray 菜单 + shared config 接入），但不包括"rawvault 分布式同步"——那是后续单独的 spec。

## Motivating principles

1. **rawvault 是稳定的、自包含的 archive**：物理布局只按时间分桶，文件名取自 calibre title 清洗结果。一次写入永不移动。后续做 rawvault 同步时，这种稳定性保证不会触发巨量重传。
2. **sotvault 是可重组的展示层**：规则改了 → 移动 sotvault 里的 markdown 目录（小文件、git mv 友好）。**rawvault 永不因为规则变化而动**。
3. **canonical 元数据只放一份**：`meta.yml` 和 `book.md` 只存在于 sotvault，受 git 同步保护。rawvault 严格只放二进制。
4. **ExLibris 与 mdeditor 物理解耦**：独立进程、独立窗口、独立设置。仅通过共享 config 共享 sotvault/rawvault/calibre 路径，仅通过 mdeditor tray 的 `open -a ExLibris` 唤起。两者可独立升级、独立崩溃。
5. **calibre 是可选依赖**：探测不到不阻塞 app 启动，只是导入功能 disabled + 顶部 banner 引导配置。

## Non-goals (v1)

- ❌ rawvault 的分布式同步（独立 spec；本 spec 只占位 tray 菜单项）
- ❌ "从 rawvault 冷重建 sotvault"——`book.md` 是分钟级计算产物，鼓励用 git 恢复而不是重算
- ❌ 单本图书的精细操作（删除、重命名、手动覆盖分类、re-convert）——v1 只做导入 + 浏览 + rule-driven rebuild
- ❌ 移动端 / Windows / Linux 支持——v1 只 macOS（aarch64 + x86_64 双 dmg）
- ❌ 封面、扉页、目录等衍生物的保存——v1 只 binary + book.md + meta.yml
- ❌ 多格式合并（同一本书的 epub + pdf 看作一本）——v1 每个文件独立看作一本
- ❌ 内置 calibre / Docker / 远程转换——只支持本机已安装的 calibre
- ❌ 规则的 JS 表达式 / 复合条件——v1 限定 `ext` / `tag_contains` / `author_contains` / `language` 这四个字段
- ❌ ExLibris 的 menubar tray icon——v1 是普通 dock app
- ❌ 多用户 / 团队 / 协作语义——单用户工具

## Architecture

```
┌────────────────────────┐         ┌─────────────────────────┐
│ mdeditor (Tauri)       │         │ ExLibris (Tauri)        │
│                        │         │                          │
│  tray menu:            │         │  Window:                 │
│   ...                  │         │   [drop zone]            │
│   Open Books  ────open─┼────┐    │   [pending list]         │
│   Open Raw Vault Sync  │    │    │   [library browser]      │
│   ───── (disabled)     │    │    │                          │
│   Quit                 │    │    │  Settings:               │
│                        │    │    │   - sotvault/rawvault    │
│  Settings dialog:      │    │    │   - calibre path         │
│   Vault tab ←──reads───┼──┐ │    │   - rules editor         │
│                        │  │ │    │                          │
└────────────────────────┘  │ │    └──────┬──────────────────┘
                            │ │           │
                            ▼ ▼           ▼
            ┌────────────────────────────────────────┐
            │ shared config:                          │
            │ ~/Library/Application Support/          │
            │   com.laobu.mdeditor-shared/config.json │
            │  { sotvault, rawvault, calibre_path }   │
            └────────────────────────────────────────┘
                            │           │
                            ▼           ▼
            ┌──────────────────┐  ┌──────────────────────┐
            │ sotvault (git)   │  │ rawvault              │
            │  <rule>/         │  │  books/YYYY/YYYYMM/   │
            │   <BookName>/    │  │    <BookName>.<ext>   │
            │     book.md      │  │                       │
            │     meta.yml     │  │                       │
            │  .exlibris/      │  │                       │
            │    rules.yml     │  │                       │
            └──────────────────┘  └──────────────────────┘
```

### Storage 布局

**rawvault**（纯二进制 archive）：

```
rawvault/
  books/
    2025/
      202501/
        Effective Modern C++.epub
        三体.epub
      202502/
        ...
    2026/
      202605/
        ...
```

- 每个文件直接挂在月份目录下，无包装目录、无附件。
- `<BookName>` 取自 calibre title 清洗结果（**不**是用户拖入时的原文件名）。清洗规则：trim、去文件系统非法字符（`/ : * ? " < > | \\`）、collapse 连续空白、超长截断到 80 字符（保留 CJK 完整字符不被腰斩）。title 缺失时回落到源文件名 stem。
- 时间分桶用 `YYYY/YYYYMM` 两层，分桶依据是**导入时间**（拖入并确认导入的时刻），不是 calibre 元数据里的 pubdate。未来归档操作可把当年的 YYYYMM 平铺到 `books/` 根、往年的下沉到 YYYY；扫描代码用"递归找文件"实现，兼容两种布局。
- rawvault 一次写入永不移动。规则变化与之无关。

**sotvault**（markdown + 元数据，按规则组织）：

```
sotvault/
  .exlibris/
    rules.yml                            ← 规则定义（git 同步）
  tech/                                  ← 规则计算出的目标
    Effective Modern C++/
      book.md                            ← calibre 转换产物
      meta.yml                           ← 元数据 + raw_path → 反向引用
  fiction/
    三体/
      book.md
      meta.yml
  uncategorized/                         ← 隐含的兜底规则
    ...
```

- `.exlibris/rules.yml` 是用户配置的规则列表，受 git 同步，多设备共享。
- `<rule>` 由规则匹配决定；匹配不上落入 `uncategorized/`。
- `<BookName>` 与 rawvault 中的 stem 相同；冲突时递增加 ` (2)`、` (3)`。
- `meta.yml` 是 canonical 元数据；含 `raw_path` 字段反向指向 rawvault。

### 共享 config

`~/Library/Application Support/com.laobu.mdeditor-shared/config.json`

```json
{
  "version": 1,
  "sotvault": "/Users/.../sotvault",
  "rawvault": "/Users/.../rawvault",
  "calibre_path": "/Applications/calibre.app/Contents/MacOS",
  "exlibris": {
    "import_concurrency": 2,
    "convert_timeout_seconds": 300,
    "last_used_rule_dirs": ["tech", "fiction", "uncategorized"]
  }
}
```

- 顶层字段是 mdeditor + ExLibris 共享。
- `exlibris.*` 是 ExLibris 私有（mdeditor 不读），物理上同文件以避免文件碎片化。
- 读写用 atomic write（`.tmp` + rename）防止崩溃留半文件；不引入文件锁（实际并发写入概率极低，atomic write 已足够）。

### `rules.yml` schema

```yaml
version: 1
rules:
  - id: r-tech
    name: "技术书"
    when:                              # 全部条件 AND；每个字段内部 OR
      ext: ["pdf", "epub"]
      tag_contains: ["计算机", "编程", "programming"]
      author_contains: []              # 缺省 = 不约束
      language: ["en", "zh"]
    target: "tech"
  - id: r-fiction
    name: "小说"
    when:
      tag_contains: ["novel", "小说"]
    target: "fiction"
```

- 规则按数组顺序匹配，第一条命中即用。
- 隐含的最末规则：`when: {}` → `target: "uncategorized"`，**不出现在 yaml 里、不可删**。
- 占位符（`{author}`、`{lang}`）作为 future work，v1 只支持纯字符串 target。
- 字段语义：
  - `ext`：源文件扩展名，小写。
  - `tag_contains`：calibre 元数据的 tags 数组中任一元素**子串**匹配数组中任一字符串。
  - `author_contains`：calibre `authors` 数组拼接后子串匹配。
  - `language`：calibre 元数据的 `language` 字段精确匹配（"en"、"zh"、"ja" 等）。

### `meta.yml` schema（每本书一份）

```yaml
schema_version: 1
title: "Effective Modern C++"
authors: ["Scott Meyers"]
publisher: "O'Reilly"
language: "en"
isbn: "9781491903995"
tags: ["计算机", "C++", "programming"]
pubdate: "2014-12-05"
description: |
  42 specific ways to improve your use of C++11 and C++14.
source_filename: "9781491903995.epub"                          # 用户拖入时的原始文件名
source_format: "epub"
source_sha256: "a1b2c3..."
raw_path: "books/2025/202501/Effective Modern C++.epub"        # 相对 rawvault 根
import_time: "2026-05-18T10:23:45+08:00"
calibre_version: "7.21.0"
applied_rule: "r-tech"                                          # 上次应用的规则 id
```

字段缺失时的默认值（v1 不做严格 schema validation，宽松解析）：
- `authors`、`tags` → `[]`
- `publisher`、`language`、`isbn`、`pubdate`、`description` → `null`
- `applied_rule` → `null`（视为 default uncategorized）

## Components

### ExLibris 仓库结构（新增）

```
exlibris/
  package.json                         ← 加入根 pnpm-workspace.yaml
  vite.config.ts
  tsconfig.json
  index.html
  src/                                 ← Svelte 前端
    App.svelte                         ← 主窗口
    main.ts
    components/
      OnboardingBanner.svelte
      DropZone.svelte
      PendingList.svelte
      LibraryBrowser.svelte
      MetaPreview.svelte
      SettingsDialog.svelte
      RulesEditor.svelte
      RebuildPanel.svelte
    lib/
      shared-config.ts
      rules.ts
      rules.test.ts
      import-pipeline.ts
      import-pipeline.test.ts
      calibre.ts
      sotvault-fs.ts
      rawvault-fs.ts
      bookname.ts
      bookname.test.ts
      meta.ts
      dedup.ts
      types.ts
    styles/
  src-tauri/                           ← Rust 后端
    Cargo.toml
    tauri.conf.json
    src/
      lib.rs                           ← Tauri 入口、命令注册
      shared_config.rs                 ← 读写 shared config（atomic）
      calibre.rs                       ← spawn ebook-meta / ebook-convert
      fs_ops.rs                        ← atomic copy / rename / 递归遍历
      hash.rs                          ← 流式 SHA256
    icons/
    tests/
      fixtures/
        ebook-meta-*.sh
        ebook-convert-*.sh
        samples/
```

### mdeditor 改动（最小化）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/lib.rs` | tray 菜单加 `Open Books`（启用）+ `Open Raw Vault Sync`（disabled，tooltip "Coming soon"），位置在 `Quit M↓` 之前；事件 `tray-open-books` 调 `Command::new("open").arg("-a").arg("ExLibris").status()` |
| `src-tauri/src/shared_config.rs` | NEW；与 ExLibris 的 `shared_config.rs` 是兄弟实现（暂复制粘贴；将来抽到 vaultgitsync crate 共享） |
| `src-tauri/src/lib.rs` / vault_sync | 启动时一次性迁移：现有 settings store 里的 `gitsync.repo` → shared config 的 `sotvault`（若 shared config 不存在或该字段为空）；幂等 |
| `src/components/VaultSettingsTab.svelte` | UI 不变；底层改读写 shared config 的 `sotvault` 字段（透过新的 Tauri command） |
| `vaultgitsync/` | 不动 |

### 顶层文件改动

| 文件 | 改动 |
|---|---|
| `pnpm-workspace.yaml` | 加入 `exlibris` |
| `package.json` | 加 script：`tauri:exlibris:dev`、`tauri:exlibris:build`（参考现有 `tauri:ios:*` 风格） |
| `scripts/build-exlibris.sh` | NEW；类比 `scripts/build-mdshare.sh`，封装 `tauri build` |
| `.github/workflows/release.yml`（如果有）| 加 ExLibris 的双 arch dmg 构建步骤；产物上传与 mdeditor 并列 |
| `README.md` | 顶部加一句指向 ExLibris 子项目；细节挪到 `exlibris/README.md` |

## Data flow — 导入状态机

```
                ┌──────────────────────┐
       (user drops 5 files into ExLibris window)
                          │
                          ▼
        ┌────────────────────────────────┐
        │ For each dropped file (parallel │
        │  bounded by import_concurrency) │
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │ 1. metadata-extract             │
        │   spawn ebook-meta <file>       │
        │   parse → title/authors/tags/   │
        │     isbn/language/...           │
        │   compute SHA256(file)          │
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │ 2. compute-bookname             │
        │   clean(title) or filename stem │
        │   resolve duplicate name suffix │
        │   against pending list          │
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │ 3. dedup-check                  │
        │   walk sotvault/**/meta.yml     │
        │   match on isbn || sha256       │
        │   status = "new" or "exists"    │
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │ 4. apply-rule                   │
        │   for each rule (in order)      │
        │     if all `when` conditions    │
        │        → target = rule.target   │
        │   fallback → "uncategorized"    │
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │ Entry appears in Pending List   │
        │ status: ready_for_review        │
        └────────────────────────────────┘
                          │
       ────────── user reviews / edits ──────────
                          │
                          ▼
        (user may: edit BookName, change target,
         skip individual rows, "select all" toggles)
                          │
                          ▼
                    user clicks "Import"
                          │
                          ▼
        ┌────────────────────────────────┐
        │ For each confirmed entry:       │
        │  (concurrency bounded again)    │
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │ 5. write-rawvault               │
        │   compute YYYYMM bucket         │
        │   atomic copy:                  │
        │     <src> → <raw>/<bucket>/     │
        │              <BookName>.<ext>   │
        │   verify SHA256 post-copy       │
        │   (overwrite collision → +" (2)")│
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │ 6. convert                      │
        │   spawn ebook-convert <src>     │
        │     <tmp>/book.md               │
        │   (timeout per-book = 5 min,    │
        │    configurable)                │
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │ 7. write-sotvault               │
        │   mkdir sotvault/<target>/      │
        │     <BookName>/                 │
        │   write book.md (from tmp)      │
        │   write meta.yml (serialize)    │
        │   (vaultgitsync watcher will    │
        │    pick up and stage/commit)    │
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │ status: imported / failed       │
        │ (failed row keeps stderr tail   │
        │  for "Show details")            │
        └────────────────────────────────┘
```

### 不变量

1. **写盘顺序固定**：先 rawvault（不可逆归档），再 sotvault（可重建展示层）。如果 rawvault 写完、sotvault 写失败 —— rawvault 里的孤儿可被 Verify 检测出来并提示用户单本重试 §6+§7。
2. **原子性**：每一步要么完成要么不留半成品。`copy → fsync → rename` 模式；任何中间步抛错都回滚已写入的临时文件。
3. **并发**：导入是 worker-pool，默认 2，设置可调到 1-8。calibre 转换 CPU 密集，多了反而慢。
4. **取消**：Cancel All 标记信号 —— 已 in-progress 的 calibre 子进程被 SIGTERM；rawvault 写一半的 `.tmp` 文件清理；sotvault 写一半的 book.md/meta.yml 删除；pending 直接丢弃。
5. **dedup 兜底**：第 5 步 write-rawvault 时若目标月份桶下已存在同名文件（dedup 漏判或并发场景），按 `BookName (2).ext` 自动加后缀；非错误。

## Rebuild & Verify

### Rebuild Sotvault（规则变化后应用）

```
1. 遍历 sotvault/**/meta.yml
   collect: [(current_path, meta, computed_new_target)]
2. compute diff: rows where current_path != new_target/BookName
3. show diff UI:
     "12 books will move:
        - tech/ → fiction/ (5 books)
        - uncategorized/ → tech/ (7 books)"
4. on user confirm:
   for each diff row:
     fs::rename(sotvault/<old_target>/<BookName>/, sotvault/<new_target>/<BookName>/)
5. update meta.yml's `applied_rule` field for moved books
```

**没有"从 rawvault 冷重建 sotvault"**。`book.md` 是分钟级产物，sotvault 受 git 保护就是其灾备机制。

### Verify

只读、不改任何东西，输出报告：

| 异常类型 | 检测方式 | 用户处理建议 |
|---|---|---|
| **Orphan raw**：rawvault 里的 binary 没有对应 meta.yml | 遍历 rawvault → 查 sotvault meta.yml 的 `raw_path` 引用 | 重新拖入纳入 sotvault |
| **Missing raw**：sotvault meta.yml 的 `raw_path` 在 rawvault 不存在 | 遍历 sotvault → stat rawvault | rawvault 未同步过来或被删；markdown 仍可用 |
| **Duplicate isbn**：同 ISBN 多次出现 | 遍历 → group by isbn | 列出冲突书让用户处理 |
| **Stale rule**：`applied_rule` 与当前规则计算结果不一致 | 同 rebuild diff | 提示 "12 本书的分类与当前规则不一致，是否 Rebuild？" |

## Onboarding flow

ExLibris 首次启动时，主窗口顶部出现向导 banner：

```
1) Sotvault：[未配置]     [选择...]   (若 mdeditor 已配置 → 自动继承)
2) Rawvault：[未配置]     [选择...]
3) calibre：[未检测到]    [选择...]   或访问 https://calibre-ebook.com
[Get Started] (3 项都有效后才可用)
```

- `sotvault` 优先从 shared config 读取（继承 mdeditor 的设置）；若空，要求用户选。
- `rawvault` 从 shared config 读取；若空，要求用户选；建议默认放在 `~/Documents/RawVault/`。
- `calibre_path` 探测顺序：shared config → `/Applications/calibre.app/Contents/MacOS/ebook-meta` → `$PATH` 里的 `ebook-meta`。
- 三项缺一不可拖入；缺 calibre 时主界面顶部红色 banner 提示，导入按钮 disabled，但浏览/规则编辑/rebuild 可用。

## Error handling

| 错误源头 | 检测时机 | 用户可见 | 后续可恢复 |
|---|---|---|---|
| **calibre 未配置 / 路径无效** | app 启动 + 每次拖入 | onboarding banner 红色；导入按钮 disabled | 配置后自动消除 |
| **拖入不支持的格式** | 拖入瞬间（扩展名白名单：epub/mobi/azw/azw3/pdf/fb2/lit/lrf/rtf/txt/docx） | 该文件红色出现在 Pending，"Unsupported"，灰显 | 移除即可 |
| **ebook-meta 失败 / 超时 / 无法解析** | §1 metadata-extract | 该行降级：title=源文件名 stem，authors=[]，tags=[]，黄色 ⚠️ "无元数据" | 用户改完照常导入 |
| **dedup 命中** | §3 | 状态 "Already imported"，默认不勾选 | 强制勾选可走重命名后缀路径 |
| **ebook-convert 超时（默认 5 分钟）** | §6 | 红色失败 "Conversion timed out (5m)"；stderr 末尾 1KB 可展开 | "Retry" 单独重跑 §6+§7（不重写 raw） |
| **ebook-convert 退出非 0** | §6 | 红色失败 "Conversion failed (exit N)" | 同上 |
| **磁盘空间不足 / 权限不足** | §5 或 §7 | 整批暂停 + 模态对话框；显示剩余 / 需要空间 | 清理或换路径后 Resume |
| **写盘冲突（dedup 漏判 / 并发）** | §5 / §7 | 自动 ` (2)` 后缀，不报错 | — |
| **共享 config 并发写冲突** | 任意写入 | 重试一次；还失败 toast"配置保存失败" | — |
| **sotvault 路径在导入中被外部修改/移走** | §7 | 失败 "Sotvault path no longer valid"；整批暂停 | 用户回设置确认 |
| **导入中改规则** | 任意阶段 | 已 in-progress batch 用 snapshot 规则不受影响；新拖入用新规则 | — |
| **正在导入时 quit ExLibris** | close 事件 | 拦截 → "有 N 本正在导入，确认中断？"；强制 quit → SIGTERM in-progress 子进程，清理半写文件 | 重启后 Pending 列表是空的，用户重新拖入 |

### 写盘不变量

1. **rawvault 永远是原子的**：`copy → fsync → rename`；崩溃只会看到完整文件或没有，不会有半截。
2. **sotvault 永远不会出现 "meta.yml 存在但 book.md 不存在"**：写盘顺序固定为先 book.md 再 meta.yml；任一失败回滚。
3. **rawvault → sotvault 引用单向**：只有 `meta.yml.raw_path` 指向 rawvault，rawvault 文件本身不知道任何 sotvault 信息。这让 rawvault 同步代码（后续 spec）不需要感知 sotvault。

### 日志

- ExLibris 运行日志 → `~/Library/Logs/com.laobu.exlibris/exlibris.log`，每行一条 JSON 事件（`import_started` / `import_failed` / `rule_applied` / `rebuild_started` / ...）
- 按日轮转，保留 7 天
- 不写日志到 sotvault（避免污染 git 历史）
- 不写日志到 rawvault（rawvault 严格只放二进制）

## UI 范围

ExLibris 主窗口包含：

- **拖放区** + **Pending 待导入列表**（导入核心）
- **Library Browser**：左侧 sidebar 显示按规则分类的树（=当前 sotvault 目录结构），中间是书列表，可搜索；点击单本显示 `MetaPreview`，含"在 mdeditor 中打开"链接
- **设置**：sotvault/rawvault/calibre 路径、并发数、转换超时、`RulesEditor`、Rebuild/Verify 工具页
- **不包含**：单本删除、单本重命名、单本 re-convert、手动覆盖单本目标分类（这些是 v2 候选）

## Distribution

- 顶层目录 `exlibris/`，加入根 `pnpm-workspace.yaml`。
- 共享 vaultgitsync rust crate 通过 path 依赖。
- 独立打包：`pnpm tauri:exlibris:build` → 出 aarch64 + x86_64 两份独立 `.dmg`（与 mdeditor 现有"per-arch dmg"约定一致）。
- 独立 updater（tauri-plugin-updater），独立版本号。bundle id `com.laobu.exlibris`。
- mdeditor 与 ExLibris 互不知道对方版本；mdeditor tray 的 "Open Books" 仅 `open -a ExLibris`，没装 ExLibris 时 `open` 命令失败 → toast "ExLibris not installed"。

## Testing

### 前端单元测试（Vitest）

| 模块 | 关键场景 |
|---|---|
| `bookname.ts` | title 清洗（FS 非法字符、空白合并、超长截断、CJK 不被误截、空 → fallback stem）；重名后缀 (2)/(3)/...；不同 stem 不冲突 |
| `rules.ts` | 单条件 / 多字段 AND / 字段内 OR / 首匹配 / 空 when match all / 隐式 default 末尾 / 占位符（future）/ diff 计算 |
| `dedup.ts` | ISBN 命中、SHA256 命中、两者都不命中；ISBN 空字符串跳过；同 ISBN 不同 SHA 仍命中；1000 本扫描 <500ms |
| `meta.ts` | YAML round-trip 保真；schema_version 兼容；缺字段默认值；非法 YAML 报错 |
| `shared-config.ts` | 读写 round-trip；atomic .tmp+rename；不存在返回默认 schema；version 预留升级路径 |
| `import-pipeline.ts` | 状态机所有 transition；metadata-extract 失败降级；dedup 命中 → exists；apply-rule fallback；取消信号 |
| Svelte 组件 | `OnboardingBanner` / `RulesEditor` 的 props/事件；不依赖文件系统 |

### Rust 单元测试（cargo test）

| 模块 | 关键场景 |
|---|---|
| `shared_config.rs` | 读写 round-trip；atomic write 在 fsync 之间 kill 不留半文件 |
| `calibre.rs` | spawn fake `ebook-meta` (shell fixture) → 解析 OPF；非法 XML 报错；hang → 超时 SIGTERM；stderr 16KB 截断 |
| `fs_ops.rs` | atomic copy 中断 → 目标不存在；目标存在 → 自动 (2)(3) 后缀；跨卷 fallback；rename 保留 mtime |
| `hash.rs` | 流式 SHA256 边界 / 100MB（sparse file）；与 `shasum -a 256` 一致 |

### Fixtures（`exlibris/src-tauri/tests/fixtures/`）

```
fixtures/
  ebook-meta-success.sh
  ebook-meta-no-title.sh
  ebook-meta-crash.sh
  ebook-meta-hang.sh
  ebook-convert-success.sh
  ebook-convert-slow.sh
  ebook-convert-crash.sh
  samples/
    pg11-alice.epub
    sample.pdf
```

### 集成测试（本地，CI 不跑）

| 测试 | 覆盖 |
|---|---|
| `e2e_import_real_epub` | 真实拖入 `pg11-alice.epub`，验证 raw + sot + meta |
| `e2e_rebuild_apply_rule` | import 10 本到 default → 改规则 → rebuild → 目录正确 |
| `e2e_dedup` | 同书拖两次，第二次命中 dedup |
| `e2e_verify_orphan_raw` | 手放 orphan，verify 报告正确 |

CI 不安装 calibre。集成测试只在探测到 calibre 时跑。

### mdeditor 侧测试

| 测试 | 覆盖 |
|---|---|
| `shared_config_migration.test` | `gitsync.repo` 迁移到 shared config；幂等 |
| `tray_menu.test`（Rust integration） | tray 含 `Open Books`（启用）和 `Open Raw Vault Sync`（disabled） |

### Manual smoke test

写入 `exlibris/README.md`：

1. 首次启动 → onboarding 三步齐全后才能拖入
2. 拖 epub → Pending → "Import" → raw + sot 各出现一份
3. 拖不支持的 `.png` / `.zip` → 红色 Unsupported；该行无法勾选
4. 大 PDF → 转换进度可见、可取消，取消后无残留
5. 拖同书两次 → 第二次显示 dedup
6. 改规则 → "Apply" → 看 diff → 确认 → 目录 mv 正确
7. 关闭同步、外部改 sotvault → Verify 报告 orphan / missing
8. 导入中 Quit ExLibris → 弹确认
9. mdeditor tray 点 "Open Books" → ExLibris 启动；"Open Raw Vault Sync" 灰显 tooltip

## Open questions（v1 内已解决）

- ❓ 规则要不要支持占位符（`{author}/{ext}/`）→ v1 不支持，纯字符串 target
- ❓ 多格式（同书的 epub + pdf）合并→ v1 看作两本不同的书
- ❓ 封面保存→ v1 不抽
- ❓ Index 文件→ 不需要，meta.yml 自描述足够

## Future work（不在 v1）

- rawvault 分布式同步（独立 spec；tray 占位项已就位）
- 单本操作（删除、re-convert、override target）
- 占位符规则 target（`{author}/{lang}/`）
- 多格式合并
- 封面、扉页保存
- 跨 vault 引用清单（哪些书在多个 sotvault 项目里被引用）
- iOS / Windows / Linux 支持
- ExLibris 自带 menubar tray icon（如需后台快速拖入）
- 历年归档操作（把过去年份的 YYYYMM 从 books/ 根下沉到 YYYY 子目录）

—

## Implementation roadmap (高层次)

1. **Phase 0**：mdeditor 侧改造 + shared config
   - 新增 `shared_config.rs` 与 Tauri command
   - VaultSettingsTab 透明改读 shared config（用户无感）
   - 启动迁移 `gitsync.repo` → shared config
   - tray 加 "Open Books" / "Open Raw Vault Sync"（前者目前 noop 即可）

2. **Phase 1**：ExLibris 脚手架
   - 新建 `exlibris/` 目录、tauri 工程、pnpm-workspace 接入
   - Onboarding + Settings UI（路径选择 + calibre 探测）
   - shared config 读写（兄弟实现）

3. **Phase 2**：导入核心
   - calibre.rs spawn + 状态机 §1–§4
   - PendingList UI + 单本 review/edit
   - 写盘 §5–§7
   - 取消、错误降级

4. **Phase 3**：规则与 rebuild
   - RulesEditor + rules.yml 读写
   - rebuild diff + apply
   - Verify

5. **Phase 4**：Library Browser
   - 按 sotvault 目录树展示
   - MetaPreview + "在 mdeditor 中打开"

6. **Phase 5**：打包发布
   - tauri build per-arch
   - dmg 签名 / 公证
   - updater 配置
   - mdeditor tray "Open Books" 接通

每个 phase 都可单独出 PR；Phase 0 是阻塞前置（其他 phase 都依赖 shared config）。
