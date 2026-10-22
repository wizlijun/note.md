# Omarchy ARM64 包与优先下载入口验收 — 2026-10-22

为用户确认的 aarch64 Omarchy 补齐可安装的 Arch 包，追加到既有 [v6.1022.1](https://github.com/wizlijun/note.md/releases/tag/v6.1022.1)。官网 Linux 主按钮优先选择 Omarchy/Arch，Debian/Ubuntu 使用独立入口；下载页提供明确格式选择及 `pacman -U` 安装提示。本次是 Linux 6.1022.1 的包格式补齐，**没有将应用升级为 6.1022.2，也未声称包含仅在新版 Mac 发布的功能**。

## 冻结与包验证

冻结 tag `v6.1022.1` 保持 `21d8a8e761839777680e5f11704046972d16c916`。公开 ARM DEB SHA256 `8cc86e16b5d40b2ce917e739b437bba9a3b8f27b50b000244a8d67b802d85bfa`、14,780,512 bytes。沿既有 `packaging/omarchy/prepare.py` 验证公开两架构 DEB/checksum 后生成 PKGBUILD；准备器 6 测试通过。生成配方 SHA256 `cb00c609c90f9e328eff0754f970524fe2ec1e6d1635ad44a1514ed046e9d09d`，非 root makepkg，不跳过 source checksum、依赖或包签名检查。

原生 aarch64 Arch Linux ARM 环境使用[官方镜像](https://ca.us.mirror.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz)，829,367,415 bytes，SHA256 `42a4eeaa038994ffd31fa173256ef2f0ef511358eeb41b9ea1f8626391b9b319`。独立任务 keyring 验证 detached PGP signature，完整指纹 `68B3537F39A313B3E574D06777193F152BDBE6A6` 与[官方下载页](https://archlinuxarm.org/about/downloads)公布值一致；包级 `Required DatabaseOptional` 保持。官方仓库实际提供 ARM 的 WebKitGTK 4.1 与 libayatana 依赖。

构建和首次安装使用同一 prepared image `sha256:364c716f277ecaa35f466072aa47b17b92f2b55d61c7868ce5e887b136dcd700` 的两个独立、非 privileged 容器，未使用 x86 仿真，首次运行前确认未安装 notemd。验证：

- `pacman -U` 从实际 package metadata 解析依赖并安装；`pacman -Qkk`：**32 total files, 0 altered files**。
- 安装后的 CLI：`notemd 6.1022.1 (plugin API v1)`；`ldd -r` 无缺失库/未解析符号，ELF 为 AArch64、DYN/PIE，ASLR 2、parent personality 00000000。
- DEB 的 **29 个 payload 条目**全部与 Arch 包的文件 bytes、模式、owner、符号链接相等；新增仅 Arch 包元数据及许可证路径。安装后二进制、desktop entry、license 再次逐字节比较。
- 未验证用户 Omarchy 的 Hyprland/fcitx5/托盘/HiDPI 桌面 GUI；没有提交/收录下游仓库，不能声称现可 `pacman -S notemd`。

## 环境失败与收敛

首次 bootstrap 在下载前因容器 Landlock filesystem sandbox 不可用退出。仅对本任务 pacman 调用使用官方 `--disable-sandbox-filesystem`；下载 syscall sandbox、包签名、依赖验证及普通 Docker 安全保留，不改用户设置或产品。随后官方 CA 镜像下载出现 TLS EOF，保存全部失败日志且确认未提交包事务；补下载及切换官方 FL 镜像、单并发后完成。没有关闭 TLS 验证或签名。

ALARM 默认 makepkg 压缩为 `.pkg.tar.xz`，首次产物因不匹配既有 `.pkg.tar.zst` 发布约定而未通过文件名门禁。只在本任务复制的 makepkg config 末尾设置 `PKGEXT='.pkg.tar.zst'`，正常 cleanbuild 重打，未将 xz 文件直接改名。最终 build 和独立 verify 均 exit 0。

## 新增公开资产

| 资产 | Bytes | SHA256 |
| --- | ---: | --- |
| `notemd-6.1022.1-1-aarch64.pkg.tar.zst` | 14625559 | `d62c9a0e26d4375f9d029c90e7cf51587f9bd95c2b6406c9975c0a241aff9ee8` |
| `SHA256SUMS-omarchy-aarch64.txt` | 104 | `06062809bd8e11c3229ea1d2e2581636ca515bc531ca3d2c573bd7532542e684` |

新增两个文件均匿名下载、与本地已验包逐字节一致。既有 v6.1022.1 的 **12 个资产**、v6.1022.2 Mac 的 **4 个资产**的 ID/digest/size 均不变；旧 x86_64 checksum 不覆盖，ARM 使用独立文件。Release notes 已回读核实，安装步骤见 [Linux / Omarchy 文档](../../linux-omarchy.md)。

## 官网变更与证据

- `8dc6d332`：明确 `format=deb/arch`，架构提示保留，fresh/LKG 按格式隔离，Arch 只找对应真实资产，不退到 DEB/其他架构。
- `287c0ad4`：按用户优先级将 Linux 主 CTA 明确为 Omarchy 并直接选择 Arch；通用格式页 Arch 第一，README/四语首页顺序一致。
- `74789b4a`：四语页面显示 `sudo pacman -U <下载的文件>`，不硬编码版本/架构或使用通配符；窄屏命令可读。
- `bf643f50`：ARM64 安装说明及双语日志。
- `3f64b997`：发布后普通公网曾回退 releases；确认 GitHub API 已含新 ARM 包、CPU 提示正确，并用旧 release-list 缓存重现。将 release-list 缓存命名空间更新为 v2，隔离新增格式支持前的旧快照。原次 Worker 错误日志不可得，不将其具体上游错误说成已证实。

最终网站 **128 测试通过**。本地真实 Chrome 155 验证 8 场景及四语360px明暗：Omarchy主CTA直达同架构Arch包、通用导航格式选择、未知架构保持格式、显式选择优先与安装提示。首次公网失败与上游响应保留，使用正常URL复验，不以cache-bypass冒充通过。

最终 [Deploy website 39737592642](https://github.com/wizlijun/note.md/actions/runs/39737592642) success（`3f64b99742c01fb917e8aee909eae5af459414ea`）。普通公网 **8 个下载入口**正确、7 个独立真实包目标 HTTP 200，3 个格式/架构选择页符合 Omarchy 优先和安装提示，4 语言首页逐字节匹配提交。生产 Chrome 155 用真实客户端提示协商机制及 ARM64 metadata 点击主 CTA，实际本站请求携带 arm/64，302 指向公开的 `notemd-6.1022.1-1-aarch64.pkg.tar.zst`；外部下载内容拦截不改变本站请求。该验证不是用户 Omarchy 实机 GUI 验收。

首轮及缓存命名空间更新后的首轮曾短暂回退 Releases 页，失败记录均保留。旧缓存路径已由回归测试复现，但缺少原请求的 Worker warning，不能认定旧缓存解释了全部瞬态。最终按同一正常 URL 全量通过，没有添加 nonce 或绕缓存验收。公网 `verification.json` SHA256 `3b8bbbab3d6e9cc52c766bb990d6f9e71afed20f716288cc72087b6fce0573b0`；生产 `browser-verification.json` SHA256 `bcf7f8d64cd8430aa5afbac30c49f153285b7dd74245d8c7a23abc18d93065c7`。

## 工作区与清理

两仓全部 worktree、本地分支及 stash 审计记录在 `scope-audit.json`；历史 7 项未跟踪入口与 3 个 stash 排除并保留。详细本地证据在 `tasks/omarchy-arm-release-20261022/` 和 `tasks/linux-arch-format-20261022/`（均为任务目录，不受版本控制）。签名、配方、包、失败与成功日志、容器/镜像身份和验证 JSON 保留。

只清理本任务四个已结束容器、两个自建镜像、可重新下载的 rootfs/cache。没有清理其他镜像、服务、源码或用户文件；`owned-cleanup.json` 与 `docker-trim.log` 记录精确范围和VM空闲块回收。正式报告独立提交。
