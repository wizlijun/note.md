# Fcitx5 系统输入源名称空白：定位与修复

2026-11-10，本机 macOS 27.0.1 (26A434)，已安装 Sumi 改造版包 0.4.3.2。

## 结论与实机证据

旧包只复制程序和用户组件，遗漏系统级注册与当前用户启用。普通用户调用 TISRegisterInputSource 返回 0，但系统 IntlDataCache.kbdx 未包含 Fcitx5；键盘设置的简体中文添加列表出现可选空白行。安装 App 的 InfoPlist 本地化字符串、NSImage/PDFKit 图标解码和签名正常。

用户在 Installer 完成管理员鉴权后，独立 4 KB 修复包只执行固定路径的 root TISRegisterInputSource（不更改 plist、不启用模式、不选择输入源、不重启进程）。安装日志 22:29:44 记录返回 0，系统 kbdx 立即更新并包含 Fcitx5。紧接注册后的 fresh TIS 仍 disabled，证明注册本身不等于启用。

随后用户操作期间输入源状态改变；主代理未调用启用或选择接口。再次检查系统设置 → 键盘 → 文本输入 → 编辑，侧栏明确显示 `Fcitx5, Fcitx5`，fresh TIS 父源 enabled=true，简体模式 enabled=true/selected=true。修复过程中未注销或重启；保留既有 WeType、词库与配置。原 PID 47326 仍在运行，故未将旧进程重启作为名称恢复原因。

根因定位为系统级注册缺失导致系统缓存不可用，补注册后 UI 名称恢复；没有证据要求修改官方输入模式可见性元数据或图标。未清理旧构建目录的 LaunchServices 注册，未手写 HIToolbox 偏好。

## 安装流程修复

输入法仓库 `/Users/bruce/git/fcitx5-macos-sumi` 提交 `6de7f31242ee66030b5e22190720459629a8fbbc`：新增原生注册/启用/状态 helper；postinstall 先 root 注册，再按官方流程以控制台用户仅启用父源，独立进程核验父源及至少一个可选模式均已启用，失败返回非零。安装失败不保证已复制文件回滚。

本机离线包 `~/Downloads/Fcitx5-Sumi-0.4.3.3-arm64.pkg`，SHA256 `9c95cf2b18d62ca0f4301acdc8bee25d44963ec07c2c03a2187f9cbcd2db0c62`。618 个展开文件与暂存逐一相同，App 深签验证、helper 最终二进制哈希、postinstall 字节对比、shell/Python/XML 检查、严格 helper 编译、隔离用户组件安装测试、完整 Fcitx5 target 构建通过。最终包提取的 helper status 在本机已启用状态返回 0；修复前 disabled 状态返回 1。包仍为本地 ad-hoc 签名、未公证。

当前机器通过独立注册包修复，仍安装 0.4.3.2；0.4.3.3 仅构建交付，未再次执行完整 GUI 安装。新版 postinstall 的 root→用户自动启用组合尚未在全新安装状态端到端验证；此次实际完成的是系统注册修复、名称可见与输入源启用状态，不等于真实物理按键和 Sumi 全量候选桥验收。源码已提交，未推送。

证据目录：[visibility-evidence](2026-11-10-sumi-macos-fcitx-visibility-evidence/)。

## 一手参考

- [Fcitx5 官方安装脚本](https://raw.githubusercontent.com/fcitx-contrib/fcitx5-macos-installer/master/install.sh)：root 注册后以普通用户启用父源。
- [另一输入法项目的 macOS 27 缓存实测](https://raw.githubusercontent.com/scholay/rimes/main/docs/macos/input-source-cache-recovery.md)：为此次单变量验证提供线索；结论以上述本机前后证据为准。
