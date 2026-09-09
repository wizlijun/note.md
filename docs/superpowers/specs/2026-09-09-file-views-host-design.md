# 文件规则视图：宿主能力

## 目标

宿主提供声明式文件选择、只读插件视图及内置编辑器回退。Timeline 是第一个正式接入者；规则引擎和生命周期不得引用 Timeline、diary 或特定 frontmatter key。第一版覆盖 Markdown、MDX、HTML、普通代码/未知扩展名文本、CSV 和 Base。图片、Canvas、受管 USER/MEMORY、legacy custom editor 保持其已有文档能力。

## 正式声明

`contributes.file_views` 是带 Rust 类型和 JSON Schema 的正式 manifest 字段，要求提供 `ui`。每个插件最多 32 个视图，ID 在插件内唯一。

```json
{
  "file_views": [{
    "id": "timeline",
    "entry": "index.html",
    "priority": 100,
    "selectors": [{
      "file_extensions": ["md", "markdown", "mdown", "mkd"],
      "frontmatter": { "type": ["timeline"] }
    }]
  }]
}
```

selector 可含 `file_extensions`、`file_name_patterns`、`path_patterns`、`frontmatter`。多个 selector 为 OR，单个 selector 内字段为 AND，单个条件的候选数组为 OR，frontmatter 的不同属性为 AND。空 selector、空数组、空属性集合、null、未知字段均无效，不解释为匹配全部。

- 扩展名忽略大小写，去掉前导点；只匹配最后一个扩展名。复合后缀通过文件名规则表达。
- 文件名和路径采用大小写敏感的 `*`、`?`、`**`；`*`、`?` 不跨 `/`，`**` 可跨层，完整 `**/` 段可匹配零层目录。其他字符是普通字面量，不执行正则、函数、脚本或表达式。
- `path_patterns` 匹配正斜线归一化后的完整绝对路径，例如 `**/diary/*.md`；无绝对路径的草稿仅不能命中路径条件。声明中的路径 pattern 不接受反斜线。
- frontmatter 只读取开头 YAML 中的顶层 string、number、boolean 标量；无效/重复 key 的 YAML 不匹配。字符串去首尾 Unicode White_Space 并忽略大小写，数字/布尔保持类型。其他属性、正文与嵌套数据不参与条件。
- `priority` 是 -1000 到 1000 的整数，默认 0，较大者优先；同分按 plugin ID、view ID 字典序选择，安装扫描顺序不影响结果。被选视图拒绝文档或加载失败时回内置视图，不继续将文件交给其他插件。

声明数量、候选数各限制 32，pattern/字符串值 256 个 Unicode 字符，ID/key 128 个字符。入口是安全的相对 `.html` 路径。运行时匹配路径最多 16384 字符，frontmatter 解析只扫描文档前 128 Ki UTF-16 字符；glob 使用有界动态规划，避免正则回溯阻塞界面。Rust 安装期校验与前端运行时校验共用 golden vectors 验证。

## 宿主生命周期

`FilePluginView` 只负责读取当前内存快照、嵌入视图、更新及回退；文件读取、dirty、保存、外部变更监测与原始 `tab.kind` 均由宿主保留。`EditorPane` 的原有内置分支成为同一个 fallback snippet：CSV 回 CSV、HTML 回 HTML、MDX 回只读阅读、代码回代码、Markdown 回原编辑器。源码模式始终优先。

正式消息通道：

```ts
// parent → plugin
{ type: 'file_view.open', viewId: string, uri: string, content: string, requestId: number }
// plugin → parent
{ type: 'file_view.ready', requestId: number }
{ type: 'file_view.fallback', requestId: number, reason?: 'edit' }
```

双向消息限定 parent/iframe source 和已知 origin，宿主还验证当前 requestId。只读通道不接受任何 `change`。加载或更新时隐藏旧内容，8 秒没有当前快照 ready 即回退；错误、解析拒绝和用户“编辑”可立即回退。进入编辑后不因每次输入重新切换，用户明确返回视图或外部重载才重试。沙箱允许脚本、同源与表单事件，原生插件 CSP `form-action 'none'` 继续禁止表单导航；设置仅使用受权限限制的 `host.settings` RPC。

## 兼容与发布

已发布 `custom_editors.file_extensions` 及其 `custom_editor.*` 可写编辑器协议保持不变。上一轮仅 Git 推送、从未公开发布的 `markdown_types` 和 Markdown 专用视图通道整体替换为正式 `file_views`，不保留两套规则。

宿主发布 `6.909.1`，Timeline 首次上架 `1.0.0`，要求 `>=6.909.1`，归现有“回顾”类别。先发布并回读宿主签名、公证、更新资产，再上传签名插件包、验证后追加市场索引；历史条目不改写。不自动安装用户本机插件。

## 验收

- 共享声明合法性向量覆盖 Rust/TS；单独测试 glob、字段 AND/OR、元数据类型、优先级、未知/空规则、路径平台差异。
- 合成 JSON/CSV/HTML 等非 Timeline 接入和原内置回退、受保护文档、旧扩展名编辑器。
- 全部 diary 样本覆盖，Timeline 分类设置与失败重试、不同快照消息、外部更新、源码和插件停用。
- 跨 origin Chromium、隔离 nonPersistent WKWebView 验证真实生产插件 bundle 的握手和表单保存。
- 发布脚本要求的全套前端/协议/原生检查；macOS 双架构 App/DMG 公证签名与公网回读；插件公开索引/包/签名/当前宿主选择器一致。
