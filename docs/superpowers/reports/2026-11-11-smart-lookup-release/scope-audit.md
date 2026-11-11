# 合并后 Smart Lookup 宿主发布范围审计

审计日期：2026-11-11。只读基线为 main `71280e1869390fe8d5b11c3f1099737cedbbf1a8`，其中 merge `6abf87503f51d9e08ede9fd5b23c6355512fc10b` 已包含远端 `c55abc6afbb6d6fdb090da7655932ece1660f1c6`。此报告记录发布准备时实际检查结果，不代替最终 tag 或安装包验证。

## 工作区清单

`git worktree list --porcelain` 实际列出五项，另用文件系统检查路径是否存在。

| 路径 | HEAD / 分支 | 状态与范围 |
| --- | --- | --- |
| `/Users/bruce/git/mdeditor` | `71280e18` / main | 最初仅 `searchidx/src/store.rs`、`src-tauri/src/smart_lookup.rs` 两处已知 EOF 换行修改；无非忽略未跟踪文件。两者保持未提交，不纳入发布。 |
| `/Users/bruce/git/mdeditor-capture-release-20261111` | `93a82534` / release/capture-plugins-20261111 | 路径不存在；Git 明确标记 prunable。无法检查不存在目录的 dirty/untracked，不能称其干净。 |
| `/Users/bruce/git/mdeditor-plugin-release-20261111` | `b88edb93` / release/plugins-20261111-create | 路径不存在；prunable。 |
| `/Users/bruce/git/mdeditor-sumi-release-20261111` | `a56e861d` / release/sumi-20261111 | 路径不存在；prunable。 |
| `/Users/bruce/git/mdeditor-writing-release-20261111` | `c4d39ddf` / release/writing-groups-20261111 | 路径不存在；prunable。 |

另按主代理发现的路径核查独立 clone `/Users/bruce/git/mdeditor-sumi-ime-host`：该 clone 唯一 worktree 为分支 `release/sumi-ime-macos-6.1110.8`，HEAD `7437e6feddb0218c8bf42cc5b6cb17903d5954e5`；`git status --short --branch` 无 dirty/untracked，stash 列表为空。其另一 local 分支 main 为 `5908e8b1d0d05c58fa2cc1a195161f240d8d2134`。两提交均通过本仓库 `git merge-base --is-ancestor <commit> 71280e18`，没有待合入提交。该 clone 不出现在本仓库 worktree 列表，因此单独记录。

未删除工作区元数据或分支。审计之后本次仅修正两份 CHANGELOG 并新建本报告，由主代理核查提交；不把这些新编辑混称为最初的 dirty。

## 本地分支与补丁等价

对所有本地分支执行 `git rev-list --count HEAD..<branch>` 和 `git cherry HEAD <branch>`；后者仅对非合并提交作补丁等价判断。计数不得当作尚缺功能数。

| 分支 | 非祖先提交数 | `git cherry` 等价 / 不等价 | 处理 |
| --- | ---: | ---: | --- |
| release/capture-plugins-20261111 | 1 | 0 / 1 | `93a82534` 是已经公开的捕捉插件冻结版本；不再次 cherry-pick。 |
| release/plugins-20261111-create | 1 | 0 / 1 | `b88edb93` 是已经公开的 Sumi/Idea Spark 分类版本；不再次 cherry-pick。 |
| release/sumi-20261111 | 16 | 12 / 4 | 运行时代码已有等价补丁；剩余为版本、清单品牌、冻结说明与发布历史组合提交，逐文件核对见下。 |
| release/writing-groups-20261111 | 23 | 16 / 7 | 包含上行历史及分类补丁；不因非祖先关系将其全部重放。 |

Sumi 分支的不等价提交：`5e197ce4`、`6d9233a0`、`23e4ad11`、`a56e861d`。writing-groups 另有 `ad535d04`、`444c24f3`、`c4d39ddf`。其余 12 / 16 个非合并提交分别由 `git cherry` 确认为补丁等价。

逐项等价提交清单：

- `release/sumi-20261111` 补丁等价提交：`0341b8db`、`e76b3f75`、`c94c4488`、`86e11a01`、`91c0fb82`、`45e07d39`、`e73cc0f3`、`32d2e26c`、`bcafd2ab`、`4b173315`、`fe5b02a3`、`d033aa8a`。
- `release/writing-groups-20261111` 补丁等价提交：`0341b8db`、`e76b3f75`、`c94c4488`、`86e11a01`、`91c0fb82`、`45e07d39`、`e73cc0f3`、`32d2e26c`、`bcafd2ab`、`4b173315`、`fe5b02a3`、`d033aa8a`、`1bbd945c`、`72781e97`、`6f6c1443`、`8c0c3be8`。

进一步核对实际源码，而不只看补丁：

- 冻结正式 `v6.1111.2^{commit}` 为 `c4d39ddff04296f66ec80ae72459bb9c8ce2d15f`（tag 对象自身为 `c81dccc4`，两者不能混用）。与 main 基线逐文件比较 `src-tauri/src/sumi`、`tauri-plugin-native-editor`、`plugins-src/write/src`、`plugins-src/write/backend`、`scripts/sumi`，差异列表为空。因此这些既有 Sumi 宿主/插件运行时源码没有新增差异；不在本轮重新宣称为新功能。
- `6d9233a0` 的九个后台/UI/测试文件与 main 完全一致；manifest 因后来分类及版本更改而不同。`23e4ad11` 的品牌 spec 与 `scripts/sumi/verify-release.py` 完全一致，其余是已更新的历史报告/日志。没有据此推定所有发布元数据逐字相同。
- 对 `src/lib/plugins/categories.ts`、`src/plugin-market-app.svelte`、`src-tauri/src/plugin_host.rs`、`src-tauri/src/plugin_runtime/adapter.rs`、`scripts/gen-plugin-index.mjs`，main 与冻结 v6.1111.2 的差异列表为空。分类能力已经在上一宿主公开。
- `b88edb93` 的 Sumi/Idea Spark manifest 与 package.json 四文件都与 main 完全一致；其旧单页发布报告未保留在同路径，main 已有后续受控发布报告，不因此复活旧文档。
- `93a82534` 的三款 package.json 与 main 一致。Apple Notes、Roam manifest 解析为 JSON 后完全一致（仅格式差异）；Health manifest 仅日、德 description 不同，main 保持后续 SQLite 外部库说明，不回退旧描述。其六个已公开包的再打包不属于这次宿主请求。

## 唯一 stash

`stash@{0}` = `03d8a9ff3cc5c25552040fda41a2531ee3c1ac5c`，说明为 `On main: codex-before-git-pull-2026-11-10`，父提交 `2a1b2a12`，另有未跟踪树 `9d1bdc31`。没有 apply、pop 或 drop 此 stash。

受跟踪补丁共 17 文件、276 行新增/33 行删除：

- 两份 CHANGELOG 与 `docs/superpowers/specs/2026-11-07-immersive-write-design.md`：旧五行/57% 聚焦与状态隐藏说明。
- `plugins-src/write/src/contract.ts`、`main.test.ts`、`main.ts`、`style.css`：聚焦设置字段、默认开启、设置保存测试及状态栏隐藏。
- `scripts/sumi/build.mjs`、`scripts/sumi/native/build.rs`、`scripts/sumi/run-native.mjs`、`scripts/sumi/verify-release.py`：focus.h/probe 构建与证据输入。
- `src-tauri/src/sumi/mod.rs`、`tauri-plugin-native-editor/build.rs`、`tauri-plugin-native-editor/native/editor.m`、`tauri-plugin-native-editor/src/lib.rs`：旧版聚焦配置、迁移与原生呈现桥。
- `searchidx/src/store.rs`、`src-tauri/src/smart_lookup.rs`：原有 EOF 换行差异。

未跟踪树恰含 `tauri-plugin-native-editor/native/focus-probe.m`、`tauri-plugin-native-editor/native/focus.h`。这两文件当前已受版本控制，但其内容都与 stash 不同。

只读 `git apply --reverse --check` 对 stash 补丁返回 1（多处上下文不适用），因此没有宣称 stash 整体已合入或完全等价。其五行/57% 方案与后续已记录的现行居中渐隐设计不同；本轮不自动复活历史 WIP。已公开 v6.1111.2 与 main 的上述 Sumi 源码一致，是排除额外 Sumi 源码改动的具体依据；不是 stash 全等证明。

## 本轮新增与日志校对

相对正式 v6.1111.2，主要新增宿主能力为完整 Smart Lookup enhancement / SAG2 / answer-first：本地立即检索、分轮找依据、自动回答与编号引用、逐主机许可及保密门禁、零命中改写/扫描、CLI lookup/eval 与参数说明。当前未发布的中英日志已经覆盖这些主题。Faitc5 `.14` 配套批准与公开下载验证在 `3c055387`、`71280e18` 中；日志有配套条目。

发现并已最小修正（主代理提交）：当前 main 的中英历史曾从未发布直接跳到 v6.1110.8，缺少隔离分支已经公开的 v6.1111.1/.2 章节。本次从冻结 v6.1111.2 提取两章补回；仅将 .2 过宽的“旧分类全部进 Other”改为已知别名映射对应工作流、未知进入 Other，遵守上一版报告已经指出的更正。Faitc5 `.14` 开头由“下次发布”改为“本次 macOS 宿主发布”，其余当前未发布内容保留。

`node scripts/changelog.mjs check` 输出 `changelog ok`；两份日志 `git diff --check` 通过。

此审计不证明新安装包、签名、公证、更新签名或公网附件；这些须由最终冻结 tag 和真实产物验收。没有将用户后续要求解释为重新发布 Linux/Intel/Windows 或已有插件包。
