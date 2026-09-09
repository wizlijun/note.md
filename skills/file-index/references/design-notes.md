# 标题分类与行内字段：参考与取舍

参考日期：2026-09-10。本文区分各产品已有能力与 Index Viewer 自己定义的 Markdown 契约；它不承诺 Notion 数据库或 Obsidian 插件的完整兼容。

| 参考 | 已有规则 | Index Viewer 的选择 |
| --- | --- | --- |
| [Notion 编辑基础](https://www.notion.com/help/writing-and-editing-basics) | 标题、列表、页面链接是基本内容块；标题快捷方式覆盖 H1–H3。 | 使用标题组织分类，标题下每文件一行，保留直接阅读的结构。分类深度按 Markdown 扩至 H6。 |
| [Notion 数据库视图与分组](https://www.notion.com/help/views-filters-and-sorts) | 同一数据库可以用不同布局呈现，并按属性分组。 | 一份文件列表切换表格、列表、看板或封面布局，不为布局复制条目。 |
| [Notion 数据库属性](https://www.notion.com/help/database-properties) | 属性具有文本、选择、日期等类型。 | 采用具名属性组织信息；当前按文本显示和分组，不加入类型声明、状态编辑、公式或数据库同步。 |
| [Obsidian 基础格式](https://obsidian.md/help/syntax) | 支持 H1–H6 标题、列表及 Markdown 链接。 | 标题决定分类树，支持相对 Markdown 文件链接和简单 WikiLinks，列表缩进不决定分类，降低手工编辑对空格的依赖。 |
| [Obsidian 标签](https://obsidian.md/help/tags) | `#标签` 支持 `/` 嵌套；标签不含空格，不能只有数字，大小写不敏感。 | 保留标签的显示、搜索、分组能力；按用户要求，点击标签改为与同名 WikiLink 一样打开知识页面，复用 note.md 的页面导航规则。 |
| [Obsidian 内部链接](https://help.obsidian.md/links) | 支持 WikiLinks、Markdown 链接及链接显示文字。 | 支持 `[[页面]]` 和 `[[页面|显示名]]`，也允许作为索引主项；采用 note.md 的全局页面索引与缺页创建规则。 |
| [Obsidian Properties](https://obsidian.md/help/properties) | 原生 Properties 是文件顶部 YAML 中的结构化元数据。 | 顶部 YAML 只需保存页面布局配置；每个索引条目的字段留在该行内，避免误把页面属性当作条目属性。 |
| [Dataview 作者文档：添加元数据](https://blacksmithgu.github.io/obsidian-dataview/annotation/add-metadata/) | 社区 Dataview 支持 `[key:: value]` 行内字段及列表条目元数据。 | 借用方括号行内字段的外形，允许同一行写多个属性；不实现查询语言或完整数据类型语义。 |

## 最小书写单位

```markdown
## 工作
### 查看器
- [设计方案](./设计方案.md) [状态:: 进行中] [作者:: A B] #主题/设计 一句话说明
```

标题回答“放在哪个分类下”，主链接回答“哪个文件”，`[字段:: 值]` 表示具名信息，`#标签` 提供跨分类主题与知识页面导航，剩余尾文保留为说明。每个文件一行，增减某行缩进不会把其属性移到其他文件。

这些来源并未共同定义一份索引交换格式。上述组合是本插件的设计：`[字段:: 值]` 来自社区 Dataview 惯例，并非 Obsidian 核心语法，也不是 Notion 的 Markdown 属性协议。普通 Markdown 编辑器仍能读到所有原始文本；Index Viewer 负责解释其中的索引含义。

## 兼容边界

- 标准 Markdown 链接按索引所在目录解析；`#标签` 和 `[[页面]]` 按宿主全局页面索引解析，名称相同就走相同打开规则。别名只影响显示，`#主题/设计` 不是相对目录路径，文件名处理交给宿主。支持 `#[[多词标签]]`。
- Obsidian 原生标签的点击通常用于查找带标签的笔记。本产品按用户要求，将标签点击等同于 WikiLink 页面导航；这是 note.md 的产品约定，并非声称 Obsidian 也将标签作为页面。标签仍可搜索和分组。
- 标签与 WikiLinks 都参与宿主反向链接；索引来源条目以只读摘要展示，编辑时返回索引文件。
- 加载索引不创建文件；用户点击尚不存在的标签或 WikiLink 时，宿主按配置的 Wiki / Daily Note 规则创建目标。查看器不改写索引或既有源文件，生成 skill 也不会提前为链接建页。
- 仅采用简单页面名与别名，不实现 WikiLink 标题片段定位、嵌套链接、`![[嵌入]]` 或 Notion `@页面` 提及。
- 标题支持 H2–H6 分类及跳级归属，但不让列表缩进承担分类层级；这是为了满足索引源码易改、不易错位的需求。
- 标签提供页面导航与标签信息；状态、项目、作者等用明确字段。一个文件的多标签作为组合分组，不自动复制卡片。
- 字段值可以是 Markdown 文本、链接或图片，不运行 Dataview 表达式、公式或查询，也不推断日期、人员等复杂类型。
- 不兼容此前未发布原型的表格数据或多行子属性列表；避免把有歧义的旧行静默分到错误文件。具体校验与回退规则以 [格式说明](format.md) 为准。
