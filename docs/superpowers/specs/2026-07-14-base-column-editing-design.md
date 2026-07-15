# Base 列定义编辑设计 (v1.1)

> 状态:已通过 brainstorm,待实现计划
> 日期:2026-07-14
> 前置:`2026-07-14-base-plugin-design.md`(只读 v1);本轮把只读表格升级为可编辑列定义。

## 1. 目标

在 base 表格里直接编辑 `.base` 的列定义并写回文件:增/删列、重命名列、调列顺序、UI 设置 groupBy 与默认排序。写回后 Obsidian 打开同一 vault 仍可用。

### 已确定的决策

| 维度 | 决策 |
|---|---|
| 编辑操作 | 增/删列、重命名(displayName)、调序(拖拽+菜单)、设 groupBy、设默认排序 |
| 写回路径 | 走普通 tab 保存流:序列化 YAML → `setContent(tab.id, yaml)` → 脏点 → 自动保存/Cmd-S 落盘 |
| 交互入口 | 列头内联 ⋯ 菜单 + 表头末尾 "+" 加列 + 拖拽表头重排 |
| 未支持字段 | 始终在 `config.raw` 上改再整体 `yaml.stringify`,formulas/summaries/cards 等原样保留 |
| filters 可视化编辑 | 本轮**不做**(仍可 source 模式改 YAML) |

## 2. 核心数据流

```
用户在表头操作
  → base/edit.ts 纯函数:在 config.raw(完整解析对象)上施加操作 → 新 raw 对象
  → toYaml(newRaw) 序列化
  → parseBase(yaml) 自检:解析异常则中止(toast 报错,不写)
  → setContent(tab.id, yaml)  // currentContent 变 → 脏 → 现有保存流落盘
  → config = $derived(parseBase(tab.currentContent)) 自动重渲染表格
```

始终在 `raw` 上改再整体序列化,所以我们不认识的字段(formulas / summaries / 非 table 视图)不会丢。
**已知代价**:`yaml.parse → stringify` 会丢掉原文件里的 YAML 注释。Obsidian 自身重写 `.base` 也如此,可接受。

## 3. 模块划分

| 模块 | 职责 | 动作 |
|---|---|---|
| `src/lib/base/edit.ts` | 纯函数编辑器 + 序列化(见 §4) | 建 |
| `src/lib/base/edit.test.ts` | 纯单测 | 建 |
| `src/lib/base/model.ts` | `BaseView` 增 `sort?: BaseSort[]` | 改 |
| `src/lib/base/parse.ts` | 解析 `view.sort` | 改 |
| `src/lib/base/rows.ts` | 应用 `view.sort`(多键,复用 sortRows) | 改 |
| `src/components/BaseColumnMenu.svelte` | 单列 ⋯ 菜单 | 建 |
| `src/components/BaseAddColumnMenu.svelte` | "+" 属性选择器 | 建 |
| `src/components/BaseView.svelte` | 编排:表头交互、拖拽、派发操作、setContent | 改 |
| `src/lib/i18n/{en,zh,ja,de}.ts` | `base.*` 菜单/占位文案 | 改 |

设计原则:所有编辑逻辑与序列化是纯函数(可单测);Svelte 组件只做交互与派发。BaseView 会变大,故把列菜单与加列选择器拆成独立小组件。

## 4. `base/edit.ts` 接口(纯函数)

所有操作输入 `raw: unknown`(parseBase 得到的完整对象),返回**新** raw 对象(不原地改)。`viewIndex` 指定目标视图。

```ts
type Raw = Record<string, unknown>

// 若 views[i].order 缺省,用 currentColumns 物化成显式 order 后再改
function addColumn(raw: Raw, viewIndex: number, prop: string, currentColumns: string[]): Raw
function removeColumn(raw: Raw, viewIndex: number, prop: string, currentColumns: string[]): Raw
function moveColumn(raw: Raw, viewIndex: number, prop: string, toIndex: number, currentColumns: string[]): Raw
// 全局 properties[prop].displayName;name 为空串 → 删除该 displayName(properties 项若空则删)
function renameColumn(raw: Raw, prop: string, name: string): Raw
// prop=null → 删除 groupBy
function setGroupBy(raw: Raw, viewIndex: number, prop: string | null, direction: SortDirection): Raw
// prop=null → 删除 sort;否则写 views[i].sort = [{property, direction}]
function setSort(raw: Raw, viewIndex: number, prop: string | null, direction: SortDirection): Raw

function toYaml(raw: Raw): string   // yaml.stringify 封装
```

实现要点:
- 深拷贝目标路径(结构化 clone 或逐层浅拷贝)避免污染 `config.raw`(它绑在 `$derived` 上)。
- `views` 缺省时补 `[{type:'table',name:'Table'}]` 再定位 viewIndex。
- `properties` 缺省时按需创建。

## 5. 编辑操作语义

- **加列**:`views[i].order` 追加 `prop`;order 缺省先物化。
- **删列**:从 order 移除 `prop`;若删空则保留空数组(仍显式)。
- **调序**:拖拽表头 / 菜单左移右移 → `moveColumn(prop, toIndex)`。
- **重命名**:写 `properties[prop].displayName`;清空→删。
- **groupBy**:菜单"设为分组 ↑/↓"→ `views[i].groupBy={property,direction}`;"取消分组"→删。
- **默认排序**:菜单"默认升序/降序"→ `views[i].sort=[{property,direction}]`;"清除默认排序"→删。

## 6. 排序两条路(消歧义)

- **点列头** = 会话内临时排序(现有 `clickSort`,不写盘)。
- **菜单默认升/降序** = 持久化到 `view.sort`(写盘)。

渲染排序优先级:`clickSort ?? view.sort?.[0] ?? view.groupBy`。
`view.sort` 是列表(Obsidian 格式),v1.1 只写单键、渲染取首键;多键读入也不报错。

## 7. 属性选择器(BaseAddColumnMenu)

可选属性 = 扫描到的所有文件 frontmatter 键并集 ∪ `file.{name,path,folder,ext,mtime,ctime,size,tags}`,减去当前 view 已有列。点选即 `addColumn`。frontmatter 键以 `note.<key>` 形式加入。

## 8. UI 细节

- 每个 `<th>`:hover 显示 ⋯ 按钮;点开 `BaseColumnMenu`(绝对定位,跟随 FolderView 的 ctx 菜单模式)。菜单项:重命名(内联 `<input>`,回车提交)、设默认升序、设默认降序、清除默认排序、设为分组升序/降序、取消分组、左移、右移、删除列。
- 表头末尾一个 "+" → `BaseAddColumnMenu`。
- `<th>` `draggable`:dragstart 记源列,dragover 允许,drop 计算目标 index → moveColumn。
- 主题跟随 Canvas/CanvasText(与已修的 BaseView 一致)。

## 9. 错误 / 边界

- `config.error`(YAML 坏)时:禁用全部编辑控件(⋯、+、拖拽),提示切 source。
- 每次编辑:`toYaml` 后先 `parseBase` 自检;解析异常 → 不 `setContent`,toast 报错(避免写坏文件)。
- 写回只改内存 tab 文本;落盘、外部变更检测、hash 复用现有 tab 保存机制,本组件不直接碰盘。
- viewIndex 越界由 edit.ts 兜底(clamp / 补 views)。

## 10. 测试

- `edit.test.ts`:
  - 每操作正确性(add/remove/move/rename/setGroupBy/setSort)。
  - 空 order **物化**成显式 order。
  - **未支持字段往返保留**:含 `formulas`、`summaries`、第二个 `type: cards` view 的 raw,经任一操作 + toYaml + parseBase 后这些字段仍在。
  - renameColumn 空串即删;properties 项空则删。
  - moveColumn 边界(移到首/尾、同位)。
  - toYaml→parseBase 往返稳定。
- `parse.test.ts` / `rows.test.ts`:补 `view.sort` 解析与应用用例。
- `BaseColumnMenu` / `BaseAddColumnMenu` / 拖拽:手动 GUI 验证(隔离 worktree)。

## 11. 明确不做(本轮 out of scope)

- filters 的可视化编辑(仍 source 改)。
- formulas / summaries 编辑、cards 视图渲染。
- 单元格值编辑(改 frontmatter)——仍是只读单元格,本轮只编辑**列定义**。
- 多键排序 UI(数据结构支持读,UI 只设单键)。
- 保留 YAML 注释。
