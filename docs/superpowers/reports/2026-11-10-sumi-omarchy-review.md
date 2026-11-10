# Sumi Omarchy 原生桥独立审查

日期：2026-11-10。范围：`tauri-plugin-native-editor/src/linux.rs` 与宿主 `src-tauri/src/sumi/mod.rs`、macOS `native/editor.m` 的事务及生命周期契约对照。此报告记录源码审查，不代表实机验收或正式发布；运行证据须引用对应测试记录。

本文保留各轮审查当时的“待验”状态；最终运行结果统一见 [实现验收报告](2026-11-10-sumi-omarchy-validation.md)，不能将早期记录误当作最终未完成项。

## 发现

| 编号 | 严重度 | 发现与依据 | 复核状态 |
|---|---|---|---|
| R1 | 高 | Linux `clipboard(true)` 原先直接发送剪切事件，但宿主仅 `cut:false` 回复 `clipboard_text`；剪切分支返回删除后的投影。因此原实现可删除正文而未更新剪贴板。macOS 先请求复制并写入剪贴板，成功后才剪切。 | 源码复核已修：先请求 `cut:false` 的 Markdown，取得文本并写入剪贴板后才发 `cut:true`；未取得文本不删除。实际剪贴板运行仍待验。 |
| R2 | 高 | `action()` 在 `failed` 状态拒绝所有动作，包括 `save`；本机日志失败后无法通过 Ctrl-S 到达宿主 `document_command("save")` 的精确重试与投影恢复。 | 源码复核已修：失败态允许 `save`；其余修改仍拒绝。已增加保存动作路由断言，运行结果由原生验收记录报告。 |
| R3 | 高 | 原 `preedit-changed("")` 立即发送 `Composition(false)`，可能早于最终文本的 Edit。宿主在 false 后允许处理远端更新，提交存在竞争窗口。 | 源码复核已修主时序：独立 composing 标记保持至 idle，检查预编辑仍为空、user_action 已结束，再发送最新 revision 的 false；inspect/投影/隐藏/detach/粘贴均用该标记。实际 Fcitx5 提交仍待验。 |
| R4 | 高 | `replace` 对话框调用无返回值的 `find()` 后，只检查当前选区非空。查找无结果时旧选区仍在，会替换不匹配的无关正文。 | 续查发现首次修复仅改 find 返回值，调用处仍有风险；现已复核改为 `matched = find(false)` 且 matched 才替换，并新增 GtkDialog 无匹配保留正文回归。运行仍待验。 |
| R5 | 中 | `accept()` 原先接受任意成功回执版本；Edit 的同版本回执也能应用 fallback 文本，旧版本回执可回退 accepted revision。macOS 的普通 Edit 要求回执严格增加。 | 源码复核已修：Edit 成功回执必须严格大于 base_revision；accept 拒绝旧 revision。已加入同版本回执拒绝回归，运行仍待验。 |
| R6 | 中 | 菜单路由把动作执行失败解释成未消费，原生编辑器在组字/失败状态拒绝动作时可继续落入宿主普通菜单路径。应区分命令归属与动作成功。 | 源码复核已修：原生 surface 拥有焦点时命令归属被消费，不再以动作成功决定是否落入普通宿主路由。原生菜单夺焦行为仍待实机验收。 |
| R7 | 中 | `request_text(None)` 提前返回，HTML-only 剪贴板无法进入宿主已有的安全 HTML 转文本链路。 | 源码复核已修：文本可为空，继续请求 text/html；两者均无时进入有界 RTF 转文本后备路径。异步返回继续核对 revision、选区、组字、可见和焦点。 |
| R8 | 低 | 快捷键仅过滤按下事件；对应释放仍发 KeyUp，thock 会响释放音。修饰键释放原先也发 Modifier。 | 源码复核已修：记录实际接受按下的 hardware_keycode，仅对应释放发送声音；modifier 释放不再发送 Modifier。端到端键盘音效仍待验。 |
| R9 | 中 | Linux `menu_command` 对 `input:*` 直接返回 false，而宿主在设置面板输入焦点下调用 `input:select_all/undo/redo` 后消费菜单事件，导致这些菜单操作无效。macOS 会转给当前输入 responder。 | 源码复核已修设置面板路径：查找当前 active GTK 窗口的 focused_widget，WebKit 原生执行 SelectAll/Undo/Redo；GtkEntry 支持 select_region 全选，不向失活窗口发送。`SetVisible(false)` 已将 GTK 焦点归还 WebKit，PreparePanel 成功后调用同一隐藏路径；实际菜单焦点与编辑结果由 Wayland probe 单独验证。 |

## IME 时序依据

GTK 官方 `GtkIMContextSimple` 的 `gtk_im_context_simple_commit_string` 先发预编辑变化/结束，再发 commit；`GtkTextView` 在 commit 回调中才开启 buffer user action、插入最终文本、结束事务。这确认不能把预编辑字符串为空等同于最终正文已提交。来源：[GtkIMContextSimple 源码](https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gtk/gtkimcontextsimple.c)、[GtkTextView 源码](https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gtk/gtktextview.c)。这是源码时序核对，未在本轮独立审查中操作物理中文输入法。

建议使用独立 composing 屏障：非空预编辑开始屏障；清空后延迟至当前 GTK 提交事务结束，再用最新回执版本发 Composition(false)。inspect、远端投影、隐藏、面板、detach 及粘贴均须尊重该屏障。延迟回调检查对象仍挂载及新组字状态，不使用捕获的旧 revision。

## 已核对的保护

- 宿主 `handle_native` 对 surface/generation/revision 和生命周期检查；本机持久队列失败保留 pending operation 与 native draft revision，并仅允许复制、结束组字及保存重试。
- Linux draft_error 回执保留旧 accepted revision、显示草稿并设只读；ApplyDocument 才解除冻结。`SetVisible(false)` 和 PreparePanel 拒绝隐藏失败草稿。
- 宿主正常 detach 路径先隐藏、捕获位置、flush 确认，再移除原生面；失败时恢复可见。不能仅凭原生 detach 函数缺少 failed 检查断言生产路径丢稿。
- 异步粘贴回调已核对 surface 身份、revision、选区、组字、失败、可见和焦点，避免普通延迟回调写入已换页或已变化的选区。
- 音效已在失焦、隐藏、detach、draft_error 及 monitor 切换发送 Stop；以上源码路径已复核，尚未由本审查独立运行端到端音效生命周期测试。


## 包装与依赖复核

- Linux 发布分支仍使用既有 `zip_pkg` / `sign_pkg`；仅 Apple 签名公证步骤按目标条件化。macOS 未指定目标时仍默认 Apple Silicon，Linux 才从 rustc host 推导；manifest 校验阻止不支持的目标。此为脚本审查，不表示已执行发布。
- Linux 开发安装使用 `${XDG_DATA_HOME:-$HOME/.local/share}/net.notemd.app/plugins`，与宿主应用数据目录一致；Sumi 音效从构建 UI 中移入 `resources/sounds`，与正式包布局一致。主代理已在隔离目录运行，具体证据归其验收记录。
- Arch 声明 `libsecret`、`libpulse`、`fontconfig`。续查后 Deb 已补齐 `libsecret-1-0`、`libpulse0`、`libfontconfig1`；此为依赖声明复核，不替代实际 deb/Arch 安装验证。
- ELF 校验器只验证格式、x86_64 架构、可执行权限和程序头边界；它不替代实际启动、`ldd` 依赖核对、签名回读或 Arch 安装验收。

## 本次审查执行的轻量检查

- `bash -n scripts/release-plugins.sh scripts/dev-install-plugin.sh scripts/sumi/test-linux-credentials.sh`：通过。
- `python3 -m unittest discover -s scripts/sumi -p test_verify_linux_binary.py`：1 项通过；仅测试 ELF 校验逻辑，不表示实际发布包可运行。

## 本次审查未执行的验证

本轮为源码独立复核，未运行或据此宣称物理 Fcitx5 选词、系统剪贴板往返、GTK 菜单焦点转移、完整宿主 owner 交接与安装包通过。原生事务、对话框与 Wayland probe 的新增测试由实现/验收代理运行后另记；主代理报告的后台初始化和依赖结果也不替代原生编辑验收。


## RTF-only 补齐（独立模块）

采用固定 `rclip-rtf = 0.1.0` 默认无 feature 解析器，来源 [rich-clipboard](https://github.com/fschutt/rich-clipboard) / [crate 文档](https://docs.rs/rclip-rtf/0.1.0/rclip_rtf/)，许可 MIT OR Apache-2.0。源码审查确认它及唯一必需依赖 `rclip-core` 均禁止 unsafe，解析无需 I/O、网络、外部程序或字体渲染；嵌套上限 64，使用固定栈与循环。未使用系统 LibreOffice 或手写 RTF 解析器。

新增 `linux_rtf.rs` 用其 Parser 提取纯文本，输入和解码后输出分别限制 2 MiB。Unicode CJK、正确 UTF-16 代理对、uc fallback、CP1252/Latin-1 可用；损坏序列或不支持的旧编码产生替换字符时明确拒绝，不将乱码写入正文。此限制包括合法但字面包含 U+FFFD 的 RTF，需要用户从来源复制纯文本；普通文本粘贴不受该转换策略影响。

独立轻量 Cargo harness 直接引用生产模块，5 项测试通过：

- 中文、emoji、fallback、转义括号、换行、Tab 与 CP1252；
- formatting/font/author metadata、field 指令、图片和对象数据不泄露为正文，显示 field 标签保留；
- 错误签名、不平衡分组、截断 binary、孤立代理、旧 CJK code page 与深嵌套拒绝；
- 超限原始输入与 UTF-8 解码膨胀后超限输出拒绝；
- 使用库 FontTable/Tokenizer 检查旧字体 charset 下的原始高字节，拒绝将 CJK 字节误读成全局 CP1252；同字体下 Unicode escape 仍正确通过。

`linux.rs` 接入由 native_finish 实施；已只读核对 plain/HTML 均不可用时依次请求 `text/rtf`、`application/rtf`，每次异步回调重新检查身份/revision/选区/组字/可见/焦点，转换失败展示 GTK 错误对话框且不提交编辑。上述为模块运行和接入源码检查，尚不等同于真实系统 RTF 剪贴板粘贴验收；其结果须由 probe 记录。


## PID 77146 隔离 probe 崩溃诊断

按 `diagnose-crash` 技能只读调查。崩溃时间 2026-11-10 03:41:25 CST（coredump 列表收集记录 03:41:35），命令为 `tauri-plugin-native-editor/target/debug/examples/native-probe`，信号 SIGABRT，主线程主动进入 Rust abort。同可执行文件的 coredump 列表本次只有该条；03:40–03:42 内核日志无 OOM/kill 记录，不能用当前 free 值倒推历史内存，但现有堆栈明确是 panic，而非 OOM kill。

证据：`tasks/omarchy-build/sumi-probe-run4/process.log`、`coredump-info.txt`、`kernel-window.log`。未导出 core 内存副本，未修改系统/通知配置。

实际堆栈链路：

1. `libc abort` → `std::panicking::panic_with_hook`；
2. `core::panicking::panic_cannot_unwind`；
3. `gtk::WidgetExt::connect_button_press_event::button_press_event_trampoline<webkit2gtk::WebView, tauri_runtime_wry::undecorated_resizing::gtk::attach_resize_handler::closure>`；
4. GTK `g_signal_emit` / `gtk_main_do_event` / 主循环。

进程日志定位到 `tauri-runtime-wry-2.11.1/src/undecorated_resizing.rs:546:57`：`window.downcast().unwrap()` 实际收到 `GtkOverlay`，而不是预期 `GtkWindow`。该 Tauri 左键处理器先取 `webview.parent().parent()` 并强制下转型，之后才检查 decorations/resizable。原生桥把 GtkOverlay 包在宿主根 child 外，改变了 WebView 祖父，因此点击 WebKit 区域时触发 panic，跨 GTK C trampoline 无法 unwind，最终 SIGABRT。

结论：这是已确认的原生桥与 Tauri 控件层级假设不兼容，属于本次集成必须修复的问题；不是测试主动结束，也不能用其他 probe 步骤成功抵消。仅关闭 decorations 不足以修复，因为 unwrap 早于条件判断。已通知实现代理修正控件结构并要求以实际 WebKit 左键点击验收，而非仅 JS invoke。其他线程主要等待 GLib、WebKit、Tokio 或 GPU 工作队列，未发现指向同步/文档事务崩溃的栈。

该进程为隔离测试 probe，最后正文 snapshot 写于 03:41:24.818；不能据此保证此后到崩溃前尚未 snapshot 的输入已保存，不把 fixture 存在当成生产写作恢复验证。正式 Vault 未参与本 probe。

修复源码独立复核：`vendor/tauri-runtime-wry` 对缓存中的发布版 2.11.1 逐文件字节比较，除新增补丁说明外，唯一修改文件为 `src/undecorated_resizing.rs`；其 diff 只有鼠标左键及触摸两处处理器从固定 `parent().parent()` 强转改为 `toplevel().and_then(downcast.ok())`。装饰、resize、坐标及传播分支未变，两个 Cargo manifest 指向同一份补丁。缓存 crate 原始 archive 的 SHA-256 与 `NOTEMD_PATCH.md` 一致。省略的只有 `.cargo-ok`、`.cargo_vcs_info.json`、上游 Cargo.lock 与 Cargo.toml.orig，许可与生产源码均保留。此结论为源码正确性审查；真实点击、触摸与菜单重测结果由 probe/主验收记录汇总，不在此提前标为通过。

## 光标几何修复与剩余边界

基线 spec 第 85 行要求光标高度使用当前整体字体 ascender/descender，排除行距；macOS `typewriterCaretRect` 以 baseFont 取得固定高度，再用 TextKit 返回的真实基线定位。旧 Linux 实现直接按 GTK `cursor_locations(None)` 高度绘制，真实 GTK 测量 A/中/空行为 33，emoji 为 27，而整体字体 ascent 26 + descent 7 固定为 33，确认了 emoji fallback 改变光标高度的问题。

官方 [GTK TextLayout 源码](https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gtk/gtktextlayout.c) 从私有行布局调用 Pango cursor API；[Pango 源码及 API 注释](https://raw.githubusercontent.com/GNOME/pango/main/pango/pango-layout.c) 明确返回 run extents。修复没有调用私有 GtkTextLayout ABI：保留 GTK 实际插入点，以公开 Pango itemize/shape 得到相应字形 run 的 logical ascent，再从原生矩形恢复基线，绘制整体字体固定高度。使用 glyph extents 避免彩色 bitmap emoji 的 FontMetrics 缩放差异。普通文本取当前合法字形簇，行末取前一簇，保留变体选择符及 ZWJ；粗体/斜体属性参与 itemize。

只读复核确认缓存键包含 Pango context serial、font-map serial、字体描述、语言、字形簇或预编辑全文及粗体/斜体；字号、字体加载或样式变化会重新测量，不每帧重做 shaping。独立小型 DrawingArea 只重绘光标像素，焦点遮罩只在渐变或空间变化时更新；隐藏、失焦、单 surface detach 和 window detach 均隐藏或移除光标，回调保持弱引用。实际 CPU 改善仍待最终 probe 重测，不以源码推断性能达标。

已查验实现代理的 `tasks/omarchy-build/sumi-native-caret-offscreen.log`：`native_caret_geometry_offscreen` 1 项通过。测试使用真实 GtkOffscreenWindow，覆盖 Latin、CJK、emoji、混合文字、ZWJ、组合重音、阿拉伯文及空行，逐字符位置，普通/粗体/粗斜体，以及行距 1/3，断言整体字体高度与独立公开 Pango layout 基线一致。此次复核未重新运行该测试；它不代表物理输入法候选窗或全部字体已验收。

明确保留的限制：GTK 的 preedit-changed 不暴露预编辑内部光标偏移，故预编辑按原生 run 高度匹配全文 itemize 结果。若候选 run 等高但 ascent 不同，或没有可匹配的 run，代码保留 GTK 原生矩形而不猜测基线；该少见情况下光标高度可能仍随 fallback 字体变化，不能声称所有 IME 组合均与 macOS 固定高度完全一致。此分支只影响呈现，不改正文、组字提交或系统候选定位。

冻结源码核对：本次逐文件计算的 SHA-256 均匹配 `tasks/omarchy-build/sumi-native-source-sha256.json`，无不一致项；外部候选面板实验不属于本次冻结源码或验收范围。当时报告更新未提交；当前提交与最终源码对应关系见主验收报告。

## PID 102925 宿主引用计数崩溃

按已读 diagnose-crash 技能再次只读核对 `coredumpctl info 102925`、`tasks/omarchy-build/sumi-host-gui/process.log` 与 `core-info.log`。该隔离 debug 宿主于 2026-11-10 04:13:11 CST 在主线程 SIGABRT；这不是旧 GtkOverlay 强转，也不是测试主动 abort。日志明确报告 `alloc::rc` 的非零强引用计数前置条件失败。旧可执行文件已被后续构建替换，因此不拿当前二进制地址反解旧 core，也未导出 core 内存。

原始 core-info 帧 11–20 链路：`RcInner<RefCell<HashSet<tao::WindowId>>>::inc_strong` → `Rc::clone` → Linux `EventLoopWindowTarget::clone` → `DispatcherMainThreadContext::clone` → `Context::clone` → `WryWebviewDispatcher::clone` → `DetachedWebview::clone` → `Webview::clone` → `Webview::on_message`。后续帧是 Tauri IPC scheme、WebKit callback、GTK main loop。其他线程多处于 Tokio/GLib/GPU 等待，没有相应文档事务错误栈。

源码确认一个与堆栈吻合的线程安全缺口：原 runtime `Context` 按值持有 `DispatcherMainThreadContext` 且派生 Clone；后者 unsafe 实现 Send/Sync，但其中 Tao Linux window target 含非原子的 `Rc<RefCell<HashSet<WindowId>>>`。合法跨线程 AppHandle/Webview clone/drop 也会触及这个 Rc；`run_threaded` 的主线程检查保护 GTK 使用，不能保护派生 clone/drop。已核对 native GTK mount/command 使用 `with_webview`/`on_main` 调度，没有发现本插件另造 unsafe Send 跨线程搬运 GTK surface。引用计数竞争是与源码和崩溃一致的根因判断；单份 core 不显示此前每一次计数竞争的时序。

已建议将 `Context.main_thread` 改为 `Arc<DispatcherMainThreadContext>`，唯一构造位置使用 Arc，令后台 Context 克隆只更新原子引用计数；GTK 访问继续原有主线程守卫。运行中的 runtime 保有 owner，因此 worker drop 不析构内部 GTK/Rc。`run_return` 之后外部 handle 最后在后台释放的终止阶段边界仍需区分，不能将最小修复说成全面重做了运行时析构协议。要求真实主线程 IPC 与多 worker 同时 clone/drop、worker join 后退出的回归及新版宿主交互证据；此处尚不声称修复运行通过。

04:12–04:14 内核记录无 OOM kill；04:13:34 的隔离 portal Wayland segfault 晚于宿主崩溃，不当作宿主 Rc panic 的原因。列表另有旧宿主 PID 93280（04:08:04、`--gui --cli-background`）在后台 malloc/realloc abort，模块标记 deleted 且部分栈无法可靠解释；保留为独立旧失败，不凭相近时间强行归同因。生产 Vault 未参与该隔离验收，测试文件完整性仍须按宿主持久日志/实际文件核对。

## 宿主窗口恢复与 Wayland 光标 surface 复审

Linux Tao 的 show() 会把 GTK 请求再次排入默认优先级 GLib channel；立即查询 is_visible 可能仍得到 false，导致宿主永久漏发恢复通知。宿主改为在 GTK idle 确认可见性，show ticket 与后续 close 共用 epoch，防止旧显示回调覆盖后来关闭。互斥锁只用于状态读写，不跨 await 或 GTK 同步查询；非 Linux 保留同步确认。独立源码复审未发现阻塞项。固定 Sumi 窗口在创建前按可用逻辑区域及 GTK 标题栏尺寸限制，避免 resizable=false 时后续 resize 被忽略。真实验收另外证实 Tao 的 outer/inner 查询差值为零，不能代表 GTK 标题栏；实现改为在 GTK 主线程读取标题栏的 allocation/preferred height。

Wayland 呼吸光标使用公开 GDK_WINDOW_SUBSURFACE 实现独立小 surface；继承 GtkDrawingArea 的 size_allocate 与 GtkWidget 的 unregister/destroy 路径。真实 Wayland 使用 native surface，非 Wayland 及 GtkOffscreenWindow 走原 DrawingArea；空 input region 和 pass-through 避免抢输入。Cairo Source 只作用于独立 subsurface，更新上一帧 alpha；共享 backing 保留普通 alpha 叠加。已对照 GTK 本地源码复核 ownership、unrealize、坐标更新和父 surface 销毁信号，未发现阻塞项。最终动画帧、CPU 和窗口交互结论以主验收报告的实际证据为准。

## 编辑面释放锁范围复核

排查显示残影时另发现 `host.sumi.detach` 先完成 `detach()` 并释放生命周期锁，再无条件清 owner。并发 mount 可在两步之间创建新的原生面，随后被旧请求清除 owner。修复沿用 before_close 的既有模式，在同一生命周期锁内调用 detach_locked 并释放 owner；Tab 的 detach 保留 source owner 语义不变。此项是源码确认的并发缺口，并非已证明当前正文残影由重复挂载导致；正常阅读导航不调用 mount，最终显示回归需另外给出证据。

## 阅读布局残影与系统次光标

最终包移动光标验收发现视觉重复正文，但文件仍仅一份。隔离的单 Surface / 单 TextView（包括纯 GTK 与 WebKit 底层）均可复现，排除了宿主重复挂载作为该实例的原因。只重画 Overlay 无效；重画 TextView 后旧像素消失。修复在 appearance 修改边距和行间距后调用一次 view.queue_draw，不在呼吸定时器重画正文。真实 compositor 截图在修复前与强制新鲜重画结果不同，修复后逐像素一致。

另以测试中临时关闭系统 cursor 的正对照检测到白线：仅设置 primary caret-color 不足，text 子节点仍可绘制系统次光标。生产代码将 textview 及 text 节点的 caret-color / -gtk-secondary-caret-color 均设为透明，保留 cursor_visible=true；不能关闭该属性，因为 GTK move_cursor 会因此把方向键切换为滚动。最终像素对照无差异，真实 move-cursor 信号仍使选区左移。红/绿日志及截图见主验收证据。

### 最终 Tab 窄宽分配

真实 GTK 红测试证明 size_request 仅设最小值，800 缩到 400 后实际分配仍为 792，长行裁剪。get-child-position 精确限制本 surface 的 scroll/decoration，保留其他 overlay child 默认处理；矩形包括 GTK 随后扣除的 margin。Weak 捕获无引用环，两条 detach 路径均先断开 handler。绿测试实际 400、30 个视觉行且逐字形不越界；生产最小宽高保持 1，避免零窗口尺寸。独立复审通过。

### 完整宿主 CSD 阴影参与坐标换算

仅精确 GTK allocation 不足以消除 Tab 裁剪：实际 window.innerSize 为 4048×2608，scale 4，而 WebView.size 为 3840×2104，DOM/WebKit 为 960×526。GTK 窗口缓存含 52px 阴影，将正确 DOM 宽误放大为 1012。改用 Tauri 官方 WebView.size：Tab 获取实际 WebView 物理尺寸，Linux plugin_bounds 同样读取 WebView bounds；不硬编码阴影宽度，不改变系统窗口配置。组件测试使用实测窗口/内容尺寸差验证传给原生的宽仍为960。
