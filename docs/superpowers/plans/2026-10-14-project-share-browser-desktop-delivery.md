# Browser E1–E3 and Desktop E4 Implementation Plan

> 2026-10-14 正式实施合同。前置已受理：CORE `6a6d0f940383c1e2cd19dc3c9c3df8f63e69baff` / HOST产品 `8a0b555ca6a0e8df226700fc74f67ffa64f3925e`；唯一全阶段审查及一次 finalfix/scoped复审完成，准确证据见 [docs/superpowers/reports/2026-10-14-file-bindings-history-verification.md](/Users/bruce/git/mdeditor/docs/superpowers/reports/2026-10-14-file-bindings-history-verification.md)。本合同的 E1–E4 尚待实施与发行。用户暂无移动设备，移动端真实中日 IME 保持待验，继续独立实现。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. ROOT 已核对规格、真实接口与逐Task生产者/消费者，正式按下列8 Task串行实施。

**Goal:** 完成同一保真编辑器的网页协作与桌面离线协作，并证明提交、主人审阅、回执和更新两条真实用户链路。

**Architecture:** 保留当前local-first源文件、现有Worker/R2/KV和v2建议包；分享kit用独立IIFE、内容寻址和SRI交付。浏览器/桌面调用同一TS合并内核与组包函数；桌面Rust负责有界下载、安全IO、base/outbox和CAS更新，永不实现第二套diff3。

**Tech Stack:** TypeScript、Svelte5、ProseMirror、现有@moraya/core、Vite6、Vitest、已安装Playwright、Rust/Tauri2、reqwest、zip2.2、现有Wrangler3。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md`；本OWN `docs/superpowers/specs/2026-10-14-project-share-docs/superpowers/specs/2026-10-14-project-share-browser-desktop-delivery-design.md`解释现行源码seam及需同步的陈旧条文。

## Global Constraints

- I1 base只取声明snapshot原字节；I2主人源文件只经ProjectStore::apply；I4单一TS内核；I6/I7不归一BOM/EOL、不过滤格式差异、不全文件重序列化。
- Worker不理解正文；不新服务/数据库/协作DO；保持免费方案、现行分段上传协议和source-only ZIP。
- v1永久兼容；v2≤5MiB、edits/annotations各≤2000、message≤2000 UTF16、name≤80无Cc、正文不含凭据。offset为UTF16。
- kit name严格 `^share-editor(-mermaid)?\.[a-f0-9]{64}\.(js|css)$`；PUT≤8MiB；js/css SHA256内容命名、SHA384 SRI；IIFE禁止动态import；主kit gzip≤900KiB；旧kit永不删除。
- CSP不加strict-dynamic、unsafe-eval或通配路径；不使用第三方CDN；只读链接不请求/_kit。
- 分享者批注browser保护；desktop允许改但显式提醒；所有访客数据纯文本/净化渲染，不自动加载外部资源。
- token只在IDB/app-data Store；不得进vault、ZIP、日志、错误、回执；没有token仍可下载公开ZIP，但不能提交/读receipt。
- 不读.env；运行时只root受控加载发布凭据且不得打印。所有pnpm验证加 `env pnpm_config_verify_deps_before_run=false`，不触发隐式安装。
- 本规划未运行任何测试/build/install/发布。前置 bindings 的实际 mount/owner/单文件保存 API 已实现并逐 Task 受理；最终 phase 与收尾 SHA 见上方冻结身份。下面命令是后继 E1–E4 的将来步骤，不表示已执行。每Task独立记录RED→GREEN/类型检查/精确提交SHA，未提交必须明确标注。
- 现有工作目录main，不新worktree；不替并行任务提交dirty文件；发布前审所有worktree/分支/stash和补丁等价。
- 真IME矩阵为macOS Safari/Chrome、iOS Safari、Android Chrome × 中文拼音/日文假名 × 表格cell/列表；当前后两平台无可用设备，保持“未验收”，合成事件不能替代。

---

## File Structure / 前置接线门槛

先读design inventory；只改本Task明确文件。前置 bindings Task3 已交付 `src/editor-kit-v2/file-contract.ts` / `file-main.ts` / `main.ts` 中的 `mountFileEditor`、FileEditorOwner、FileSnapshot、同一 PM history 与 Source 输入，以及 design §3.2 的 adapters/render/pure-veto/decorations/annotations 接口；E1 以本合同列明的前置冻结提交消费。pure-veto由bindings Task2的createFileController首产，Task3仅传递；controller先完整准入root+append事务及所有history有序delta，最后对初始raw/最终raw纯调用一次policy，拒绝时raw/doc/bindings/layout/generation与observer全不发布。不得在history delta中间态执行veto。既有 `createShareFileSession` 已实现于 `src/share-editor/file-session.ts`，E1在该文件继续接线，不创建另一个factory。

前置确切公开接口：`mountFileEditor(container,options):Promise<MountedFileEditor>`；owner `snapshot/replaceSource/execute/canExecute/executeSlash/canExecuteSlash/undo/redo/canUndo/canRedo/restoreContent/installBaseline/setReadOnly/flush/observe/close`；snapshot.raw完整保留文件字节。`installBaseline(input,options?:{policy:FilePolicy|null})`在成功构造目标controller后才原子交换policy/authority/history；分享rebase/undo-rebase显式传以目标snapshot+目标draft新建的policy，省略仅兼容普通host，null不向URL/draft/公开ShareEditor API开放。共享file-main/file-contract/file-controller只接显式adapters并保持browser-safe；未传字段仅用core既有browser-safe默认，无默认的必需项由调用者提供。桌面 RichEditor 对应宿主调用路径已在前置 bindings 中组装现有 Tauri/media/link/platform 等依赖并传入；共享路径不得导入desktop工厂/Tauri总模块/默认bridge，不靠tree-shake或dynamic alias，不增第二factory。adapters 的来源是 CORE `src/setup.ts` 的公开 `CreateEditorOptions`；`DecorationHost` 来自 HOST `editor-kit-v2/contract.ts`。FileAdapters 类型可选不表示 mediaResolver 可缺省；当前 mount 会拒绝缺失的 mediaResolver。E1不得从未提交core源码直接导入，也不得绕过已安装dist。

后继文件职责：

| 新/改文件 | 责任 |
|---|---|
| `src/share-editor/contract.ts`, `main.ts`, `ShareEditor.svelte`, `share-editor.css` | 固定浏览器API v1、UI、全局注册 |
| `src/share-editor/file-session.ts`, `media.ts`, `owner-policy.ts` | 复用前置file owner、批准资源、browser owner保护 |
| `src/lib/project-share/guest-submission.ts` | 两端纯TS统一组包，不含IDB/IPC/fetch |
| `src/share-editor/changes.ts`, `rebase.ts`, `RebasePanel.svelte`, `mermaid.ts` | proposal/revert、rebase事务、可选渲染器 |
| `scripts/build-share-editor.mjs`, `check-share-editor-build.mjs` | 独立IIFE构建、hash/SRI、依赖图/闭包预算 |
| `worker/src/kit.ts`, `worker/tests/kit.test.ts` | 同源不可变资源 |
| `src/lib/project-share/{browser,bundle,host}.ts` | 现行IDB/发布状态机的kit接线 |
| `src-tauri/src/share_guest.rs`, `share_guest/{archive,reader,store}.rs` | 原生IPC分发、有界归档/reader解析、受管工作目录 |
| `src/lib/share-guest/{types,host,link,update}.ts`, `state.svelte.ts` | 客户端合同、IPC/Store、深链解析、内核编排 |
| `src/components/share-guest/{OpenShareDialog,GuestPanel}.svelte` | 网络前确认和项目侧栏 |
| `scripts/check-share-editor-browser.mjs`, `check-share-guest-native.mjs` | 真实产物浏览器与原生验收recording入口 |

## Task 1: 共享组包、保真mount和批注/媒体能力

**明确前置 M0（本 Task 首生产，等 bindings 阶段受理后串行实施）：** 按 `docs/superpowers/specs/2026-10-14-mermaid-loader-design.md` §4–6 在 CORE 增加纯 `MermaidApi/MermaidLoader`、setup/NodeView 显式注入，删除共享运行时对默认 mermaid-renderer 的加载边；flag false 抑制注入，true 不创造默认 loader。pending 与完成 cache 同时按 schema/registry/loader 身份隔离；保留专有 NodeView，防异步迟到写回与失败隐藏源码。desktop bridge 注入原 CORE 可选 renderer（稳定 adapter）；旧 Kit false 保持源码。新增 focused RED/GREEN、旧主题测试显式注入、产物实际图/installed 字节验收与 SDK 迁移文档，记录无参数 SDK 自动预览行为改变。无第二 factory、无别名/stub/字符串改写，registry 不注册 Mermaid。FileAdapters 增加 mermaidLoader 并透传，共享 mount 不 import desktop adapter；E1 无 loader 并以真实 Mermaid 草稿验零加载。预算按当前已受理 CORE 口径重新核，不能预称通过。

**Task 1 首产纯主题类型，Task 4 首实现：** `ShareMermaidAppearance={theme:'default'|'dark';themeVariables:{primaryColor:string;primaryTextColor:string;primaryBorderColor:string;lineColor:string;secondaryColor:string;tertiaryColor:string}}`。render 必须接 code 与 appearance。reader data-theme 是冻结 themeId，不是暗色枚举；Task4 adapter 每次从实际 mount root 读取六项 CSS 颜色，明暗来自明确页面设置或系统偏好。仅六色，调用者不能覆盖 strict 安全参数。


**Files:** Create `src/share-editor/{contract,main,media,owner-policy}.ts`、`ShareEditor.svelte`、`share-editor.css`及同名tests；Modify前置 `file-session.ts`；Create `src/lib/project-share/guest-submission.ts`/test；必要仅按前置已采纳合同改file-contract/file-main；Create `src/lib/i18n/runtime.svelte.ts`、`src/lib/slash-menu/slash-items-common.ts`、`src/editor-kit-v2/file-menus.ts`；Modify `src/lib/i18n/store.svelte.ts`、`src/lib/slash-menu/{SlashMenu.svelte,slash-items.ts}`、`src/lib/note-anno/NoteEditPopup.svelte`及对应tests；双CHANGELOG。

**Interfaces:** 使用主spec §12.3完整ShareEditorHost及最终ShareEditorModule/Handle，不改submit/body协议；本Task module实际返回E1 handle（下述精确Omit类型），Task3消费 `ShareEditorHandleE1 & Partial<Pick<ShareEditorHandle,'rebase'>>`，Task4才将module返回类型收紧为完整Handle。补齐spec未定义 `RebaseUiResult={status:'applied';draft:DraftV2}|{status:'cancelled'}`，Task4产出；host增加可选 `loadMermaid?():Promise<{render(code:string,appearance:ShareMermaidAppearance):Promise<string>}>`（Task4首实现，同源SRI加载由inline host持有descriptor）；另可选 `setFileBadges?(rows:readonly {path:string;changed:boolean;annotations:number}[]):void`，只传派生UI状态、不持久化第二份draft；正式API文档一并列出，避免浏览器内联脚本复制内核做徽标。

```ts
export interface SubmissionInput {
 project_id:string;draft:DraftV2;submissionId:string;
 client:{kind:'browser'|'notemd';version:string};
 message?:string;name?:string;aiAssisted?:boolean
}
export interface BuiltSubmission {
 body:string;submissionId:string;
 summary:{files:number;blocks:number;annotations:number};
 ownerAnnotationsTouched:readonly {path:string;raw:string[]}[]
}
export function buildGuestSubmission(input:SubmissionInput):BuiltSubmission
export function ownerAnnotationFloor(base:string,initial:string):ReadonlyMap<string,number>
export function acceptsOwnerFloor(floor:ReadonlyMap<string,number>,candidate:string):boolean
// scanOwnerAnnotations使用share-merge/critic.ts已有实现；不新写Critic解析器。
// bundleMediaResolver(files,currentPath)返回core MediaResolver；只解析批准dataUrl。
```

- [ ] **1.1 组包真实RED。** 新test直接调用实际extract/propose/anchor，不mock内核：

```ts
const base='\uFEFF{==主人==}{>>保留<<}\r\n\r\n风险。\r\n'
const raw='\uFEFF{==主人==}{>>保留<<}\r\n\r\n{==风险==}{>>请量化<<}！\r\n'
const draft:DraftV2={v:2,lineageId:'L',snapshotId:'S1',
 base:{'a.md':{hash:sha256Sync(base),markdown:base}},after:{'a.md':raw},annotationKinds:{}}
const r=buildGuestSubmission({project_id:'P',draft,submissionId:'I',client:{kind:'browser',version:'test-version'}})
const p=JSON.parse(r.body)
expect(p.edits[0].afterMarkdown).toBe('\uFEFF{==主人==}{>>保留<<}\r\n\r\n风险！\r\n')
expect(anchor(p.edits[0].afterMarkdown,p.annotations[0].selector).status).toBe('exact')
expect(r.body).not.toContain('ownerAnnotationsTouched')
```

导入明确：`DraftV2` from ../project-share/types，`anchor` from ../share-merge，`sha256Sync` from ../share-merge/hash；在guest-submission.test相对路径据文件改为 `../share-merge` / `./types`。另以相同id/version输入browser/notemd，剔除client后deepEqual；无变更无edit；批注only不造edit；point、重复owner、kind hash、5MiB边界、message/name非法、非base文件拒绝。

运行 `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/lib/project-share/guest-submission.test.ts src/share-editor/owner-policy.test.ts`；先建立可编译的最小接口，再记录实际组包/保护行为失败；缺导出或编译错误单列，不算行为RED。

- [ ] **1.2 实现统一builder。** path排序遍历draft.after，必须有base；extractGuestAnnotations→clean!==base才add edit；selector kind由 `sha256Sync(exact+'\0'+comment).slice(0,16)`查annotationKinds；blocks用真实propose({path,base,ours:base,theirs:clean}).hunks计数。完整协议字段校验后只JSON.stringify一次。outer客户端负责pending持久化，不在pure builder读取时钟/随机/fetch；同输入确定。

**buildSubmission公开API边界（Task1首次实现与测试）：** `ShareEditorHandle.buildSubmission(input)`只flush实际owner、capture一致draft并调用builder，返回spec既定body/id/summary；不持久pending、不host.submit、不POST、不更新receipt/submitted。builder仍不取时钟/随机；handle每次新build生成一次id并传入，预览丢弃该结果无提交记录持久化副作用。flush可走普通draft保存；这是原输入生命周期，不能误标为冻结pending。用host.submit与atomic pending spies证明build/preview网络0次、冻结0次；flush失败不产包/不发送。提交唯一orchestrator在Task3，Task1 UI不能另装发送handler。正式同步spec§12.6措辞以区分API返回与用户submit流程，不改wire。

- [ ] **1.3 owner floor RED/GREEN。** base O计数2、initial1→floor1；删除最后一份拒绝；复制至2→删任意一份允许；undo复制允许回1；old touched initial0→恢复O→undo回0允许；新authority才重冻，rebase/undo-rebase用目标snapshot+目标draft显式`installBaseline(input,{policy:newPolicy})`；故意沿用旧floor必须用新旧O计数相反的fixture检出，baseline构造失败旧policy/authority/history不变；restoreContent/Source/原生undo都走最终候选veto；混合appendTransaction只能最终一次安装；原生undo单history事件内部先删后复原owner的中间delta不veto，只核最终count。追加插件使最终floor失效时root与append全链都零observer/零代安装。仍以完整base抽取，old touched不被静默修复。把复制后删原occurrence的语义局限写入spec§21与验收，不伪装逐node身份保护。

```ts
const O='{==甲==}{>>旧注<<}'
const floor=ownerAnnotationFloor(O+O,O)
expect(acceptsOwnerFloor(floor,'')).toBe(false)
expect(acceptsOwnerFloor(floor,O+O)).toBe(true)
expect(acceptsOwnerFloor(floor,O)).toBe(true)
const missing=ownerAnnotationFloor(O,'')
expect(acceptsOwnerFloor(missing,O)).toBe(true)
expect(acceptsOwnerFloor(missing,'')).toBe(true)
```

- [ ] **1.4 真mount与UI。** 先消除真实Tauri依赖边：`i18n/store.svelte.ts` 的 Store 静态 import 与 Tauri event 动态 import；将现有纯locale/registry/t原样移到runtime.svelte.ts，store重导出并保留桌面持久化，NoteEditPopup/SlashMenu只import纯runtime。`slash-items.ts` 的 dialog/attachment 动态 import不能靠菜单filter tree-shake；bindings Task2已首产纯slash-command与原Steps原子组合，本Task只把无桌面依赖UI metadata/翻译条目与filter算法移到slash-items-common.ts，条目委托同一已实现producer；桌面getSlashItems合并原附件条目保持顺序，网页消费同一common+明确允许列表。新test比较桌面既有id/顺序/翻译和网页禁止项；没有浏览器别名替代Tauri的stub。 main只注册 `{apiVersion:1,mount}`；E1阶段实现类型明确为 `ShareEditorHandleE1 = Omit<ShareEditorHandle,'rebase'>`，main不创建该方法，Task3的browser以方法存在性显示迁移按钮；Task4实际实现后才按完整ShareEditorHandle完成最终API v1。完整主spec接口只在最终E1–E4发行时冻结，不用取消空实现或fake mount伪装已具备rebase。ShareEditor使用前置createShareFileSession→mountFileEditor，default Rich、Source切换、slash/快捷键/undo、真实 `src/lib/note-anno/note-commands.ts`、`NoteEditPopup.svelte`、`NotePopover.svelte`、`note-plugin.ts` 气泡/徽标。owner floor仅browser启用；旧被改owner提示本地统计且不阻止修复/原样导出。切文件与 close 委托已有 createShareFileSession 的保存/close 机制完成 flush、实际 durable 回执及 baselineIdentity 校验，确认成功后卸载旧 view 并挂新 file；不在 ShareEditor 再实现第二套 ACK。失败不丢 raw，不新建 textarea 撤销栈。已有Rich→Source→Rich三次零diff、BOM/frontmatter初mount零change必须用实际IIFE页面重新验。

- [ ] **1.5 adapters与安全。** bundleMediaResolver只返回files集合中与当前path解析相符的dataUrl，路径escape/远端URL/file:///未分享目标不给网络权限；wikilink与相对链接仅host.openFile已分享集合；不自动加载HTML远程媒体。图像粘贴/drop/附件按钮被能力层阻止并提示“在批注中描述”，纯文本paste保留；不出现AI/插件/全库搜索。math使用共享KaTeX，font全部data；高亮复用registry默认；Graphviz仍源码。菜单复用popup-menu.css，全局menu-panel/menu-row；真实hover验收。

**正文主题与资源闭包的明确实现/测试：** `presentation.ts` 的 inlineMathCss 把本机 KaTeX woff2 变 data，renderProjectPresentation 用 frozenTheme.compiledCss，`share-baker.ts`组合KaTeX/hljs light+dark/正文theme/响应式/Critic样式。网页编辑根延续同 `.moraya-editor` 与data-theme，复用页面已内嵌styleHead；不要import整个presentation.ts（含Tauri），不要调用editor-kit/theme.ts的host bridge。share-editor.css仅编辑器几何/工具条与proposal层，不覆盖正文font/color/line-height。主IIFE只包含KaTeX/必要hljs运行时，不重复注入有外部url的katex.min.css；若独立预览需要CSS，由build从同一字体名单生成data闭包。所有CSS url扫描必须仅data或同页fragment，字体不发HTTP、无worker/wasm，非法资源构建失败；不改font-src data:。真实browser装载后await document.fonts.ready，document.fonts.check的KaTeX字体覆盖数学样本，DOM glyph边界/截图证明无缺字；spy网络无font404/外域请求。至少两个实际theme含自定义正文font/heading/code颜色，比较reader与Rich computed font-size/family/color/line-height和代码hljs颜色，切Rich/Source、暗色及重试保持同冻结theme。保留现行“本机主题字体未打包时替代字体”warning，不宣称任意系统字体一致。高亮/Math出现时不能额外动态import分块；Mermaid独立hash/SRI在Task4，Graphviz仍源码。

- [ ] **1.6 GREEN/类型/提交。** 跑新builder/policy/media/file-session tests与前置已安装consumer回归；运行现有host完整build与新main严格类型检查；IIFE产物/Tauri闭包/预算及上述实际reader/Rich资源截图验收在紧接的Task2/3完成，不借Task1宣称已交付浏览器产物。新增测试纳入严格tsc/svelte-check。记录脚本、raw fixture committed SHA、UI截图和行为；精确提交，不能拿仅builder green说UI完成。

## Task 2: E1 kit产物、Worker运输和主人发布闭包

**Files:** Create `scripts/build-share-editor.mjs`、`scripts/check-share-editor-build.mjs`、`worker/src/kit.ts`、`worker/tests/kit.test.ts`、`src/lib/project-share/editor-kit.ts`与`.test.ts`；Modify `package.json`, `vite.config.ts`, `worker/src/index.ts`, `src/lib/project-share/{host,bundle}.ts`及对应test、双CHANGELOG。构建入口消费Task1真实main，不发布空壳。

**Interfaces:**

```ts
// editor-kit.ts：Node build写入dist，Vite虚拟module读冻结manifest并emit确切资源。
export interface KitAsset {name:string;sha256:string;sri:string}
export interface KitManifest {apiVersion:1;js:KitAsset;css:KitAsset;mermaid?:KitAsset}
export interface EditorKitDescriptor {
  apiVersion:1;js:{url:string;integrity:string};css:{url:string;integrity:string}
  mermaid?:{url:string;integrity:string}
}
export async function ensureProjectEditorKit(input:{
  origin:string;apiKey:string;manifest:KitManifest;
  readAsset:(name:string)=>Promise<Uint8Array>
}):Promise<{editorKit?:EditorKitDescriptor;warnings:string[]}>
// Worker：
export async function handleKit(req:Request,env:Env,url:URL):Promise<Response>
```

- [ ] **2.1 写Worker RED。** 在现有worker test环境用 `SELF.fetch`/env.MEDIA，沿 `receipt.test.ts` fixture owner鉴权。下列行为用固定body求hash后构造name，不hardcode错误hash：

```ts
const bytes = new TextEncoder().encode('globalThis.NotemdShareEditor={apiVersion:1};')
const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
  .map(x=>x.toString(16).padStart(2,'0')).join('')
const url='https://share.test/_kit/share-editor.'+hex+'.js'
// PUT无Bearer=>401；feedback token不能代Bearer；合法PUT=>201、相同重传=>200。
// GET=>bytes，HEAD=>零body且同length/MIME/immutable/nosniff；跨目录/name错=>404。
// 正确name+不同bytes=>400；8MiB+1(含无Content-Length流)=>413，不写R2。
```

运行：`env pnpm_config_verify_deps_before_run=false pnpm --dir worker test -- tests/kit.test.ts`。期待新路由404导致断言失败，不接受环境/依赖失败当RED。

- [ ] **2.2 最小实现。** boundedBody(req,8MiB)→digest→比name→head旧key→相同对象200/不存在put201，错误不得存。旧对象hash身份不能靠用户声明，GET只读取 `kit/<validated name>`。index在handleGet前 `if(path.startsWith('_kit/')) return withCors(await handleKit(...))`，PUT owner授权、GET/HEAD无token。未知method405，头/错误同样走CORS。禁止revoke顺手清kit。

- [ ] **2.3 写build RED与实现。** 独立Vite build `configFile:false,envDir:受控空目录,build.rollupOptions.input='src/share-editor/main.ts',build.rollupOptions.output.format='iife',build.rollupOptions.output.inlineDynamicImports=true,build.cssCodeSplit=false`；不能把IIFE塞现有多entry app build。入口仅side-effect注册globalThis.NotemdShareEditor，不设置同名Rollup output.name覆盖已注册对象。第一阶段使用临时文件名，拿最终bytes后SHA256命名和SHA384 SRI，写manifest。app build虚拟模块静态导入该manifest，`emitFile`把同bytes作为assets置入dist；不重新编译改hash。记录rollup模块列表检查无@tauri-apps；KaTeX字体inline data；禁外链/动态import；gzip固定默认参数，主JS+必要runtime闭包≤900KiB且每资源≤8MiB。

```js
const asset = bytes => ({sha256:createHash('sha256').update(bytes).digest('hex'),
  sri:'sha384-'+createHash('sha384').update(bytes).digest('base64')})
// 主kit必须evaluate后暴露apiVersion===1和mount函数，不能仅检查字符串。
// 完整JS闭包只能一个主IIFE；可选Mermaid从第二IIFE外置，不在主bundle中藏副本。
```

`package.json build`保持purity→share build→app vite build→existing kit check→share check，失败即停；`vite.config.ts`只增加产物读取/emit插件，不破坏既有Kit入口。

- [ ] **2.4 宿主与bundle RED。** host.test冻结S1的manifest A，第一次HEAD404/PUT失败→warning+页面无editorKit但发布继续；成功后第二次attempt不能换manifest B；重启重放bundle bytes不变；新一轮发布才采用B。bundle.test断言可选字段完整同源URL/SRI、无token/local path/git；editorKit absent时CSP逐字保持现行语义；相对/跨origin/credential URL拒绝。

- [ ] **2.5 接线。** 新分享阶段首次构造entry前ensure kit；先本地读bytes核manifest，再HEAD→404 PUT，错误只返回warning。`PendingBase`新增本机冻结descriptor和kit选择完成标识，确保undefined fallback也固定；首次和full bundle都用同descriptor；legacy pending不得重新构建旧body。资产读路径来自Vite emitted同源app静态资源，不fetch网络CDN；读取失败仍warning。可选Mermaid descriptor同冻结。

- [ ] **2.6 GREEN/类型/提交。** Worker kit+project/feedback/receipt tests，host/bundle/editor-kit tests，受控完整build后真实manifest/hash/module graph检查；记录installed app resources能读这些bytes。新增未发布条目，精确提交以上source/test/config；记录SHA、manifest与资源SHA；不宣称部署。E1对免费生产/_kit 8MiB PUT的CPU门槛留Task8实测，不能以test pool通过代替。

## Task 3: 浏览器E1装载与E2可见修改/持久化闭环

**Files:** Modify `browser.ts`, `bundle.ts`, browser/bundle.test，Create `src/share-editor/changes.ts`/test、`scripts/check-share-editor-browser.mjs`；Modify `ShareEditor.svelte`、`file-session.ts`及双CHANGELOG。

**Interfaces:** `projectShareBrowser`仍零runtime import；持有ShareEditorHost、module/handle和单IDB写队列。新增纯函数 `revertGuestHunk(input:{path:string;base:string;draft:string;hunkId:string}):string`，只能使用当前propose并匹配稳定hunk ID；未命中拒绝，不凭旧raw offsets覆盖。派生summary经host.setFileBadges推回当前文件树。

- [ ] **3.1 实际产物RED。** 新脚本沿 `check-project-share-browser.mjs`的isolated Vite服务、`PLAYWRIGHT_MODULE`、空envDir、真实buildProjectBundle；服务返回Task2真实JS/CSS字节，禁止注入fake NotemdShareEditor替代产物。录网络body、IDB读回、截图、securitypolicyviolation，不收token。只读零/_kit；点击编辑请求恰一js/css；SRI篡改、404、15s超时、apiVersion错各回textarea；原始页面仍可提交。

- [ ] **3.2 loader最小实现。** 可用token+initialized之后才启用Edit；只用户点击时同源link/script带integrity与crossOrigin='anonymous'；CSS和JS均成功且module.apiVersion===1才mount。超时dispose script/link监听并保留draft；后到旧promise不得覆盖后续实例。mount失败await销毁临时owner，恢复同raw fallback，不提前清after/base。只读无编辑自动加载。SRI失败文案采用主spec；不把错误堆栈或URL fragment展示。

- [ ] **3.3 host状态桥与唯一用户submit编排。** loadDraft返回当前固定lineage的同一live Draft对象（同realm，不另建正文镜像）；saveDraft(liveLineage):Promise<Readonly<DraftV2>>进入同一atomic FIFO，实际轮到时clone该对象与同身份notes并写入，成功返回此次实际durable detached clone，失败ready=false并停止提交；成功后徽标刷新。Kit普通编辑只写after/editorFiles/annotationKinds，pending/送达控制字段由inline宿主唯一编排。队列捕获固定lineage对象，不能执行时读取页面当前draft。内联`browser.ts`现有显式提交handler（现有 freeze/POST/确认流程）是唯一orchestrator；kit UI只触发该用户入口，不在buildSubmission内或另一个监听器发送。handler以现有busy/lineage锁去重：已有pending直接重放exact id/body，跳过build/new-id/再次冻结；无pending才await handle.buildSubmission，检查lineage/snapshot仍匹配，然后在既有atomic队列合并**最新**draft并持久化pending（不能旧build snapshot覆盖后续after）。durable成功才调用一次host.submit。host.submit仅验证body/id等于durable pending、force版本检查（保留draft.snapshotId）、执行一次现有POST并返回结果；不freeze、不saveDraft、不rebuild、不清pending/previous、不另行重试。成功结果只由原handler沿现有atomic流程一次写submitted/lastSubmissionId、清匹配pending/previous；错误留原pending。flush/build期间lineage变化取消新包；飞行中后续after继续保留。普通saveDraft与pending/送达确认是不同必要事务，禁止两层重复冻结或双POST。fallback在同一个handler里走原组包分支，不能复制发送流程。现行notes辅助store/v1迁移/旧草稿导出保留；增强Critic草稿降级时不能直接作为fallback after提交造成漏抽取，应保留并提示恢复增强编辑器或导出。禁止为了fallback清Critic或重写用户字节。

- [ ] **3.4 E2 RED与实现。** My changes调用extract→propose，proposal层按真正binding定位，删除hunk无正文也提供侧边操作；hunk点击“撤销这处”重算当前proposal后从base恢复这处raw，访客批注重锚，orphan提示保留。调用owner.replaceSource/restoreContent进入同一undo历史，失败不安装；不可用旧hunk ID盲改。两处修改撤一处，提交raw须与独立构造的只改另一处expected严格相等。文件树点/批注数/只看改过从同draft派生；昵称本机保留，AI默认false，summary列每file blocks/annotations；receipt仍复用P2纯文本panel。

```ts
const base='第一句。\n\n第二句。\n'
const draft='第一句！\n\n第二句！\n'
const p=propose({path:'a.md',base,ours:base,theirs:draft})
expect(p.hunks).toHaveLength(2)
const next=revertGuestHunk({path:'a.md',base,draft,hunkId:p.hunks[0].id})
expect(next).toBe('第一句。\n\n第二句！\n')
```

- [ ] **3.5 durability故障矩阵。** build/preview调用host.submit=0、pending-write=0；首次显式点击仅一份pending事务+一次POST；双击同一flight只一次；pending重试build/new-id/再次freeze均0且id/body逐字相同；flush/build失败或lineage切换网络0次；冻结期间继续编辑after不被旧快照覆盖；frozen save失败网络0次；POST成功但IDB确认失败→refresh重试body字节相同；503/网络中断→重试同id/body；pending中继续编辑→送达后保留后续after；两file切换保存失败保留编辑面；v1旧snapshot无base只旧v1提交/导出；返回410禁新提交保留导出；receipt404待处理/403权限不足/410失效。伪造owner改动由真实主人propose标owner-annotation。

- [ ] **3.6 GREEN/提交。** 新Vitest+原browser.test+既有P2实际serialized脚本、新IIFE脚本；真实浏览器复查菜单hover、选择→批注、切file/Source/undo。每层证据单独命名，提交source/tests/CHANGELOG并记录SHA；自动事件不冒称真IME。

## Task 4: E3 rebase、撤销与Mermaid按需加载

**Files:** Create `src/share-editor/{rebase,mermaid}.ts`、`RebasePanel.svelte`和tests；Modifymain/contract/file-session/ShareEditor、browser旧稿按钮、build/check和bundle CSP，双CHANGELOG。

**Interfaces:**

```ts
export interface RebaseCandidate {
 old:DraftV2;next:DraftV2;
 files:readonly {path:string;proposal:MergeProposal;decisions:Record<string,HunkDecision>}[];
 removed:readonly string[];
 orphans:readonly {path:string;annotation:ProjectAnnotationV2}[];
}
export function prepareGuestRebase(draft:DraftV2,next:ShareEditorHost['snapshot']):RebaseCandidate
export function completeGuestRebase(candidate:RebaseCandidate):DraftV2
// complete拒绝任何pending conflict/orphan/removed尚未导出确认；旧draft不变。
// async handle.rebase返回applied/cancelled；永久记录沿用DraftV2及向后兼容的previous恢复元数据，不新增DB/store版本。
```

- [ ] **4.1 RED。** prepare用实际rebaseDraft对两句独立修改合并；同句双方修改保留conflicts；新snapshot缺path列removed，不从after静默删；批注exact不存在列orphan；BOM/CRLF两边未动字节不变；cancel旧对象深等；pending存在先要求发送/导出冻结包，不切base。真实fixture：old='甲。\n\n乙。\n'、draft='甲！\n\n乙。\n'、new='甲。\n\n乙！\n'→两处；old='甲。' draft='甲！' new='甲？'→conflict。

- [ ] **4.2 实现。** 每file先extractGuestAnnotations(base,draft)；用rebaseDraft({oldBase:base,newBase:incoming,draft:clean})迁clean，保留分享者Critic；guest批注用anchor(newClean,selector)定位，按raw UTF16降序重新插入现行Critic格式，重新计算exact变化后的annotationKinds hash；重叠或无法表达合法Critic的选区列入人工处理，不丢/拼坏；kind与message/lineage保留。冲突用proposal层+guest三选按钮，决定交compose；不能另写diff3。被移除file先导出完整raw，明确用户处理后才从新scope移除。

- [ ] **4.3 完成/撤销原子边界。** next.previous保存完整旧snapshot/base/after；saveDraft(next)完成后`installBaseline(nextInput,{policy:policyFor(newSnapshot,next)})`安装新authority；undo-rebase显式用previous目标snapshot+draft重建floor，不能省略options继承旧保护；mount失败回存old并留可恢复候选，不半装。已有previous时先完成提交或撤销上次rebase，不能覆盖旧撤销点；pending期间禁重复rebase。本机DraftV2.previous向后兼容追加可选 `annotationKinds`、`rebasedFrom`，迁移时保存旧值；undo rebase从previous恢复old及这些旧元数据，缺省字段按原v2默认值恢复，不凭当前snapshot重建旧base；同步spec§6.7本机草稿说明，wire不变。清previous只在成功提交本机确认后。重新加载继续看到事务故障恢复入口。

- [ ] **4.4 Mermaid RED/GREEN。** share-editor-mermaid IIFE独立注册 `NotemdShareMermaid.render(code:string,appearance:ShareMermaidAppearance):Promise<string>`，由browser实现host.loadMermaid，script load成功后返回该全局module；share模块不猜测/_kit URL。用现有mermaid-mini，安全strict且结果净化；普通文本页/只读页/_kit失败不请求；编辑有mermaid块或之后输入产生块才加载，切文件复用一次。仅manifest所列完整同源URL/SRI，CSS不运行外部字体/fetch；加载失败保留源码与提示。build检查主bundle无Mermaid副本，CSP明确列可选完整URL。

- [ ] **4.5 UI验收与提交。** browser实际点击旧稿“在新版本上继续”→四场景→逐冲突→提交新snapshot/rebasedFrom；“撤销rebase”后旧raw/base/sid完全恢复；无Mermaiddoc网络0次、有doc1次/SRI篡改不执行。focused tests、build、真实脚本、types通过再精确提交。

## Task 5: E4受控下载、安全received与token边界

**Files:** Create `src-tauri/src/share_guest.rs`, `share_guest/{archive,reader,store}.rs`；Modify `lib.rs`注册、`project_share.rs` received保护；Create `src/lib/share-guest/{types,host,link}.ts`及tests；主spec§13.2/§20按design修订，双CHANGELOG。不修改archive/source ZIP及Worker上传。

**Interfaces:**

```ts
export interface GuestLink {origin:string;slug:string;shareUrl:string;token?:string}
export function parseGuestLink(value:string,dev:boolean):GuestLink
export interface GuestInfo {schemaVersion:1;root:string;entry:string;origin:string;slug:string;shareUrl:string;project_id:string;snapshotId:string;
 contributorName?:string;lastSubmissionId?:string;
 files:readonly {path:string;hash:string}[];submitted:readonly string[];
 outbox:readonly {submissionId:string;body:string;queuedAt:string}[];
 pendingUpdate:null|{snapshotId:string;unresolved:string[]}}
export function guestCommand<T>(op:string,input:Record<string,unknown>):Promise<T>
// invoke('share_guest',{request:{op,...input}})
// ops open {origin,slug,shareUrl} => GuestInfo；inspect {root} => GuestInfo；
// read-base {root,path,snapshotId} => {markdown,hash}；token不传进Rust下载open。
```

Rust公开 `share_guest(app:AppHandle,request:serde_json::Value)->Result<Value,String>`；`GuestStore`限定当前Vault/received，不能让caller提供任意工作根；share_db凭据由TS Store保存于 `guest:<origin>:<pid>`，网络无token下载。重定向关闭（包含同源重定向也清楚报错，防隐式改host）；HTTP仅开发localhost，HTTPS无userinfo、query只接受分享路径所需且最终strip fragment，slug按Worker真实SLUG_RE。

- [ ] **5.1 先修确认入口解析RED。** parse支持原share URL/`notemd://share/open?u=...`，URL内username/password拒绝，非https拒绝（dev只localhost、127.0.0.1、[::1]若准许需与spec localhost统一），错误字符串不含原输入/token；hash只有feedback取token。确认之前不得调用guestCommand或任何fetch；无标题用“此分享项目”，不预取网页补title。

- [ ] **5.2 reader/ZIP RED。** `reader.rs`包含 `#[cfg(test)]`真实byte parser tests：注释内假project-data、script rawtext内假tag、重复id/重复属性/重复JSON键、截断/非法UTF8、错误type、转义 `\u003c`、BOM正文hash正确、512/513files、大小写path碰撞。archive tests用zip::ZipWriter生成小归档并手工变异central/local metadata，逐类路径穿越、symlink、未列条目、hash/CRC错、重复名、zip bomb、解压计数、额外本地entry、overlap。读取器只允许stored/deflate普通entry，逐entry限定字节并完成CRC。

```rust
#[test]
fn reader_rejects_comment_payload_and_duplicate_json_keys() {
    let comment=b"<!-- <script id=\"project-data\" type=\"application/json\">{}</script> -->";
    assert!(reader::extract_public_snapshot(comment).is_err());
    let duplicate=b"<script id=\"project-data\" type=\"application/json\">{\"snapshot\":{},\"snapshot\":{}}</script>";
    assert!(reader::extract_public_snapshot(duplicate).is_err());
}
```

运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib share_guest`；真实路径/fixture导致RED，不把编译环境错误当安全逻辑失败。

- [ ] **5.3 本机验证实现。** 按design §3.1确定性HTML tokenizer+serde duplicate-reject visitor；公开snapshot严格白名单字段、markdown/dataUrl需与hash/bytes相符，ignore presentation/script。V-before→reader→ZIP→V-after项目/snapshot相同、archiveReady true才接受；409未准备/410停止/identity mismatch/version race均不创建目标项目。流式计数HTTP reader≤25MiB/ZIP≤32MiB，无Content-Length同限。legacy内manifest与reader外snapshot同时一致，只允许精确2内部文件；原包无manifest走source验证，不降低清单完整性。

- [ ] **5.4 原子落盘/隔离。** 验证完成先写受管临时目录与base，再同目录rename到 `received/<lowercase hostname_port>/<pid>`；existing仅可信guest.json同origin+pid可转更新，其他目录即使空/只有用户文件也拒绝覆盖。每级symlink/文件类型/canonical containment验证；复用 `write_atomic` 的crate私有导出，不复制不安全实现；guest.json/所有base无token。源条目逐项复用现有validate_relative（`project_share.rs` 的 `validate_relative`），它已经拒绝.note.md/.notes.md、隐藏段、node_modules及凭据命名；恶意外部manifest含这些直接拒收，不改后缀、不扩大到关系索引重构；`project_share::source_root/source_path/create`及Vault-root引用解析拒绝received或其symlink别名，避免从Vault根把received再发布。复用现有Sync不相交保护模式，收到项目也不生成sync mapping。

- [ ] **5.5 GREEN与数据证明。** 临时Vault创建已有同名文件、symlink父目录、项目identity冲突、网络截断/版本换代都零覆盖；遍历全Vault文件断言不含fixture token；路径/源字节SHA逐项相等。运行 `project_share_` 针对received与既有Sync安全tests；Rust编译+TS link测试，提交精确source/tests/spec/CHANGELOG。

## Task 6: E4入口、项目侧栏、离线提交和回执

**Files:** Create `src/components/share-guest/{OpenShareDialog,GuestPanel}.svelte`及tests、`src/lib/share-guest/state.svelte.ts`/tests；Modify `App.svelte`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`菜单/冷启动、`src/lib/side-panel/registry.svelte.ts`, `src/lib/i18n/{zh,en,ja,de}.ts`、Task5 store/host/types、browser/bundle及双CHANGELOG。

**Interfaces:** 新ops `queue {root,submissionId,body}`先持久化、`deliver {root,submissionId,token}`按stored body网络POST、`receipts {root,submissionIds,token}`最多20并发≤4；token仅从app Store读，在IPC进程内使用且禁日志；若Rust插件Store可直接取键则只传root/id，仍不得自读凭据文件。`list`只枚举可信guest.json，启动时重试已有outbox。

- [ ] **6.1 入口RED。** 真onOpenUrl/冷启动queue/单实例转发对notemd scheme先parse并进入确认，绝不落旧openFile带URL日志分支；取消网络0次、确认后host与download相符。文件菜单“打开分享链接…”dispatch唯一`open-share-link`事件，设置dialog；read-only无token URL下载后侧栏明确只读/不可提交，不伪造token。网页编辑状态才有`notemd://share/open?u=`按钮，完整fragment仅深链携带，禁止console/analytics采集。

- [ ] **6.2 deep link注册/原生菜单实现。** Tauri plugins.deep-link.desktop.schemes=['notemd']；保留已装plugin，Windows/Linux按已有plugin平台API调用注册（正式实施时依实际安装API核对，不由app打开任意shell）。Mac核Info.plist CFBundleURLTypes；冷启动先暂存未处理URL待settings/Vault可用，再确认；getCurrent/onOpenUrl去重相同交付，避免两次导入。菜单翻译沿lib.rs现有menu_label与四语言字典，禁直接hardcode另一菜单系统。

- [ ] **6.3 侧栏与编辑。** registerSideView id='share-guest'，appliesTo只可信received项目的活动tab，GuestPanel展示base版本/状态、“提交修改”“检查更新”“我的提交”；打开文件复用openFile与前置file owner/Source/history，正常desktop adapters。Rich离线编辑→flush真实tab保存成功→读磁盘再组包；新增/缺失文件明确警告，不自动加入edits。ownerAnnotationsTouched需先显示数量与明确继续动作；不触发browser保护floor。

- [ ] **6.4 outbox RED/GREEN。** 仅用户明确提交按钮的host单一orchestrator使用Task1builder，client.kind='notemd'、app package真实version；纯build/预览不queue或deliver；首次queue durable一次后deliver一次，已有outbox直接deliver原body/id，不build/new-id/重复queue；UI双击以同一flight锁去重。queue拒绝body内pid/sid与base不一致、非法协议/超5MiB，write_atomic guest.json后才送；无网络/503/发送成功本机写失败重启重放同body；409保留outbox且可导出，不能生成新id悄悄重试。成功只移走匹配id，submitted去重保留200、lastSubmissionId更新，不清工作文件；用户后续修改保持。针对新body与pending同id不同字节拒绝。

```ts
// host.test：跨重启读真实临时guest.json，不用第二次重新build替代重放。
expect(firstRequestBody).toBe(persistedOutboxBody)
expect(restartedRequestBody).toBe(persistedOutboxBody)
expect(JSON.parse(restartedRequestBody).client.kind).toBe('notemd')
// 发送失败/409后工作文件和base SHA都与发送前相同。
```

- [ ] **6.5 两端共通结构/回执验证。** 同base+draft，browser通过真实handle提交和desktop通过真实GuestPanel提交；规范化只删除submissionId/client，其余逐字段相等（message/contributor同输入）；owner实际import/review→apply→receipt，receipt统计由P2生成，无正文。无网络/404/403/410界面准确，不清outbox/草稿；reply按纯文本。

- [ ] **6.6 真实native GREEN/提交。** Mac实际安装app菜单/外部deep link→确认→received打开→断网输入→重启→联网发送；AX/截图+磁盘SHA+HTTPbody证据。先组件/Rust/unit green再native，不用invoke stub宣称原生链路完成；Windows/Linux无实机保持未验状态/仅菜单fallback按spec，不宣称三平台注册完成。精确提交与双CHANGELOG。

## Task 7: E4版本更新、guest冲突与恢复

**Files:** Create `src/lib/share-guest/update.ts`/test；Modify Ruststore/share_guest、GuestPanel、`components/project-review/{HunkView,ConflictEditor}.svelte`及tests（Create `ConflictEditor.test.ts`、`HunkView.test.ts`），双CHANGELOG。

**Interfaces:**

```ts
export type GuestUpdateAction =
 | {kind:'write';path:string;expectedHash:string|null;content:string}
 | {kind:'copy-base';path:string;expectedHash:string|null}
 | {kind:'delete';path:string;expectedHash:string}
 | {kind:'retain-removed';path:string;expectedHash:string}
export interface GuestUpdatePlan {fromSnapshotId:string;toSnapshotId:string;
 actions:GuestUpdateAction[];conflicts:{path:string;proposal:MergeProposal;expectedHash:string}[]}
export function planGuestUpdate(input:{oldBase:Record<string,string>;
 newBase:Record<string,string>;work:Record<string,string>;
 fromSnapshotId:string;toSnapshotId:string}):GuestUpdatePlan
// ops update-prepare {root}=>已验证新base+旧base+work hashes（不写工作文件）；
// update-apply {root,plan}=>pendingUpdate；resolve {root,path,expectedHash,content}；
// update-finish {root}：所有journal行确认后更新guest.json.sid/files并清旧base。
```

- [ ] **7.1 RED。** 真实propose(old,new,work)→theirs-only接受，不复制diff算法；同句冲突零写；删除unchanged可删、删除changed保留；新文件撞未知工作文件写`.shared.md`，若该名也存在用`name.shared-2.md`且collision检查不覆盖；大/小写折叠collision在磁盘同样保护。更新期间外部改工作文件expectedHash失配→停该文件保留其它journal进度。

```ts
const p=planGuestUpdate({oldBase:{'a.md':'甲。\n\n乙。\n'},
 newBase:{'a.md':'甲？\n\n乙。\n'},work:{'a.md':'甲！\n\n乙。\n'},
 fromSnapshotId:'S1',toSnapshotId:'S2'})
expect(p.conflicts.map(x=>x.path)).toEqual(['a.md'])
expect(p.actions.filter(x=>x.path==='a.md')).toEqual([])
```

- [ ] **7.2 journal与CAS实现。** TS planGuestUpdate只对markdown运行内核；附件用Rust已校验新base bytes：旧工作hash==old base→copy-base，新附件无目标→copy-base，已被本机改动则保留并列人工选择（保留本机/采用新附件），绝不把binary转UTF8或空字符串。copy-base只从当前pendingUpdate.snapshotId受管base取对应path；无caller byte payload或任意source路径。新增附件同名冲突也用唯一.shared后缀保留原文件。 `.notemd/update-plan.json`只保存from/to/每path expectedHash/resultHash/action状态，任何写前durable intent；实际安全路径write_atomic/CAS完成再标row。pendingUpdate.unresolved列冲突及失败文件；crash后按hash判断未写/已写/用户改，不用重新propose覆盖用户内容。old base保留到全部文件明确完成；新base下载完整校验后才stage；outbox非空不切换sid。新增未知文件只保留/提示，不因新manifest掉scope而删除。

- [ ] **7.3 guest UI最小扩展。** HunkView/ConflictEditor新增 `mode?:'owner'|'guest'`默认owner，guest标题“分享者版本/我的版本”，仅ours/theirs/edited三种；按钮直接commit对应真实HunkDecision，edited source='human'；不显示owner批量接受/拼接两版/风险采纳的无关文案。每fileconflicts全decided→compose→guest resolve(expectedHash)，不是ProjectStore::apply（这是received访客副本，主人原件仍唯一apply）。owner既有5按钮回归不变。

- [ ] **7.4 真更新验收。** 主人publish S2→访客检查→new ZIP严格验证→clean自动合并/冲突原file不动→选三种各一例→finish后guest.sid/base切新；中断每个write-before/after、guest.json完成前后，重启恢复不丢old base与用户文件。提交新建议snapshot=S2、baseHash来自S2、lastSubmissionId供supersedes；旧outbox仍存在不能误提交新sid。

- [ ] **7.5 GREEN/提交。** new update Vitest、guest Rust、ProjectReview/HunkView/ConflictEditor现有及guest tests；原生同名文件/冲突保存/重启验证，独立记录source/base SHA；精确commit。

## Task 8: 两端完整验收、版本打包与发行证据

用户2026-10-14追加发布顺序：完成实现与必要验证后，**先推送并部署Worker**，确认实际线上版本/100%部署与受影响路径，再发布应用；仍包含全部未发布宿主/插件更新。此前授权继续有效，不重复询问。不提前将未完成的E1–E4或本地提交当作已发布。移动端真实中日IME继续保留待验。

**Files:** Create `docs/superpowers/reports/2026-10-14-project-share-e1-e4-verification.md`（报告内逐次记录真实执行日期，不以文件日期冒充验收日期）、新增native/browser recording脚本；Modify双CHANGELOG与正式spec已核修订。版本/发布文件仅root冻结release时改，不能本规划提前填写将来版本号。

- [ ] **8.1 冻结证据输入。** root记录core/host完整SHA、installed package所有export JS/DTS实际bytes、fixture Git blob SHA、kit manifest/assets、Worker待验commit。保存argv/cwd/tool session/退出code、操作输入与日志；不覆盖先前失败。read-only inventory主/所有worktree dirty/untracked、未合入commit/stash、补丁等价；逐项范围，所有用户要求的未发布更新包括LatestCreated10项按tag实际hunks核验。

- [ ] **8.2 顺序检查。** focused都通过后仅一次host完整Vitest→share-merge purity→strict new-test tsc→svelte-check→受控empty-envDir完整build→existing/shared kit checks→Rust相关全集→Worker相关全集。任何非零停止依赖的stage/commit/package；最终root指纹变则只重跑受影响层并诚实说明范围。不得pnpm自动install或换Wrangler。

- [ ] **8.3 真实网页用户链。** 已构建IIFE+真实Worker本地或隔离fixture：主人实际冻结发布approved两Markdown+附件→只读无kit/匿名download字节一致→编辑Rich/Source来回、slash/table/math/note→撤一hunk→submit→真实主人review/apply→receipt→新publish→rebase/cancel/undo→export。截图/网络/body/磁盘SHA四类证据闭环；mock只用于明确故障注入，不能替代全链。

- [ ] **8.4 真native/IME矩阵。** Mac在真正Tauri app Rich与Source：中文拼音/日文假名在段落、列表、表格输入；候选窗Enter/Esc/方向键、切Mode、undo/redo、立即保存/关闭/重开；核未触块raw SHA与一次完整输入不丢/重复。Safari和Chrome同矩阵；iOS Safari/Android Chrome接入真实设备后同验。记录OS/browser/IME/app版本、操作录像/截图及raw结果。当前无iOS模拟器/Android连接就把相应行写“未验收，E1完整跨端验收仍未闭合”，不以Playwright mobile viewport或composition dispatch填通过。native deep-link必须从外部浏览器/OS启动链验证，不能只调用组件函数。

- [ ] **8.5 免费Worker新路径生产证据。** root按现有Wrangler3/Account Token与deploy-worker渠道，确认main push触发的run完成，记录commit→Worker version→100% deployment；不把较早手动deploy version当持续有效。只上传合成非用户内容：HEAD404→PUT→HEAD/GET exact hash/SRI→重复PUT200、8MiB边界及HTTP错误；使用既有CPU验收机制记录新路径免费预算，超限停并回报不升套餐。旧free-upload reseal/status-cleanup各10ms且strict<10ms未过单独列遗留，不能被本批新路径green清掉，也不扩大成本批上传重构。

- [ ] **8.6 版本/安装包冻结。** root选实际发行日日期版本（当前base 6.1013.2，不预承诺6.1014.1），package.json/tauri.conf/Cargo.toml/Cargo.lock/app Info.plist/client.version一致；`MERGE_KERNEL_VERSION`不变（本批不改算法），ShareEditor apiVersion1/documentEditor apiVersion2各守边界。沿既有scripts/release.sh双架构签名、公证和updater验签；该脚本包含git fetch/push与secret加载，不能当普通本地build运行，正式外发按root已有授权和spec I11产品不自动push边界分别记录。发布脚本git行为是维护者发行操作，不可混入产品guest功能。

- [ ] **8.7 frozen tag→产物→公开回读。** 从tag实际源码核Task1–7及所有点名未发布更改；资产SHA与kit manifest对应安装包内字节，实际安装app点分享后上传正确kit；Mac Info.plist scheme存在；GitHub Release两dmg/tarball/sig/latest.json匿名下载并签名验证；Worker匿名获取kit字节与SRI、页面descriptor/hash相符。旧kit继续可访问，旧分享和v1建议仍工作。各平台未验/CPU遗留分别列出，不称“全部发布验证通过”。

- [ ] **8.8 结果回顾。** 报告列已提交SHAs、实际release tag/asset/Worker version、已验矩阵与未验边界；tasks/todo只由root更新实际勾选及review；未发布变更不得写成已进入安装包。没有真native/IME证据的对应能力保持未完成，继续独立完成可推进项，不反复要用户确认已授权范围。

## Spec Coverage / 自审映射

- §10 kit/现有P2：Task2；§11版本、旧稿、freeze、receipt：Task3/6，已有P2仅复用。
- §12.2资源/CSP/SRI/build：Task2/4/8；§12.3接口：Task1/3；§12.4 I7：前置+Task1/8实际产物；§12.5/12.6批注/组包：Task1/3/6；§12.7 rebase：Task4；§12.8 E2：Task3；§12.9能力/IME：Task1/4/8。
- §13.1入口：Task5/6；§13.2下载/base/隔离：Task5（正式修旧ZIP条文）；§13.3离线submit：Task6；§13.4更新：Task7；§13.5receipt：Task6。
- I1/I6/I7跨Task1–8原byte断言；I2主人仍原apply，guest只能received；I4纯内核；I8 Worker只运输；I12/I13纯文本receipt与净化；I14不自动verified/关系提升。
- 已有前置实际 mount 合同与逐 Task 受理记录；最终冻结 SHA/phase 见上方与前置报告。仍未证明：E1 实际 IIFE 的该合同消费、900KiB 实测、免费 /_kit CPU、native 跨平台 scheme、相应真实平台 IME、发布 tag 包含性。前置证据不能替代后继交付验收。

## 每Task精确验证入口（实施时顺序执行，不在本规划运行）

所有命令cwd为HOST，Worker使用现有--dir worker。Playwright脚本必须从已发现的安装路径设置PLAYWRIGHT_MODULE；不npx下载。前置installed package与源码SHA由root固定。

| Task | focused命令 | 第一生产者→消费者/收尾 |
|---|---|---|
| 1 | `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/lib/project-share/guest-submission.test.ts src/share-editor/owner-policy.test.ts src/share-editor/media.test.ts src/share-editor/file-session.test.ts src/share-editor/main.test.ts src/lib/i18n/store.test.ts src/lib/slash-menu/slash-items.test.ts` | builder+E1 main→Task2/3；新增main.test实际mount前置owner，不fake EditorView；精确commit，记录未打包 |
| 2 | `env pnpm_config_verify_deps_before_run=false pnpm --dir worker test -- tests/kit.test.ts tests/project.test.ts tests/receipt.test.ts tests/feedback.test.ts`；host `pnpm exec vitest run src/lib/project-share/editor-kit.test.ts src/lib/project-share/host.test.ts src/lib/project-share/bundle.test.ts` 同加env前缀 | descriptor/build manifest→Task3；受控build成功才 `node scripts/check-share-editor-build.mjs` |
| 3 | `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/lib/project-share/browser.test.ts src/lib/project-share/bundle.test.ts src/share-editor/changes.test.ts`；`node scripts/check-project-share-browser.mjs`；`node scripts/check-share-editor-browser.mjs` | inline Host/IDB+真正IIFE→Task4；先build后browser，不自挂假module |
| 4 | `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/share-editor/rebase.test.ts src/share-editor/mermaid.test.ts src/share-editor/file-session.test.ts`；build后新browser脚本 | 完整Handle.rebase/Mermaid→最终API冻结；previous恢复元数据向后兼容 |
| 5 | `cargo test --manifest-path src-tauri/Cargo.toml --lib share_guest`；`cargo test --manifest-path src-tauri/Cargo.toml --lib project_share`；`env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/lib/share-guest/link.test.ts` | GuestStore/open/read-base/GuestInfo→Task6/7；spec ZIP条文同步提交 |
| 6 | `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/lib/share-guest/host.test.ts src/lib/share-guest/state.test.ts src/components/share-guest/OpenShareDialog.test.ts src/components/share-guest/GuestPanel.test.ts`；Rust share_guest | outbox/deliver/receipt/入口→Task7；native菜单/深链独立实际recording |
| 7 | `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/lib/share-guest/update.test.ts src/components/project-review/ProjectReview.test.ts src/components/project-review/ConflictEditor.test.ts src/components/project-review/HunkView.test.ts`；Rust share_guest | GuestUpdatePlan+CAS/journal+guest choices→最终两端链 |
| 8 | `env pnpm_config_verify_deps_before_run=false pnpm test`；`env pnpm_config_verify_deps_before_run=false pnpm run check:share-merge`；`env pnpm_config_verify_deps_before_run=false pnpm run check`；`node scripts/check-editor-kit-build.mjs`、`node scripts/check-share-editor-build.mjs` 在受控build之后 | 每层保存真实exit；strict测试tsconfig由root按最终新增测试集合在本轮执行OWN创建 `tsconfig-share-delivery-tests.json` 并运行 `env pnpm_config_verify_deps_before_run=false pnpm exec tsc --noEmit -p "$DELIVERY_PLAN_OWN/tsconfig-share-delivery-tests.json"`；该文件为实施时新建，extends HOST tsconfig并保留实际ambient shims，以明确include覆盖截至本Task已创建的新TS测试，不假称现已存在 |

新增tests的文件责任归属已在相应Task；上述ConflictEditor/HunkView tests明确为Task7新建，旧组件只有ProjectReview.test.ts不能假称已有独立测试。每Task收尾执行root的精确allowlist diff-check→commit流程，提交号写实施报告，禁止git add .。

### API/接线自审补充

- Task1的pure `RebaseUiResult`和最终Handle只定义类型，运行时代码不import Task4文件；E1 module明确返回E1 handle，无rebase方法，不以空实现假通过。Task4才实现并收紧返回类型，最终v1验收检查全部方法实际可调用。
- Task1的popup/slash共用消费者需在file-main的私有真实view上运行；ShareEditor不能新造EditorView或绕过owner。当前 `RichEditor.svelte` 的 `executeSlashItem` 在 fileSession 分支已调用同一 owner.executeSlash；两 dispatch 的旧实现仅留在 legacy 非 file 分支。E1 提取识别/选择/IME/菜单 UI 接线并消费已有原子 producer，不迁回 legacy 两 dispatch；Task1把同一选择/IME/菜单接线提成 `src/editor-kit-v2/file-menus.ts`（新增），由file-main首次消费并暴露 `menus:{openSlash():void;closeSlash():void}` 界面控制，实际命令闭包持有view、不导出raw权限。失败用真实consumer证明没有丢slash或半次结构保存；前置 bindings Task2 已交付并逐 Task 受理 executeSlashCommand 的窄同步 collector：逐笔tr.before/tr.docs一致、原Steps依序保留，selection/storedMarks/真实metadata验证，root+append完整链只准入一次；前置 bindings Task3 的 owner 已委托，该 UI 只消费。若实际受理产物缺少该能力即前置不满足，不在share shell私造serializer/撤销栈。异步popup/import准备完成后重新验证authority/generation/selection/slash字节；无真实同步producer不能先删slash或cast假view，保留原scope并列formal接线验收。UI直接复用SlashMenu渲染与common条目，禁import整个RichEditor（含tabs/Tauri）。此额外seam是源代码核实得到的必要接线，菜单 UI first producer 为交付 Task1，交付 Task3 仅消费完成的 mount。
- theme来自现行`browser.ts` 写入 reader/article 的 data-theme；增强root也取同一个presentation.themeId。任何整页默认theme替代都应使两主题computed-style验收失败。
- Task4新增 `previous.annotationKinds`、`previous.rebasedFrom`只用于本机可逆恢复，序列化v2建议包不得携带它们；旧DraftV2缺字段继续可读。Task1不提前依赖这两个字段。

## 冻结实施与证据约束

- CORE 主入口预算沿前置最终裁定：Node 默认 gzipSync ≤104448 bytes；分享主 IIFE ≤900KiB 独立不变。不得通过搬出口、stub、CDN、第二factory或不实产物图规避。
- 同时只有一个产品 writer；每Task fresh implementer + combined spec/quality reviewer，fix1–3回原writer；最后唯一全阶段final及最多一次合并finalfix/scoped复审。ROOT不直接修产品。
- 当前唯一工作证据目录 `.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery`。所有gate保留实际argv/cwd/exit/stdout/stderr及tool lifecycle；pnpm关闭隐式安装，build使用空env，只有最终正式发布由ROOT受控加载凭据。精确stage/commit；不改无关dirty/stash/untracked。
- CORE修改仅已批准M0源、公开纯类型、测试/文档与真实dist；package/依赖/锁不变。提交/审计后才能受控安装，明确实际上一installed SHA，不用阶段BASE猜前驱。不直接复制node_modules或清理未知产物。HOST package build脚本仅Task2按合同更改，依赖变更必须先核需要，不能静默安装。
- saveDraft返回实际durable detached clone，固定live lineage FIFO和baselineIdentity复用已有实现；普通保存不写pending/previous，build API不提交。两端只有用户显式提交编排耐久pending/outbox和网络一次发送。
- M0显式MermaidLoader、三身份pending/完成cache、SDK默认行为迁移、来源/UI生命周期见正式Mermaid设计；Task1不实现E3 preview，Task4首实现独立SRI模块。
- 主spec已同步source-only ZIP、外部reader清单、真实file源码合同、批注floor局限、精确保存回执和纯build边界；I7语料/判据、禁令、平台能力、900KiB预算未放宽。
- 免费CPU旧10ms遗留保持失败。Task2只实现kit运输，不顺带盲改上传状态机。Task8先按当前冻结部署复测small；若仍失败，停止依赖的线上验收并基于保存的真实事件重新规划最小等价控制JSON读取优化，方案线索在selected-input/free-worker-cpu-preflight.md。任何此类产品修补须独立记录/审查/重新部署验证，不提高套餐或门槛；其余独立实现继续。
- 实机缺证逐行保留，不用合成composition替代；用户明确移动端保留待验，不重复询问。正式发行说明必须列明未验和失败项，不能称全平台通过。


Ruling: Task1 M0 追加具名迁移 CORE src/__tests__/code-language-producer.spec.ts 的 routes exact renderer language 参数化用例：仅给该真实 NodeView factory 显式注入测试 MermaidLoader，保留原 language attrs、大小写精确识别、preview/edit toggle、raw roundtrip 和零 docChanged 断言，不将预览预期删掉。ROOT 已读实际用例及 t1-m0-full-tests 原日志：1506/1508，旧mermaid无loader预览断言与已批准M0默认迁移矛盾；另一失败是新测试把copy按钮SVG当预览，应修准确DOM选择器并单列fixture错误。成本是一处具名旧fixture接线迁移；生产能力不扩、原失败保留，新增strict include/精确allowlist，修后覆盖并重新CORE full/type/build/artifact通过再提交安装。

Ruling: Task1 在既有 FileMountWiring 新增内部 styles?:'host'，只在明确指定时跳过 injectKitCss；默认及既有独立Kit沿原CSS注入，externalSource不冒充为分享模式。ShareFileSessionOptions可选透传该内部选择，只有本Task ShareEditor显式指定host，由reader styleHead及share-editor.css提供样式。ROOT核实际file-main/kit-styles后确认现行自动link会引入editor-kit-v1.css，与分享冻结正文主题/字体闭包冲突。须先真实mount RED，后断分享无该link且内建Source/几何/proposal/正文主题保持、缺省Kit仍CSS一次加载，不改已有持久化ACK/Source逻辑。成本是最小宿主样式所有权接缝；不扩公开ShareEditor API、不关闭资源门槛，实际两主题/字体闭包仍由Task2/3验。


Ruling: Task1 同步纯builder使用既有 share-merge/hash.ts 的 sha256Sync；计划示例误把公开async sha256Hex的Promise当字符串，ROOT已核其实现仅return sha256Sync而无其它差异。只修精确import/fixture及kind hash调用；propose沿既有对象参数补path，使用{path,base,ours:base,theirs:clean}。不改内核公开API、不新算法、不把builder改async；测试可await公开sha256Hex对照同输入。成本是纠正计划接口笔误，原错误运行分列工具/接线失败不当业务RED；真正builder行为RED/GREEN另证。


Ruling: Task1媒体限制在share-editor/media.ts内以真实PM Plugin提供image与html_inline NodeView，ShareFileSessionOptions仅追加plugins?:Plugin[]透传既有FileMountWiring.plugins，保持CORE schema和唯一factory不变。ROOT已核schema.ts：远端image直接img.src，video直接src/load，audio/source经部分resolver；这些HTML媒体均在html_inline，html_block原本只pre源码。故仅bundleMediaResolver不能实现原Task1自动外部资源零加载合同。共享viewer只把确认附件映成data image，html_inline显示原源码而不创建活跃媒体；需真实factory证明这些NodeViews确实优先消费，不仅单独测试helper，并覆盖Markdown远端/协议相对、本机/fileURL、HTML img/srcset/video/poster/audio/source零请求与批准附件显示、Source/raw/history保持。成本是分享端窄NodeView装配与纯plugin透传，不改普通桌面媒体、不增解析器/serializer，不能事后MutationObserver补救已发请求。


Ruling: Task1 main 的 owner observer 除派生徽标，还须短防抖复用既有 ShareFileSession.save 完成停留编辑的耐久保存；不得另造 ACK/FIFO。ROOT 已核 main 当前只有 build/switch/close 保存，ShareEditorHost 无另一个 onChange 入口，故仅停留编辑会缺耐久保存。计时器捕获实际 session/lineage，在途保存后的继续输入须再次排入，切换/关闭取消本 timer 并由原 close 保存；失败保留 raw 并明确提示且可重试。加实际 Source 输入→durable save、失败留稿以及 pending/submit 零副作用测试，重跑受影响 main/types/UI。成本是一处必要生命周期触发器；不改 wire、不重复持久化协议，HOST 全套4695此前结果据原输入如实保留。


Ruling: Task2 允许新增 scripts/share-editor-assets.mjs 并在 vite.config.ts 与 vitest.config.ts 复用 virtual module resolve/emit 接线；必要TS声明优先现有声明文件（实施时核真实路径并报告）。ROOT已核原两配置和host.test：host新增虚拟manifest import需要测试模块解析，独立脚本避免重复构建规则。生产build缺manifest必须失败，emit读取冻结真实bytes；仅测试配置明确提供mock，真实build/hash/graph/evaluate不得mock或自动fallback。成本是最小构建与测试装配文件增加，不能掩盖漏打包；仍不安装依赖或改CORE。首次worker测试命令脚本参数实际跑488全量，按真实输出保留，不作仅focused描述；后继同输入不重复全量。


Ruling: Task2保留现有share-editor.css，不把完整kit.css/editor-base.css/KaTeX CSS追加到分享包。ROOT已读实际kit.css（CanvasText/Canvas）、editor-base（高特异性hljs色等）及presentation.ts:inlineMathCss/themedStyleHead；真实reader已有同一KaTeX woff2内嵌与冻结正文主题，重复导入会增加字体副本并可能覆盖冻结正文颜色。Task2检查实际资源hash/SRI/图与CSS url只允许data或fragment，主JS预算照验；真实reader字体glyph/无font网络/两主题及必要编辑结构样式在Task3闭合，不能以当前空字体CSS检查冒称已验。若Task3真实测试暴露结构样式缺口，先按实际必要控制/几何确定最小共享样式接线，保持正文font/color/lineheight来自冻结主题，不直接全量覆盖。成本是UI样式闭环明确落在本来负责真实reader的Task3，Task2不额外复制KaTeX或提前称可交付。另批准新src/share-editor-assets.d.ts纯virtual module声明，原vite-env.d.ts不存在。


Ruling: Task2修复完整Worker tsc暴露的5处原类型缺口，而非skip/加DOM lib。ROOT核原错误、file-contract/contract/project-share types/receipt/tests/env后批准6处：新增纯file-recovery.ts只type-import RootIdRow维护同一个FileRecovery；file-contract import/reexport保留公共接口；project-share/types只引用纯recovery模块，隔断Worker类型到HTMLElement的UI边。receipt.ts TextDecoder明确ignoreBOM:false（当前默认），ROOT实际Node plain/BOM/Unicode对比记录root-task2-decoder-default-check，Worker现有receipt测试再覆盖实际runtime。worker/tests/env.d.ts引用真实Vite ImportMeta类型；receipt.test仅headers参数/矩阵显式Record<string,string>，不变断言、不增加any。成本是纯持久化类型独立维护点及最小类型声明修补，公开shape/协议/JSON行为不变；若错会由Worker全tsc和kit/receipt/feedback、HOST相关与累计strict捕获。保留最初7错误，新Task2两条已自行修；修后全tsc成功才进入依赖build/提交，不另重复无关完整488。


Ruling: 更正紧前Task2纯恢复类型新文件名为file-recovery-contract.ts；ROOT已核file-recovery.ts原本存在且承载recoveryFromSnapshot/acknowledgeSaved，不能覆盖或改成纯类型。新路径原不存在，其他5处接线及原FileRecovery shape/导出保持。成本只为避免撞名，不扩实际功能；原裁定保留并由此明确替代文件名。


Ruling: Task2真实模块图属于构建证据，不是运行资源；ROOT已读plugin generateBundle把绝对模块路径JSON emit最终dist，writer确认并先冻结a46cc2a81fa908bfa097107e71261d0ed373b05e。批准追加精确修补：独立build写/dist-share-editor/share-editor-modules.json并.gitignore仅该构建目录，JSON绑定{jsSha256,modules}；checker显式graphPath（默认对应独立build），断主JS实际hash与graph相同并仍检查无Tauri/Mermaid。插件不读取/emit graph，最终app dist无该证据文件；fixture更新shape和stale/mismatch负例，OWN受控脚本传明确当轮graphPath。成本是私有构建证据格式/参数调整及一个精确ignore项，运行manifest/js/css和预算不变；旧真实emit证据保留，新build/check/probe/相关checker测试与strict覆盖，Worker和业务无改不重复完整层。初审仍取Task2原BASE覆盖全部提交。


Ruling: Task3 bundle.test.ts旧整份HTML不得出现editorKit的断言，精确迁移为解析project-data后的editorKit为undefined；ROOT已读实际payload helper与新增loader引用data.editorKit。合同要求无descriptor且沿原CSP，不禁止内联能力探测源码出现属性名。保留原精确CSP断言、无descriptor实际reader零资源请求验证及最初273/274失败记录，原writer修改并重跑受影响层。成本是纠正旧断言层次，不弱化无增强资源及CSP边界。

Ruling: Task3实际reader结构探针已重现whiteSpace=normal、range/point伪元素content=none，截图另有任务项缺checkbox、代码工具栏占两行。批准原writer从editor-base.css精确抽取必要编辑结构到新src/styles/editor-structure.css，由editor-base.css和share-editor.css共同import，单一维护点。范围限定root pre-wrap/overflow/outline、links cursor、批注高亮与badge完整交互几何/content及其控件色、task checkbox伪元素与定位、code wrapper/toolbar/buttons/icons必要几何和控件样式；正文pre/code字体、行高、语法色及通用背景留原主题路径，普通列表与表格已正常不扩。不得整包导入kit/editor-base/KaTeX；抽取保留普通宿主相同声明/优先级语义，若拆分控件与正文背景须证明冻结主题无覆盖。成本是共享样式单一来源变更，须真实reader两冻结主题/深浅色及Source切换、标注可点/checkbox/代码工具栏、KaTeX字体零外部请求与原宿主/Kit视觉回归验证；原RED保留，最终IIFE重建并绑定新hash/SRI/预算。


Ruling: Task3精确durable ACK校验设在main.buildSubmission显式组包门槛，不改变已受理file-session普通save返回/过期ACK不推进的语义。writer首次在save直接throw引发9旧合同回归，应恢复而非迁移旧测试。既有合同要求提交前确保持久化且不丢在途编辑；核对实际durable对象和当前snapshot/lineage/raw，不以ready布尔或旧snapshot代替。成本是正确分层到提交入口，新增实际build失败RED/GREEN并回归main/file-session，保留首次失败。


Ruling: Task3 fallback增强批注保护不得依赖可失效/删除的editorFiles缓存，也不能以after含Critic且整篇异于base广拦，否则分享者已有批注旁改普通文字也无法沿旧fallback提交。ROOT已核真实scanOwnerAnnotations为无外部运行依赖的纯scanner，bundle现有parser/zipper函数序列化接线。批准bundle导入同一scanner并序列化为projectShareBrowser第三参数，browser保持零runtime import；基础组包只在after的有效Critic raw多重集超出base相同片段计数时提示恢复增强编辑器或导出，pending继续exact replay。不得另造抽取器/修改原内核/新字段/改wire；真实RED为增强批注后降级并继续输入删除cache仍不得误发送，GREEN还须覆盖owner原注不变仅改普通句允许、重复owner超计数阻止、无descriptor旧fallback保持。成本是内联单一纯scanner几KB及三参数装配，需实际serialized reader和原P2回归、受影响类型/包/CSP与最终app build；旧丢批注/广拦临时候选记录保留。


Ruling: Task3 fix1 fresh scopedreview确认I1/I2关闭、无新Critical/Important；新Minor M1为挂载中请求b后初始化失败，fallback正文/tree保留a但URL仍b，真实probe无跨file写入/丢稿。按此实际影响接受Task3，M1交紧接Task4触及browser装载/导航时精确修：临时owner释放后统一协调目标，或明确保留当前file并同步URL；保持IDB失败raw/recovery和原pending/lineage合同，复用reviewer-task3-fix1-failed-mount-navigation原RED及当前loader probe，不为minor开启重复Task3完整审查。成本是短期本地候选URL不一致，正式发布前由Task4与唯一final核关闭，不将其静默留到发行。


Ruling: Task4已核真实API冲突：Task3普通saveDraft只接受当前owner live对象，而spec§12.7要求先耐久新aggregate再安装，并在失败/重载后恢复。批准ShareEditorHost新增可选transitionDraft(expected:DraftV2,next:DraftV2):Promise<Readonly<DraftV2>>作为明确rebase/undo/rollback唯一转换入口；普通saveDraft身份守卫不放宽。该入口复用同一saving FIFO，在实际槽内CAS核当前live expected、相同lineage/宿主project范围、禁止pending和不合法previous覆盖，原子写入成功后才交换browser及该host私有live引用；旧session/旧queue保存必须拒绝且不得覆盖新身份，不能把正常陈旧取消误写成当前新草稿保存失败。返回实际durable detached clone，installBaseline仍显式目标policy，双向转换均受同样门槛。成本是一个必要宿主事务seam，需真实save/transition竞态、失败前后零半安装与重载证明，不新增DB/网络协议或第二队列。

Ruling: Task4本机DraftV2允许追加单个可选rebaseRecovery:{snapshot:批准公开快照纯数据,candidate:Omit<DraftV2,'rebaseRecovery'|'pending'>}；使用纯类型维护点，不能类型依赖UI/Worker DOM，运行验证拒绝嵌套recovery/pending或无限previous链，内容/入口/path/hash/sid/project必须匹配已知公开scope，无token或新增权限。candidate中previous沿单层既有旧基线shape。next先耐久含完整old previous；install失败后尝试transition(next,old+recovery)，成功则reload显式恢复候选，回滚写也失败则IDB仍保留next+previous，reload提供撤销到old且next本身就是候选，不能冒称失败写入的old已durable。恢复只在匹配当前公开snapshot时安装；当前版本已变化则保留可导出候选并明确提示，不能丢弃/静默重基/自动提交。成功安装/明确取消按事务清理恢复记录，送达确认也不得留下可误用旧恢复点；不在建议包wire序列化这些本机字段。原writer同步主spec§6.7/§12.7及实际types/host合同后实施，报告列首次写失败、install失败、rollback写失败、清记录失败和reload各状态。成本是有界本机恢复元数据副本，用户原稿优先，所有原失败必须可回源。


Ruling: Task4独立Mermaid图中mini入口来源与实际输出须分别验证。ROOT实读当前node_modules/mermaid-mini/dist/index.js：仅export default/* from mermaid，无运行语句，合法tree shaking后不必保留在emitted chunk.modules。批准构建图在原emitted modules之外记录真实Rollup getModuleIds inputs，独立图整体绑定实际mermaid资源SHA；checker要求inputs含现有mini入口、emitted含真实share-editor/mermaid.ts及上游Mermaid库，仍核无Tauri/主editor混入与每资源8MiB，主IIFE仍无Mermaid且gzip≤900KiB。图只保留ignored构建证据不进app资源。成本是准确区分输入来源与实际输出，原过强gate失败保留，负例须分别证实mini入口缺失/真实库缺失/hash不符，不能改为只有输入图便冒称库已打包。


Ruling: Task4严格CSP构建失败来自三份已安装vendor源中的4处浏览器全局对象fallback，ROOT逐bytes核SHA/原语句：@mermaid-js/parser/dist/chunks/mermaid-parser.core/chunk-FOHPRMQF.mjs SHA5c83305b04a62463567bdf6d82d9ba9dfc3795e516d8cc848e6981504af48068（2处），cytoscape/dist/cytoscape.esm.mjs SHA485cbbede29dac6028e96c89a895b2e3cbe26abaf3457049a5913e0f8ad53451（1处），lodash-es/_root.js SHAdf58ff96c454ca91ace20d20e6af49b354c70dfba7e737adc00cd23e8ff77168（1处）。允许仅独立browser Mermaid IIFE构建plugin按精确module suffix+源SHA+逐模块计数把Function('return this')()及对应双引号字面式替换为globalThis；其语义仅为前置freeGlobal/freeSelf未命中时取得当前浏览器全局对象。不得改node_modules/锁/依赖/普通桌面构建，不做泛化Function正则消除；源/hash/次数偏离即构建失败。保留真实输入/输出图与变换证据，最终全AST禁eval/Function gate、实际diagram/CSP测试必须继续通过；未知动态代码仍失败。成本是三个已知vendor源的具名浏览器特化，后续依赖变动必须重新核对，不能把此变换扩为隐藏unsafe-eval。

Ruling: Task4不能把旧fallback sidecar批注非空一律禁止rebase作为完整兼容。批准ShareEditorHost可选loadAnnotations():Promise<readonly ProjectAnnotationV2[]>，prepareGuestRebase第三可选annotations输入，复用同一anchor/合法Critic roundtrip/降序插入流程，成功迁入新raw并在同atomic清旧sidecar。previous新增可选annotations保存完整旧sidecar，undo/rollback显式恢复；candidate.previous已带它，不增循环字段/DB/wire。transitionDraft第三可选参数使用明确对象{expectedAnnotations:readonly ProjectAnnotationV2[],annotations:readonly ProjectAnnotationV2[]}，分别表示转换前sidecar与目标sidecar；不凭next.previous推断每个方向的CAS。实际FIFO槽同时核expected live身份与当前sidecar逐值等于expectedAnnotations，原子写新draft+目标sidecar后才更新browser及host私有live引用，旧notes queue不得覆盖。未提供此参数沿原保留sidecar语义；Task4显式rebase/undo/rollback必须给准确双向数据。某条无法anchor/合法Critic表达沿existing orphan人工处理，导出保留原sidecar来源与完整内容。writer同步spec§6.7/12.7、纯类型与验收：forward/undo/rollback/reload、混合Critic+sidecar不重复/不丢、异步sidecar变化CAS拒绝、pending exact replay和旧v1/v2不回归。成本是既有两份本机草稿状态的必要原子协调，不另造批注抽取/合并算法或网络协议。


Ruling: Task4 fix1原reviewer message-race探针在核心断言前等待S1写入次数≥2，ROOT读原脚本确认这是等待已发现的错误状态；修复后不应继续满足该等待。保留原reviewer真实RED与原脚本，不重复同输入RED；允许复制为fix1 probe，仅把该等待替换为可证明转换及排队保存已完成的观测，保留同一IDB put间隙注入与durable S2/message断言，追加live/重载一致性。不得以固定延迟或仅UI成功文案替代耐久队列完成，不能改输入时机/禁用行为来让测试跳过。成本是验证fixture同步条件纠正，不弱化原产品要求，需报告原/新脚本精确差异。


Ruling: Task4 fix1普通fallback保存的有效owner按其lineage当前aggregate判定，不一律等于界面当前选中draft。ROOT已读browser.test.ts原queued input ownership回归：切到另一个lineage后，前一lineage已接收的排队正文和notes必须仍写回它自己的key；不能迁移旧expected掩盖丢输入。普通save在实际FIFO槽核drafts map内该lineage对象身份，当前选中时另核notes引用；同lineage rebase成功后map指向next，旧owner任务仍须拒绝，不同lineage仍有效owner可完成保存。增强host.saveDraft继续严格当前选中owner；message字段任务按捕获lineage的最新有效aggregate更新，不跨lineage转移。复用既有map/FIFO，不新增状态库；保留首次276中1失败及原测试，增加/复用同lineage stale与不同lineage有效两种证据。成本是区分编辑目标身份与界面选择，若错误会丢旧稿或回写旧版本，故两侧都必须验证。


Ruling: Task6只读API地图已核当前installed deep-link2.4.9和single-instance2.4.2源码；single-instance未启deep-link feature，选在既有callback显式使用已装DeepLinkExt/handle_cli_arguments（Windows/Linux，按真实单URL参数合同）并先排除notemd旧文件分支，不改Cargo feature/依赖。Mac沿已有插件RunEvent::Opened→onOpenUrl/getCurrent，注册只用配置生成产物，不对Mac调用不支持的runtime register。App先监听再getCurrent、统一暂存和同一次交付去重，等有效Vault后确认；取消后用户再次主动打开相同链接仍可确认，不做永久URL黑名单。所有入口先阻断带token URL的旧argv/path日志，保留普通文件打开行为。成本是既有平台API接线，Windows/Linux无实机只作编译/代码证据，Mac仍需真外部启动验收。

Ruling: Task6“唯一open-share-link事件”落在既有Rust menu-event的唯一menu id与App明确case，直接打开同一确认dialog；不另加CustomEvent/central command或强制cast未知CommandId，现有四语言menu_label与前端字典分别同步。guest side view复用registry，选right/order3，位于现有git-history之后，仅经Task5可信list/inspect缓存匹配活动tab时显示；appliesTo保持同步，不增第二侧栏。成本是明确最小装配与常规文档工具位置，不改变原菜单命令/现有侧栏顺序。

Ruling: Task6无token的“只读/不可提交”表示分享协作权限，不能据此把已公开下载的本机Markdown设为全局不可编辑；主spec§13.2明确公开下载不需token、§13.3明确使用桌面编辑器全部功能。侧栏应明确“只读分享/无回传权限；修改仅保存在本机”，禁queue/deliver/receipt，保留本机普通Rich/Source与保存；不扩isReadOnlyTab或改桌面owner policy。builder/预览不发送，真正提交仍必须凭据与用户明确动作。成本是区分公开副本编辑与线上协作权限，需用无token实际下载、编辑保存和零提交/回执请求证明，不把本地可写宣传为获得分享权限。


### Task5 审查后平台兼容裁定

Ruling: Task5 I2 的 mandated write_atomic 复用继续保留，但修复该共享实现并让 received 发布调用同一 crate-private 目录同步 helper；采用仓库 knowledge_structure/store.rs 已有平台边界：Unix 目录 open+sync_all 错误必须传播，非 Unix 不尝试不受支持的普通目录 File::open，并明确不保证目录项掉电耐久性。所有平台的文件 write/sync_all/rename 错误仍严格传播，no-replace/零覆盖合同不变，不引入新依赖或复制 writer。— Windows 普通目录 open 必然失败，既有 Unix 策略不能直接通用于 Windows；最小修复保留受支持的耐久性与原子可见性，而不伪造 Windows FlushFileBuffers 目录保证。— 如果平台假设不成立，需要补平台专用持久化 API；当前无 Windows 实机，Windows 掉电耐久及真实运行不得报通过。

iOS 的 share_guest 模块及 command 注册遵相邻 desktop-only cfg；无实机/SDK不得以桌面 cargo check 替代 iOS 编译证据。


### Task7 实际API与更新恢复合同裁定

Ruling: Task7 保持同一 propose({path,base:oldBase,ours:newBase,theirs:work})/compose 内核，但 guest 显式为所有 theirs-only 构造 accept decision，不使用会按 owner 风险 flags 跳过的 acceptUnconflicted；resolve 前核 pendingConflicts/pendingTheirs/staleDecisions 均空。expectedHash 取受控读盘原 bytes SHA，不取经过内核 alignEol 的 proposal.theirsHash。扩 SourceDiff 一个可选 currentLabel（默认当前原件），guest 两侧标题/aria 同步为分享者版本/我的版本，owner 默认行为保持。— 真实 API 与原简写/owner helper 不同。— 错误会丢本机改动或把 CAS 绑定归一后的文本，因此须覆盖 flagged theirs-only、BOM/CRLF 原始 hash、owner 五选项回归。

Ruling: Task7 copy-base action 允许明确 sourcePath（可信 pending manifest 的分享相对路径）与 path（受管目标相对路径）；Rust 验证二者及其匹配关系，不接受任意源路径/byte payload。碰撞另存需在 guest.json 增加向后兼容可选 workPaths 映射，仅记录分享路径→非同名工作相对路径；缺省同名。此映射是 received 本机身份记录，不进建议 wire/公开快照；Rust 验证来源属于对应 files、目标安全/唯一/无文件系统别名，并与更新 journal 一起耐久。后续提交按映射读工作文件但 wire 仍用分享 path，后续更新/删除/打开入口同样消费映射；原未知同名文件始终保持未知，不能自动纳入 edits，既有映射不每次生成新 .shared。— spec 要求保留未知文件又将新源另存，现有同名 key 无法维持两者身份。— 成本是一个必要本机路径映射及跨提交/更新接线，必须连续两次更新再提交证明源路径正确、未知文件 SHA 不变；错误会串稿，不能只验证第一次另存。

Ruling: Task7 附件人工选择使用单独受限 resolve-file {root,path,expectedHash,choice:keep-local|use-base}，path 指分享路径并由可信 workPaths 解到工作路径；use-base 只能从当前 pending manifest 取验证原 bytes，keep-local 仅记完成而不写文件。对于旧/新源均存在而本机工作文件缺失，保留缺失、列待人工选择同一 keep-local/use-base（expectedHash:null），不得把缺失当空字符串 propose 或自动恢复。选择保留删除后照现有提交规则忽略并提示缺失，不把删除加入 wire。— 文本 resolve(content) 不能表达 binary 或删除，用户改动优先。— 成本是窄 tagged 文件级选择，须验证两种附件选择、缺失两种选择以及 CAS 变化拒绝。

Ruling: Task7 hash-only update-plan journal 不保存正文，但写前先将文本 merge/人工 edited 结果以不可变原 bytes 写入受管 .notemd/update-results/<toSnapshotId>/<rowId>，file write/sync 完成后才耐久 intent（记录目标、expectedHash/resultHash、action/state 与受管结果标识），再执行工作路径 CAS 写入和完成标记。重启校验结果 bytes hash 后可重放未写行；工作 hash 为 resultHash 标完成，等于 expectedHash 可按同一结果重试，否则留 unresolved，禁止重新 propose 覆盖用户。全部完成并耐久 guest.json 新 snapshotId/files/workPaths 后才清旧 base 和本批 staged results；清理失败可重试不回滚已确认用户文件。— hash 本身不能还原尚未写入内容，原只存 hash 的计划缺恢复材料。— 成本是有界临时结果文件，与已验证快照/最大工作数据边界共同限制；要以 write-before/after 及 guest.json 前后故障证明真实恢复，而非假设内存仍在。


Ruling: Task6 每个 received 项目最多一个耐久 outbox pending；已有 pending 时只重放原 body/id，新的不同 id 拒绝入队，同 id 不同 bytes 同样拒绝。guest.json 使用读写一致 32 MiB 总上限，body 仍严格按 UTF-8 ≤5 MiB 验证，metadata/pending 数量和协议另作验证，不能将文件 cap 当 wire 放宽；32 MiB 保守覆盖字符串 JSON 转义与有限 metadata。允许原 share_guest.rs/store 增 list/read-work/check-version/queue/deliver/receipts 窄操作；Task6 检查更新只读公开 version 并显示有更新，不下载/改 base 或合并，Task7承接。— 原计划已要求既有outbox直接重放但未给容量；单pending最小且避免无限放大 guest.json。— 成本是离线时先送达旧提交才能产生下一份，UI须明确提示且保留新工作修改；测试5MiB及转义后重启读取、第二id拒绝、同id异bytes拒绝、旧包重放不读新工作稿。


Ruling: Task6 为6.5 producer→consumer验收扩允许范围至 src-tauri/src/project_share.rs 的 cfg(test) 一条实际主人 import/review/apply→P2 receipt 测试，以及 share_guest/fixtures/desktop-submission.json；fixture 必须由真实 GuestPanel 提交测试经生产 builder/队列路径生成并冻结，绑定生成命令与SHA，不能手写等价对象冒称真实UI产物。只新增测试，不改owner生产逻辑；fixture无真实用户内容/token，浏览器与桌面包比较只剔除既定submissionId/client字段，其余同输入逐项比较。— 原P2旧测试不能证明新增桌面生产者与主人消费端相容。— 成本是一份小型真实合成fixture和窄Rust测试，生成与后续回读SHA必须一致，版本值属于冻结样本而不能冒充之后发行包的client.version。


Ruling: Task6 允许追加 share_guest/fixtures/desktop-receipt.json，必须由同一真实主人 apply 结果经现有 buildProjectReceipt 生成冻结，再被原生 HTTP receipts 消费与组件纯文本展示测试直接读取；记录生成命令/SHA且断言无正文/token，不手写伪回执。— 上一裁定的真实提交fixture仅闭合输入，独立实际P2回执bytes才能闭合新消费端。— 成本是一份小型合成公共fixture及生成/消费身份校验；原canonical/source-binding测试设置失败保留，不当成产品逻辑RED。


Ruling: Task6 deliver ACK 的 post-rename sync 失败不能只靠一次尽力回写旧 GuestInfo：第二次回写也可能失败并丢掉唯一 pending。采用单个受管 .notemd/guest-ack-recovery.json 保存待清理的同一 Outbox 原包（无token），在清 outbox 前通过现有 writer 完整耐久写入；若准备失败，原 guest.json pending 不动。inspect/list/queue/deliver 统一读取并验证该恢复记录（project/snapshot/id/body与可信base一致、安全路径、有界、同id冲突拒绝），将其视作仍待发送，直到 guest.json ACK 写入成功并清掉恢复记录。ACK替换/同步或清理失败都保留可重放的耐久来源，不依赖再次写盘成功才能找回原body；重复成功重放仍为同id/body。成功仅移走匹配pending并保留工作文件与submitted去重，不新增服务/通用journal；恢复标记存在时新包和Task7切sid仍受pending约束。— write_atomic Err不能证明rename没发生，原硬门槛要求本机ACK失败后能恢复。— 成本是一份最多单包的短期本机恢复副本和读取协调；需真实替换后故障注入+重构GuestStore/重启读取原body、恢复写不可用仍可读原包、成功清理三类证据；底层介质全面不可读仍不能保证物理持久性。


Ruling: Task6 ACK恢复标记的清理采用 remove_file 成功即逻辑完成，不在 unlink 后新增目录 fsync 成功门槛；此时 guest.json 的 ACK 写入已经完整成功，掉电后若旧标记复现，只允许同 id/body 的幂等重放。inspect 的恢复协调为只读，即使目录不可写仍可取得原包；不为清理另造第二文件/阶段。— 删除后再以fsync错误报ACK失败会移走唯一恢复来源，垃圾回收无需强于已耐久ACK。— 成本是极端掉电可能多一次安全重放，不能承诺 exactly-once 或 Windows目录掉电保证。


Ruling: Task7 received更新必须将已打开普通Markdown的输入/保存与backend CAS/写后owner reload纳入同一有界操作；现有saveTab、owner.setReadOnly与reloadTabFromDisk(expectedContent)各自不构成完整边界。允许窄扩现有tabs/file-editor-sessions及其documentReadOnly/Source/watcher接线，复用markdownSaveQueues，不另造第二保存队列或通用锁框架。新base网络下载可先完成而不锁编辑；真正捕获工作稿并规划/写盘前，先取得按受管真实path的操作准入，await真实owner/Source/批注flush及既有保存tail，将原dirty精确保存，再在所有await后核tab/path/session/baseline/authority/raw仍一致。仅在这段写入窗口使对应Rich/Source及普通save/autosave共同识别临时不可写状态，原本readonly原因保留；内部准备保存使用明确受控通路，不能因临时readonly静默跳过持久化。操作期间到达的旧timer/save不能在CAS后写回旧稿；新增/关闭/切换tab或未决composition不能被忽略。写后从真实disk经原file owner安装baseline/history，检查各await后的身份与未接受draft；若无法安装或外部改动则保留原稿和可见冲突/恢复信息，不强制覆盖、不用旧稿补偿回写。成功或失败finally只释放本次操作状态；owner/Source读写能力恢复到原策略。只为guest调用提供此边界，不顺带重构旧ProjectReview工作流。
— 只做磁盘CAS看不到未保存输入，现成reload在await flush前检查一次会漏窗口，Source外部textarea也不由单独owner.setReadOnly控制。
— 成本是必要宿主基础保存接口扩展及针对性真实测试；必须以真实owner/Source与临时盘验证IME或popup未决时零CAS且保留输入、排队autosave/保存后继续输入、CAS成功reload、reload失败保稿、tab换代与能力恢复，不能用busy按钮或mock saveTab代替。无实际系统IME设备时仅称软件状态/合成事件验证，真设备项继续待验。


Ruling: Task7允许将update-prepare与新增窄update-read分开：prepare在无编辑锁时仅下载/验证/受管stage新base；update-read必须在tabs受控操作窗口、真实flush与保存后，读取可信旧/新base及当前工作原bytes/hash，才供同一TS内核规划。prepare期间任何先前work值不得当作apply写入依据；apply仍绑定同一from/to并逐文件CAS，恢复走相同受控窗口。接口不改公开建议wire/CORE、不接受任意caller源路径或附件payload。— 网络期间不冻结用户输入与规划前必须保存真实当前稿这两个要求不能由一次早期read同时满足。— 成本是一个只读内部op，需证明下载期间继续编辑会进入后续新规划，而不是被旧work覆盖。


Ruling: Task7 pendingUpdate允许附已验证新manifest路径元数据（向后兼容default），只供更新操作的保存/输入准入和目标枚举；来源、路径、数量沿可信snapshot校验，正文与原bytes hash仍在受控窗口内update-read取得。保存只涉及旧approved workPaths；新manifest路径撞未知文件时只能冻结必要输入/检查，不把未知稿保存或纳入edits。碰撞另存的.shared/-2目标除磁盘存在检查，还必须防已打开但尚未落盘的目标及窗口内重绑被覆盖；沿已批准的tabs统一操作边界处理，不能只把磁盘不存在等同于无人编辑。— 锁外读取工作正文会使计划过时，单看磁盘也看不到新本地draft。— 成本是小型本机路径metadata及实际打开未落盘目标回归，不改变公开wire或新增服务。

Ruling: Task7 fix1的原review probe保留原文件/原RED，新增wait-aware副本先在未修产品验证“旧SaveAs tail释放前更新callback不得进入”的真实RED，finally可靠释放旧保存，再修后GREEN并保留最终publisher S2原bytes断言。— 原probe故意await更新完成才释放旧保存，正确等待语义下会天然死锁，调度断言必须适应新增同步契约而不能削弱等待。— 成本是小型测试调度迁移，报告准确称同一场景新增准入时序回归RED→GREEN，不称原probe未经修改GREEN；生产保存合同不变。


# Task8 ROOT正式实施裁定

Ruling: Task8分为本地交付审查与真实外发两段。本地修改/必要验收/候选材料先Task8 combined review，再唯一whole-phase final及最多一次合并fix/scoped复审；ROOT随后先CORE main源码同步（不推CORE tags、不触发npm发行）、HOST main与Worker真实100%部署验证，再应用/相关插件发行。8.5–8.7外发复核及最终Task8完成只能在实际发生后勾选。— 避免“需先发布才能审查”的循环，又不把本地成功当已发布。— 成本是报告分阶段更新，任何未发/失败均明确保留。

Ruling: 发行仅对现有scripts/release.sh和真实Vite配置、现有资源checks作必要窄扩展，可有小型可测试helper，不建第二发行脚本/通用部署框架。允许ROOT提供精确untracked清单，仍拒tracked/staged变化和未知untracked，默认继续严格clean。保留六份无关文档/HTML及.pnpm-store缓存；不stash/搬移/删除/加入发布，cache不递归备份，六文档前后SHA与目录存在单独核。最终仍精确add原六版本/日志文件。— 既有7项文件会阻断原clean门槛，用户未授权收走这些内容。— 成本是一个明确可选的保留清单入口，必须有拒绝错误/额外路径的验证。

Ruling: HOST Vite/Vitest与Memory相应配置允许同一显式empty envDir入口，默认开发行为不变；本次受控调用核目录为空，传至嵌套双架构/retry build与Memory build，沿原share builder空env。pnpm禁隐式install不变。— 正式beforeBuildCommand当前裸vite会隐式读根dotenv，外部纯shell环境不足以阻止。— 成本是必要配置接缝及实际传递检查，不安装/升级依赖。

Ruling: 不实现release六gate receipt/skip/reuse协议。Task8本地软件验收照常，正式release.sh保留原六项强制门槛并在最终发行SHA、实际发行环境和当时依赖审计上执行一次；ROOT接受这一次有界重验，所有实际命令/退出记录。除此之外普通同输入回归仍复用，不mock git/pnpm或过滤失败。— 比给生产发布流程增加跳过分支、证据索引协议更简单，保留既有 fail closed 流程。— 成本是正式发版额外一次六门槛运行时间；不得宣传为此前同输入重复的必要功能证据。

Ruling: 每次正式架构构建/重试都核冻结share manifest原文与所列全部资源原bytes，候选改变即停止自动tag/push，不更新expected迎合结果。实际MachO中完整Brotli payload唯一匹配→取回解压→SHA/SRI与候选相等，配合同次build/depfile/cache身份，作为包内包含证据；实际tar/DMG内MachO与已核binary逐bytes相等才传递证明。该方法不宣称PHF选键/运行resolver已验，实际app正常分享资源仍另验；不得为验收开生产debug/RPC后门或扩大plugin协议。— dist自洽不证明两个发布包包含同一候选，现有codegen逐资源压缩已实际验证可读取。— 成本是窄只读包验收与额外资源副本，不造完整二进制解析器。

Ruling: 仅删除既有release.sh已知APPLE_ID明文输出；保持原签名/公证/私钥注入与Wrangler3+Account Token、R2包/签名→匿名验签→KV→公开复核通道。只有ROOT正式外发受控加载凭据，记录入口argv/非敏感结果，不打印env或展开带凭据命令。— 当前日志确有已知身份输出点，不能用全新凭据框架解决。— 成本是小型输出收敛；实际错误不能因脱敏而伪称成功。

Ruling: CORE .github/workflows/ci.yml的主入口预算同步至已批准Node默认gzipSync<=104448 bytes，其他type/tests/build/purity门槛保持；真实当前dist与超限拒绝逻辑验证，精确提交CI-only，不改预算/出口/package/锁/dist来过门槛。— 当前workflow仍81920和gzip CLI口径，与已受理合同不一致，不能明知CI必失败仍push。— 成本是一处CI合同同步，需区分新CORE仓库HEAD与源码/installed dist未变的字节证明，不无谓重装。

Ruling: 原生QA保留独立identifier、OSdeny真实appdata和全新合成Vault；空间仅20GiB时，不复制约16GiB新target，冻结源码后无其他cargo时串行复用现debug缓存并正常重编译核新binary。正式打包必须不带QA override，另核生产identifier/资源。允许仅QA前台临时选择已启用可选的测试输入源，finally恢复原源；每键核PID/TIS，不安装/启用源，遇第三方干预停止。— target不是数据隔离边界，而输入源准备是已授权真实IME验证必要可逆动作。— 成本是编译缓存切换与短时输入源改变，必须留身份/恢复/cleanup证据，不以工具probe代替产品IME。

本Task还须统一中英Unreleased实际范围和局限、Memory变更版本与包验收、引用已盘点release scope；不静默漏掉Latest10/Memory/Rich等用户点名更新。移动真实IME按用户持续指示待验，iOS编译/旧免费CPU等失败逐项保留，不能称全平台通过。原生cp首轮失败尚未归因，须先实际记录定位再决定最小产品修复，不通过重置文档/改期望消掉失败。

Ruling: Memory发布候选版本为2.5.3，按实际未发布UI改动同步manifest.v2.json和package.json；app日期版本仍由ROOT正式发行时决定。ROOT于2026-10-14T08:26:00Z匿名读取公开index，真实id notemd.memory最新2.5.2、包SHA92c74e85da3994641d494238d6c7b15bc0ffc072fb27126f772923bf71b392f4，未见2.5.3，证据task8-memory-version-scope.json/两个root-task8-public-memory-* gate。首次过滤简写memory无结果仅查询错误，后按实际manifest id核实，不称插件缺失。正式R2/KV外发前再核版本占用，不能覆盖别人的同版本包。— 新UI不能继续覆盖已发布2.5.2不可变对象。— 成本是一次正常插件patch版本与发布前占用复核，不改变host最小版本除非实际API依赖证明需要。

原生event3已结束并核清理；Rich中文慢速/原节奏保存通过，重开/Source未验，首轮cp未归因。报告 task8-native-event3-report.md 保留全部失败，不重启已完成Task1–7。

Ruling: Task8 focused初验的两处测试预期允许窄迁移：empty envDir以macOS实际canonical路径比，旧release-plugins.test逐字git-status片段改为现clean helper真实调用接线；dirty/未知untracked/tracked/staged/保留文件变更拒绝要求仍由真实临时Git仓库测试证明，不mock通过/删除语义。— /var与/private/var及已批准helper替换不构成产品拒绝能力失效，原文本断言不能再表示合同。— 成本是测试接线变化，首失败保留并明确非功能RED，新label重新验证。

Ruling: Task8允许一个ignored Rust integration recorder，显式执行并只调用现有公开ProjectStore方法，串接真实owner-freeze→浏览器原HTTP body→实际TS propose/compose→review_save/apply→receipt/S2；无生产RPC/feature/依赖变化。显式合成root须自有标识/路径边界，不能自动读应用配置回落真实Vault；阶段原bytes/hash身份绑定，report区分浏览器UI与RustAPI。— 现有浏览器录制的模拟中间件不足以证明实际Worker与主人磁盘合并，分段真实producer/consumer比新生产调试接口简单。— 成本是一个默认ignored的专用录制test，Task8必须实际运行，不能以默认suite skip当通过。

Ruling: Task8原生QA运行于明确冻结的在途Task8 bytes而非旧HEAD单独宣称：writer暂停非OWN全部写入/index/commit，ROOT创建task8-source-worktree-freeze.json（SHA b4bb88bbaff0ab2d2dbe54c2f8764eab75658b8cc9a68706e9d1d66f1e5d36a0；22 dirty/untracked完整路径/hash、status/index SHA、HEAD2037fc94），runner启动/结束核同清单，prod另核reference。— 已批准发布接线含实际Vite配置未提交，不可用旧clean guard拒绝后删改工作区；冻结真实bytes才能诚实验证。— 成本是本次结果绑定该工作输入，后继输入变更需按影响重新核，不称最终tag验收。CORE97fcc3e为CI-only，runtime保持3e06。
