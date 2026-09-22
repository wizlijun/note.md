# Conversation Transcript Corrections

`notemd.conversation-dictionary` 用于整理本人参与的会议、通话与语音消息中的正式名、
别称和 ASR 误识别。插件按场景保存已确认的替换规则；未经人工确认的候选不会自动
进入正式词典，也不会直接改写历史转写。

需要 note.md `6.916.1` 或更高版本。当前原生发布包支持 macOS Apple Silicon 与
Intel，不提供 Windows 版本。

## 人机协作边界

- Agent 可以查询词典、提出候选，并从用户明确指定的转写范围生成审阅数据集。
- Agent 只应分析用户本人参与的沟通；不得扫描未授权的他人会话或扩大数据范围。
- 数据集导入后仍由用户逐条确认、合并、移动或删除。Agent 不能代替用户批准规则。
- 正式词典默认位于 `ssot/meetings/conversation-dictionary.yml`；候选数据集写入
  `ssot/meetings/conversation-dictionary-drafts/`，不应绕过插件直接修改正式词典。

插件窗口中的「安装 Agent Skill」会在 Vault 内安装
`.agents/skills/build-conversation-dictionary/`，并在 `AGENTS.md` 中加入有边界的
调用说明。该操作必须由用户明确触发；插件不会静默安装或更新 Agent 配置。

## CLI

```sh
notemd conversation-dictionary status
notemd conversation-dictionary list --domain DOMAIN_ID
notemd conversation-dictionary pending
notemd conversation-dictionary check
notemd conversation-dictionary propose --input proposal.yml
notemd conversation-dictionary resolve --input decision.yml
notemd conversation-dictionary dataset-check --input dataset.yml
notemd conversation-dictionary dataset-import --input dataset.yml
```

`status`、`list`、`pending` 与 `check` 可用于只读检查；`propose` 只创建待确认候选。
`resolve` 和 `dataset-import` 会修改 Vault 中的数据，调用方应展示输入并取得用户明确
确认。`--domain` 与 `--id` 使用精确 ID，不做模糊匹配。

插件控制状态和事务日志位于 `.notemd/conversation-dictionary/`，设置保存在
`.notemd/conversation-dictionary.json`。这些文件用于恢复与审计，不应手工编辑。

## 验证

```sh
cargo test --manifest-path plugins-src/conversation-dictionary/backend/Cargo.toml
pnpm --dir plugins-src/conversation-dictionary test
pnpm --dir plugins-src/conversation-dictionary check
pnpm --dir plugins-src/conversation-dictionary build
```
