# Linux 官网下载架构修复验收

已于 2026-10-22 部署官网修复，源码提交 `e81bd593b80e3b431fb4c2b7d7bab11a8837d7b6`；[Deploy website 39733438117](https://github.com/wizlijun/note.md/actions/runs/39733438117) success。本次仅更改官网 Worker、回归测试与双语未发布日志，没有重发安装包。Linux 最新实际安装包仍为 6.1022.1。

## 原因与改动

[Chromium 的 UA reduction](https://www.chromium.org/updates/ua-reduction/) 会将 Linux UA 固定为 `X11; Linux x86_64`，即使实际为 ARM。原 Worker 虽读取 `Sec-CH-UA-Arch`，却未请求此高熵提示；首页仅读取 `userAgentData.platform`。显式 ARM 链接验通没有覆盖自动识别，顶部导航及内容页也绕过首页脚本。已用真实首页脚本和 reduced UA + ARM metadata 复现原路径。

修复集中在 Worker，覆盖静态页进入及直接 `/download`：

- 静态响应发出 `Accept-CH: Sec-CH-UA-Arch, Sec-CH-UA-Bitness`，下载响应另带 `Critical-CH`，促使首次直达的 Chromium 补发架构信息后重试。按 [Critical-CH 协议](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Critical-CH) 将提示列入 Vary，下载响应保留 no-store。
- Linux 族名 hint 自动选择要求明确 64 位；32 位、缺失、空或未知位数不自动猜包。明确 ARM64 UA及非 Chromium 明文 x86_64 可回退；reduced Chromium 的 x86_64 不能作为可信架构。
- 未知 Linux 架构展示英/中/德/日选择页，提供显式 ARM64 和 AMD64 链接，不读取误判的 AMD64 下载缓存。手动架构参数优先。原有 Mac/Windows 解析及真实资产回退保留。

## 验证

- RED：旧代码 4 项失败/44 项通过，捕获 reduced UA 猜 AMD64、缺失协商响应头等问题；日志 `red.log`。
- GREEN：最终全网站 5 文件 **111 测试通过**，含 hint 位数、用户手选优先、旧架构缓存、提示不可用、四语选择页、静态内容/缓存保留及既有平台回归；`git diff --check` 通过。
- 真实 Chrome 155、CDP 设置 Linux reduced UA 与 ARM64 metadata，实际 HTTP 服务直接调用生产 Worker，并模拟 GitHub 资产 API，六场景全通过：fresh 直达首次无 hint → 200 + Critical-CH → 浏览器真实重试 ARM/64 → ARM；首页主 CTA、顶部导航、内容页 CTA均携提示；剥离提示显示选择页且手选 ARM 成功；ARM metadata下显式 AMD64 优先。最终 mock 资产为本地无下载 fixture，不能将此表述为 Linux 实机安装。首次真正 GitHub 下载跳转导致测试工具的 download-starting 中断已留证，属于 harness 调整，不是产品通过证据。
- 选择页桌面明暗、360px 窄屏明暗均经截图查看，无横向溢出/遮挡。
- 公网普通 URL **11 场景**通过：ARM/x86提示、两种显式覆盖、缺提示、缺位数、32位、明文ARM UA，以及Mac双架构/Windows；响应头、状态和目标地址均正确。四语首页 HTTP 200、字节与提交HTML相同且协商头存在；Linux双架构目标最终HEAD 200。没有使用cache-bypass。

这是实际 Chromium 协商机制与线上响应验证，没有在用户的 Linux ARM 实机上运行浏览器或安装应用。

## 产物与证据

- [Linux ARM64 6.1022.1 安装包](https://github.com/wizlijun/note.md/releases/download/v6.1022.1/note.md_6.1022.1_arm64.deb)
- [固定选择 ARM64 的官网入口](https://notemd.net/download?os=linux&arch=aarch64)
- Worker SHA256 `a7d113f66a0b65a9a00c4cc85996007a3ed71b74efd99d040fcd7b73d1337408`；resolver SHA256 `f7c58ac80861003977c3cfb818c76d0b92bff9eddcb7777ae6eaaf02af327288`。
- 最终 `browser-verification.json` SHA256 `5268b02b61780f18418653687b9286aa4906f5b149d3eef6d02f8b9c68aea210`。
- `public-verification.json` SHA256 `e343683c823383c20ea8cb8863632da2f1b37ca08f2e3e0035e27edd82980b35`。

完整本地证据在 `tasks/linux-download-arch-20261022/`（任务目录不纳入版本控制）。scope-audit.json枚举两仓全部worktree/本地分支/stash；原7项未跟踪入口及3份历史stash保持，不纳入提交。用户纠正已记入tasks/lessons.md：显式架构链接和curl明文UA的验收不能替代reduced UA＋真实ARM metadata下的冷启动浏览器验证。
