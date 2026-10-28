# NEXT 自主检索开个头：插件发布证据

状态：已发布；正式包与公网市场索引均已验证。

## 范围与冻结

本次仅发布 NEXT 1.13.0、Codex Agent 1.1.0、DeepSeek Agent 1.2.0、Claude Agent 1.1.0，不安装插件、不发布宿主、不操作正式 Vault 或提醒。

基线 `8b60fa06` 保留 Ebook Import 1.5.5/1.5.6 与最新共享 SDK。功能提交 `b6857e7d` 移植为 `72302857`，除两份合并后的 CHANGELOG 外，63 项文件变更逐项一致。兼容与版本提交 `167eb3303d8593653d976a2775083483c5682085` 冻结为以下四个 tag：

- `plugin-next-v1.13.0`
- `plugin-codex-agent-v1.1.0`
- `plugin-deepseek-agent-v1.2.0`
- `plugin-claude-agent-v1.1.0`

已审计 8 个 worktree、8 个本地分支、3 个 stash；主工作区 17 项 tracked 修改、9 项 untracked 均保留，不纳入发布。旧分支采用逐文件与实际功能核对，不单凭祖先或整体 patch-id 判定。完整审计及 361 个构建输入哈希见同名 JSON。

## 用户点名功能与兼容

NEXT 只传计算的 Vault 根、Task 路径、UUID/哈希等身份与检索要求，不扫描背景文件、不注入正文包。Agent 按 v3 协议自行读取 Task，调用 `notemd search --vault <计算路径>` 与 harness 联网搜索近期文章，回读来源并区分事实、推断与缺口。Agent 不改 Vault 内容、不执行任务、不发送消息；NEXT 校验并单独保存结果，用户确认才安放。进度消息与终态 JSON 分开，防止检索叙述污染结果。

三 Agent 并发均可设 1–5，默认 3，已有设置保持。旧宿主 6.1027.1/6.1027.3 在键缺失时仍返回 1：本次插件打开 Agent 设置页时仅为缺失键保存 3；无需改动已有显式值。未打开设置前，旧宿主仍按 1 限流。宿主默认值的源码改动已提交，但本次插件包不部署宿主，不能声称免操作默认已生效。

网页来源优先 `host.link.open`；旧宿主明确返回 `-32601` 时通过既有 `clipboard.write` 复制链接并提示浏览器打开。其他错误照常报告，安全 URL 校验不放宽。旧宿主允许未知 capability 声明，故无需虚设未发布最低宿主版本。本次兼容实现取代此前实现报告中“必须提高最低宿主版本”的发布建议。

## 验证

- NEXT 841 项通过；三 Agent 设置与界面回归 78 项通过；四插件类型检查均 0 错误、0 警告。
- 最新 SDK 14、共享 core 171、Codex 101、DeepSeek 148、Claude 138，共 572 项通过；5 项环境相关测试未计入通过数量。包含 Ebook 共享 SDK 调度变更的整合验证。
- 7 个正式包验 minisign、Developer ID codesign、原生架构、manifest、v3 标记与 UI 构建产物逐字一致；未夹带 stub 或测试 fixture。三家 arm64 正式包均经 SDK 初始化、激活、harness-status、退出，实际声明 v3 与 readonly_context。
- 正式 arm64 Codex 包经 SDK `run-task` 的真实模型验收：74.39 秒成功，实际本地 CLI 与 WebSearch；5388 字节终态经生产解析 0 repairs，1 题、5 来源（3 网页），文档往返通过，全部 10 个既有输入文件哈希不变。调用由最新生产 NEXT prepare/start 生成，包含 JSON task_path 与 curl 回读后备。通知由隔离宿主 stub 接收，未发送真实通知。此前 DeepSeek 原生工具图验证见实现报告，不冒充本轮模型验收。
- Claude 本机认证过期，未重新宣称真实模型检索验收通过；不要求恢复登录后才能发布。

## 市场发布

沿用仓库 Wrangler 3.114.17 与 Account API Token。依次执行 R2 上传、匿名公网回读字节与 minisign 验签、KV 索引追加及普通/绕缓存公网复核。索引 288 → 292，原有 288 条逐字保持，仅追加上述四版本。先发三个 Agent，最后发 NEXT；各步 KV 与普通/绕缓存公网索引一致。源码与冻结 tags 已推送。上传首对象遇版本提示查询停滞，确认公网 404 后刷新真实 npm 提示缓存并以相同 Wrangler 3 命令、对象键重试；未安装新 Wrangler，未改发布通道。

| 插件 | 架构 | 包 SHA-256 |
|---|---|---|
| notemd.next 1.13.0 | universal | `2274d569e72094e6d008bfd9006bd862d639fa6de85d5d611fa6094beadc4e18` |
| notemd.codex-agent 1.1.0 | aarch64-apple-darwin | `5745e35050fba45c327bf10c81c0882193f9ee2080aa3df15203d22d057acdec` |
| notemd.codex-agent 1.1.0 | x86_64-apple-darwin | `0f532dc663d4d199c5e934cd237b32717c31b179fdf20511fbbb2ee3830d6821` |
| notemd.deepseek-agent 1.2.0 | aarch64-apple-darwin | `41015db8f9d53ba3e9ae50438e3579d8fcaf9c9c98f1320b34a2d0c02ea18bd6` |
| notemd.deepseek-agent 1.2.0 | x86_64-apple-darwin | `aeac8cbb192d9cf23a3f1511251743165c00f2827da9eb06ef6074c0bf909a20` |
| notemd.claude-agent 1.1.0 | aarch64-apple-darwin | `46a10a70207a37cc45ff026cc87dc09add9341d654143ff4bcd97a9af4cc09d3` |
| notemd.claude-agent 1.1.0 | x86_64-apple-darwin | `37bb4c5f96f7ae0093f589beab0f9e3b4dc5e2170ed372957e15b092002cbce6` |

本机安装清单仍为 NEXT 1.12.1、Codex 1.0.22、DeepSeek 1.1.21，未安装 Claude；本轮没有安装。报告为发布后文档提交，不改变冻结源码或安装包。
