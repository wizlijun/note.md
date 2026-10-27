# NEXT 1.12.0 / Codex 1.0.21 / DeepSeek 1.1.20 验收

本次补齐真实可用的 kickoff。名单来自本机已安装 Agent；NEXT 按声明范围收集有限背景快照，Codex / DeepSeek 在空目录、无工具和无用户扩展模式生成结构化问题。Claude 未安装，不参与本机验收，本次不发布 Claude。

进行中的 Task 显示入口；复合控件共用一个外框与分隔线，并保留两个可访问动作。答案预填继续使用同一 Task UUID，不重复占 WIP、不自动完成任务。只在用户提交安放表单后修改生命周期。

## 已验证

- NEXT：44 个文件、806 个测试通过；类型检查 0 错误 / 0 警告；生产构建通过。
- agent-run-core：162 个测试；Codex：90 个测试；DeepSeek：137 个普通测试通过。2 个需真实认证的 DeepSeek 测试默认忽略，另有显式真实验收证据。
- 独立审查修复 R1–R4：关闭数据源的引用授权、UTF-8 硬预算、严格总超时、坏结果/读取失败按 Task 隔离与终态冲突释放容量。已有文件保持原字节。
- 实际已签名 arm64 包运行 synthetic Vault：Codex gpt-6-astra 与 DeepSeek deepseek-v4-flash 均成功。生产 parsePayload 无修复；生成文档落盘回读、人工答案保存回读均通过；原 Task SHA 未变且 artifacts=[]。
- 四个 native 包已验证 minisign、Developer ID codesign、架构、manifest、关键能力及测试夹具排除；172 项构建源码输入哈希未变。完整源码输入与真实包 SHA 见同名 JSON。
- Codex 的真实恶意工具调用在执行层报 code-mode host is disabled；DeepSeek 恶意 profile/NODE_OPTIONS 未执行。不是仅依据模型自述证明边界。

## 范围与限制

- 600 秒为严格执行总时限，max_turns=40 为协议收束目标；两家 CLI 不提供统一硬性轮数上限。
- 只读背景为预算内快照；未取得的证据通过 gaps 披露。不给模型提供 Vault 文件或外部网络工具。
- CUA 对 Safari、Chrome 和已安装 note.md 均返回 cgWindowNotFound，因此本轮没有取得实机截图或 hover 视觉证据；DOM/键盘/状态集成回归已通过，不冒充实机视觉验收。
- 主工作区另有未提交改动及三个历史 stash，均保留，不代其提交。本次独立工作区的版本冻结、市场与安装结果另见最终发布报告。
