# 分享 Rich 右键菜单验收

## 修复

file-menus补齐右键入口，复用客户端EditorContextMenu/menu-model/rich-actions。菜单显式注入Trace/图片能力，桌面Rich/Source调用方保留原插件能力；网页无Tauri或插件运行时依赖，不提供图片上传，图片自身使用浏览器原生复制/保存菜单。网页菜单沿页面语言显示。

格式/列表/标题/表格命令走既有file owner，批注走既有admission。每次打开捕获authority/sourceLineage/generation/选区；延迟剪切和粘贴在返回后再次检查。Source切换并返回、readonly切换并返回、detach后重新挂载均使原操作过期。右键前同步编辑器选区，避免原生右键的选区事件使整个菜单失效。菜单和子菜单使用全局.menu-panel/.menu-row；主菜单可滚动，子菜单独立定位以避免被裁切，窄屏与窗口边缘内可达。

## 验证

- 8文件161项相关测试通过，包含桌面图片对话框/延迟粘贴原有回归、共享批注及保真保存；最终选区修正后14项context/slash专项通过。
- pnpm check：0错误、31项既有警告。pnpm build：同一IIFE纯度/hash/SRI门槛通过，无Tauri/主Mermaid依赖，主包gzip598240 bytes。
- 真实Chromium实际静态页与最终IIFE：右键加粗→撤销保持原Markdown；右键提问进入共享批注弹层并在Source保留Critic；表格列居中成功；390×480主/子菜单均位于窗口内、hover白字高亮、Escape关闭；实际提交HTTP正文等于编辑后源码。截图已检查。
- 不把窄屏视口模拟写为移动真机/系统IME通过。

## 过程记录

新增测试初次有菜单label/表格空格预期错误；改为既有目录实际label与真实GFM对齐结果。初次实际浏览器发现二次右键导致选区晚到、菜单变灰，已通过打开前同步选区修复并在同场景验证通过。失败与最终结果均保留。

证据：.superpowers/sdd/2026-10-14-share-rich-context-menu/evidence；最终浏览器context-real-browser-selection，截图context-desktop.png/context-mobile.png。

本次已修复源码，尚未发布新的宿主版本；分享网页采用冻结发布资源，升级并重新发布项目后生效。
