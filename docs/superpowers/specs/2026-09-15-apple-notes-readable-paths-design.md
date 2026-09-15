# Apple Notes 可读路径与集中 ID 映射

日期：2026-09-15

## 目标

Apple Notes 仍是唯一来源，`Vault/applenotes/` 仍是只读镜像。用户日常浏览的账户目录、文件夹目录、笔记名、附件名和笔记 YAML 不再暴露 Apple Core Data ID 或其哈希；同步所需的稳定身份统一放在 `Vault/applenotes/id-sync.json`。

## 用户可见布局

```text
applenotes/
  id-sync.json
  iCloud/
    工作/
      2026-09-15-会议记录.md
      2026-09-15-会议记录.attachments/
        截图.png
```

- 日期取 Apple Notes 创建时间的 UTC 日期，只保留 `YYYY-MM-DD`。
- 标题 slug 保留中文；拉丁字母小写；非法字符与连续分隔符归一为 `-`。
- 空账户、文件夹、标题或附件名使用 `Untitled` / `untitled` / `attachment`。
- 同一父目录的等价名称使用稳定的 `-2`、`-3` 后缀。等价比较至少覆盖大小写与 Unicode 规范化；不会因为源端枚举顺序、较早对象删除或新对象加入而重排既有后缀。
- `applenotes/id-sync.json` 是根目录保留名。任何账户或其他目标与其发生大小写/Unicode 等价冲突时必须使用序号，不得覆盖 descriptor。

笔记 YAML 只保留可读来源信息：

```yaml
type: Note
readonly: true
source: apple-notes
title: 会议记录
account: iCloud
folders: [工作]
created: '2026-09-15T08:30:00.000Z'
modified: '2026-09-15T09:00:00.000Z'
locked: false
```

不再写入 `apple_notes_id`、`account_id` 或 `folder_ids`。

## `id-sync.json` 契约

version 2 descriptor 是唯一长期 ID 映射，采用确定性、格式化 JSON：

```json
{
  "version": 2,
  "source": "apple-notes",
  "sync_state": {
    "auto_sync": false,
    "last_finished": 1789440000,
    "report": null,
    "error": null
  },
  "accounts": {
    "<account-id>": { "name": "iCloud", "path": "applenotes/iCloud" }
  },
  "folders": {
    "<folder-id>": {
      "account_id": "<account-id>",
      "parent_id": null,
      "name": "工作",
      "path": "applenotes/iCloud/工作"
    }
  },
  "notes": {
    "<note-id>": {
      "account_id": "<account-id>",
      "folder_ids": ["<folder-id>"],
      "title": "会议记录",
      "created_at": "2026-09-15T08:30:00.000Z",
      "modified_at": "2026-09-15T09:00:00.000Z",
      "locked": false,
      "path": "applenotes/iCloud/工作/2026-09-15-会议记录.md",
      "files": {
        "2026-09-15-会议记录.md": "<content-sha256>",
        "2026-09-15-会议记录.attachments/截图.png": "<attachment-sha256>"
      },
      "attachments": {
        "<attachment-id>": {
          "name": "截图.png",
          "path": "applenotes/iCloud/工作/2026-09-15-会议记录.attachments/截图.png",
          "sha256": "<content-hash-or-null>"
        }
      },
      "legacy_attachments": {}
    }
  }
}
```

- 内容 SHA-256 用于本地改动保护，不是来源身份。
- `files` 的键相对该笔记的父目录；附件映射中的 `path` 是完整 Vault 相对路径。
- 无事务时省略 `pending`；存在事务时它包含操作清单和下一版 descriptor。
- URL、正文占位或暂时无法导出的附件仍以完整 attachment ID 建项，`path` / `sha256` 可为空。
- version 1 只保存过附件 ID 的 16 位哈希。当前快照能提供完整 ID 时立即补齐；锁定笔记或不可见账户无法补齐时，暂存在 `legacy_attachment_fingerprints`，后续可见时再收敛。该过渡身份也只能存在于 `id-sync.json`。
- descriptor 损坏、缺失必需映射或与旧状态冲突时 fail closed；不能从无 ID 文件名猜测来源身份。
- descriptor 缺失时，同步根目录内单独的 macOS `.DS_Store` 可忽略；其他任何未知项均视为可能的用户数据并 fail closed。预检失败时不得为记录错误而创建空 descriptor；只有已存在的可验证 descriptor 才能接收持久化报告。
- `sync_state` 与身份映射共存，是自动同步开关、上次完成时间、最近报告和错误的唯一持久来源。缺省值可省略。

## 路径分配

路径必须在任何写入前完成全局预分配：

1. 为当前 descriptor 中仍同名、同父级的对象优先保留已分配组件。
2. 收集当前同步批次所有账户、文件夹、笔记与附件目标，按来源 ID 仅作为确定性 tie-breaker 分配空闲序号；ID 不进入路径。
3. 保留未管理的磁盘邻居，目标冲突时分配下一个可读序号；符号链接继续拒绝。
4. 标题或容器改名时重新分配可读路径；同一身份通过 descriptor 识别为移动，不生成第二份。
5. 附件导出失败时按 attachment ID 从 descriptor 读取旧路径和字节，不再反查文件名中的 ID 哈希。

## 迁移与事务

- 跨进程锁继续使用 `.notemd/apple-notes/sync.lock`。
- 启动时先重放旧 `.notemd/apple-notes/pending.json`，再读取旧 `.notemd/apple-notes/state.json`。即使源内容没有变化，version 1 → 2 的路径、YAML 和 descriptor 迁移也必须执行。
- 新事务不再创建含 Ledger 的 `pending.json`。`id-sync.json.pending` 同时保存无 ID 的文件操作与待提交的下一份映射，确保所有来源 ID 只出现在同一 JSON。
- 提交顺序：原子写入带 pending 的 descriptor → 全局校验并备份所有旧文件 → 安装所有新文件 → 原子写入完成态 descriptor。先备份、后安装才能安全处理 A ↔ B 或更长的改名循环。
- staging 与新 trash 路径只用随机事务名和操作序号，不使用来源 ID 或其哈希。历史 trash 是恢复档案，不主动删除或重写；从 v1 迁移时归档的旧 Markdown 可能保留当时 YAML 中的 ID，但同步器不再以其作为映射来源，Agent 与用户日常浏览均不应读取该恢复区。
- 迁移成功后，旧 state 写为不含 ID 的 version 2 tombstone。旧版二进制因此明确拒绝，而不会把 Vault 当作首次同步、重新生成带 ID 路径。
- macOS Application Support 中的旧 `plugin_data/notemd.apple-notes/state.json` 不再是状态源。当 Vault descriptor 存在且尚无 `sync_state` 时，其内容一次性迁入 descriptor 后删除；若 `applenotes/` 已被删除，视为用户明确重置，只删除旧全局文件而不恢复历史。
- dry-run 不写 descriptor、tombstone、文件或控制状态。

## 安全与失败边界

- 只迁移旧 ledger 拥有且内容哈希仍匹配的文件；本地改动继续阻断同步。
- 锁定笔记、账户暂不可见、附件暂不可导出时保留旧正文和资产，同时仍可迁移其可验证的旧布局。
- warning、staging、trash 和日志不再用完整来源 ID 定位；用户可在 `id-sync.json` 查映射。
- 现有恢复语义保持：中断可重放、已替换/删除内容可从 trash 恢复、未管理相邻文件不被删除。
- `id-sync.json` 不算一篇笔记，不带 YAML，也不能成为普通笔记或附件操作的目标。

## 验证

- 全新同步：同名账户、同级文件夹、同日同标题笔记、同名附件、大小写与 Unicode 等价名称。
- 稳定性：枚举重排、删除第一项、再新增对象后既有路径不变；第二次同步不重写。
- 迁移：真实 version 1 布局、旧 pending、锁定笔记、不可见账户、不可导出附件和 legacy 指纹补齐。
- 事务：备份后、安装中、descriptor 最终提交前中断；A ↔ B 与三项循环改名。
- 保护：本地修改、未管理文件、符号链接、路径穿越、descriptor 损坏/缺失。
- 输出：现役 `applenotes/` 路径与 Markdown YAML 不含生成的 ID；全部账户、文件夹、笔记和附件身份可在唯一 descriptor 中找到。
- 插件 Rust/UI/协议/生产构建，以及 macOS 临时 Vault 首次同步、version 1 迁移和二次幂等实测。
