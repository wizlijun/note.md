# Pele 默认内核与构建回退 / Default Pele renderer and build fallback

Pele 是默认图表内核；不设置或清空 `VITE_DIAGRAM_RENDERER` 都使用 Pele。仅构建时选择，不提供设置项或自动回退。桌面预览、静态 HTML/PDF 导出、分享访客图表使用同一选择；Markdown 的 mermaid 代码块无需迁移。

```sh
env -u VITE_DIAGRAM_RENDERER pnpm_config_verify_deps_before_run=false pnpm build
```

回退必须明确使用 `VITE_DIAGRAM_RENDERER=mermaid` 重新构建。未知非空值会使构建报错。

```sh
env VITE_DIAGRAM_RENDERER=mermaid pnpm_config_verify_deps_before_run=false pnpm build
```

开发服务器的分享资源读取 dist 中已构建的独立资源，因此必须先使用同一选择执行 build，再以同一选择执行 dev。回退也必须先重建；只重启 dev 不能替换旧分享资源。请通过进程环境变量传入开关，三个构建路径共用该值。

Pele 支持的语法与 Mermaid 有差异：任意 HTML 标签、Mermaid themeVariables 自定义颜色语法与 JS callbacks 不受支持。新引擎不会在单图失败时偷偷切回旧引擎；保留源码修正语法或显式重建 Mermaid 版本。图表图片禁用；分享同时禁用链接，不加载外部资源。主题六色在每次渲染时读取，导出 SVG 自带颜色与背景。没有即时性能提升保证；Windows/Linux 原生宿主仍需实机验证。

The selector is build-only, with no settings UI or automatic fallback. The same process environment selects the desktop preview, static HTML/PDF export, and independent visitor diagram resource. Existing mermaid Markdown stays unchanged. Pele is the default when the variable is unset or empty. Explicitly set `VITE_DIAGRAM_RENDERER=mermaid` and rebuild to revert. Unknown nonempty values fail the build.

For development, build first and run dev with the same selector: the share asset plugin serves the independent resources already in dist. Reverting also requires rebuilding before dev. Supply the selector through the process environment so every build path uses the same value.

Pele syntax differs from Mermaid: arbitrary HTML labels, Mermaid themeVariables syntax, and JS callbacks are unsupported. A diagram error keeps its source; it does not switch engines. Images are disabled; shares also disable links and external resources. Each render reads the current six theme colors, and exported SVG contains its own palette and background. No immediate performance improvement is promised. Native Windows/Linux verification remains outstanding.

## 定期检查上游更新 / Upstream update checks

[Check Pele updates](https://github.com/wizlijun/note.md/actions/workflows/check-pele-updates.yml) 每周一 01:00 UTC（台北 09:00）查询 npm 官方最新稳定版，也可手动运行。检查摘要记录当前固定版本与上游版本；发现新版时给出 notice。它不安装依赖、不自动升级或发版。升级前需审阅变更，并复核图谱 50 个样例的明暗主题、安全净化、导出/分享及 Mermaid 回退构建。

The read-only workflow checks the official npm registry every Monday at 01:00 UTC (09:00 Asia/Taipei), and supports manual runs. Results appear in the job summary with an update notice when a newer stable version exists. The pinned dependency changes only after a separate review and diagram/compatibility checks.
