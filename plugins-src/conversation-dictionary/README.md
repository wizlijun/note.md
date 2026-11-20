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

## Agent 上下文:`vocabulary.md`

每次经确认写入词典后，插件在词典同目录生成 `vocabulary.md`(默认
`ssot/meetings/vocabulary.md`),供 agent 作为上下文插入。它是纯 Markdown,不含 front matter
或任何元数据(版本、时间、来源等),由词典 schema 确定性派生，只含已启用规则，按场景(domain)与类型(kind)分组;场景以名称为标题;场景、条目、规则的 ID,条目描述、确认时间等都不进入。
写法与常见查找替换表一致，从左往右读「听到的 → 应写作」,图例只解释正文实际用到的记号:

- `x, y → A`:转写里的 x、y,说话人指的是 A,上下文吻合时改正(`application: suggest`);
- `x → A (always)`:一律改正(`application: automatic`);
- `do not change: x`:不改(`action: preserve`);
- 没有箭头的 `A`:属于该场景、但没有替换规则的正式写法;
- 含分隔符(含全角 `、，；`)的写法以 JSON 字符串给出。

规则只在所属场景内生效(与 `resolve` 一致,`public` 也不会套用到其它场景)。写入是单向的:
插件只从词典生成该文件、从不读回，内容不同就整份覆盖，手工修改会被下次生成覆盖。
插件窗口顶部的「打开勘误表」打开的就是这个文件(打开前先按词典刷新一次);YAML 词典本身在「设置」里打开。

插件窗口中的「安装 Agent Skill」会在 Vault 内安装
`.agents/skills/build-conversation-dictionary/`，并在 `AGENTS.md` 中加入有边界的
调用说明。该操作必须由用户明确触发；插件不会静默安装或更新 Agent 配置。

## CLI

```sh
notemd conversation-dictionary status
notemd conversation-dictionary list --domain DOMAIN_ID
notemd conversation-dictionary pending
notemd conversation-dictionary context [--domain DOMAIN_ID]
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
