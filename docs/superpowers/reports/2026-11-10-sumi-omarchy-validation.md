# Sumi Omarchy 实现验收

日期：2026-11-10。源码基线 `183b636b05bcf1440e2b8626f28629ce44b78863`，原生基础桥已精确提交为 `40adb1f1`；宿主接线与后续修复见包含本报告的实现提交。依据 [适配规格](../specs/2026-11-10-sumi-omarchy-native.md)；独立发现与修复过程见 [审查报告](2026-11-10-sumi-omarchy-review.md)。

## 范围

Linux x86_64 的 GTK3 原生编辑桥，共享既有 Markdown/CRDT/撤销与持久日志，独立窗口和专用 Tab 使用同一原生协议。新增 Secret Service 凭据、PulseAudio/PipeWire 音效、进程内字体注册、剪贴板与原生菜单/对话框、HiDPI 坐标换算、Linux 插件打包及 Arch/Deb 依赖。macOS 原生实现保持不变；共享 Tab 尺寸来源改为 WebView 内容区，在 macOS 与原窗口 helper 的视区语义一致。

GTK 覆盖层引发的 Tauri WebKit 鼠标事件崩溃已定位到固定祖父层级强转；仓库冻结 `tauri-runtime-wry 2.11.1` 并修复两个 Linux 事件回调及 Linux 句柄复制的上下文所有权，来源与许可证见 `vendor/tauri-runtime-wry/NOTEMD_PATCH.md`。实际按钮点击验证已通过，不能只用 JS invoke 代替该回归。

## 自动化与实机检查

| 检查 | 结果 | 本地日志（tasks/omarchy-build/） |
|---|---|---|
| 共享 Sumi 前端 | 4 文件、27 项通过；包含 WebView 阴影尺寸回归 | sumi-frontend-tests-webview.log |
| Sumi 插件前端 | 2 文件、101 项通过，类型检查和构建通过 | sumi-plugin-final-tests.log |
| write-core | 85 项通过 | sumi-core-tests.log |
| 宿主 Sumi | 84 项通过，4 项隔离环境测试未在该批次运行 | sumi-host-tests-owner-release.log |
| Linux 原生单元测试 | 17 项通过，3 项显示环境测试单独执行 | sumi-native-wrap-unit-final.log |
| 固定高度/基线离屏测试 | 1 项通过，9 类文本 × 3 类样式 × 2 行距 × 逐字符位置，含普通 Child 回退 | sumi-native-wrap-glyph.log |
| 实际 GTK/Wayland 事务 | 1×/4× 各通过，含移动坐标、子 surface、隐藏/恢复、销毁等多项断言 | sumi-native-wrap-wayland-4x.log、sumi-native-wrap-wayland-1x.log |
| 真实 compositor 像素回归 | 阅读导航无旧文字残影、无系统额外光标、实际方向键移动与窄宽逐字形检查均通过 | sumi-native-wrap-fixed.log |
| Linux 音效 | 9 项通过；真实 Pulse 无声流另 1 项通过 | sumi-sound-final.log、sumi-pulse-silent-final.log |
| Secret Service | 2 项错误/身份测试及私有 keyring 读写删除 1 项通过 | sumi-credentials-final.log |
| 发布/开发安装脚本 | 75 项相关测试通过，8 项其他流程未选中；shell 语法通过 | sumi-packaging-tests-final.log |
| ELF 校验器 | 1 项通过 | sumi-elf-validator-final.log |

原生显示测试覆盖：UTF-16/Unicode 事务、选区替换、严格 revision 回执与拒绝回滚、保存失败草稿冻结和重试动作、IME 预编辑清空后提交/idle 屏障、远端投影与选区、查找失败不替换旧选区、真实剪切 Markdown 剪贴板回读、text/rtf 和 application/rtf 异步粘贴回调、字体与布局更新、60 行导航居中及指针期间冻结几何。独立 Fcitx/GTK 回归另外验证了真实拼音提交：普通投影、Markdown 删除前缀并加粗、强制改变选区和失败草稿均保留严格的“你好”正文，未追加原始拼音；候选区任务提供的日志与修复补丁哈希见基础桥证据目录。该回归不等于最终宿主的物理键盘候选窗验收。

真实 Tauri probe run13 在 Hyprland 原生 Wayland 上通过：窗口显示/隐藏/恢复，WebKit 面板输入全选，中文与 emoji 虚拟键盘输入精确相等，GTK 保存菜单消费正确，Remote edit、Snapshot、Overlay（两次）、Focus、Quit 按钮真实鼠标点击均正常。Quit 实际关闭窗口。分辨率 3840×2400、compositor scale=4；WebKit CSS 与 GTK 逻辑像素不同，顶部按钮未被原生编辑区遮住。触摸只验证隔离的 Tauri 合成回调，未验证物理触屏。

最终显示回归使用独立 Sway headless/pixman Wayland 会话，配置、包与 runtime 均置于任务目录，不连接真实锁屏、DRM 或 libinput。保留一个不发送按键的虚拟键盘，防止短命输入工具退出后整个 seat 失去 keyboard capability、GTK 随之失焦。该条件建立后最终 GTK 事务/RTF/剪切/居中测试通过；此前无键盘焦点的失败不计作通过。

光标几何改为通过公开 Pango itemize/shape 的 glyph logical extents 还原真实基线，使用整体字体固定高度；小尺寸 DrawingArea 承担光标绘制。Wayland 独立 surface 的最终动画验收另见下文。字体、样式、字形簇和字体缓存序号变更均使度量缓存失效。无法唯一匹配的罕见预编辑保留 GTK 原生矩形，可能仍有高度变化，避免猜测基线破坏输入位置。

最终导航与光标回归为私有 Sway 的 run32 和真实 Hyprland 的 run33，均通过完整 probe 与截图复核。run33 使用实际 GTK 3×，六帧的五个差异均只覆盖 6×99 物理像素光标区；run32 为 4×、8×132。两者 5 秒进程 CPU 均约单核 2.60%，稳定两秒光标绘制 60 次、WebKit 0 次。实际虚拟键盘输入、导航、按钮、菜单、显示/隐藏与退出通过；导航后正文/revision 不变，旧位置无残影。见 [物理桌面结果](2026-11-10-sumi-omarchy-validation/physical-probe.json) 及 [导航记录](2026-11-10-sumi-omarchy-validation/physical-navigation.json)。这些完整 probe 早于最后一次窄宽分配修复；最终源码另跑下面的 GTK 矩阵与包内 Tab 复验。

导航测试曾遇到 wtype 每次启动发送不同稀疏 keymap，GTK 缓存硬件快捷键后导致方向键/Backspace 不生效；普通 GtkTextView 同样复现。固定完整 evdev keymap helper 后真实导航通过，未为测试工具修改产品按键行为。证据包含普通 GTK 红绿日志与 helper 构建结果。
并行的 Fcitx 内嵌候选区属于独立任务，在 `sumi-fcitx-candidates` 分支继续集成；其模块、规格和 addon 未纳入本次构建/提交。本报告描述不含候选的基础预览；后续正式发布将基于本次已验证提交整合候选，并另外记录验收与发布证据。

## 性能验收中的反例

run24 的低 CPU 单值不是最终通过证据：run25 的真实 Hyprland 连续六帧检查发现光标没有变化，尽管 draw 回调约 30 次/秒。协议检查确认 GDK 父窗口层级导致独立 buffer 未提交。该失败与旧共享 backing 的高 CPU 都必须保留，最终结果须同时证明可见动画、正确位置与 CPU，不能通过隐藏/冻结光标降低开销。

修复将 GDK 子表面挂在逻辑 root 下，通过 transient_for 关联真实 Wayland 父 surface，并以 GTK allocation 和父窗口相对原点同步位置，使公开 begin/end frame 路径提交独立缓冲区。修复后的 run29 在 Sway/Pixman 4× 通过全部实际点击、Unicode 输入、菜单、隐藏/恢复和退出步骤；连续六帧的五次差异均精确为 8×132 物理像素（2×33 GTK 逻辑像素），只覆盖一个光标。稳定采样两秒光标绘制 60 次、WebKit/正文 0 次；5 秒进程 CPU 为单核 2.60%，同类环境旧版约 59.6–67.8%。包含每秒一次 probe snapshot IPC，不代表所有机器或正式 release 优化构建的性能。证据见 [最终 probe](2026-11-10-sumi-omarchy-validation/final-probe.json)、[绘制计数](2026-11-10-sumi-omarchy-validation/final-draws.json) 和 [连续帧差异](2026-11-10-sumi-omarchy-validation/final-caret-phase-differences.json)（链接为后续 run32 的完整导航复验）。

## 最终宿主与产物

最终宿主包 `0a2dc482…` 已通过包内二进制验收（[结果](2026-11-10-sumi-omarchy-validation/host-final-result.json)）：保存、隐藏后重开续写、Appearance 遮挡/恢复、单一 owner 交接及导航删除后精确保存。16 轮真实异步 detach A / mount B 竞态全部保留新 owner，正文哈希不变；临时 UI 13 文件已逐项恢复。见 [竞态结果](2026-11-10-sumi-omarchy-validation/owner-race-result.json)。

Tab 缩窄裁剪另由真实 GTK 回归复现：bounds 从 800 改为 400 后控件仍分配 792，原因是 GTK size_request 只有最小尺寸语义。Overlay get-child-position 现只为该 surface 的正文/遮罩精确分配宿主边界，销毁时解除回调；400 宽度实测精确为 400，长行从错误 14 行变为 30 行，逐字形检查未越界。该增量已独立复审。完整宿主又确认窗口 innerSize 含 52px CSD 阴影：window 4048/4=1012，WebView 与 DOM 实际宽 960。Tab 与 Linux 插件现在统一以 WebView.size 换算，避免把阴影计入正文边界；模拟真实 4048/3840 尺寸差的组件回归通过。最终包 `0a2dc482…` 的 Tab 长行已完整折行，实际 Ctrl+A/C 复制的 UTF-8 Markdown 与隔离投影正文逐字一致。4× 事务中原 100ms 固定等待在链接高负载下曾失败，测试改为至多 2 秒等待实际 allocation 后通过；保留失败日志。后续完整宿主构建已包含该测试修正；最终源码映射见 build-source-verification.json。

本地交付产物：

- 宿主 `tasks/omarchy-build/sumi-arch-package/notemd-sumi-preview-6.1110.1.dev20261110-1-x86_64.pkg.tar.zst`，SHA256 `0a2dc482493b2776889798a9c609bd64d817741fcc47f6b1e7094eab696deced`；包内 binary SHA256 `fb0b789b88797aeadd1707a3eb9014baff2a10e3e322584bee0d58a63cf6760c`。ELF、ldd -r、依赖、desktop、许可证和隔离 CLI 版本全部通过，见 [包元数据](2026-11-10-sumi-omarchy-validation/arch-package.json)。
- 插件 `tasks/omarchy-build/sumi-plugin-acceptance/sumi-0.1.10-linux-x86_64-debug-unsigned.zip`，SHA256 `b720a9819f975df68e79f089a82590bcaf318865c01b353a9ebcd5645307fd59`；29 个文件，包含 x86_64 Linux 后台服务和 UI。仅未签名开发包，未发布到市场。
- [构建命令](2026-11-10-sumi-omarchy-validation/build-commands.txt)、源码哈希、测试日志（归档仅去除行尾空白，原始哈希见 log-provenance.json）、固定键盘/指针 helper 和真实竞态复现脚本均随提交保存；[worktree 范围核对](2026-11-10-sumi-omarchy-validation/worktree-scope.json) 明确候选分支与旧构建工作树均未混入。

此前发现问题的包保留为本地 superseded 证据，不作为交付产物。最终预览属于 debug 源码构建、Arch 包剥除符号，不代表官方 release 优化构建或 Debian 12 兼容基线。

## 边界

- 本报告冻结时为本地实现与开发预览验收，未发布插件市场、R2/KV、GitHub Release 或正式版本 tag；不将现有 macOS 的 v6.1110.1 发布结论套用到 Linux。所有测试使用隔离目录与 Vault，未安装本轮预览包或修改正式写作数据。
- 已验证 x86_64 Linux；未生成或宣称 aarch64 Linux Sumi 后台包。
- 物理 Fcitx5 候选窗、分数缩放、触屏、多显示器切换和超大文档性能未在本机完整验收。远端投影及同步内核测试不等同于跨设备生产联调。
- 不能无损提交 IME 预编辑时明确拒绝切换并保留输入；RTF 损坏、超限或不支持的旧编码明确拒绝，不静默写入乱码。此行为和可重试路径已记录于适配规格。
