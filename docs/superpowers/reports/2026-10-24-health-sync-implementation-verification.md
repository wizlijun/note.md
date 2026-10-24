# Health Sync v0.1 源码验收记录

日期：2026-10-24。按用户最新要求，本轮**不签发、不发布、不上传、不推送**；验证与提交源码，保留真实账户及应用内验收项。本记录不是安装包或线上发布证明。

## 已实现范围

- 一个 native v2 Mac 插件：Apple 完整 ZIP/XML 为主体，Garmin 官方 Personal API 与 Oura V2 API 补充详情。Oura API 采用用户确认的额外授权前提。
- schema 2 每日 SSOT、可读 slug 分片及附件、分类目录与查询、CLI/cron、有界历史回填及续跑。
- 完整 XML/JSON 内容保留，ZIP 附件原字节保存，按来源与完成集合替换；重复样本/厂商重复 ID 分别处理，错误不激活半份窗口。
- 本地钥匙串、OAuth PKCE/state、刷新 token 持久化、账号绑定、跨进程授权代际和提交锁。
- 简化窗口交互与覆盖表，切换 Vault 清空旧状态，筛选变化重置分页；Apple 单独同步不要求无关日期。
- 查询使用命名筛选结构，CLI 共用布尔解析；授权与同步共用状态目录解析；没有新增通用任务引擎或前端框架。

## 多轮复审修复

1. 重新授权尚未完成时，旧 Keychain 凭据不能按新代际推进历史游标；Keychain 保存失败不激活授权。同步使用实际 client 代际，而非较早的状态快照。
2. Oura 扩展 UTC 查询的窗口外记录必须按原始归属日过滤，仍完整翻页；否则真实持续心率会触发存储窗口校验失败。
3. XML mixed content 保留子节点间文本顺序，支持继承的 `xml:space`；常规纯属性记录不增加冗余字段。非法 ExportDate 不能被当成完整空快照清除旧成员。
4. 合法 DTD 字段名不因包含 SYSTEM/PUBLIC 字样误拒绝；真正外部 DTD/ENTITY 仍拒绝。空附件保留，不因零长度阻断导入。
5. GUI 授权失败清除过期链接，凭据不进入报告；只停止后续采集批次，已提交进度可恢复。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| `cargo test --locked` | 80 项通过：51 单元、3 真实宿主/CLI 协议、26 快照集成；百万 benchmark 默认忽略 |
| `cargo clippy --locked --all-targets -- -D warnings` | 通过，无 warning |
| `cargo fmt --check` | 通过 |
| UI `node --test` | 26 项通过 |
| TypeScript `tsc --noEmit` / Vite build | 通过 |
| release-plugins.sh 打包契约 | 77 项通过 |
| 开发安装/发布脚本 `bash -n` | 通过，未执行安装或签发 |
| aarch64 / x86_64 Apple Darwin release build | 两种架构均成功，`file` 确认目标 Mach-O 架构 |
| 最终 arm64 release 二进制实跑 | 合成 ZIP、GPX 附件、分类/查询、XML mixed text、幂等重复导入通过 |
| 市场页面相关静态检查 | 新入口/分类、生成 HTML 内联 JS 语法、manifest 中/日/德 metadata 通过 |
| 精确改动的 diff 格式检查 | 通过；不修改其他任务已有空格/文案 |

百万条合成心率、3650 天 benchmark：schema 2 导入 73.42 秒；独立核对 1,000,000 条记录、3650 个分片、3650 个日摘要；manifest 6,742,105 字节，vault 371,560 KiB。RSS 途中采样 28,848 KiB，仅为采样值。`cargo test` 明确 PASS；`/usr/bin/time -l` 在系统资源查询权限处返回 1，不将该 wrapper 退出码误报为导入失败，也不宣称取得峰值内存。后续 XML/授权等边界修复通过最终小型回归，未重复百万规模测试。

## 未完成的环境验收

- 没有真实个人 Apple 导出、Garmin Key、Oura 应用或用户授权会话；在线采集、真实钥匙串交互尚未验证。
- 没有完成应用内 WebView 的实机视觉检查；当前依据 DOM 行为测试、类型检查与构建。
- 插件市场完整 Workers 测试未能启动：已有 workerd 返回 `spawn Unknown system error -88`，没有执行任何测试；兼容日期也回退到运行时支持日期。未修改或升级 Wrangler/运行时，改用与本次两处页面映射改动对应的生成页面检查。不能把这项记录为 Workers 测试通过。
- Intel 架构已编译，未在 Intel Mac 实跑。没有签名、冻结发布 tag、安装包、公网回读或线上索引更新。

## 工作区范围

提交前仅一个 main worktree、无 stash、无其他本地分支；origin/main 之后已有本任务两个规划提交 `a3ba9d70`、`4570c66b`。本次只提交 health-sync 插件、相关规格/验收记录、工作区依赖 importer、开发安装/打包分支和市场页面入口映射。

排除已有其他任务改动：`CLAUDE.md`、根 `README.md` / `README.zh-CN.md`、`website/public/llms*.txt`、`docs/product-principle-agent-playbook-belongs-to-the-vault.md`。临时测试配置、依赖链接和自动产生的空 pnpm store 已清理；构建产物不提交。
