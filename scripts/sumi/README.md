# Sumi 同机编辑基准

对应 `docs/superpowers/plans/2026-11-07-immersive-write-macos.md` §7。这个工具包提供**可复现的分段指标**，没有把程序化事务、JS handler、rAF、TextKit 布局称为物理 input-to-frame。三组必须在同一机器、同一字体文件、同一语料摘要、相同字号 22 / 行距设置 1.6 / 900×650 编辑区域下比较。

## 三组的真实范围

| 组 | 实际代码 | 包含 / 排除 |
|---|---|---|
| 当前 Rich | 生产 `RichEditor.svelte`、`mountRichEditor`、FileOwner、桌面编辑插件 | 真实前端编辑/源文映射；隔离内存宿主适配，不读写正式 Vault，不含磁盘/网络保存 |
| 最小 Web | 同窗口引擎的 ProseMirror basic schema，无额外插件 | 编辑器 DOM/事务；同字体与正文，不把它冒充完整宿主功能 |
| Native + core | 直接编译生产 `native/editor.m`，同步回调调用 `SourceMap::apply_edit` + `Document` + SourceMap 重建 + JSON projection | 真实 AppKit/TextKit 2/core 增量路径；隐藏窗口的同步 viewport layout；排除 Tauri 业务锁、耐久队列、网络、物理事件投递与 compositor |

不能将 Native 隐藏窗口的布局时长与 Web 的 rAF 机会时长当成同一个指标；可比较同步处理段，同时分别列出两种渲染代理。完整宿主 WAL/投影和实时同步沿用既有 `write-core/examples/candidate_continuous.rs`、`confirmed_benchmark.rs` 及 durability 容量基准证据，不能与本工具混在同一列。

Web 自动轮次直接派发 ProseMirror transaction，会经过真实 editor owner/plugins，但不会模拟键盘事件、DOM beforeinput/IME 或依赖 DOM input 的 slash-menu 监听。Native 自动轮次调用 insertText，也不经过物理键盘事件投递。真实输入记录必须另外运行；不能把自动轮次说成完整打字路径。

## 构建与隔离宿主入口

```sh
node --test scripts/sumi/corpus.test.mjs
node scripts/sumi/build.mjs
python3 scripts/sumi/acceptance/prepare.py
```

最后一步只生成审阅用 seed；由主代理按既有授权的 Acceptance.app 构建流程统一 `--install`。`prepare.py` 若存在默认临时 benchmark 构建，会验证 JS/CSS bundle hashes，复制 `ui/benchmark/`、语料、字体及许可证，并仅为隔离 seed 增加 `benchmark` 窗口/菜单；**生产插件 manifest 和 Sumi main 窗口条目不变**。可用 `--benchmark-dir PATH` 指定产物。

验收宿主的跟踪脚本位于 `scripts/sumi/acceptance/`。`prepare.py` 从便携模板生成旧位置 `tasks/sumi-native/host-acceptance/tauri.acceptance.json`，其 plist 指向本 checkout 的跟踪文件；Vault、seed、marker 与报告仍使用原目录。显式运行 `bash scripts/sumi/acceptance/build.sh` 才构建宿主，脚本不启动应用。隔离路径与重复安装回归：`python3 -m unittest discover -s scripts/sumi/acceptance -p 'test_*.py'`。

验收构建默认仍为 ad-hoc。需要跨重建保持证书身份时，可使用本机已有证书的**完整 common name**（不接受简称或 SHA1）：

```bash
SUMI_ACCEPTANCE_SIGNING_IDENTITY='Developer ID Application: Your Organization (TEAMID)' \
  bash scripts/sumi/acceptance/build.sh
```

此选项在准备 seed 后只覆盖 ignored 的生成配置，并显式传给 Tauri 正常组件签名；跟踪模板保持 `-`，隔离 identifier 和 entitlements 不变。构建报告记录实际 Authority、TeamIdentifier、CDHash 和 designated requirement，严格验证 bundle 签名及请求的证书名称，不匹配则失败。仅有签名不代表完成公证。旧 ad-hoc 凭据首次迁移、签名私钥访问或系统授权仍可能提示；脚本不修改 Keychain ACL、不新建凭据、不承诺零提示。

在 **note.md Sumi Acceptance** 现有应用内：插件 → 体验 → **Sumi 同机性能验收**。先点“快速检查”（1 轮、20 次预热、10 次样本），确认编辑器挂载和 `correctness.exact_text=true`。随后分别运行 Rich/最小 PM × 10k/100k 四组“标准 5 轮”。每轮新建编辑会话，1000 次预热编辑之后测 100 次、100ms 间隔；原始样本保留。初始/手动加载单列在 `editor_mounts`，可能包含编辑模块懒加载；标准循环的 `mount_ms` 是同页面缓存内的新编辑会话热挂载，不是 SQLite 历史恢复或整个宿主冷启动时间。

所有语料用固定中英混合短段、数字、emoji/ZWJ、组合字符。尺寸是 **Markdown UTF-16 units**；JSON 同时记录 Unicode scalar、grapheme、UTF-8 bytes 与 SHA-256。预热后的正文比初始语料更长，此事实记录在 warmup / correctness，不能仍称“恰好 100k”。三个位置交替输入同一字符序列。大段粘贴/删除/撤销、单段超长、极短行、列表/强调、1M压力边界仍需独立场景，不能用当前正常写作集声称覆盖。

“保存报告”在插件内先验证 `.sumi-acceptance-vault` 标记，再经现有能力门控 bridge 写入隔离 Vault 的 `inbox/sumi-benchmark-results/web-*.json`，不放宽 CSP、不使用新宿主命令。浏览器附加对照可用：

```sh
node scripts/sumi/serve.mjs
# http://127.0.0.1:5179/
```

HTTP 报告只写临时 artifacts/reports。Chrome 只能标为额外引擎对照，不能替代同 WKWebView 比较。本次复用已授权的 Acceptance.app，不另外创建 GUI 应用。

只读审计隔离 Vault 内保存的累计 Web 报告：`node scripts/sumi/audit-web-reports.mjs [REPORT_DIR] [INSTALLED_BENCHMARK_DIR]`。脚本核对当前源码、安装产物与字体摘要，按固定语料独立重放正文，复算原始样本分位数；仅纳入 1000 次预热 / 100 次采样的正式轮次，排除 quick，并去重累计报告中的同一记录。每组必须恰好 5 轮，否则明确报告未完整。测试过程中读取完整 AX 树等观察操作须另附记录，不能无依据剔除慢样本；脚本始终将物理输入到呈现帧标为未测。

系统输入到实际呈现的 Instruments 能力探针：`bash scripts/sumi/probe-input-present.sh plan ACCEPTANCE_PID` 仅验证既有隔离进程并打印命令；显式 `record` 才附加该 PID 录制 30 秒，不启动新应用或录制所有进程。须先结束基准、解锁屏幕并确认目标版本。Frame Lifetimes/Display/HID 的实际关联应从 trace 验证；legacy Hitches 只含慢帧，不能单独计算全输入 p95。无法关联同一输入的 transaction/frame-seed/surface 时保持未测，不取最近一帧猜测。

## 原生程序化基准

```sh
node scripts/sumi/run-native.mjs --smoke
node scripts/sumi/run-native.mjs
```

自动使用 Rust 1.99.0、`--release --offline --locked`，复用 `write-core/target`；锁文件以 core 的已验收依赖版本为基础。必须允许本机 AppKit/字体服务连接；窗口保持隐藏，不注册或启动新的 GUI app。默认每尺寸 5 轮、1000 warmup、100 samples。所有输入经生产 NSTextView `insertText`，回调执行实际 core；逐字构造期望结果并验证最终 AppKit 文字和 core 投影完全一致。指标包括 core apply/render、projection JSON、insertText return、viewport layout、挂载、独立进程 RSS peak。原生 `core_open_ms` 是合成语料创建，`mount_ms` 不含 SQLite 历史恢复，因此不能直接填作 spec 的完整纸页热打开门禁。只读字体 manifest 核验全部使用字体的 SHA-256。

脚本记录二进制与生产源码 before/after hash；测试期间源码变化会使本轮失败，不能拿旧证据验新包。

```sh
node scripts/sumi/summarize.mjs /path/to/web.json /path/to/native.json > /tmp/sumi-comparison.json
# 显式列出宿主及对应 WebKit XPC PID；不自动猜 launchd 子进程
node scripts/sumi/sample-process.mjs 123,456 60 /tmp/sumi-memory.json
```

`sample-process` 每 250ms 记录选定 PID 的 RSS 和 OS `%CPU`；RSS 含共享页，不自动求和当物理 footprint，短峰可能漏采。应另用 Instruments Activity/Allocations/Time Profiler 验证完整宿主与 WebKit 的内存、主线程、CPU/能耗。

## 实机门禁与报告规则

1. 记录机器/系统、屏幕实际刷新率、设备像素比、构建 hash、字体 hash、语料 hash、系统输入法名称/版本。关闭开发工具及录屏之外的高负载任务；不要在不同机器或 Chrome/WK 混合结果间算“倍数”。
2. 真实拼音/注音用同一输入法手动输入，至少 5 轮。页面“记录真实输入事件”只接受 `isTrusted`，分开统计 input handler→下一次 rAF 与 compositionend→rAF；**rAF 在 paint 前，不等于显示完成**。合成 insertText 不替代 IME 候选、组合撤销、VoiceOver。
3. 用系统事件 + 帧呈现标记或高帧率录屏，观察最终提交文字出现；排除用户选候选的等待。60Hz 机器目标 p95≤50ms、无可重复 >100ms 主线程编辑停顿。代理指标可以发现不达标风险，不能单独证明该门禁通过。
4. 原生完整 Acceptance.app 使用同一语料的真实 Sumi 页，保留后台 SQLite/投影和同步开启时的测量；同样记录真实输入/画面。不得将本 native CLI 的隐藏布局结果填到该物理指标。
5. 远端可见 p95≤300ms 必须附真实 RTT≤100ms 证据；10万热打开目标≤500ms；停止输入后 MD/meta 通常≤1秒，并验证关闭 flush。现有算法/队列基准不能代替这些完整 UI 测量。
6. 汇总脚本始终将 `physical_input_to_frame_gate` 与 `host_memory_gate` 标为 `NOT_MEASURED`，不会因为程序化数字好看而自动判绿。发布验收仍需主代理补充实机证据。
