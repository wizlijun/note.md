# 6.1107.1 Apple Silicon 测试版发布证据

已于 2026-11-07 01:31:54（Asia/Taipei）公开，仅 Apple Silicon，标记 prerelease。稳定 latest 仍为 v6.1104.2，官网稳定入口未修改。本次未替用户覆盖安装。

- 发布页：https://github.com/wizlijun/note.md/releases/tag/v6.1107.1
- DMG：https://github.com/wizlijun/note.md/releases/download/v6.1107.1/note.md-6.1107.1-aarch64.dmg
- 冻结 tag 对应源码：`e1e64f9f157b025a0eb1bc698e9702beba4b4980`。
- 宿主全选修复：`954348e05519d8a8be8480396fe7d3fc502ddbaa`；此前退格回归：`96eae001c1b5276c739ceae572b4b60f243e99d6`。
- core：`e01e451b7df7dadbd74de1060bd3a5d05cd89e6b`，包含 `ac79ae4` 完整清空/历史修复与 `dfda8e46` 空格/格式末字修复。

## 范围与验证

修复 Rich 逐字 Backspace，以及 Cmd+A 有高亮后删除仍被源码保真/历史校验拒绝的问题。结构包装、公式、分隔线与段内批注纳入正文全选；保留 frontmatter 与隐藏 top-level 引用定义，支持撤销重做。普通文本选区保持原行为，结构选区的 Enter 通过既有 Selection.replace 处理。根因与回归见 `2026-11-07-rich-select-all-delete.md`。

发布前枚举两仓全部 worktree、分支未合入提交、dirty/untracked 与 stash；各仅 main/唯一 worktree，无其他遗留改动或 stash；两仓修复均已精确提交推送。64 个 core dist 文件、宿主安装依赖和冻结提交逐字一致，实际 tag 中的宿主实现及回归与修复提交一致。

- core：73 文件 / 1712 项全量测试、类型检查和 dist 构建通过。
- 宿主针对性 83 项通过，原末字退格 18 项通过。
- canonical 发布门禁：414 文件 / 5436 项前端测试、30 项 Rust 检查、protocol 一致性通过；svelte-check 0 错误 / 31 个既有警告。
- 6.1107.1 完整发布 attempt 2 退出 0；既有 release-publish 流程确认 `v6.1107.1 mac-arm64-only` 后退出 0。
- 实际候选 `--cli --json version` 返回 6.1107.1，thin arm64。
- App 公证 `a03b7a6f-5aae-4089-b1ab-ea5e02228139`、DMG 公证 `f8e57692-4582-48d1-846e-7ddd08aea7a9` 均 Accepted；codesign、stapler、Gatekeeper 通过。
- App、只读挂载 DMG 内 App 与 updater 的 Mach-O 均为 `66a8c0cacab60188ab6f9874d4e601de686e1f19ee5ce069ef3baaa90f0eccd7`。三个完整修复 JS 模块从实际 Mach-O 的 Brotli 字节恢复并与构建模块逐字匹配，覆盖旧退格修复、新清空/空补丁保护及 BodySelection。
- 四资产普通/绕缓存共八次匿名公网回读全部逐字相等，updater minisign 验签通过。公开 tag 指向上述冻结源码；manifest 仅含 darwin-aarch64；稳定 latest API 与下载端点仍指向 v6.1104.2。

## 资产 SHA256

| 资产 | SHA256 |
|---|---|
| `note.md-6.1107.1-aarch64.dmg` | `d8bdf77de7c817ada75b8f1cbf5c8c98b85ce9f82de00548e959a7d79502825c` |
| `note.md-aarch64.app.tar.gz` | `8fe9bf14d4df2aabc364c61446329a85c55e2632a4cb6b346af3884bbb7f4e6e` |
| `note.md-aarch64.app.tar.gz.sig` | `b287dcd41acc29a17ed281f4860675586d1f27def880021c9a1894e2ca06385b` |
| `latest.json` | `8659156cfa0c819764ebad243b212d522d4fad1715d027f75afa9e17ba6c3e95` |

## 中断、纠正与记录恢复

旧 6.1106.1 因 Git TLS、Apple timestamp/上传超时反复失败；收到用户“全选仍删不掉”后终止自己的发布进程，未公开该候选。已核实用户本机 6.1106.1 的确含旧边界修复，未把复报误归因于旧安装。所有旧日志/检查点保留，不把历史 Accepted 沿用于后续重新签名的字节。

本版首次 preflight 因冻结 share 资源尚在 task 输出目录而被拦截，退出 1；精确复制到 dist 后重跑完整流程，未修改门禁。首次候选 DMG 验收把 /var 与 /private/var 路径别名误判为不同；保留失败报告，改为解析规范路径并仍唯一核对本次设备后重验成功、卸载本次挂载。首次无 --cli 的 --version 调用没有版本输出，未作为证据；后续显式 CLI 返回值已记录。

双语各 19 条其他未发布条目已按原 SHA256 精确恢复到 Unreleased/未发布；v6.1107.1 及以下版本段逐字未变，临时 tracked pending 文件已删除。恢复证据与备份位于任务目录。

## 验收限制与证据位置

未完成原生 WKWebView 实机键盘/保存验收；只读原生界面只看到空白启动页，不能替代交互验证。隔离组件测试没有写用户正式文档。独立末尾 softbreak 逐字删除及嵌套 protected reference definitions 边界仍未放宽，不宣称解决所有 Backspace 场景。

本机完整证据：`tasks/backspace-select-all-20261106/`（audit、candidate-verification、host-public/public-review、publish-result、pending-restore-evidence、原始发布日志）；修复红绿证据另在 `tasks/backspace-selectall-20261106/`、`tasks/select-all-delete-20261106/`。旧失败现场在 `tasks/backspace-release-20261106/`。
