# 免费 Worker 项目分片发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 Workers 免费的前提下，通过宿主冻结产物和 R2 原生分片实现入口先发布、单片续传、完整项目原子切换。

**Architecture:** 宿主校验源范围、渲染 HTML、构建确定性纯源 ZIP，按固定 5 MiB 计算每片 MD5 与预期 multipart ETag。Worker 仅验证小元数据和发布栅栏，将请求流交给 R2；seal 原生 complete，commit HEAD 后 CAS。旧协议及旧冻结包继续兼容。

**Tech Stack:** TypeScript、Svelte 5、fflate、Web Crypto、R2 Workers binding、现有 Wrangler 3、Vitest/workerd。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-free-upload-design.md`

## Global Constraints

- 当前 main 原地实施，不创建 worktree；保留原 46 个 dirty 文件和所有无关 untracked。
- Workers 免费；不增加服务、数据库、cron；不升级 Wrangler、不打印凭据。
- 源文件最多 512 个、总计 25 MiB；单个 HTML 最多 25 MiB；ZIP 最多 32 MiB。
- 分片固定 5 MiB，末片可更小；顺序上传。
- 控制请求及 v2 state 最多 16 KiB；退休会话最多八个；每次控制操作最多清理一个退休会话。
- Worker 不全量读取/hash/解压/解析发布正文，不用 JS 累积分片；entry 与 final 同样适用。
- 旧 pending 重试保留冻结输入、主题、标题、身份与绝对期限；清除 pending 必须精确确认 active publicationId + snapshotId。

## 共享接口合同

路由均为 `/project/:slug/upload/:op`，`op = begin | part | seal | commit | status`，POST，沿用 Bearer API Key。JSON 请求携带 edit_token；二进制 part 用 X-Edit-Token / X-Publication-Id / X-Upload-Session / X-Artifact / X-Part-Number。

```ts
type ArtifactName = 'entry' | 'reader' | 'archive'
interface ArtifactPlan {
  name: ArtifactName; bytes: number; sha256: string; etag: string
  parts: { number: number; bytes: number; md5: string }[]
}
interface BeginUpload {
  edit_token: string; project_id: string; feedback_token_hash: string
  publicationId: string; previousPublicationId: string | null
  sessionId: string; phase: 'entry' | 'full' | 'legacy'; snapshotId: string
  entry: string; title: string; expires_in_seconds: number | null
  artifacts: ArtifactPlan[]
  replaceSessionId?: string
  legacy?: { migrationId: string; snapshotId: string; publicationId?: string; expires_at: string | null }
}
interface UploadOperation { edit_token: string; publicationId: string; sessionId: string; artifact?: ArtifactName; parts?: {number: number; etag: string}[] }
interface UploadReceipt {
  publicationId: string; url: string; expires_at: string | null
  active: { publicationId: string; snapshotId: string; expires_at: string | null } | null
  upload?: { sessionId: string; phase: 'entry' | 'full' | 'legacy'; snapshotId: string; sealed: ArtifactName[] }
}
```

`part` 返回 `{number, etag}`（etag 原样保存native token，不能规范化opaque；裸MD5可早校验）；begin/seal/commit/status 返回 UploadReceipt。status JSON 至少包含 edit_token，publicationId/sessionId 可选。首次无项目状态返回 HTTP 404。会话 uploadId 失效返回 410 + 明确 `upload_expired` 错误码，宿主仅在业务期限仍有效时以 replaceSessionId 轮换 sessionId，同一冻结计划不变。阶段已提交的 begin/commit 返回 active 身份供幂等恢复。旧 KV 元数据查询及流式正文读取可用受 owner 保护的 status/legacy 读操作，保持控制 JSON 小型，正文独立 stream（POST upload/legacy，owner JSON请求；status无R2但有KV返回legacy小元数据，真正无状态才404）。

### Task 1: Worker 分片协议与生命周期

**Files:** Create `worker/src/project-upload.ts`, `worker/tests/project-upload.test.ts`; Modify `worker/src/project.ts`, `worker/src/index.ts`。

**Interfaces:** 消费上述 JSON/headers；产出五个上传路由、v1/v2 公共状态消费者兼容、native multipart 回执。

- [x] 先写失败回归：入口未提交410、入口成功、full切换/原ZIP下载、重试、错误partMD5、不同计划、前代冲突、撤回/到期交错、registered反馈/MCP、旧v1 pending与KV迁移。
- [x] 运行 `cd worker && npm test -- --run tests/project-upload.test.ts`，记录未实现路由失败。
- [x] 实现计划校验、版本化状态与原生流直传。关键流程：

```ts
const part = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(number, req.body!)
// 原样保存part，opaque不冒充MD5；seal传入客户端持久化的native回执。
const object = await env.MEDIA.resumeMultipartUpload(key, uploadId).complete(parts)
if (object.etag !== expectedMultipartETag) throw new Error('Artifact checksum mismatch')
// HEAD/元数据/ETag核对后才CAS；不读object正文。
```

- [x] 先登记key、再创建MPU、再持久uploadId、最后接受正文；独占key不覆盖；CAS失败与撤回只清理精确已退休key。
- [x] v2 active:null 支持所有读/反馈/撤回/旧接口；KV迁移流复制，旧active可读，旧无phase状态信息供宿主核对。
- [x] 运行 Worker 全测试及 `npx tsc --noEmit`，交独立评审，修复后精确提交。

### Task 2: 宿主冻结计划与续传

**Files:** Create `src/lib/project-share/multipart.ts`, `multipart.test.ts`; Modify `src/lib/project-share/host.ts`, `host.test.ts`, `upload.ts`, `upload.test.ts`。

**Interfaces:** 消费共享路由与 buildProjectArchive(snapshot,html,format?)；向界面输出 artifact/part/bytes 进度。原 ProjectIdentity.pending 增加 optional protocol/session/plans/receipts，旧记录无需迁移数据库。

- [x] 先写失败回归：入口不走JSON HTML；reader/ZIP分传；失败后仅补缺片；本机save失败保留pending；ready旧active不误报成功；旧full重建legacyZIP。
- [x] 运行 `pnpm exec vitest run src/lib/project-share/multipart.test.ts src/lib/project-share/host.test.ts` 确认失败。
- [x] 以纯TS MD5小函数或现有可复用实现计算分片校验（不新增依赖），WebCrypto SHA-256计算产物身份；最终ETag按二进制各片MD5拼接的MD5加片数。

```ts
// 第一个网络请求之前：冻结bytes/sha/parts、持久sessionId。
// 每片收到ETag并匹配后：先save回执，再推进下一片。
// 重试先status：active精确匹配则补本机published，缺片原字节重发。
```

- [x] 新entry上传/commit后继承expires_at，再生成full；原full pending用legacy原ZIP，phase entry/preparing按精确身份续接。
- [x] 旧无phase pending用owner小元数据+流正文，在宿主比较SHA；缺失未知状态不自动续期，不再POST旧大JSON。
- [x] 运行宿主/上传/分片定向测试及类型检查，交独立评审，修复后精确提交。

### Task 3: 纯源 ZIP 与项目进度界面

**Files:** Modify `src/lib/project-share/archive.ts`, `archive.test.ts`, `src/components/ProjectShareDialog.svelte`, 相关界面测试。

**Interfaces:** `buildProjectArchive(snapshot, html, format: 'source'|'legacy' = 'source')`。默认仅源，legacy精确保持原manifest/reader与固定压缩字节。进度扩展artifact与片号仍兼容旧调用。

- [x] 写纯源ZIP回归，验证只含批准源、拒绝所有隐藏路径/逃逸/重复、源hash仍验证；legacy与旧fixture精确一致。
- [x] 执行失败测试，再最小新增format参数，禁止.notemd及其他隐藏源组件。
- [x] ZIP和reader的字节进度分开，最终文案“正在完成发布”，保留project_id隔离；不改菜单/主题/阅读布局。
- [x] 定向UI/ZIP测试与check，真实浏览器检查续传与中间进度，交独立评审。

### Task 4: 集成、真实免费 CPU 验收与发布

**Files:** 本轮证据存 `tasks/design/project-share-free-upload-20261012/`；按需要增加精确回归。

- [ ] Worker全测试、项目分享前端回归、Svelte check、Rust project_share回归；审查生产差异和旧pending全部四类。
- [ ] 合成63源文件/4.9MiB、8.5MiB reader及上限包，真实multipart begin/part/seal/commit/status/revoke，分别至少十轮；校验匿名HTML/ZIP字节与撤回410。
- [ ] 使用现有Wrangler3/Account Token发布向后兼容Worker并抓CPU tail；每种操作CPU<10ms且无exceededCpu方可判通过。若未达门槛先定位小元数据/清理开销再修，不改套餐。
- [ ] 独立整体验收；当前main精准提交实现、保护原46dirty字节。根据最新AGENTS.md盘点并整合全部未发布产品更新，至少包含Memory、Rich锚点和已验证的Agency/Agent能力；发行普通clone以origin/main为基线，避免覆盖已发布修复。按既有授权发布新应用与相关插件。
- [ ] 清理本轮临时包/QA服务/发布编译缓存，保留正式产物和证据；更新todo回顾，不清理无关文件。
