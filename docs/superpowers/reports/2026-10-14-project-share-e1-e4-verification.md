# E1–E4 本地交付验收（Task8）

记录日期：2026-10-14。本文逐gate记录实际执行UTC时间；文件名日期不是验收证明。

**状态：本地软件候选已验证，等待 Task8 combined review 与唯一 whole-phase final。8.4 跨端IME未闭合；8.5–8.7生产外发、双架构签名包与公网回读仍pending。** 没有push、deploy、读取发布凭据、安装/升级依赖或新建worktree，不能据本文宣称已发布。

## 输入与改动

- HOST BASE `2037fc94a256a31261a710dbcfc5368ca864d258`；Task1–7已受理，本任务不重开。Task7后继修复已在此BASE。
- CORE BASE `3e06f1a6b693f5bd807796b0b36961c446a0af7c`；Task8 CI-only提交 `97fcc3e41f1791c763effe9de880cf4302feea32`，源码/dist/package/lock未变，installed每个声明JS/DTS出口与CORE committed bytes一致。真实默认Node gzip=104042 / 104448 bytes；超限192078 bytes样本被原CI代码exit1拒绝。没有CORE tag/npm发布。
- 全部发行范围复用 `OWN/task-8-release-scope-refresh.md` 的冻结refs/worktree/stash及补丁等价证据，追加Task7和本任务实际增量；Memory/Rich rewrite已在旧tag的事实保留。LatestCreated10此前不在v6.1013.2，本次Rust 6项测试含明确10项断言，仍须新tag与实际包复核。
- 既有release.sh只扩展精确保留清单、empty-envDir、冻结kit和包内完整payload核验，删除APPLE_ID日志。默认clean仍严格；清单只允许精确SHA文件及既有`.pnpm-store`目录，不递归备份缓存；拒tracked/staged/未知untracked/变化清单。最终精确add仍为原六版本/日志文件。
- 原六正式发行强制门槛全部保留，无receipt/skip/reuse分支。此次本地全量之后，仅追加清单自身原文冻结/cmp与cleanup；后继81项release focused、bash语法和真实cmp变异反例通过，未改应用runtime。
- 同一`NOTEMD_EMPTY_ENV_DIR`入口覆盖HOST Vite/Vitest与Memory Vite/Vitest；目录必须存在且为空，变量缺省保留开发行为。正式两架构及retry由shell继承，pnpm显式禁止隐式install。
- Memory唯一插件runtime增量候选版本2.5.3，manifest/package/版本测试一致，Host最低版本仍>=6.906.1。双语日志已合并成单一Unreleased，清理重复和过时“未接线”，列完整功能及真实待验边界。

`OWN` = `.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery`。所有gate原始argv/cwd/start/end/exit/stdout/stderr在`OWN/evidence/<label>/`，完整工具initial/session/final在同目录`<label>.tool.json`；原失败未覆盖。安装出口、fixture committed blob、全部kit资产SHA/SRI、六保留文件SHA与cache存在性在`task8-final-runtime-inputs/runtime-inputs.json`。

## 真实用户链：软件分段闭环

实际录制程序：`scripts/record-project-share-delivery.mjs` 与 ignored 的 `src-tauri/tests/project_share_delivery.rs::record_project_share_delivery`。ignored仅防默认套件启动副作用，Task8显式执行编译后的test binary。测试根由driver独占创建标识，Rust只接受显式参数及标识根内vault/state/source/request/output，不从真实app设置寻找Vault。未增加生产RPC/feature/依赖。

成功gate：`task8-browser-chain-durable-observer`，Chromium 140.0.7339.16。主人环节是实际Rust API调用，并非原生UI点击；Worker是本地真实Miniflare R2/KV/DO，未用手写HTTP mock替代。

1. 实际ProjectStore open/read/snapshot批准两个Markdown及一个PNG（入口和完整快照分别冻结），实际bundle存盘；生产buildProjectBundle/buildProjectArchive/createArtifactPlan生成HTML/source ZIP及分片计划，经真实Worker begin/part/seal/commit发布S1。
2. 匿名只读页面零kit请求，匿名ZIP回读与上传逐bytes相同。后继实际unzip核仅README.md、docs/note.md、pixel.png；未批准文件未入包。
3. 本次IIFE真实Rich/Source往返、slash插入Table/Math、选文批注；菜单hover实际accent背景+白字。两处改动撤一处后提交；源码记录/截图均保留。
4. 浏览器原HTTP body独占保存，真实Worker envelope.requestHash与其SHA相同，直接把该envelope文件交ProjectStore.feedback/review。真实merge propose/acceptUnconflicted/compose输出原样进入review_save/apply，回读磁盘精确匹配，不手写等价apply。
5. 实际buildProjectReceipt投影经Worker PUT/GET，浏览器显示已合入；ProjectStore冻结/真实Worker发布S2，再完成rebase取消、迁移、撤销和导出。导出JSON实际断言仍是S1及精确未提交正文。旁文与PNG磁盘SHA均不变。

所有原body/envelope/merge结果/逐次Rust argv与exit/ZIP/网络/截图/磁盘位于成功gate目录。final-artifact-chain在完整build后再次确认同一kit bytes、批准文件清单、导出正文、原HTTP/Worker envelope绑定和实际disk SHA；不重跑未变化链路。

| 证据对象 | SHA256 / 标识 |
|---|---|
| s1 | `281c54fc-ec2e-4687-928c-d7f7726da56b` |
| s2 | `7443fe8b-5c75-4c82-9370-bf23cb550652` |
| submissionSha256 | `7e6b6ebf1ffabaa7fd5d42896901ce250ae3c50583a8fe2a04b7153d4a3240f4` |
| envelopeSha256 | `71404a548d05129e4fc2dc280900c5c69dacb439db12b8262a8835c012563495` |
| receiptSha256 | `018e34207ec122ab8cbf61640b516a78ddd0653d5fe2e0cb062560dde3f8f7c9` |
| sourceSha256 | `2bf84e08b56352347c743b7c463ecf107b72437fdb002ca03ff0affc3b198c4c` |
| unchangedNoteSha256 | `3a735dfec55633936cdadf42e3c9fbc06950b9bfc737c912ef22b86c8436993f` |
| unchangedAttachmentSha256 | `9b4de411786c924cd8f94bf7ddf3d947f7bca470bf5c67600de725ed0909f4f6` |
| exportSha256 | `7b47e2520f28c47d3e013b27bf6bb996781b9c7678defea743a8d2e0542e45ae` |

主要截图：`readonly.png`、`editing-controls-note.png`、`one-hunk-reverted.png`、`receipt.png`、`rebase-undo-export.png`。最后截图已人工查看，旧版未提交提示、Rich正文与导出控件清晰可读。

## 软件门槛与候选资源

HOST完整384文件/4826项通过；累计严格svelte-check 0 errors/29 warnings，生产check 0 errors/31 warnings。完整empty-env build、purity、existing Editor Kit、share IIFE静态图与SHA/SRI检查通过。Rust owner124、guest41、LatestCreated6、原生链接分类1项通过；Worker全量10文件/488项通过。Memory12文件/158项、check/build及实际unsigned安装布局ZIP验证通过。

IIFE gzip593243 / 921600 bytes；API版本保持share1/documentEditor2，MERGE_KERNEL_VERSION=1未改。manifest与Task7同bytes；三资产：
- JS SHA256 `4832a3eed7a0b800150ec52af4a3ad559d9e42d664abd9cf4c2d74c45338601c`
- CSS SHA256 `36489809fe831b96d033eb2c84c90e6f26275fc4c5ba62c09259f942793a6e6b`
- Mermaid SHA256 `62fdacdc210de8e12c8cd3c143542c058cf78b756a271a1446ed394b0e9a6cac`

Memory unsigned ZIP SHA256 `ebeb48ba139efc9af4d71efcffad9ae9ba237b69a1a5729e73aeb53551b976c1`。解包后manifest和全部UI逐bytes等于实际候选；未签名、未上市场。正式发布前须重新核2.5.3占用，不覆盖已公开2.5.2或别人同版本对象。

## 失败、修正与边界

- `task8-release-focused`：新测试未规范化macOS /var→/private/var；旧文本测试硬要求被已批准helper替代的原shell句子。保留原失败，前者改真实realpath期望，后者迁移为helper接线，dirty拒绝由实际临时Git仓库测试覆盖。
- `task8-payload-boundaries`：旧probe正则`.js|.css|.json`把`.json`截成`.js`导致ENOENT。改后缀顺序与完整边界；完整payload阳性、重复、截断、manifest变异拒绝均通过。此阳性是合成容器单测，不是正式Mach-O包通过。
- 浏览器first：pnpm symlink路径createRequire找不到Miniflare，改真实package路径；second：harness遗漏ProjectStore.bundle，published按合同拒绝。third：只改hash未重新加载页面，所以编辑尚未激活，补真实新navigation。
- 浏览器fourth/final/async-observer：录制过早读取异步undo或在Source保存耐久确认前reload；保留错误及完整原阶段结果。最终等待真实Mode，再调用公开buildSubmission的实际确认保存，undo逐次await实际loadDraft；没有改期望/产品来消除失败。
- `task8-memory-tests`：157/158通过，唯一旧版本2.5.2断言按正式2.5.3裁定迁移，158全过。
- `task8-worker-complete`：外置测试config中的相对wrangler.toml指向OWN，未运行测试；改绝对既有配置后488全过。不是Worker功能RED。
- 完整测试保留既有Svelte/a11y、happy-dom/KaTeX/AbortError等日志；构建保留大chunk和混合静态/动态import告警。没有清理无关警告。

原生已有证据按实际时间线引用`OWN/task8-native-event3-report.md`与`OWN/task8-source-argv-report.md`：Rich中文慢速及原节奏保存通过；新原生进程argv重开同一43B文件，真实菜单切Source后UI与磁盘精确43B通过。Source输入只发完整z按键后失焦停止，未发完整zhongwen/Space/cmdS；即时盘43B，后续盘44B末尾z，持久化触发未证，不能称49B中文保存成功或推定产品IME缺陷。两轮进程/端口清理已证。首次cp异常仍未归因。

Japanese有已启用/可选择子模式记录但未实测；不称绝对不存在。Safari/Chrome完整系统中日IME×段落/列表/表格×候选键/模式/undo/关闭重开矩阵未闭合。iOS Safari/Android Chrome无真实设备，保持未验；不以viewport/composition dispatch替代。Windows/Linux注册/真机未验；Windows目录项掉电耐久性不作承诺。此前iOS编译55诊断与旧免费free-upload reseal/status-cleanup各10ms且strict<10ms失败分别保留，不被本次488测试或新路径覆盖。

## 正式外发仍待ROOT

通过Task8 combined review与唯一whole-phase final后，先CORE main源码同步（无tag/npm发行），HOST main push并确认Worker commit→version→100% deployment及新kit路径公网/CPU证据，再按实际发行日冻结应用版本和签名包。此阶段没有实际release tag/Worker version/public asset可填。

受控release入口须提供`--allow-untracked <冻结精确清单>`和`--expected-share-manifest <冻结manifest>`，继承显式empty envDir。两架构每次build/retry前后比manifest原文及全部hash/SRI，真实成功build紧接depfile/cache→Mach-O完整Brotli payload唯一匹配、取回解压核对；tar与DMG内部Mach-O再与已核binary逐bytes一致，任何不符在自动commit/tag/push前失败。此方法只证完整payload包含，不声称runtime PHF选键/正常分享返回已验。当前尚未执行本期双架构正式包证明，ROOT外发时必须补足，不用dist或本次合成单测代替。

原六发行强制门槛届时在实际发行SHA/环境运行；签名、公证、updater、公网匿名下载验签、实际安装分享资源与旧kit/v1兼容分别留证。Memory按现有Wrangler3 Account Token的R2包/签名→匿名验签→KV→公开复核，不换渠道。tasks/todo仅ROOT据实际进展更新，不能将8.5–8.7勾为完成。

## 实际gate索引

| label | 实际开始UTC | exit | 原argv |
|---|---|---:|---|
| task8-release-frozen-list-focused | 2026-10-14T09:00:38.120251+00:00 | 0 | `env pnpm_config_verify_deps_before_run=false NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/empty-env pnpm exec vitest run scripts/release-inputs.test.ts scripts/release-plugins.test.ts --maxWorkers=2` |
| task8-release-final-shell | 2026-10-14T09:00:42.296912+00:00 | 0 | `bash -n scripts/release.sh` |
| task8-preservation-list-mutation | 2026-10-14T09:03:32.382573+00:00 | 0 | `python3 .superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/task8-frozen-list-check.py` |
| task8-payload-boundaries-fixed | 2026-10-14T08:53:28.503967+00:00 | 0 | `node .superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/task8-payload-unit.mjs` |
| task8-core-ci-contract | 2026-10-14T08:43:45.244753+00:00 | 0 | `python3 /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/task8-core-ci-check.py` |
| task8-memory-tests-version | 2026-10-14T08:57:47.676440+00:00 | 0 | `env pnpm_config_verify_deps_before_run=false NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/empty-env pnpm --filter memory-plugin test --maxWorkers=2` |
| task8-memory-check | 2026-10-14T08:57:54.740640+00:00 | 0 | `env pnpm_config_verify_deps_before_run=false NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/empty-env pnpm --filter memory-plugin check` |
| task8-memory-build | 2026-10-14T08:57:57.506228+00:00 | 0 | `env pnpm_config_verify_deps_before_run=false NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/empty-env pnpm --filter memory-plugin build` |
| task8-memory-unsigned-package | 2026-10-14T08:57:59.172299+00:00 | 0 | `python3 .superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/task8-memory-package.py` |
| task8-browser-chain-durable-observer | 2026-10-14T08:56:38.411314+00:00 | 0 | `env NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/empty-env OWNER_TEST_BINARY=/Users/bruce/git/mdeditor/src-tauri/target/debug/deps/project_share_delivery-f56503d60c106107 PLAYWRIGHT_MODULE=/Users/bruce/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs node .superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/task8-browser-chain.mjs` |
| task8-host-complete | 2026-10-14T08:58:07.932367+00:00 | 0 | `env pnpm_config_verify_deps_before_run=false NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/empty-env pnpm exec vitest run --maxWorkers=2` |
| task8-share-merge-purity | 2026-10-14T08:59:39.553672+00:00 | 0 | `node scripts/check-share-merge-purity.mjs` |
| task8-new-tests-strict | 2026-10-14T08:59:40.056261+00:00 | 0 | `env pnpm_config_verify_deps_before_run=false NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/empty-env pnpm exec svelte-check --tsconfig .superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/tests-host.tsconfig.json` |
| task8-host-check | 2026-10-14T08:59:45.266661+00:00 | 0 | `env pnpm_config_verify_deps_before_run=false NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/empty-env pnpm check` |
| task8-host-build | 2026-10-14T08:59:52.122551+00:00 | 0 | `env pnpm_config_verify_deps_before_run=false NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/empty-env pnpm build` |
| task8-rust-owner-complete | 2026-10-14T09:00:42.508131+00:00 | 0 | `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib project_share -- --nocapture` |
| task8-rust-guest-complete | 2026-10-14T09:01:18.997100+00:00 | 0 | `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib share_guest -- --nocapture` |
| task8-rust-latest10 | 2026-10-14T09:01:21.987802+00:00 | 0 | `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib latest_files` |
| task8-rust-native-entry | 2026-10-14T09:01:23.133084+00:00 | 0 | `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib guest_entry_tests` |
| task8-worker-complete-config | 2026-10-14T09:02:38.269270+00:00 | 0 | `env pnpm_config_verify_deps_before_run=false pnpm --dir worker exec vitest run --config /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/task8-worker.config.ts` |
| task8-final-artifact-chain | 2026-10-14T09:03:32.562682+00:00 | 0 | `node .superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/task8-final-artifacts.mjs` |
| task8-final-runtime-inputs | 2026-10-14T09:03:32.726064+00:00 | 0 | `python3 .superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery/task8-runtime-inputs.py` |
