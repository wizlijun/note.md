# Sumi 与 Faitc5 联动：Apple Silicon 宿主发布

宿主 **6.1110.8** 已公开，Sumi **0.1.13** 配套要求宿主 `>=6.1110.8`。本轮仅构建 Mac Apple 芯片产物；输入法 Faitc5 for Sumi 单独安装。候选使用原生正文排版，专注时位于当前行下方，普通输入时固定在底部，搜索框保留输入法自己的候选窗口。插件外观设置提供中、英、日启用说明。

宿主冻结 tag `v6.1110.8` 对应 `0b5c3c7ba1b6f3f0923c71041315ae73142faa3b`；实际正式编译起点 `436a7ed72471e7b3a40679b87b61c40d0a3029d0` 与最终源码仅有外部只读产物验证器差异，全部编译输入、资源、版本和锁文件相同。插件实际签名/公证源为 `2ddc823d`，其原始 Apple receipt 未更改；既有门禁逐文件证明 native receipt input hashes 与最终冻结源码完全相同，插件全部 tracked 源码亦相同。没有通过改 receipt 或放宽 CPU、签名、启用等条件制造通过。

[公开下载与更新](https://github.com/wizlijun/note.md/releases/tag/v6.1110.8)。DMG 14,100,740 字节，SHA-256 `7d1f20c20a094f6dd4435e217e82ca0c4e335238a75e2ec4f96645b68cb38e46`；更新归档 14,174,984 字节，SHA-256 `1054cc4c9d6791909ad60941e5b55a7449c9ba85fcd620a5ea81fa31d9c2e607`。四项草稿回读及四项匿名公网完整回读均与冻结字节一致；实际客户端 updater 端点返回相同 6.1110.8 清单。App 与 DMG 均 Apple Accepted，post-staple 更新签名、Gatekeeper、严格签名、同 Mach-O/CodeResources、完整 JS/Brotli 嵌入和插件素材排除门禁通过。实际 Mach-O 的 SumiCandidatesBridge、SumiCandidatesView、SumiCandidateAccessibilityElement 均存在。

430 套前端测试共 5718 项通过；类型检查 0 错误/31 条既有警告，协议产物一致，生产依赖 audit 无 high/critical（有 low/moderate）；Canvas 27 项和移动配置 3 项通过。实际签名插件从完整包解出，stdio 2、崩溃日志 13、真实宿主传输 1 项通过。候选布局 20877 断言、宿主 60 检查及 Objective-C/Swift 双进程候选桥通过。物理 IMK 候选窗口端到端输入未由工具合成按键证明；旧 caret-render KVO12<20 亦在原生产基线失败，保留该边界，没有降低门槛或冒称新回归已解决。

本轮遇到并修正的发布门禁失配：已发布 Idea Spark 1.3.8 与 Linux 音频依赖的硬编码测试仍停旧值；只同步两处测试期望。Vite 对外部 symlink 依赖的 raw import 拒绝通过 CoW 本地依赖副本解决；默认 stable 工具链缺 cargo，显式使用已安装 1.99.0。首次 debug2 构建耗尽可用空间导致 OpenSSL 失败，保留失败日志后只清可再生缓存，按已有正式 probe 惯例用 debug0 重跑并通过。字体开发缓存逐文件 hash/size 核对后 CoW 复用，未跳过准备验证。

源码合入已发布 6.1110.6/.7 平台修复，保留 macOS 桥和主线功能。root 的两个未提交 Rust 文件、旧 stash 与其他 worktree 均保留，未替其他任务提交。首次 GitHub 上传较慢，原请求最终成功，所有对象 retained；没有覆盖不可变资产。平台省略确认沿用真实 PTY 原脚本，按用户明确 Mac Apple 芯片范围逐字确认。公开流程未升级工具或改发布通道。

本机 `/Applications/note.md.app` 已由主 agent 正常退出旧 debug 进程后升级；本报告再次回读版本与主程序哈希，确认安装的是该正式产物。Sumi 市场 KV 与本机插件启用状态由配套发布代理另行记录，本文不把宿主公开等同于插件已经启用。详细机器可读证据见同名目录。
