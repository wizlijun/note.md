# Rich 全选后无法删除：修复与验证

## 原因和修复

主窗口全选按设计避开 frontmatter。旧 `@moraya/core` 在删除键处理中将 DOM 选中文字长度达到全文 90% 的选区当作整篇文档，执行 `replaceWith(0, docSize, paragraph)`。因此正文较长时连未选中的 frontmatter 也被纳入删除，FileController 的源码一致性检查以 `unsupported-step` 拒绝事务；普通文档的大片部分选区则可能误删未选中的尾部。

修复移除 DOM 范围/文字比例推断，以刷新后的 ProseMirror 选区为准；保留真正全选的快速删除，未放宽文件准入检查。源码和 tracked dist 位于兄弟依赖仓库 moraya-core。

- core 提交：`061143066af7c220e2799e6c63b6db7f66e4cb31`。
- 使用既有 `npm run sync:core` 同步依赖；64 个 dist 文件逐字节一致。
- `dist/index.js` SHA-256：`464b3eafa9db040336e53b43946368ce2edfbd9a7931e5a8b9e5eadffa961b1e`。
- mdeditor 的 `file:../moraya-core` 不锁定 Git SHA；后续发布必须同时纳入上述 core 提交，不能只移植宿主回归提交。

## 验证

- 修复前：实际 FileEditor DOM 键盘回归的正文删除和部分选区共4项失败；桌面测试最初未设置平台，后已显式设Apple平台并断言选区非空。core 独立DOM回归4失败2通过。
- 修复后：宿主新增9项通过，包括桌面 RichEditor Cmd+A/Backspace、Backspace/Delete、frontmatter保留、部分选区尾部保留、无metadata全选、原字节撤销重做、onChange、owner.flush、Source切换及重挂载、只读与IME。
- 宿主相关套件：34文件、493项通过；core全量：70文件、1655项通过。
- core构建、TypeScript检查通过；宿主svelte-check 0错误、31项既有警告；双方diff检查通过。
- 独立审查无阻断问题。

测试使用 happy-dom 的真实组件、EditorView 和DOM事件；未进行 WKWebView 实机验收或真实磁盘保存。未发布、未安装、未改用户正式文档；其他Agent/NEXT任务的未提交改动未纳入。
