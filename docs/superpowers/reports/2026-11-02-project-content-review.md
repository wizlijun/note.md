# 全项目评审与公开内容一致性

日期：2026-11-02。审查基线：`main@711e42bd`。范围覆盖核心编辑/存储/分享/检索边界、插件清单与发布记录、README 中英文、FEATURES 中英文、网站四语 52 页、Agent 参考和语言目录。代码采用定向审查和自动化回归，并非逐行审计或完整安全审计。

本轮没有发布宿主、插件或网站，没有修改真实 Vault。原有 `CLAUDE.md`、README 和 llms 中的 agent playbook 修改及未跟踪的原则文档保留，不纳入本次提交。

## 仍需处理的发现

### P1：Health Sync 发布修复没有回到 main

`main` 中 Health Sync 仍为 0.2.0，而远端跟踪分支 `origin/release/health-sync-0.2.2` 保存 0.2.2 的源码和发布证据。冻结 tag `plugin-health-sync-v0.2.2` 指向 `caa7089ae285ba3f5f0dcf40dea38a200e7b69a9`，证据提交为 `0738da45`。本轮核对的是仓库中的 2026-10-30 发布记录，未重新访问生产市场。

- `plugins-src/health-sync/backend/src/auth.rs:769` 缺少 `stress`、`ring_configuration` OAuth scope，但 `oura.rs` 仍请求对应集合。
- `auth.rs:815` 及 UI 仍默认 `127.0.0.1` 回调；发布修复统一为 `localhost`。
- `oura_export.rs` 仍使用旧 CSV 解析，缺少发布分支针对真实 Oura DSR 分号 CSV、BOM、大文件和额外集合的修复。

影响：从 main 构建后续插件可能重新带入已修过的授权与导入问题。应独立回并并核对补丁等价、真实导出回归和打包输入；本次没有把功能修复混进文案修改。

### P1：本地 core 依赖不受宿主提交约束

`package.json` 使用 `file:../moraya-core`。本机兄弟仓库仍为 `f3c0808`，其 64 个 dist 文件与已安装依赖相同，但缺少宿主验收记录要求的复选框及删除选区修复。首次全量测试中，复选框 12 项、选区删除 5 项失败，分别重现其已有报告记录的旧行为。

为确认原因，在忽略的任务目录独立获取 `061143066af7c220e2799e6c63b6db7f66e4cb31`，核对其 tracked `dist/index.js` SHA-256 为 `464b3eafa9db040336e53b43946368ce2edfbd9a7931e5a8b9e5eadffa961b1e`，与既有选区验收报告一致。备份已安装 dist 后，只将这一份已核验产物用于本机测试；兄弟仓库工作区与分支未改。22 项相关回归及随后全量测试通过。

README 两语已说明拉取宿主不会更新兄弟依赖，并链接所需 core 提交的验收记录。仍需从依赖管理或发布输入门禁上约束 core 版本；单纯再次执行 `sync:core` 会把未更新兄弟仓库中的旧 dist 复制回来。

### P2：仓库与依赖许可证说明原本不一致

本仓库 `LICENSE` 为 Apache-2.0；实际安装及上述已核验 core 提交的 `package.json` / `LICENSE` 声明 `PolyForm-Internal-Use-1.0.0`。README 原先“与 @moraya/core 一致”的说法不成立。

本轮已修正两语 README、四语网站与 llms，明确 Apache-2.0 指本仓库、依赖遵循各自许可，没有修改 LICENSE。这是对文件声明的核对，不是对分发权限的法律判断；未开展完整安装包依赖许可审计。

## 已完成的内容修正

| 问题 | 修正 |
| --- | --- |
| README/主页停留在不同版本，9 月能力仍称“最近发布”，固定下载体积 | 删除过期快照，使用稳定能力描述及发布记录入口 |
| Linux 被写成 Debian/Omarchy 共用 `.deb` | 明确 Arch `.pkg.tar.zst` 与 Debian `.deb`、两架构、beta 与包管理器边界 |
| Mermaid 渲染器描述未更新 | 明确默认 Pele、Mermaid 语法兼容说明及构建选择 |
| “没有数据库/隐藏状态”“全部文件均 OKF” | 区分笔记、Memory 修订、派生索引、插件持久库和原始附件 |
| 大纲不能进 Source、批注不改变源文件 | 按当前实现说明 Source 模式和行内批注写入/sidecar 镜像 |
| 所有 Wiki 链接统一全库解析 | 明确大纲走全库索引，普通 Markdown 相对当前文件解析 |
| 路径/行号引用在重命名后永久有效 | 明确后续查询使用新路径，已保存的引用需要重新解析 |
| Base 被列为市场插件、插件版本过期、PDF 快捷键不实 | Base 归为内置视图；删除易过期版本快照；PDF 标注可选 macOS 插件 |
| 核心四语被泛化到全部插件 | 明确插件语言覆盖各异；修 Health manifest 日德文 SQLite 描述 |
| 第三方价格和能力断言 | 删除过期固定价格，保留官方入口与有明确核验日期的比较资料 |

保留仍有效的大纲、Source、批注问答、知识浏览、Memory 双投影、受控共写等能力。没有删除历史 changelog 或发布证据，也没有因文案过期而擅自移除产品功能。

## 测试与脚本修正

已单独提交 `3a78fb47`：

- 分享测试把到期时间固定为 2026-11-01，却使用真实时钟，导致 11 月 2 日起 40 项失败。现在只冻结测试 Date，结束时恢复，并新增两个真实到期边界回归；不改生产的到期拒绝逻辑。
- 发布脚本的安装说明在本机 macOS Bash 3.2 中导致 heredoc 解析失败。调整一句文案后，`bash -n scripts/release.sh` 及两架构安装说明测试通过。
- Linux Tauri schema 测试曾依赖已有 `dist/`；现在使用隔离的最小网页 fixture，仍验证实际平台配置和非法字段拒绝。

## 验证结果

- 宿主、脚本、网站测试：**412 文件，5346 项全部通过**。使用上文核验的 core dist，`PATH` 包含 Rust 工具链，Node 26 运行时设 `NODE_OPTIONS=--no-experimental-webstorage`，避免其 Web Storage 全局与 DOM 测试环境冲突。
- 网站：**134 项通过**，包含在临时目录重新生成 52 页并逐字比对、四语 canonical/hreflang、导航、下载选择和过期文案回归。
- Health UI：**102 项通过**；Rust：**154 项通过、2 项人工测试忽略**。最初受网络限制缺少依赖，补齐锁定依赖后成功重跑。这里验证的是 main 的实现，并未将 0.2.2 已发布修复回并。
- NEXT：**45 文件、841 项通过**，使用同一 Node Web Storage 兼容设置。
- README/FEATURES 相对链接、两语章节结构、JSON manifest、changelog 检查通过。
- `bash -n`、本轮提交差异空白检查通过。原有中文 README 的 Markdown 换行空格不纳入本次修改。

全量日志仍有既有 Svelte 编译警告及 DOM 测试加载本地 CSS 的网络警告，测试退出码为 0；没有将警告表述为实机验证通过。未做 WKWebView、Windows/Linux 桌面实机验收、真实健康账号同步或全量 Rust 工作区测试。

本地日志、原有修改快照、core 校验输入和 dist 备份保存在忽略目录 `tasks/content-review-2026-11-02/`。最终全量成功日志为 `verified-project-tests.log`；`project-tests.log` 和 `final-project-tests.log` 保留修复前及依赖对齐前的失败证据。独立验证另存为 `website-tests.log`、`next-tests.log`、`health-ui-tests.log` 和 `health-rust-tests.log`。后续发布仍须按正常流程核对冻结源码与安装包，文档提交本身不证明已部署。
