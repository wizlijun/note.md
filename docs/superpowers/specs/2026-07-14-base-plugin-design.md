# Base 插件设计(v1)

> 状态:已通过 brainstorm,待实现计划
> 日期:2026-07-14

## 1. 目标与语义

在目录下放一个 **Obsidian 兼容的 `.base` YAML 文件**,把该目录下的 md 元数据做结构化表格展示(类似 Obsidian Bases)。

- `.base` 定义 `views` / `filters` / `properties` / `order` / `sort` / `groupBy`。
- 双击 `.base` → 在一个 **tab** 里渲染表格:递归扫描 `.base` 所在目录的 `.md`,取每个文件的 frontmatter 字段与 `file.*` 属性,按 filter/sort/group 展示。
- **v1 只读**;点行(或行首文件名) → 当前 tab 打开对应 md。
- **未实现的字段(formulas / summaries / cards 等)原样保留**——v1 从不写回 `.base`,天然不丢;`source` 模式可直接看/改原始 YAML。

### 已确定的决策

| 维度 | 决策 |
|---|---|
| 文件格式 | 兼容 Obsidian `.base` YAML |
| 呈现方式 | 当作 tab 文件打开(datagrid 由自写 HTML 表格渲染) |
| v1 范围 | table 视图 + 列定义 + filters + sort/groupBy(**不含** formulas/summaries/cards) |
| 数据源范围 | `.base` 所在目录**递归**(非全 vault) |
| 可编辑性 | v1 **只读** |
| 行点击 | 当前 tab 打开该 md |
| 表格渲染 | 轻量自写 HTML 表格(revolist 留作日后虚拟滚动/内编辑) |

## 2. 与 Obsidian `.base` 的兼容对照

Obsidian 官方 schema 顶层键:`filters` / `formulas` / `properties` / `views` / `summaries`。

- v1 **实现**:`filters`(and/or/not + 子集函数/比较)、`properties`(displayName)、`views`(仅 `type: table`,含 `order` / `groupBy` / view 级 `filters`)。
- v1 **保留但不生效**:`formulas`、`summaries`、非 table 视图(cards/map)、view 级 `limit`(见下,可选实现)。
- 因为 v1 从不写回 `.base` 文件,这些字段不会丢失,Obsidian 打开同一 vault 仍能用。

## 3. 模块划分(纯逻辑 + 薄 UI,便于单测)

| 模块 | 职责 | 依赖 |
|---|---|---|
| `src/lib/fs.ts`(改) | 新增 `FileKind = 'base'`,扩展名 `base` → `{ kind: 'base' }` | — |
| `src/lib/tabs.svelte.ts`(改) | `openFile` 对 `.base` 读文本、`mode: 'rich'`(同 spreadsheet) | — |
| `src/components/EditorPane.svelte`(改) | `{:else if tab.kind === 'base' && tab.mode !== 'source'}` → `<BaseView>` | — |
| `src/lib/base/model.ts` | 类型:`BaseConfig` / `BaseView` / `BaseFilter` / `FileRecord` / `BaseRow` | — |
| `src/lib/base/parse.ts` | YAML 文本 → `BaseConfig`;容错,坏 YAML 返回带 `error` 的空配置 | `yaml` |
| `src/lib/base/filter.ts` | filter DSL 求值器:`and/or/not` + 函数 + 比较表达式,输入一行属性值 → bool | — |
| `src/lib/base/rows.ts` | 文件记录 → 行对象(解析 `note.*` / `file.*` 属性值);排序、分组 | `filter` |
| `src/lib/base/scan.svelte.ts` | 递归读目录、逐文件解析 frontmatter(`yaml`)、取 `stat`,产出 `FileRecord[]` | tauri fs, `yaml` |
| `src/components/BaseView.svelte` | 薄壳:scan + parse + rows,渲染表格、视图切换、行点击、错误/空/加载态 | 上述 |
| `src/lib/i18n/{en,zh,ja,de}.ts`(改) | `base.*` 文案(视图选择、空态、解析错误) | — |

设计原则:扫描/求值/解析是纯函数(可单测),Svelte 组件只做编排与渲染。

## 4. 数据模型(`model.ts`)

```ts
type BaseSort = { property: string; direction: 'ASC' | 'DESC' }

interface BaseView {
  type: string            // v1 只渲染 'table'
  name: string
  order?: string[]        // 列的左右顺序,属性 id
  groupBy?: BaseSort
  filters?: BaseFilter    // view 级,和全局 filters 取 AND
  limit?: number
}

interface BaseConfig {
  filters?: BaseFilter                       // 全局
  properties?: Record<string, { displayName?: string }>
  views: BaseView[]
  error?: string                             // 解析失败时的信息
  raw?: unknown                              // 保留原始对象(未来写回用)
}

type BaseFilter =
  | { and: BaseFilter[] }
  | { or: BaseFilter[] }
  | { not: BaseFilter[] }
  | string                                   // 叶子:比较表达式或函数调用

interface FileRecord {
  path: string
  name: string            // 含扩展名
  folder: string          // 父目录
  ext: string
  mtime: number
  ctime: number
  size: number
  tags: string[]          // v1:仅 frontmatter tags
  frontmatter: Record<string, unknown>
}

interface BaseRow {
  record: FileRecord
  cells: Record<string, unknown>   // 属性 id → 解析后的值(用于显示/排序)
}
```

## 5. Filter DSL 支持子集(v1)

求值器实现一个**有界子集**,覆盖最常用的:

- **逻辑**:`and` / `or` / `not`(结构化嵌套对象)。
- **函数**:`file.inFolder("x")`、`file.hasTag("x")`、`file.hasLink("x")`、`file.ext == "md"`;`taggedWith(...)` 等按需扩展。
- **比较表达式**(字符串叶子):`prop == "v"` / `!=` / `>` / `<` / `>=` / `<=`;
  - 左侧:`file.*`、`note.field` 或裸 `field`(= `note.field`);
  - 右侧:字面量(带引号字符串 / 数字 / `true|false`)。
- **无法解析的叶子** → 该行**不被过滤掉**(fail-open),console 记一条警告。目的:坏表达式不清空整表。
- `formula.*` 引用:v1 当空值(不报错)。

求值输入是一行的 `FileRecord`(可直接取 `file.*` 与 frontmatter),输出 bool。全局 filters 与当前 view 的 filters 取 AND。

## 6. 属性解析(`rows.ts`)

`file.*` 属性:

| 属性 | 值 |
|---|---|
| `file.name` | 文件名(含扩展名) |
| `file.path` | 完整路径 |
| `file.folder` | 父目录 |
| `file.ext` | 扩展名(不含点) |
| `file.mtime` | 最后修改(ms) |
| `file.ctime` | 创建(ms) |
| `file.size` | 字节 |
| `file.tags` | frontmatter `tags`(v1 不含正文 `#tag`) |

`note.<field>` / 裸 `<field>` → frontmatter 该键值(经 `yaml` 解析后的原生类型:string/number/bool/array/object)。

列显示名:`properties.<id>.displayName`,缺省用属性 id。数组值以 `, ` 连接显示;对象值 `JSON.stringify` 显示。

## 7. 排序 / 分组

- **`groupBy`(来自 .base)**:按属性值分组,渲染分组小标题行 + 组内计数;组顺序按 `direction`。
- **列头点击排序**:点表头切 asc/desc(客户端),覆盖默认顺序。默认(无点击)按文件出现顺序或 groupBy 内的自然序。
- 比较规则:数字/时间按数值比较;数组按首元素;其它按 `localeCompare`(base sensitivity)。

## 8. 渲染(`BaseView.svelte`,轻量 HTML 表格)

- `<table>` sticky 表头;首列文件名可点击(`openFile`),整行点击也打开。
- **多视图**:顶部下拉切换 `views`;v1 只渲染 `type: table` 的视图,非 table 视图在下拉里灰显/跳过。
- **状态**:加载中(扫描目录)、空态(无匹配文件)、解析错误态(显示 `config.error`,并提示切 source 模式查看原始 YAML)。
- 主题跟随现有 CSS 变量,不引第三方样式。
- 文件系统变化时重扫(复用 folder-view 的 `watchImmediate` 思路,可选;v1 可先做打开时扫描 + 手动刷新,监听留待需要)。

## 9. 插件开关与集成

- 走现有 `plugins.enabled` 机制,`PLUGIN_ID = 'base'`,默认**开**(与 folder-view 一致)。
- 插件关闭时:`.base` 回退成普通文本(source)打开(`classifyPath` 仍认得,但 EditorPane 分支不走 BaseView)。
- `.base` 文件在 folder-view 里因 `classifyPath` 命中而正常显示、可点开。
- `source` 模式(顶栏切换)始终可看/改原始 YAML,作为逃生舱。

## 10. 测试(vitest,纯逻辑优先)

- `parse.test.ts`:合法 / 残缺 / 空 YAML;views / order / groupBy / properties 提取;坏 YAML → `error` 非空。
- `filter.test.ts`:and/or/not 嵌套;`==` `!=` `>` `<` `>=` `<=`;各 `file.*` 函数;裸键=note.;坏表达式 fail-open;formula 引用当空。
- `rows.test.ts`:属性解析(note./file./裸键)、类型显示、排序(数字/时间/字符串)、groupBy 分组结果与计数。
- `scan.svelte.ts` 与 `BaseView.svelte`:走轻量测试或**手动 GUI 验证**(按用户约定:我只起 dev 构建 + 给手动测试步骤,不做 UI 自动化)。

## 11. v1 替用户定的默认(可改)

1. 正文 `#tag` **不纳入** `file.tags`,只取 frontmatter `tags`。
2. **列头点击排序保留**(即便 .base 没写 sort),只读表格需要它。
3. 插件**默认开启**。
4. 文件监听 v1 **先不做**(打开时扫描 + 手动刷新),按需再加。

## 12. 明确不做(v1 out of scope)

- `formulas` 计算列、`summaries` 列尾聚合。
- `cards` / `map` 视图。
- 单元格内编辑回写 frontmatter。
- 正文 `#tag` 采集。
- 跨全 vault 扫描 / 复杂 `limit` 分页(可选简单实现)。
