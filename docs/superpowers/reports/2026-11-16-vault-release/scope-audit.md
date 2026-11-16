# Vault 重新发布范围审计

审计日期：2026-11-16。审计基线：`main` / `83638b30ed03d5198ed7ef3da467aceafcf01a9f`。用户更新 Apple 协议后要求重新发版；本报告仅核对发布输入范围，不证明协议已经生效、公证成功、候选已构建或公开。最终版本号和冻结提交由主线程的发布记录确定。

审计计划与验证：重新枚举 worktree、所有本地分支及 stash 三父树；对照 [11 月 14 日审计](../2026-11-14-vault-release/scope-audit.md) 核对变化和补丁等价；回读远端历史 tag 及新 Fcitx5 预发布身份；只写本文，不修改产品、不提交、不应用旧分支或 stash。

## 相对上次审计的变化

- 原实现基线 `d56a538f97afe2870085581a5d75eac2624d37f7` 之后只有 `19d9cf7b`（记录 Apple 协议阻塞）与 `83638b30`（核实历史公证路径同样返回 403）两条提交。`git diff --name-only d56a538f..main` 仅含 11 月 14 日发布目录内 README、blocked-candidate.json、direct-notary-recheck.json 和 scope-audit.md，产品源码没有变化。
- 审计时 `git log origin/main..main` 为空；该比较针对当前本地 origin/main 引用。本报告不将远端引用比较当作安装包验证。
- 四条历史 release 分支、唯一 stash 及原两处 EOF 修改均未改变；没有新增待合入产品分支。
- 新增公开测试预发布 `fcitx5-v0.5.0.15-build.20261115`，它不是仓库批准的 companion，详见后文。

## Worktree 与独立 clone

主仓库 `git worktree list --porcelain` 仅有 `/Users/bruce/git/mdeditor`，分支 main，HEAD 为上述基线；没有其他登记 worktree。写本文之前 `git status --short --untracked-files=all` 仅有以下两项，无未跟踪文件：

| 文件 | 已核对差异 | 本轮决定 |
| --- | --- | --- |
| `searchidx/src/store.rs` | 文件末尾换行移除 | 保留原工作区修改，排除出发布源码与提交。 |
| `src-tauri/src/smart_lookup.rs` | 文件末尾换行移除 | 保留原工作区修改，排除出发布源码与提交。 |

本文是本轮新增、未提交的证据文档。其他代理随后产生的发布文件不属于上述初始快照，冻结前由主线程再次核对。

两处上次已知独立 clone 也重新核对（不是主仓库新增 worktree）：

| 仓库 | 本地引用 | 工作区 / stash | 范围判断 |
| --- | --- | --- | --- |
| `../mdeditor-sumi-ime-host` | `release/sumi-ime-macos-6.1110.8` HEAD `7437e6feddb0218c8bf42cc5b6cb17903d5954e5`；main `5908e8b1d0d05c58fa2cc1a195161f240d8d2134` | 仅一个 worktree，clean，无未跟踪文件，无 stash | 两个提交均经 `merge-base --is-ancestor` 确认属于本轮 main；无额外待发布功能。 |
| `tasks/vault-release-20261114/source` | main / `83638b30ed03d5198ed7ef3da467aceafcf01a9f` | 仅一个 worktree，clean，无未跟踪文件，无 stash | 与审计基线相同。其生成目录仍按原发布准备规则管理。 |

## 本地分支未合入提交

本地共五条分支：main 与下列四条 release 分支。重新执行 `git cherry -v main <branch>`；patch-id 计数与 11 月 14 日一致。上次实现基线到当前 main 没有产品源码变化，因此上次逐文件语义核对仍适用；本次又重跑分类生成器及测试的逐字比较。

| 分支 / HEAD | 非祖先提交与补丁等价 | 实际功能与发布证据 | 决定 |
| --- | --- | --- | --- |
| `release/capture-plugins-20261111` / `93a8253490c7e649cceb4108c11c22d747192e32` | 共 1；0 等价 / 1 不等价 | Apple Notes、Roam manifest 解析后与 main 相同；Health Sync 主线说明较新；版本分别 1.0.5、1.2.8、0.2.3 已在 main。远端 `plugins-capture-20261111` 指向此 HEAD；受控发布记录为 `2026-11-11-workflow-group-release/README.md`。 | 已发布历史引用，保留，不合并、不重发市场插件。 |
| `release/plugins-20261111-create` / `b88edb93c5c09611ad9d888177b3814ce2ab3d64` | 共 1；0 等价 / 1 不等价 | Idea Spark manifest/package 与 main 一致，1.3.9；此分支 Sumi 0.1.15 已被 main 0.1.16 替代。远端 `plugins-create-20261111^{}` 指向此 HEAD；main `4805a39a` 与 `2026-11-11-creation-plugin-release/README.md` 记录公开。 | 已发布历史引用，保留，不回退、不重新发布。 |
| `release/sumi-20261111` / `a56e861dd71708feb98a623a50dc45bd73b8300d` | 共 16；12 等价 / 4 不等价 | 聚焦、候选区、全屏、字体、云回声持久身份、快捷键声音等已等价纳入；品牌由 main `4938ba27` 等纳入，后续使用正确 Fcitx5 名称。远端 `v6.1111.1^{}` 仍指向此 HEAD。 | 已发布历史宿主引用，保留，不重放旧版本冻结。 |
| `release/writing-groups-20261111` / `c4d39ddff04296f66ec80ae72459bb9c8ce2d15f` | 共 23；16 等价 / 7 不等价 | 本次确认 `scripts/gen-plugin-index.mjs`、`scripts/gen-plugin-index.test.ts`、`src/lib/plugins/categories.ts`、`src/lib/plugins/categories.test.ts` 四文件与 main 逐字相同。远端 `v6.1111.2^{}` 仍指向此 HEAD。 | 已发布历史宿主引用，保留，不回退主线。 |

Sumi 的四条非等价提交为 `5e197ce4`、`6d9233a0`、`23e4ad11`、`a56e861d`，属发布版本、冻结说明或品牌 manifest 邻行上下文差异。Writing 分支另有 `ad535d04`、`444c24f3` 分类整合上下文差异，以及 `c4d39ddf` 版本冻结。它们不是仅凭祖先关系判定的未交付功能。

历史公开状态沿用 11 月 14 日实时回读证据：[v6.1111.1](https://github.com/wizlijun/note.md/releases/tag/v6.1111.1) 公开于 `2026-11-11T04:08:20Z`；[v6.1111.2](https://github.com/wizlijun/note.md/releases/tag/v6.1111.2) 公开于 `2026-11-11T05:24:24Z`，当时均非 draft。本次重新回读远端 tag 目标未变，不将历史公开时间冒充本次新回读。

## Stash 三父树

唯一 stash 仍为 `stash@{0}` / `03d8a9ff3cc5c25552040fda41a2531ee3c1ac5c`，`On main: codex-before-git-pull-2026-11-10`。

三父提交不变：基线 `2a1b2a120b5d17230ee2d5f0e15955a04df7f1e1`；index `ebea208d352bf5ada631762ea4ea5d5e61b76b7a`；未跟踪树 `9d1bdc31289fc678e73a42c984b8d48cb297962e`。

重新枚举的 17 个受跟踪文件：

- `CHANGELOG.md`
- `CHANGELOG.zh-CN.md`
- `docs/superpowers/specs/2026-11-07-immersive-write-design.md`
- `plugins-src/write/src/contract.ts`
- `plugins-src/write/src/main.test.ts`
- `plugins-src/write/src/main.ts`
- `plugins-src/write/src/style.css`
- `scripts/sumi/build.mjs`
- `scripts/sumi/native/build.rs`
- `scripts/sumi/run-native.mjs`
- `scripts/sumi/verify-release.py`
- `searchidx/src/store.rs`
- `src-tauri/src/smart_lookup.rs`
- `src-tauri/src/sumi/mod.rs`
- `tauri-plugin-native-editor/build.rs`
- `tauri-plugin-native-editor/native/editor.m`
- `tauri-plugin-native-editor/src/lib.rs`

第三父树 2 个当时未跟踪文件：`tauri-plugin-native-editor/native/focus-probe.m` 与 `tauri-plugin-native-editor/native/focus.h`。

其主题是早期 Sumi 聚焦、安静通知、构建输入绑定及原 EOF 修改。核心功能 `710c148c` 重新确认是当前 main 的祖先，并已在历史 `v6.1111.3` 中；原生聚焦文件已有后续迭代。上次仅部分反向补丁检查等价，不声称整份 stash 逐字合入。决定保持 stash、不应用、不删除，不以旧草稿覆盖主线。

## Fcitx5 companion：排除新增测试预发布

本次通过 GitHub REST API 重新回读两项 release，元数据如下。首次 GraphQL release 列表因 TLS handshake timeout 失败，改用精确 tag 的只读 REST 查询后成功；没有发布动作。

| 项目 | 仓库批准的正式 companion | 新增测试预发布 |
| --- | --- | --- |
| tag | `fcitx5-v0.5.0.15` | `fcitx5-v0.5.0.15-build.20261115` |
| GitHub 状态 | draft=false，prerelease=false | draft=false，prerelease=true |
| 公开时间 | `2026-11-12T05:27:32Z` | `2026-11-15T17:25:17Z` |
| pkg 文件名 | `Fcitx5-for-Sumi-0.5.0.15-arm64.pkg` | 同名 |
| 字节数 | 61,312,645 | 61,310,388 |
| pkg SHA-256 | `f75d72fa51efa50d09412b956453a0f36f59ced8a47f501bab148867f10c4299` | `53b1b9d89ed3440c031f458083fba90e759ff8f8637a412ddd401b9a6cbe372c` |
| 审批元数据资产 | `fcitx5-companion.json`，372 bytes | `build-manifest.json`，2,267 bytes |

新预发布远端 tag 指向 `83638b30ed03d5198ed7ef3da467aceafcf01a9f`。这个 tag 指向 note.md 主线并不使其 pkg 自动成为批准 companion，也不表示宿主安装包包含该测试输入法。

仓库 `scripts/release-companions/fcitx5.json` 仍固定正式版本 `0.5.0.15`、源码 `2f561d84463a225f89acd1cf6f9e561c575642da`、61,312,645 bytes 与 SHA `f75d72fa…`，并记录 appNotarized=true / packageSigned=false。主目录 `~/Downloads/Fcitx5-for-Sumi-0.5.0.15-arm64.pkg` 本次实际读取字节数与 SHA 完全符合该批准记录；旧发布 clone 内批准 JSON 的 SHA 为 `dfe3c834ccd645899a928e7082d2cdfe8be5828f4a3c5cb07b9d92d059c8d05f`，也与正式 GitHub 资产 digest 一致。

`release-companion.mjs` 按批准文件名、大小和 SHA 暂存，不挑选最新下载；`release-publish-core.mjs` 再对已上传 manifest 全字段和实际包回读校验。因此即使同名，测试预发布不能替换正式批准包。本次排除该预发布，不改批准 JSON、不下载或重发测试包。正式发行最终仍须对实际附带包重新回读，本文只证明审计时本地批准输入和远端元数据。

参考：[正式 companion](https://github.com/wizlijun/note.md/releases/tag/fcitx5-v0.5.0.15)、[测试预发布](https://github.com/wizlijun/note.md/releases/tag/fcitx5-v0.5.0.15-build.20261115)。

## 追加核查：测试预发布不是新公证成功证据

父线程在本轮公证恢复时仍收到协议 403，因此追加检查昨日测试包是否存在更新的成功通道。精确 release body 明确说明“此构建尚未通过 Apple 公证”，其公开 `build-manifest.json` 同时记录 `notarized: false`、`signing_team: T5G56DH47L`、`app_signature: Developer ID Application`、`installer_signature: unsigned`，源码为 `d71b28468885404d5d21b2ff1939c650aa66958d`。由此只能证明同团队签名的未公证构建公开为测试预发布，不能提供 11 月 15 日新 Accepted，也不能据此断言该日公证凭证通道可用。

本次找到的最近 Fcitx5 成功证据仍是 11 月 12 日正式包：

- 本地原始日志 `../fcitx5-macos-sumi/logs/fcitx5-name-correction-20261112/notary.log` 包含 `Successfully uploaded file` 和最终 `status: Accepted`，submission 为 `85a89706-8105-4bf4-9c8d-56a145093688`，归档为 `~/Fcitx5-Releases/0.5.0.15/notary-app.zip`。
- 受版本控制的 `docs/superpowers/reports/2026-11-12-fcitx5-name-correction/ime-package-verification.json` 将该 submission 绑定至正式源码 `2f561d84463a225f89acd1cf6f9e561c575642da`，归档 SHA `4888664b0ec481973917fac6d8b89d7a8b09c58c237665e491690f7f5feee3b7`，正式 pkg SHA `f75d72fa…`；记录实际展开包的严格签名、装订票据、Gatekeeper `accepted / Notarized Developer ID` 通过。
- 该正式构建的 `~/Fcitx5-Releases/0.5.0.15/developer-id/signing-receipt.json` 记录签名团队 `T5G56DH47L`，与测试构建及本轮宿主团队一致。此 receipt 与目录 manifest 生成于公证之前，其旧 `notarized: false` 不是最终状态，最终状态采用上面的原始 Accepted 日志和实际展开包验收。
- 已检查资料没有保留可安全确定旧 submission 使用哪个 Apple ID 或 keychain profile 的证据；同签名团队不证明同一公证凭证。此次未读取或输出任何凭证，不能将账户通道推断为已确认。

结论：11 月 15 日测试包不能反驳当前协议 403，也不提供可切换的新成功公证路径。11 月 12 日的 Accepted 是历史成功证据，当前服务端可用性须另行验证。

## 本轮范围决定与回顾

纳入当前 main 已提交的 Vault 功能：单个状态化主菜单入口、首次运行引导、设置中的 Vault 管理及 Git 初始化/同步、受保护的位置更改、欢迎页路径/文档数/内容大小、用户路径 `~` 缩写。实现/设计提交 `f818cf6f`、`f5a02521`、`e24ab827`、`0dd14c4f`、`d56a538f` 均重新确认是当前基线祖先；产品源码与上次审计一致。

发布范围仍为 Apple Silicon 宿主及仓库固定批准的 Fcitx5 companion；市场插件不重发。旧分支和 stash 保留；原两处 EOF 排除；新增 Fcitx5 测试预发布排除。没有从这些历史引用发现需补入的 Vault 产品改动。

审计步骤已完成；本文未提交，由主线程整合。最终冻结 tag、未发布日志、实际签名包、公证结果、安装交互与公网回读必须另有验收证据，不能由本报告替代。用户已更新协议是恢复公证检查的依据，不是公证成功证据。
