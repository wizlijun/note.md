# Index Viewer：Markdown 文件索引查看器

## 目标与范围

`*.index.md` 表示一批文件的静态索引。插件通过已有文件名规则、菜单命令及宿主 Rich/Source/文件视图槽打开；解析失败回退 Markdown。V1 是只读查看器：点击文件打开原文件，布局切换、搜索与分组选择只影响当前显示，不修改索引、不移动原文件。此次实现、验证与提供模板/skill，不自动发布。

## Markdown 格式 V1

唯一数据形式为 GFM 表格，不引入 JSON、指令围栏、块 ID 或逐行 YAML。第一列每行恰好一个标准 Markdown 文件链接，列名自由；其余列可自定义，保留顺序与内容。图片以 `![说明](相对路径)` 写在任意单元格，每行第一张图作为封面。支持强调、行内代码、普通链接的文本显示，链接仍可点击；原始 HTML 不执行。Markdown 链接目标相对索引文件，允许在 Vault 内使用 `../`；禁止越出 Vault、网络或脚本 URL。封面通过宿主 `host.vault.read_bytes` 读取 Vault 内 PNG/JPEG/WebP/GIF，失败显示书籍占位及提示。V1 不自动下载远程封面。

可选 YAML frontmatter（无 frontmatter 默认 table；普通元数据允许共存）：

```yaml
view: table # table | list | board | gallery
group_by: 状态 # 按某个表头分组；默认按二级标题分组，无标题为未分组
lane_by: 项目 # 仅 board：纵向泳道字段；横向列仍为 group_by
```

一级标题为页面标题，缺省使用文件名；段落/引用作为说明显示。二级标题为分节，各节表格表头必须一致；多表合并为同一数据集，保留 section。表头必须非空且唯一，配置列必须存在，未知 view 或损坏表格/缺失主链接/不支持的结构整体回退，不能静默丢行。只有表头的空表格有效，显示空态。无需 `type: index`，文件名已表明格式。

## 四种布局

- table：原表多列、水平滚动、文件列醒目、保留全部字段。
- list：按所选列或二级标题分组，文件名称与元数据紧凑排列，组计数。
- board：分组值为横向看板列；可选 lane_by 为纵向泳道，交叉单元格显示卡片及数量。明确只读、不提供拖动。
- gallery：封面网格，书名及全部元数据可读，缺图与坏图有占位。窄屏自适应。

顶部为标题、数量、四种紧凑布局按钮、搜索和分组/泳道选择。所有交互具可访问名称、键盘焦点，浅色/深色使用项目 UI tokens。标准 select 使用原生弹层，不添加私有菜单样式。宿主文件视图使用现有 generic 图标（不新增宿主协议需求）。

## 模块契约

`plugins-src/index-viewer/src/lib/model.ts` 定义：

```ts
type IndexView = 'table' | 'list' | 'board' | 'gallery'
interface IndexLink { text: string; href: string; start: number; end: number }
interface IndexImage { alt: string; href: string }
interface IndexCell { text: string; links: IndexLink[]; images: IndexImage[] }
interface IndexRow { id: string; title: string; href: string; cells: IndexCell[]; section: string; cover?: IndexImage }
interface IndexDocument { uri: string; title: string; description: string[]; columns: string[]; rows: IndexRow[]; view: IndexView; groupBy: string; laneBy: string }
```

`groupBy`/`laneBy` 为列名或空串（空 groupBy 按 section，空 laneBy 单泳道）。`parseIndex(content, uri): IndexDocument | null` 纯解析；`onDocument(callback)` 验证父窗口来源并回 ready/fallback；`openLink(uri, href)` 通过宿主打开；`loadCover(uri, href): Promise<string>` 返回 Blob URL，由消费组件释放；`locale()` 返回宿主语言，主界面中英。

## 交付与验收

提供可直接打开的四份 `.index.md` 示例及其真实相对链接目标和本地封面；skill 位于仓库 `skills/file-index/`，可独立复制到 Agent skills 目录，含自包含格式参考、四种模板和四类 prompt。生成原则为先盘点真实文件、输出相对链接、未知字段留空，不虚构封面/状态、不改源文件。

测试覆盖格式与非法输入、路径边界、文档桥接与回退、四布局切换、列分组/二维泳道、搜索、封面失败和过期加载释放、示例全部可解析。运行插件 test/check/build、打包集成测试与生产 bundle 浏览器交互/视觉验收。
