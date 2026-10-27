# NEXT 1.12.1 / Codex 1.0.22 / DeepSeek 1.1.21 发布证据

已完成修复、正式包验收、市场发布与本机安装。源码提交 `ecfac4beb06b8df4534b0f42f3d143a9a9f0fd08`；三个冻结 tag `plugin-next-v1.12.1`、`plugin-codex-agent-v1.0.22`、`plugin-deepseek-agent-v1.1.21` 均指向该提交。发布报告与总更新日志为后续独立文档提交，不改变冻结包。

## 用户点名的修复

1. 按数据源及目录公平分配预算、中文部分词语匹配、账本已完成任务预过滤。650 Task 回归及正式包 600 Task / 60 目录场景均选到日记、批注、同项目完成任务。
2. 每次运行明确服务商和实际发送文件；确认发送同一份冻结内容。切换 Agent、重试、重跑、规程变化均重新预览。确认后改变背景不会将新内容混入请求。
3. registry 持久保存实际发送路径，重启仍限制来源；未发送文件即使存在也不能支撑 fact；旧 run 缺少清单时降级可信度。
4. v2 协议仅拼一次，保留旧 v1 文件及轮询兼容；旧插件缺能力不得执行。引擎不再重新拼磁盘指令，v2 不能通过配置变化退回有工具模式。
5. Claude 等未支持 Agent 明确暂不支持。锁冲突为 capacity，时长为整数秒。

对应实现均在冻结 tag 的 context/client/registry/template、Agent core prompt/task/record 和两家 engine/plugin/runner 内；935 个构建相关源码输入与 tag 提交逐一核对，完整哈希见同名 JSON。正式 NEXT 包验证了 v2、preview-changed、context_paths、确认外发等内容标记；两个架构的 Agent 包验证了新能力声明、隔离标记及架构。

## 验收

- NEXT 45 文件 / 835 项；core 166、Codex 96、DeepSeek 143、Claude 兼容 125；picker/发布脚本 87 项通过。DeepSeek 两个默认忽略的认证测试不计为通过，真实验收另行执行。类型检查 0 错误、0 警告。
- 已签名 arm64 正式包运行生产 NEXT prepare/start 生成的背景：两家均确认并发送 5 文件、2080 字节，包括中文日记和批注；确认后修改日记，未确认字节未进入 prompt。
- Codex 默认 gpt-6-astra 成功，4 个来源；DeepSeek 默认 profile 报告 deepseek-v4-pro，成功，5 个来源（终态 usage.model 缺失，记录 null）。两者各 1 题，生产 parsePayload repairs=[]，fact 均有快照内来源。
- 生产 reconcile、整数时长、模拟人工答案保存/回读通过；已有但未发送的来源负例被剔除并降级为 unverified inference。模型运行前后隔离 Vault 的既有文件哈希不变，无 artifacts。
- 实际 Chromium 140 已验证每次预览、服务商切换、变更再确认和取消零调用；一体控件、全局蓝底白字 hover、1080×850 与 440×620 布局通过。此证据使用内存 Vault 和模拟模型调用，与上面的正式包真实模型证据分开记录。

## 签名发布及安装

沿用仓库 Wrangler 3.114.17 和 Account API Token：R2 包/签名上传 → 匿名公网逐字回读与 minisign 验证 → KV 仅追加对应版本 → 普通 URL、缓存绕过 URL 和 KV 内容一致复核。共 5 个包、10 个 R2 对象；索引从 282 条变为 285 条，原 282 条逐项不变。所有 native 包均通过 Developer ID codesign、arm64/x86_64 架构和 manifest 验证，未包含测试 stub。

| 包 | 架构 | SHA-256 |
|---|---|---|
| notemd.next 1.12.1 | universal | `6a27026dd36798a102c92d5a5a100db444633ae44776a9efa2e24cce58070658` |
| notemd.codex-agent 1.0.22 | aarch64-apple-darwin | `5b6d40d34a3b4f7c19b779ed6c24cd9e8b662392e558b7abadb60fee0198f700` |
| notemd.codex-agent 1.0.22 | x86_64-apple-darwin | `cbf966fa44d575454e375bc5675027c8548d68bf1ccd369bb7b1149e4772190e` |
| notemd.deepseek-agent 1.1.21 | aarch64-apple-darwin | `ef03ed4c52b1f00b636af1ca08eacb1bd98b918900032a84d8cd9740cd41fc3c` |
| notemd.deepseek-agent 1.1.21 | x86_64-apple-darwin | `b131363cdb8e12b3fceda193cf1f64264fad087f436b15a5c2e5c3aa88e46b9b` |

通过市场 CLI 依次安装三个指定版本；已启用，current 指向正确版本，每个安装文件与对应签名包逐字一致。已安装 Codex/DeepSeek 的真实 SDK harness-status 均 ok，readonly_context/terminal_result 为 true，kickoff_protocol_versions 为 [2]。

## 范围与限制

发布前审计全部 4 个 worktree、本地未合入提交和 3 个历史 stash。主工作区另一会话的 17 个 tracked、9 个 untracked 文件全部保留；旧两个 kickoff worktree 干净，无未合入提交。唯一新提交为本轮经验证实现，未替其它任务提交代码；详细路径和 stash 范围见 JSON。

未安装 Claude，保持暂不支持，本次未发布 Claude。真实模型只在隔离合成 Vault 上运行，未修改正式 Task 或发送真实提醒。背景检索仍受预算限制并披露 gaps；max_turns 是协议目标，600 秒为执行层硬总时限。CLI 安装不会重载已运行的桌面实例，重开 note.md 后加载新版插件。
