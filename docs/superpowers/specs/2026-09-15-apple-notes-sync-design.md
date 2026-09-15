# Apple Notes 单向同步

## 范围与契约

- 新增 `notemd.apple-notes` 原生插件，仅 macOS（Apple Silicon / Intel）。使用系统 Notes 脚本接口（JXA / Apple Events），不访问私有数据库。
- Apple Notes 是唯一来源。按账户 / 原有文件夹与子文件夹组织到 `Vault/applenotes/`。按用户补充要求，每篇正文命名为 `YYYY-MM-DD-HHMMSSZ-ID摘要-标题slug.md`，时间为创建时间 UTC，ID 摘要为来源 ID 的 SHA-256 前 16 位，标题 slug 保留中文；附件存入同级 `同名stem.attachments/`。YAML 标记 `readonly: true`，携带完整来源 ID、账户、目录、创建/修改时间。账户和文件夹带 ID 摘要，避免同名冲突。
- HTML 转 Markdown，保留接口可导出的附件。锁定笔记不要求解锁，不覆盖已同步正文；账户/笔记枚举或正文读取不完整时整批不提交。附件导出失败独立报告：仍提交正文及成功附件、保留同 ID 旧附件（若有），缺失资产显示占位，结果为不完整并返回非零退出码。接口不提供的智能文件夹规则等不虚构。
- 完整枚举成功后同步新增、内容修改、移动/改名和删除。控制状态放 `.notemd/apple-notes/`。仅修改本插件清单拥有的文件；删除副本可从该目录的回收区恢复。原子写文件，跨进程锁防止 UI、轮询和 cron 重叠。
- 插件界面提供立即同步、自动同步开关（默认关闭，用户开启后每 5 分钟同步）和上次结果。启用插件并开启自动同步后宿主启动恢复轮询。
- 提供 `notemd apple-notes-sync [--vault PATH] [--dry-run]` 插件命令及独立 `notemd-apple-notes sync --vault PATH [--dry-run]`，独立 CLI 可由 cron 执行且无需启动宿主窗口。JSON 结果和非零退出码表达失败/不完整。
- 首次使用需要 macOS Automation 授权；cron 必须在同一已登录用户会话、已授权环境执行。源端 iCloud 的刷新由 Notes 负责，插件同步本机接口可见的内容。

## 验证

1. 单元/集成测试：初次导入、重复同步不重写、内容修改、重名、重命名/移动、源端删除、空/失败/不完整快照、锁定、附件、路径与符号链接边界、并发锁、CLI JSON/退出码。
2. 插件 manifest、前端类型检查和构建，独立 Rust crate 测试；检查打包脚本收录及平台过滤。
3. macOS 实际脚本只读探测和临时 Vault 同步，验证笔记数量/组织/YAML、二次同步；如系统授权阻止，明确记录而不宣称通过。

## 接口依据

- 本机 `/System/Applications/Notes.app/Contents/Resources/Notes.sdef`。
- https://support.apple.com/en-au/guide/notes/-notc3b2d538b/mac
- https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AboutScriptingTerminology.html
