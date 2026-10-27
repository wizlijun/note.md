# NEXT kickoff ready 发布范围预审

快照时间：2026-10-27T22:25:13.926521+08:00。本报告是发布前审计，不证明已发布、已安装或已推送。

## 发布范围

- 拟发布 NEXT 1.12.0、Codex Agent 1.0.21、DeepSeek Agent 1.1.20。Claude Agent 不在本次发布范围。
- 只处理 `/Users/bruce/git/mdeditor-next-ready` 的本次改动；其他 worktree、历史 stash 与无关文档保留。
- 主工作区另会话可能发布 NEXT 1.11.1 / Claude Agent 1.0.34。发布前须重新读取远程 main 与市场索引，保留其提交与索引条目，不覆盖。

## 远程与版本占用

- `git ls-remote origin refs/heads/main`：`f9c765d7ed065776087e12f8636ed113eeaf9e0b`。本地 origin/main 与之相同。
- 公网只读索引：`https://plugins.notemd.net/api/index.json`；最高版本：next 1.11.0, codex-agent 1.0.20, deepseek-agent 1.1.19, claude-agent 1.0.33。
- 三个拟发布版本均未出现在公网索引，本地与远程对应 `plugin-…-v…` tag 查询为空。未上传对象、未写索引、未创建 tag。

## 所有 worktree 文件枚举

### `/Users/bruce/git/mdeditor`

本次范围外，不修改、不代为提交。

```text
M plugins-src/agent-run-core/src/harness.rs
 M plugins-src/agent-run-core/src/record.rs
 M plugins-src/agent-run-core/src/scaffold.rs
 M plugins-src/claude-agent/backend/src/engine.rs
 M plugins-src/claude-agent/backend/src/plugin.rs
 M plugins-src/codex-agent/backend/src/engine.rs
 M plugins-src/codex-agent/backend/src/plugin.rs
 M plugins-src/codex-agent/backend/src/runner.rs
 M plugins-src/deepseek-agent/backend/src/engine.rs
 M plugins-src/deepseek-agent/backend/src/plugin.rs
 M plugins-src/next/src/App.kickoff.render.test.ts
 M plugins-src/next/src/App.svelte
 M plugins-src/next/src/components/KickoffPicker.render.test.ts
 M plugins-src/next/src/components/KickoffPicker.svelte
 M plugins-src/next/src/lib/kickoff/client.test.ts
 M plugins-src/next/src/lib/kickoff/client.ts
 M plugins-src/next/src/lib/strings.ts
?? .pnpm-store/
?? docs/superpowers/specs/2026-09-23-agency-batch-cli.md
?? docs/superpowers/specs/2026-09-23-agency-plugin-design.md
?? docs/superpowers/specs/2026-09-23-agency-practical-review.md
?? docs/superpowers/specs/2026-09-30-habitat-knowledge-city-design.md
?? docs/superpowers/specs/2026-09-30-vault-knowledge-structure-extraction-design.md
?? docs/superpowers/specs/habitat-city.html
?? plugins-src/codex-agent/backend/tests/
?? plugins-src/next/src/lib/kickoff/__fixtures__/capacity-status.json
```

### `/Users/bruce/git/mdeditor-next-kickoff`

本次范围外，不修改、不代为提交。

```text
(clean)
```

### `/Users/bruce/git/mdeditor-next-ready`

本次范围内（由 root 最终精确提交并验证）。

```text
M CHANGELOG.md
 M CHANGELOG.zh-CN.md
 M docs/superpowers/specs/2026-10-27-next-task-kickoff.md
 M plugins-src/agent-run-core/src/harness.rs
 M plugins-src/agent-run-core/src/scaffold.rs
 M plugins-src/claude-agent/backend/src/plugin.rs
 M plugins-src/codex-agent/backend/Cargo.lock
 M plugins-src/codex-agent/backend/Cargo.toml
 M plugins-src/codex-agent/backend/src/argv.rs
 M plugins-src/codex-agent/backend/src/engine.rs
 M plugins-src/codex-agent/backend/src/plugin.rs
 M plugins-src/codex-agent/backend/src/runner.rs
 M plugins-src/codex-agent/manifest.v2.json
 M plugins-src/codex-agent/package.json
 M plugins-src/deepseek-agent/backend/Cargo.lock
 M plugins-src/deepseek-agent/backend/Cargo.toml
 M plugins-src/deepseek-agent/backend/src/composition.rs
 M plugins-src/deepseek-agent/backend/src/engine.rs
 M plugins-src/deepseek-agent/backend/src/plugin.rs
 M plugins-src/deepseek-agent/manifest.v2.json
 M plugins-src/deepseek-agent/package.json
 M plugins-src/ebook-import/src/lib/agent-picker/types.ts
 M plugins-src/idea-spark/src/lib/agent-picker/types.ts
 M plugins-src/memory/src/lib/agent-picker/types.ts
 M plugins-src/next/CHANGELOG.md
 M plugins-src/next/manifest.v2.json
 M plugins-src/next/package.json
 M plugins-src/next/src/App.kickoff.render.test.ts
 M plugins-src/next/src/App.svelte
 M plugins-src/next/src/components/KickoffButton.render.test.ts
 M plugins-src/next/src/components/KickoffButton.svelte
 M plugins-src/next/src/components/KickoffPicker.render.test.ts
 M plugins-src/next/src/lib/agent-picker/types.ts
 M plugins-src/next/src/lib/kickoff/button-state.test.ts
 M plugins-src/next/src/lib/kickoff/button-state.ts
 M plugins-src/next/src/lib/kickoff/client.test.ts
 M plugins-src/next/src/lib/kickoff/client.ts
 M plugins-src/next/src/lib/kickoff/template.ts
 M plugins-src/next/src/lib/strings.ts
 M plugins-src/trace-source/src/lib/agent-picker/types.ts
 M src/lib/agent-picker/types.ts
?? plugins-src/codex-agent/CHANGELOG.md
?? plugins-src/codex-agent/node_modules
?? plugins-src/deepseek-agent/CHANGELOG.md
?? plugins-src/deepseek-agent/node_modules
?? plugins-src/next/kickoff-preview.html
?? plugins-src/next/src/lib/kickoff/context.test.ts
?? plugins-src/next/src/lib/kickoff/context.ts
```

## 本地分支未合入提交

```text
feat/next-task-kickoff 0e7276abd522cf89a3fedabe6129a240aa1a61d7
fix/next-kickoff-ready f9c765d7ed065776087e12f8636ed113eeaf9e0b
main f9c765d7ed065776087e12f8636ed113eeaf9e0b
```

`git branch --no-merged origin/main` 为空。所有现有分支提交均在该远程 main 祖先链内；没有仅因 cherry-pick/重写而误判的未合入提交。本工作树功能目前未提交，不能视作已经进入主线或安装包。

## Stash 枚举与归属

### stash@{0}: On feat/plugin-market-catalog-redesign: codex-preserve-before-release-6.831.1

本次范围外，保留。

```text
M	docs/superpowers/specs/2026-08-10-windows-download-design.md
M	plugins-src/next/src/lib/domain.test.ts
M	plugins-src/next/src/lib/domain.ts
M	plugins-src/next/src/lib/events.test.ts
M	plugins-src/next/src/lib/events.ts
M	plugins-src/next/src/lib/model.ts
A	plugins-src/next/src/lib/project-match.test.ts
A	plugins-src/next/src/lib/project-match.ts
M	plugins-src/next/src/lib/repository.ts
M	website/src/index.js
A	website/src/index.test.ts
M	website/src/resolve-download.js
M	website/src/resolve-download.test.ts
```

### stash@{1}: On main: stray fix-E/F content left in main's worktree by the roam-inc2 stash incident 2026-08-04; superseded by feat/roam-incremental-2, kept for safety

本次范围外，保留。

```text
M	plugins-src/roam-import/backend/src/outline.rs
M	plugins-src/roam-import/backend/src/syntax.rs
M	plugins-src/roam-import/src/lib/roam-import/syntax.test.ts
M	plugins-src/roam-import/src/lib/roam-import/syntax.ts
M	src/lib/outline/markdown.test.ts
M	src/lib/outline/markdown.ts
```

### stash@{2}: On feat/attention-intervals: attention-intervals wip: plugin_host.rs (decision-log 期间保管)

本次范围外，保留。

```text
M	src-tauri/src/plugin_host.rs
```

## 本子任务可精确提交的文件

- `CHANGELOG.md`
- `CHANGELOG.zh-CN.md`
- `plugins-src/next/CHANGELOG.md`
- `plugins-src/next/package.json`
- `plugins-src/next/manifest.v2.json`
- `plugins-src/codex-agent/package.json`
- `plugins-src/codex-agent/manifest.v2.json`
- `plugins-src/codex-agent/backend/Cargo.toml`
- `plugins-src/codex-agent/backend/Cargo.lock`
- `plugins-src/codex-agent/CHANGELOG.md`
- `plugins-src/deepseek-agent/package.json`
- `plugins-src/deepseek-agent/manifest.v2.json`
- `plugins-src/deepseek-agent/backend/Cargo.toml`
- `plugins-src/deepseek-agent/backend/Cargo.lock`
- `plugins-src/deepseek-agent/CHANGELOG.md`
- `docs/superpowers/reports/2026-10-27-next-kickoff-ready-release-scope.md`

Cargo.lock 仅改各自包版本，不更新依赖。前端 package.json 同步插件版本；没有宿主版本或 Claude manifest 变更。

## 验证与剩余动作

- `node scripts/changelog.mjs check`：通过。
- `git diff --check`：通过。
- 已枚举所有 worktree、未合入分支与 stash；本子任务未提交、未发布。
- root 仍须以冻结提交/tag 构建验收实际包，并按既有 Wrangler 3 + Account API Token 流程执行 R2 包/签名上传、匿名回读验签、KV 索引发布和公网复核。
