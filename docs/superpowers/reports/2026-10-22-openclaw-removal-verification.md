# OpenClaw 插件彻底移除验收（2026-10-22）

OpenClaw 插件与专属聊天 relay 的源码、线上市场分发均已移除；本地源码、构建产物及本机 app-data 安装目录经核对均不存在。源码提交为 [`53f0caf903c8ec39cd07cb56b274a094f5a832f1`](https://github.com/wizlijun/note.md/commit/53f0caf903c8ec39cd07cb56b274a094f5a832f1)，独立修改 119 个文件，201 行新增、16,343 行删除。市场 Worker 与官网均已从该提交成功部署，公网回读和真实浏览器验收通过。

本次没有重发桌面安装包，没有改写历史发行包或 tag，也没有远程卸载其他用户已有的插件副本。保留用户 Vault、通用插件平台能力、中立的外部工具文件协作介绍及历史发行事实。

## 源码与本地移除

- 删除 `plugins-src/openclaw/` 全部 39 个受控文件，含 Rust 后端、前端、manifest、专属 Cargo 配置与锁文件；删除对应 pnpm workspace importer，没有变更共享依赖版本。
- 删除仅供 OpenClaw 聊天使用的 `mdrelay/` 全部 18 个受控文件，并删除 8 份插件及 relay 专属设计/实施文档。无关的 Syncthing `scripts/setup-relay.sh` 保持不变。
- 删除开发安装、插件构建/发布脚本中的专属入口与分支；旧 `openclaw` 参数在两套脚本中均以 exit 2 拒绝。剩余 25 个 workspace 包没有该插件。
- 清除宿主与市场的专属分类、AI 角色、菜单入口映射、i18n 残留及专属浏览器 fixture；保留通用环境隔离、生命周期、插件窗口与 `host.ui.post` 等共享能力。
- 官网四语生成源及页面、两版 FEATURES、插件开发文档同步清理安装宣传；指向已删除源码的现行示例改为仍存在的插件。历史跨插件迁移设计、审计和发行证明按历史记录保留。
- 本地插件源、relay 源、`dist-plugins/notemd.openclaw-chat`、对应 node_modules 链接和本机 app-data 安装目录的核对结果均为不存在；本机 app-data 安装路径原本不存在，没有执行卸载。私有 relay 源码/本地状态在忽略的任务证据目录内安全归档，归档目录权限 700、文件权限 600；报告不公开 secret 或私有状态内容。

唯一继续用于产品逻辑的退役标识保存在 `plugins-registry/retired-plugins.json`。市场生成器与 Worker 共用该清单：生成器自动排除退役 ID，Worker 同时过滤旧索引并对该 ID 的任意历史下载返回 404。相关回归测试保留退役样例，避免旧索引或旧产物再次上架；没有保留插件实现。

## 索引、对象与专属服务下架

全程沿用仓库既有 Wrangler **3.114.17** 和 Account API Token 通道，没有安装其他 Wrangler、使用浏览器 OAuth 或切换上传渠道。

1. 删除前完整备份公开索引、目标 R2 清单及 12 个包/签名对象。12 个对象均记录实际 SHA-256，6 个包全部通过 minisign 签名验证；现行索引中的 1.0.4 双架构包另与 KV 删除前的 SHA-256 匹配。1.0.0 / 1.0.1 已无现行索引条目，未声称其摘要可与现行索引比对。
2. 生成器直接合并本地 metadata 时会替换 8 个无关插件条目的本地元数据，该输出没有发布。实际发布使用重新读取的线上索引，仅删除目标全部版本，并对其他条目逐项严格核对；索引保持原有仅含 plugins 的结构，没有新增版本字段。
3. 线上 KV 由 **267 条版本记录变为 266 条**，仅移除 `notemd.openclaw-chat / 1.0.4`；其余 266 条记录和顺序完整保留。KV 回读与候选索引一致，候选文件 SHA-256 为 `1972bb20f7fc0c25c1a1594bb713d62086e7d10abce331a4c5f549ac37f4b70c`。
4. 使用相同既有 Wrangler 3，对历史 **1.0.0、1.0.1、1.0.4** 的 Apple Silicon / Intel 包及 minisig 共 **12 个 R2 对象**逐项删除。Account API 对目标前缀的复查结果为空；删除前本地回滚副本和 SHA-256 记录保留。
5. 目标统计 KV key 回读为 404。专属 `mdrelay` Worker 删除前已确认没有外部引用，只有自身 Durable Object 引用；正常删除成功，没有使用 force。Account API 列表无该 Worker，单独读取返回 404。

市场公开下载已由退役策略阻断，即使旧的孤儿对象再次出现，也不能通过市场 Worker 分发。

## 验证结果

| 验证 | 结果与边界 |
|---|---|
| 宿主完整 Vitest | **403 个文件，5,186 条测试通过**；最终重跑使用现有 Rust 1.99 工具链、4 workers |
| 宿主类型/组件检查 | **0 errors，31 条既有 warnings** |
| 生产构建 | 分享纯度检查、分享编辑器构建、Vite 生产构建、Editor Kit 与分享构建校验均通过 |
| 插件市场 | **21 条测试通过**；生产源码 TypeScript 检查通过 |
| 市场整包 TypeScript | 既有 `cloudflare:test` 模块类型错误仍存在；修改前 baseline 已复现，不将其标为通过 |
| 官网 | **5 个文件，93 条测试通过**；重复生成全部公开页面字节不变 |
| 保留的 3 个 Agent UI | Claude / Codex / DeepSeek 真实 UI 入口均通过 Chromium 140 验证，覆盖历史、弹层 hover、键盘焦点、异步设置保存与失败回滚；使用 fixture，没有调用真实账号 |
| 脚本与补丁 | 修改的 JS 语法、shell 语法及 `git diff --check` 通过；旧专属 CLI 参数被拒绝 |

首轮完整测试中，`scripts/linux-bundle.test.ts` 调用 Tauri CLI 时受本机 stable 工具链 cargo 不可用影响，另一个受控 Arch 验证测试在并行负载下超过既有 5 秒限时，原日志保留；显式使用已安装的 `RUSTUP_TOOLCHAIN=1.99.0` 并限制 `maxWorkers=4` 后全量通过，没有修改测试超时、断言或产品逻辑。完整测试日志仍含 happy-dom 页面销毁时的本地资源 fetch/异步任务噪声，最终测试结果为 5,186 条通过。本次没有额外运行完整 Native Cargo 编译/测试，不以浏览器或前端构建结果代替原生安装包验收。

## 实际部署与公网验收

- [市场 Worker CI 39712760224](https://github.com/wizlijun/note.md/actions/runs/39712760224)：`completed / success`，head 为源码提交 `53f0caf9`，最终状态更新时间 `2026-10-22T02:41:49Z`。
- [官网 CI 39712760220](https://github.com/wizlijun/note.md/actions/runs/39712760220)：`completed / success`，head 为同一源码提交，最终状态更新时间 `2026-10-22T02:46:44Z`。

市场侧共 **27 个匿名公网请求全部通过**：

- 普通与绕缓存的 `/api/index.json` 完整 JSON 均严格等于实际发布候选；从旧索引仅过滤目标 ID 后，其余 266 条记录与候选数组严格相等。
- 市场 landing 返回 200，无 OpenClaw 专属映射；其他插件映射存在。
- 12 个历史对象对应的公开下载 URL，各执行 GET 和 HEAD，共 **24 次全部 404**。覆盖上述 3 个版本、双架构及包/签名两类。

真实公网市场使用 **Chromium 140.0.7339.16** 再验英文 1200 px、中文 390 px 两种视图，没有 mock 或网络替换。公开索引响应与候选完整 JSON 一致；两端各渲染 **25 张当前插件卡片**，名称/版本逐项匹配按插件 ID 取最新版本后的结果；无 OpenClaw 可见卡片，其他卡片正常，无 JavaScript 页面错误或横向溢出。两张完整页面截图已查看。

官网部署成功后，对英文、德文、日文、中文的 `/integrations/openclaw/` 页面各执行普通与绕缓存请求，共 **8 个匿名 GET 全部 200**。每个响应 HTML 与提交的对应生成文件逐字节一致，均无官方 Chat 插件安装宣传，保留 `AGENTS.md`、Markdown 和 `research/topic.md` 的中立文件协作说明。

首次市场浏览器验收脚本误访问 IIFE 私有变量 CACHE 而超时，改为 DOM 与真实索引响应交叉核验后通过；未修改产品代码。官网仍部署中时的首轮预检读到旧 HTML，保留该证据且未误判成功；最终结论只依据部署成功后的重新回读。

## 工作区与独立任务

源码提交 `53f0caf9` 精确排除了 Timeline 改动。随后 Timeline 由独立提交 [`f632762119d02135e8355b720246fd06fd002848`](https://github.com/wizlijun/note.md/commit/f632762119d02135e8355b720246fd06fd002848) 提交并 push，未发布新的插件市场包，不计入本次 OpenClaw 改变。

报告编写前 `main` 与 `origin/main` 均指向 `f6327621`，受控文件干净，仅有原有 7 个未跟踪路径；只有一个 worktree，本地分支为 main。原有 3 个 stash 原样保留：

- `7168eb9ab49d429f8e91ebcf2ac1ba9580582402`
- `240fdc4c69e1b4789ca1166a95c65b1c7c3999b7`
- `a904adce51b40b26ac46409b232a5ac61ab3216c`

## 本地证据索引

证据保留于忽略目录 `tasks/openclaw-removal-20261022/`，私有归档没有提交到公开仓库。

- 范围与构建：`source-commit.json`、`source-commit-files.json`、`host-entrypoint-verification.json`、`workspace-packages.json`、`local-artifact-state.json`、`host-full-tests.log`、`host-full-tests-retry.log`、`host-check.log`、`build-result.json`。
- 市场与远端：`registry-final-tests.log`、`registry-production-tsc.log`、`registry-baseline-tsc.log`、`index-withdraw-proof.json`、`r2-archive-proof.json`、`r2-delete-actions.json`、`r2-after.json`、`remote-removal-proof.json`。
- 公网与浏览器：`public-market-verification.json`、`public-market-browser.json`、`public-website-verification.json`、`registry-ci-public-proof.json`、`website-ci-public-proof.json`、`public-web/` 的响应头、响应体与截图。
- 官网与保留功能：`website-tests.log`、`website-regeneration.json`、`web-docs-residuals.json`、`agent-ui.log`、`agent-ui/` 截图。
- 工作区保护：`post-source-workspace.json`。
