# Sumi Apple 芯片发布候选：6.1111.1 / 0.1.14

状态：仅本地源码候选；未构建正式产物、未 push、未上传或发布。

## 范围与冻结

从正式 `v6.1110.8`（`0b5c3c7ba1b6f3f0923c71041315ae73142faa3b`）创建独立 worktree `/Users/bruce/git/mdeditor-sumi-release-20261111`、分支 `release/sumi-20261111`。八项源码提交无冲突重放，其 stable patch-id 逐项一致：

| 原 main 提交 | 候选提交 | stable patch-id |
|---|---|---|
| `93775741` | `0341b8db` | `32784f55e86ea29ee841ac6190d916d0604fb66e` |
| `e5c323d8` | `e76b3f75` | `a1726a27260fa8a1ef724ff18e587cf2dc350da6` |
| `35611925` | `c94c4488` | `9ec439a0f178180bc5fa5451fab5f773990e937e` |
| `f7e5c147` | `86e11a01` | `5bb8a8d2dd076f97173c6b7297815ea2299c386c` |
| `f0343d3f` | `91c0fb82` | `b132b6cd2e2240d2d4e01755a9cd5d107fbb356d` |
| `08d42615` | `45e07d39` | `6a0d028534f29f23006a244ed140cbd9f656ab8b` |
| `49e203c6` | `e73cc0f3` | `76dc2de2c1795ca31a708d81df934b7c0c777f8f` |
| `e6a2098f` | `32d2e26c` | `a05bfa86240fc318804aaed7e66d6c1991edf6a1` |

Sumi 原生编辑器、宿主 Sumi 模块、插件 backend/UI、窗口策略三文件与 main 实现逐字相同。智能查找源码保持已发布 tag，未合入 `07f53793` 后的模型判断、增强设置、查询修复和 headless CLI 功能；这些不是 6.1110.8 已发布功能的重复记录。

host 版本统一为 `6.1111.1`；Sumi manifest/package 为 `0.1.14`，最低宿主 `>=6.1111.1`。保留源 manifest 多平台映射，实际本轮只打包和上架 `aarch64-apple-darwin`，不能改写既有 Linux 0.1.12 市场条目。backend crate 独立版本沿用既有流程。

本地与 origin 均没有 `v6.1111.*`，GitHub `v6.1111.1` release 不存在；匿名市场 index 无 Sumi 0.1.14，arm 包和签名端点均为 404。这是准备阶段观察，不构成预约，外部发布前必须重查。候选使用本地 `sumi-v6.1111.1-rc1` 标签，正式 `v6.1111.1` 尚不创建。

## 所有工作区、分支与 stash 核对

- 主 worktree `/Users/bruce/git/mdeditor`：main `e6a2098f`。未提交 CHANGELOG.md、CHANGELOG.zh-CN.md 含本轮和未发布智能查找内容，不能整体复制；未提交 parity report 已选择复制并限定证据；未跟踪 window-startup spec 已按授权复制；`searchidx/src/store.rs` 与 `src-tauri/src/smart_lookup.rs` 的既有 EOF 修改保留，不纳入候选。
- 发布 worktree：八项已提交源码；本次版本、双语日志及 spec/report 由独立发布准备提交纳入。tasks/todo.md 属忽略的本地计划。没有复用主 worktree dirty 源码或用户数据。
- 本地分支仅 main 与 release/sumi-20261111。main 比 origin/main 多九项：上述八项源码及 `79ff7479` 文档；文档经选择复制，未整项 cherry-pick。发布分支相对 main 因基线有意隔离，并非遗漏未合入新功能；八项修复用上表补丁等价验证。
- 唯一 stash `stash@{0}`：`03d8a9ff3cc5c25552040fda41a2531ee3c1ac5c`（before-git-pull-2026-11-10），17 个 tracked 文件及早期 focus.h/focus-probe.m。它保留早期五行聚焦/quiet-notice 实现，已由 `710c148c` 及后续正式聚焦提交吸收或替代；不与最终居中全部可视行方案补丁等价，不能应用旧五行/+2pt 几何。两处 EOF 修改仍在主工作区；不恢复整个旧 smart_lookup 文件。stash 不属于本次新发布，原样保留。

## 证据与门禁

复制的 platform-parity report 区分开发基线 `eff8c327`、完整隔离 Acceptance 和正式候选。Return 上部全消失目前未再出现，未确证根因，不能作为本次“已修复”承诺。Linux Shift+Enter 只有源码回归，本次没有 Linux 二进制验收。

主代理已在 e6a2098f 隔离 Acceptance 验证新窗口默认全屏、关闭偏好不切当前、绿色按钮原生全屏、退出重开 false 保留及合成中文正文完整；恢复 true 不切当前。该验收不是尚未生成的正式签名 App 证据。

准备阶段通过：双语 changelog check/rotate；`python3 scripts/sumi/verify-release.py --self-test`；`python3 -m unittest discover -s scripts/sumi -p test_native_release.py`（9 项）；八项 stable patch-id、关键源码与 main 等价、Smart Lookup 与 tag 等价。verify-release 的版本门禁已更新，并把新窗口 geometry/policy 加入冻结源摘要。

后续仍需正式 host 和插件构建、签名、公证、精确源摘要/嵌入资源/架构/真实进程探针验收、市场与 GitHub 回读，再能称已发布。既有 `scripts/release.sh` 要求 main 且等于 origin/main，不能在此分支直接运行，也不能放宽门禁；使用既有分步构建、verify-release 与 draft/publish 流程，保留审计证据。市场必须沿用 Wrangler 3、Account API Token、R2→匿名回读验签→KV→公网复核，不改 Linux 条目。
