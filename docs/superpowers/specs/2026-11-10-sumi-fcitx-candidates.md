# Sumi 内嵌 Fcitx 候选区

## 行为
仅 Linux Sumi 当前获得键盘焦点的原生编辑面板使用。普通输入框和其他应用仍使用 Fcitx 原候选窗。GTK 的预编辑、按键、提交、选区和持久化事务保持原路径。

- 使用正文实际 Pango 字体、字号、字重和行距，候选横向排列，第一项对齐正文左边界，占用正文可用宽度。无独立色块背景、边框或阴影，当前候选仅下划线强调。
- 专注模式：当前输入显示行的下一行开始，向下换行，最多四行。组合期间该区域作为纸页留白供候选占用，不能与原正文重叠；不向文档插入空行或候选文字。
- 非专注模式：打字时正文输入行固定在 Sumi 编辑区域底部；有候选时输入行在候选区上方，候选从底部向上扩展，最多四行。保留现有 bottom_inset。用户主动滚动阅读时允许退出底部锚定，重新输入时恢复。
- 页面很窄时允许候选区域内部翻页，超长候选按字形省略展示；候选真实索引保持不变，选择仍由 Fcitx 完成。
- 失焦、隐藏、销毁或 Fcitx 重启时清空候选，桥不可用时保留原输入法候选，不允许丢失选词能力。

## 实现
Fcitx fork 增加 opt-in sumicandidates 模块，通过 D-Bus 与 Sumi 通信。只接管显式激活且程序名匹配的精确 InputContext，不通过截图/OCR、不重写 IME。

服务 org.fcitx.Fcitx5，路径 /org/fcitx/Fcitx5/SumiCandidates，接口 org.fcitx.Fcitx.SumiCandidates1。
- SetActive(s token, as programs, b active) -> b
- Candidates(s token, t serial, a(iss) candidates, i cursor, b hasPrev, b hasNext)，单播至注册连接。
- Revoked(s token)：服务端撤销接管；清空客户端并在组合结束后重试。
- Select(s token, t serial, i index)、Page(s token, t serial, b next) 拒绝过期消息。

Sumi 在 GTK Overlay 中绘制；候选文字只存在展示状态，不进入 TextBuffer/CRDT/撤销历史。原生库依赖 Linux 基础桥提交 `40adb1f1a162348de9c8aefb86e992e64380da96`；候选功能在独立分支验证并提交。

## 验证
纯布局覆盖窄宽度、长词、Unicode、四行、分页和定位；真实隔离 Fcitx 覆盖候选数据/选词/翻页/失焦/断连回退。原生 GTK 测试字体继承、光标锚定、窗口尺寸变化与正文内容不变。真实桌面显示验收与程序化测试分开报告；未安装版本不宣称本机已生效。
