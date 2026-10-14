# Mermaid 可选加载的真实模块边界设计

> 2026-10-14 正式实施合同。前置已受理：CORE `6a6d0f940383c1e2cd19dc3c9c3df8f63e69baff` / HOST产品 `8a0b555ca6a0e8df226700fc74f67ffa64f3925e`；唯一全阶段审查及一次 finalfix/scoped复审完成，准确证据见 [docs/superpowers/reports/2026-10-14-file-bindings-history-verification.md](/Users/bruce/git/mdeditor/docs/superpowers/reports/2026-10-14-file-bindings-history-verification.md)。本合同的 E1–E4 尚待实施与发行。用户暂无移动设备，移动端真实中日 IME 保持待验，继续独立实现。

日期：2026-10-14。状态：ROOT 已正式采纳的交付 Task1 M0 合同；尚未实施、构建或证明900KiB预算。前置writer已停写，所有权交给后继Task1唯一writer。

路径简称：CORE=`/Users/bruce/git/moraya-core`，HOST=`/Users/bruce/git/mdeditor`。证据符号对应规划时读取的工作区文件；不是冻结 tag 或已安装包的证明。只引用所需稳定区域，不将另一 writer 的在途工作作为本设计成立前提。

## 1. 结论与裁定边界

采用显式 `MermaidLoader` 注入，保留现有唯一 editor factory、现有 code-block NodeView 及 Mermaid 专有预览/编辑/主题行为，删除该 NodeView 对默认 Mermaid 模块的**运行时加载边**。旧 `plugins/mermaid-renderer` 保持独立公开可选模块，桌面 bridge 显式注入它。网页 E1 不传 loader；E3 只传调用 `host.loadMermaid()` 的 loader。RendererRegistry 继续处理其他语言，不能承担这个 seam。

这是可以闭合的模块方案，但有公开 SDK 默认行为变化：以前未传参数甚至传 `enableMermaid:false` 都会自动走 Mermaid 分支；以后未传 loader 显示源码。ROOT 已采纳此方案，并要求普通旧 Kit 按原有 false 的意图显示源码。必须在 CORE/HOST 的未发布日志、API 文档及迁移用例中记录，不能声称所有消费者行为不变。本文件记录 ROOT 已冻结的设计决定，不冒充实现受理或新 SDK 版本已发布。

不能同时维持“从同一 SDK 入口无参数自动加载 Mermaid”“该入口的分享运行时闭包绝无默认 Mermaid 加载边/库副本”“不引入第二默认包装或入口机制”三项。若最终决定仍要求第一项原样兼容，必须重新选择兼容入口方案并承担其成本；不能继续用 false/tree-shake 承诺解决。

## 2. 实际源码证据

| 文件/区域 | 已核事实 | 对现有候选的影响 |
|---|---|---|
| CORE `src/plugins/code-block-view.ts` 的类型导入与 `loadMermaidApi` | RenderFn/UpdateThemeFn 是 **type-only** import，本身没有运行时边；loadMermaidApi 中 `import('./mermaid-renderer')` 才是真实运行时边，且结果在模块级缓存 | 仅替换类型、传 registry 或把 false 传到 host 都不能切断依赖 |
| 同文件 `createCodeBlockNodeViewFactory` / `syncMermaidMode` / `update` | 首次挂载和 update 都仅按 `language==='mermaid'` 设置 `isMermaid`；先走专有预览再调用 loader | registry 注入不会覆盖 Mermaid；初次挂载与语言切换都必须改 |
| 同文件 `isRenderer` / `syncRendererMode` | `isRenderer` 是另一套独立状态；两个 sync 函数都考虑另一状态决定是否隐藏 pre | 把 Mermaid 同时放进 registry 会导致双模式，不能作为最小修复 |
| 同文件 `installThemeObserver` / NodeView theme callback / `destroy` | 全局主题观察监听 html `data-theme` 和系统 matchMedia；先调用唯一全局 API 的 updateTheme 再重绘所有 Mermaid；destroy 移除回调 | 注入后必须按实例/loader 保留主题行为，不能只改 render 调用 |
| CORE `src/plugins/mermaid-renderer.ts` 的 `ensureMermaidLoaded` / `resolveThemeColors` | `import(/* @vite-ignore */ 'mermaid')`；初始化读取 document root/系统暗色和六项 CSS 颜色 | 存在浏览器裸导入问题，也不是 host 的 mermaid-mini |
| 同文件 `renderMermaid` / `updateMermaidTheme` | `renderMermaid` 返回 svg/error 联合；模块级串行队列与 ID；`updateMermaidTheme` 保留同样 themeVariables | 桌面注入此模块才保留当前实际渲染器和主题，不应替换成 registry 的 mini renderer |
| CORE `src/setup.ts` 的 `preloadEnhancementPlugins` / `EditorPluginOptions` / `createEditorPlugins` / `createEditor` | enableMermaid 只有声明；preload 仅传 registry；完成缓存比较 schema/registry，而全局 `tier1Loading` 不比较任何 key | 新 loader 必须传过两次 preload，并修正并发身份隔离 |
| HOST `src/lib/adapters/renderer-registry.ts` 的 `rendererRegistry` | Mermaid 刻意不注册；注释明确双状态会使 Edit 后源码被隐藏；现有 registry 仅 dot/graphviz | 候选“用 registry 解决 Mermaid”与桌面已知经验相反 |
| 同文件 `loadMermaidRenderer` | 另一条 `loadMermaidRenderer` 加载 mermaid-mini，初始化 loose，供 host HTML/PDF/share 烘焙 | 不能把它当 desktop editor 的等价 API，也不能原样用于 strict 的访客草稿 |
| HOST `src/lib/editor-bridge.ts` 的 `mountRichEditor` | 先做 CSSStyleSheet 兼容处理，再传 registry 和 enableMermaid:true | 应在此显式注入 CORE 原 API，继续已有 CSSOM 顺序 |
| HOST `src/editor-kit/rich.ts` 的 `mountRich` | 旧 Kit 显式 false，注释意图不需要重 renderer，但当前 CORE 忽略它 | 修正后行为会从自动尝试渲染改为源码，必须登记 |
| CORE `src/__tests__/mermaid-theme-observer.spec.ts` 的 factory/主题观察 fixture | 无参数 factory；空 Mermaid 内容；伪 view；测试只证主题触发清空 stale DOM | 测试需显式注入，且不能作为非空 Mermaid 真加载/SVG/主题验收 |
| CORE `package.json` / `tsup.config.ts` | `./plugins/*` 已公开映射到 dist；mermaid optional peer；tsup 包含 plugins 通配与 setup，splitting:false | 可沿已有 `@moraya/core/plugins/mermaid-renderer` 导入，无需另造 editor factory；仍需检查实际 dist 文件/图 |
| HOST 候选 Task 2.3 | IIFE 使用 inlineDynamicImports:true | 能内联可解析内部动态模块；不能保证 vite-ignore 裸 import 被消除，也不会凭 false 裁掉整个运行时路径 |

## 3. 三种方案比较

### A. 只消费 enableMermaid，或把 Mermaid 注册到 RendererRegistry

不采纳。消费 false 能防止当次执行，仍保留 `setup → code-block-view → mermaid-renderer → mermaid` 的运行时可达边。Rollup 不因函数的某个调用传 false 就保证删除函数内另一条分支。强制 inline 后可能留下裸 import，也可能把大库纳入主包；都不满足合同。注册 Mermaid 还引入现有双模式 bug，并绕不过 builtin 优先分支。删 builtin 后统一 registry 虽可做，但要迁移主题订阅、渲染结果协议、预览/复制和错误 UI，范围比独立 loader 大。

### B. 显式 loader，默认模块脱离共享运行时图（已采纳）

只增加一个能力注入；NodeView 继续持有已有 preview/edit/copy/language-picker/contentDOM。桌面显式提供原 loader；分享提供 SRI loader；旧 Kit 不提供。没有运行时默认 fallback。新增成本是 API 接线、缓存身份与生命周期回归、一次 SDK 默认迁移；不新增服务、数据库或 editor factory。

### C. 保持默认 SDK 行为，另设纯入口和兼容初始化

理论可行：纯入口导出同一个 factory，兼容入口显式注册默认 loader，分享所有可达 runtime import 都只能走纯入口。需要注册覆盖规则、同页混用隔离、package sideEffects 保留声明及实测、所有共享 import 迁移，并防 barrel 重导出重新引入兼容初始化。当前 package `sideEffects:[]` 还会让注册副作用存在被裁掉风险。或者用兼容 factory wrapper 注入默认值，但这触及“不另造默认包装/第二 factory”限制。

本次不采纳。为一个可选渲染器维护入口状态与隐式默认会增大迁移面。若未来明确要求 SDK 零默认行为变化，这才成为必须单独设计的合同变更，不能在本次 B 中偷加 fallback。

## 4. 推荐 API 与消费语义

### 4.1 CORE 第一生产者：新增可并行规划、串行落地的 `Mermaid seam M0`

M0 归交付 Task 1 的明确前置小任务，必须早于 E1 产物验收。属于后继交付 M0，不回扩已逐 Task 受理的 bindings Task1–5 范围。前置所有权已移交，按窄 allowlist 实施、验证、精确提交、产出 committed dist 和 installed bytes。

在 CORE `src/types.ts` 首产纯类型：

```ts
export interface MermaidApi {
  renderMermaid(code: string): Promise<{ svg: string } | { error: string }>
  updateMermaidTheme(): void
}
export type MermaidLoader = () => Promise<MermaidApi>
```

在 CORE `src/setup.ts` 的 EditorPluginOptions 加 `mermaidLoader?: MermaidLoader`，CreateEditorOptions 自然继承；保留 `enableMermaid?: boolean`，但准确记录语义：

```ts
// 只抑制已注入能力；true 从不安装、导入或生成默认 loader。
const effectiveMermaidLoader = opts.enableMermaid === false
  ? undefined
  : opts.mermaidLoader
```

| 配置 | 新行为 |
|---|---|
| 无 loader，flag 缺省/true/false | Mermaid 为普通可编辑 fence；加载次数 0 |
| 有 loader，flag 缺省/true | 有非空 Mermaid 且需要预览才调用 loader |
| 有 loader，flag false | 普通 fence；加载次数 0 |

NodeViewOptions 新增 `mermaidLoader?: MermaidLoader`；factory 无参数默认同样不加载。`preloadEnhancementPlugins(schema, registry?, mermaidLoader?)` 增加向后兼容的第三参数，两个内部调用均传相同 effective loader。公开类型从既有类型出口可取，root index 若需 type-only re-export 由 M0 与其 owner 协调后追加，不能借此 re-export 默认 renderer 的运行时代码。

### 4.2 NodeView：只替换能力来源，保留普通代码路径

删除 NodeView 的运行时 `import('./mermaid-renderer')`、单一全局 mermaidApi/mermaidLoading；API 类型改从纯 types 引用。旧 type-only import 本来就不污染 JS，只是改成正式可注入合同。

初次挂载与 update 均使用 `Boolean(mermaidLoader) && language==='mermaid'` 判断专有模式。没有 loader 时 Mermaid 明确按普通代码处理，保留 language label、picker、copy、contentDOM、高亮，不发 loader 调用、不显示假“加载中”。为避免双状态，`isRenderer` 对 mermaid 语言也明确为 false；Mermaid 只由专有 loader 管理，其他 registry 语言逻辑不变。文档说明 registry 中的 mermaid 不是该能力的替代入口。

缓存按 loader 函数身份用小型 WeakMap 保存 promise/API；不以一个全局 API 服务所有宿主。load 成功缓存，失败删除其 promise，允许用户再次 Preview 重试；E1 根本不创建该 entry。不同 file-session 尽量复用同一 host loader 引用，由 inline host 再对同一冻结 descriptor 去重实际 script。

主题 observer 保留 html 和 matchMedia 两条触发。移除“通知全局单一 API”的代码；NodeView 的 onThemeChange 先对其**已加载** API 调 updateMermaidTheme，再清 lastRenderedCode、重新 render。主题通知本身不得触发尚未需要的库加载。允许同 API 被多个节点同步 update（原 API 当前是同步 initialize），不为去重另建管理服务。渲染仍由 renderer 自己的共享串行队列保护。桌面保留原六项颜色与 OS fallback。

为新异步宿主边界补最小生命周期守卫：每次渲染捕获 generation；语言切换、新渲染和 destroy 使旧 generation 失效。await load 和 await render 后均检查仍有效、仍是 Mermaid、源码相同、节点未销毁；不能只比较源码字符串，否则 Mermaid→普通语言但内容相同仍可能接受旧结果。destroy 清 timer/订阅，不允许迟到 promise 写回。

加载失败保留源文本并显示可读错误/重试入口；必须使 pre 可见，不能只在隐藏源码的 preview 中写一句 Render failed。可复用已有 preview DOM 为错误提示区，退出 preview-mode 并保证 Edit/Preview 能再次尝试；不要造第二编辑器或把错误写进文档。语法错误同样不修改 raw。正常 desktop 成功路径的 DOM、复制图片、Edit/Preview 保持现状。

### 4.3 Tier 1：按真实身份隔离 pending 与完成结果

最小修法不是只给完成缓存加 loader 字段。当前无 key 的 tier1Loading 会把 A 的 factory 返回给并发 B，因此 M0 必须同时修 pending。

沿现有单槽结构增加 `{schema, rendererRegistry, mermaidLoader}` key：完成槽与 pending 槽都比较三个引用。相同 key 复用同一个 promise；不同 key 自己创建加载任务，不能 return 另一个 key 的 promise。任务 finally 只有在 pending 槽仍等于自己的 task 时才清槽，防先完成的 A 清掉 B。完成槽允许最新完成结果替换，只影响缓存命中率，不改变已返回 factory 的 closure。内部每个任务局部保留其 key/opts，不从后来改变的全局槽读取。

这样无需泛化多级 cache 或 cache service；最差重复等待相同 ESM import，由模块系统缓存。必须覆盖 A/B 并发、完成顺序逆转、schema 相同但 registry 或 loader 不同，避免分享错误复用 desktop loader。

### 4.4 HOST 消费：同一 factory，按宿主给能力

| 第一生产者 | 文件 | 接线与影响 |
|---|---|---|
| M0，CORE | `src/types.ts`, `src/setup.ts`, `src/plugins/code-block-view.ts` | 类型、选项消费、无默认导入、缓存/主题/生命周期；新增 focused tests；旧主题测试显式传 loader |
| M0，CORE | `src/plugins/mermaid-renderer.ts` | 保留旧导出、队列和主题，必要时仅显式实现新类型；不能从共享 setup/NodeView 回 import 它 |
| M0，CORE | public type 导出/CHANGELOG/README 与实际 dist | 仅在相关 owner 交接后处理；记录默认变化、安装 peer＋注入迁移；现有 plugins 通配出口足够，无第二 factory |
| M0，HOST | `src/lib/adapters/mermaid-loader.ts`（新建）、`src/lib/editor-bridge.ts` | 稳定函数 `loadDesktopMermaid = () => import('@moraya/core/plugins/mermaid-renderer')`；在现有 options 传入，保留 enableMermaid:true 和 CSSOM 顺序 |
| M0，HOST | `src/editor-kit/rich.ts`、相关测试/双 CHANGELOG | 不注入 loader，保留 false；更新说明与源码显示验收，诚实登记从先前自动尝试加载变为禁用 |
| 交付 Task 1，在前置 mount 受理之后 | `src/editor-kit-v2/file-contract.ts`, `file-main.ts`、桌面调用者、分享 file-session | 将 mermaidLoader 加进 FileAdapters 纯类型 Pick，原样传给同一 core factory；桌面调用者组装并传 loader，共享 file-main 不导入 desktop adapter。在已交付 FileAdapters/mount 上明确追加 loader，不追改前置任务归属 |
| 交付 Task 2 | share build/check | 验证 installed package 的真实图与产物，不从 CORE src 路径取捷径 |
| 交付 Task 4 | `src/share-editor/mermaid.ts`, file-session、browser host、独立 bundle entry/check | adapter 只调用 host.loadMermaid；可选 bundle、SRI、主题及失败消费在此首次实现 |

桌面使用原 CORE 模块，不改接 `loadMermaidRenderer`：后者是另一个 mini/loose/无同等主题 API 的渲染器。既有 HTML/PDF/静态分享烘焙的 registry loader 不动。普通 codeNodeView 未替换；不导入整座 desktop bridge 来拿一个 loader。

## 5. E1 / E3 与构建边界

### E1

共享 E1 mount 不传 loader。即使 draft 初始含 Mermaid、由 Source 新增 fence、picker 切成 Mermaid、切文件/undo/redo/恢复草稿，也只显示源码。关闭/未安装 E3 能力不是错误状态；不调用 host.loadMermaid，不隐式请求 mermaid、mermaid-mini、/_kit 的 Mermaid 资源。

共享 runtime 图只包含 setup、code-block-view 与纯 API 类型擦除后的逻辑，**没有**默认 renderer 加载边。Task 2 可把 CORE 其他可解析内部 dynamic imports 内联成一个 IIFE；不能靠模块别名/stub、生产代码字符串替换、外部 bare import 或 suppress warning 过检查。

### E3

`src/share-editor/mermaid.ts` 仅为能力 adapter，无 mermaid/mini runtime import；有 `host.loadMermaid` 才构造 loader，API render 调 host 返回模块的 render，捕获错误为既定 error 联合；不猜 URL。只有处于编辑、实际出现非空 Mermaid preview 时请求，空块暂不加载；明确这个比“出现空 Mermaid fence 就加载”更小的触发范围。

inline host 首产完整同源 URL/SRI script loader：冻结 descriptor、校验同源和清单 URL、设置 integrity/crossOrigin 后插入 script；同 descriptor 成功与 in-flight 去重，失败清 flight 并支持明确重试；错误保留源码。主 module 不自行拿 token、不新 DB、不注册 service worker。script 失败、SRI 不符或缺全局 API 不可伪装成功。

Task 4 独立 `share-editor-mermaid` IIFE 以静态 import 使用现有 mermaid-mini，包含其所需净化代码；严格 securityLevel，并对输出 SVG 净化，渲染队列/唯一 ID 在该模块内共享。不能直接复用 desktop 的 loose loader，也不能复制 Mermaid 库源码。独立包同样须无残余 ImportExpression/外部依赖、无额外字体/worker/wasm 网络请求；超过每资源 8 MiB 或依赖无法静态闭合时明确失败，不改用户预算。

**主题合同补足（Task 1 先定义纯类型、Task 4 首实现）：** 本轮另核 HOST `browser.ts` 的 reader/article data-theme 写入，reader/article 的 `data-theme` 存的是 `presentation.themeId`，并非暗色枚举；当前文件没有另外一套主题切换控件。不能把任意 themeId 当 `dark|light`。分享 adapter 捕获实际 mount root，逐次 render 从该 root 的 computed CSS 读取六项颜色，暗色取页面明确明暗设置或系统 matchMedia。为避免独立 bundle 猜测 DOM root，候选 host API 明确增补一个必需的第二参数：

```ts
// 仅可传列明字段，不透传任意 Mermaid config。
type ShareMermaidAppearance = {
  theme: 'default' | 'dark'
  themeVariables: {
    primaryColor: string; primaryTextColor: string; primaryBorderColor: string
    lineColor: string; secondaryColor: string; tertiaryColor: string
  }
}
// host.loadMermaid 返回的对象与独立 IIFE 全局对象使用同一类型：
render(code: string, appearance: ShareMermaidAppearance): Promise<string>
```

这是新增 E3 方法尚未发布前的一次类型补足，不改变已发布 wire/draft 协议。颜色取现有 CORE resolveThemeColors 相同 CSS 变量与 fallback 值，但作用域明确为捕获的编辑根；仅窄六字段，不能传 securityLevel 或 directive 配置。独立 bundle 在每个串行任务内先 initialize `{...appearance,startOnLoad:false,securityLevel:'strict'}` 再 render/净化，安全参数不由 caller 覆盖。adapter 的 updateMermaidTheme 可为空操作，因为下一次 render 每次获取新 appearance；其注释与测试必须说明理由。

NodeView 仍由既有 html/OS observer 触发重绘。冻结 themeId 在本会话不变；Task 4 rebase 安装新 presentation/baseline 时销毁旧 file view 并用新根重新挂载，保证新主题首次渲染重新取色，不额外造 refresh API/observer。验收应覆盖实际 OS 明暗事件以及“另一冻结主题重新 mount”的真实路径，而不是虚构页面当前已有主题控件。如果最终产品新增会话内根属性切换，该 producer 必须同步补通知 seam，现有 html observer 不会观察子树；不能未经该变更就宣称支持任意运行时主题切换。

主 IIFE 可包含这个极小 adapter，不能包含 mini、默认 CORE renderer 或其中任何大库副本。主 JS＋必需可执行闭包 gzip ≤900 KiB（沿候选既定 gzip 口径）；可选 Mermaid 单独报告原始/gzip bytes/hash/SRI。900 KiB 目前未经实测，不应先承诺；DI 消除 Mermaid 是必要条件，不是整体预算证明。

## 6. RED → GREEN 与实际验收

本轮不执行。以下是实施 gate，不应勾成完成。

### M0 的真实 RED

1. 用真实 createEditor 挂载非空 Mermaid，无 loader：断言 pre 可见、零 renderer 调用/动态加载。现有代码会进入 builtin 预览，故能真实失败。使用模块 mock 监测默认模块是否被触达仅作为 RED 诊断；最终静态图检测才证明边已删除。
2. 注入两个不同 loader，同 schema/registry 并发 preload 后分别挂载，改变 Promise 完成顺序，断言每个 view 只使用自己的 API；第三个无 loader view 仍源码。增加 schema/registry 不同维度。现有全局 tier1Loading/mermaidApi 无法满足。
3. loader＋false：预览 0 次；true 无 loader：源码；注入 registry 即便声称 has mermaid 也不得触发双模式。普通 js/text/dot 的现有功能不受影响。
4. 真实非空内容初次 preview→Edit 源码→Preview，language mermaid→javascript→mermaid；异步 load/render 期间切语言/销毁，旧响应不得写回；失败→源码/提示→用户重试成功。
5. 既有主题测试保留 html 和 OS 两个用例，显式注入测试 API；新增非空 SVG、updateTheme 调用、多个不同 loader 各自更新、销毁后不更新。空内容＋fake view 的旧测试不够。

focused core 测试建议新建 `src/__tests__/mermaid-loader.spec.ts`、`enhancement-loader-isolation.spec.ts`，连同既有 `mermaid-theme-observer.spec.ts` 运行。基于真实 EditorView 的行为测试与少量 deferred API 故障注入并用，不创建平行简化 editor 实现。CORE typecheck/受影响 package build 与 committed dist 验收由 M0 在 writer 交接后运行，不重复其他任务全量测试。

### Task 2 的构建 RED / GREEN

- 检查 Rollup 实际 module graph：主入口可达图含预期 installed CORE code-block-view；不含 core mermaid-renderer、mermaid、mermaid-mini、desktop mermaid adapter、Tauri。type-only 引用不算 runtime 边；不要拿源码 grep 到类型名称就判污染。
- 解析最终 JS AST：没有 ImportExpression、ImportDeclaration/外部 export、require；没有残余裸 specifier。查模块图与 emitted chunks，比只查字符串更可靠。主产物只能一个自足 IIFE，CSS/字体符合已有闭包规则。
- 构建禁把 loader 改写成空函数以“验证瘦身”；先用旧 CORE 产物证明检查能抓到真实默认边/裸 import，再换已提交新 dist 验 GREEN。
- 输出固定口径 bytes/gzip、全部资源清单、SHA256/SHA384、CORE/HOST commit＋installed bytes 指纹；任何超标保留失败结果。不要根据注入类型编译成功就宣称预算通过。

### Task 4 的真实 DOM / 网络验收

- 从实际构建 IIFE 挂载共享 mount：只读页 0 kit、编辑普通文 0 Mermaid 请求、E1 Mermaid fence 0 Mermaid 请求；E3 非空 Mermaid 首次需要预览 1 次正确同源 hash/SRI 请求，多块/切文件共用 1 次。
- 通过现有桌面真实 bridge 挂载非空 diagram：实际 svg、Edit/Preview/copy、html 主题与系统主题变化均生效；保留现有 `ensureMermaidCssStyleSheetCompatibility` 路径，选现有 CSSOM 回归覆盖的图例，不以 stub render 宣称真实 Mermaid 支持。
- 分享 E3 验初始 draft 和输入新增 diagram，显示实际 SVG；SRI 改字节不执行、网络失败源码可编辑、正常重试成功；切文件/销毁后迟到 SVG 不覆盖新文档，raw 字节不因渲染变化。
- 至少两个冻结正文主题分别真实 mount＋OS 明暗实际事件，rebase 更换 presentation 后重新 mount，比较源码/预览 DOM 与 computed style，确认图色不滞留；同时录制网络，禁止外域字体/模块/worker。
- 旧 Kit 明确验证 Mermaid 保留 fence/可编辑且不预览；报告此为已公开登记的行为修正。SDK 迁移例分别验证“未注入不加载”和“显式原 loader 恢复原预览”。

## 7. 正式计划的对应落点

1. `docs/superpowers/specs/2026-10-14-project-share-docs/superpowers/specs/2026-10-14-project-share-browser-desktop-delivery-design.md` §3.2 FileAdapters 增加 `mermaidLoader`；§3.4 新增本设计的 CORE seam 前提，删除/改正“registry 足以提供 Mermaid”的隐含推断；不要碰不相关 source/history 合同。
2. `docs/superpowers/plans/2026-10-14-project-share-browser-desktop-delivery.md` Task 1 前列 M0 的 CORE/desktop/legacyKit first producer 与 SDK 迁移 gate；FileAdapters 消费作为前置 mount 已受理后的明确补丁，不塞进当前 writer 的未交接任务。Task 1 E1 无 loader，并用包含 Mermaid 的真实 draft 验零加载。
3. Task 2.3 把默认 CORE renderer 静态图禁入、最终 JS AST 与 installed dist 身份加为 build gate；inlineDynamicImports 只解决可静态解析的内部 import，不作为未知/裸 import 豁免。
4. Task 4.4 用本设计的 MermaidLoader adapter 接真实专有 NodeView，写明 E3 first producer、空块延迟、主题取得位置/真实通知路径、失败回源码与重试；registry 不注册 Mermaid。Task 4 独立 bundle 名/hash/SRI/Worker/CSP 沿既定候选，不新设计发布通道。
5. 所有证据只能在实际实现、focused 测试、构建、DOM 和提交完成后填写。当前没有已提交实现 SHA、预算数字或产物证明；本设计不能标成“已进入下次发布”。

## 8. 迁移成本与剩余不确定性

改动成本集中在 CORE 三处源码的依赖注入/缓存、桌面一个小 adapter 与接线、旧测试默认行为调整、共享 mount 一项纯适配器传递，以及原 Task 4 本就需要的 SRI bundle。保留 existing optional peer 和原 renderer 导出，外部 SDK 用户添加一条显式 loader 即可恢复原自动预览；若他们依赖无参数 factory 或只传 enableMermaid:true，则需要迁移。该变化必须随真实版本说明交付，不能把注释写的“默认 false”误当过去的实际行为。

未证明项：实际主闭包能否压到 900 KiB；mermaid-mini 的实际独立 IIFE 能否无残留动态加载；分享 rebase 更换 presentation 后实际重新 mount 与主题取色；实际 installed CORE 通配导出及桌面生产 Vite 对该可选子模块的打包结果。以上均有明确 gate。若任一失败，暂停该依赖阶段并按真实 graph/DOM 重新规划，不能改成 Tauri stub、CDN、第二 editor 或运行时默认回退绕过。
