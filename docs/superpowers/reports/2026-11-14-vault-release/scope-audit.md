# Vault 发布范围审计

审计日期：2026-11-14。候选范围：note.md `v6.1114.1`，Apple Silicon 宿主；本报告不证明候选已经构建、公开或安装。市场插件不在本轮范围，不重新发布。

审计基线：`main` / `d56a538f97afe2870085581a5d75eac2624d37f7`。执行只读 Git 审计、补丁等价检查、实际文件比较和历史公开状态回读；未合并旧分支、未应用或删除 stash。最终写入本文前再次检查 `origin/main..main` 无提交，表示主线程已同步这批提交到远端。

## 工作区与当前未提交改动

`git worktree list --porcelain` 仅有 `/Users/bruce/git/mdeditor`，分支 `main`，HEAD 为上述基线。不存在其他活动 worktree。此前四条目录已不存在的 worktree 登记已清理，对应分支引用保留。

写入本报告前 `git status --short` 仅有：

| 文件 | 实际差异 | 本轮处理 |
| --- | --- | --- |
| `searchidx/src/store.rs` | 既有文件末尾换行移除 | 保留，排除出构建源码与提交。 |
| `src-tauri/src/smart_lookup.rs` | 既有文件末尾换行移除 | 保留，排除出构建源码与提交。 |

无未跟踪代码文件。本报告是本轮新增证据文件，由主线程整合提交，不因此把主工作区描述为完全 clean。

## 当前主分支本轮内容

Vault 设计与实现提交：`f818cf6f`、`f5a02521`、`e24ab827`、`0dd14c4f`、`d56a538f`。它们包含用户确认的单个 Vault 菜单入口、首次引导、桌面管理设置、受保护的位置变更、可选 Git 初始化与同步控制、欢迎页文档数/内容大小、`~` 路径显示，以及测试与实施验证记录。

实现基线未改变原有两处 EOF 工作区差异。`CHANGELOG.md` 和 `CHANGELOG.zh-CN.md` 的未发布区有 Vault 条目。发布冻结后仍须由主线程用实际 tag 源码与包内产物核对，不以本报告或工作区测试代替包验证。

## release 分支逐项核对

仅凭祖先关系会将已重写或 cherry-pick 的历史提交误判成漏发；本次同时运行 `git cherry -v main <branch>`、比较关键文件，以及回读远端 tag 和公开发行。

### `release/capture-plugins-20261111`

- HEAD：`93a8253490c7e649cceb4108c11c22d747192e32`。
- 相对 main 有 1 个非祖先提交，patch-id 不等价；其内容是三个捕捉插件的版本/分类冻结及 JSON 排版变化。
- Apple Notes 与 Roam manifest 和 main 的解析后 JSON 完全一致；Health Sync 仅 main 的日语、德语说明较新。三个 package 版本与 main 相同：Apple Notes `1.0.5`、Roam `1.2.8`、Health Sync `0.2.3`。
- 远端 `plugins-capture-20261111` 精确指向此 HEAD。
- main 上受版本控制的证据：`docs/superpowers/reports/2026-11-11-workflow-group-release/README.md`，明确已公开三个插件双架构包，并完整回读验签；main 整合提交 `06c337ea`、发布记录 `0e98b91c`。
- 决策：历史已发布引用，保留，不合入旧快照，不重新发布插件。

### `release/plugins-20261111-create`

- HEAD：`b88edb93c5c09611ad9d888177b3814ce2ab3d64`。
- 相对 main 有 1 个非祖先提交，patch-id 不等价。Idea Spark 的 manifest/package 与 main 逐字一致，版本 `1.3.9`；Sumi 已从此分支的 `0.1.15` 升至 main 的 `0.1.16`。
- 远端 `plugins-create-20261111^{}` 精确指向此 HEAD。
- main `4805a39a` 已记录实际公开。证据为 `docs/superpowers/reports/2026-11-11-creation-plugin-release/README.md` 及同目录包、索引、真实原生进程验证数据。分支中的旧“发布准备”文档不是当前发布状态，不应重新并入。
- 决策：历史已发布引用，保留；本轮不回退插件版本、不重新发布市场包。

### `release/sumi-20261111`

- HEAD：`a56e861dd71708feb98a623a50dc45bd73b8300d`。
- 相对 main 有 16 个非祖先提交：12 个 patch-id 等价；4 个不等价为 `5e197ce4`、`6d9233a0`、`23e4ad11`、`a56e861d`，涉及发布版本、冻结说明和品牌 manifest 的版本邻行冲突。
- 聚焦、候选区、全屏、字体、云回声持久身份与快捷键声音等源码提交已补丁等价纳入 main。品牌实际改动由 main `4938ba27` 等纳入，后续又已统一为正确的 Fcitx5 命名。冻结版本/说明不应覆盖更新后的主分支。
- 远端 annotated tag `v6.1111.1^{}` 精确指向此 HEAD；`gh release view` 实时回读 `isDraft=false`，公开时间 `2026-11-11T04:08:20Z`。
- 公开发行：<https://github.com/wizlijun/note.md/releases/tag/v6.1111.1>。
- 决策：历史宿主发布分支，保留；不作为本次未交付功能重新合入。

### `release/writing-groups-20261111`

- HEAD：`c4d39ddff04296f66ec80ae72459bb9c8ce2d15f`。
- 相对 main 有 23 个非祖先提交：16 个 patch-id 等价，7 个不等价。除上述 Sumi 的 4 个冻结差异，还包含 `ad535d04`、`444c24f3` 的分类整合上下文差异以及 `c4d39ddf` 的版本冻结。
- 实际比较 `scripts/gen-plugin-index.mjs`、对应测试、`src/lib/plugins/categories.ts`、对应测试：这四个文件与 main 逐字相同。插件分类与版本已在 main 整合；不应把 patch-id 差异当作产品功能缺失。
- 远端 `v6.1111.2^{}` 精确指向此 HEAD；`gh release view` 实时回读 `isDraft=false`，公开时间 `2026-11-11T05:24:24Z`。
- 公开发行：<https://github.com/wizlijun/note.md/releases/tag/v6.1111.2>。main 证据位于 `docs/superpowers/reports/2026-11-11-workflow-group-release/`，整合记录提交 `0e98b91c`。
- 决策：历史宿主发布分支，保留，不回退主分支。

## Stash：完整三父树审计

唯一 stash：`stash@{0}`，`03d8a9ff3cc5c25552040fda41a2531ee3c1ac5c`，说明为 `On main: codex-before-git-pull-2026-11-10`。

其父提交分别为基线 `2a1b2a120b5d17230ee2d5f0e15955a04df7f1e1`、index 树 `ebea208d352bf5ada631762ea4ea5d5e61b76b7a`、未跟踪文件树 `9d1bdc31289fc678e73a42c984b8d48cb297962e`。第三父树不能省略审计。

受跟踪文件共 17 个，按主题列出：

- 发布记录：`CHANGELOG.md`、`CHANGELOG.zh-CN.md`、`docs/superpowers/specs/2026-11-07-immersive-write-design.md`。
- 写作插件：`plugins-src/write/src/contract.ts`、`main.test.ts`、`main.ts`、`style.css`。
- 构建/验证：`scripts/sumi/build.mjs`、`scripts/sumi/native/build.rs`、`scripts/sumi/run-native.mjs`、`scripts/sumi/verify-release.py`。
- 宿主：`searchidx/src/store.rs`、`src-tauri/src/smart_lookup.rs`、`src-tauri/src/sumi/mod.rs`。
- 原生编辑器：`tauri-plugin-native-editor/build.rs`、`tauri-plugin-native-editor/native/editor.m`、`tauri-plugin-native-editor/src/lib.rs`。

第三父树包含 2 个当时未跟踪文件：`tauri-plugin-native-editor/native/focus-probe.m`、`tauri-plugin-native-editor/native/focus.h`。两者已在 main 存在，并继续演进。

此 stash 是早期 Sumi 聚焦打字、安静通知与构建输入绑定草稿，加既有 EOF 修改。核心功能已由 `710c148c`（Complete Sumi focused typing and quiet notices while preserving local durability）纳入 main，且该提交也是已发布 `v6.1111.3` 的祖先。其后还有字形缓存、聚焦滚动、候选区等修正，不能恢复旧草稿覆盖新实现。

只读反向补丁检查证明部分构建输入补丁已存在；其余文件因后续实现、版本或测试更新，不再精确补丁等价。因此本次不声称整个 stash 逐字已合入，但它不是本轮 Vault 发布输入。决策：保留 stash 不应用、不删除；不恢复旧聚焦算法、旧文案或旧版本号。

## 本轮范围决定

准备 `v6.1114.1` Apple Silicon 候选，发布基于当前 main 的已提交内容。Vault 功能需在冻结 tag 与实际包中逐项验证。旧 release 分支和 stash 均保持为历史证据；原两处 EOF 修改留在工作区；市场插件不重发。平台范围、签名/公证、安装包真实交互和公开回读结果由本目录其他发布证据记录，不由本次范围审计代替。

## 发布准备补充核查

- 已知独立 clone `../mdeditor-sumi-ime-host` 仍只有一个 worktree，HEAD `7437e6fe`，另一本地 main `5908e8b1`；无 dirty/untracked、无 stash。两个提交都已是本次基线祖先，无额外待发布功能。
- 本轮使用 `tasks/vault-release-20261114/source` 独立干净 clone，避免触碰主目录原两处 EOF 改动；它不属于新增 worktree。其依赖从本次已验证 node_modules 用 APFS clone 复制并记录本地 core 的73文件哈希，不运行会重建主依赖的 install。
- 该 clone 的 `src-tauri/target` 指向主仓库可重建构建目录，单一发布进程使用；`.git/info/exclude` 仅排除此生成目录软链。正式 App/DMG/更新包均在构建后单独回读校验。原发布历史证据和历史包未删除。
- 为释放空间仅清理可重建 debug incremental/deps 缓存；保留源码、stash、正式签名包及历史报告。
