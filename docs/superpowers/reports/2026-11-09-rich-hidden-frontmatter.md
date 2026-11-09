# Rich 隐藏 YAML frontmatter

日期：2026-11-09。范围：桌面 Rich（文件、非文件及只读入口）。当前为源码实现，未发布、未安装正式包。

## 行为与实现

- 文件头经解析器识别的 frontmatter 完全隐藏：不生成 Metadata 摘要、可编辑值或占位空白。正文 YAML 代码块和分隔线保持可见。
- YAML 节点继续存在于文档模型中；文件 owner 保持原文、注释、BOM 和换行。Source 继续显示、编辑完整文档。
- desktop 专用选区插件将隐藏元数据内的光标/选区移到正文，阻止首个顶层正文块起点 Backspace 跨入元数据；嵌套列表正常退出列表。
- 仅 YAML 文件使用不可见空选区，单纯打开不创建编辑事务；显式聚焦时沿现有 owner 入口建立正文。只读文件不建立正文。
- 全选、复制、删除只作用于正文，支持 Source/Rich 往返、撤销重做。Source 显式修改元数据不受限制。
- 移除被替代的属性面板渲染器、元数据链接编辑分支及其专属编辑样式。分享静态页和插件自定义 Rich 维持既有行为。

## 验收发现与修复

隐藏之前的首段 Backspace 会选中 frontmatter；空首段还可能被删除并将光标移入 YAML。新增真实 RichEditor 回归先复现，再由选区插件修复。

带 BOM 文档清空正文另有既有 `semantic-mismatch`：内核正文清空路径要求 frontmatter 的原文起始偏移为 0，却未计入 BOM 后的偏移 1。通过无隐藏插件的 file controller 组合测试确认与本次呈现变化无关。内核仅修正此起点检查，不删除 BOM、不放宽语义校验；新增回归先有 5 项失败，再全部通过。

所需 `moraya-core` 提交：`8bb896a3a56c2184db648e94cc1be26321476134`。源码、测试、受版本控制的 dist/index.js 及 sourcemap 一并提交。宿主安装的全部 67 个 dist 文件与该构建逐字节和 SHA256 一致，见同目录 JSON 证据。依赖仍按仓库既有 `file:../moraya-core` 管理，后续构建应使用该提交或其后继。

## 验证

- 编辑内核：75 套 / 1745 测试通过，类型检查及构建通过。
- 宿主：426 套 / 5521 测试全部通过；Svelte 检查 0 errors / 31 个既有 warnings。
- Chromium 140.0.7339.16 实际浏览器：隐藏 NodeView 高度为 0 且无 details；新建模板、无末尾换行、BOM/CRLF、已有正文的光标和系统剪贴板粘贴；首行退格/方向键/文首跳转；系统复制不含 YAML；全选删正文保留 YAML；撤销重做、Source/Rich 和只读检查均通过。BOM/CRLF 全选清空在同步内核修复后再次通过。
- 实际组件：主 RichEditor、EditorPane + ModeToggle 的 Source 元数据修改/IME、切换文件后返回、正文 IME flush 等入口通过。
- 首次宿主全量发现旧测试依赖已移除的属性编辑单元格，已替换为 Source 编辑流程；默认 Rust toolchain 缺 cargo 和并发下 Linux 验证超时采用本机已安装 1.99.0、4 workers、15 秒测试超时复核，未修改无关发布逻辑。

原始日志、浏览器脚本和截图位于 `tasks/rich-hidden-frontmatter-20261109/`；该目录按仓库既有规则忽略，关键摘要及文件哈希随本报告版本控制。

边界：未进行 macOS WKWebView 原生实机验收、未发布安装包；Chromium 不作为 WebKit 验收证据。非文件旧编辑器仍沿用既有 serializer，不承诺文件 owner 的字节级保真。
