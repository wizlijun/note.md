# 当前文档分享项目修复与发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当前Markdown直接创建独立分享项目，缺图可发布，草稿可找回并安全删除，然后发布新宿主。

**Architecture:** 延续本地Sync/project_id镜像和静态HTML+轻量收件。宿主bindings为项目目录，share_db仅发布凭据；固定入口独立身份，后端管理读取不依赖原件，删除标记和已有fs2保护跨进程共享records。

**Tech Stack:** Svelte 5 / TypeScript / Tauri / Rust / fs2 / Vitest，现有Worker协议不变。

**Spec:** docs/superpowers/specs/2026-10-10-current-document-project-sharing-design.md

## Global Constraints

- 当前main/现有目录，不创建worktree，保留用户46个dirty tracked文件。
- 每篇入口文档独立项目，目录仅引用基准；不新建服务或数据库。
- 原件永不因删除项目被删除、移动或覆盖；有变化/未知内容的镜像阻断清理。
- HTTP期间不持Sync文件锁；GUI/CLI整表load-modify-save共用固定sidecar的fs2锁。
- 新发布不能把权限/路径安全失败降级成缺图；原包未知结果继续相同身份重试。
- 用户已授权实施和正式发布；Worker无需变化不部署。

## Task 1: 后端项目身份与生命周期

**Files:** Modify src-tauri/src/project_share.rs, src-tauri/src/sotvault/store.rs, src-tauri/src/sotvault/mod.rs。Tests 在相同Rust模块。

**Interfaces:** projects -> ProjectSummary[]；create{sourceFile} / get{project_id} -> ProjectInfo；begin-delete / cancel-delete / delete / stopped{project_id} -> null。ProjectSummary沿用ProjectInfo并可含sourceAvailable:boolean、deleting:boolean、error:string。read确定文件不存在时错误字符串以 `NOT_FOUND:` 开头；安全/未知错误绝不使用此前缀。

- [ ] 写失败测试：同目录a/b不同ID，重复a复用；旧/P+docs/a入口保持ID和基准；草稿列表和源缺失get/inbox/snapshot；Vault根允许但Sync引用拒绝；删除保护原件、他项目、legacy、未知文件和漂移。

```rust
let a = service.create(source.join("a.md").to_str().unwrap()).unwrap();
let b = service.create(source.join("b.md").to_str().unwrap()).unwrap();
assert_ne!(a.project_id, b.project_id);
assert_eq!(service.create(source.join("a.md").to_str().unwrap()).unwrap().project_id, a.project_id);
```

- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml project_share --lib` 记录旧实现失败。
- [ ] create先按canonical完整入口匹配旧记录，固定entry；get只读。拆管理binding与source可用检查，删除中拒绝写。projects逐项容错。
- [ ] 删除前检查所有本项目records与未知/软链/个人文件；begin-delete落标记，delete幂等按project_id清理，绑定最后移除。stopped清config.url。inbox源不可用时不运行破坏intent的恢复。
- [ ] 复用fs2 fixed sidecar锁，在GUI/CLI所有records修改路径覆盖读取/校验/写/保存；避免嵌套死锁，必要内部unlocked helper。
- [ ] 运行相关project_share/sotvault测试，并增加跨进程文件锁竞争回归。

## Task 2: 引用分类和缺图可分享

**Files:** Modify src/lib/project-share/references.ts, references.test.ts。

**Interfaces:** ReferenceIssue含kind与可选 severity:'warning'|'error'；导出 `isBlockingReferenceIssue(issue):boolean` 统一UI与publish门禁。现有类型兼容；明确NOT_FOUND引用警告，入口或未知错误硬阻断。绝对路径硬阻断，相对越界/歧义/私密引用警告。

- [ ] 写失败回归：真实形状的5个report-img缺图，入口可读但所有引用抛 `NOT_FOUND: target`；预期files只含入口且没有blocking。

```ts
const result = await scanProject('strategy.md', [], async path => {
  if (path === 'strategy.md') return { path, markdown:'![a](report-img/a.png)', hash:'h', bytes:30 }
  throw new Error('NOT_FOUND: '+path)
})
expect(result.issues.every(issue => !isBlockingReferenceIssue(issue))).toBe(true)
```

- [ ] 运行 `pnpm test src/lib/project-share/references.test.ts` 证明旧门禁不能区分；实现稳定失败分类，保持不可安全内容阻断。
- [ ] 回归私密内容、绝对地址、缺入口、权限、安全路径、循环/wiki/HTML引用，不修改浏览器既有占位机制。

## Task 3: 当前文档入口、草稿列表和删除UI

**Files:** Modify src/components/ProjectShareDialog.svelte, ProjectShareDialog.test.ts。

**Consumes:** host.ts导出 listProjects():Promise<ProjectSummary[]>、createProject(sourceFile):Promise<ProjectInfo>、deleteProject(project_id,beforeDelete?:()=>Promise<void>):Promise<void>、cancelProjectDeletion(project_id):Promise<void>；projectCommand('get')恢复项目。types.ts已有可选sourceAvailable/deleting/error/orphaned。

- [ ] 写失败组件测试：当前文档创建无需目录选择、未保存取消不创建、草稿列表可选、同目录按入口显示、缺图警告主操作可用、删除正确调用。
- [ ] 当前tab ID在点击时捕获；flush并saveTab，未命名通过pickSaveFile+saveAs；不保存其他tab。创建与分享都进预览，上传仍需点击发布。
- [ ] initialize优先当前入口对应既有项目/Sync映射，不自动创建；单独列后端项目与发布身份，恢复用get且entry只读。
- [ ] 显示当前文档卡片和选择其他文档；可见删除入口、删除中重试/取消、源不可用管理。删除前后查镜像buffer，只关闭干净镜像tab，保留源tab。
- [ ] `isBlockingReferenceIssue`用于按钮和publish同一门禁，显示未包含警告，配置错误可跳宿主分享设置且保留当前界面。
- [ ] 运行组件/相关交互测试和svelte-check。

## Task 4: Host编排、集成审查与实际验收

**Files:** Modify src/lib/project-share/host.ts, host.test.ts, types.ts；文档与独立验证证据在tasks/design。

- [ ] listProjects后端列表关联发布凭据，孤儿凭据保留管理；create只调宿主。停止确认后同步Rust config及前端状态。
- [ ] delete先begin-delete，原服务owner DELETE确认，再执行beforeDelete二次buffer校验和Rust delete，最后删identity。无凭据草稿离线可删；活动配置无凭据明确阻断；失败保留删除状态/凭据。

```ts
await projectCommand('begin-delete', {project_id})
if (identity?.url || identity?.pending) await stopProjectShare(project_id)
await beforeDelete?.()
await projectCommand('delete', {project_id})
await forgetProjectIdentity(project_id)
```

- [ ] host测试覆盖204/404、网络失败不清本机、pending先撤回、取消、孤儿记录；运行项目相关全部测试。
- [ ] 每个任务独立spec/质量审查，修正后广泛整合审查。运行前端完整测试、check、build、Rust相关/完整发布检查。
- [ ] 用隔离实际Tauri宿主、临时Vault与独立测试文档验证invoke→文件系统→HTTP→反馈→更新→撤回→删除；真实缺图形状和同目录两个入口。生产测试如需联网只用新建隔离项目，清理测试链接，绝不删除用户项目。

## Task 5: 主干集成与正式发布

**Files:** CHANGELOG.md / CHANGELOG.zh-CN.md、既有scripts/release.sh；不改发布通道。

- [ ] 按备份前用户文件与当前文件的差异精确暂存本轮delta；检查暂存，不夹带其他功能；现有main提交。
- [ ] 复用 /Users/bruce/git/mdeditor-release-610082-20261008 普通clone的main，合入本轮提交、保留最新远端功能与安全依赖。
- [ ] 核对远端最新版本后递增patch（预计6.1010.3），运行已有release.sh双架构签名、公证、Gatekeeper及updater验签；失败按原流程幂等恢复。
- [ ] 独立匿名下载7个正式资产核对大小/SHA256/GitHub digest、两架构更新签名与latest入口；归档成品。
- [ ] 清本轮Cargo cache/dist和临时重复产物，保留正式bundle，核对用户原有dirty delta未被改变，记录发布结果。
