# 玄霜写作(Sumi Write)独立成项目:交接与 iOS 规划设计

日期:2026-11-18。状态:已批准,第 0 期已完成(可见性已定:公开)。基线:note.md `main` 969f8e73,宿主 6.1117.1,插件 `notemd.sumi` 0.1.16。

标注约定:**[用户定]** 是用户在讨论中明确选择的;**[我的判断]** 是设计者补全的,用户可推翻。

## 1. 意图

玄霜写作现在是 note.md 仓库里的一个插件,但它已经有自己的内核、协议、同步服务和品牌,并且下一步要做 iOS/iPadOS 原生版。继续放在 note.md 里,会让两个产品的边界、发版节奏和文档混在一起。

本设计要做三件事:

1. 把玄霜写作立为独立项目,放在 `~/git/sumiwrite`。
2. 把现有知识交接过去:技术选型记录、重写后的规范、迁移计划。
3. 为 iOS/iPadOS 原生版定好架构和里程碑。

## 2. 目标、非目标、反目标

**目标**

- 新仓库拥有产品本身:内核、协议、同步服务、桌面插件包、iOS 应用、全部规范。
- note.md 与 sumiwrite 之间有一份成文、带版本号的契约,谁拥有什么一目了然。
- 规范重写成一套按主题组织的现行文档,读者不需要翻 15 份增量文件和发布流水。
- iOS 第一阶段可在 iPhone 和 iPad 上写作,并与桌面跨设备续写。

**非目标**

- 本轮不搬代码,不改 note.md 的任何构建或发版行为。**[用户定]**
- 桌面独立应用不在近期范围,只写进路线图,iOS 上线后评估。**[用户定]**
- iOS 第一阶段不做公开发行:没有注册登录、多租户、付费、App Store 上架。**[用户定]**
- Android、ESP32 客户端只保留原规范中的定位,不做新规划。**[我的判断]**
- Fcitx5 for Sumi 输入法是独立项目,不并入;新规范只写对接契约。**[我的判断]**

**反目标**(出现即失败)

- 两个仓库各留一份可编辑的源码并各自演进。
- iOS 与桌面的 CRDT 或行时间实现分叉,导致同一页在两端合并结果不同。
- 新规范把“已交付”和“计划中”混写,让人分不清哪些行为真实存在。
- 迁移过程中 note.md 有任何一期不能照常构建和发版。

## 3. 约束

- 原生编辑桥 `tauri-plugin-native-editor`(含探针约 12k 行 AppKit/GTK)编译进 note.md 宿主,当前无法随插件独立更新(原规范 §8.1)。
- 宿主里还有一层实时编辑会话:`src-tauri/src/sumi/`(约 8.7k 行 Rust,其中 `mod.rs` 4858 行)。它负责单一编辑 owner、组字期间暂缓远端更新、本机输入日志、崩溃恢复、凭据,并向插件暴露约 20 个 `host.sumi.*` 命令。
- 宿主 `src-tauri` 直接依赖 `write-core` 和 `sumi-protocol`,不只是插件后台依赖它们。
- `sumi-protocol` 是宿主与插件后台之间的内部服务契约(持久化、字体、服务握手),不是同步线协议。同步线协议在插件后台的 `sync.rs` 和同步服务的 TypeScript 里。
- 插件壳反过来依赖 note.md 的三样东西:`notemd-plugin-sdk`、`src/lib/sumi/i18n.ts` 与 `plugins-src/shared/shortcuts.ts`、`scripts/release-plugins.sh` 里的签名公证流程。
- note.md 是公开仓库,Apache-2.0。
- 同步的线格式是 Yjs update/state-vector V1,Yrs 固定在 0.24.0,对 Yjs 13.6.33 做过互操作测试。任何客户端都必须遵守。
- 同步服务是私有、单用户、多设备:无公开注册,首台设备由管理员密钥开通,其余设备用一次性配对码加入。
- 现有已发布版本的签名包和验收证据在 note.md,不移动、不改写。插件没有自己的 tag,证据只能定位到宿主 `v6.*` tag、提交号和 `docs/superpowers/reports/` 路径。
- note.md 的 `CLAUDE.md` 约束(CHANGELOG 门禁、OKF 写入规矩)继续约束宿主侧改动。

## 4. 考虑过的做法

### 4.1 桌面版与 note.md 的关系

| 做法 | 取舍 |
|---|---|
| 仍是 note.md 插件 | 改动最小,桌面不用重新验收;桌面体验调整仍受宿主发版牵制 |
| 桌面也做独立应用 | 边界最干净;要重做窗口、签名、更新、Linux 打包,拖慢 iOS |
| **先插件,独立写进路线图** | **[用户定]** 兼顾两者,iOS 上线后按 §9 的标准评估 |

### 4.2 本轮是否搬代码

| 做法 | 取舍 |
|---|---|
| **文档先行,代码分期迁** | **[用户定]** 本轮 note.md 零改动;每期可单独验证和回退 |
| 一步到位 | 没有过渡期;但构建、发版、市场打包同时改,出问题难以归因 |
| 不带历史的快照复制 | 已排除:两份源码必然分叉 |

### 4.3 iOS 第一阶段面向谁

| 做法 | 取舍 |
|---|---|
| **先自用** | **[用户定]** 沿用配对码,账号体系不动;身份层与纸页层分开,为公开发行留口子 |
| 直接公开发行 | 要补登录、多租户、合规、付费,工作量约翻倍 |
| 公开发行并改用 iCloud | 已排除:与桌面同步服务分叉 |

### 4.4 iOS 技术栈

| 做法 | 取舍 |
|---|---|
| **Swift 原生界面 + Rust 内核** | **[用户定]** 复用 CRDT、行时间、三方合并,与桌面字节级一致;多一层 FFI |
| 纯 Swift 重写内核 | 少一层 FFI;两套实现要永远对齐,风险最高 |
| Tauri Mobile 等跨平台壳 | 已排除:不是原生,IME 和键盘避让做不好 |

## 5. 产品边界

### 5.1 一句话

sumiwrite 拥有“纸页”这个产品:写、存、同步、呈现规则。note.md 是它的一个宿主:提供原生编辑面、vault 和插件运行时。

### 5.2 归属表

| 东西 | 归属 | 现位置 | 说明 |
|---|---|---|---|
| 编辑内核 | sumiwrite | `write-core/` | 第 1 期迁 |
| 宿主与插件后台的服务契约 | sumiwrite | `sumi-protocol/` | 第 1 期迁;iOS 不使用它 |
| 同步服务 | sumiwrite | `write-sync-worker/` | 第 1 期迁;要解开三处对 note.md 的依赖:`worker/` 里的 Wrangler 和 `tsc`、`cloud-admin.py` 读取的根目录 `.env` 与 `worker/wrangler.toml` 账号 ID |
| 桌面插件壳 | sumiwrite | `plugins-src/write/` | 第 2 期迁;按 tag 引用 note.md 的 `notemd-plugin-sdk` |
| 插件界面文案 | sumiwrite | `src/lib/sumi/i18n.ts` | 第 2 期迁;宿主若也用到,改为从插件包取或各留所需的一小份,由第 2 期计划定 |
| 实时编辑会话中与 Tauri 无关的部分 | sumiwrite | `src-tauri/src/sumi/`(owner、组字防护、输入日志、恢复、凭据逻辑) | 第 3 期下沉成共用 Rust 模块,宿主只留薄适配 **[我的判断]**,理由见 §10.2 |
| 字体目录、音效资源、许可与来源文件 | sumiwrite | `plugins-src/write/resources/` | 第 2 期迁 |
| 插件侧测试与验收脚本 | sumiwrite | `scripts/sumi/` 中不依赖宿主的部分 | 第 2 期迁,逐个文件判定 |
| iOS/iPadOS 应用 | sumiwrite | 无 | 第 4 期新建 |
| 产品规范、技术选型记录 | sumiwrite | `docs/superpowers/specs/*sumi*` 等 | 本轮重写 |
| 原生编辑桥 | note.md | `tauri-plugin-native-editor/` | 不迁;是宿主能力 |
| 宿主内 Sumi 界面与 Tauri 适配 | note.md | `src/lib/sumi/`(除文案)、`SumiRecovery`、`NativeFileView`、`src-tauri/src/sumi/` 中的命令注册、窗口、系统钥匙串与原生桥对接 | 不迁 |
| 原生桥探针与宿主侧验收脚本 | note.md | `scripts/sumi/` 中依赖宿主的部分、`tauri-plugin-native-editor/native/*-probe.m` | 不迁 |
| 插件 SDK、插件市场、签名与发版 | note.md | `notemd-plugin-sdk/`、`plugins-registry/`、`scripts/release-plugins.sh` | 不迁 |
| 历史发布证据 | note.md | `docs/superpowers/reports/*sumi*` | 不迁;新规范链接过去 |
| Fcitx5 for Sumi 打包 | note.md | `packaging/omarchy/fcitx5-sumi-candidates/` | 不迁;随 Linux 宿主打包 **[我的判断]** |

### 5.3 两个仓库之间的契约

写成 `docs/handoff/03-notemd-contract.md`,包含五部分:

1. **宿主接口契约**:宿主向插件暴露的全部耦合面,从现有代码逐项读出并编号版本。包括:原生编辑面能力(外观参数、光标、IME 交接、焦点、编辑事务回调、owner 交接)、约 20 个 `host.sumi.*` 命令、`plugins-src/write/src/contract.ts`、后台服务的版本与能力握手(`sumi-protocol`)。由 sumiwrite 定义,note.md 实现。插件 manifest 的 `engines.notemd` 继续表达最低宿主版本。
2. **依赖方向**:两个方向都按固定 tag 引用,不跟分支。note.md 宿主引用 sumiwrite 的内核与服务契约;sumiwrite 的插件壳引用 note.md 的 `notemd-plugin-sdk`。两者在 crate 层面不成环。本地联调用 `[patch]` 指向本地目录。共享的快捷键 TypeScript 的处理方式由第 2 期计划定。**[我的判断]**
3. **vault 投影约定**:`inbox/writings/YYYY-MM-DD-NN.writing.md` 加同目录 `.writing.meta.json`,frontmatter `type: Writing Page`。这是桌面插件独有的行为,遵守 note.md 的 OKF 写入规矩。
4. **发版配合**:只改插件壳或内核且契约版本不变时,只需发插件包;契约版本变化时,两边配套发版。
5. **签名与上架**:签名、公证、插件市场上架留在 note.md 的发版流程里(密钥和门禁都在那边)。sumiwrite 产出待签名的构建物和校验清单。**[我的判断]**

### 5.4 纸页存储与 vault 投影分开

现规范把存储路径直接写成 vault 内的文件。新规范拆成两层:

- **纸页存储**:各端都有。内核的 SQLite 存完整 CRDT 历史,是本机事实源。iOS 放在应用沙盒里。
- **vault 投影**:只有桌面插件做。把已提交状态投影成 `.writing.md` 和 sidecar,并处理外部修改的三方合并。

iOS 没有 vault,只有纸页存储,外加“导出为 Markdown”的分享入口。**[我的判断]**

## 6. 新仓库结构

```
sumiwrite/
  README.md            产品是什么、仓库里有什么、从哪读起
  AGENTS.md            给 agent 的规程入口
  CHANGELOG.md         本仓库自己的变更记录(中英各一份,第 1 期起启用)
  core/                编辑内核(第 1 期迁入)
  protocol/            宿主与插件后台的服务契约(第 1 期迁入)
  session/             实时编辑会话与同步协调的共用 Rust 模块(第 3 期新建)
  sync/                同步服务(第 1 期迁入)
  apps/
    notemd-plugin/     桌面插件壳(第 2 期迁入)
    ios/               iOS/iPadOS 应用(第 4 期新建)
  docs/
    handoff/           交接方案
    spec/              现行规范
    adr/               技术选型记录
```

本轮只产生 `README.md`、`AGENTS.md`、`LICENSE` 和 `docs/`。代码目录到对应期次再建,不放空壳。**[我的判断]**

仓库公开,许可见 §12。现状是:`write-core/Cargo.toml` 声明了 MIT 但没有 LICENSE 文件,`sumi-protocol` 没有声明,note.md 根目录是 Apache-2.0。

## 7. 本轮交付物

### 7.1 交接方案 `docs/handoff/`

| 文件 | 内容 |
|---|---|
| `00-overview.md` | 为什么拆、拆成什么样、当前状态、读文档的顺序 |
| `01-inventory.md` | 逐目录清单:现位置、规模、依赖、归属、迁入期次。覆盖 §5.2 全部条目,`scripts/sumi/` 逐文件判定 |
| `02-migration-plan.md` | §8 的分期计划,每期写明前置条件、步骤、验证命令、回退办法 |
| `03-notemd-contract.md` | §5.3 的四部分契约,含原生编辑面当前能力的完整列表(从现有代码读出,不凭印象) |
| `04-known-gaps.md` | 已知缺口与未决项:体验对齐清单(P1–P10)的现状、原规范 §10 的未决决策、Windows 未交付等 |

### 7.2 现行规范 `docs/spec/`

把 1 份主规范(721 行)、14 份增量规范和 `2026-11-08-plugin-payload-extraction.md` 中仍然有效的内容,合并成按主题组织的一套:

| 文件 | 内容 | 主要来源 |
|---|---|---|
| `00-product.md` | 产品定义、命名、成功标准、边界、非目标 | 主规范 §0–1、品牌命名 |
| `01-pages-and-storage.md` | 纸页模型、身份、顺序、纸页存储、崩溃恢复与本机正文优先 | §2.1、§5、2026-11-09 P0 |
| `02-markdown-and-line-time.md` | Markdown 边界、隐藏元数据、行时间语义 | §3、§5.2–5.3 |
| `03-sync.md` | 同步线协议、身份与配对、合并语义、恢复与运维 | §6、同步服务 README、`WIRE.md`、插件后台 `sync.rs` |
| `04-editing-experience.md` | 排版、主题、光标、聚焦、快捷键语义、剪贴板、IME 边界、打字音 | §2.2–2.5、各增量规范 |
| `05-fonts.md` | 字体目录、按需下载、校验、回退、许可 | §2.2 |
| `platform/notemd-desktop.md` | 插件形态、vault 投影、专用 Tab、宿主更新边界、macOS 与 Linux 的平台差异 | §4、§7–8、Omarchy 与体验对齐规范 |
| `platform/ios.md` | iOS/iPadOS 版规范(§10 的展开) | 新写 |
| `platform/later.md` | Windows、Android、ESP32、桌面独立应用的定位与现状 | §6.4、§9 |
| `MAPPING.md` | 旧文档章节到新文件的对照表 | 新写 |

重写规则:

- 只写现行规则,不写变更过程。被推翻的决定不进正文,只在 `MAPPING.md` 留一行去向。
- 每条规则标状态:`已交付(macOS)`、`已交付(Linux)`、`计划(iOS)`、`未定`。状态依据现有发布证据,不凭推断。
- 平台无关的规则放主题文件;某个平台特有的实现放 `platform/`。例如“光标是稍粗竖线、4 秒呼吸”是主题规则,“用 AppKit 公开 API 抑制系统细线”是 macOS 实现。
- 工程数值(快捷键、尺寸、阈值)保留原规范“实现团队补充”的标注,不冒充用户选定。
- 历史证据不复制,链接到 note.md 仓库的宿主 tag、提交号和报告路径。
- 来源不限于文件名带 sumi 的规范。还要纳入 `2026-11-10-omarchy-plugin-shortcuts.md`、`2026-11-11-release-input-method-companion.md`、`2026-11-12-fcitx5-name-correction.md`、`2026-11-11-omarchy-amd64-ime-release.md`、`2026-11-11-writing-plugin-groups.md`,并登记进 `MAPPING.md`。
- 0.1.15 和 0.1.16 的行为(例如进入后从文末续写)没有对应规范,以代码、CHANGELOG 和 `docs/superpowers/reports/2026-11-12-sumi-entry-*` 为准补进新规范。
- 旧文档留在 note.md 原处不删,文首加一行“现行规范已迁至 sumiwrite”的指引。这是对 note.md 的唯一改动,放在第 1 期做,不在本轮。**[我的判断]**

### 7.3 技术选型记录 `docs/adr/`

每条一页:背景、决定、放弃的方案及原因、后果。前七条是把已有决定补记成文,后五条是本次新决定。

| 编号 | 决定 | 类型 |
|---|---|---|
| 0001 | 内核用 Rust,CRDT 用 Yrs,线格式为 Yjs V1 | 补记 |
| 0002 | 正文是单个 Y.Text,行时间随字符贡献保留,不用行号或后写覆盖 | 补记 |
| 0003 | 便携文件是小 YAML 头加 Markdown 正文加 JSON sidecar;完整历史在 SQLite | 补记 |
| 0004 | 同步服务用 Cloudflare Worker + Durable Object + R2,私有单用户、配对码接入 | 补记 |
| 0005 | 桌面用各平台原生文本控件,不用统一 Qt 或 Web 编辑器 | 补记 |
| 0006 | 持久化、同步协调、字体下载放插件后台进程;宿主保留内存 CRDT、实时编辑会话与原生桥 | 补记 |
| 0007 | 字体按需下载,不随宿主或插件打包 | 补记 |
| 0008 | 独立单一仓库;桌面先留作 note.md 插件,原生编辑桥归宿主 | 新 |
| 0009 | 纸页存储与 vault 投影分层 | 新 |
| 0010 | iOS 用 UIKit/TextKit 2 + SwiftUI,内核经 UniFFI 复用 | 新 |
| 0011 | iOS 第一阶段自用;身份层与纸页层分开 | 新 |
| 0012 | 实时编辑会话与同步协调下沉为共用 Rust 模块,桌面与 iOS 共用 | 新 |

### 7.4 `README.md` 与 `AGENTS.md`

- `README.md`:一段产品说明、仓库地图、当前所处期次、文档入口。
- `AGENTS.md`:规范在哪、哪些东西归 note.md 不能在这里改、状态标注的规矩、iOS 与桌面必须共用内核的红线。

## 8. 代码迁移分期

本轮是第 0 期。后面各期各自另立计划,本设计只定顺序和验收口径。

| 期 | 做什么 | 完成的标志 |
|---|---|---|
| 0 | 建仓库,写 §7 的全部文档 | 用户通读并认可规范与交接方案 |
| 1 | 迁 `write-core`、`sumi-protocol`、`write-sync-worker`,保留 git 历史;note.md 改为按 tag 引用;旧规范文首加指引 | 新仓库三个模块测试全过;note.md 宿主与插件照常构建,现有 Sumi 测试全过 |
| 2 | 迁插件壳、资源、插件侧脚本;打通“sumiwrite 出包、note.md 市场上架” | 从 sumiwrite 构建的插件包在正式宿主上安装并通过现有验收 |
| 3 | 把实时编辑会话(宿主 `src-tauri/src/sumi/`)和同步协调(插件后台)中与宿主无关的部分下沉到 `session/`;宿主和插件后台改为调用它 | 桌面行为不变,现有会话、恢复、同步测试全过;`session/` 不依赖 Tauri 和插件 SDK |
| 4 | iOS/iPadOS 应用(§10) | TestFlight 版可与桌面跨设备续写 |
| 5 | 评估桌面独立应用 | 按 §9 给出结论 |

迁移方法 **[我的判断]**:在 note.md 的一份全新克隆上用 `git filter-repo` 按路径提取并改名,再并入 sumiwrite。note.md 一侧在同一期内删除对应目录并改依赖,不留副本。

## 9. 桌面独立应用的评估标准(第 5 期)

满足下面任意两条,就启动桌面独立:

- 过去一个季度里,因为原生编辑桥改动而被迫配套发宿主的次数,明显多于宿主自身需要的发版。
- iOS 版证明内核加原生界面的组合可以脱离宿主运行,且维护成本可接受。
- 出现不使用 note.md 但想用玄霜写作的桌面用户需求。

独立时,原生编辑桥随之迁入 sumiwrite,note.md 改为只识别和阅读 `.writing.md`。

## 10. iOS/iPadOS 版

### 10.1 第一阶段范围

**做**

- 一页纸写作:打开即恢复上次纸页、光标和阅读位置。
- 纸页概览、新建、上一页、下一页、移到废纸篓与恢复。
- 六种主题、字号、行距;六组字体按需下载,规则与桌面相同。
- 自定义竖线光标,呼吸或常亮。
- 系统输入法正常组字、选词;正文避让键盘,接上硬件键盘后收回留白。
- iPad 硬件键盘快捷键,按规范中的语义映射。
- 离线写作,联网后自动合并;与桌面同页并发编辑。
- 配对:粘贴桌面端生成的邀请文本并填写同步服务地址,加入同步空间;凭据存钥匙串。邀请含 256 位密钥、5 分钟过期,不适合手输,靠通用剪贴板或隔空投送传到手机。
- 把当前纸页导出为 Markdown(系统分享)。

**不做** **[我的判断]**

- vault、文件夹、文件名。
- 打字音效(留到后续)。
- 自定义输入法或键盘扩展。
- 专注窗口的固定尺寸规格(手机无意义;iPad 用系统的多窗口与全屏)。
- 注册登录、付费、上架。
- 扫码配对。桌面现在只输出邀请文本,没有二维码;加二维码要改桌面插件,留到后续。

### 10.2 架构

```
SwiftUI 外壳(纸页概览、设置、配对)
        │
UIKit 编辑面(UITextView + TextKit 2,自绘光标)
        │  编辑事务(修订号 + 可见 UTF-16 范围)
Swift 薄适配层(把 UIKit 回调转成会话调用,钥匙串读写)
        │  UniFFI
Rust:session(单一编辑 owner、组字期间暂缓远端更新、本机输入日志、
            崩溃恢复、同步协调与同步客户端)
      core(文档、SourceMap、存储、候选会话)
```

要点:

- 内核编成 XCFramework,经 UniFFI 生成 Swift 接口。编辑事务的形状与桌面原生桥一致:原生回调带修订号和可见 UTF-16 范围,由内核做最小的规范 Markdown 事务。
- 组字中的文字不进 CRDT;组字期间到达的远端更新先暂存。这是内核 README 的既有规定,iOS 照做。
- 持久化在后台线程,输入线程不等锁。
- 会话与同步逻辑不在 Swift 里重写。**[我的判断]** 现在这些逻辑分在两处:宿主的 `src-tauri/src/sumi/`(owner、组字防护、输入日志、恢复,约 8.7k 行)和插件后台的 `sync.rs`、`coordinator.rs`、`durability.rs`(约 6k 行)。它们是数据不丢、合并正确的关键,测试也最重。在 Swift 里重写一遍,就违反了“两端实现不分叉”的反目标。所以第 3 期先把与宿主无关的部分下沉成 `session/`,第 4 期 iOS 直接用。切分方式留给第 3 期的计划。
- 插件后台的 WebSocket 用了 `tokio-tungstenite` 的 `rustls-tls-native-roots`。这套根证书加载方式在 iOS 上很可能不可用(未实测),下沉时要换证书校验方式,记入技术选型记录 0010 的后果。
- 最低系统版本 iOS 17 / iPadOS 17。**[我的判断]** 理由:TextKit 2 在该版本上足够稳定,自用场景不需要照顾旧设备。

### 10.3 里程碑

| 里程碑 | 内容 | 验证 |
|---|---|---|
| M0 | 内核过 FFI:XCFramework 构建,Swift 侧加载现有互操作夹具 | 夹具往返结果与 Rust 测试一致 |
| M1 | 编辑面:TextKit 2、自绘光标、主题、中文组字 | 真机上中英文输入、选词、撤销正确,无系统细线 |
| M2 | 本机存储与纸页概览,崩溃恢复 | 强杀进程后正文不丢 |
| M3 | 同步与配对 | 与一台 Mac 同页并发编辑、离线重连后合并正确 |
| M4 | iPad 打磨:硬件键盘、分屏、指针 | 快捷键表逐项通过 |
| M5 | TestFlight 自用版 | 连续一周日常使用无数据丢失 |

M0 排在最前,因为它验证整条路线能否成立;不成立就回到 §4.4 重选。

### 10.4 为公开发行留的口子

- 身份(空间、设备、凭据)与纸页数据在协议和代码里分层,将来换登录方式不动纸页层。
- 配对界面不出现管理员密钥。
- 规范里把“单用户”写成当前部署形态,不写成协议假设。

## 11. 留给执行者的

- `01-inventory.md` 中 `scripts/sumi/` 每个文件的归属判定。
- `03-notemd-contract.md` 中原生编辑面能力列表的整理方式和版本编号方案。
- 规范各条规则的状态标注,须逐条对照现有发布证据。
- 第 1、2、3 期的具体步骤,到时各自另立计划。
- iOS 的 Bundle ID、开发者账号、应用图标等发行事务。

## 12. 可见性与许可

- **仓库公开。** **[用户定]** note.md 是公开仓库,宿主要按 tag 引用 sumiwrite;内核和插件源码原本就公开在 note.md 里,保持现状。
- **许可证全仓库统一 Apache-2.0,与 note.md 一致。** **[我的判断]** 第 0 期在仓库根放 LICENSE;第 1 期迁入 `write-core` 时把它 `Cargo.toml` 里的 MIT 声明改为 Apache-2.0,并给 `sumi-protocol` 补上声明。
- iOS 的发行事务(Bundle ID、签名身份、TestFlight 配置)不进仓库,只放凭据引用。
