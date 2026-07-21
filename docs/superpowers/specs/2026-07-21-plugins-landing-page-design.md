# plugins.notemd.net 插件首页 — 设计文档

- 日期：2026-07-21
- 状态：已确认，待实现
- 作者：bruce + Claude

## 目标

在插件服务 `plugins.notemd.net` 上提供一个 HTML 首页，风格与主站 `notemd.net`
一致，导航栏可在主站与插件页之间切换。首页展示**当前最新版本**的插件及其介绍，
并明确告诉用户每个插件**从 App 的哪个入口使用**。同时更新主站首页/各页导航栏，
让用户能进入插件页。

## 背景与现状

- **主站 `notemd.net`**：`website/` 下的静态多语言站（en/de/ja/zh）。
  - 英文母版 `website/public/index.html`（手写）。
  - `website/build_i18n.py` 从母版按翻译行字符串替换，生成 `public/{zh,ja,de}/index.html`。
  - `website/build_pages.py` 生成 compare/integrations/guides 等 SEO 页（多语言）。
  - 设计 token：深色导航栏（`rgba(23,24,28,.9)` + blur）、paper 底 `#FAFAF7`、
    Playfair Display 衬线标题、EB Garamond 正文、Courier Prime mono 强调、
    琥珀 `#F59E0B` 主色。CF Worker `notemd-site` 托管。
- **插件服务 `plugins.notemd.net`**：`plugins-registry/` 的 CF Worker
  （`plugins-registry/src/index.ts`），当前**只有 `/api/*`**：
  - `GET /api/index.json` — KV `index` 逐字返回（`RegistryEntry[]`）。
  - `GET /api/download/<id>/<version>/<arch>[.minisig]` — R2 流。
  - `POST /api/stats/install` — 计数。
  - 没有任何 HTML 首页；未知路径返回 404 JSON。
- **`/api/index.json` 当前 5 个插件**（含 id/version/min_host/archs/name/description，
  **不含 `contributes`/入口信息**）：ExLibris、Export to PDF、OpenClaw Chat、
  Position Log、Roam Research Import。

## 决策（已与用户确认）

1. 首页**由插件 worker 自己托管**（放在插件服务上），不是主站的一个静态页。
2. 插件列表**运行时 `fetch('/api/index.json')` 动态渲染** → 永远显示最新版本，
   发新版无需改页面。
3. 语言范围：**英文 + 中文双语**（页面骨架 + 入口说明双语；插件 name/description
   目前仅英文，原样展示）。
4. 「使用入口」数据：**页面内按 id 硬编码映射**（不改发布脚本 / 各插件 manifest）。
5. 未知插件（映射表里没有的）入口显示通用兜底文案。

## 架构

改动两处，互不耦合：

### A. 插件 worker 新增 HTML 首页 — `plugins-registry/src/index.ts`

- `/api/*` 三个路由**原样保留**，逻辑零改动。
- 新增：`GET /`（和 `GET /index.html`）返回自包含 HTML 页面。
  - `content-type: text/html; charset=utf-8`
  - `cache-control: public, max-age=300`
  - 保留 CORS 头（沿用现有 `corsHeaders`）。
  - 仅 GET/HEAD；其他方法 405（复用 `methodNotAllowed`）。
- HTML 作为一个导出的模板常量（如 `src/page.ts` 导出 `PAGE_HTML` 字符串），
  在 `index.ts` 里 import，保持 `index.ts` 聚焦路由。页面**内联 CSS + JS**
  （无外链资源，字体走 Google Fonts CDN，与主站一致），一个请求即完整渲染骨架。
- 未知路径仍返回现有 404 JSON（不变）。

### B. 主站导航栏加「插件」入口 — `website/`

- 英文母版 `website/public/index.html` 导航栏加一个链接
  `插件/Plugins` → `https://plugins.notemd.net`。
- `website/build_i18n.py` 增加一条翻译行（en→zh/de/ja 的 "Plugins" 文案），
  重新生成 `public/{zh,ja,de}/index.html`。
- `website/build_pages.py` 的生成页导航（compare/integrations/guides）也加同一
  入口（走其 `c[]` i18n 字典），重新生成受影响页面。
- 目标：主站首页（4 语言）+ SEO 页导航栏都能点进插件页。

## 插件首页详细设计

### 布局

复用主站 token（内联，不引主站 CSS 文件，避免跨服务依赖）：

1. **导航栏**（sticky，深色）：
   - 左：logo `note·md`（`.` 为琥珀点），点击 → `https://notemd.net`。
   - 中/右链接（mono）：`note.md 主站`（→ notemd.net）、`插件`（当前页，高亮）。
   - 语言切换：`EN / 中文`（当前语言琥珀高亮）。
   - CTA：`下载 / Download`（→ `https://notemd.net/download`）。
2. **头部 header**（深色底）：
   - 面包屑式小标：`PLUGIN MARKETPLACE`。
   - 标题（衬线）：「note.md 插件市场」/ "Plugins for note.md"。
   - lead（斜体/一句）：介绍插件生态。
3. **如何安装** section（通用，双语）：
   - 打开 note.md → 顶部「插件」菜单 → 插件市场 → 一键安装。
   - 说明所有插件都从这里安装、更新。
4. **插件列表**：`fetch('/api/index.json')` 后按 `plugins[]` 渲染卡片。
   每张卡片：
   - 名称（`name`）+ 版本徽章（`v{version}`，mono）。
   - 描述（`description`）。
   - **「使用入口 / How to use」**行 — 来自硬编码 id→入口映射（双语）。
   - `min_host` 要求（如「需要 note.md ≥ 6.716.7」）。
5. **页脚 footer**：同主站风格，链接回 notemd.net。

### id → 使用入口映射（双语，取自各 manifest `contributes.menus.location`）

| id | zh 入口 | en 入口 |
|---|---|---|
| `notemd.md2pdf` | 「文件」菜单 → Export to PDF…（也支持 CLI `notemd pdf`） | File menu → Export to PDF… (also CLI `notemd pdf`) |
| `notemd.roam-import` | 「文件」菜单 → Import from Roam Research… | File menu → Import from Roam Research… |
| `notemd.openclaw-chat` | 「窗口」菜单 → OpenClaw | Window menu → OpenClaw |
| `notemd.exlibris` | 「窗口」菜单 → ExLibris | Window menu → ExLibris |
| `notemd.pos-log` | 「插件」菜单 → Save Location Now（装好后随启动自动记录） | Plugins menu → Save Location Now (auto-logs on startup once installed) |
| *（兜底）* | 安装后在 note.md 的「插件」菜单中启用 | Enable from the Plugins menu in note.md after install |

### 双语实现

- 页面内置一个 `I18N` 字典（页面骨架文案 + 上表入口映射，均 en/zh 两份）。
- 语言判定优先级：`?lang=zh|en` 查询参数 > `navigator.language`（`zh*`→中文）
  > 默认英文。
- 顶栏语言切换改 `?lang=` 并重渲染（或直接 JS 切换文本，不刷新）。
- 插件 `name`/`description` 来自 index.json，目前**仅英文**，两种语言下都原样显示
  （在 spec 记录为已知限制，将来 index.json 支持 i18n 字段再接）。

### 兜底与健壮性

- `fetch('/api/index.json')` 失败：列表区显示「暂时无法加载插件列表，请稍后重试 /
  Couldn't load plugins, please retry later.」，骨架/导航/安装说明照常展示。
- 空 `plugins: []`：显示「暂无已上架插件」。
- 卡片渲染对缺失字段（如 `min_host`）容错。

## 测试

- **worker 单元测试**（`plugins-registry/tests/`，vitest + workers pool，沿用现有）：
  - `GET /` 返回 200 + `content-type: text/html`，body 含关键标记（标题、
    `/api/index.json` 字样）。
  - `GET /index.html` 同样 200 HTML。
  - `/api/*` 三个路由行为不回归（已有测试保持通过）。
  - 未知路径仍 404 JSON。
  - 非 GET 的 `/` → 405。
- **前端渲染**：worker 测试只验证骨架 HTML；卡片是客户端 JS 渲染，靠人工
  GUI/浏览器验证（`wrangler dev` 后本地打开，检查 5 张卡片、入口文案、语言切换、
  导航跳转、fetch 失败兜底）。
- **主站**：`build_i18n.py` / `build_pages.py` 重新生成后，人工检查 4 语言首页
  与 SEO 页导航栏出现「插件/Plugins」链接且指向 plugins.notemd.net。

## 部署

- `plugins-registry/**` 改动推到 main 触发
  `.github/workflows/deploy-plugins-registry.yml`（`wrangler deploy`）。
- `website/**` 生成产物推到 main 触发 `deploy-website.yml`。
- 两者都是纯 worker/静态资源部署，无需改 KV/R2/域名。

## 非目标（YAGNI）

- 不做插件详情子页 / 路由（单页足够）。
- 不做 de/ja 两语（仅 en/zh）。
- 不改 `/api/*`、发布脚本、各插件 manifest、index.json 结构。
- 不做安装计数/下载量展示（虽有 `stats:<id>`，本期不接）。
- 不做插件搜索/分类/筛选（5 个插件用不上）。

## 已知限制

- 插件 name/description 只有英文（源自 index.json），中文视图下原样显示英文。
- 入口映射硬编码在页面里，新插件上架若未加映射，走通用兜底文案（需手动补映射
  才有精确入口）。
