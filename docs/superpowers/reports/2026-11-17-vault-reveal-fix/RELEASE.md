# Vault 显示目录修复版 6.1117.1

状态：已正式公开，六附件匿名完整回读及实际自动更新入口验证通过。版本仅 Apple Silicon macOS，沿用用户上一版本确认的范围；用户本轮明确要求“解决以后，再发一个版本”。

- [发布页](https://github.com/wizlijun/note.md/releases/tag/v6.1117.1)；公开时间 `2026-11-16T16:49:49Z`，GitHub 非 draft、非 prerelease。
- 冻结 tag `v6.1117.1`，提交 `d6d63363fb7667e34eaa60af27abd3ae13ded87b`；修复提交 `5954dbbd25ea81297330bec518d55ab518ca856a`。代码、版本提交与 tag 均已推送。
- [修复与回归说明](README.md)；[范围审计](scope-audit.md)重新核对 worktree、历史分支、stash 与批准配套包。原两处 EOF 与 stash 哈希保持。

## 构建与公证

干净 clone `tasks/vault-release-20261114/source` 上执行原 `scripts/release.sh 6.1117.1 --arm64-only`，保留冻结依赖哈希，使用 CLT notarytool 1.1.4 透传 shim。全量 436 文件 / 5,929 tests、Svelte 0 errors / 31 既有 warnings、协议一致性、audit 无 high/critical、Rust canvas 27 与 mobile 3 项均通过。签名及公证本次一次成功。

- App Accepted：`d86dd996-74a9-4ed8-87c3-107945b6bd3f`，见 [Apple 结果](app-apple-notary-log.json)与[实际 App CDHash 绑定](app-notary-binding.json)。
- DMG Accepted：`367c1fa1-8cf4-4f96-98ff-4d9de6f48dd1`，见 [Apple 结果](dmg-apple-notary-log.json)与[实际下载 DMG CDHash 绑定](dmg-notary-binding.json)。

## 冻结源码与实际包

[完整验证报告](artifact-verification.json)记录 207 个嵌入资源、46 个源码文件与 15 条检查命令通过。两处真实编译点击处理器均绑定到 `revealItemInDir`，继而调用 `plugin:opener|reveal_item_in_dir`；完整组件模块与 opener 模块的 SHA 均在真实签名 Mach-O 中证明，原组件不再引用 `openPath`。这项证明针对实际上传后回读包，不仅是工作区源码。

App Mach-O SHA256：`f304bf3c83d2c22e8e4c6603a8c2043b298578cce2dcb1e032c55c36ee1c77c5`；装订后的 DMG SHA256：`de61c5380599b3c8d1f3193d26ebb36cc456bfd5a7ad8267f06970934da8d9c9`。App/DMG codesign、Gatekeeper、stapler 均通过；DMG 中 App 与候选一致，tar 中全部 7 个文件及权限/链接一致，Minisign 整包验签通过。六附件冻结哈希见 [host-assets.json](host-assets.json)。

Fcitx5 for Sumi 0.5.0.15 仍为批准 SHA `f75d72fa51efa50d09412b956453a0f36f59ced8a47f501bab148867f10c4299` 的正式配套。App 已公证、pkg 本身未签名，没有替换为测试预发布。

## 公开与匿名回读

原发布器重新下载并核对批准附件，在交互终端输入本轮 `v6.1117.1 mac-arm64-only` 范围后返回 Published，退出 0。[匿名完整回读报告](public-host-full-browser-verification.json)与[实际更新入口验证](updater-endpoint-verification.json)均通过：六附件共 93,174,055 字节，匿名完整读取后 SHA-256 与冻结本地资产和 GitHub digest 一致；完整更新 tar 的 Minisign 验签通过；Fcitx5 批准记录/整包一致；真实更新入口 HTTP 200，740 字节逐字等于本次清单，版本 6.1117.1、平台仅 darwin-aarch64。验证前后 release/tag/资产身份未变，无 fallback、网络错误或验证过程远端修改。验证脚本的 10 项 fixture tests 通过。

## 边界

本轮没有启动或安装正式 App，没有打开或改变用户正式 Vault。修复的 SDK/IPC 回归、实际权限配置与最终包嵌入证明均已验证，但没有将其声称为原生 Finder GUI 端到端测试。原始日志与下载保留在 `tasks/vault-reveal-fix-20261117/`。
