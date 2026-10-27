# Claude Agent 更新日志

## 未发布

## 1.0.34 — 2026-10-28

- 声明并支持 NEXT 冻结 v2 协议（`readonly_context`、`kickoff_protocol_versions: [2]`）：只消费确认后的完整 prompt，经 stdin 传入，不读取磁盘 CLAUDE.md / AGENTS.md 或 task.json 指令。
- 在空临时目录以 safe/restricted 模式运行，关闭全部内置工具、MCP、斜杠命令与会话持久化；严格只读任务按总时限而非静默时限终止，不生成或扫描交付文件。
- 缺少 v2 标记，或只读、预检、`max_turns`、`timeout_seconds` 配置不合规时，在启动 Claude 前拒绝（CLI 后台运行返回退出码 6）。
- 严格执行在输出提前关闭、stderr 或 stdin 收束挂起时仍遵守同一总时限和取消信号，避免后台进程绕过超时。

配合 NEXT 1.12.1 使用，无需更新 NEXT；本次只发布 Claude Agent。
