# Roam Research 导入插件(一期)设计

日期:2026-07-11 · 状态:已批准(v2:改为独立插件 + 独立导入窗口)

## 背景与调研结论

Roam Research 提供 EDN / JSON / Markdown 三种导出。完整度 EDN > JSON > Markdown:

- **EDN**:Datomic 原生 dump,最完整(含视图类型、版本历史),但为单行 Clojure EDN,解析负担重,多出的信息对本功能无用。
- **JSON**(选定):页面数组,页含 `title / children / create-time / edit-time`;block 含 `uid / string / children / heading / text-align / create-time / edit-time`,递归嵌套。仅丢"View as Document"视图设置与版本历史。
- **Markdown**:块引用/embed 只剩裸 uid 不可解析,同名页互相覆盖,弃用。

增量途径:官方 Backend API(Datalog,按 edit-time 拉增量,需付费 token)留作后续期;一期采用**全量 JSON + uid 幂等 diff**,用户重新导出 zip 即可增量重导。

## 范围

- 一期:以**独立插件**形态导入 Roam 全量 JSON(zip 或 .json)→ vault 内 daily notes + wiki pages(`.note.md` 大纲文件);支持增量重导。
- 使用模式:一次性迁移为主 + 偶尔重导。
- 非目标(后续期):附件本地化下载(一期保留 Firebase 远程 URL)、Backend API 持续同步、EDN 解析。

## 插件形态

仿照 `outline-notes` / `openclaw-chat` 的 **`kind: "builtin"` 插件**模式,游离于主程序之外:

- `src-tauri/plugins/roam-import/manifest.json`:`default_enabled: false`(**默认关闭**),name/description/menus 含 en/zh/ja i18n。
- 菜单声明:`{ location: 'file', label: 'Import from Roam Research…', command: 'open' }`。用户在 设置 → 插件 开启后 File 菜单才出现该项(宿主 `set_plugin_menu_item_enabled` 机制已有);关闭插件即菜单消失,主程序无残留入口。
- 不采用外部二进制插件:现有插件协议为一次性请求/响应(默认 30s 超时),无流式进度与自定义 UI 通道;builtin + 独立窗口是仓库现成模式,同样满足隔离要求。

## 独立导入窗口

仿照 `chat.html` / `insights.html` 的独立 Tauri 窗口:

- 新增 vite 多入口 `roam-import.html` + `src/roam-import/` 窗口应用(Svelte);App.svelte 的 builtin 菜单分发处按 `pluginId === 'roam-import'` 打开窗口。
- 转换核心 `src/lib/roam-import/` 仅被该窗口入口引用,**不进主窗口 bundle**。
- 窗口布局:
  - **选择文件区**:选 Roam 导出 zip 或 .json;zip 用 fflate 前端解包(新增小依赖,仅打进本窗口)。
  - **进度区**:分阶段(解析 → 计划 → 写入),进度条 + 总页数/已转换/当前页面名。
  - **错误日志区(醒目)**:红色高亮面板实时追加,每条含页面名 + 原因(解析失败/写入失败/属性撞名转义/标题碰撞改名/冲突跳过);有错误时摘要横幅警示,无错误时绿色完成态;支持一键复制全部日志。
  - **结果摘要**:N wiki pages、M daily notes、跳过/失败清单。
- 独立窗口惯例:自声明 `color-scheme: light dark`。

## 架构

转换核心 `src/lib/roam-import/`,纯函数(vitest 全覆盖),IO 薄层不测(仓库惯例):

| 文件 | 职责 |
|---|---|
| `parse.ts` | Roam JSON → 内部模型:页面数组 + uid 全局索引 + 被 `((ref))` 引用的 uid 集合 |
| `syntax.ts` | 字符串级语法转换(见下表) |
| `convert.ts` | RoamPage → 现有 `OutlineTree`(复用 `outline/model.ts`),经 `serializeOutline` 落盘,不另造序列化器 |
| `plan.ts` | 结合清单计算导入计划:新建 / 覆盖 / 冲突跳过 / 改名重链 |
| `io.ts` | Tauri 写文件、zip 解包、清单读写 |
| `src/roam-import/` | 独立窗口应用:文件选择、进度、错误日志、摘要(驱动上述纯函数 + io) |

## 页面归类与命名

- 日记页判定:**uid 形如 `MM-DD-YYYY`**(不解析英文标题)→ `dailynote/{yyyy}/yyyy-MM-dd.note.md`,front-matter title = 日期字符串(与 `outline/daily.ts` 约定一致)。
- 其余页面 → `wikipage/{title}.note.md`,标题经 `slug.ts` 的 `sanitizeFileName`。
- 文件名碰撞(含大小写不敏感碰撞):后缀 ` (2)` 去重,并**改写全图指向该页的 `[[link]]`** —— wikilink 只按文件名解析是硬原则(file-over-app)。

## 语法映射

| Roam | 转换后 | 说明 |
|---|---|---|
| block 层级 | outline 缩进节点 | 直接对应 |
| `uid` | `id:: uid` | 仅对被 `((ref))` 引用的 block 写(serializer persistIds 已支持) |
| `((uid))` | 原样保留 | 与本地块引用语法一致 |
| `{{embed: ((uid))}}` / `{{[[embed]]: ((uid))}}` | 降级为 `((uid))` | |
| `create/edit-time`(ms) | `created:: / updated::` | 转为现有时间格式 |
| `{{[[TODO]]}}` / `{{[[DONE]]}}` | `[ ]` / `[x]` | |
| `__斜体__` | `*斜体*` | |
| `**粗体**` `^^高亮^^` `~~删除~~` `[[链接]]` | 原样 | 语法一致 |
| `#[[多词标签]]` | `[[多词标签]]` | 并入 wikilink 图 |
| `#tag` | 原样 | 保持 Obsidian 标签语义 |
| `heading: 1-3` | 内容前缀 `#`/`##`/`###` | |
| `属性:: 值` | 原样;与保留属性 `type/line/id/collapsed/created/updated` 撞名的行需转义(前置空格或改写) | 防止被 `parseOutline` 当属性行吃掉 |
| 代码块 / 图片与附件 URL | 原样 | 多行内容 serializer 已支持;附件二期本地化 |

## 增量重导与冲突

清单文件 `vault/.notemd/roam-import.json`:

```json
{ "graphName": "...", "importedAt": "...",
  "pages": { "<uid或title>": { "file": "...", "editTime": 0, "contentHash": "..." } } }
```

重导规则:

- 新页面 → 写入;`edit-time` 未变 → 跳过。
- `edit-time` 变化且本地文件 hash 与清单一致 → 覆盖。
- 本地被用户改过(hash 不符)→ 默认跳过并列入报告,报告中可勾选强制覆盖。

## i18n

插件 name/description/菜单走 manifest 内嵌 i18n(插件体系惯例);导入窗口内文案走自研 i18n(扁平点分键),en/zh/ja 三语言齐全。

## 错误处理

- JSON 解析失败 / zip 内找不到 .json → 错误日志区醒目报错,不写任何文件。
- 单页转换异常不中断整体:该页记入错误日志区,继续后续页面。
- 写盘前先算完整导入计划,冲突全部前置判定,不做半途覆盖。
- vault 未配置时窗口给出引导提示,禁用导入按钮。

## 测试

- fixture:手工构造的小型 Roam JSON,覆盖:日记页 uid、深嵌套、跨页块引用、embed、TODO/DONE、属性撞名、标题大小写碰撞、多行代码块。
- `parse / syntax / convert / plan` 纯函数 vitest 全覆盖;`io.ts` 与窗口/菜单入口不做单测。
- 插件开关 → 菜单出现/消失、导入窗口全流程(进度、错误日志、摘要)按仓库惯例 dev 实机验证(注意并行会话桌面争用与深浅色)。
