# Sumi macOS 输入法改造可行性调研

日期：2026-11-10。状态：官方接口和源码调研完成；未实现、未安装、未做真实输入法验收。

依据：[跨平台规范](../specs/sumi-ime-cross-platform.md)、[Linux 候选方案](../specs/2026-11-10-sumi-fcitx-candidates.md)及[非聚焦最终要求](../specs/2026-11-10-sumi-stationary-nonfocus-input.md)。本仓库调查基线为 `82d8c2662f2f01f48a98c79aa71cf9e2286672ad`。

## 结论

macOS 有对应输入法，也有实现这套体验的源码基础。优先验证 **Fcitx5 macOS + Sumi 原生候选展示层**：可延续 Linux 的职责划分，但需要移植输入上下文接管和通信层。不能把现有 Linux addon 或 D-Bus 桥直接当作 macOS 可用实现。

| 路线 | 判断 | 缺少的关键部分 |
| --- | --- | --- |
| Fcitx5 macOS | 最接近 Linux 方案，建议先做原型 | 精确正文上下文握手、候选通信、局部隐藏默认窗、断连回退、AppKit 展示 |
| 鼠须管 Squirrel / Rime | 可改源码，适合已有 Rime 词库和方案的用户 | Squirrel 控制器与 Sumi 的桥接；仅配置主题或 app_options 不够 |
| 苹果自带拼音 | 公开接口不足以满足完整 spec | 普通编辑器没有通用候选导出、选择/翻页、接管系统候选窗接口 |

这些是源码级可行性判断，不能视作整套 spec 已经满足。最需要先验证的是：同一应用中从正文切到搜索框时，能否可靠撤销接管，并让原输入法候选立即正常工作。

## Fcitx5 macOS 的依据与缺口

[官方项目](https://github.com/fcitx/fcitx5-macos)移植了 Fcitx5 引擎，并通过 macOS 原生输入法前端接入系统。它是 Linux Fcitx5 路线的直接对应对象。[官方主题文档](https://fcitx-contrib.github.io/docs/theme/)说明候选窗采用原生 WebView，支持 CSS/JavaScript 定制。

主题定制可以修改字体、颜色和装饰，但本规范还要求正文实际排版度量、精确输入框隔离、聚焦留白、非聚焦正文不动，以及点击后由原引擎选词。因此主题只能作为局部能力证据，不能代替应用与输入法配合。

源码检查确认：

- `webpanel` 已取得真实候选列表、当前候选和分页状态，选择交回 Fcitx 引擎；可在这层增加只对获授权正文上下文生效的候选分流。
- macOS 构建关闭 `ENABLE_DBUS`。保留 Linux 的消息语义有价值，传输与上下文绑定须重新实现。
- 既有远程控制能力不等于候选 API；当前候选点击路径使用最近的输入上下文，不能直接用于异步跨进程选择。必须绑定精确上下文、候选版本与正文生命周期。
- 需要在 Sumi 确认展示桥可用后才抑制默认候选窗；桥断开时恢复原窗。单纯将原窗透明或隐藏不满足回退要求。
- 关闭某个框架 emoji 模块不能证明拼音、Rime 或快捷短语均无 emoji；必须按实际引擎核查自动推荐开关的作用范围。不要仅在展示层删项，造成数字选词索引错位。

固定审查版本：`fcitx/fcitx5-macos@6322853b17aca03ce1f1b694208cc5201944ca69`。关键证据：

- [CMake 构建选项](https://github.com/fcitx/fcitx5-macos/blob/6322853b17aca03ce1f1b694208cc5201944ca69/CMakeLists.txt)：该源码标注项目版本 0.4.3，部署目标 macOS 13.3；不把它等同于本机已安装版本。
- [controller.swift](https://github.com/fcitx/fcitx5-macos/blob/6322853b17aca03ce1f1b694208cc5201944ca69/src/controller.swift)：为输入客户端建立 UUID，上下文激活/失活有对应处理。
- [webpanel.cpp](https://github.com/fcitx/fcitx5-macos/blob/6322853b17aca03ce1f1b694208cc5201944ca69/webpanel/webpanel.cpp)：候选读取、选择/翻页与默认窗显隐入口。
- [remote.cpp](https://github.com/fcitx/fcitx5-macos/blob/6322853b17aca03ce1f1b694208cc5201944ca69/src/remote.cpp)：现有命令仅包含状态、启停、切换及当前输入法等，不含正文接管协议。
- [fcitx5-beast 服务](https://github.com/fcitx-contrib/fcitx5-beast/blob/66ef1cec0984030fbcfd20c28de1fbe94399fee4/src/beast.cpp)：已有 HTTP/Unix socket 通信基础，可评估扩展，不能称为已具备候选订阅。
- [macosfrontend.swift](https://github.com/fcitx/fcitx5-macos/blob/6322853b17aca03ce1f1b694208cc5201944ca69/macosfrontend/macosfrontend.swift)：原生提交及预编辑路径已有细下划线处理，也存在兼容用占位预编辑，必须验收实际正文行为。

## 鼠须管的依据与缺口

检查版本：`rime/squirrel@b7970a93b05ae1ca1bcd97888fd6aa3cd0458d3e`；已比对所读控制器源码与此固定提交一致。

[SquirrelInputController.swift](https://github.com/rime/squirrel/blob/b7970a93b05ae1ca1bcd97888fd6aa3cd0458d3e/sources/SquirrelInputController.swift) 包含完整候选路径：

- `rimeAPI.get_context` 读取候选、标签、当前项、页码和末页状态。
- `select_candidate_on_current_page` 选词，`change_page` 翻页。
- `showPanel` 将候选交给自身面板；`hidePalettes` 隐藏面板。
- `setMarkedText` 和 `insertText` 向原客户端更新组字与提交。

所以可以修改候选的展示出口，同时保留 Rime 引擎和原生提交链路。现有 `app_options` 按 bundle ID 选择配置，无法区分 Sumi 正文与同应用搜索框；须补正文会话握手。

还需特别验证失焦行为：当前 `deactivateServer` 调用 `commitComposition`，后者可提交尚未转换的原始输入。候选点击不能导致正文失焦，也不能通过重置输入上下文来掩盖保存错误，否则可能违反 spec 的“不追加原始拼音”。

## Apple 公共接口的边界

`NSTextInputClient` 提供预编辑、提交、选区和字符范围位置等能力。`firstRectForCharacterRange` 提供输入位置矩形，不是候选窗布局协议，不能控制候选宽度、行数、内容或选词。

`InputMethodKit` 的候选管理面向输入法实现者。创建自己的 `IMKCandidates` 并不能获得苹果拼音正在使用的候选对象。没有在已核查的公共接口中找到普通编辑器完整接管任意系统输入法候选的方法。

`NSTextView.markedTextAttributes` 可调整预编辑的文字颜色、背景色和下划线；字体/行高不能仅靠该属性保证。还需处理输入法传入的 attributed string 和 marked range 内的选择展示，限定于组字范围，保留普通正文选择反馈。此项有局部实现基础，但必须实机验证。

Touch Bar 的 `allowsTextInputContextCandidates` 也不是候选导出接口：其 `candidates` getter 返回客户端自行设置的列表，不返回由文本输入上下文提供的候选。

一手依据：[NSTextInputClient](https://developer.apple.com/documentation/appkit/nstextinputclient)、[NSTextInputContext](https://developer.apple.com/documentation/appkit/nstextinputcontext)、[IMKCandidates](https://developer.apple.com/documentation/inputmethodkit/imkcandidates)、[IMKInputController](https://developer.apple.com/documentation/inputmethodkit/imkinputcontroller)、[markedTextAttributes](https://developer.apple.com/documentation/appkit/nstextview/markedtextattributes)、[Touch Bar 候选设置契约](https://developer.apple.com/documentation/appkit/nscandidatelisttouchbaritem/setcandidates(_:forselectedrange:in:))；同时核查本机 SDK 的 AppKit 输入客户端头文件与 HIToolbox `IMKInputSession.h`。

## 建议的最小实现验证

保持输入法负责组字、候选和提交，Sumi 只负责展示。候选数据通过新增的本机通信桥送入 AppKit 展示层；不另启一套拼音状态，也不模拟键盘提交候选文本。

1. **先验证接管闭环。** 原生测试窗口包含正文和普通搜索框。用真实 Fcitx5 拼音输入 `nihao`，读取真实候选并点击选词；只提交一次“你好”。切到搜索框恢复默认窗，切回正文重新握手。正文 token、输入法上下文身份、文档代次和候选序号须共同拒绝过期选择。
2. **先验证失败回退再精修外观。** 主动断开桥和重启输入法，清除旧候选并恢复原生选词能力；不通过强制提交或取消组字实现 UI 切换。
3. **实现 AppKit 布局。** 聚焦时在当前视觉行下一行向下展开，以展示留白防重叠；非聚焦时只在正文视区底部向上覆盖，正文选区、滚动和视区保持不变。最多四行，使用正文实际字体度量，完整候选仍可翻页到达。
4. **验证剩余约束。** 预编辑无蓝底、普通选区正常、emoji 设置局限于目标会话或明确其实际范围；多屏/Retina/全屏、长文、小数字号、候选点击不失焦、撤销、保存失败和重开内容逐项验证。

通信可评估扩展既有本机服务或采用 macOS 原生 IPC；调研阶段不冻结具体传输。绑定精确客户端是原型门槛，不能假定一个 InputMethodKit 会话天然等于一个 Sumi 正文 view。

当前 macOS 原生实现位于 `tauri-plugin-native-editor/native/editor.m`，已有 `setMarkedText` 和 `firstRectForCharacterRange` 路径；`build.rs` 将其编译链接进宿主。真正交付此改造预计需要配套输入法包与宿主更新，不能只发 Sumi Web 插件 ZIP。

## 验证记录

本轮核对了仓库实际代码、官方文档及上游源码。没有改变输入源、安装输入法、修改业务实现或运行真实输入验收。未声称支持任意第三方输入法，也未声称字体、emoji 局部设置、上下文隔离及断连恢复已通过原型验证。
