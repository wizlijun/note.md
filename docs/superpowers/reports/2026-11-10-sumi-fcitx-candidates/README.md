# Sumi 应用内候选区验收

实现范围：Linux Sumi 原生编辑面板。专注模式在输入行下一行左对齐展开，最多四行；非专注打字时正文输入行与候选一起固定底部，候选增加时正文上移。候选继承正文排版，不显示独立背景、边框或阴影。

## 已验证

- 原生库普通测试：26 通过；3 个需要显示环境的测试默认忽略。
- 非测试原生库构建通过；[光标离屏回归](caret.log) 与 [GTK 编辑事务回归](transactions.log) 各 1 项通过。
- 独立 Sway + 独立 D-Bus + 真实 Fcitx 拼音 + GTK 编辑面板端到端通过。使用虚拟键盘，不等同于物理桌面验收。
- `nihao` 候选点击提交严格为 `你好`；Markdown 富投影删除格式符及改变选区后仍只产生一次编辑；保存失败时草稿不混入原始拼音。
- 同程序其他输入框保留普通输入法候选；窄窗口回退、四行限制、分页、尺寸恢复、失焦清空与 Fcitx 重启重连通过。
- 展示候选不修改正文、选区或修订号。
- 1 倍与 4 倍缩放端到端均通过（[4 倍日志](test-scale4.log)）。

## 图像证据

[真实拼音候选](bottom-real-nihao.png)、[非专注四行](bottom-four-rows.png)、[专注四行](focus-four-rows.png)。四行图使用注入的展示样本验证排版，不声称拼音引擎生成了这些样本。

[端到端日志](test.log)。复现方式见 [运行说明](../../../../scripts/sumi/fcitx-candidates/README.md)。

## 依赖与交付边界

Fcitx fork：`https://github.com/wizlijun/fcitx5`，分支 `typewriter-candidate-theme`，本地提交 `47da99c7716d02309ee97bf454333268bf69522d`。独立 addon 协议回归及完整 Classic UI/addon 构建已通过。

宿主需要 Linux 原生基础桥 `40adb1f1a162348de9c8aefb86e992e64380da96` 及本次候选实现，Fcitx 需要加载 `sumicandidates` 模块。模块缺失或不支持安全接管时保留普通输入法候选。测试没有替换桌面输入法，也没有修改正式 Vault；尚未安装、发布，不代表当前已安装 note.md 已具备此功能。

## 组字串去除蓝底

用户补充要求由 Fcitx 提交 `d2c1442957f695b3a3bbd9c2aaec0f753c50a591` 实现。只在 Sumi 当前注册的精确输入上下文中把展示格式 `HighLight` 转为 `Underline`，保留原文字、光标和提交语义。当前候选继续使用细下划线。

新增真实拼音协议回归确认：原来的 `ni hao` 标记为 24（高亮＋下划线），修复后仅下划线；同程序其他输入框仍带原高亮标记。[实际 GTK 截图](preedit-underline.png) 与 [完整输入回归日志](preedit-test.log) 已通过。新模块仍需随最终宿主安装，不能用此前含蓝底的旧 addon 包替代。

完整 Sumi 窗口快照也已通过：[组字无蓝底](host-preedit-underline.png)、[普通正文选区仍可见](host-document-selection.png)。真实鼠标选词后正文精确保存为四次“你好”。该宿主是候选提交 `4dd7c501` 配合未提交宿主接线的隔离验收快照，尚不能作为最终交付包；使用的新 addon 则来自冻结提交与实际 Arch 包。详见 [模块包与宿主样式证据](preedit-package.json) 和 [包内模块协议回归](preedit-protocol.log)。

## 与最终 Linux 宿主整合

候选分支已合入宿主 `576a0edb` 的独立光标、精确宽度分配、布局重绘、同锁 detach/owner 修复。冲突解决保持装饰层全高，正文分配高度扣除底部候选；独立光标使用同一 `editor_height()` 边界，避免读屏滚动时覆盖候选。

新增回归先在旧边界上失败（[红灯](integration/caret-red.log)），修复后通过。合并后 [26 项普通测试](integration/ordinary.log)、真实 Fcitx [1 倍](integration/candidate-1x.log)/[4 倍](integration/candidate-4x.log)、[字形光标](integration/caret.log)、[编辑事务](integration/transactions.log)、[重绘及 800→400 换行](integration/damage.log) 均通过。候选测试同时断言正文 allocation 精确为 360 像素宽、扣除候选后的高度，及越过正文边界的光标隐藏。

初次高负载 4 倍运行曾在切换到同程序普通 Entry 时得到英文 `nihao `，保留[失败日志](integration/initial-parallel-4x-failed.log)。检查发现测试只等 GTK 焦点和固定时间，未等异步 Fcitx FocusIn；控制器仍可能激活旧 IC。测试现通过 Fcitx `DebugInfo` 等待新 dbus IC 获焦后仅激活一次，不重试输入、不修改产品输入法状态逻辑。随后两种缩放均通过；不将先前失败隐藏为成功。

从合并源码构建的 deb 内提取宿主程序，与 `d2c14429` 实际 Arch 包内模块在独立 Sway/D-Bus 中联合验收：[非专注底部](integration/host-bottom.png)、[专注下一行与无蓝底](integration/host-focus.png)。鼠标选词、Appearance 切换并 Apply、保存、关闭 Sumi、菜单重开、继续拼音输入及保存全部通过；正文由既有四次“你好”精确增加至七次，没有原始拼音或重复提交。[源码/包/模块哈希和步骤](integration/verification.json) 记录这轮证据。此轮是未安装的 6.1110.1 整合预览，最终版本、冻结 tag、签名及公网发布由发布任务另行执行；不把该包称为正式发布。无头环境未提供音频输出，本轮不复验打字音效。

[安装依赖及回退说明](INSTALL.md) 随候选模块交付。正式安装/发布均未由本验收执行。

整合提交 `c0465b16` 随后合入发布任务 `673a9230`（含 `150db985` 构建依赖补全），保留既有 Mac 6.1110.1 发布记录及 Linux 未发布分界。此次合并未改变上面验收的宿主/原生源码哈希；[26 项 Linux 发布编排/依赖测试](integration/release-dependencies.log) 通过。最终正式版本仍由发布任务统一冻结。
