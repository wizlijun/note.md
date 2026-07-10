# AGENTS.md 一等公民 — tray 编辑入口 + CLAUDE.md 自动镜像 — Design

## 目标

把 vault 根目录的 `AGENTS.md` 提升为一等公民：

1. **tray 编辑入口**：系统托盘菜单新增「Edit AGENTS.md…」，一键在主窗口打开
   vault 根的 `AGENTS.md`；不存在则用内置模板自动创建。
2. **单向镜像**：`AGENTS.md` 是真相源，任何修改（应用内保存或外部工具改动）
   自动整文件复制为同目录 `CLAUDE.md`。
3. **偏离提醒**：`CLAUDE.md` 被单独修改（与 `AGENTS.md` 不一致）时弹原生
   对话框，让用户二选一：合回 AGENTS.md，或用 AGENTS.md 覆盖。

## 决策记录

| 问题 | 决定 |
|---|---|
| 同步范围 | 仅 vault 根目录一对文件（不递归子目录） |
| 修改来源 | Rust 侧文件监听，覆盖外部修改（Claude Code 直接写 CLAUDE.md 的场景） |
| CLAUDE.md 偏离处置 | 原生对话框二选一：合回 / 覆盖 |
| AGENTS.md 不存在 | 点菜单时用内置英文模板创建并同时镜像出 CLAUDE.md |
| 与 git 同步的关系 | 解耦：vault 路径已配置即生效，不依赖 vault_sync 是否 running |

## 架构

新建独立 Rust 模块 `src-tauri/src/agents_sync/`，与 `vault_sync` 平级：

- **watcher**：notify 非递归监听 vault 根目录，只处理文件名为
  `AGENTS.md` / `CLAUDE.md` 的事件，500ms 防抖合并。
  不复用 `vault_sync/watcher.rs`——那个 watcher 生命周期绑在 git 同步
  running 状态上，且通道只发 `()` 信号不带路径。
- **基线状态**：持久化上次同步成功时两文件的内容 hash 到 app 配置目录
  （`agents_sync.json`：`{ agents_hash, claude_hash }`）。启动时先跑一次
  判定，能发现应用离线期间的改动。
- **启动时机**：`agents_sync::init(app)` 在 vault 路径已配置时启动 watcher
  并跑首次判定；vault 路径变更（tray 重新选文件夹）时重启 watcher。

## 判定逻辑（纯函数，可单测）

输入：两文件当前内容 hash + 基线 hash。三态判定：

| AGENTS 变 | CLAUDE 变 | 动作 |
|---|---|---|
| ✓ | ✗ | 复制 AGENTS.md → CLAUDE.md，刷新基线 |
| ✗ | ✓ | 内容与 AGENTS.md 一致 → 只刷新基线；不一致 → 弹冲突对话框 |
| ✓ | ✓ | 内容一致（如 git pull 拉下同步好的两份）→ 只刷新基线；不一致 → 弹冲突对话框（不静默覆盖，防丢外部写入的内容） |
| ✗ | ✗ | 无动作 |

边界：

- `CLAUDE.md` 不存在而 `AGENTS.md` 存在 → 视为「AGENTS 变」，直接镜像。
- `AGENTS.md` 不存在 → 不做任何事（不反向生成，避免把外部工具生成的
  CLAUDE.md 意外提升为真相源）。
- **自写抑制**：镜像/覆盖写入后立即把新 hash 记入基线；watcher 事件到来时
  hash 与基线相同则忽略，杜绝回环触发。
- **弹窗防抖**：冲突对话框弹出期间挂起事件处理；对话框有结果后再跑一次
  判定，避免连环弹窗。

## 冲突对话框

tauri-plugin-dialog 原生弹窗：

- 文案（随 UI locale 三语）：「CLAUDE.md 已被修改，与 AGENTS.md 不一致。」
- 按钮 1「合回 AGENTS.md」：整文件复制 CLAUDE.md → AGENTS.md，
  CLAUDE.md 内容成为新真相。
- 按钮 2「用 AGENTS.md 覆盖」：整文件复制 AGENTS.md → CLAUDE.md。
- 两个方向都是整文件复制，不做文本合并。

## Tray 菜单

`build_tray_menu`（`src-tauri/src/lib.rs`）Vault 区块新增
`tray-edit-agents` 项，label key `tray.editAgents`
（en「Edit AGENTS.md…」/ zh「编辑 AGENTS.md…」/ ja「AGENTS.md を編集…」）。

点击行为：

1. vault 未配置 → 走现有 `pick_sync_folder` 流程提示先选文件夹。
2. `{vault}/AGENTS.md` 不存在 → 写入内置模板，并同时镜像出 CLAUDE.md、
   记基线。
3. `show_main_window` + `emit_open_file_delayed` 在主窗口打开 AGENTS.md。

## 内置模板

打包资源 `src-tauri/templates/AGENTS.md`，Rust `include_str!` 嵌入。
英文内容，与 outline-note spec（2026-07-10-outline-note-base-design.md）
的目录约定一致：

```markdown
# AGENTS.md

Guidance for AI agents working in this vault. This file is the source of
truth; CLAUDE.md is an auto-generated copy — edit AGENTS.md only.

## Vault layout

- `dailynote/` — daily outline notes, organized as
  `yyyy/yyyy-MM-dd.note.md` (e.g. `2026/2026-07-10.note.md`).
  Monthly and yearly summaries live in the same year folder as
  `yyyy-MM.note.md` and `yyyy.note.md`.
- `wikipage/` — default home of global wikilink pages. Each page is an
  outline note named `title.note.md`, created when a `[[title]]` link is
  first resolved.
- `sync/` — markdown documents copied in from outside the vault (the
  editor's sync-to-vault feature). Each file is a snapshot of an external
  original; edits here do not flow back to the source file.
- Any other folder — regular markdown documents (`xxx.md`), optionally
  with a companion outline note beside them (see below).

## The `.note.md` suffix

- A file ending in `.note.md` is an **outline note**: a bullet-list
  outline with per-node metadata, edited in a dedicated outline view.
- **Companion rule:** if `xxx.note.md` sits next to `xxx.md` in the same
  folder, the two are companions — the `.note.md` holds outline
  annotations for the main document. Treat them as a pair:
  - Do not edit, rename, move, or delete one without the other.
  - Do not "fix" the outline structure of a `.note.md` file; its format
    is managed by the editor.

## House rules

- (Add your own project conventions below.)
```

注：`wikipage` / `dailynote` 目录名全局可配置（outline spec），但模板按
默认字面值书写；用户改过目录名后可自行编辑 AGENTS.md，本功能不做动态生成。

## 测试

- 单测（Rust）：三态判定纯函数——hash 基线组合 × 一致/不一致 × 文件缺失
  边界；自写抑制（写后事件被忽略）。
- dev 实机验证（按惯例，GUI 改动发布前必做）：tray 菜单项出现且三语正确；
  点击创建模板并打开；外部改 AGENTS.md 后 CLAUDE.md 跟进；外部改
  CLAUDE.md 后弹窗且两个按钮行为正确。

## 不做的事（YAGNI）

- 不递归子目录、不支持多对 AGENTS/CLAUDE。
- 不做文本级 merge，只整文件复制。
- 不监听 GEMINI.md 等其他 agent 说明文件。
- 不在 AGENTS.md 缺失时反向从 CLAUDE.md 生成。
