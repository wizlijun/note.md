# Project Share Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现已确认的当前模板项目阅读页、Folder View 文件树、自定义分享标题，并完成部署与应用正式发布。

**Architecture:** 宿主从不可变批准快照生成正文HTML、SVG和模板资源，公开单HTML仅做显示、导航及既有本地协作。源修改时间新增可选字段；分享标题复用Identity/pending，不增加服务或数据库。

**Tech Stack:** Svelte 5 / TypeScript / Tauri Rust / Marked / KaTeX / highlight.js / mermaid-mini / @viz-js/viz / 既有 Wrangler 3 / macOS release.sh。

**Spec:** `docs/superpowers/specs/2026-10-10-project-share-reader-design.md`

## Global Constraints

- 实施在现有 main，不开 worktree，精确保护原46个 dirty tracked 改动。
- 左侧文件栏默认收起，支持文件夹逐层展开，参考现有 Folder View 风格；文件按修改时间从新到旧排列。
- 正文沿用发布时应用当前选中的正文主题/皮肤，与单篇分享同源；代码不得硬编码 Effie。
- 删除整块「note.md 项目分享」标题栏、固定说明、常驻状态信息及重复文件标题。保留 Markdown 本身的标题。
- 分享时可设置分享标题，默认入口文件名去扩展名；frame显示「分享标题 · 只读/可编辑」，以当前token能力判定。
- 草稿图表显示代码和提示，合入重发后完整渲染；反馈5MiB、最终HTML25MiB、原包重试合同保留。
- 图表与模板仅访问批准快照/打包资源；不读取其他磁盘文件、不增加CDN引擎、浏览器WASM或服务。
- 用户本轮已授权实现、部署、合并main与正式发版；不重复请求发布许可。既有普通发布clone可继续使用，不新建worktree。

## Task 1: 冻结正文和模板呈现

**Files:** Create `src/lib/project-share/presentation.ts`, `presentation.test.ts`; Modify `src/lib/plugins/host-render-html.ts`, `share-baker.ts`（仅必要共享入口）。

**Interfaces:**
```ts
export interface ProjectPresentation {
  themeId: string
  styleHead: string
  documents: Record<string, string>
  warnings: string[]
}
export async function renderProjectPresentation(snapshot: ProjectSnapshot): Promise<ProjectPresentation>
```
正文HTML内批准资源统一使用`data-project-resource="相对path"`，由viewer绑定snapshot中的dataUrl；项目文档链接使用`data-project-path`。类型定义由本任务拥有，其他任务只import type。

- [ ] 先写失败测试：同源模板/GFM/KaTeX/highlight/图表结构、前置原HTML净化、受限资源及CSS依赖，不读取未批准磁盘。
```ts
expect(result.documents['README.md']).toContain('katex')
expect(result.documents['README.md']).not.toContain('onerror=')
expect(result.styleHead).not.toContain('file://')
expect(result.documents['README.md']).toContain('data-project-resource')
```
- [ ] 运行 `pnpm exec vitest run src/lib/project-share/presentation.test.ts`，记录失败后实现。
- [ ] 复用renderTabBody、图表和正文样式必要入口，先限制原HTML/图表资源再渲染，保留受控SVG/MathML/class/style；生成器失败有源和提示。捕获真实当前主题，字体fallback警告，KaTeX woff2内嵌，无重复图片。
```ts
const documents: Record<string,string> = {}
for (const file of snapshot.files) {
  if (file.markdown === undefined) continue
  documents[file.path] = await renderApprovedDocument(file, snapshot)
}
return { themeId, styleHead, documents, warnings }
```
- [ ] 运行新测试及既有share-baker/diagram-render测试，写报告；主代理精确提交后独立任务审查。

## Task 2: 静态阅读壳、文件树与协作视图

**Files:** Modify `src/lib/project-share/bundle.ts`, `browser.ts`, `bundle.test.ts`, `browser.test.ts`。

**Interfaces:**
```ts
export interface ProjectBundleOptions { title?: string; presentation?: ProjectPresentation }
export function buildProjectBundle(snapshot: ProjectSnapshot, feedbackUrl: string, options?: ProjectBundleOptions): string
// payload: {snapshot,feedbackUrl,title,presentation}; baseline优先presentation.documents[path]
```
消费Task1 presentation，snapshot.files[].modifiedAt可选，未知排后。build默认title从entry去扩展，支持旧fixture；生产host始终传presentation。

- [ ] 先写行为失败测试，覆盖默认折叠/层级展开/修改时间排序、标题权限、只读控件隐藏、导航及正文外选文拒绝。
```ts
expect(document.getElementById('file-panel')!.hidden).toBe(true)
expect(document.title).toBe('自定义标题 · 可编辑')
expect(document.querySelector('header')).toBeNull()
```
- [ ] 跑相关browser/bundle测试记录红灯；实现FolderTreeNode风格的静态嵌套按钮、目录优先同类降序、当前祖先、手机抽屉/焦点。保留既有IDB/提交合同，基线挂载冻结HTML，绑定批准资源，草稿轻量净化预览+图表源提示。
```ts
const published = data.presentation?.documents[path]
const original = baseline || (state.drafts[path] ?? file.markdown) === file.markdown
article.innerHTML = original && published !== undefined ? published : sanitize(parser.parse(markdown))
```
- [ ] 验证原协作回归、CSP/JSON/包限制，原图表不能被裸Marked再次覆盖。写报告供主代理提交及独立审查。

## Task 3: 分享标题与源修改时间

**Files:** Modify `src-tauri/src/project_share.rs`, `src/lib/project-share/types.ts`, `host.ts`, `host.test.ts`, `src/components/ProjectShareDialog.svelte`, `.test.ts`; Create `src/lib/project-share/title.ts`（必要时）。

**Interfaces:**
```ts
// ProjectFile.modifiedAt?: number
// ProjectIdentity.shareTitle?: string; pending.shareTitle?: string
export async function publishProject(info: ProjectInfo, files: ProjectFile[], title?: string): Promise<{info:ProjectInfo;identity:ProjectIdentity;warnings?:string[]}>
// 无pending分支：await renderProjectPresentation(snapshot)，buildProjectBundle(...,{title,presentation})
```
RustProjectFile增加`#[serde(default, skip_serializing_if="Option::is_none")] modified_at:Option<u64>`，serde camelCase；snapshot源准备阶段捕获mtime，其他make_file调用可None；保持旧schema1。

- [ ] 先写标题配置/原包重试/旧schema/mtime源测试，运行相关前端与Rust定向测试记录红灯。
```ts
await publishProject(info, [file], '分享标题')
expect(identity.pending?.shareTitle).toBe('分享标题')
// 重试不调用renderProjectPresentation，不受后来输入/主题变化影响
```
- [ ] 实现输入默认值、按project切换初始化、扫描不覆盖输入、pending只显示冻结title；成功记忆title并显示渲染warnings。源mtime只作排序，不改baseHash。host await渲染成功后写bundle/pending，才上传。
- [ ] 跑host/dialog回归及Rust项目分享测试，确保删除、停止、当前文档入口等原功能保留。写报告，精确提交并独立审查。

## Task 4: 集成与真实浏览器验证

**Files:** 必要修复限以上范围；证据放`tasks/design/project-share-reader-implementation-20261010/`。

- [ ] 主代理审查三任务接口并运行前端相关测试、`pnpm check`与最终全套测试；Rust定向和全lib在既有干净发布clone执行以避开用户不相关dirty。
- [ ] 真实宿主/隔离native probe调用生产publish链；包含两层目录、同/未知mtime、缺图、中文Mermaid flow/sequence/quadrant、DOT、公式、宽表、frontmatter、CriticMarkup及恶意HTML的fixture。
- [ ] 真实浏览器检查最终单HTML/CSP的浅深色、Effie/另一主题、390px、目录收放/标题/模式、跳转/草稿/标注/提交。宿主canary资源请求为零，批准reader无越界；离线KaTeX字体/图表正常，无未批准本机路径。
- [ ] 完成各任务spec+质量审查及一次整体审查，修复实质发现并复验。记录证据和测试数量，不以mock宣称真实图表通过。

## Task 5: 部署与正式应用发布

**Files:** `CHANGELOG.md`, `CHANGELOG.zh-CN.md`；版本由既有release脚本在发布clone管理。

- [ ] 精确提交实现与中英changelog；复用`/Users/bruce/git/mdeditor-release-610082-20261008`的main，检查clean/upstream，将root预期提交合入main，保留所有上游已发布功能，不复制root不相关dirty。
- [ ] 读取现有Worker部署记录及环境变量名称，使用既有Wrangler3/Account API Token部署兼容Worker（即使协议不变也按用户授权执行），记录版本并匿名HTTP检查；不打印凭据。
- [ ] 在干净已同步main运行`bash scripts/release.sh --draft`，完成前端/Rust门禁、双架构签名公证、updater签名，复核具体产物后公开draft。
- [ ] 匿名公网校验release七个资产大小/SHA256/signature与latest.json、两架构签名公证及Gatekeeper，记录版本/链接。验证新应用发布生成的新分享页面；旧冻结页面需owner更新分享才获得新设计。
- [ ] 清理本轮可重建target/临时下载/隔离probe，保留正式产物、证据、用户配置与全部46项dirty，更新tasks/todo回顾。
