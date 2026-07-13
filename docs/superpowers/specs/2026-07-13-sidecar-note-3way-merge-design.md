# 伴生笔记的三方合并同步 (Sidecar Note 3-Way Merge)

Date: 2026-07-13
Status: Design approved, pending implementation

## 问题

sotvault 的"sync to vault"在把当前 md 复制进 Vault 时,会连带同步其伴生笔记
(`foo.note.md`,内部 id `outline-notes`,用户可见名"伴生笔记")。当前实现
`src-tauri/src/sotvault/mod.rs::sync_companion_note()` 用 `std::fs::copy()`
**无条件覆盖**目标侧的伴生笔记:

- 没有任何 hash 比对、没有冲突检测;
- `Record`(`store.rs`)只记账正文的 `source_hash` / `vault_hash`,**伴生笔记
  连 hash 都没记账**,更没有"上次同步"的共同祖先。

伴生笔记是用户严肃手写的笔记层。Vault 通过 git 跨设备/Obsidian 同步:设备 B 编辑
的笔记经 git 到达设备 A 的 Vault,而设备 A 本地也改了源笔记;此时设备 A 的
sync-to-vault 会用本地源笔记盲目覆盖 Vault 侧,**丢掉设备 B 的改动**。反方向
(`sotvault_apply_update`,Vault→源)同样盲目覆盖,会丢掉本地手写笔记。

## 目标

把伴生笔记的同步从"盲目 copy"改为 **git 风格的三方合并**:

1. 能自动合并的非冲突改动,自动合并;
2. 冲突的行写入 `<<<<<<< / ======= / >>>>>>>` 标记,留给用户在编辑器解决;
3. 任何冲突都额外把合并前两侧原文各存一份 `.conflict.<时间戳>` 备份,**零丢失**;
4. **双向**保护:`sync_to_vault`(源→Vault)与 `apply_update`(Vault→源)都受保护。

正文 md 的同步逻辑不变(它已有 `decide_update` 的 hash 冲突检测与用户提示)。本设计
只改伴生笔记这条支流。

## 非目标 (YAGNI)

- 不改正文 md 的冲突流程。
- 不做交互式逐块合并 UI(冲突标记 + 备份已足够)。
- 不做伴生笔记的独立冲突提示对话框;最多一个轻量 toast(可选)。

## 合并引擎选型

> **修订(2026-07-13,写计划时):** 原拟用 `git2::merge_file`,但核实 git2 0.19 的
> **安全 API 并未暴露** `merge_file`(仅底层 `libgit2-sys` 有 `git_merge_file` FFI)。
> 用它需写 unsafe FFI,不划算。改用纯 Rust 的 **`diffy`**。

使用 **`diffy` crate(0.5.0)**:

```rust
// 干净合并 → Ok(merged);有冲突 → Err(带冲突标记的 merged)
diffy::MergeOptions::new()
    .set_conflict_style(diffy::ConflictStyle::Merge) // 经典三标记(无 base 段),便于手工解决
    .merge(ancestor, ours, theirs) -> Result<String, String>
```

- `Ok`/`Err` 直接区分"是否冲突",无需额外判定;
- 冲突标记为标准 `<<<<<<< ours` / `=======` / `>>>>>>> theirs`(diffy 不支持自定义
  标签,ours=本地源笔记、theirs=Vault 笔记,用户可理解);
- 纯 Rust、安全、无 FFI;新增一个小依赖,远优于 unsafe FFI。

被否决的备选:`git2::merge_file`(安全 API 不可用)、`libgit2-sys` 裸 FFI(unsafe、冗长)、
libgit2 完整 index merge(对单文件过重)。

## 存储改动

`Record`(`src-tauri/src/sotvault/store.rs`)新增字段:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub vault_path: String,
    pub source_path: String,
    pub synced_at: u64,
    pub source_hash: String,
    pub vault_hash: String,
    #[serde(default)]
    pub note_merge_base: Option<String>, // 上次收敛后的伴生笔记内容 = 三方合并的共同祖先
}
```

> 命名说明:叫 `note_merge_base` 而非 `note_base`,以免与已有
> `2026-07-10-outline-note-base-design.md`(那里的 "base" 指 `.note.md` 的**基础功能**)
> 概念混淆——本字段是**三方合并的共同祖先内容**,两者无关。

- `#[serde(default)]` 保证旧 `sotvault-sync.json` 照常反序列化(缺失 = `None`,
  走"无 base 迁移"分支)。
- base 存**内容**而非 hash——三方合并需要真正的祖先文本。伴生笔记体量小,存 JSON 可接受。
- `store.rs` 中 `find_by_*` / `upsert` / `remove` 逻辑不变;测试里构造 `Record` 的
  helper 需补 `note_merge_base: None`。

## 核心:reconcile 决策

新增一个**纯函数**(仿 `logic::decide_update` 风格,可全分支单测),再套一层 io wrapper。

### 输入
`base: Option<&str>`(旧 `note_merge_base`)、`source: Option<&str>`(源笔记内容,None=文件不存在)、
`vault: Option<&str>`(Vault 笔记内容,None=文件不存在)。

### 决策表

| 情况 | 动作 | 新 base |
|---|---|---|
| source、vault 都无 | 无 | 不变 |
| 仅 source 有 | 写 source→vault(首次同步) | source |
| 仅 vault 有 | 写 vault→source(把远端笔记拉到本地) | vault |
| source == vault | 无需写(已收敛) | source |
| source 改、vault == base | 快进:source→vault | source |
| vault 改、source == base | 快进:vault→source | vault |
| **source、vault 都 != base(有 base)** | `merge(base, source, vault)`,结果写**两侧** | 合并结果 M |
| source、vault 都有但**无 base**(迁移) | 保守当冲突:`merge("", source, vault)`,结果写两侧 | M |

产出一个描述"要写哪些文件、是否冲突、新 base"的结果结构(纯数据),由 io wrapper 落盘。

### 关键约束:合并结果写入两侧收敛

冲突/合并的产物 M 必须**同时写回源笔记与 Vault 笔记**(git 式收敛),并把 base 更新为 M。
否则源侧保留自己的旧版本,下次同步时会把"远端独有的行"当成"本地删除",再次把它合掉——
造成重复丢失。快进分支同理:被快进的一侧要写成另一侧内容。

### 零丢失兜底

当判定为冲突(`!automergeable()`,或"无 base 且 source != vault"的迁移分支)时,
除了把带标记的 M 写入两侧,还要把**合并前的 source 原文与 vault 原文各写一份**
`<笔记 stem>.conflict.<时间戳>.note.md`,放在各自目录旁。即使用户后续误删标记,原始两版
永远留存。时间戳格式复用现有 `.conflict.<ts>` 惯例(见 `vault_sync/conflict.rs`)。

## 接线

替换 `sync_companion_note(source, target)` 为 reconcile 流程,两个命令共用:

- `sotvault_sync_to_vault`:在写正文前/后,从**当前** store 里按目标 `vault_path`
  (或 `source_path`)取旧 `note_merge_base` → 调 reconcile(方向无关,双向都判)→ 得到新 base;
  最终 `upsert` 的 `Record` 带上新 `note_merge_base`。(该命令原本只在末尾 `load_store`,需提前到
  取 base 的时机;注意路径 dedup 后 vault 笔记名随 target stem 变化,复用
  `logic::companion_note_name()` 推导两侧笔记文件名。)
- `sotvault_apply_update`:同样取旧 base → reconcile → 写回新 base。
- reconcile 返回"是否产生冲突标记";命令结果可把该布尔带给前端。

### 可选:轻量提示

前端在 `sync` / `applyUpdate` 拿到"发生冲突"标志后,弹一个 toast:
"伴生笔记有冲突,已插入冲突标记并备份 .conflict"。非必需,锦上添花。

## 打开中的笔记竞态

若 reconcile 写回源笔记(或 Vault 笔记)时,该笔记正在"伴生笔记"面板 / tab 中打开:
复用现有外部变更检测(`file-watcher.svelte.ts` / `external-state.ts`)——干净则自动重载为
合并结果,脏则出横幅。这与正文 md 被 `apply_update` 写回是同一套机制。伴生笔记面板
(OutlineEditor `flushDisk` / `note-writeback-io`)需确保能感知磁盘变更并重载;具体接线
留给实现计划核对。`.conflict` 备份保证即便竞态处理不完美也不丢数据。

## 测试

仿现有 `logic.rs` 的 pure-function + io-wrapper 风格:

1. **纯决策函数**单测:覆盖决策表每一行(都无 / 仅一侧 / 相等 / 两个快进方向 /
   有 base 双改自动合 / 有 base 双改冲突 / 无 base 迁移)。
2. **io 集成测试**(tempdir):
   - 首次同步复制笔记(现有 `companion_note_synced_with_renamed_target` 演进);
   - 缺失源笔记 no-op(现有 `companion_note_missing_is_a_noop` 保留);
   - 双改可自动合并 → 两侧收敛为合并结果、base 更新、无 `.conflict`;
   - 双改冲突 → 两侧含标记、生成两份 `.conflict.<ts>`、base = 带标记的 M;
   - 无 base 迁移 + 分叉 → 冲突分支;
   - 快进两方向各写对侧。
3. 若加了 `note_merge_base` 字段:`store.rs` 的 round-trip 测试确认旧 JSON(无该字段)
   反序列化为 `None`。

## 受影响文件

- `src-tauri/src/sotvault/store.rs` — `Record` 加 `note_merge_base`。
- `src-tauri/src/sotvault/logic.rs` — 新增 reconcile 纯决策 + `merge_file` 封装。
- `src-tauri/src/sotvault/mod.rs` — 用 reconcile 替换 `sync_companion_note`;两个命令
  取/存 `note_merge_base`。
- (可选)前端 `src/lib/sotvault.svelte.ts` — 冲突 toast。
