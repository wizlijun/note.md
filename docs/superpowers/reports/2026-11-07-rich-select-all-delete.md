# Rich 全选后删除无响应修复

用户确认 Cmd+A 显示全选高亮，但 Backspace 不删除。已核实本机 6.1106.1 的实际 Mach-O 含上一轮末字删除修复，因此本次单独补齐全选路径。

## 原因与处理

- 软换行、引用定义、脚注、HTML 等正文完整删除被源码保真层拒绝。core ac79ae4410de4ba35cd713f7127b374f935b1cca 增加仅在原路径失败时使用的完整清空处理；验证标准 ReplaceStep、完整覆盖范围与空段落终态，保留元数据及隐藏 top-level 引用定义原字节，重解析严格核对文档语义。
- 引用定义恰到文件末尾时的无变化补丁会被 SourceHistoryStep 拒绝；不再生成该补丁，历史校验保持严格，并直接覆盖正向/撤销/重做回放。
- TextSelection 会遗漏结构包装、公式等块及批注点。宿主对这些内容用完整正文 BodySelection，普通段落、标题、代码正文继续原文字选区。元数据不纳入正文全选，删除后保留可编辑空段。
- 新块选区按 Enter 曾被当作邻接段落插入；core e01e451b7df7dadbd74de1060bd3a5d05cd89e6b 对非空自定义块范围经 Selection.replace 删除选区，保留 AllSelection、NodeSelection、IME 与修饰键的原有行为。

## 验证

- core 全量 73 文件 / 1712 项通过；类型检查、分发构建通过。
- 宿主相关 83 项通过：实际 Rich Cmd+A 两次、Backspace/Delete/Enter、元数据与隐藏定义保留、只读、撤销重做和保存重开。原末字退格 18 项也通过。
- svelte-check 0 错误 / 31 个既有警告。独审发现的 Enter 与段内批注漏项均有回归并已修正。
- 原生控制只读取到本机空白启动页，未把它计为 WKWebView 键盘交互验收；未修改用户正式文档。

## 范围和发布状态

末尾软换行的独立逐字退格边界、嵌套结构中的受保护引用定义仍保留拒绝策略，本轮未放宽保护。旧 6.1106.1 发布流程已停止，原日志保留；本修复拟由 6.1107.1 Apple Silicon 测试版交付，最终 tag、包和公网上线证据另录发布报告。

本机证据：tasks/backspace-select-all-20261106/、tasks/backspace-selectall-20261106/、tasks/select-all-delete-20261106/。
