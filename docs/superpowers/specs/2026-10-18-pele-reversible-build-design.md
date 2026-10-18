# Pele 可撤销构建版本设计（2026-10-18）

用户授权：实现研究中的Pele版本，可能撤销，必须保留之前实现；用户明确仅构建开关，不增加设置项。

## 目标和边界

`VITE_DIAGRAM_RENDERER=pele` 选择Pele；unset或mermaid保留旧Mermaid。禁止新设置项/运行时持久化切换、自动fallback、版本号或对外发布。保留原CORE mermaid-renderer.ts和src/share-editor/mermaid.ts完整源码及旧宿主registry renderer，不能删Mermaid依赖。Markdown源码/代码块名称不变。无新worktree，按用户既有授权在现有main精准提交，保留原7项untracked。

## 统一引擎与回退

桌面MermaidLoader、静态HTML/PDF renderer、分享访客独立资源都按同一构建开关选择。旧路径不加载Pele；Pele独立share IIFE不包含Mermaid。构建脚本和Vite校验非空未知值并报错，不把拼错当成旧版。默认构建回退只需移除环境变量并重建，无需改数据或卸载库。不会暗中在某张图失败后改用旧引擎。

## 接口和响应式

CORE MermaidApi增加可选supportsResponsiveLayout?:boolean与renderMermaid(code, options?:{maxWidth?:number})。仅opt-in引擎创建ResizeObserver；旧API继续单参调用、无observer、原主题行为不变。有效容器宽度加入缓存，0宽等待可见尺寸，忽略仅高度变化；沿用debounce和generation，Edit/非mermaid/destroy断开。观察稳定wrapper内容宽，不能直接Pele.mount接管DOM。Share渲染模块同步允许可选能力标记和第三参数width，旧两参数路径兼容。

## Pele渲染和安全

精确锁定pele1.6.0（MIT与附带Lucide ISC notice）。共享纯浏览器渲染模块返回独立SVG字符串，render(source,{maxWidth,...})。六个现有主题色映射为SVG根上的Pele变量，并保留适当背景/字体fallback；复制PNG/离线HTML/PDF不依赖宿主继承CSS变量。前景和背景按明暗主题设置，不能将primaryColor误作页面背景。输出须保留viewBox与安全的本地引用/id前缀。

Pele不支持任意HTML标签、Mermaid themeVariables颜色/JS callbacks；文档注明差异。分享继续禁外链/图片和净化；新adapter在生成阶段images:false，不配置不可信icons，保留源/输出/edges上限、PeleError安全文本。DOMPurify SVG净化后剔除外部CSS url/@import和危险href；不放宽CSP，不引入CDN/eval/运行时外部资源。不绕过任何现有签名/hash/SRI/单文件IIFE/900KiB主包/8MiB单资源门槛。静态版心有效宽度作为maxWidth，不依赖screen宽。

## 验收和交付

TDD与定向回归覆盖真实Pele多类型/中文、安全、错误、独立SVG主题/导出、响应式race/cleanup、旧默认loader及share原行为。CORE build+typecheck+安装dist逐字节对齐；host check与测试；两种模式实际完整生产build与share资源门禁，产物隔离保存证据，最后保留Pele dist便于试用。真实浏览器验证SVG预览、暗色、窄屏与PNG/静态自足性（按可用工具）；没有Windows/Linux实机则明确待验。保留本轮提交列表与基线f7bd48f8/core97fcc3e以便revert；不自动推送或发布。
