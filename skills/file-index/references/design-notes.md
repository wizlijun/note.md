# 标题分类与行内字段：参考与取舍

参考日期：2026-09-10。本文区分各产品已有能力与 Index Viewer 自己定义的 Markdown 契约；它不承诺 Notion 数据库或 Obsidian 插件的完整兼容。

| 参考 | 已有规则 | Index Viewer 的选择 |
| --- | --- | --- |
| [Notion 编辑基础](https://www.notion.com/help/writing-and-editing-basics) | 标题、列表、页面链接是基本内容块；标题快捷方式覆盖 H1–H3。 | 使用标题组织分类，标题下每文件一行，保留直接阅读的结构。分类深度按 Markdown 扩至 H6。 |
| [Notion 数据库视图与分组](https://www.notion.com/help/views-filters-and-sorts) | 同一数据库可以用不同布局呈现，并按属性分组。 | 一份文件列表切换表格、列表、看板或封面布局，不为布局复制条目。 |
| [Notion 数据库属性](https://www.notion.com/help/database-properties) | 属性具有文本、选择、日期等类型。 | 采用具名属性组织信息；当前按文本显示和分组，不加入类型声明、状态编辑、公式或数据库同步。 |
| [Obsidian 基础格式](https://obsidian.md/help/syntax) | 支持 H1–H6 标题、列表及 Markdown 链接。 | 标题决定分类树，使用相对 Markdown 文件链接，列表缩进不决定分类，降低手工编辑对空格的依赖。 |
| [Obsidian 标签](https://obsidian.md/help/tags) | `#标签` 支持 `/` 嵌套；标签不含空格，不能只有数字，大小写不敏感。 | 采用行内标签及嵌套写法，作为可显示、搜索、分组的“标签”字段；不自动推断状态或改写标题树。 |
| [Obsidian Properties](https://obsidian.md/help/properties) | 原生 Properties 是文件顶部 YAML 中的结构化元数据。 | 顶部 YAML 只需保存页面布局配置；每个索引条目的字段留在该行内，避免误把页面属性当作条目属性。 |
| [Dataview 作者文档：添加元数据](https://blacksmithgu.github.io/obsidian-dataview/annotation/add-metadata/) | 社区 Dataview 支持 `[key:: value]` 行内字段及列表条目元数据。 | 借用方括号行内字段的外形，允许同一行写多个属性；不实现查询语言或完整数据类型语义。 |

## 最小书写单位

```markdown
## 工作
### 查看器
- [设计方案](./设计方案.md) [状态:: 进行中] [作者:: A B] #主题/设计 一句话说明
```

标题回答“放在哪个分类下”，主链接回答“哪个文件”，`[字段:: 值]` 表示具名信息，`#标签` 提供跨分类主题，剩余尾文保留为说明。每个文件一行，增减某行缩进不会把其属性移到其他文件。

这些来源并未共同定义一份索引交换格式。上述组合是本插件的设计：`[字段:: 值]` 来自社区 Dataview 惯例，并非 Obsidian 核心语法，也不是 Notion 的 Markdown 属性协议。普通 Markdown 编辑器仍能读到所有原始文本；Index Viewer 负责解释其中的索引含义。

## 兼容边界

- 使用标准 Markdown 相对链接，不解析 `[[WikiLinks]]`、`![[嵌入]]` 或 Notion `@页面` 提及，避免隐式文件名解析和平台专属标识。
- 标题支持 H2–H6 分类及跳级归属，但不让列表缩进承担分类层级；这是为了满足索引源码易改、不易错位的需求。
- 标签仅提供标签信息；状态、项目、作者等用明确字段。一个文件的多标签作为组合分组，不自动复制卡片。
- 字段值可以是 Markdown 文本、链接或图片，不运行 Dataview 表达式、公式或查询，也不推断日期、人员等复杂类型。
- 不兼容此前未发布原型的表格数据或多行子属性列表；避免把有歧义的旧行静默分到错误文件。具体校验与回退规则以 [格式说明](format.md) 为准。
