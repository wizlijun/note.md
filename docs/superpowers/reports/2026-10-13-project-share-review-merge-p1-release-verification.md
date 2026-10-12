# 正式发行后线上/源码最终核验

只读核验区间：UTC `2026-10-12T18:14:39.434635+00:00` → `2026-10-12T18:14:49.583361+00:00`，完成台北时间 `2026-10-13T02:14:49.583387+08:00`。安全 JSON：`release-final-production-verification-evidence.json`。

**正式公开发行已存在且为 latest**：[v6.1013.1](https://github.com/wizlijun/note.md/releases/tag/v6.1013.1)，Release ID `410880367`，draft=false / prerelease=false，仓库 public=true，published `2026-10-12T18:12:15Z`，七个预期资产均 uploaded。源码、冻结输入、Worker 生产和插件市场复核均通过。root 的独立 `verify-release.py` 已于 UTC `2026-10-12T18:14:14.525763+00:00` 完成 passed：7/7 本地/匿名/GitHub digest SHA一致，两架构 updater签名、版本/架构、app/DMG签名公证与Gatekeeper通过，公网 latest 精确一致。交叉证据 `verify-v6.1013.1-jnpcd7jc/report.json`；本审计只读取其安全报告，未重复下载大包。

本轮没有发布/部署/构建、Git refs/index/HEAD/生产源码修改、凭据或环境修改，没有子代理。Cloudflare 仅以既有 Account API Token 内存认证直接只读查询，仓库既有 Wrangler 版本仍为 worker3.114.17 / plugins-registry3.114.17；未输出 token/AppleID/密码/原始敏感API响应/进程 argv。

## 正式 tag / 远端 main / 发行资产

fresh `git ls-remote --heads --tags origin`，未 fetch：

- 远端 tag object：`4ed3b1f0fd809e4a36c22c286144f121b8e1f27f`。
- 正式 tag 解引用 commit：`09abadb7db855085713aa2454e84e28e79cd3c0e`。
- 实际 origin/main：`09abadb7db855085713aa2454e84e28e79cd3c0e`。
- 本地实际 HEAD：`09abadb7db855085713aa2454e84e28e79cd3c0e`；审计完成仍一致。

以上 tag commit/main/HEAD 完全相同。GitHub latest 为 v6.1013.1，等于目标正式 Release；七资产名集合与预期精确相等，各一份，GitHub digest 完整值保存在 JSON。

| 正式资产 | 状态 | 字节 |
|---|---|---:|
| `latest.json` | uploaded | 1314 |
| `note.md-6.1013.1-aarch64.dmg` | uploaded | 13162726 |
| `note.md-6.1013.1-x86_64.dmg` | uploaded | 13854894 |
| `note.md-aarch64.app.tar.gz` | uploaded | 13205893 |
| `note.md-aarch64.app.tar.gz.sig` | uploaded | 416 |
| `note.md-x86_64.app.tar.gz` | uploaded | 13823310 |
| `note.md-x86_64.app.tar.gz.sig` | uploaded | 416 |

七正式 staged 文件总计 **54048969 字节**，逐文件名/size 与 GitHub 元数据一致。本地 staged 还包含 `local-staged-sha256.json`（977字节）证据 sidecar；它不属于七正式资产，也没有出现在公开 Release 资产集合中。目录总量不能将该 sidecar 算入发行七资产。本轮自身只比较metadata/size；大包SHA/签名通过证据见上述root独立helper报告。

## finalfix 冻结源码与全 main 产品范围

以 `final-fix-gate2-results.json` 的八个冻结 SHA256 为 oracle，直接读取**正式 tag 内实际 blob 字节**重算；8/8 全同，且 HEAD blob 也等于 tag。没有只依赖 ancestor 判断。

| 冻结文件 | 正式 tag SHA256 | 与 gate 冻结一致 |
|---|---|---|
| `src-tauri/src/project_share.rs` | `a6043e538d2ce8a4e8f752b09a4591871ba92798b3f5047683b55d2c67e6dbc5` | true |
| `src-tauri/src/project_share_git.rs` | `fbd536adb5293d1f7d828265126fee8f18399914ec6947c8b7d143958eeca5e0` | true |
| `src-tauri/src/vault_sync/git_ops.rs` | `719d594cf4ab9808db0a7a2f69eb54b205f5a00302f96422d005b13a47749f84` | true |
| `src/components/ProjectShareDialog.test.ts` | `627ce295c24d3974629caaa7e66acbc12f8ae83bb8528a7b0f343988abe69a70` | true |
| `src/components/project-review/ProjectReview.test.ts` | `b09b257d6eb9fee7cb14dd8c0bb27b6a6cb73cf37cc199c23be052682802f07c` | true |
| `src/lib/project-share/git.ts` | `1d045c6599150c688b993ade3b45d9445d0857357e327c96e15e08e95fd17cab` | true |
| `src/lib/project-share/review.svelte.ts` | `a73a5adff9e350300c9ad4ca7314534b4ff054600c9f3c0e0886b462139019ae` | true |
| `src/lib/project-share/review.test.ts` | `7baccf089759884f397af717277013fa16a9932b66811c0cb96439817763f92e` | true |

最终 finalfix `2c9f165918297e4b089e3c56c4e876401edfc53d` 后只有以下两提交：

- `09abadb7db855085713aa2454e84e28e79cd3c0e chore: release v6.1013.1`
- `fe89cd039c245d97cc16b764c2f937fdacea16df docs(share): archive final P1 approval and release verification scope`

`fe89cd039c245d97cc16b764c2f937fdacea16df` 仅归档计划/验证与 finalfix/finalreview/release-audit 文档。实际 release commit parent `fe89cd039c245d97cc16b764c2f937fdacea16df`；release commit 精确只改六个允许版本/changelog 文件：CHANGELOG.md、CHANGELOG.zh-CN.md、package.json、src-tauri/Cargo.lock、src-tauri/Cargo.toml、src-tauri/tauri.conf.json。finalfix→tag 的非 docs 路径也精确只有这六个，产品实现没有其后漂移。

当前正式 tag 对上一正式 v6.1012.2 的全量清单为 **84 路径 / 44 commits**（72 产品/测试/构建 +12文档/changelog）。前次已完整盘点的78路径全部保留；新增六条路径只是 Cargo.lock/Cargo.toml/tauri.conf 三版本路径与三归档报告。完整全 ID commit、全路径清单本轮重新写入 JSON，结合 `release-post-fix-source-audit.md` 的最终九文件 actual patch 与前次全清单，没有仅挑选分享 commit 的遗漏。

## Memory / Rich 实际 14 项复核

对原 Memory `9a14dd7c` 3文件与 Rich `c49b8e66` 4文件，分别在正式 tag 和实际远端 main 读取原 patch 新增行/目标内容与关键 blob，共14项，缺失原新增非空行数均 **0**。Memory mod/projector 与 Rich 四文件保持原 post-patch blob；git_ops.rs 因后续功能和 test-only注入不同于原整 blob，但原 reconcile 内容/回归增量全部保留。完整实际 blob IDs 在 JSON。

| 原 patch | 文件 | 目标 | 等于原 post blob | 缺失新增行 |
|---|---|---|---|---:|
| 9a14dd7c | `src-tauri/src/memory_control/v2/mod.rs` | released_tag | true | 0 |
| 9a14dd7c | `src-tauri/src/memory_control/v2/mod.rs` | actual_remote_main | true | 0 |
| 9a14dd7c | `src-tauri/src/memory_control/v2/projector.rs` | released_tag | true | 0 |
| 9a14dd7c | `src-tauri/src/memory_control/v2/projector.rs` | actual_remote_main | true | 0 |
| 9a14dd7c | `src-tauri/src/vault_sync/git_ops.rs` | released_tag | false | 0 |
| 9a14dd7c | `src-tauri/src/vault_sync/git_ops.rs` | actual_remote_main | false | 0 |
| c49b8e66 | `src/components/RichEditor.svelte` | released_tag | true | 0 |
| c49b8e66 | `src/components/RichEditor.svelte` | actual_remote_main | true | 0 |
| c49b8e66 | `src/components/rich-editor-anchors.test.ts` | released_tag | true | 0 |
| c49b8e66 | `src/components/rich-editor-anchors.test.ts` | actual_remote_main | true | 0 |
| c49b8e66 | `src/lib/rich-anchor.test.ts` | released_tag | true | 0 |
| c49b8e66 | `src/lib/rich-anchor.test.ts` | actual_remote_main | true | 0 |
| c49b8e66 | `src/lib/rich-anchor.ts` | released_tag | true | 0 |
| c49b8e66 | `src/lib/rich-anchor.ts` | actual_remote_main | true | 0 |

## Worker fresh 生产与 push 后 CI

本轮 fresh Cloudflare deployments API 直接读取：deployment `6a2131e6-b32c-465e-aebd-cf4a32f8e141`，created `2026-10-12T06:05:34.833516Z`，strategy `percentage`，source `wrangler`；版本 `4b59fa31-c9b1-4619-aeae-c186bed33374` 占 **100%**。

fresh 最近10个 deploy-worker CI：最新 run `38210844417`，created `2026-10-12T06:05:12Z`，head `b2de9a9666affed37c41d525d1a72fdaa95f3aba`，completed/success；日志抽取 Current Version ID 与直接 API 100%版本一致。相对01:30没有新增 Worker run，也没有排队/进行中的较新部署。没有因“源码没变”直接假设CI状态，而是实际查询 run列表和生产API。

正式 tag Worker+deploy-workflow 与finalfix、发行前远端main均无差异，当前生产仍是此前已经部署的优化版本；因此本轮未额外部署。此前 v6.1012.2→main 的三 Worker 文件变化仍收纳于正式源码全量清单。

## 匿名插件索引 fresh 回读

本轮匿名 `https://plugins.notemd.net/api/index.json` 成功读取，正式26插件的当前源码 manifest 与线上最高版本 **26/26一致**；fixture排除。插件源码/registry自finalfix至tag无差异；没有新增插件包发布。未重新下载所有插件大包或重验其签名。

| 插件 | 源码 manifest | 匿名线上 |
|---|---|---|
| notemd.agency | 0.3.0 | 0.3.0 |
| notemd.apple-notes | 1.0.4 | 1.0.4 |
| notemd.assistant-mail | 0.1.6 | 0.1.6 |
| notemd.claude-agent | 1.0.33 | 1.0.33 |
| notemd.codex-agent | 1.0.20 | 1.0.20 |
| notemd.conversation-dictionary | 0.1.13 | 0.1.13 |
| notemd.decision-log | 1.1.7 | 1.1.7 |
| notemd.deepseek-agent | 1.1.19 | 1.1.19 |
| notemd.ebook-import | 1.5.2 | 1.5.2 |
| notemd.habitat | 0.5.3 | 0.5.3 |
| notemd.idea-spark | 1.3.7 | 1.3.7 |
| notemd.index-viewer | 1.0.2 | 1.0.2 |
| notemd.knowledge-browser | 3.2.0 | 3.2.0 |
| notemd.md2pdf | 1.0.5 | 1.0.5 |
| notemd.meetings | 1.0.3 | 1.0.3 |
| notemd.memory | 2.5.2 | 2.5.2 |
| notemd.next | 1.6.6 | 1.6.6 |
| notemd.openclaw-chat | 1.0.4 | 1.0.4 |
| notemd.pos-log | 1.1.5 | 1.1.5 |
| notemd.power-mode | 1.0.3 | 1.0.3 |
| notemd.roam-import | 1.2.6 | 1.2.6 |
| notemd.strata | 0.1.6 | 0.1.6 |
| notemd.timeline | 1.0.4 | 1.0.4 |
| notemd.trace-source | 1.2.5 | 1.2.5 |
| notemd.typst-reader | 0.2.4 | 0.2.4 |
| notemd.weekly-review | 1.0.6 | 1.0.6 |

## core 57 文件发行输入与原七 untracked

兄弟 core HEAD与实际远端main均 `1cb70441f440f50ac4b023857f6d48d5b70eda5a`，tracked/untracked clean。兄弟/installed dist **57 文件、2206579 字节**逐文件 SHA256一致；兄弟57tracked dist与其Git HEAD字节一致，package.json一致。tree SHA256 `1b656cb331446f6110816b828fb61dae9b25227622836f734922918ac674ec16`，与发行前冻结审计相同；无安装/同步dist/依赖修改。完整57逐文件hash存于JSON。不能用该当前输入反推旧历史二进制的file-dependency实际输入。

当前 tracked clean；完整 porcelain **不是空**，原七个 untracked 可见。root在发布完成后已逐字恢复localexclude；七路径均存在、check-ignore=false，未丢失、未读取业务文档内容、未删除、未纳入资产。

原采样命令为 `git status --porcelain=v1 --untracked-files=normal`，采样发生在原审计UTC区间 `2026-10-12T18:14:39.434635+00:00` 至 `2026-10-12T18:14:49.583361+00:00` 内，脚本没有为该单条命令记录独立时刻。原JSON的 `current_porcelain_empty` 实际已为false；原Markdown硬编码“porcelain空/暂隐藏”与证据矛盾，现已纠正。再次采样UTC `2026-10-12T18:18:09.785495+00:00` 至 `2026-10-12T18:18:09.899586+00:00`，完整porcelain恰为原七untracked，unstaged/staged tracked均为空；新采样的逐条结果保存在安全JSON。审计未修改exclude。

| 原路径 | 存在 | 本次被忽略 |
|---|---|---|
| `.pnpm-store/` | true | false |
| `docs/superpowers/specs/2026-09-23-agency-batch-cli.md` | true | false |
| `docs/superpowers/specs/2026-09-23-agency-plugin-design.md` | true | false |
| `docs/superpowers/specs/2026-09-23-agency-practical-review.md` | true | false |
| `docs/superpowers/specs/2026-09-30-habitat-knowledge-city-design.md` | true | false |
| `docs/superpowers/specs/2026-09-30-vault-knowledge-structure-extraction-design.md` | true | false |
| `docs/superpowers/specs/habitat-city.html` | true | false |

## 验收边界仍然保留

本次正式宿主 macOS 两架构七资产发行，不构成整套免费上传/所有后续阶段的验收。既有 small-k archive reseal/status-cleanup 为10ms，未达 strict `<10ms`；representative10/limits10/KVlegacy-copy验收未完整。本轮没有CPU重测、没有线上fixture。native UI/OS picker/iOS、P2、访客rich editor与offline client未由本轮验证；旧warning、非法UTF-8目录环境限制、search attention历史偶发根因未定位仍按验证报告保留。旧combined/stash保留root既有实际盘点裁定，本轮未恢复或重复旧hunks。

正式 Release、最终冻结源码、Worker/plugin/core输入已完成本报告的只读核验；最终七资产匿名字节/签名/架构/公证/latest已由root独立helper实际通过，交叉引用上述安全报告。


---

## Root匿名七资产验收（已实际完成）

完整安全结果如下，未包含凭据或临时下载地址。

```json
{
  "tag": "v6.1013.1",
  "repository": "wizlijun/note.md",
  "started_at": "2026-10-12T18:12:24.186610+00:00",
  "status": "passed",
  "anonymous_downloads": true,
  "updater_public_key_sha256": "16de48aae52d3c2f72593b1337d853528d633cdb89d98998155a5859da567563",
  "release": {
    "id": 410880367,
    "tag_name": "v6.1013.1",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-10-12T18:12:15Z"
  },
  "assets": [
    {
      "name": "latest.json",
      "size": 1314,
      "sha256": "64181b878b5d9591c22612c1a24f7cc0c3a19d6e215d8c25e530031ce7586145",
      "local_match": true,
      "github_digest_checked": true,
      "state": "uploaded"
    },
    {
      "name": "note.md-6.1013.1-aarch64.dmg",
      "size": 13162726,
      "sha256": "3c06d5700d300b5bce035a9e1a4dfd0c2f5df50ea90c4a02cb0f447b4f773cde",
      "local_match": true,
      "github_digest_checked": true,
      "state": "uploaded"
    },
    {
      "name": "note.md-aarch64.app.tar.gz",
      "size": 13205893,
      "sha256": "0009cf377ea9b950ebb02abd560952ab4b0c8b41371cefec39cfdc05db205d92",
      "local_match": true,
      "github_digest_checked": true,
      "state": "uploaded"
    },
    {
      "name": "note.md-aarch64.app.tar.gz.sig",
      "size": 416,
      "sha256": "9ea41d359330538099f9a3d435602fb7637ad256e4444792f5d3994ea0bf82e1",
      "local_match": true,
      "github_digest_checked": true,
      "state": "uploaded"
    },
    {
      "name": "note.md-6.1013.1-x86_64.dmg",
      "size": 13854894,
      "sha256": "dc7771a19097eb37f0a693305033bc600f34f7b78176a12022dde03d7f37e7e0",
      "local_match": true,
      "github_digest_checked": true,
      "state": "uploaded"
    },
    {
      "name": "note.md-x86_64.app.tar.gz",
      "size": 13823310,
      "sha256": "55d9ff987813d425e32abde0a111e822a8b45989c5af100454f307ae5c737980",
      "local_match": true,
      "github_digest_checked": true,
      "state": "uploaded"
    },
    {
      "name": "note.md-x86_64.app.tar.gz.sig",
      "size": 416,
      "sha256": "3b23b0d399bee5cd981c67944b9acdd39c8018a41e988c4f40b41214ea773bc3",
      "local_match": true,
      "github_digest_checked": true,
      "state": "uploaded"
    }
  ],
  "architectures": [
    {
      "architecture": "aarch64",
      "mach_o": "arm64",
      "plist_version": "6.1013.1",
      "updater_signature": true,
      "app_codesign_and_staple": true,
      "dmg_codesign_staple_and_gatekeeper": true
    },
    {
      "architecture": "x86_64",
      "mach_o": "x86_64",
      "plist_version": "6.1013.1",
      "updater_signature": true,
      "app_codesign_and_staple": true,
      "dmg_codesign_staple_and_gatekeeper": true
    }
  ],
  "public_latest": {
    "version": "6.1013.1",
    "sha256": "64181b878b5d9591c22612c1a24f7cc0c3a19d6e215d8c25e530031ce7586145",
    "exact_manifest_match": true
  },
  "finished_at": "2026-10-12T18:14:14.525763+00:00"
}
```
