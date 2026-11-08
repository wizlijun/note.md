# Sumi macOS 首版发布证据

日期：2026-11-08。宿主 **note.md v6.1108.1**，插件 **notemd.sumi 0.1.0**，本次产物范围为 **macOS Apple Silicon（arm64）**。Sumi 原生编辑器要求 macOS 13+，未提高 note.md 宿主原有最低系统版本。

宿主已公开，插件市场闭环结果见末节。本报告区分正式产物核验、隔离应用实机测试和未完成的验收矩阵；发布不代表全部平台和性能目标完成。

## 源码与正式产物

- 发布 tag：`v6.1108.1`，完整提交 `da7eff9513b758effc1c1231a2509198d43c4b7e`。
- 最终功能集成与实机 Acceptance 源码：`8339ec9b1ae799c38c5fee073c5ed06edfb48090`。此后至 tag 仅改双语 changelog、未发布日志保全、`pnpm-lock.yaml` 和原生桥 `build.rs`；没有修改 Sumi 编辑器、宿主业务、插件 UI 或同步核心实现。
- `4b561a9f` 锁定 Sumi workspace 开发依赖；`e62b5ccd` 为正式优化链接补上实际 Clang 对应的 availability runtime。该构建修复通过实际 release 构建验证，不以旧 debug probe 替代。
- [冻结输入](2026-11-08-sumi-release/frozen-inputs-release-tag.json)记录 tag 源文件、宿主完整 JS 模块及插件文件摘要；[正式产物核验](2026-11-08-sumi-release/release-artifact-verification.json)结果为 `ok:true`。App/DMG 的 Developer ID 签名、公证与 stapler 验证通过；updater 和插件 minisign 验签通过。DMG 只读挂载后，内部程序与构建候选、updater 字节一致，原生桥类及完整前端模块已核对。

以下摘要已由本地构建产物核验取得；宿主还经过 GitHub 草稿完整回读、公开入口核验，具体范围见末节：

| 产物 | 字节数 | SHA-256 |
|---|---:|---|
| App arm64 可执行程序 | 22068128 | `bcbd62cb793a14fd6199925656671cd4db5cccb9db8dc320ea9253b3685db860` |
| note.md-6.1108.1-aarch64.dmg | 70214922 | `e3b458dcff3e443fe36f1ec3567e3e7106ea7e3d1969f3df22b1609a558a925c` |
| note.md-aarch64.app.tar.gz | 69979664 | `b22653055ee7f8c21dd1846988317216028a5972eded6d8a9881f749e1dbe8d3` |
| notemd.sumi/0.1.0/universal.notemdpkg | 8080 | `4d4d0feb5a66eb5b2c8b6a146806676e9900fc23f374f3003d701042e4b62be0` |

## 已纳入的用户要求

- 原生 `NSTextView` / TextKit 2 全屏或固定 960×720 写作窗口，一页纸/下一页纸；字号、行距、默认 80 字符列宽目标、底部留白可设置。黑白、黑灰、白黑及米色深灰主题同时映射到原生正文和 Web 外壳；米色为 `#f3ead7`，正文为 `#44413c`。
- 最终五组字体：IBM Plex Mono Light + IBM Plex Sans SC Light、霞鹜文楷等宽 Lite、朝华、油茶、独立朱雀仿宋。正式包已逐摘要核对 **6 个字体文件 + 7 份许可/来源文件**；仅进程内注册，缺字允许系统回退。朝华/油茶替代已退役候选，朱雀使用自己的中英文字面。
- 光标为随整体字体 metrics 定高、稍粗的竖线；默认 6 秒平滑呼吸，可持久化选择常亮，减少动态效果时常亮。IME 组字期间仍使用同款自定义竖线，系统细线全程隐藏；steady 在输入、布局和选区中间事务保留有效光标。
- 原生常用移动/删除、Find/Replace，精确修饰键快捷键、链接、标题/段落/列表、缩进、保存、字号、全屏等；空选区 B/I/删除线切换后续输入样式，不修改正文与行时间。IME 提交及粘贴按一次协同事务处理，导航/换页/首个 LF 清理 pending 样式。
- copy/cut 输出带必要格式的 Markdown 纯文本，成功写入剪贴板后才 cut；paste 支持 Markdown 和 HTML/RTF 文本化，显式 literal fallback 保留原字符，空提取不删除选区。无法由 Markdown 表达的边界优先保全文字，不伪造任意富文本格式。
- `inbox/writings/YYYY-MM-DD-%02d.writing.md` 保存小 YAML 身份头和正文，同目录 `.writing.meta.json` 保存逐行身份与 first/last/source；原生阅读/续写隐藏元数据，Source 明确展示源码。SQLite 保存权威协同状态和耐久队列；MD/meta 是配对快照，不宣称跨文件原子写。独立 CF 同步支持实时增量、离线自动合并及仅撤本地操作的 undo。

逐条源码与证据索引见 [final-feature-evidence.md](../../../tasks/sumi-release-20261108/final-feature-evidence.md) / [JSON](../../../tasks/sumi-release-20261108/final-feature-evidence.json)。该索引以 8339 功能源码冻结；上节说明它与正式 tag 的差异。

## 测试与本轮实机验收

| 证据层 | 结果及范围 |
|---|---|
| 最终功能代码自动化 | [write-core 完整套件](../../../tasks/sumi-native/typing-core-tests.log) **85 passed**；[宿主 Sumi 套件](../../../tasks/sumi-native/typing-host-tests.log) **99 passed / 2 ignored**。宿主结果不是整个 Rust 仓库全测：另有 1381 filtered out。覆盖输入样式、IME 事务、剪贴板、行身份/时间、持久化、同步和恢复等实际测试项。 |
| 前端回归 | [最终正式发布流程全量前端回归](../../../tasks/sumi-release-20261108/host-release-6.1108.1-e62b5ccd.log) **422 test files / 5498 passed**（日志第 313–316 行，129.32s）。在隔离发布源码目录以 `e62b5ccd` 作为发布输入执行，随后版本提交形成上述正式 tag；不是沿用旧 3202 阶段结果。最终快捷键相关前端 [3 files / 33 passed](../../../tasks/sumi-native/shortcuts-frontend-tests.log)；[最终快捷键阶段 Svelte 检查](../../../tasks/sumi-native/shortcuts-svelte-check.log)无错误，保留已有警告。 |
| 原生与资源 | [连续 caret raster](../../../tasks/sumi-native/caret-render-continuous.log)、[caret probe](../../../tasks/sumi-native/typewriter-caret-probe.log)、[快捷键 probe](../../../tasks/sumi-native/shortcuts-probe.log)、[私有剪贴板测试](../../../tasks/sumi-core/clipboard-native-tests.log)、[五组 CoreText probe](../../../tasks/sumi-zhaohua-youcha/five-groups-coretext-probe.log)。包含系统细线阳性对照、抑制验证、真实 markedText 多次更新/提交、朝华 32pt/米色/steady 与中间状态观察；未操作用户系统剪贴板。 |
| 本轮真实 AppKit/系统拼音 | [8339 Acceptance 构建报告](../../../tasks/sumi-native/host-acceptance/build-report-8339ec9b.json)与[IME 合并报告](../../../tasks/sumi-sync/ui-release-8339-ime-acceptance.json)：实际系统拼音 `ni + space → 你`、`zhong + space → 中`；组字及提交后观察到同款粗竖线，没有额外细线。实际测试空选区加粗及普通续写、CmdF 替换/撤销、CmdK 链接、CmdS flush。 |
| 真实远端合并与数据核对 | IME 期间 peer 增量耐久入队，提交后合并；本地 undo/redo 保留远端文本。[只读最终核对](../../../tasks/sumi-sync/ui-release-8339-final-verification.json)：本机/远端/MD/meta 正文及 7 行 ID、first/last/source 一致，远端标记仅一次，inbox/outbox/目录/projection 队列均为 0，磁盘文件对与基线一致。 |

实机对象是隔离 Acceptance 包，可执行程序 SHA-256 为 `6f3ae9bd66c2f40f19f17ea6d2abb0a819afaf96692189c28a0b08ed4616ab7a`，与本次正式包二进制不同。正式包取得的是源码/资源/模块/签名/公证与归档一致性证明；**未将 Acceptance 的操作记录改称正式 DMG 安装后的重新操作记录**。历史 Source/Rich 交接、导出/恢复/全屏记录仍有效于其记录范围，未全部在本次正式包重新执行。

## 明确限制

- Windows/Linux/iOS/Android/ESP32 原生端、定制输入法和固定底部候选框/统一输入法配色未交付；本次也不提供 Intel 产物证明。
- VoiceOver 尚未实测；AX 可访问性对象、静态截图、raster、rAF 或 layout 时间都不等于物理输入到屏幕 present 的帧指标。完整性能/PM10k、能耗/内存及网络可见 p95 矩阵仍未完成。
- 当前真实 IME 报告未保留候选弹窗截图；部分额外 UI 检查被锁屏中断。旧系统、多屏、缩放、全部字体/主题/快捷键组合、viewport 重启和部分恢复 GUI 路径未完成新包全矩阵重验。
- 硬件断电、实际磁盘耗尽、区域灾难和全部限额 UI 尚无完整实测；已有错误注入、进程崩溃与真实云证据不能替代这些场景。同步服务不是 E2EE。
- 默认固定 960×720 已实现；spec 中“设置可选少量固定窗口规格”尚无实现证据。忽略测试与既有警告均未当作通过。

## 发布闭环

- 宿主通过既有 `scripts/release-publish.sh v6.1108.1 --mac-arm64-only` 发布，退出码 0；公开时间 **2026-11-08 07:05:24 UTC**。[正式 Release](https://github.com/wizlijun/note.md/releases/tag/v6.1108.1)为非草稿、非预发布；本次提供 Apple Silicon 产物。[公开记录](2026-11-08-sumi-release/host-publication.json)。
- [四个草稿产物完整回读](2026-11-08-sumi-release/draft-assets-verification.json)的实际字节数和 SHA-256 全部匹配本地与 GitHub 摘要。公开后 [匿名核验](2026-11-08-sumi-release/public-host-verification.json)确认同一 tag/asset ID/大小/digest：latest.json 与签名全量回读；DMG/updater 各首尾 64 KiB 回读与已验完整文件逐字节一致。公开签名对完整 updater 验签通过。**大文件没有重复匿名全量下载，不将抽样说成全量。**
- 插件 `notemd.sumi 0.1.0` 于 **2026-11-08 07:12:39 UTC** 完成发布验收，最低宿主 `>=6.1108.1`。沿既有 Wrangler **3.114.17 + Account API Token** 完成 R2 包/签名上传、普通及 fresh 匿名全量回读验签、KV 索引发布和公网复核。[发布结果](2026-11-08-sumi-release/plugin-publication-complete.json)、[包验签](2026-11-08-sumi-release/plugin-public-packages.json)、[索引核验](2026-11-08-sumi-release/plugin-index-verification.json)均通过；[公开索引](https://plugins.notemd.net/api/index.json)由 298 增至 299 条，只增加 Sumi，原有条目完整保留。包实际回读 SHA-256 与上表一致。首次 KV 只读复查失败后按原流程重试，总共一次 KV 写入，没有升级工具、部署 Worker 或升级付费套餐。
- 发布后，`2c125290` 精确恢复两语各 19 条 Unreleased 原文及顺序；两语 v6.1108.1 的各 4 条 Sumi 和全部历史保持与冻结 tag 一致。changelog gate、diff check 及恢复幂等复查通过；[保全档案](2026-11-08-deferred-changelog.json)已标 restored。其他尚未发布的日志不归入本版本。
- 原工作区 `searchidx/src/store.rs`、`src-tauri/src/smart_lookup.rs` 的两项既有 LF 改动未提交、未进入发布包。关键发布证据已随本报告纳入版本控制；`tasks/` 链接是本机完整原始测试记录。报告提交发生在冻结 tag 之后，不移动 tag 或重新描述产物来源。
