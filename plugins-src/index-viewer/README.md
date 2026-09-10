# 索引查看器（Index Viewer）

将 `*.index.md` 显示为可搜索的文件索引，支持多列表格、分组列表、泳道看板和封面网格。索引仍是普通 Markdown：层级标题、一段说明、一组单行文件列表；只用少量可选 frontmatter 指定初始布局。

```markdown
# 项目文件

## 工作

### 查看器

- [需求清单](./需求清单.md) [状态:: 待处理] #主题/需求
- [设计方案](./设计方案.md) [状态:: 进行中] [作者:: A B] #主题/设计 一句话说明
```

这里的文件名用于说明语法；可直接打开的完整演示位于下方模板目录。插件按文件后缀接入宿主文件视图，可从视图切换栏或插件菜单打开；不支持的格式会回退到 Markdown 编辑器。

## 使用

- `#` 为页面标题，`##` 至 `######` 为层级分类。标题跳级会挂到最近更浅的分类，回到浅层标题时结束旧子分类；段落与引用是当前分类的说明。
- 每个文件或知识页面一条单行列表，主链接在最前，支持 `[标题](./文件.md)`、`[[页面]]`、`[[页面|显示名]]` 和 `#标签`；同行写 `[字段:: 值]`、`#标签` 和说明。属性值可含空格、链接与图片，不需要对齐或子属性列表。
- 分类由标题决定，文件列表缩进增减不改变归属。属性可省略、顺序可调整；同一行重复字段会回退 Markdown。
- `文件`、`标签`、`说明` 是由主链接、行内标签、剩余尾文生成的保留字段；自定义属性使用其他名称。
- 可选 frontmatter 中的 `view` 为 `list`、`table`、`board` 或 `gallery`，省略时使用列表。`group_by` 指定确切字段名，省略时按标题分类；`lane_by` 指定看板纵向泳道字段。
- 封面推荐 `[封面:: ![封面](<./covers/book.png>)]`，支持 Vault 内 PNG、JPEG、WebP、GIF；按整行书写顺序的第一张图片作为封面。生成文件链接和图片链接时统一使用尖括号目标，并对路径做一次 URL 编码，例如 `![封面](<./Life%20in%20Three%20Dimensions/cover.jpg>)`；引号是 Markdown 的可选标题，不能用来包住含空格路径。
- `#标签` 与 `[[wikilink]]` 都是知识页面链接：`#阅读` 与 `[[阅读]]` 打开同一目标；`#[[产品 设计]]` 支持含空格的标签。属性值和说明中也可使用。
- 搜索、布局、分组与泳道切换仅改变当前显示，不修改索引或原文件。知识链接复用宿主页面索引及 Wiki / Daily Note 规则，目标不存在时，点击会由宿主创建页面；普通 Markdown 链接仍按相对文件路径打开。

四种布局共用上述单行列表源码，`table` 仅表示界面的表格布局。完整语法、路径规则和回退条件见 [格式说明](../../skills/file-index/references/format.md)。封面读取失败时显示占位与提示，不自动下载远程图片。

标题与列表参考 Notion、Obsidian 的基础结构；行内属性采用 Obsidian 社区 Dataview 的 `[字段:: 值]` 写法，并非 Obsidian 核心属性语法。不运行查询或表达式。具体采用与兼容边界见 [参考与取舍](../../skills/file-index/references/design-notes.md)。

知识页面也可直接作为索引条目：

```markdown
## 工作
- [[设计方案|方案]] [关联:: [[需求清单]]] #主题/设计
- [[阅读清单]] [主题:: #[[产品 设计]]] 参考 [[设计方法]]
```

这里的页面名是逻辑名称，由宿主解析；`#主题/设计` 与 `[[主题/设计]]` 等效，斜线不会被插件当成相对目录。标签仍能搜索和分组，点击则导航到知识页面；两种写法都参与反向链接，可从目标页面反查这份索引的来源条目。加载索引不会创建页面，创建只在点击缺失的知识链接时发生。

## 模板与 Agent skill

四份模板使用明确标为演示的文件和本地生成封面，相对链接均有对应目标：

- 多列表格：[table.index.md](../../skills/file-index/assets/table.index.md)
- 分组列表：[list.index.md](../../skills/file-index/assets/list.index.md)
- 泳道看板：[board.index.md](../../skills/file-index/assets/board.index.md)
- 书籍封面：[gallery.index.md](../../skills/file-index/assets/gallery.index.md)

将整个 `skills/file-index/` 目录复制到所用 Agent 的 skills 目录即可使用；目录自包含，不依赖本仓库其他文件。已有同名 skill 时先比较内容，避免覆盖用户定制。这里仅提供资源，不自动安装。

[SKILL.md](../../skills/file-index/SKILL.md) 指导 Agent 根据真实文件生成索引；[四类 prompt](../../skills/file-index/references/prompts.md) 可直接调整使用。复制演示到 Vault 体验时，请连同 `assets/examples/` 和 `assets/covers/` 一起保留相对目录；生成真实索引时应替换为实际文件与有证据的字段。

## 开发与验证

宿主最低版本为 `6.910.1`。在仓库根目录运行：

```sh
pnpm --filter index-viewer test
pnpm --filter index-viewer check
pnpm --filter index-viewer build
node scripts/check-index-viewer-browser.mjs
```

浏览器验收使用 Playwright；可通过 `PLAYWRIGHT_MODULE` 指定模块路径，通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定本机 Chrome。测试使用隔离的示例 Vault 和真实宿主视图桥接。

`bash scripts/release-plugins.sh index-viewer` 构建并签名本地插件包，不上传；`bash scripts/dev-install-plugin.sh index-viewer` 用于明确需要时安装到本机开发环境。
