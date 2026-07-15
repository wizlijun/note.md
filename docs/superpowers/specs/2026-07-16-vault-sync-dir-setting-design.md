# Vault 级目录设置(Sync 目录 + Wiki/Daily 目录)

日期:2026-07-16
分支:feat/base-plugin

## 背景

两类"vault 内约定目录"目前散在不同存储、且都不跟 git 走:

1. **Sync 目录**:vault 外的 md 在**分享**和**手动"同步到 Vault"**时被复制("归位")到的子目录。当前写死为 `const SYNC_SUBDIR = "Sync"`(`src-tauri/src/sotvault/mod.rs`),用户不可改。
2. **Wiki / Daily 目录**(sidecar/outline-notes 的 "Vault folders"):`wikipage` / `dailynote`,当前存 **app 级 Tauri store**(`outline.wikipageDir` / `outline.dailynoteDir`,`src/lib/outline/dirs.svelte.ts`),**不跟 git 走**,多设备不一致。

本设计把三者统一到一份 **vault 级、跟随 git 同步**的配置 `{vault}/.notemd/settings.json`,并新增 Sync 目录的可编辑 UI。

## 目标

1. `core` 设置页(桌面/iOS 都常显)新增 "Vault 目录" 小节:
   - 只读展示当前 vault 路径;
   - 可编辑的 Sync **相对路径**输入框,默认 `sync`,可保存,含一句用途说明。
2. 同步逻辑优先按用户配置的 Sync 目录归位。
3. Wiki / Daily 两个目录设置的**存储**改到同一份 vault 配置(UI 仍留在 outline-notes tab)。
4. 配置存 `{vault}/.notemd/settings.json`,随 git 同步(多设备/iOS 共用)。

## 决策(已与用户确认)

- Sync 默认目录名:`sync`(小写)。`SYNC_SUBDIR` 常量默认值由 `"Sync"` 改为 `"sync"`。
  - 副作用:从未配置过、又已有 `Sync/` 副本的老用户,新同步会落到 `sync/`(macOS 本地大小写不敏感,git 里会多一个目录)。用户接受此取舍。
- 改目录后:**只影响之后的新同步**。旧目录里的已有副本原地不动;追踪记录存绝对 `vault_path`,仍有效。不做移动/迁移。
- Wiki/Daily 默认仍是 `wikipage` / `dailynote`。老用户在 app store 里改过的值做**一次性透明迁移**(见下),不静默重置。

## UI 落点(依现有 tab 结构定)

- `VaultSettingsTab`(git 配置)**仅 iOS**,不适合放 Sync 目录 → Sync 目录 UI 放 **`core` tab**(两端常显)。
- Wiki/Daily 的输入框**留在 `outline-notes` 插件 tab** 的 "Vault folders" 小节,仅把读写改到 vault 配置命令。

## 组件

### 1. 配置文件 `{vault}/.notemd/settings.json`

vault 根下新建 `.notemd/` 目录,内含:

```json
{ "syncDir": "sync", "wikipageDir": "wikipage", "dailynoteDir": "dailynote" }
```

- 跟随 vault 走 git 同步。
- 与现有 folder-view 的 `.notemd.json`(每目录置顶、单文件)无关。
- 缺字段按各自默认解析;后端为准写入。

### 2. 后端(Rust,`sotvault/vault_settings.rs`)

- `VaultSettings { sync_dir, wikipage_dir, daily_note_dir }`(serde camelCase:`syncDir` / `wikipageDir` / `dailynoteDir`),各字段 `Option<String>`(缺失=None,不填默认)。
- `read(vault_root) -> VaultSettings`:读 `.notemd/settings.json`;文件缺失/损坏 → 全 None,不崩。
- `write(vault_root, &VaultSettings)`:写文件,自动建 `.notemd/`。
- `validate_rel_dir(raw) -> Result<String, String>`:trim;空 → Err;**拒绝绝对路径(前导 `/`)与含 `..` 段**;去尾部 `/`;允许相对多级(如 `Attachments/sync`)。
- `resolve_sync_dir(vault_root) -> String`:`read().sync_dir` 校验通过则用,否则默认 `sync`。
- `sotvault_sync_to_vault`:`vault_root.join("Sync")` → `vault_root.join(resolve_sync_dir(vault_root))`。
- 命令:
  - `notemd_vault_settings_get(app) -> VaultSettings`(原样返回 Option 三字段,不填默认;供前端解析+迁移)。
  - `notemd_vault_settings_set(app, sync_dir?, wikipage_dir?, daily_note_dir?) -> VaultSettings`:读现有 → 对每个 `Some` 字段校验后覆盖、其余保留 → 写回 → 返回合并结果(**部分更新,防互相覆盖**)。
- `SYNC_SUBDIR` 默认值改 `"sync"`。

### 3. 前端

- 新增 `src/lib/vault-settings.svelte.ts`:`vaultSettings` $state `{ syncDir, vaultPath, loaded }`;`loadVaultSettings()`(get + `sotvault_vault_root`)、`saveSyncDir(v)`(set 仅传 syncDir)。
- 改 `src/lib/outline/dirs.svelte.ts`:保持对外 API(`outlineDirs` / `DEFAULT_DIRS` / `normalizeDirName` / `loadOutlineDirs` / `setOutlineDir`)不变,内部改走命令:
  - `loadOutlineDirs`:调 `notemd_vault_settings_get`;字段解析顺序 `vaultVal ?? legacyAppStoreVal ?? DEFAULT`;若采用了 legacy 值(vault 缺该字段)→ write-through 到 vault 配置(一次性迁移)。
  - `setOutlineDir(kind, raw)`:normalize 后调 `notemd_vault_settings_set` 传对应字段。
  - 所有 `outlineDirs` 消费方(backlinks-io / daily / blocklist / roam-import)不改。

### 4. UI

- `core` tab(`SettingsDialog.svelte`)新增 "Vault 目录" 小节:当前 vault 路径(只读)+ Sync 相对路径(可编辑、默认 `sync`、保存按钮、用途说明);非法输入内联报错 + toast;vault 未配置时只读禁用。
- `outline-notes` tab 的 "Vault folders" 两输入框保留,读写已改到 vault 配置。
- i18n 走现有系统(en/zh/ja/de);复用/新增键。

## 数据流

- 保存 Sync:输入 → `notemd_vault_settings_set{syncDir}` → 后端校验 → 写 `.notemd/settings.json` → toast → 随 git 同步。
- 保存 Wiki/Daily:输入 → `setOutlineDir` → `notemd_vault_settings_set{对应字段}` → 同上。
- 同步:`sotvault_sync_to_vault` 每次读 `resolve_sync_dir` → `vault_root + syncDir` → 建目录 → 写副本。

## 错误处理

- vault 未配置:core 页 Sync 小节只读显示"未配置",输入/保存禁用。
- 非法路径(绝对/`..`/空):后端 `set` 对该字段返回错误,不落盘,前端 toast;其余字段不受影响。
- 配置缺失/损坏:后端 read 返回全 None;syncDir 回落默认 `sync`;前端 dirs 回落默认/legacy。`.notemd/` 首次写入时自动建。

## 测试

- Rust 单测(tempdir,仿 `logic.rs`):`validate_rel_dir` 接受相对/多级、拒 `..`/绝对/空;`read` 缺文件=全 None、损坏=全 None;`write`→`read` 往返;部分更新不清其他字段;`resolve_sync_dir` 缺配置=`sync`、有配置=配置值。
- 前端单测(mock invoke,仿 `sotvault.test.ts`):`vault-settings` load/save;`dirs` 的 legacy 迁移(vault 缺字段→用 app-store 值并 write-through)。
- 回归核查:默认 `"Sync"`→`"sync"` 不破坏现有断言(`logic.rs` 测试传字面量 `/v/Sync`,与常量无关)。

## 不做(YAGNI)

- 不迁移/移动旧 Sync 目录里的副本。
- 不做 per-folder 覆盖(vault 全局)。
- 不把 Wiki/Daily 输入框的 UI 也搬到 core tab(仅改存储)。

## 验证

UI 改动,须 dev 构建实机验证 `core` 页 Sync 小节的显示/保存、`outline-notes` 页两目录仍可读写(不做 UI 自动化,给手动测试步骤)。
