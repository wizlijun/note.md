# Apple Notes 同步（仅 macOS）

通过 macOS 自带 Notes 的 JXA / Apple Events 接口，将所有账户中的可见笔记单向同步到当前 Vault 的 `applenotes/`。支持手动同步、宿主运行期间每 5 分钟自动同步和独立 cron CLI。不会修改 Apple Notes。

## 文件组织

保留 Apple Notes 的账户、文件夹和子文件夹层级。每个名称附带来源 ID 摘要，避免重名冲突；笔记文件名包含创建时间、稳定身份和标题：

```text
applenotes/
  iCloud--<account-id>/
    工作--<folder-id>/
      2026-09-15-083000Z-<note-id>-会议记录.md
      2026-09-15-083000Z-<note-id>-会议记录.attachments/
        截图--<attachment-id>.png
```

时间为创建时间的 UTC（`Z`），不会随着修改改变；ID 为完整 Apple ID 的 SHA-256 前 16 位；slug 保留中文，英文转小写，用连字符分隔。完整 ID 和原始标题保存在 YAML。修改标题、移动笔记时更新路径及附件链接。

```yaml
type: Note
readonly: true
source: apple-notes
apple_notes_id: x-coredata://…/ICNote/p123
title: 会议记录
account: iCloud
account_id: …
folders: [工作]
folder_ids: […]
created: '2026-09-15T08:30:00.000Z'
modified: '2026-09-15T09:00:00.000Z'
locked: false
```

本次宿主改动会让 `readonly: true` 的 Markdown 在 Rich、Source 和 YAML 属性区只读，并阻止保存、另存和历史覆盖。外部同步仍可刷新内容。请在 Apple Notes 中编辑原件。

## 使用与权限

1. 从源码安装开发插件：`bash scripts/dev-install-plugin.sh apple-notes`。插件需要同时包含 UI 和当前 macOS 架构的二进制。
2. 在插件菜单打开「同步 Apple Notes」，点击立即同步。首次运行允许 macOS 的「自动化 → Notes」授权。本次宿主已加入 Automation entitlement 与用途说明；需要使用包含这些改动的宿主构建，旧签名安装包可能无法提示授权。
3. 按需开启「每 5 分钟自动同步」。默认关闭；开启后立即同步，后续在应用运行期间定时同步，并在下次启动恢复。系统睡眠或未登录时不保证执行。

Notes 的 iCloud 下载由系统 Notes 完成；同步依据本机接口当前可见内容，不会强制刷新 iCloud，也不读取 Notes 私有数据库。

## CLI 与 cron

已安装插件时，可由宿主 CLI 使用当前配置的 Vault，或显式指定：

```sh
notemd --json apple-notes-sync --vault /absolute/path/to/vault
notemd --json apple-notes-sync --vault /absolute/path/to/vault --dry-run
```

独立二进制无需启动 note.md，适合 cron。构建后先在已登录用户终端交互运行一次，确认 Notes 自动化权限：

```sh
cargo build --release --manifest-path plugins-src/apple-notes/backend/Cargo.toml
/absolute/path/notemd-apple-notes sync --vault /absolute/path/to/vault
/absolute/path/notemd-apple-notes sync --vault /absolute/path/to/vault --dry-run
```

示例 crontab（替换二进制、Vault 与日志绝对路径）：

```cron
*/5 * * * * "/absolute/path/notemd-apple-notes" sync --vault "/absolute/path/to/vault" >> "/absolute/path/apple-notes-sync.log" 2>&1
```

cron 必须使用可访问 Notes 的同一登录用户。macOS 的授权可能按调用程序归因；若 cron 报自动化拒绝，需在系统设置授权实际调用程序，并确认该用户图形会话已登录。插件不自动修改 crontab。

独立 CLI 标准输出为 JSON。退出码：`0` 完整成功；`4` 不完整（锁定/附件不可导出等，详见 report）；`1` 同步失败；`2` 参数错误。`--dry-run` 读取 Notes 并把附件暂存到系统临时目录以计算变化，但不改 Vault。重复运行不会重写内容未变的镜像文件。

## 删除、恢复与失败

- 只有笔记枚举和正文完整、且读取前后身份/修改时间/目录稳定的快照才会提交。权限拒绝、超时、枚举期间变动不会触发删除。
- 某个账户整体不可见时保留旧副本并报警；不会把退出账户误当作批量删笔记。
- 系统公开接口中的笔记消失后，对应的受管理文件会移入 `.notemd/apple-notes/trash/<transaction>/<note-id-hash>/`；更新替换的旧文件也保存在这里，可手动复制到其他目录恢复。回收区不会自动清空。
- 控制清单与恢复 journal 位于 `.notemd/apple-notes/`。跨进程文件锁防止 UI、后台与 cron 同时写入。中断后下次正式同步先重放 journal。
- 仅改动清单拥有的文件；本地修改会报冲突，未受管理的相邻文件保持原样。请先把本地改动移到其他目录或还原副本，再重试。
- 锁定笔记保留已有正文；首次遇到时创建带元数据的占位文件。需在 Notes 解锁后再同步。
- 公开接口可能无法导出某些附件。仍保留正文、可导出的文件和 URL；不可导出的资产显示占位、保留同 ID 已有附件并在 report 中列明。实机遇到 Notes `-10000` 的附件，不能宣称全保真备份。
- 智能文件夹的查询规则、置顶、标签数据库、协作历史及删除状态未由本机 Notes 脚本字典提供，不会虚构映射；以原始容器层级和 API 返回的可见笔记为准。Markdown 对 Notes 特有排版也不保证无损。

## 验证

```sh
cargo test --manifest-path plugins-src/apple-notes/backend/Cargo.toml
pnpm --dir plugins-src/apple-notes check
pnpm --dir plugins-src/apple-notes build
```

接口依据：[Apple 的账户/文件夹说明](https://support.apple.com/en-au/guide/notes/-notc3b2d538b/mac)、[Apple 的脚本字典说明](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AboutScriptingTerminology.html)，以及本机 `/System/Applications/Notes.app/Contents/Resources/Notes.sdef`。
