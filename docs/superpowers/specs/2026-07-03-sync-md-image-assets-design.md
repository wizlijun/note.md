# 同步 md 到 Vault 时打包引用图片资源

**日期:** 2026-07-03
**状态:** 已确认设计,待实现

## 背景与问题

`sotvault_sync_to_vault`(`src-tauri/src/sotvault/mod.rs`)把当前 md 文件复制到
`{vault}/Sync/{日期前缀-文件名}`,文件名冲突时用 `dedup_target` 追加 `-2`/`-3`。

它**只复制 md 本身**,完全不处理 md 里引用的本地图片。因此:

- 本应用粘贴/拖入的图片存于 md 同级 `{文件名}_files/`(`paste-resources.ts` 的
  `filesDir`);外部导入的 md 常引用 `assets/`、`images/` 等目录。
- 同步后这些图片不在 Vault 里,md 中的图片链接在 Vault 侧全是断链。

## 目标

同步 md 时,扫描其引用的本地图片,一并复制进 Vault,并把图片放入一个
**当前 md 专属的唯一目录**,避免与 Vault 里其他 md 的资源冲突。

## 已确认的设计决策

| 决策点 | 选择 |
|--------|------|
| 资源范围 | **仅图片**(按 `IMAGE_EXTENSIONS` 扩展名匹配) |
| 路径形式 | **仅相对路径**(相对源 md 目录);http/https 外链与绝对路径跳过 |
| Vault 资源目录命名 | **跟随 md 最终名 `.assets`**,如 `2026-07-03-notes.assets/` |
| 更新时行为 | **重新扫描并同步图片**(见「更新流程」) |
| 图片引用语法 | v1 仅行内 `![alt](相对路径.png)`(不含 HTML `<img>`、引用式 `![][id]`) |
| 「只改图片不改正文」 | 接受为已知限制,不重搬(见「已知限制」) |

## 架构

所有逻辑放在 **Rust 端 `sotvault` 模块**,理由:

1. 资源目录名要跟随 md 在 Vault 里的**最终文件名**(经日期前缀 + `dedup_target`
   去重后才确定),该最终名只有 Rust 里才知道。
2. 复制 md 字节的动作本就在 `sotvault_sync_to_vault`(Rust),一并处理最原子。
3. 前端 `syncCurrentToVault()`(`src/lib/sotvault.svelte.ts`)调用签名不变,无需改动。

纯逻辑抽到 `sotvault/logic.rs`(带单元测试),文件 IO 留在 `mod.rs`。

## 组件

### `logic.rs` 新增纯函数

```
/// 资源目录名 = "{stem}.assets"
fn assets_dir_name(stem: &str) -> String

/// 一次复制操作:源绝对路径 -> assets 目录内的相对文件名
struct CopyOp { src_abs: PathBuf, dest_filename: String }

/// 一处已规划的引用改写。仅在其对应 CopyOp 复制成功后才由 mod.rs 应用。
struct PlannedRef { original: String, rewritten: String, dest_filename: String }

/// 扫描 md 中相对路径的图片引用,规划复制清单与改写清单。纯函数,注入
/// exists 便于测试。改写不在此应用——见「失败一致性」。
/// - source_dir: 源 md 所在目录(解析相对路径的基准)
/// - stem:       Vault md 去重后的文件名主干(用于生成 "{stem}.assets/xxx")
/// - exists:     判断源图片是否存在(注入)
/// 返回:(改写清单, 复制清单)
fn plan_image_assets(
    md: &str,
    source_dir: &Path,
    stem: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> (Vec<PlannedRef>, Vec<CopyOp>)
```

`plan_image_assets` 的职责:

1. 用正则找出行内图片 `![alt](path)`(处理可选 `"title"` 与 `<path>` 尖括号形式)。
2. 过滤:仅保留**相对路径**且扩展名属于 `IMAGE_EXTENSIONS` 的引用;跳过
   `http://`、`https://`、`/` 开头的绝对路径、`data:` 等。
3. 对每个引用:相对 `source_dir` 解析出源绝对路径;`exists` 为真才纳入。
4. 在 assets 目录内按 basename 去重:两个不同来源的同名 `img.png` →
   `img.png` / `img-2.png`(复用 `dedup_target` 的 `-N` 规则)。
5. 生成复制清单;把每个原始引用改写为 `{stem}.assets/{dest_filename}`。
6. 同一源绝对路径被多次引用时,只复制一次,所有引用改写为同一目标名。

`IMAGE_EXTENSIONS` 目前定义在 TS(`paste-resources.ts`)。Rust 侧新增一份等价常量
(png/jpg/jpeg/gif/svg/webp/bmp/ico/tiff/tif/avif),就近放在 `logic.rs`。

### `mod.rs` 改造 `sotvault_sync_to_vault`

```
1. 读取源 md 字节 -> src_bytes;src_md = String::from_utf8(src_bytes)。
   非 UTF-8(理论上 md 不会)-> 按现状仅复制字节,不做资源处理。
2. 照旧算出去重后的 Vault 目标路径 target,取 stem = target 文件名去扩展名。
3. source_dir = source 的父目录。
4. (planned_refs, copy_ops) = plan_image_assets(&src_md, source_dir, stem, &|p| p.exists())
5. 若 copy_ops 非空:
   - 创建 {subdir}/{stem}.assets/
   - 逐个 CopyOp 复制,收集复制成功的 dest_filename 集合;单个复制失败 -> 记
     warn 并跳过。
   - 仅对复制成功者(dest_filename 命中成功集合)应用 planned_ref 改写:
     vault_md = src_md,依次 vault_md.replace(original, rewritten)。失败图片的
     引用保持原样(仍指向源相对路径),避免断链。见「失败一致性」。
   - 写入 vault_md 到 target。
   否则:写入 src_bytes 到 target(与现状完全一致)。
6. Record:
   - source_hash = sha256(src_bytes)          // 源原文
   - vault_hash  = sha256(写入 target 的字节)   // 改写版 or 原文
```

**失败一致性:** `plan_image_assets` 依据 `exists` 决定是否改写引用;`exists` 为真才
改写并加入 `copy_ops`。实际复制阶段极小概率失败(权限等)。为保持「md 引用」与
「实际文件」一致,复制阶段对失败的 `CopyOp` 需回退其改写:实现上让 `mod.rs` 先执行
复制、收集成功集合,再对成功集合调用一个纯改写函数生成最终 `vault_md`。即把「改写」
延后到「复制成功」之后。据此调整 `plan_image_assets` 返回结构为:

- `plan_image_assets(...) -> (Vec<PlannedRef>, Vec<CopyOp>)`,其中 `PlannedRef`
  含 `{ original: String, rewritten: String, dest_filename: String }`;
- `mod.rs` 复制成功后,仅对成功者做 `md.replace(original, rewritten)`。

这样断链风险最小:复制失败的图片,其 md 引用保持原样(仍指向源相对路径)。

### `mod.rs` 改造 `sotvault_apply_update`

源 md 文本变化触发 `OriginUpdated` 后调用:

```
1. 读源 md -> src_bytes / src_md。
2. stem 从 rec.vault_path 文件名取(去扩展名)。
3. source_dir 从 rec.source_path 的父目录取。
4. 复用同一 plan + 复制 + 改写流程,写入 rec.vault_path。
   assets 目录同名覆盖(不删除孤儿)。
5. 刷新:source_hash = sha256(src_bytes),vault_hash = sha256(写入字节),
   synced_at = now。
6. 返回写入 vault 的内容字符串(改写版),供 reloadTabFromDisk 重载标签页。
```

## 数据流

```
syncCurrentToVault() [TS, 不变]
  └─ invoke('sotvault_sync_to_vault', { srcPath, datePrefix })
       └─ [Rust] 读源 md
          → 算 target/stem (dedup_target)
          → plan_image_assets(md, source_dir, stem, exists)
          → 创建 {stem}.assets/,复制成功的图片
          → 对复制成功者改写 md 引用 → vault_md
          → 写 vault_md 到 target
          → upsert Record(source_hash=源原文, vault_hash=改写版)
```

## 唯一性如何保证

Vault md 文件名已被 `dedup_target` 保证在 `Sync/` 内唯一(冲突追加 `-N`)。
资源目录名 `{stem}.assets` 直接派生自该唯一 stem,故资源目录也天然唯一——
无需额外去重逻辑。这正是「把 assets 目录改为当前 md 专属目录」的实现方式:

- `2026-07-03-notes.md`  → `2026-07-03-notes.assets/`
- 若首名被占,md 变 `2026-07-03-notes-2.md` → `2026-07-03-notes-2.assets/`

## 兼容性

- md 不含任何相对路径图片时,`copy_ops` 为空,行为与当前完全一致:不建目录、
  不改写、`source_hash == vault_hash`(与历史 Record 一致)。
- 已有 Record 不受影响:仅在下一次 sync/update 时才可能出现 `source_hash !=
  vault_hash`,而 `decide_update` 分别比较源侧与 Vault 侧,逻辑天然成立。

## 已知限制(v1 明确不做)

1. **更新触发以 md 正文为准**:只改图片、md 文本没变时,`decide_update` 判
   `UpToDate`,不会自动重搬图片。已接受为限制。
2. **不清理孤儿图片**:重新同步只增量覆盖,不删除已不再引用的旧图(交给 git 历史)。
3. **不处理**引用式链接 `![][id]`、HTML `<img src>`、绝对路径引用、percent-encoded
   路径的完整还原。v1 仅行内 `![](相对路径.png)`。

## 测试

`logic.rs` 单元测试(纯函数,注入 `exists`):

- 无图片 → 原样返回,复制清单为空。
- 单张相对图片 → 改写为 `{stem}.assets/x.png`,清单含 1 项。
- 跳过 http/https、绝对路径、非图片扩展名的引用。
- 两处不同来源同名 `img.png` → 去重成 `img.png` / `img-2.png`,两处引用各指其一。
- 同一图片被引用两次 → 只复制一次,两处引用同名。
- `![](assets/x.png "标题")`、`![](<assets/x.png>)` 形式正确解析。
- `exists` 为假的引用 → 不纳入清单、不改写。
- `assets_dir_name("2026-07-03-notes")` == `"2026-07-03-notes.assets"`。

`mod.rs` 复制/失败回退可用现有 `TempDir` 模式加集成测试(可选)。
