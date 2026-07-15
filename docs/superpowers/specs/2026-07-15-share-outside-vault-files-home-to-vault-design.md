# 分享 vault 外文件 → 强制同步进 vault，分享副本

日期：2026-07-15
状态：已确认，待实施

## 背景与问题

分享（share/publish）时向服务端发送的 `src` 由 `vaultRelativeSrc(tab.filePath, vaultRoot)` 计算：
- vault 内 → vault 相对路径（如 `notes/foo.md`），其他机器可解析。
- vault 外 → **绝对路径**（`/elsewhere/x.md`），映射成 `abs:` 键，是**设备本地**的，其他机器找不到源 md。

目标：分享 vault 外文件时，强制把一份副本同步进 `{vault}/Sync/`（沿用现有 sotvault 同步逻辑），实际分享 vault 副本。这样所有分享文件都在 vault 下，显示/缓存只需列 vault 相对路径。

## 现状事实

- 分享入口 `src/lib/share/index.ts::sharePublishCurrent`；`src` 计算点在第 93 行。
- `sotvault_sync_to_vault`（`src-tauri/src/sotvault/mod.rs:199`）把源文件复制到 `{vault}/Sync/{dated-basename}`，含图片打包（`{stem}.assets/`）与伴生笔记 3-way merge；**每次都 `dedup_target` 生成新副本**（`foo-2.md`…），对同一源不复用。命令**从磁盘读源文件**。
- `SotRecord`（TS，snake_case）：`vault_path` / `source_path`。判定工具：`isUnder(path, root)`、`isSyncedSource`、`find_by_source`（Rust）。
- 可复用 TS：`openFile`、`saveActive`、`closeTab`（`tabs.svelte.ts`）；`sourceCreationYmd`（`sotvault.svelte.ts` 私有）。
- 决策：① 同步后**切换 tab 到 vault 副本**；② **无 vault 时阻止并提示**。

## 设计

### 1. 分享流程（`share/index.ts::sharePublishCurrent`，仅非图片分支）

在 bake html 之前插入归位逻辑：

1. `root = sotvaultStore.vaultRoot`；`outside = !root || !isUnder(tab.filePath, root)`。
2. 若 `outside`：
   - `!root` → `reportError(new ShareError('vault_required'), ...)` 并 return。
   - 若 tab 脏 → `await saveActive()`（命令从磁盘读源，须先落盘）。
   - `const vaultPath = await ensureVaultCopyForShare(tab.filePath)`。
   - 记住源 tab id → `await openFile(vaultPath)`（切到副本）→ `await closeTab(sourceId)`（已存盘不脏，不弹窗）。
   - `filePath = vaultPath`。
3. 用当前（副本）active tab bake html，`publishHtml({ path: filePath, filename: basename(filePath), html, src: vaultRelativeSrc(filePath, root), ... })`。
   - 此时 `src = "Sync/yyyy-MM-dd-foo.md"`、record 键 = 副本路径 → 其他机器 `resolveSrc` → `rel:` 键，落在 vault 下。

图片分享（`tab.kind === 'image'`）维持原样。

### 2. Rust：`sotvault_sync_to_vault` 增参 `reuse_existing: Option<bool>`

- 抽纯函数（`logic.rs`）：
  ```rust
  pub fn sync_target(existing: Option<PathBuf>, subdir: &Path, basename: &str,
                     exists: &dyn Fn(&Path) -> bool) -> PathBuf {
      match existing {
          Some(p) if exists(&p) => p,
          _ => dedup_target(subdir, basename, exists),
      }
  }
  ```
- 命令内：先 `load_store` 一次；`existing = reuse_existing.unwrap_or(false)` 时 `s.find_by_source(&src).map(|r| PathBuf::from(&r.vault_path))` 否则 `None`；`target = logic::sync_target(existing, &subdir, &basename, &|p| p.exists())`。
- 其余不变：`upsert` 按 `vault_path` 原地替换；`find_by_vault(target)` 取回 `note_merge_base` 保持伴生笔记 merge base 连续。
- 旧调用方（手动同步 `syncCurrentToVault`）不传参 → `None` → 行为不变。

### 3. TS：`sotvault.svelte.ts` 导出 `ensureVaultCopyForShare`

```ts
/** Ensure an OUTSIDE-vault file has a copy inside the vault, reusing the existing
 *  tracked copy for this source. Returns the vault copy's absolute path.
 *  Caller guarantees a vault is configured and the path is outside it. */
export async function ensureVaultCopyForShare(sourcePath: string): Promise<string> {
  const datePrefix = await sourceCreationYmd(sourcePath)
  const rec = await invoke<SotRecord>('sotvault_sync_to_vault', {
    srcPath: sourcePath, datePrefix, reuseExisting: true,
  })
  await refreshSotvault()
  return rec.vault_path
}
```

### 4. 错误 / i18n

- `ShareErrorKind` 增 `'vault_required'`（`types.ts`）。
- `SHARE_ERROR_KEYS['vault_required'] = 'share.err.vault_required'`。
- i18n 新键 `share.err.vault_required`：en「Configure a Vault before sharing files that live outside it.」；zh「分享 vault 外的文件前，请先配置 Vault。」

## 测试

- Rust：`logic.rs` 加 `sync_target` 单测——`existing` 存在且文件在 → 复用；`existing` 为 None 或文件不在 → 走 `dedup_target`。
- 分享编排为 invoke 胶水，纯判定（`isUnder`/`isSyncedSource`）已有覆盖；胶水靠 `svelte-check` + 用户实机验证。

## 手动验证（用户执行）

1. 打开一个 vault 外的 .md，分享 → `{vault}/Sync/` 出现日期前缀副本；当前 tab 切到副本；剪贴板 URL 可访问。
2. 对同一外部文件再次分享 → 不产生 `-2` 副本，更新原副本与原分享。
3. 未配置 vault 时分享外部文件 → 被阻止并提示先配置 Vault。
4. vault 内文件分享 → 行为不变。

## 非目标

- 图片分享不变。
- 不迁移历史已分享的外部文件（下次再分享才归位）。
- 不改服务端 / 受众采集格式。
