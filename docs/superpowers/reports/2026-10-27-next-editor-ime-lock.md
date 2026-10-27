# NEXT 打开 Markdown 卡住：定位与修复验收

## 结论与范围

确认宿主存在可复现的输入法事件归属缺陷：元数据字段失焦提交后替换节点，旧节点的 compositionend 无法到达正文祖先，但宿主已误将字段的 compositionstart 记为正文输入。richComposing 因而不清除，保存 flush、Source 切换和文件 activate 一起等待。NEXT 同路径打开复用会话，会保留这个等待状态。此机制不涉及文件只读。

现场可观察 Source 按钮及原生模式菜单无响应、另开文件新增标签但不激活、侧栏操作正常；文件权限和 readonly 均排除。用户不确定是否输入过中文，缺少历史事件追踪，因此已确认代码缺陷与症状吻合，但不宣称已证明这次现场的唯一触发原因。

修复提交 `393a76ff3feddb1526c7c9aaf710df7497107932`：按 contenteditable 边界区分正文与嵌套字段，字段独立维护弱引用 IME guard，保留原有收尾按键保护。未使用计时强制结束或绕过保存。入口链回归提交 `c4b2f1a1`。

## 验证

- 实际 frontmatterFactory / EditorPane / ModeToggle / openPath / openFile 回归：修复前相同事件序列切换 Source 失败；修复后字段保留、Source 编辑、另一文件与返回、正常正文组合输入保护通过。相关 7 文件 89 测试通过。
- Safari 实际组件对照：左侧仅 file-main 与 ime 冻结于 v6.1027.2，其余依赖共用当前源码；右侧为 393a76ff。两侧触发受控合成输入法事件，旧节点均被替换、PM composing 均为 false；左侧 Source 超过 800ms 仍等待 flush，右侧 Source 成功。右侧粘贴中文后切回 Rich，中文及元数据保留，flush 成功。仅内存合成 Task，文件写入数为 0。这不是物理输入法录制，也不是已安装宿主验收。
- 浏览器构建主资产 index-RW9utaTu.js，SHA-256 `bba87768754ec5769ddce5f736dd63ef60930f7c736a1ec9e78a7f0bf7c4cd59`；本地详细证据 `tasks/next-editor-stuck-20261027/browser-acceptance.json`。
- 全量 Vitest 首次 408/410 文件、5308/5310 测试通过。两个失败分别为本机默认 Rust toolchain 的 cargo 不可用、NEXT 发布测试仍断言 1.9.0。使用已安装 `RUSTUP_TOOLCHAIN=1.99.0` 并将断言对齐实际 1.10.0 后，两个相关文件 81 测试全通过；断言修正独立提交 `f5241d76`。没有将首轮全量结果写作全绿。
- `pnpm run build` 通过。
- `pnpm run check` 仍有 6 个错误、31 个警告。6 个错误来自未改动的 ProjectShareDialog.test.ts 和 project-share/review.test.ts 中 findLast/findLastIndex 的 ES lib 类型及其回调推导；这两个文件及 tsconfig.json 与调查前 d90ef1ca 无差异。改动文件没有新增类型错误；未宣称全项目类型检查通过。

## 交付边界

修复已提交，双语日志列入未发布。没有发布或安装宿主；NEXT 1.10.0 不包含此宿主修复。未修改正式任务、未处理外部变更提示、未发送提醒。完整历史触发序列和修复后已安装宿主的现场验证仍未完成。
