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
