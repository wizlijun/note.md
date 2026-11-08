# Sumi：macOS 首版实施计划

日期：2026-11-07。状态：实施与验收中；本文不是完成证明或发布记录。

需求依据：[全平台设计](../specs/2026-11-07-immersive-write-design.md)。首版必须同时交付原生编辑、本地 Markdown、行首末时间、CF 增量同步及离线并发自动合并；不能把单机原型称为首版完成。

选型已确认：原生桥封装为 `tauri-plugin-native-editor`；macOS 使用 NSTextView/TextKit 2，Windows 使用 Win32 Rich Edit，不采用跨桌面统一 Qt。Linux 的 Omarchy Qt 6 路线仍是独立平台原型，不给 macOS/Windows 引入 Qt。

后续平台参考已按用户补充固定：ESP32 优先参考 Draftor 的自研编辑内核/bgIME/显示链路；Linux 以 Omarchy 为主要目标，优先验证 Omawrite 同栈的 Qt 6 富文本方案。它们分别需要 Markdown/同步适配与 Qt/GTK3 原生 tab 可行性验证，不改变本轮 macOS 首版范围；细节与证据见设计 §4.1、§6.4。

## 1. 原起点与当前落地

- 宿主 Tauri 2 / Svelte 5，现有 Rich 是 @moraya/core + ProseMirror。
- file_views 可按顶层 frontmatter 选 `.md` 专用视图；有 editor.write 整篇快照保存，原 UI 为 iframe；现已扩展 `native-editor` surface，由 `NativeFileView` 挂载原生正文。
- custom_editors 不允许接管 `.md`；WindowContribution 已增加原生 surface 与 `resizable` 等窗口声明；macOS 后端随宿主编译。
- 原文件 session 依赖 web editor；现通过 `src-tauri/src/sumi/` 与 `src/lib/sumi/` 交接原生 session、Source、外部文件和持久化，验收仍须核对所有生命周期路径。
- 宿主 macOS 最低 11.0；Sumi 原生功能要求 13+ 并执行运行时能力检测。实施不顺手抬升主应用最低版本。

## 2. 当前代码边界

| 模块 | 职责 |
|---|---|
| `plugins-src/write/` | Sumi 插件 manifest（显示名 Sumi）、纸页入口/概览、设置与状态；不在 iframe 处理正文击键 |
| `write-core/` | Rust 文本/行时间模型、Yrs adapter、源映射、Markdown 解析序列化、持久 outbox 与投影；与 UI/平台分离 |
| `tauri-plugin-native-editor/` | 随宿主编译的 Tauri 插件 crate；统一 surface 接口、平台能力探测及 macOS AppKit 后端，负责生命周期、焦点/IME/外观、主线程边界 |
| `src-tauri/` | 注册原生编辑插件、检查调用权限、绑定 write-core 文档 session；不另建第二套原生编辑桥 |
| `write-sync-worker/` | Worker 鉴权、SQLite DO、WebSocket、页面 CRUD、快照与恢复 |
| `write-core/` schema、`write-sync-worker/src/protocol.ts` | 版本化消息、Yrs/Yjs 双向黄金 fixtures；未另建 write-protocol crate |
| `src/lib/plugins/`、`src/components/EditorPane.svelte` | 原生视图能力探测/选择/几何与 overlay 协调 |
| `plugin-protocol/` | 窄 capability 和 manifest 扩展，生成 TS/Rust 类型；未知旧宿主明确回退 |

P0 实现选择 Objective-C ARC + 固定 C ABI 薄桥，便于直接实现 NSTextView 委托并避免 Swift 运行时打包约束。只保留这一种 macOS 生产桥，不同时维护 objc2/Swift 替代实现；通用 Rust API 仍由 tauri-plugin-native-editor 提供。原生代码随宿主签名发布；插件不动态加载任意可执行库。

桥接 crate 不承担 Markdown/source map、行时间、CRDT 或文件/网络存储；这些由 `write-core` 负责。首版只实现 macOS 后端，其他平台明确报告能力不可用，不用空后端宣称支持。最小接口沿设计 §8 的 mount/activate/setBounds/setAppearance/applyRemote/flush/detach；正文编辑通过进程内 Rust 接口交接，IME 组字、光标与即时绘制不等待 JS 往返。applyRemote 只应用内核验证后的编辑事务，flush 等待内核持久化结果，不能把控件刷新当保存成功。

实施状态核对（2026-11-08）：内核、原生桥、宿主、插件与 Worker 均已有实现。内核提交 `94fde1d8` 与稳定选区序列化提交 `0925f71d` 有独立测试；`write-core/tests/` 覆盖并发时间、UTF-16、导入、文件对与增量恢复。下面清单保留为整项验收门禁：涉及真实输入、断电、无障碍和完整生命周期的混合条目，不能因单元测试通过直接勾选。冻结发布 tag 与实际包验证由发布记录提供。

## 3. P0：先验证五个不可绕开的风险（约 1–2 周）

- [ ] **原生 surface**：通过宿主实际注册的 `tauri-plugin-native-editor` 在真实 Tauri 窗口内挂载 NSTextView/TextKit 2，同时验证 tab、独立固定窗口、系统全屏、挂载/销毁与过期 session 拒绝；验证 macOS 构建不引入 Qt。禁止先用外置独立 App 替代 tab 验收。
- [ ] **真实输入**：中文拼音/注音、长组合串、候选选择、Cmd+A、撤销、剪贴板、VoiceOver。应用菜单与 first responder 正确路由。
- [ ] **Markdown 最小编辑**：原生可见位置映射到源范围，测试标题/强调/链接/列表/空行/软换行/emoji/未知块，不全篇重序列化。
- [ ] **跨语言与行身份**：锁定 Yjs/Yrs 版本及 UTF-16 偏移；Y.Text LF 属性、属性继承抑制、并发同处回车、合行、Undo、重复/乱序更新收敛。
- [ ] **并发时间归属**：一端分裂另一端改右半、一端合行另一端改右行、跨行删除与撤销；基于稳定范围/边界 provenance 汇总，不能只检查原行 ID 的极值。

验证输出：可复跑 demo、固定测试正文、机器/OS/字体/输入法版本、原生视频/截图、性能数据与协议 fixture hash。所有数据只在隔离 Vault 与测试账号中生成。

退出条件：五项通过再冻结数据协议和 native surface API。失败就修订方案与工期；不能隐性改回 WebView、禁掉离线并发或省略 native tab 后称需求已完成。

## 4. P1-A：文档内核与离线持久化（约 1 周）

用户已确认设计 §5.2 的 MD + `.writing.meta.json` 文件布局。serializer 已实现 schema 1 / sidecar-v1；紧凑时间事件 v1 和 SQLite checkpoint + 连续 delta 协议见设计 §5；完整内容迁移需同时携带匹配的正文与时间快照。

- [ ] 实现 page/epoch/逻辑行身份/时间、局部 Markdown patch 与格式子集；原生富文本不接触隐藏元数据。
- [ ] 行时间 reducer 对并发、拆合、导入、空行、撤销有确定规则；first/last 不使用一个可被并发覆盖的普通 LWW 对象。
- [ ] SQLite 原子提交 CRDT 增量、时间属性、outbox、投影需求；已本地保存仅在持久成功后出现。
- [ ] 固定 WAL/synchronous 耐久配置与平台 flush 策略；远端 inbox 同样持久化，分别验证进程崩溃与断电，不混用结论。
- [ ] 落盘到 `inbox/writings/YYYY-MM-DD-%2d.writing.md`（两位补零日序号）；固定首次有效输入的本地日期，服务端协调正式序号，离线重名安全改名，UUID 身份不变。
- [ ] 从同一已提交 revision 生成 MD + sidecar；逐文件原子替换、body/行 hash 校验和投影完成日志；关闭/切页 flush。验证两文件之间崩溃、磁盘满、权限失败，先识别外部改动再恢复，不宣称跨文件原子。
- [ ] 分别验证 MD-only 正文恢复、MD+sidecar 时间快照恢复、完整数据库备份恢复；未知元数据保留、重复 page UUID、旧时间快照不得回滚现有 session、外部改动三方导入。
- [ ] 生产格式黄金样本覆盖空正文、空白/尾部空行/末尾 LF、硬换行、围栏、正文 HTML 注释、重复行、未知 schema 与缺失/损坏 sidecar；正文与时间表对应且不吞正文。
- [ ] companion 的改名/移动/迟到/孤儿检测，以及文件树、搜索索引和分享规则；从冻结快照打包导出，不直接复制正在变化的文件对。
- [ ] 注册 `Writing Page` 到 `src/lib/okf/concept.ts`；同步 origin 类型映射与生成 fixtures，按真实作者签名。

验收：输入→崩溃→重开不丢已报告持久化的文字；MD 正文与模型一致，伴随时间表正确；无编辑导入导出正文无损；导入损坏元数据不覆盖原文。

## 5. P1-B：CF 服务与多设备同步（约 1–2 周）

- [ ] 开通隔离开发环境，选择现有身份基础设施或设备配对实现；定义 token 更新/撤销、账号归属和数据限额。
- [ ] Worker + SQLite DO 的 pages/不可变增量日志/轻量因果校验索引/去重/目录游标；上线 migration 可回滚。
- [ ] WebSocket hibernation、固定版本分页日志补齐与 durable ack；字节落盘成功才确认。首版完整 replay，state vector 提示不冒充已实现服务端裁剪。
- [ ] 新建/列表/编辑/删除/恢复 API；page 与 operation UUID 幂等；tombstone 与迟到正文更新隔离。
- [ ] 离线目录 create/delete 与正文 outbox 原子保存，重连遵守 create→body 依赖；并发新页和被删排序锚点确定收敛。
- [ ] R2 不可变分段日志、schema-2 校验清单与恢复演练；后台网络上传不阻塞编辑，保留旧副本因果状态。
- [ ] 两台 Mac 或两个隔离实例同时编辑、离线不同位置/同位置输入、断线重试与重新订阅。

验收：同步后两端正文、行身份、时间摘要与页面目录收敛；不存在整页覆盖；持久失败不 ack；设备撤销后连接/HTTP 操作拒绝。服务状态/日志不记录正文、token 或隐藏时间明细。

发布预算用实际请求计数与日志增长估算，列出 1/3/10 活跃设备、每日输入时长、页面大小及备份保留量。服务已进入独立部署/云验收流程，具体版本、配额计量与恢复结果见发布记录；不以本文状态代替线上证明。

## 6. P1-C：macOS 插件与宿主体验（约 1–2 周）

- [ ] 插件入口、新纸页、上一页/下一页、按需概览、废纸篓；恢复上次位置，不显示路径/日期。
- [ ] 黑白/黑灰/白黑/米色深灰主题、字体与回退、全局字号、行距、最大正文宽与底部避让。
- [ ] 正文默认 NSTextView/TextKit 2；系统支持不足时清楚回退；运行时断言实际布局引擎，避免访问旧 layoutManager。
- [ ] note.md 按 `type: Writing Page` 进入原生视图，Source/普通 Rich 可显式切换；专注窗口固定尺寸或全屏。
- [ ] 文档 owner 接入：打开/切 tab/换 Vault/退出/插件禁用/卸载/外部磁盘变更，逐条交接并保持恢复路径。
- [ ] native surface 的 frame、Retina、滚动、宿主弹层、first responder、选区与辅助功能；旧 session 事件不会写到新文件。
- [ ] 远端变动不打断 IME，选区通过相对位置跟随；本地 undo 不撤销远端编辑。
- [ ] 主题菜单复用全局 Web popup 样式或系统原生菜单，真实验证 hover 与遮挡。

验收：用户可从插件打开一页纸输入→同步→普通 Vault 打开同文件→原生 tab 续写→Source 阅读→回到专注窗口，全文、时间、选区与保存状态均正确。

## 7. 性能测试计划（目标，非测量结果）

三组同机基线：当前 note.md Rich；同 Web 引擎裁掉非写作扩展的最小配置；NSTextView 原型。测试使用发布构建，记录 CPU 架构、机器、系统、屏幕刷新率、字体与文档 hash；既比较编辑模块增量，也记录整个宿主内存，避免只挑有利指标。

数据：1 万 / 10 万 / 100 万字符；中文长段、每行极短、列表/强调混合、单段超长、emoji 与组合音符。1 万/10 万为首版正常验收，100 万作为压力边界，明确退化点且不能丢数据。

操作：连续输入、拼音/注音提交、大段粘贴/删除/撤销、滚动、切纸页、远端同步到达、后台 MD 投影、断网重连、冷启动。至少 5 次独立重复；启动与稳态分别统计。

| 指标 | 首版建议门槛 |
|---|---|
| 已提交输入到画面 p95 | 目标 60Hz 机器 ≤50ms；不把 IME 用户选词等待算作引擎延迟 |
| 稳态输入停顿 | 不出现可重复的 >100ms 编辑主线程停顿 |
| 远端已提交输入可见 | 声明 RTT≤100ms 的测试网络下 p95≤300ms；离线/后台不适用 |
| 正常尺寸 Markdown 投影 | 停止输入后通常 ≤1 秒；长文单列结果，关闭 flush 可观察 |
| 打开纸页 | 10 万字符热打开目标 ≤500ms 达到可输入；冷启动单列 |
| 正确性 | 零丢字、零 composition 破坏、无元数据出现在正文或普通复制中 |

本地保存延迟单独统计：键入立即显示不等于已持久化；异步 WAL 可有极短未确认窗口，只有 commit 后才能显示“本机已保存”。不得拿异步未落盘状态冒充零丢失保证。

输入到画面需系统事件与帧呈现标记或高帧率录屏辅助，JS handler 时间不能证明物理输入延迟。用 Instruments/系统 profiler 核主线程、内存、CPU、能耗；真实硬件手动 IME 与辅助功能验收不可由合成事件完全替代。

不预设原生必胜。若原生优势不明显，报告真实数据并检查源映射、全文解析、布局失效与保存开销；不能通过不同字号/字数/关闭同步制造优势。

可复现性能脚本在 `scripts/sumi/`（提交 `d7154956`、`3c1c0136`）。三组共用固定语料和字体；程序化 Web dispatch→rAF 只表示绘制机会，原生 insertText→同步布局只表示程序调用链，不是物理输入到呈现帧。已有自动数据不勾选物理 input-to-frame / 真 IME / VoiceOver 门禁。隔离宿主脚本在 `scripts/sumi/acceptance/`；运行数据仍位于 `tasks/sumi-native/host-acceptance`，配置与 Vault marker 不变。`prepare.py` 仅准备 seed；`build.sh` 显式构建但不启动应用，benchmark 只追加到隔离插件窗口，不改正式插件 manifest。

## 8. 必过的系统验收矩阵

| 场景 | 必须证明 |
|---|---|
| 两端同位置离线输入、同段删除/格式修改 | 正文收敛且保留被合并操作；语法降级不丢原始文字 |
| 同行首次写入、split/merge与另一端编辑右侧、跨行删除/undo | 稳定行 ID，无属性继承污染；时间随最终范围归属确定收敛 |
| 日期序号命名、跨日续写、超过99页、离线同名及本地异源同名 | 路径符合新规则，UUID/行时间不变，不覆盖其他文件；重连映射收敛 |
| 离线新建后写入/删除、并发下一页、排序锚点被删 | create与正文依赖持久且幂等，无孤立正文/重复纸页 |
| 重复/乱序/部分发送后断线 | 幂等、缺失补齐、不会重复插字/新建页 |
| DO hibernate/重启、SQLite失败、R2失败 | 正文从持久状态恢复，未落盘不确认，备份失败不伪报完成 |
| 删除后旧设备带离线编辑重连 | 不复活页，不抛弃离线草稿；显式恢复行为可理解 |
| 快照整理后长期离线设备重连 | 因果状态/epoch 有正确补齐或受控恢复，不能直接覆盖 |
| IME 进行中远端插入/删除、切tab/关闭 | 冻结revision与相对锚点正确，旧offset不作用于新body；marked text不被替换，不永久卡在flush |
| native正文Cmd+A/退格/粘贴/撤销 | 隐藏元数据不可被误选删除；正文清空仍是合法页面 |
| Source更改身份/类型/epoch或全文清空 | 草稿保留、同步暂停并提供明确处理；不自动补回身份或删除云端 |
| 原生与Source/Rich交接、两窗口同页 | 同一 owner，无双写，编辑面接续保留身份 |
| 外部编辑、Vault同步、文件临时消失 | 自身投影不回声；无基线保存分歧，不误删云端页 |
| 两文件写入间崩溃、错配/缺失/迟到sidecar、配对改名 | 识别不完整投影与外部改动；正文可恢复，时间不伪造，不覆盖新稿 |
| 断电/磁盘满、只恢复MD、配对快照、完整备份恢复 | 已确认保存可恢复；正文、时间快照与完整因果恢复分开验收 |
| 旧宿主、macOS 11/12、插件卸载 | 能力不足有明确入口/回退，不崩溃、不损坏普通Markdown |
| 多屏/Retina/全屏/宿主菜单/VoiceOver | 原生区域正确、无悬空覆盖层、快捷键和可访问焦点正确 |
| 账号A访问B页/撤销设备/恶意超大update | 所有入口执行权限和限额，不靠客户端过滤 |

以上每组产生测试/实机证据及明确结果，不能仅勾选任务清单。测试只在隔离 Vault 和测试服务账号运行，不碰正式写作资料。

## 9. 提交、安装与发布

各独立阶段通过后精确提交，记录源码 commit、schema/fixture hash 和宿主最低版本。文档完成不等于功能进入安装包。

宿主含原生桥的新版本先构建签名；插件声明对应能力和宿主版本，再构建签名包。Mac arm64 是建议首个验收架构，Intel 另行构建/实机检查，不能用 arm64 测试宣称 Intel 通过。

发布前按 AGENTS 审计全部 worktree/分支/stash 与未提交文件；只纳入本功能已验证改动，更新双语未发布日志。插件市场沿用现有 Wrangler 3 + Account API Token 的 R2 上传/匿名验签/KV 索引/公网复核流程；宿主发布遵循现有签名公证链，不为本项目另开发布通道。

CF 同步服务是独立部署单元，复用仓库既有认证/工具版本约束，明确配置、迁移、回滚与备份。客户端先兼容后端滚动升级，协议不兼容时保留离线写作并提示升级。

最终交付证据包括：冻结源码/依赖、原生桥实际打包内容、两端同步结果、IME/性能报告、Markdown恢复样例、服务恢复演练、已发布包版本与下载验签。没有这些证据不写“首版完成/已全平台支持”。
