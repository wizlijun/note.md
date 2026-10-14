# 网页 E1–E3 与桌面 E4 交付设计

> 2026-10-14 正式实施合同。前置已受理：CORE `6a6d0f940383c1e2cd19dc3c9c3df8f63e69baff` / HOST产品 `8a0b555ca6a0e8df226700fc74f67ffa64f3925e`；唯一全阶段审查及一次 finalfix/scoped复审完成，准确证据见 [docs/superpowers/reports/2026-10-14-file-bindings-history-verification.md](/Users/bruce/git/mdeditor/docs/superpowers/reports/2026-10-14-file-bindings-history-verification.md)。本合同的 E1–E4 尚待实施与发行。用户暂无移动设备，移动端真实中日 IME 保持待验，继续独立实现。

状态：2026-10-14，ROOT 已完成接口与计划核对并正式采纳。本文件是后继实施合同，不是 E1–E4 实现或发行证明。

主规格：`docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md`，尤其 §4、§6、§10–13、§15–21。前置：正式前置 `docs/superpowers/plans/2026-10-14-file-bindings-history.md` 及其已完成来源保真阶段验证报告。前置 file owner/mount/单文件保存 API 已实现并逐 Task 受理；后继 E1–E4 UI 尚未交付。正式消费身份为上方已受理源码与实际 installed 包。

## 1. 验收目标与依赖

完成的用户链路必须分别成立：

1. 主人发布完整项目 → 访客只读时不加载 kit → 点击编辑后使用共享 Rich/Source/批注 → 看“我的修改”并逐处撤销 → 冻结并提交 v2 → 主人实际取件、审阅、CAS apply → 访客读到回执 → 主人新发布 → 访客 rebase/撤销 rebase。
2. 访客从网页 deep link 或桌面菜单打开链接 → 网络前确认 host → 本机严格校验下载 → `received` 内用正常桌面编辑器离线修改/批注 → 重启保留原文、base 和 outbox → 联网逐字节重试 → 主人审阅 → 更新分享版本并逐冲突解决、保护未分享/新增/已修改文件 → 读回执。

源保真、empty-body、inline/annotation producer、file bindings/history/Source 必须先有实际已提交源码、committed dist、installed bytes 与真实 consumer 证据；不得拿 source corpus 或前置单元测试替代上述 UI 链路。实现不得再写 source serializer、diff3、selector/anchor 或旁路原件写入。

基础设施继续用已有 Worker 的 R2/KV、已有 append-only feedback/receipt；没有新服务、成员库、Durable Object 或云端正文 authority。本地 source/received 是编辑来源，Worker 只校验形状和传输，不理解正文。

## 2. 已核实的 seam inventory

| 层 | 真实文件与接口 | 已有事实 | 尚缺交付 |
|---|---|---|---|
| 协议 | `src/lib/project-share/types.ts` | `DraftV2`、v1/v2 feedback、receipt/version；base 原文、pending exact body、previous 已定义 | ShareEditorHost/Handle、guest.json 前端类型 |
| Worker P2 | `worker/src/feedback.ts`, `receipt.ts`, `project.ts`, `index.ts` | v2/严格未知键；version GET/HEAD 在 Bearer 之前；receipt 4段先路由；公开 download 原 R2 流 | `/_kit` 路由/存储完全没有；不重做已完成 P2 |
| 浏览器 P2 | `browser.ts` | `.toString()` 内联；IDB v2迁移、legacy fallback、冻结/幂等重试、版本检查、旧稿提交/导出、最近回执 | 实际编辑仍为 `#editor` textarea；没有 kit mount、proposal、rebase UI、AI勾选、deep link |
| 主人发布 | `host.ts` 的 `publishProject` / `syncProjectReceipts` | 分阶段 entry/full、冻结 theme/approved/hash、先持久化再发送、实际发布后 receipt 同步 | kit upload + frozen descriptor/warning；重试不可重新选择新 kit |
| 静态页面 | `bundle.ts` 的 `buildProjectBundle` | 公开快照白名单、version URL同源、nonce CSP、只读首屏、层级文件树与下载 | editorKit payload/CSP完整URL、SRI loader 与失败回落 |
| ZIP | `archive.ts` | 新包默认 source，只含确认源文档/附件；只有 legacy 放内部 manifest/reader | E4需按现行 source ZIP 接口验证，见下节 |
| 上传协议 | `multipart.ts`, `worker/src/project-upload.ts` | artifact 只有 entry/reader/archive；full 必须 archive+reader；R2原生 multipart；active 同时切换htmlKey/archiveKey | 无公开 manifest artifact/route；不能假设已有 |
| Kit | `editor-kit-v2/main.ts`、`file-contract.ts`、`file-main.ts` | `mountFileEditor` 已实现；同一 owner 支持 Rich/Source/native history、decorations/annotations 及显式 adapters/render/policy；mount 必需 mediaResolver | E1 分享外壳、file-menus 与 bundle media/i18n 接线尚未实现；禁止旧整文 serializer 兜底 |
| Rich依赖 | `editor-kit/rich.ts`, `media.ts` | bridgeMediaResolver依赖 `window.notemd.request`，math/mermaid false；已有IME guard | 普通浏览器的bundle resolver、数学/主题、高亮、批注泡泡与slash |
| 合并内核 | `share-merge/index.ts`, `critic.ts`, `rebase.ts` | `extractGuestAnnotations({base,draft})` 返回 clean/annotations/ownerAnnotationsTouched；`rebaseDraft({path,oldBase,newBase,draft})`；`anchor(text,selector)` | 新增共享组包/视图编排即可，算法不复制 |
| 主人 review | `components/project-review/HunkView.svelte`, `ConflictEditor.svelte` | 主人文案/5种conflict choices；真实review/apply/receipt在P0–P2 | guest模式只ours/theirs/edited，不能直接复用主人所有按钮 |
| Native入口 | `App.svelte`, `src-tauri/src/lib.rs` | deep-link插件已安装；当前所有非file URL仍传openFile，失败日志含path；单实例会转发scheme | share路由必须先截断、脱敏；冷启动/第二实例也需接入；tauri.conf未注册notemd scheme |
| Native存储 | `project_share.rs` | `write_atomic`私有；source_root只拒绝Sync；Store现为share_db.json | share_guest.rs不存在；received路径隔离/安全解压/base/outbox/update全缺 |
| UI挂载 | `lib/side-panel/registry.svelte.ts`, `components/side-panel/SidePanel.svelte` | 现有side-view注册与tab applicability | guest侧栏/打开链接对话框，不增第二套Drawer |
| 构建发布 | `vite.config.ts`, `package.json`, `scripts/release.sh`, `.github/workflows/deploy-worker.yml` | app多entry ES分块；现有Kit校验；版本6.1013.2；release双架构签名公证；main worker push会部署 | share IIFE独立构建、内容hash/SRI/依赖图/≤900KiB gzip、资源入安装包、真实已发布version证明 |

以上“已有”只表示本轮读到代码；本轮没有重跑测试，更不是线上当前版本证明。

## 3. 已发现冲突与 root 的已采纳裁定

### 3.1 source ZIP 与 §13.2 内部manifest

证据：review-merge §13.2 要 ZIP 内manifest；free-upload spec第46行明确“只含批准的源文档与附件……不加入阅读页、内部 manifest、`.notemd` 或其他管理文件”。现行 `archive.ts` 与后者一致。`project-upload.ts` 不解压ZIP，不存在manifest artifact；`publicProject()`下载当前archive原字节。

两种最小方案：

- A（root已采纳）：保持现行 ZIP/HTTP上传协议，本机获取已发布 reader 的唯一 `project-data` JSON，把公开snapshot投影为manifest。多一次reader网络/有界解析，版本竞态丢弃候选后重试；不执行HTML、不存入received、不新增Worker路由。
- B：重新把manifest+reader放入source ZIP，可直接照旧§13.2验证，但违反已确认free-upload源包范围，增加包体并改变冻结字节；不采用。

正式开始E4前同步修主spec§13.2，记录A的成本及旧包兼容。§20决定6写“离线归档只保证可读”；准确出处是§20，**不是§12.2**。现行source ZIP里的原Markdown可用本地阅读器读，不能宣称有离线HTML reader；正式修订明确这一点。下载仍复用批准的完整ZIP，读者下载无需feedback token；token仅用于feedback提交/receipt读取。

本机A解析边界：请求顺序 V1 → reader → ZIP → V2；V1/V2 schema1、project_id、snapshotId都相等且archiveReady=true。reader snapshot身份与之相等；ZIP每项均以reader清单核hash/bytes。版本变化不落盘、保留已有base/工作文件；提示重新检查，不无限循环。

reader只用一个小型确定性HTML标签扫描器找到文档中的真实script raw-text边界；跳过注释，按引号解析属性，script内容只由HTML结束标签终止；id/type属性ASCII大小写不敏感，重复属性拒绝，唯一id=project-data且type=application/json，拒绝第二个同id（不论type）。不得用“搜索任意匹配regex”从注释/字符串取假payload，不用DOM执行器或WebView加载reader。JSON用自定义serde visitor保留键检查，所有对象重复键拒绝；只从顶层snapshot取schema1公开字段，不信任HTML脚本、presentation或任意sourceRoot/git字段。保留JSON `\u003c/\u2028/\u2029`正常decode语义，字节hash取decode后的UTF8正文，BOM不能被TextDecoder隐式吃掉。

reader最大25MiB；snapshot.files 1..512、清单投影≤256KiB、源文件总和≤25MiB、单项≤25MiB；ZIP读取≤32MiB、解压累计≤25MiB（legacy reader额外≤25MiB、manifest≤256KiB）、逐项计数不信声明。严格ID/hash/entry/path；UTF8路径≤1024B、无反斜杠/冒号/控制符、空段/点段/.notemd、绝对路径、大小写折叠重复；源包只regular file，拒绝symlink/hardlink/device/encryption/多磁盘、路径重复、目录外记录、重叠/未列本地头、central/local冲突、CRC错误。raw ZIP只允许清单全部源文件；legacy只额外允许既定 `.__notemd-<sid>/manifest.json` 与reader.html，二者绝不执行/写入项目。

### 3.2 已受理前置 mount 合同与后继消费边界

原前置候选仅有owner/setMode/focus/destroyView，不能注入browser media、挂proposal或调用实际批注命令。本轮已对齐为 **bindings Task1 file-contract首次定义纯类型**，**Task2 controller首产policy与同步slash原子组合**，**Task3 mount首产真实adapters/render/decorations/annotations消费**；E1只消费同一factory。下列接口已存在于前置实际源码；逐 Task 受理状态由 ROOT 提供，正式消费以本合同列明的前置冻结 SHA 为准；后继 Mermaid loader 和 menus 扩展另行实施：

```ts
// 已由前置 src/editor-kit-v2/file-contract.ts 首产；以 ROOT 最终冻结该文件为准。
import type {CreateEditorOptions} from '@moraya/core'
import type {DecorationHost} from './contract'
type FileAdapters = Pick<CreateEditorOptions,
  'mediaResolver'|'rendererRegistry'|'linkOpener'|'platform'|
  'spreadsheetViewFactory'|'frontmatterViewFactory'>
type FileRender = Pick<CreateEditorOptions,'enableMath'|'enableMermaid'|'enableImageSelection'>
// MountFileEditorOptions已有：adapters?:FileAdapters; render?:FileRender
// mermaidLoader 是 M0 后继新增，不在当前六项 FileAdapters 中。
// policy只能拒绝已经通过共享source验证的候选，不能授予raw权限。
type FilePolicy = Readonly<{acceptRawChange(before:string,after:string):boolean}>
// options.policy?:FilePolicy，Rich/Source/history/restore安装前均经过。
// MountedFileEditor已有：
type FileUiHandles = {
  decorations:DecorationHost
  annotations:{insert(seed?:string):boolean;editAt(position:number):boolean}
}
```

适配器装配边界：共享file-main/file-contract/file-controller只接显式adapters，未传字段仅可沿core既有browser-safe默认，无默认的必需项仍由调用者提供。桌面 RichEditor 对应宿主调用路径已在前置 bindings 中组装现有 Tauri/media/link/platform 等依赖并传入；browser 传自己的 bundle resolver 等；当前 mount 必须显式提供 mediaResolver，不能因 adapters 类型可选而省略。共享路径不得导入desktop工厂/Tauri总模块/默认bridge，不靠传参后tree-shake或dynamic alias，不另建factory。

policy精确合同：`createFileController({...既有参数,policy?:FilePolicy})`；先完整验证root+appendTransaction的整链以及history内部全部有序delta，最后只对安装前raw和最终candidate.raw调用一次纯veto。中间delta允许临时移除后恢复owner，不能逐delta检查floor；拒绝时整个候选raw/doc/bindings/layout/generation不安装、不发observer。保留core全部source许可/保护守卫，policy返回true不会绕过它们。Source/restore/no-op使用同一最终边界。

装饰复用FileSnapshot.bindings的真实root ID；清层不改变raw/history；不要把整文件伪装为一个业务块。policy只是附加veto，不暴露session/edits/grant。加载新base使用`installBaseline(input,{policy:newPolicy})`：newPolicy根据目标snapshot+目标draft冻结floor，undo-rebase也显式重建；成功才原子交换policy/authority/history，失败全留旧。省略options仅为普通host兼容而沿用旧policy，不能供分享rebase使用；`{policy:null}`仅trusted宿主，URL/received内容/草稿/公开ShareEditor API不得关闭保护。不增可变setter。实际批注gesture/commands/popup与桌面共用；组件可支持只读owner气泡。

core当前annotation/note_anchor只有note attrs，没有origin；给PM加origin会遇到严格attrs回读。优先使用会话内owner标记/装饰与安装前veto。在authority挂载时按每种原始Critic片段冻结 floor(raw)=min(base多重集计数,初始draft多重集计数)；每个已获source许可的最终候选必须继续满足该floor。冻结base仍完整保留，extractGuestAnnotations始终用完整base，旧textarea/导入draft已改删的owner片段原样保留并报告，绝不改写。多出的同字片段按内核多重集仍算guest，允许新增后undo；原本缺失片段恢复后再undo也允许回到初始floor。Rich/Source/paste/drop/history/restore整条事务最终候选同过，不能在appendTransaction前提前安装，也不以policy返回true替代F1许可。明确局限：同字owner复制后删除原occurrence仍满足floor，按现行多重集无法证明原节点身份；这是§21需记录的替代方案，不能称为逐occurrence origin保护等价。rebase/installBaseline在新authority完整准备成功后才重新冻结floor；普通restoreContent不重冻。保留owner hunk主人检测，不在core添加隐藏raw授权。

### 3.3 其它要明确的产品边界

- “网络前显示title”无法从未访问的任意URL可靠取得；确认框在host旁显示本机已知标题，未知时用“此分享项目”，确认后才加载真实标题。不预fetch来拼确认文案。
- 真实 `project_share.rs` 的 `validate_relative` 已拒绝 `.note.md/.notes.md`、隐藏段、node_modules及凭据命名。E4对公开清单与每ZIP entry复用该规则，外部恶意源包含这些直接拒绝，不改后缀、不增加关系索引改造；received普通md不自动提升信任。
- 900KiB gzip为share主IIFE+必要可执行闭包预算；独立mermaid也记录体积。`font-src data:`既有，KaTeX字体必须inline data，不新增字体CDN。Mermaid的单独完整URL需要显式列入同源CSP，是§12.2可选资源的具体化，不加通配/unsafe-eval。
- guest模式可在desktop正常编辑分享者批注但提交前显式提醒（§13.3）；browser必须保护（§12.5）。二者不应共享一个总是拒绝的policy开关。

### 3.4 主题/资源与真实依赖闭包

`presentation.ts` 的 inlineMathCss 已经内嵌 KaTeX woff2；renderProjectPresentation 保持 frozenTheme.compiledCss；`share-baker.ts`整合hljs light/dark和正文主题。网页editor沿用页面styleHead与themeId，不import含Tauri的presentation、不调用editor-kit/theme.ts的window.notemd桥。编辑CSS只承载交互几何；字体url仅data，主IIFE用静态KaTeX/hljs闭包，无网络字体/worker/wasm。真实字体check、math截图、reader/Rich computed style与网络录制必须同时通过；本地未携带的主题字体沿现有替代warning。

另外NoteEditPopup/SlashMenu当前import i18n/store.svelte.ts，其顶部Store与动态event皆含Tauri；slash-items.ts包含dialog/attachment动态import。bindings Task2已提纯真实同步slash-command producer与窄target，验证每次实际tr.before/tr.docs、保留原Steps序列，整次controller只准入一次；拒绝保留slash。E1仅再提纯locale runtime与公共无附件slash UI metadata条目，在桌面仍重导出保持行为；不能通过浏览器Tauri alias或运行时菜单filter掩盖IIFE依赖图污染。确切文件拆分写在plan Task1。

## 4. 数据与状态所有权

共享组包函数放 `src/lib/project-share/guest-submission.ts`，只import内核与type-only协议类型；浏览器和desktop调用同一函数。它返回body/id/summary及ownerAnnotationsTouched（留在本机，不进入wire），按path稳定排序，抽取critic后才比较clean与base，annotationKinds按既定hash选kind，大小与字段限额先校验。只有主办身份、snapshot和baseHash来自已核base；不把当前version覆盖旧稿的snapshot。

browser仍由内联host持有IDB和token，kit不打开第二DB。`ShareEditorHandle.buildSubmission(input)`只flush实际文件owner、取得一致draft快照、调用纯builder并返回既定`{body,submissionId,summary}`；不写pending/receipt、不调用host.submit、不POST。flush可触发原有普通草稿保存，但这不是冻结提交；仅预览/调用build API绝不发送。当前spec§12.6把“组包”与“冻结后提交”连写，正式同步措辞明确这是用户submit工作流，接口/wire不变。

**唯一提交编排在内联browser.ts的显式用户submit handler。** 持有单一busy/lineage锁：已有pending直接取原id/body，跳过build、新id与重复冻结；无pending才await handle.buildSubmission，校验当前lineage/snapshot未切换，再在同一既有atomic队列中合并最新draft并持久化这个不可变pending（不以build时旧draft覆盖之后after）。durable成功后恰一次调用`host.submit(body,id)`。host.submit仅校验参数与已durable pending相同、force版本检查并执行一次现有POST；不组包、不写pending、不另起发送、不确认送达。成功后的submitted/lastSubmissionId/匹配pending清除/previous清除只由用户handler沿P2既有atomic流程执行一次；失败或确认写失败保留exact pending重试。若lineage在flush/build期间变化则取消本次构建并保留草稿；提交飞行中的后续编辑照常保存且不得被回执清空。双击同一in-flight只消费一次，preview/build不占发送流程。fallback保留同一个handler的旧组包分支，不能有第二POST编排。

增强批注在fallback不可抽取时保留原草稿并要求恢复kit或导出，不能把含访客critic的after冒充已抽取v2。桌面同理：明确点击提交的唯一host流程调用纯builder→Rust queue durable一次→deliver一次；重试直接deliver现有outbox exact body/id，不重建或重新queue。

desktop的Rust GuestStore只负责权限、ZIP、路径、安全原子IO与HTTP发送；TS单一内核负责组包与merge/rebase。guest.json在received/.notemd；token只在app-data/share_db.json的 `guest:<origin>:<project_id>`。outbox写入确切body再发，原body/hash/id以本地记录为准，409保留供导出；不把token/URL fragment带入outbox或错误。网络重试仅针对用户已冻结提交。

更新时old base保留到所有冲突完成；TS候选传Rust附带工作文件expectedHash，Rust重读CAS防外部编辑。无冲突文件允许逐项完成，pendingUpdate记录可恢复进度；冲突文件零写入；新同名未知文件只另存唯一.shared.md，不覆盖已有.shared.md；删除已改文件保留且标出已不在分享范围。新base身份通过整批校验后才启用；outbox未清时禁止切base，仍可编辑并导出。

## 5. 交付顺序

1. 引用 ROOT 已受理前置 mount/installed 证据并锁定最终 SHA、adapter/decorations/policy 合同；不重新实现前置，E1 实际消费另行验收。
2. E1共享组包与真实mount、browser-only依赖边拆分；独立source/test可编译。
3. E1内容寻址IIFE/Worker kit/host冻结发布，再接E2真实browser UI，完整fallback、owner保护、修改可见/撤销/回执。
4. E3 rebase/撤销/orphan与Mermaid懒加载。
5. E4严格下载、received/base/token隔离。
6. E4深链/菜单/侧栏、离线编辑→冻结提交→实际回执。
7. E4更新与guest冲突UI、安全恢复。
8. 两端端到端、native/IME、打包版本/Worker部署/公开产物证据。

每个实施Task有自己的RED→GREEN与精确提交，完成源码不等于已打包/已发布。当前无可用iOS模拟器或Android连接，矩阵对应行必须保持“未验收”；合成composition事件只算自动回归，不能签真IME通过。


## 6. 发布遗留与责任边界

root提示正式 `docs/superpowers/reports/2026-10-13-v6.1013.2-release-verification.md` 已记录旧free-upload reseal/status-cleanup分别10ms，strict <10ms未通过；本轮规划未重测。新Worker部署不能清除此遗留，本批也不因此重构未动上传路径。新增/_kit PUT最大8MiB重算SHA必须实测免费CPU与真实HEAD/GET/SRI，超限不得提套餐或新建服务。正式release整合全部未发布更新，含LatestCreated10项等点名变更；由root核冻结tag实际源码与验收，不由本规划作者替其它任务提交。


## 7. 正式依赖与状态边界

Mermaid M0 采用正式 `docs/superpowers/specs/2026-10-14-mermaid-loader-design.md`：共享NodeView无默认renderer加载边，桌面显式注入原模块，E1源码、E3独立SRI预览；三身份缓存与SDK默认迁移必须验收。

保存复用已受理createShareFileSession的durable返回、baselineIdentity与closeIfSaved，完整宿主队列见主spec§12.3。主spec§12.4已改为真实parser capture/原Step-docs/局部producer/raw authority，而I7判据不变；§12.5明确floor不是逐occurrence身份保护，§12.6区分纯build与用户提交。此前规划时态由正式合同取代，旧候选在归档中保留。
