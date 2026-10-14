# 分享 Rich 右键菜单修复

现状：网页走file-main/file-menus，只有slash菜单；客户端RichEditor另外接入右键菜单。直接引入现有菜单会携带pluginRuntime与桌面能力。

方案：复用EditorContextMenu/menu-model与rich-actions；菜单UI不读取插件运行时，Trace安装状态由桌面调用方传入。通用动作的图片/Trace能力由宿主显式注入，网页只提供格式、标题/块/列表、表格对齐/插入、公式/Mermaid、链接、批注、复制/剪切/粘贴/全选。网页不增加附件上传或远程图片请求。

file-menus绑定contextmenu并共用既有owner/controller准入和历史；打开时冻结authority/sourceLineage/generation/选区，所有执行及异步剪贴板返回后重新核验。切模式、detach、销毁、composition开始关闭菜单。异步粘贴拒权不修改正文；过期粘贴不落到新文件/选区。只读/Source/待保存组合输入不打开可修改菜单。

验收：真实挂载右键格式修改→undo→Source精确原文；表格列对齐；批注弹层与既有owner保护；剪贴板拒权/延迟后identity或模式改变保持原文；菜单复用.menu-panel/.menu-row，真实浏览器hover、Escape、窄屏与边缘定位可用。相关测试+类型检查+产物图纯度/实际IIFE验证通过后提交，不追加全阶段review。
