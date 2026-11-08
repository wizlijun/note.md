# 宿主专属功能迁入插件：只读源码审计

审计日期：2026-11-08。旧基线 `v6.1107.4`：tag object `e4e508c02f5b11049660cd49a26b2297d702f00a`，实际源码 commit `0bca39b5fa3335aae9a73b79926074ea2856bef0`（已用 `git rev-parse v6.1107.4^{commit}` 核对）；本轮冻结源码 `261d6fe6b7d2c2e22aed48a26850ec52dc399b53`。未修改受控源码，未构建删减版，未发布市场索引。

## 结论

已有真正的原生可执行插件机制，能够把 Sumi 后台业务放进插件包；目前没有可下载安装并在宿主进程内装载的 dylib 编辑器机制。当前 Sumi 是小型 UI 插件加宿主内置编辑/CRDT/持久化/同步，因此不是把某个文件从包 A 移到包 B 就能完成。字体已改为点击后独立下载，不再贡献本轮宿主内置字体体积。

本轮压缩整包为 14,446,675 B；旧版整包为 13,505,710 B，净增 940,965 B。约 14.45 MB 是整包大小，不是 Sumi 增量。该净增也不能从源码行数、Cargo.toml 新条目或 Cargo.lock 条目直接归到 Sumi 某个组件。大小数据沿用主发布审计；本子任务没有生成可加总的二进制尺寸归因，也没有证明迁移可全部消除该净增。需相同工具链、profile、架构、签名/压缩口径的定向删减构建量化。

## 现有可利用能力

- `plugin-protocol/src/lib.rs:58,69,87,302`：Manifest v2 支持 target triple→包内 executable 的 binary map；Native/Wasm 两种枚举，但 Wasm 尚拒绝；没有 dylib 入口/ABI 字段，未知字段拒绝。
- `src-tauri/src/plugin_runtime/process.rs:62–98`：Native 由 tokio_command 启动子进程，stdin/stdout NDJSON JSON-RPC；清理环境变量，进程退出/超时受监督。这不是在宿主地址空间调用动态库。
- `src-tauri/src/plugin_runtime/lifecycle.rs:154–179,266–311,525`：每插件 app-data 目录、初始化、激活、崩溃/空闲停止；可配置常驻，pos-log 已使用后台驻留模式。
- `src-tauri/src/plugin_runtime/installer.rs:110–118,161,198`：完整包 SHA 和 minisign 验签后安全解包，保留 executable bit。现有原生插件已支持下载/安装本地可执行文件。
- `scripts/release-plugins.sh:551–590`：已有 Rust backend 双架构构建、Developer ID runtime/timestamp 签名、每架构 notemdpkg+minisig。现有 `plugins-src/health-sync/manifest.v2.json` 就是可复用范例。

## Sumi 原生边界

`tauri-plugin-native-editor/build.rs` 用 cc 把 editor.m 编译为 `sumi_native_editor` 静态库，链接 AppKit/CoreText/QuartzCore。`src/platform.rs` 直接 extern C 调用；`src/lib.rs` 的 EventHandler 是同步函数，mount 经 with_webview 获取宿主 NSView，主线程控制实际编辑器。`src-tauri/src/sumi/mod.rs:959–1040` 在同步 native edit 回调里检查 surface/generation/revision、应用 write-core、入持久队列，然后回传新投影。

因此独立进程不能直接复用 NSView 裸指针及同步 Rust 回调；不能把每次输入改为阻塞主线程的 stdio 往返而仍声称无性能/IME风险。范围搜索 `libloading|dlopen(|dlsym(|LoadLibrary` 在 src-tauri/src、plugin-protocol、tauri-plugin-native-editor、plugins-src 的 rs/m/cpp/h 未找到市场动态装载实现。Cargo.lock 中 transitive dlopen 相关包不构成此功能。

现实的两级迁移：
1. 最小：保留原生 surface 与立即响应的内存会话模型；Sumi executable 后端接管网络同步、下载/缓存等后台职责。新增窄桥、状态/事件协议、退出刷新与重启恢复，沿用原生插件运行框架。下载器已使用宿主共有 reqwest/zip/sha2/Tokio，单移下载器不会挪走这些库全部体积。
2. 更彻底：让后端拥有 CRDT、SQLite outbox/inbox、Markdown 投影；宿主保留通用原生编辑桥。必须先定义异步操作序号/确认、立即显示/拒绝回滚、IME composition、undo、远端更新屏障、掉线恢复、关闭 flush，避免每键阻塞 IPC。此方案可迁走更多业务代码，但属于架构工程，不能在冻结发布时当简单打包修正。

另一条路线是新建 in-process dylib 插件类型以保留同步回调，但当前没有 loader、ABI 版本、线程/生命周期、更新卸载/回滚与签名团队验证协议，不是最小复用路线。独立 Sumi app 也不能自动满足宿主 writing.md 专用原生 tab 的现行 spec。

## macOS 分发边界

当前脚本已做原生插件 Developer ID codesign，但没有在该发布脚本发现插件单独 notarization；找不到身份时脚本目前仅 WARNING 后留下 unsigned，未来 Sumi 原生后端正式发布需要把适用签名/运行验收设为硬门槛。minisign 证明市场包来源，不等于 Apple 代码签名或公证。宿主 Entitlements.plist 只有 Apple Events 与位置权限，没有关闭 library validation 的设置；不能靠关闭安全校验把 dylib 变成现成功能。不同可执行身份访问 Sumi 旧钥匙串项可能涉及既有授权迁移，宜保留窄凭据代理或专门设计并验收。上述为仓库能力/缺口陈述，未声称已完成新插件的 Apple 公证验证。

## 旧 13.5 MB 基线中的特殊功能

下列均从旧 tag 读取，不能算作本轮 Sumi 新增：

| 功能 | 旧源码证据 | 判断与可迁移边界 |
|---|---|---|
| Habitat | `src-tauri/src/plugin_runtime/knowledge_api.rs:7` 明确只允许 notemd.habitat；`knowledge_structure/*`、`habitat-core` | 确有插件专属宿主知识快照/历史/冲突保护。分析引擎已在 habitat/backend；宿主与 Vault Git 提交前验证、索引捕获绑定，适合拆成小共享契约/通用版本化事务接口，不能直接删。 |
| Memory | `plugin_runtime/host_api.rs:111`；`memory_control/*`；`cli/memory.rs:5` | 插件 UI 用 host.memory，但同一实现也供 CLI、smart_search.rs:687、Vault Git 同步使用。并非只供插件窗口；迁出需要可供 CLI/搜索/同步消费的后台服务，否则破坏统一状态语义。 |
| CDR | `plugin_runtime/cdr_repository.rs:1`；`cdr_managed_document.rs`；Memory cdr 前端 | 当前调用者主要 Memory，但接口按 plugin_id 隔离、opaque aggregate/CAS，不理解具体文档模型；更像通用安全存储桥。把它当大型第三方编辑引擎不准确。 |
| Power Mode | `plugin_runtime/power_mode.rs:1–8`；src/editor-kit/power-mode-config.ts、src/lib/power-mode | 确有插件专属设置/特效对接，特效在宿主和 Editor Kit 生效；可插件化资源/懒加载，不过 Rust 配置桥只有共享 JSON 依赖，未证明会显著瘦二进制。 |
| 定位 pos-log | `plugin_runtime/location.rs:1–17`；`plugins-src/pos-log/backend/Cargo.toml` | 业务定时记录已是原生插件；宿主保留 CoreLocation 是为 note.md 的 TCC 身份与 runloop，源码记录过 sidecar 权限失败。应保留通用受权位置桥，不宜搬回裸后台进程。 |
| Health Sync | `plugins-src/health-sync/backend/Cargo.toml`、manifest binary map | 健康解析/API/存储早已是独立可执行插件，quick-xml/csv/health业务未发现链接进旧宿主。SQLite 仍为搜索所需，见下。 |
| 录音/会议 | `plugins-src/meetings/backend/Cargo.toml`；旧源码检索 | meetings 为独立后端。旧宿主未找到 microphone/AVFoundation/cpal/whisper 录音引擎；host_api 中 recording closure 是测试记录调用，并非录音。此检索不证明外部服务或其他独立工程没有录音。 |
| 字体 | `themes/fonts.rs:1`、`themes/commands.rs`；notemd-fonts/Cargo.toml | notemd-fonts 服务宿主内置 Markdown 主题，typst-reader 后端也复用；不是只为某插件偷偷放入宿主的字体包。fontdb 属于扫描字体代码，不等同把字体二进制嵌入。 |
| 白板 | `canvas_document.rs:1`、canvas_resource.rs | JSON Canvas 是宿主一等文档读写/修订保护，无白板专属大型 Rust 渲染引擎证据；前端资源可研究懒加载，但不能以 Rust 源文件大小估 DMG 节省。 |
| 分享 | `project_share.rs:1`、share_guest.rs:1、lib.rs command/menu 注册 | 宿主项目镜像/公开分享/访客下载一等功能，非市场单插件；复用现有 zip/HTTP/Git。可另做可选功能产品设计，不能归因 Sumi 或现有单插件。 |
| 主题编译 | themes/compiler.rs；旧 Cargo 的 lightningcss | CSS/Typora 主题导入宿主功能。可能是可选模块候选，但不是 Sumi/字体下载新增，也不能从依赖名字估收益。 |

## 依赖去重及测量限制

- 旧 `searchidx/Cargo.toml` 已有 rusqlite0.40 bundled/hooks、jieba-rs0.10、pulldown-cmark0.13。Sumi 新增直接 rusqlite 声明不等于新塞整份 SQLite；迁出 Sumi 仍需搜索 SQLite。
- 旧 habitat-core 依赖 jieba/pulldown/zstd/leiden，但算法是否被最终宿主引用由链接优化决定，不能把整个 crate/词典都算进宿主。jieba 与搜索共享。
- 旧 reqwest/rustls/Tokio/zip/sha2/serde 已为更新、市场、同步等使用，不能按插件迁移全部扣除。
- 新 direct use 包括 write-core、tauri-plugin-native-editor、html5ever（Sumi paste.rs）、tokio-tungstenite（sync.rs）、security-framework（credentials.rs）和 reqwest 压缩 feature。只是源码用途候选，不是新增 linked bytes。旧 lock 已可能含相同或其他版本 html5ever；lock 存在、direct 新增、实际被 macOS release 链接是三种不同事实。
- 最终收益需基于具体实现后的匹配构建及压缩成品比较；独立后端会复用/重复链接部分 Rust 依赖，因此“宿主更小”不自动等于“安装插件后总占用更小”。
