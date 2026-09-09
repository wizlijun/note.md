# Index Viewer

将 `*.index.md` 显示为可搜索的文件索引，支持多列表格、分组列表、泳道看板和封面网格。索引仍是普通 Markdown：一个标题、一段说明、一组文件列表；只用少量可选 frontmatter 指定初始布局。

```markdown
---
view: board
group_by: 状态
lane_by: 项目
---
# 项目文件

按状态与项目浏览已有文件。

- [需求清单](./需求清单.md)
  - 状态：待处理
  - 项目：查看器

- [设计方案](./设计方案.md)
  - 状态：进行中
  - 项目：查看器
```

这里的文件名用于说明语法；可直接打开的完整演示位于下方模板目录。插件按文件后缀接入宿主文件视图，可从视图切换栏或插件菜单打开；不支持的格式会回退到 Markdown 编辑器。

## 使用

- 每个文件用一条列表记录，链接独占一行；后续用“字段：值”记录属性，可按需增减。
- 属性缩进不决定归属：空格或 tab 多一些、少一些都归最近的前一个文件条目；新文件条目或二级标题结束上一条。推荐属性缩进两格并带列表符号，也支持不带符号。
- 属性顺序可不同，缺失字段自动留空；同一条目内重复字段会回退 Markdown，避免猜测覆盖。
- `view` 可选 `table`、`list`、`board`、`gallery`，省略时使用表格。
- `group_by` 是确切属性名；省略时按 Markdown 二级标题分组。
- `lane_by` 为看板的纵向泳道字段，横向列由分组决定。
- 任意属性中的第一张 Markdown 图片作为该条目封面；支持 Vault 内 PNG、JPEG、WebP、GIF。
- 搜索、布局、分组与泳道切换仅改变当前显示；点击链接打开文件，不修改索引或原文件。

四种布局共用上述列表源码，`table` 仅表示界面的表格布局。完整语法、路径规则和回退条件见 [格式说明](../../skills/file-index/references/format.md)。封面读取失败时显示占位与提示，不自动下载远程图片。

## 模板与 Agent skill

四份模板使用明确标为演示的文件和本地生成封面，相对链接均有对应目标：

- 多列表格：[table.index.md](../../skills/file-index/assets/table.index.md)
- 分组列表：[list.index.md](../../skills/file-index/assets/list.index.md)
- 泳道看板：[board.index.md](../../skills/file-index/assets/board.index.md)
- 书籍封面：[gallery.index.md](../../skills/file-index/assets/gallery.index.md)

将整个 `skills/file-index/` 目录复制到所用 Agent 的 skills 目录即可使用；目录自包含，不依赖本仓库其他文件。已有同名 skill 时先比较内容，避免覆盖用户定制。这里仅提供资源，不自动安装。

[SKILL.md](../../skills/file-index/SKILL.md) 指导 Agent 根据真实文件生成索引；[四类 prompt](../../skills/file-index/references/prompts.md) 可直接调整使用。复制演示到 Vault 体验时，请连同 `assets/examples/` 和 `assets/covers/` 一起保留相对目录；生成真实索引时应替换为实际文件与有证据的字段。

## 开发与验证

宿主最低版本为 `6.909.4`。在仓库根目录运行：

```sh
pnpm --filter index-viewer test
pnpm --filter index-viewer check
pnpm --filter index-viewer build
node scripts/check-index-viewer-browser.mjs
```

浏览器验收使用 Playwright；可通过 `PLAYWRIGHT_MODULE` 指定模块路径，通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定本机 Chrome。测试使用隔离的示例 Vault 和真实宿主视图桥接。

`bash scripts/release-plugins.sh index-viewer` 构建并签名本地插件包，不上传；`bash scripts/dev-install-plugin.sh index-viewer` 用于明确需要时安装到本机开发环境。
