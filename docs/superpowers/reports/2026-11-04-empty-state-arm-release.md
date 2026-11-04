# v6.1104.2 空白页艺术排版发布

已公开 [v6.1104.2](https://github.com/wizlijun/note.md/releases/tag/v6.1104.2)，仅 macOS Apple Silicon。空白窗口新增灰色大主版本号、note.md 字标及完整版本，版本自动读取发布输入；保留新建、画布和打开入口，并适配深浅主题及小窗口。

## 冻结来源与范围

- 实现：`7e61af4c`；发布 tag：`eb79c419d8fd0dcc676076c28f1849ed634ff7e4`。
- 官网：`48e33457137e7fc4f8e00425eedbbe2598c7f094`；Deploy website `41811485144` 成功。
- 内核：`061143066af7c220e2799e6c63b6db7f66e4cb31`，workspace 与安装依赖的 64 份 dist 文件逐字一致。
- 发布前唯一 main/worktree，无未提交、未跟踪、未合入分支或 stash。冻结 tag 的 EmptyState 与已验收实现逐字一致，双语本版日志含对应条目；前版 MCP/Rich 修复继续保留。
- 原有双语各 19 条待发布内容曾精确移到受控 pending，现原文恢复到 Unreleased；不宣称这些独立插件随本次宿主发布。

## 验证结果

全量前端 5,357 测试通过；类型检查 0 errors / 31 既有 warnings；协议产物、依赖高危门禁、原生 canvas 和 mobile_project_config 检查通过。官网 142 测试通过。

实际组件 Chrome 验收覆盖浅色/深色、900×600、280×540、200×540、700×220 内容区及键盘按钮路径。实际签名候选在 macOS WKWebView 验证启动海报、完整 v6.1104.2、右侧面板下布局、最小 600×400 窗口、新建与关闭返回、装饰区双击新建、原生打开对话框和取消。未改变系统主题；原生验证为本机浅色，深色证据来自实际组件浏览器验收。

原生 UI 使用已签名候选副本，之后核对其二进制与最终公证构建、DMG 和 updater 内二进制一致：

`9953a66700d56d28b519f284d4f68fc7f257fe64c6a80755ee2b0354192845ea`

原生新建入口已会立即在 Vault inbox 落盘；本轮误按旧的未保存 tab 语义测试，生成两份空白笔记。发现后停止创建，依据精确路径、创建时间、77 字节空正文和哈希归档移出 Vault 至任务目录，原有同名序列文件未动。未编辑用户已有文档；原安装程序与原空白/右侧手记窗口已恢复，未覆盖安装。清理证据为 `ui/generated-note-cleanup.json`，后续原生新建测试须先隔离 Vault。

App 公证 `19bce5a9-b01d-4932-98a7-27a84675fdba`、DMG 公证 `fe6d2038-1522-4fc4-b617-54a5c6aadb6f` 均 Accepted；staple、Gatekeeper、arm64 架构、权限及更新签名检查通过。

## 传输恢复与公开

原 release.sh 内首次签名时间戳失败、首次 DMG 上传 RequestTimeout，均由既有自动重试恢复；未改公证路线、未使用预备的尾段恢复、未重构建已验收输入。完整构建、签名、公证、包内比较、commit/tag/push 均完成，但最后 GitHub 并行资产上传 HTTP 408，使原脚本真实退出 1；此退出码保持原样。

先核实草稿仅有清单/签名，再固定源码、原日志与四份资产哈希，按同一 GitHub Release Assets API 补传缺失文件：DMG 使用 gh HTTP/1.1；updater 在停顿/408 后使用 curl HTTP/1.1 有界重试，最终 HTTP 201。未覆盖已就绪资产，未修改包字节。四份远端 API SHA-256 均与本地冻结产物一致，候选验证通过后，原 release-publish.sh 以已授权的 mac-arm64-only 范围公开，退出 0。

公开后四资产分别经普通/绕缓存请求完整回读，共八份逐字一致，latest endpoint 与 minisign 验签通过，仅包含 darwin-aarch64：

- DMG SHA-256：`6305281d7ec3d4c733fca5dea2632eb2720f1d363dd448474ef6910d9790e969`
- Updater SHA-256：`a7a9d480f0394cda1184e588ed31125c38b0ea857e7a35265bf73c29b9cd2b47`

官网首次 push 遇 GitHub 500，确认远端仍为旧 HEAD 后安全重试成功。四语页面与 ARM 下载入口在普通/绕缓存请求下均通过，版本及页面字节对应官网提交。其他平台未发布；本轮部分既有下载入口回退到发布列表，不声明全平台下载矩阵稳定通过。

全部本地证据位于 `tasks/empty-state-release-20261104/`：`audit.json`、`candidate-verification.json`、`ui/ui-verification.json`、`upload-recovery-result.json`、`host-public/public-review.json`、`website-verification.json` 与 `pending-restored.json`。
