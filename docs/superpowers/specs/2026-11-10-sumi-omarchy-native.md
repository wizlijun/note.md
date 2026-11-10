# Sumi Omarchy 实施与验收规格

基线：`2026-11-07-immersive-write-design.md` 及当前 macOS 实现，包括其末尾的聚焦、导航恢复与本机持久日志要求。本文件记录 Linux 适配方案，不表示已发布或验收通过。

## 集成方案评审

按基线 §4.1 重新评审 GTK3 路线。现有 Tauri 使用 GTK3/WebKitGTK；Qt 的 QQuickWidget 继承 QWidget，不能作为 GtkContainer 的子控件。Wayland 外部窗口不能作为 Tab 嵌入方案。引入离屏 Qt 渲染还需要重新实现输入法、无障碍和焦点桥，扩大本次适配范围。选择在现有宿主事件循环中使用 GTK3 TextView/Overlay，作为原生 surface，供独立专注窗口和专用 Tab 共用。此为明确的 Linux 方案变化；不改 macOS 后端，不创建独立替代产品。

参考：[QQuickWidget](https://doc.qt.io/qt-6/qquickwidget.html)、[GtkOverlay](https://docs.gtk.org/gtk3/class.Overlay.html)。上述判断是基于容器 API 的工程评审，不声称已实测所有 Qt 集成方式。

实际 Wayland 验收发现两项集成约束：

- Tauri runtime 2.11.1 的无装饰窗口鼠标/触摸处理假定 WebKit 的祖父必为 GtkWindow，加入覆盖层后会在点击时强转崩溃。冻结原运行时源码，最小补丁改为查找实际顶层窗口并安全检查类型；保留原 VBox/菜单结构，不修改系统或 Cargo registry 缓存。另一次完整宿主验收证实运行时句柄的按值 Clone 可跨线程克隆 Tao 的非原子 Rc，故 Linux 主线程上下文改以 Arc 共享，GTK 访问仍必须通过既有主线程检查；增加并发克隆与主线程 IPC 压力回归。
- 系统字体 DPI 可使 WebKit CSS 像素与 GTK 逻辑像素不同。独立插件在 mount/resize 提交 viewportWidth，由宿主按窗口实际逻辑宽度换算；专用 Tab 沿用原有换算，不重复缩放。覆盖层的位置同时跟随 WebKit 后续 allocation 更新，避免遮住菜单下方的按钮。

Linux 使用本机 IME 预编辑状态及提交事务屏障；无法无损提交组合时，面板/切页操作明确拒绝并保留组合，待用户完成或取消输入后重试，不把拼音字符串当成已提交汉字。RTF-only 粘贴使用固定的小型纯 Rust 解析器转纯文本；损坏、超限或无法可靠解码的旧编码明确拒绝，不静默写入乱码。

## 必须保持的契约

- 使用现有 SurfaceConfig / NativeEvent / SurfaceCommand，GTK 字符偏移与协议 UTF-16 偏移严格转换，禁止截断代理对。
- 编辑由共享文档内核决定 Markdown 投影、撤销、CRDT 与行时间；原生控件不得另存权威文档。
- 只有持久化成功的回执才能推进 revision；失败保留输入、阻止后续编辑并显示保存风险。
- IME 组合期间冻结远端应用与 owner 交接；面板、切页、关闭和隐藏不得默默丢弃预编辑。
- 使用进程内字体注册与既有按需下载；系统字体不被修改。
- 系统安全存储保存设备秘密，插件/Web/Vault 不接触凭据；Linux 音效只监听当前原生输入控件。
- 原生专注窗口与 Tab 共用会话与单一 owner；插件设置面板可用，布局/缩放不修改正文。

## 验收计划

1. 原生契约测试：Unicode、选区、样式、输入/删除/粘贴、撤销与重做、远端投影、旧 generation、保存失败、IME 屏障和销毁。
2. 隔离 GTK/Wayland 交互：显示/隐藏、焦点交接、滚动/菜单遮挡、全屏、字体/主题/留白；物理输入法与合成测试分别记载。
3. 服务与插件：凭据错误不误报未配对，音效释放，manifest 架构与实际 ELF 一致，前端测试/类型/构建通过。
4. 宿主 Linux 构建、Arch 包内容与动态依赖检查。仅实际生成的包记录哈希；发布沿用原渠道，不能把开发构建标为发布。

## 交付状态

基础实现与本地 x86_64 开发包验收完成；独立窗口、专用 Tab、保存重开、真实 Hyprland probe、GTK 1×/4× 及性能证据见 [验收报告](../reports/2026-11-10-sumi-omarchy-validation.md)。候选分支整合与正式发布后续单独记录；物理 Fcitx5 候选窗、分数缩放及其他架构不能由这些测试推断。
