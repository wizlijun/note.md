# v6.1104.1 macOS Apple Silicon 发布验收

2026-11-04 已公开 [v6.1104.1](https://github.com/wizlijun/note.md/releases/tag/v6.1104.1)，仅 macOS Apple Silicon。冻结 tag 源码为 `77f1491417561f0c05bddf099ed9dfd1cc1938e3`。UI 验收在公开前完成；未覆盖本机 /Applications 安装，验收后已恢复用户原文档窗口。

## 源码与范围

- 最新 MCP 设置说明、启动等待与只读工具来自 `891c1615`。
- `8d1008f3`：说明预览使用完整内容宽度。
- `4f4d965c`：MCP 开关、复制与预览移到“搜索与索引”顶部独立区块；保留 iOS 门禁及原保存语义。
- `a3a23fd4`：同步 11 处说明、模板及快照入口；不改用户已有 Vault 或 Claude 配置。
- `79055eff`：修复后台托盘更新持锁等待主线程、而主线程重建菜单等待同一锁的死锁。Repo、Status、SyncNow 三处均先释放锁再调用原生菜单 API。
- 内核仍为 `061143066af7c220e2799e6c63b6db7f66e4cb31`；64 个 dist 文件与冻结源码、安装依赖逐字一致，包含此前 Rich 全选删除修复。tag 中回归源码及新版本双语日志已核对。

其他待发布条目按原冻结文本恢复到两份 Unreleased，每种语言 19 条；删除本次临时 `.pending` 文件，不宣称独立插件随此宿主包发布。

## 测试与真实 UI

完整前端 412 文件、5357 项通过；svelte-check 0 错误、31 个既有警告；协议产物一致；依赖审计无 high/critical。发布 Rust 门禁 canvas 25、匹配的移动配置 2 及完整移动配置 3 通过。MCP/CLI/AGENTS 共 114 项此前通过；入口同步后 setup 12、agents_sync 10 再次通过。新增菜单锁并发回归旧实现 1 失败、修复后 1 通过，独立审查无阻断。Settings 46 项通过。

最终签名候选 Mach-O SHA-256：
`8e5b960b277c786ee0f34cf42cfd954eeedf334060dd2f787710875ad6a2a311`。

实际 macOS WKWebView 验收确认：核心页无 MCP 区块，搜索与索引页显示新入口；说明可预览和复制。通过 UI 粘贴并保存的中文说明 4294 字节，与该二进制 CLI 输出逐字一致。隔离文档 Rich 全选删除后磁盘仅保留元数据 74 字节；撤销精确恢复原文 757 字节；重做、Source/Rich 切换、关闭重开均正确，菜单重建及编辑保持响应。原生窗口调整工具曾超时，重新连接后所有验收操作成功。

最终实际包 CLI 中英文生成、错误退出及无 GUI 副作用检查通过；启动精确候选进程后 initialize/tools-list 返回两个只读工具及正确 annotations。未执行真实 tools/call、外部 Claude 注册或 Cowork 挂载端到端测试。只修改任务 fixture，不修改正式 Vault。

## 构建、公证与恢复边界

最终 App 公证 Accepted：`701b7c21-a182-47c0-be4e-86853e5ad699`。
最终 DMG 公证 Accepted：`fc5367f3-3271-4523-9785-562d5f39e68f`。
App/DMG 签名、staple、Gatekeeper、ARM 架构、权限与包内二进制比较通过；更新包使用最终字节重新签名并通过 minisign。

首次候选因预览宽度、第二轮因真实菜单死锁未发布；第三轮 UI 通过，但旧分享资源冻结清单未包含四条新增标题，被门禁拦截。独审确认仅共享 JS 增加 207 字节，移除四键即精确恢复旧哈希，CSS/Mermaid 未变。最终源码重新生成的清单 SHA-256 为 `cfdae046a76841f01f70e03ad191872ec1496cc5e6cd61b4de9d0b09e48a5351`，构建输出和包内嵌入资源均匹配。

最后一轮原 release.sh 在 DMG 上传工具 Bus error 后退出 138，不能称为整轮成功。已独审的任务恢复脚本锁定 HEAD、六个版本文件、原脚本、构建日志与 21 个产物哈希，复检 App 公证及冻结输入；复用原发布脚本尾段，仅将已完成的重建调用替换为检查点验证，保留所有后续 DMG、架构、包内比较、重签验签及草稿门禁。恢复退出 0；原失败日志/退出码未覆盖。随后按原 release-publish.sh 的 ARM-only 流程公开。

## 公网与官网

公开 tag 源码与冻结提交一致，latest 端点正确，platforms 仅 `darwin-aarch64`。DMG、更新 tar、签名、latest.json 的普通/绕缓存共 8 次完整回读全部与本地逐字及 SHA 一致，更新签名验证通过。

官网提交 `cd89ab822ba7712b48ab7e1ac229ac1339d7722f`，142 项测试通过，[部署 CI 41793974034](https://github.com/wizlijun/note.md/actions/runs/41793974034) 成功。四语主页普通/绕缓存共 8 次与该提交一致，ARM 入口指向新 DMG。其他平台未发布；Intel/Windows 首轮部分访问回退发布列表，补验恢复既有包，保留“不稳定全矩阵”结论，不宣称全平台稳定通过。

本机完整证据：`tasks/mac-arm-release-20261104/`，包括源码审计、三轮旧候选归档、实际 UI/CLI、恢复脚本审查、candidate-verification.json、host-public/public-review.json、官网结果及待发布日志恢复记录。
