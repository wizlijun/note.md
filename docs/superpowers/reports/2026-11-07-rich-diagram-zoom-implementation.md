# Rich 图表缩放实施与验收

日期：2026-11-07。实现完成，未发布、未替换用户安装包，也未修改6.1107.2冻结tag。

## 实现

桌面Rich的Mermaid/Pele与DOT/Graphviz成功预览接入统一视口；图内新滚轮序列直接缩放，图外滚页，跨界尾事件不突然转交。支持捏合适配、拖拽/方向按钮/键盘平移、恢复100%和适应视口。长图高度受限，两侧各保留24px滚页通道，默认与恢复100%从顶部开始。

沿用工具栏常显偏好；隐藏时仍预留换行高度，焦点/手势中可达。四语可访问名称与原生按钮激活就绪。源码/预览焦点交接和宿主capture快捷键隔离；图内href/xlink在拖拽判定后的click经原有安全打开链处理。

查看状态只在文档会话内保存，按事务映射块身份；无关编辑、主题、NodeView重建和临时tab切换保留，关闭重开/源码变化复位。缩放不改Markdown、dirty或撤销历史，复制仍使用完整原图。renderer采用已挂载的隔离输出和generation核验，取消立即清理，晚到结果再次清理自己的资源；destroy的幂等约定已写入core类型。

core提交：`aac4cde2dc2b98dafa42015b8934c13eb0aa739d`。源码、测试与分发dist一起提交；宿主消费的67个dist文件与该core构建目录逐字节一致，setup.js SHA256为`6b0dbdd010cba6d55be3aef32669c74cb7efb8cd8e0c32294ca8bd6cbebb9e03`。宿主文件与本报告同一提交；两仓库提交均未推送。

## 验证

| 检查 | 结果 |
| --- | --- |
| core全量测试（含最终长图顶部修正） | 75文件、1731项通过 |
| core类型/构建与diff检查 | 通过 |
| 宿主全量测试 | 416文件、5453项通过 |
| 最终顶部修正同步后的宿主定向测试 | 5文件、35项通过 |
| Svelte类型检查 | 0错误、31项既有警告 |
| 最终Pele生产构建、Editor Kit/share检查 | 通过 |
| 真实RichEditor页面 | 17组通过；最终顶部修正另有定向复核 |
| 独立源码审查 | 发现问题已修复并回归，无未处理P1/P2 |

全量宿主测试先因默认stable Rust工具链缺失cargo失败；按项目此前发布使用的`RUSTUP_TOOLCHAIN=1.99.0`重跑全量通过，未修改工具链或测试。最后仅新增长图初始/恢复纵向位置修正，其core全量、宿主定向、生产构建及真实页面定向检查均通过，未将先前17组矩阵冒称在最终哈希全部重跑。

浏览器覆盖file-backed与兼容挂载、鼠标锚点/倍率端点/跨界序列、不可取消事件、合成GestureEvent去重路径、拖拽与链接、Enter/Space代码/复制、只读、390px实际面板、深浅主题、会话保留/重开复位。PNG有viewBox为1024×88、无viewBox为1365×117，在100%与400%时各自尺寸一致。最终fresh页面确认正常DOT完整显示，长图初始与恢复top=0，适应视口完整显示。

机器可读摘要见同名JSON。本机完整日志、事件与截图在`tasks/diagram-zoom-20261107/`（该目录按仓库规则忽略，不是发布产物）。默认截图为`browser/light-default.png`、`narrow-default.png`及`dark-narrow-default.png`。

## 发布前仍须验证

Mac物理鼠标滚轮和触摸板捏合/双指滚动尚未在实际候选note.md WKWebView验收。独立WKWebView仅完成runtime/API及Graphviz初始化烟测；环境中的隐藏/背景窗口始终报告hidden，Mermaid的rAF初始化被暂停，不能据此宣称原生完整渲染或手势通过。Chromium自动化中的trusted事件也不是物理硬件证据。

已提供本机`native-probe.swift`及`NATIVE-PROBE.md`供可见窗口采集真实事件。发布Apple Silicon候选前须核实取消默认行为、wheel/gesture去重、跨界与灵敏度；未提前承诺Windows/Linux或移动触屏支持。本轮未访问用户Vault、未发布或安装应用。
