# NEXT「帮我开个头」实现与验收

日期：2026-10-27。分支：`feat/next-task-kickoff`；基线：`bbbecb1b`（新增 spec/plan）。工作树：`/Users/bruce/git/mdeditor-next-kickoff`。本报告验收源码及隔离测试，未安装、未发布、未推送，版本维持 NEXT 1.10.0。

用户要求先完成代码，真实运行留待验证。当前所有未通过真实安全验收的 provider 均保持不可执行；实现完成不代表已可用真实模型。列表根据宿主**已安装的 Agent 插件**动态生成；名称、版本、模型与默认选择来自宿主，健康检查失败也保留条目。不存在 Claude 专用安装清单。

## 验收矩阵

| spec §13 | 证据与结果 |
|---|---|
| 1 卡片与旧 host | button-state 与 App 渲染测试覆盖收件箱/等待/稍后、Idea/进行中/已完成/修复区及旧 host；Safari 隔离预览安放后按钮消失 |
| 2 确认与播种 | template/client 测试覆盖确认前零写入、不覆盖已存在文件；已有 task.json 不满足严格只读时拒绝执行 |
| 3 计时与恢复 | status/button/App 测试覆盖绝对时间、无 started_at 回退、重开对账、轮询与销毁 |
| 4 文件与 OKF | 实际 buildKickoffDocument 产物经临时目录 OKF lint；JSON载荷由NEXT验证后写旁文件 |
| 5 载荷规则 | payload 的 schema、长度、Unicode、64KiB、path/source、安全修正与围栏回归通过 |
| 6 列表隔离 | repository 实际旁文件测试、构建后的 CLI list/transition e2e 通过，Task 数量不变 |
| 7 答案保护 | document/client 测试覆盖 human:owner、未知字段/旧答案保留、手改正文保护与写前冲突；UI显示保护提示 |
| 8 安放 | prefill/PlaceSheet/App 测试与 Safari 内存 Vault 操作验证答案预填、取消保留、用户确认后进入进行中 |
| 9 失败 | status/client/Progress/App stub 覆盖失败矩阵、原文截断、登记失败恢复、无run_id的真实启动失败登记 |
| 10 真实只读 | **待验**，无provider准入。真实CLI启动遇OAuth过期；stub不能替代模型工具拒绝证据 |
| 11 自动验证 | NEXT test/check/build、picker同步、concept-origin-sync、Rust origin及backend测试，最终数字见下 |
| 12 未发布日志 | 主CHANGELOG中英、NEXT CHANGELOG均新增未发布条目，changelog检查通过 |

## Safari 隔离界面验收

通过本地 Vite 临时预览挂载真实 App，host bridge使用浏览器内存Map模拟Vault；数据为合成Task与生产序列化的kickoff文件。`host.agent.run`在fixture中明确抛错，未启动模型、未操作正式Vault。

已实际操作：查看开头→选择答案→安放字段预填→取消安放→重开仍保留人工选择→用户确认安放→进入进行中且按钮消失。数据源、模型/用时、未读标记和未验证禁用原因可见。三插件fixture列表均显示；切换为仅Codex的安装清单后只出现Codex，默认项随之切换，无Claude。渲染测试另覆盖仅DeepSeek及空列表。

Safari截图右侧存在白色遮挡，左侧列表与面板和完整AX树可验证；不把此次操作描述为全视口视觉验收或正式已安装插件验收。生产provider禁用时未验证可点击条目的鼠标hover；继续复用既有全局menu-panel/menu-row样式。

## 验证命令与提交

最终前端命令（2026-10-27 21:39 Asia/Taipei，使用已有依赖，不安装/改锁文件）：

```sh
pnpm --config.verify-deps-before-run=never --dir plugins-src/next test
pnpm --config.verify-deps-before-run=never --dir plugins-src/next check
pnpm --config.verify-deps-before-run=never --dir plugins-src/next build
node scripts/sync-agent-picker.mjs --check
node scripts/changelog.mjs check
```

结果：**43 个测试文件、768 项测试通过；类型检查 0 errors / 0 warnings；build 成功（254 modules，JS 461.55kB / gzip 147.08kB）**。其中 kickoff 模块 230 项（client 67、registry 10）；canonical AgentPicker 33项另行通过，生成副本同步。已有483项基线测试持续通过。

origin/CLI/backend 验证命令：

```sh
pnpm --config.verify-deps-before-run=never exec vitest run src/lib/okf/concept-origin-sync.test.ts
CARGO_TARGET_DIR=/Users/bruce/git/mdeditor/src-tauri/target cargo +1.99.0 test --manifest-path searchidx/Cargo.toml origin::tests:: --offline
pnpm --config.verify-deps-before-run=never --dir plugins-src/next build:cli
node --test plugins-src/next/scripts/task-cli.e2e.mjs
cargo +1.99.0 test --manifest-path plugins-src/agent-run-core/Cargo.toml
cargo +1.99.0 test --manifest-path plugins-src/claude-agent/backend/Cargo.toml
cargo +1.99.0 test --manifest-path plugins-src/codex-agent/backend/Cargo.toml
cargo +1.99.0 test --manifest-path plugins-src/deepseek-agent/backend/Cargo.toml
```

默认 stable 缺少 cargo 组件，因此使用本机已有 1.99.0；未升级工具链。Rust 与 origin 的对应源码通过测试后未再修改，不重复执行无变化的完整测试。CLI只在隔离工作树构建与临时Vault测试，未复制到正式Vault skill。

已验证提交：

- `33f68af7`：OKF Task Kickoff / Skill 与 origin；TS同步2、Rust origin23通过。
- `9134239d`：载荷验证；67项通过。
- `a0c74908`：文档与答案保护；生产产物OKF lint通过。
- `996f871f`：三家结果通知不强制产物路径；plugin测试30/21/19通过。
- `1458fddd`：登记/状态/按钮/安放预填；43项通过。
- `fa51fc00`：只读协议与skill播种；5项通过。
- `739174f6`：任务列表与实际CLI旁文件回归。
- `ec61528b`：严格只读执行分支；core161/Claude123/Codex84/DeepSeek133通过。
- `a9efda8f`：存储数据严格校验与启动时间回退。
- `f99c45be`：动态已安装provider、client/bridge/picker、登记恢复与冲突保护。
- `a5c47076`：问答/安放界面、四语言与恢复/键盘回归。

上述实现经独立spec/quality审查，发现的核心5项及UI7项已修复并限定复审通过。所有产品源码在`a5c47076`冻结，最终自动测试针对该源码；本报告与未发布日志随后单独提交。

## 已知边界与待验

1. 真实认证恢复后，需在隔离Vault验证 Task/sources可读，Write/Bash/Web/MCP不可调用，用户hooks/扩展不启动，外部路径与symlink不能读取，以及terminal_result/run-status完整链路。不得仅凭capability=true开放入口。
2. 现有宿主max_concurrency是信息，普通任务按同Vault的任务锁串行；NEXT保守一次只启动一个kickoff，不声称实现跨provider并行或宿主全局容量调度。
3. 当前USER.md无规范owner frontmatter字段，按已核实的spec回退human:owner，不猜身份或新增私有字段契约。
4. 新agent capability会进入单插件安装/更新确认；现有“全部更新”只有批量确认，不声称逐插件新增权限确认。本轮未走安装或更新流程。
5. Vault写API无原子compare-and-swap。客户端串行化本实例并写前比较/写后回读，检测已观察到的外部修改；不能保证跨设备并发原子性。

安全研究与后端实现依据见 [Task 0报告](2026-10-27-next-task-kickoff-task0.md)。

## 后续插件发布

实现验收之后，用户授权发布 NEXT 1.11.0；实际包、tag 和公网证据见[发布验收](2026-10-27-next-1.11.0-release.md)。仅 NEXT 插件已发布，真实模型准入仍未完成，本文上面的“未发布/未推送”是实现完成时的历史状态。
