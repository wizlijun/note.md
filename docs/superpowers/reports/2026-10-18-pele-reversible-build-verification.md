# Pele 可撤销构建版本验证 — 2026-10-18

已实现并在本地 main 精确提交，未推送或公开发行；版本号仍为6.1018.1。用户明确选择仅构建开关、不增加设置项，且保留旧实现。

## 构建与撤销

- 默认/unset及明确 `VITE_DIAGRAM_RENDERER=mermaid` 使用原 Mermaid。候选构建：`env pnpm_config_verify_deps_before_run=false VITE_DIAGRAM_RENDERER=pele pnpm build`。
- 回退：`env -u VITE_DIAGRAM_RENDERER pnpm_config_verify_deps_before_run=false pnpm build`。开关只来自进程环境；未知非空值构建失败。开发试用先同模式build，再同模式dev；独立分享资源从dist读取。
- 桌面预览、静态HTML/PDF渲染、分享在线编辑采用同一选择，无运行时设置、数据迁移或单图自动fallback。CORE继续拥有DOM和错误恢复；Pele返回SVG字符串，不使用mount接管NodeView。
- 原CORE `src/plugins/mermaid-renderer.ts`、原宿主registry mermaidPlugin body、`src/share-editor/mermaid.ts`及原Mermaid依赖保留。前两份独立源码与基线逐字节相同，registry原body由冻结hash回归约束。

## 源码提交与回退基线

Host基线 `f7bd48f8`：`3293763b`设计/计划；`b285c074`共享Pele引擎/精确依赖；`41215257`三路径构建选择；`d1db0475`许可证与Safari15修复。应用实现冻结 `d1db0475e87123f21534555845cb94bb7572c7ea`，后续本报告提交仅证据。

CORE基线 `97fcc3e`：`5a0a6ef`可选响应式接缝；`474e4a1`旧ESM namespace兼容；`03225ca`仅补padding/border回归。最终CORE `03225cad14863d1b67113601fd994c87055d724f`；安装dist与源码dist共64文件完整哈希一致，无额外/缺失/差异。三个提交均保留在本地main，不推送。构建开关即可回退引擎；若将来整项撤销，按这些已归档提交在Git中revert，不需要reset/clean或改动笔记。

## 最终验证

- 最终host完整回归：**401文件 / 5060测试通过，exit0**，`full-host-tests-final.log`。初始实现400文件/5056测试亦通过，集中修复后重新跑全套；保留首次失败、修复和两次完整原始日志。
- host类型检查：**0错误 / 31项既有警告**。覆盖最终修复的38项定向测试通过。CORE新接缝loader/theme/响应式24项通过；补padding/border后响应式10项与typecheck通过，原构建dist不因补测试变化。CORE构建/typecheck通过；原renderer源码未动。
- 最终默认与Pele两次完整`pnpm build`均exit0，包含主Kit/独立资源AST封闭性、无eval/import、模块图、SRI/hash、900KiB主包gzip与8MiB单资源门禁；未放宽预算。
- 默认Mermaid独立资源SHA256 `62fdacdc210de8e12c8cd3c143542c058cf78b756a271a1446ed394b0e9a6cac`，与改动前6.1018.1本地发布构建资源相同。最终修复前后默认整套dist树的所有文件哈希亦完全相同。
- Pele独立资源SHA256 `5eaee6b3d1f91d1c42bf613d4cf5e2a6b2d03eca484298fc9425306ed1cb009c`，700917原始bytes / **259991 gzip bytes**；默认图表3420871原始bytes / **933098 gzip bytes**（相同Node门禁），图表资源约减少72%。不是安装包整体体积或端到端速度承诺。
- 独立Pele图谱4模块、旧Mermaid687模块；两种模式主分享Kit均277模块且JS hash相同，主Kit不包含任一引擎。Pele实际host chunk与独立IIFE都内嵌完整MIT/ISC全文，并在hash/SRI之前生成；缺notice实际旧产物被门禁拒绝。
- 最终真实Chromium **140.0.7339.16**：加载实际生产主Kit/独立资源，13项检查通过，manifest hash与最终构建一致。真实NodeView中文流程图viewBox **380×64→116×256**；HTML主题/六色变化后深色重绘；独立SVG经Image→Canvas转换PNG成功（116×256、148色），深色背景与accent像素正确。恶意图片/链接/语法样例无外部请求、CSP违规、脚本效果或pageerror，原Mermaid fence源码保留。浏览器和临时server已关闭。
- 集中最终审查：两Important（产物notice、Safari15缺randomUUID）与一Minor（非零padding/border测试）全部修复，唯一scoped复审 **Spec PASS / Quality APPROVE，新增C0/I0/M0**。前置三任务独立审查均通过。

## 边界和证据

Pele精确锁定1.6.0，保留MIT及Lucide ISC notice。默认限源50000字符、输出4000000字符、5000边；生成前禁图片，分享禁链接，SVG净化后只留安全本地引用；六色/背景与字体fallback固化到SVG，不依赖页面继承颜色。Safari15前缀使用getRandomValues，不依赖randomUUID；缺API模拟回归通过，未冒充Safari15实机。

任意HTML标签、Mermaid themeVariables颜色配置及JS callbacks不等价，详见 `docs/pele-build.md`。**尚未验证macOS原生WKWebView、Windows/Linux原生WebView、OS剪贴板PNG传输或实际PDF文件输出**；已验证的是真实Chromium分享编辑器及独立SVG栅格化。没有原生安装包构建、安装、上传、发版，也没有修改已有发行tag/资产。

全量日志保留Svelte/happy-dom的localhost资源/teardown诊断，CORE有既有KaTeX quirks-mode warning，不声称stderr pristine。原7项untracked文件/缓存目录保留、未纳入提交，无新worktree或reset/clean/stash删除。

原始证据：本地ignored `tasks/pele-implementation-20261018/`，包括 `dist-before-pele/`、`dist-mermaid/`、`dist-pele/`、`final-build-verification.json`、`default-final-rollback-check.json`、`core-install-check.json`、`browser-report.{md,json}`、截图/PNG、全部真实退出码/日志与归档SDD证据。

实施判断：依赖安装与CORE构建必须串行，安装会读取兄弟包dist，首次并行发生短暂ENOENT后已恢复完整安装；若该判断不适用，成本仅为重新安装依赖，不涉及源码损失。
