# 分享网页工具栏与 Source 高度验收

修改：参照客户端ModeToggle的眼睛/代码图标与分段选中状态，接入tab键盘导航；撤销/重做/批注/修改使用图标，提交选项使用全局菜单。提交摘要收进修改面板；增强编辑容器补明确视口高度，基础textarea同步适配；只读正文保持自然高度。

验证：相关3文件263测试通过，pnpm check为0错误（既有31警告），pnpm build通过。实际content-addressed IIFE在Chromium通过1200×850、390×844、900×600、390×480四组视口：textarea与document可用高度逐项相等（689/677/439/313px），无横向溢出；键盘切换、预览往返保持草稿，修改面板限高，基础编辑390×844高度720px。全局菜单hover白字/选中背景实测通过。只读不加载编辑器。未做系统IME或移动真机新验收，沿用既有待验。

首次浏览器测试因只读URL仅变hash而未重新初始化协作token超时；修正测试导航为先离开页面再打开协作链接，原失败保留，未改变产品token语义。另修正两个既有browser检查脚本shebang必须位于首行的问题。

证据及截图：.superpowers/sdd/2026-10-14-share-editor-toolbar/evidence/toolbar-real-browser-navigation；类型/测试/build的完整执行记录位于同OWN。

本次源码修改不改变Worker。未发布新应用版本；旧分享包含冻结资源，需由含本次修复的应用重新发布项目后应用新界面。
