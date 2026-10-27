# NEXT 打开任务后编辑会话卡住：IME 事件归属

## 已确认的缺陷

宿主在 Rich 容器祖先捕获 compositionstart/compositionend，原先将容器内所有输入都记为正文的输入法状态。frontmatter NodeView 内的字段有自己的 contenteditable，ProseMirror 不处理它的输入事件；字段 blur 提交时会重建 NodeView 并移除原输入节点。若结束事件发给旧节点，就无法回到 Rich 容器，宿主 richComposing 永久为 true。owner.flush 等待这个状态结束，Source 切换与 activate 都无法完成；NEXT 打开同路径会复用原会话，因此不会自动恢复。

隔离回归使用实际 frontmatterFactory、EditorPane、ModeToggle、openPath/openFile，重现字段 compositionstart → blur 提交并移除节点 → 旧节点 compositionend。修复前 Source 保持 Rich；不是 readonly、文件权限或 NEXT 覆盖层造成。

现场已观察 Source 按钮、原生模式菜单均不能切换；打开另一文件新增标签但旧文档仍活动，侧栏按钮可以响应。文件可写、无 readonly，路径无链接差异。已确认的代码缺陷符合这些症状；用户不确定是否先输入中文，不能将隔离复现当成这一次现场的完整事件记录。

## 修复边界

统一判断输入事件属于正文还是嵌套 NodeView 自管字段。Rich 输入法状态与共享键盘守卫仅接纳外层编辑区；input/textarea/select 由原生控件处理；嵌套 contenteditable 使用按节点隔离的弱引用守卫，保留既有收尾按键保护，不能污染正文状态。不按组件 CSS 命名，不增加计时强制解锁，不提前提交真实正文组合输入，不放宽只读与保存校验。

## 验证与交付

验证字段内容原样保留，Source 切换、Source 编辑、切换文件及返回可用；保留正常正文输入等待最终 compositionend 的行为。检查共享守卫的桌面 Rich、Editor Kit 与相关输入法回归。使用隔离浏览器 fixture 比较故障事件序列，不修改正式任务。此修复属于宿主，不包含在已发布 NEXT 1.10.0；发布与安装需独立说明。
