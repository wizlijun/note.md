# 编辑会话交互阻塞调查与 IME 修复

## 观察与结论边界

- 用户指定研究文档的安装版窗口（6.1119.1）中，源码切换、关闭标签、返回首页均未生效，撤销菜单禁用。窗口保留未保存的分段、高亮与批注。
- 用户确认这些改动来自上次编辑。`openFile` 对已有路径只激活旧标签，不重新读取文件或创建编辑会话，因此再次打开仍可保留旧会话的阻塞状态。
- 原文只读加载后，在隔离文档身份下通过真实 TabBar → HomeDocumentHost → EditorPane → RichEditor 验证：初始化、原样 flush、源码按钮切换、关闭按钮均成功。独立编辑器探针另验证输入、撤销、批注及关闭。
- 已证明存在下述 IME 状态分裂缺陷，可导致同样的交互阻塞；没有取得安装版故障现场的闭包状态，不能据此断言它是当前窗口的唯一根因。
- 安装版未替换、未重启；没有保存或丢弃用户的未保存改动，没有写入正式 Vault 文档。本次不是发布或原窗口恢复验收。

## 可复现根因与修复范围

ProseMirror 在 mousedown、contextmenu、touchstart 时可能自行结束 composition 并读取原生输入，却不派发 DOM compositionend。文件编辑器只等待后一个事件，造成底层 `view.composing=false`、外层 `richComposing=true`，共享 IME 守卫也仍锁定。命令返回不可用；flush 等待无法完成，继而阻塞模式切换和关闭。

修复仅修改 `src/editor-kit-v2/file-main.ts`：在这些手势传播结束后的 task 中检查底层状态，确认已经结束后统一恢复守卫并完成 flush 等候者。保留新组字 epoch、关闭/卸载状态和 compositionend 最终帧保护，不按固定时长强制结束输入。

评审纠正了初稿的微任务调度：原生事件可在 capture 与 target listener 之间运行微任务，不能用合成 dispatchEvent 的同栈行为推断真实鼠标顺序。新增回归覆盖该检查点。

## 验证

- 新增 8 项回归，覆盖三类手势、仍在组字、新组合竞态、末次字符、真实事件检查点以及实际 `closeTab` 草稿确认。
- 定向检查：file-ime-recovery、file-owner、ime、ime-attach、editor-bridge.ime，共 87 项通过。
- Safari/WebKit 实机：隔离页面以合成文本 `A中` 建立组字等待，CUA 原生右击后确认底层组字结束、撤销恢复、键盘门禁解除、flush 完整返回 `A中`；随后源码切换及关闭成功，无错误。此项验证真实鼠标事件，组字开始由测试夹具模拟，不等同于覆盖所有真实输入法。
- 扩大检查：39 文件，487 通过、93 失败。未修改基线 `d2fa0b9e` 的隔离 worktree 同命令为 38 文件，479 通过、相同 93 失败；失败用例集合没有增加。基线失败集中在 main/table-producer 的 localStorage 环境及 backspace/select-all 路径。
- `pnpm check` 前后均为 75 errors / 30 warnings，诊断集合完全相同，无新增诊断；`git diff --check` 通过。
- 原文与浏览器诊断夹具、命令日志保留在忽略的 `tasks/diagnostics/` 及本机 `/tmp/notemd-interaction-*`；未将用户正文纳入版本控制。

## 构建与发布限制

本地测试使用当前 node_modules 中的 Moraya 构建产物，与本机 sibling dist 一致，但 sibling dist 有原有未提交修改；部分文件哈希与既有发布依赖记录不同。没有证明该环境与安装包依赖逐字一致。此次修复已加入双语未发布日志，未构建、安装或发布新版本。
