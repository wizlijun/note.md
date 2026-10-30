# Quick Launch 1.0.0 与 Apple Silicon 宿主 6.1030.1 发布记录

> 插件市场、仅 Apple Silicon 的配套宿主和官网均已公开；源码、签名、公证及普通/绕缓存完整公网回读均已通过。随附[机器可读发布证据](2026-10-30-quick-launch-release-evidence.json)。

## 发布内容与范围

Quick Launch / 快捷启动归属「体验增强」。用户可从「插件 → 体验增强 → 配置快捷启动…」管理最多 20 个应用或 CLI 启动项，保存后在托盘「启动」子菜单生效。默认 cmd1 为「屏幕重连」，目标 `uc reconnect`；cmd2 留空且停用。支持更名、启停、排序、增删；有未保存修改时不能运行。配置只保存在本机，不写 Vault，不注册全局快捷键。

插件依赖宿主新增 `host.quickLaunch.get/save/run`，最低宿主 `>=6.1030.1`。旧公开宿主 6.1028.1 没有这些接口，因此用户授权继续发布配套 Apple Silicon 宿主。本轮只发布 macOS ARM64 宿主与 Quick Launch；没有发布 Intel、Windows、Linux 宿主或其他插件，没有安装至正式 note.md，没有执行真实 `uc reconnect`。

## 源码、版本和冻结证据

| 对象 | 冻结引用 / 提交 |
| --- | --- |
| 原始功能提交、插件包来源 | `9a19aee266246a5a5a8874fc6ee90556376fc6c3` |
| 插件 tag | `plugin-quick-launch-v1.0.0`，已推送；剥离后指向 `9a19aee266246a5a5a8874fc6ee90556376fc6c3` |
| 宿主集成基线 | `6a8db1caed1c552345162ffbda98d76dc389aa6f` |
| 精确移植功能提交 | `5f7c27262cd291faa0e256b298f1d2ac813d7745` |
| 发布日志范围隔离 | `ab848e9e36ce2a4462f83809a8efd0d5a97f38bb` |
| 宿主 tag / 发布提交 | `v6.1030.1` → `c16055c394642c8cd93769f829f19428c0a17ff7` |
| 官网源码更新 | `09ba842485bb67cb8160456ff6bc50e075926f07`；官网 CI 与公网核验通过 |

`integration-proof.json` 对原提交与移植提交逐文件核对补丁、变化行与文件摘要；`host-source-proof.json` 从冻结宿主 tag 回读实际快捷启动源码及生产 manifest，并记录实际 ARM64 二进制摘要。插件 UI 与宿主冻结源码中对应文件一致，不以任务记录或版本号代替源码核对。

本轮使用最新远端 main 做隔离集成，保留已公开 NEXT 1.13.2、Agent 等远端功能。开始时已审计 1 个 worktree、本地分支未合入提交、17 个 tracked 修改、9 个展开后的 untracked 文件及 3 个 stash；既有 NEXT/Agent 并行修改、Agency/Habitat 文件及独立 Health Sync 发布内容全部排除。对已 cherry-pick 的 NEXT 提交按补丁等价与冻结版本实际功能核对，没有整分支合入旧本地历史。详见 `scope-audit.md`、`scope-audit.json`。发布后 20 项核查全部通过；原工作区 17 个 tracked 修改、9 个 untracked 文件、HEAD 和 3 个 stash 均与开始审计一致。证据为 `post-release-scope-and-source-proof.json`。

`ab848e9e` 暂存的其他 Unreleased 条目没有作为本版发布内容；已在 `564d444e` 原样恢复双语日志，两段与保存副本逐字一致，该提交已推送。

## 插件包与市场发布

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `universal.notemdpkg` | 7076 bytes | `55a4c4a870c6ce0f5b4d7d1c36257751439ddc85807b736760ca7bc12937d522` |
| `universal.notemdpkg.minisig` | 314 bytes | `90d30f597325c32c4bc0cea36c72d99c598c8e7c0a6b72bd18109c6d6636ebbc` |

包由冻结源码使用仓库既有 `release-plugins.sh` 构建和签名；包内 manifest 的版本为 1.0.0，宿主门槛为 `>=6.1030.1`。签名验证通过，解包每个文件与签名 ZIP 内字节一致；实际已打包 JavaScript 重新执行 9 项 UI 行为测试全部通过，涵盖默认值、显式保存、失败保留编辑、排序增删、应用选择、执行进度/失败、读错误及数量上限。详见 `package-proof.json`、`package-ui-results.json`、`plugin-helper-validation.json`。

市场发布始终使用项目现有 Wrangler **3.114.17** 与 Account API Token，按 R2 包/签名 → 匿名回读验签 → KV 索引 → 公网复核顺序执行。没有升级 Wrangler、安装其他版本或切换 OAuth/Dashboard 上传通道。

R2 首次上传卡在 Wrangler 的 npm 更新通知检查。已保存原缓存，匿名获取官方 npm dist-tags 后仅刷新通知缓存；重试前匿名核包和签名均为 404，确认子进程组身份后仅终止卡住的 Wrangler，保留原 stage 父进程按相同对象键重试。随后上传完成，普通和绕缓存 URL 的包及签名字节均与本地相同，minisign 验证通过。恢复细节见 `plugin-stage-recovery.json`，公开包证明见 `plugin-public-packages.json`。

`publish-index` 在匿名确认宿主 `v6.1030.1` 已公开、ARM64 资产及 updater manifest 齐全后才写 KV。它从最新 KV 派生候选，写入前再读一次以拒绝并发变化。最终市场索引 **296 → 297**，仅增加 `notemd.quick-launch@1.0.0`，全部历史条目保持，KV、普通公网、绕缓存公网内容一致。索引候选 SHA-256：`7f0ddcbafe6b94640bb70a51c20315e6fc26219cef516690e660a7a5ef23d025`。执行退出码为 0，详见 `plugin-index-verification.json` 和 `plugin-publish-index.log`。

## 宿主构建、门禁、签名与公证

隔离宿主沿用 canonical release 脚本；完整最终构建退出码 0。初次 node_modules 符号链接导致 Vite 原始资产导入越过仓库边界，已停止该次依赖流程；用同一依赖的 APFS 克隆代替链接，保留原安全检查，先复验受影响测试再完整重跑。

- 最终宿主全量前端：**411 个测试文件、5329 项测试全部通过**。
- Svelte：**0 错误、31 项既有警告**；前端生产构建通过。
- canonical 原生门禁：Canvas 文档/资源 25 项、iOS Canvas 配置筛选 2 项、完整移动配置 3 项通过；这些是定向门禁，不代表运行了全部 Rust 测试。
- 功能实现阶段：快捷启动后端 13、托盘 9、RPC capability 1、生产插件集成 2、插件 UI 9 项通过；原生窗口验收见下一节。独立集成脚本测试另有 92 项通过。
- 宿主 App 签名通过，App 公证 `2881ac33-6755-4f8c-8d40-80ea3a678ef9` 为 Accepted；App Gatekeeper 为 `accepted / Notarized Developer ID`。
- 最终分发 DMG 公证 `eaa72e12-b607-4adb-8c13-ec83ac5c07ed` 为 Accepted，staple/validate、codesign 和 Gatekeeper 均通过；只读挂载验收通过。
- updater tarball 在公证后重新签名，并用应用内公钥验签通过；最终二进制架构为 arm64，Location/Apple Events entitlements 验证通过。

| 最终本地产物 | SHA-256 |
| --- | --- |
| `note.md-6.1030.1-aarch64.dmg` | `aeaf61d02e5267716571e0b03a473adac642dc71b289af2b999d3d31f0bd935a` |
| `note.md-aarch64.app.tar.gz` | `9191050909ffc23cd601e83c6bd220cfba99c50865fc07de5e132b8c19de9115` |
| App 内 `notemd` | `d070c13533bcc873dab8f9260c5178f65cf11631c19fae8aea43bbda14b7d0a6` |

证据：`host-release.log`、`host-release.exit`、`host-app-codesign.log`、`host-app-gatekeeper.log`、`host-build-inputs.json`、`host-source-proof.json`。

分享编辑器载荷检查证明冻结 manifest、JS/CSS/Mermaid 的完整压缩字节存在于实际 Mach-O；越界输入负例仍拒绝。`host-payload-proof.json` 明确其范围仅为 contained bytes，未证明运行时 resolver、生成 PHF 绑定或相同构建生命周期，本文不扩大该证据结论。

公网完整回读首次遇到连接提前关闭（curl 18 / HTTP 200），未重传或替换已发布资产。只读验证改用 1 MiB HTTP Range：响应须为 206、Content-Range 与长度完全匹配，最多 8 并发、有限重试，普通和绕缓存模式分别保存；完整组装后仍进行原始 SHA-256、逐字比较及 updater 验签。离线正反例、区间错误拒绝和中断恢复检查通过，真实 1 MiB 探针与本地同区间逐字一致。

## 原生功能验收及边界

实现阶段在独立 identifier 的 macOS 原生验证程序加载生产 `plugin://` 窗口，调用生产协议、窗口、RPC 与快捷启动服务；没有注入假桥。已验证：默认配置显示、编辑后禁止运行、保存后运行无副作用 CLI、退出 7 的错误提示、原生应用选择器选择 Calculator、计算器实际启动。隔离测试覆盖配置损坏/原子保存、插件身份与启停、App 独立 argv、登录 Shell PATH、非零退出、输出限额及进程组超时清理。

该验收覆盖真实配置窗口与执行服务；**没有实际执行 `uc reconnect`，没有另行启动完整宿主做托盘鼠标交互验收，也没有把本次正式包安装到用户日常运行的应用**。托盘组装由编译、菜单回归及生产插件启停集成检查证明。原生验收程序与 Calculator 已退出，隔离配置存为本地证据；详见 `docs/superpowers/reports/2026-10-30-quick-launch-verification.md` 与 `tasks/quick-launch-20261030/`。

## 收尾验收

- [x] 宿主全部 4 个公开资产在普通/绕缓存两种模式下完整回读，8 份结果与本地产物逐字和 SHA-256 一致；两种模式 updater minisign 均通过，latest API 和更新入口均指向本版，更新平台仅 `darwin-aarch64`。验证器退出 0，证据：`host-public/public-review.json`。
- [x] 官网 `09ba8424` 对应 CI [41024858234](https://github.com/wizlijun/note.md/actions/runs/41024858234) 成功。四语言页面只有 Cloudflare 注入的一段统计脚本差异，严格移除此段后与源码逐字一致。7 条下载路线的完整 URL、平台、架构与版本均通过；其他平台版本保持。证据：`website-verification.json`。
- [x] 原工作区 tracked/untracked 哈希、stash 和原分支状态与开始审计一致；其他任务改动未提交。
- [x] 原 Unreleased 条目已原样恢复并推送 `564d444e`。
- [x] 本报告和随附 JSON 作为独立文档提交，最终提交号记入本地 `tasks/todo.md`；未纳入其他任务改动。

本地完整证据目录：`tasks/quick-launch-release-20261030/`。公开入口：[宿主 v6.1030.1](https://github.com/wizlijun/note.md/releases/tag/v6.1030.1)、[Quick Launch 1.0.0 包](https://plugins.notemd.net/api/download/notemd.quick-launch/1.0.0/universal)、[插件市场索引](https://plugins.notemd.net/api/index.json)。
