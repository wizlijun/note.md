# 项目协作编辑器源码保真门槛（E1 实测与 E4 代码核对）

日期：2026-10-13。检查时 HEAD：`b824c173ee61d9523a47bedbbf96d438e1d34cbc`。源码指纹见 `e1-scratch/source-hashes.json`。依据：[已批准 spec](../specs/2026-10-12-project-share-review-merge-design.md) §12.2–12.4、§21；既有 `browser-editor-research.md`。

## 裁定

**不能直接按“现有 Kit v2 + 块原文/间隔适配 + 现有 serializeSpan”连续完成 E1。按 §21，E1 的硬门槛当前不通过，应回报人决定；P2 协议、Worker、基础浏览器不受这项结论阻塞。**

不是因为裸 parse→serialize 有格式差异，也不是因为表格/列表原子 hunk 过大。本次用真实 Chromium 挂载当前 Kit v2，原文回退已真实运行。一个普通段落只改一个汉字时，**未改的另一句中的 `_斜体_` 和尖括号链接被改写，propose 得到 2 个 hunk**；这直接违反 §12.4 的“恰好 1 个 hunk，且只覆盖该句”。保留块原文及 prefix/gaps/suffix 的原定适配器不能修复触碰块内部的这类漂移。

需要增加**携带原始源码信息的局部序列化能力**。无法据此断言必须先重写整个 `@moraya/core`：可在共享 Kit 的 `serializeSpan` 路径实现，也可以让 Moraya parser/serializer 提供原文映射。现有 `serializeSpan(doc, span)` 只接收当前 PM 文档与顶层节点区间，能力不够。仅新增块导出 API 或仅保存块间空白，不足以满足判据。

## 真实验证与可复现材料

未修改产品、依赖、共享 tasks 或现行 spec，未提交、未发布、未读取 `.env`。全部新文件在本计划 scratch/报告目录。Vite 使用 `configFile:false`、scratch 空 `envDir`、scratch `cacheDir`，绑定 `127.0.0.1` 的临时端口。只 stub 现有 Kit 必需的 theme/vault bridge；编辑器、PM、序列化器与 propose 都是真实实现，没有 mock mountRich。

环境：Node `v23.10.0`，既有 Playwright `1.55.0`，Chromium `140.0.7339.16`。先发现的另一版 Playwright 缺少匹配浏览器，随后复用现有 1.55 安装；未下载浏览器或安装包。命令：

```sh
cd /Users/bruce/git/mdeditor
PLAYWRIGHT_MODULE=/Users/bruce/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs \
  node .superpowers/sdd/2026-10-13-project-share-review-merge-p2/e1-scratch/check.mjs
```

材料：

- `e1-scratch/check.mjs`：完整 fixture、语料、真实 DOM 选区与 `page.keyboard.insertText('乙')`；收集 Kit 的真实 `block.replace` 和 `getDraftMarkdown()`；直接调用当前 `propose`。
- `e1-scratch/raw-results.json`：18 个样本全部输入/输出、18 次真实编辑、操作批次、完整 proposal；`pageErrors: []`。
- `e1-scratch/run.log`：摘要原始 stdout。
- `e1-scratch/parser-source-identity.json`：只用于解释根因的 AST 比较，不作为整体 Kit 失败证据。
- `e1-scratch/source-hashes.json`：检查时关键源文件及实际 Moraya dist 的 SHA-256。

语料包含 spec 的 13 类，CriticMarkup 两种形式分列为两例，共 14 个基础案例，另有 4 个定向诊断案例。所有输入是有效 Unicode；未进行任何 trim/换行归一/Unicode 归一，字符串严格相等在这些样例上等价于 UTF-8 字节相等。

**验证范围限制**：当前 Kit v2 没有 Rich↔Source 公共接口，E1 wrapper 尚不存在。“三次切换”实测是 scratch 将真实 Kit 的 `getDraftMarkdown()` 交给真实 `mountSource().getValue()`，再重新挂载 Kit，重复三次；是既有组件直接组装路径的实证，不冒充未来完整 E1 UI 的验收。自然分块在 fixture 中显式给定原文切片与分隔符，未实现通用原文分块器，也没有验证 Source 编辑后的局部重解析、插入/删除/重排/撤销等完整适配。

## 必须分开的结果

### 1. 当前 Kit 的未改块回退确实有效

完整原文放进单个 `EditorSnapshot` 块，无修改调用 `getDraftMarkdown()`，**18/18 逐字相同**。涵盖 CRLF、BOM、对齐表格、混用嵌套列表、frontmatter、HTML、脚注、批注、公式、mermaid、无末尾换行等。不能说“当前 Kit 一打开就全篇格式化”。

源码对应 `src/editor-kit-v2/main.ts` 的 `draftBlocks()`：当前 span 的 canonical 输出等于该块初始 canonical 输出时，返回快照里的 `original.markdown`。

但把整个文件永远当作一块不构成 E1 方案：一个字被编辑后，这个块会走整个 span 的 canonical 序列化。

### 2. 原定块原文适配器可以补足文件外围信息

当前 `getDraftMarkdown()` 固定 `join('\n\n')`。当自然分块后原文件的间隔是三换行、CRLF 或含 BOM/末尾换行时，直接拼接会丢失外围原文。

scratch 的 `rawSliceAdapter` 在打开时已经保留 `prefix + block0 + gap0 + block1 + ... + suffix`，编辑时仅对 Kit 操作指出的 blockId 替换为该 `block.replace.payload.content`，其余原始切片直接拼回。**没有做 after/base diff 后过滤，没有忽略格式 hunk。** 该操作内容来自真实 `draftBlocks() → serializeSpan()` 路径。

对于独立普通段落的一字编辑，同时保留未触碰表格、混用列表、HTML、多空行、BOM 等，适配器确实成功：例如 `table`、`mixed-nested-list`、`html`、`long-chinese`、`bom` 的结果均只发生“甲→乙”，propose 为一个目标句 hunk。说明原定适配方向有用，并非不能做。

`frontmatter` 案例把最后换行放在触碰段落 raw 内，现有 serializer 丢掉它；把文件末尾换行在解析时归入 suffix 可补足。这不是必须改核心的证据。更完整分块器应明确 gap/suffix 归属，不得仅按空行 split，因为代码、列表、HTML 等都可能含空行。

### 3. Source 的 CRLF 是另一层可补问题

直接三轮组件切换，**17/18 无变化，唯一失败类型是 CRLF**。不是 Kit 的初次 rich 导出丢失：初次 `getDraftMarkdown()` 保持 CRLF；赋入 HTML textarea 再读取 `.value` 后成为 LF。

对应 `src/editor-kit/source.ts`：`ta.value = initial`、`getValue: () => ta.value`。因此 spec “源码直接编辑本来就满足字节保持”不能理解成 textarea 自带原始换行保持。

适配器应持有独立原文 buffer：没有 input 时继续使用原始 buffer；发生 input 时基于实际编辑范围更新源码、保持未改区域原始换行/BOM，并维护 DOM offset 与原文 offset 的映射。仅为了无修改切换，可用 input dirty 状态避免回读 textarea 覆盖原文。实现 Source 编辑保真仍需后续测试，当前尚未完成。此类预先保留来源信息的做法属于适配，不是事后过滤格式差异。

### 4. 决定性失败：同一个普通段落的另一句被规范化

样本 `edit-separated-sentences` 是一个自然段，只有一个自然 Kit 块，没有表格/列表原子范围歧义、BOM/EOL/文件分隔符干扰。输入：

```md
这是甲句。中间句保持。末句保持 _斜体_ 与 [链接](<https://example.com>)。
```

浏览器只选中“甲”，输入“乙”。期望只改第一句，真实 Kit 输出：

```md
这是乙句。中间句保持。末句保持 *斜体* 与 [链接](https://example.com)。
```

无修改时此原文已通过三轮组件切换零 diff；编辑后 Kit 发出一个 `block.replace`，其 content 即上面的规范化文本。scratch 原文适配器取得相同结果，因为整个自然段就是被触碰的块。

真实 `propose({path:'case.md',base,ours:base,theirs:after})` 的 hunk 为：

```json
[
  {"base":"这是甲句。","theirs":"这是乙句。","oursStart":0,"oursEnd":5},
  {"base":"末句保持 _斜体_ 与 [链接](<https://example.com>)。","theirs":"末句保持 *斜体* 与 [链接](https://example.com)。","oursStart":11,"oursEnd":51}
]
```

另一个两句变体 `edit-marked-paragraph` 得到一个 hunk，但范围覆盖两句，同样违反“只覆盖该句”。因此只检查 hunk 数量不足。

不能把同一自然段的句子各自伪装成当前 Kit 块来规避：`BlockSpan` 是顶层 PM node index 区间，`materializeBlocks` 分别 parse 每块；拆句会变成多个 PM paragraph，改变编辑文档结构。要在同一个 paragraph 中保留来源，需要更细的源码映射/局部序列化能力。

### 5. 其他诊断不提升为额外门槛

- CRLF 段落中的 softbreak 编辑后变成 `两空格 + LF`；现有核心 parser 将 softbreak 标为 `hardbreak{isInline:true}`，serializer `hardbreak()` 无条件输出 `  \n`。此处说明需保留 EOL/softbreak 信息，不单独用它提高“触碰块必须全文字节不变”的要求。
- 列表项编辑会改 bullet/空行，表格单元格编辑会改对齐写法。列表和表格按 §7 可能本来就是原子合并单元，本报告不以原子 hunk 的整体范围宣告新增验收失败。
- `rawSliceAdapter.exactExpected` 是诊断字段，比 I7 对“未触碰块”的要求更强；不是每个 false 都代表 E1 门槛失败。真正硬阻点是上一节普通段落的两个句子 hunk。

## 确切接口缺口与最小工程范围

| 现有接口 | 已有能力 | 必须补足的责任 |
| --- | --- | --- |
| `EditorSnapshot = DocumentRevision`（`src/editor-kit-v2/contract.ts`） | `{documentId,revisionId,blocks[{blockId,blockRevision,markdown}]}` 有整块原文 | 文件 prefix/gaps/suffix、原始源码区间及 Source buffer 可由 share 适配层持有，不必污染 CDR 权威协议 |
| `materializeBlocks(blocks,schema)`（`block-layout.ts`） | 每块独立 parse；顶层 PM 节点打 blockId | 若要求块内保真，需同时取得原文到 PM 子区间的对应，不能只返回顶层 span |
| `serializeSpan(doc,span):string`（`block-layout.ts`） | 仅当前 PM node 子集 → canonical Markdown | 增加 original/source-map/transaction provenance 等上下文，或调用具备来源保留的共享 serializer；避免把未改 mark/链接/softbreak重新生成 |
| `draftBlocks()`（`main.ts`，内部） | 整块 canonical 相等时原文回退 | 已改块也需通过上述保真路径输出；单纯“原块或全块 canonical”二选一不足 |
| `observeLocalOperations` / `block.replace` | 可知 changed blockId 和 canonical content | 到达这里时格式信息已丢失，不能仅靠回调中的字符串实现来源保留；必须在序列化之前接入 |
| `getDraftMarkdown()` | `join('\n\n')` | 可增加有序块读取接口供 share assembler 使用，或基于 ack 后 snapshot 组装；这只解决外围拼接，不解决句子级问题 |
| `mountSource` / `SourcePane.getValue()` | textarea 文本 | 原文 buffer、input 范围/EOL offset 映射；无修改切换不能把规范化 textarea value写回原文 |

根因补充证据：当前 `parseMarkdown('_斜体_')` 与 `parseMarkdown('*斜体*')` 的 PM tree `.eq()` 为 true；尖括号链接与普通链接也相同。当前 `serializeMarkdown(doc)` 仅看 doc，无法分辨两种来源写法。因此不能只改一个固定输出 delimiter 就支持两种原文；需要保留来源信息。`/Users/bruce/git/moraya-core/src/markdown.ts` 的 `em`、`link` 与 `hardbreak` serializers 可定位规范化来源；实际运行加载的是 `node_modules/@moraya/core/dist/index.js`（已记录指纹）。

可行工程路径应是**序列化前以原文 token/source span 为权威**，针对真实编辑重建必要语法片段；完整未改来源片段直接复用。它可以位于 Kit 内部，也可以通过 Moraya 提供新的来源映射接口。不能以 canonical 文本与原文做 diff 后删除“看似格式”的改动，否则可能吞掉用户主动修改格式，且违反 spec 禁令。

本次不为证明门槛而实现该能力，不承诺一个未经验证的 lossless serializer 方案已可用。

## 需要人的最小裁决

**是否在 E1 接入前增加“共享 Kit 的块内来源保留/局部序列化”前置任务，并继续维持 §12.4 当前判据？** 推荐是。该任务应先解决上面的单段两 hunk 复现，再完成原文 envelope 与 Source buffer 适配，最后跑完整 E1 UI 的 13 类三轮切换和一字编辑验收。

无须让用户决定 PM 数据结构细节，也无证据要求先重写整个 Moraya core。需要裁决的是新增能力范围/前置工作，而不是批准事后过滤、降低标准、或将整个文件当一块。后续 E4 代码核对也确认桌面路径缺少来源保留，见下方补充。因此更新后的另一选择是暂缓两端富文本协作，先完成并发布 P2。共享编辑器保真前置范围仍待用户决定，P2 继续。

本次未验：新的 IIFE 构建、900 KiB 预算、CSP/SRI、部署、输入法矩阵、主人批注保护、完整 Source 编辑/局部重解析。报告只裁定字节保持相关可行性。


## E4 后续只读核对（2026-10-13）

桌面 `mountRichEditor` 直接调用 Moraya createEditor；RichEditor 的 onChange、notemd:flush-doc 和 destroy 均可全量 getMarkdown 后写入 tab。实际安装产物与源码均未发现原始来源保留路径：`../moraya-core/src/setup.ts:1029` getMarkdown 和 `:656` onChange 调用 serializeMarkdown；`../moraya-core/src/markdown.ts:1389` serializer.serialize 后处理并全局去 U+200B；安装 dist/setup.js:5487、dist/index.js:5607 同路。现有 frontmatter/footnote tests 明确接受去掉末尾换行。这是源码风险证据，未冒充真实 Tauri E4 编辑验收。

用户已收到更新的异步决策请求：增加共享编辑器源码保真前置后完成两端协作，或暂缓两端先发布 P2。尚未收到明确答复；没有依赖该新增前置的产品改动，也没有默认为默认源码编辑或降低 I7。E4 十任务草稿与未裁决边界只作为后续规划保留。

原始 E1 语料、Playwright脚本、完整输入/输出、操作与提案、源码指纹及 E4 研究/草稿保留在本轮 P2 证据中；最终归档路径、文件清单与 SHA-256 由 P2 验证报告记录。工作区清理后，文中 scratch 相对路径从该归档解出复现，不代表仍保留临时工作区。此文件为门槛发现报告，不是 E1/E4 已完成或已发布声明。
