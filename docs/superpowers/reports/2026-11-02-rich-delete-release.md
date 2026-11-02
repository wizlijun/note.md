# Rich 全选删除修复 6.1102.1 发布记录

已在实际 macOS WKWebView 界面验收通过后公开发布，仅 Apple Silicon；未替换 /Applications 中用户已安装的应用，未修改正式 Vault 文档。

公开地址：https://github.com/wizlijun/note.md/releases/tag/v6.1102.1

## 冻结源码与范围

- 宿主 tag `v6.1102.1`：`db6f23f4a49850f71d7dc2ee77c4b112df60f956`。
- core：`061143066af7c220e2799e6c63b6db7f66e4cb31`，已推送；源码及受版本控制的 dist 同步，64个依赖文件与冻结提交逐字一致。
- 宿主回归原提交 `041694d5`，从最新main隔离移植为 `711e42bd`；实际冻结tag包含精确回归文件及双语发布日志。
- 官网四语及待发布日志恢复：`07171a2e2d460c2d56be5f0c2a19b47ec6454222`。
- 原工作区26文件、HEAD、分支和3个stash保留。Agent/NEXT未提交内容及其他未跟踪文档不纳入本轮。

完整分支/补丁等价审计在本地 `tasks/rich-delete-release-20261102/scope-audit.md`。主线并行新增的文档/官网、Health描述及测试稳定性调整已逐项核对；没有增加宿主运行时功能。本轮仅让Rich修复进入版本日志，其余待发布条目已恢复。

## UI 验收

先在已安装旧版以专用文件复现：Cmd+A选中正文，Backspace后正文不变。然后退出旧版，从正式签名包路径启动候选；核对进程路径、版本、二进制SHA，未使用浏览器模拟器或开发构建替代。

| 场景 | 实机操作与结果 |
| --- | --- |
| 元数据+长正文 | Rich点击正文→Cmd+A→Backspace：正文清空，元数据保留 |
| 保存与模式切换 | Cmd+S→Source：仅原元数据；磁盘文件与原元数据字节完全一致 |
| 撤销/重做 | 回Rich→Cmd+Z保存：原文件逐字恢复；Cmd+Shift+Z保存：再次只剩元数据 |
| 关闭重开 | 重新打开同一磁盘文件：Rich仍仅显示元数据和空正文 |
| 普通文档 | Cmd+A→Delete→保存：空文件；撤销保存后原字节完整恢复 |
| 大片部分选区 | 选150/158个字符→Backspace：未选的“保留尾部KEEP”保留；保存与撤销字节核验通过 |

测试文件全部位于任务专用目录，未同步入Vault。UI测试完成后才执行 `release-publish.sh v6.1102.1 --mac-arm64-only`，按用户明确范围完成脚本的精确平台确认。证据为随附JSON及本地 `ui/` 原件、保存结果、检查点；交互过程中已读取AX及截图。验收仅覆盖本机Apple Silicon，没有声称Intel/Linux/Windows实机通过。

## 门禁与产物

- core全量1655项、宿主完整412文件5346项测试通过；Svelte 0错误/31项既有警告，协议和生产依赖审计通过。
- 原生canonical定向门禁：Canvas25项、移动配置筛选2项、完整mobile_project_config3项通过；不等于全部Rust测试。
- 首次门禁暴露分享测试固定到期时间已过；采用主线 `3a78fb47` 的Date-only基准及到期边界测试后完整重跑，没有放宽生产过期规则。
- 生产前端/ARM构建、App与DMG签名公证、Gatekeeper及updater签名校验通过。App公证 `11b133b7-382f-4b39-ad63-a928e18cdfc4`；DMG公证 `3a0eb165-a372-4f04-aad7-3d0ee5fbde7d`。
- UI候选Mach-O SHA-256：`a7a08215c67d81812c5c06f476ad54e1ae57c49ef8a056853a778e0e59da74ef`；updater内Mach-O与候选逐字一致。
- 实际Mach-O中分享载荷完整字节校验通过，越界负例仍拒绝；不将此证据扩大为运行时PHF绑定证明。

## 公网复核

4个发布资产在普通和绕缓存两种模式全部回读，与本地产物逐字及SHA一致；两模式updater签名、公开tag、latest API和更新入口均通过，仅包含darwin-aarch64。首次匿名TLS读取失败后仅重试只读验证，没有替换公开资产。

官网CI [41440261260](https://github.com/wizlijun/note.md/actions/runs/41440261260) 成功；四语言页面显示6.1102.1修复文案，仅移除实读Cloudflare统计脚本后与源码逐字一致。ARM下载指向本版，Intel仍指向6.1027.1。公网复核时Windows及四条Linux下载路由曾回退到GitHub发布列表，旧平台资产仍公开存在；本轮未改下载解析器，也不声称七条路由全部直达成功。详见本地website-verification.json。

完整机器可读证据：[release-evidence](2026-11-02-rich-delete-release-evidence.json)。本地日志与UI原件：`tasks/rich-delete-release-20261102/`。
