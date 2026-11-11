# 0.5.0.14 安装后自动修复链路审计

2026-11-11，只读审计；本轮保留 0.5.0.12 引入并由 0.5.0.13 沿用的安装后自动修复链路，不新增重复机制。此记录不代表 0.5.0.14 安装包已在真实系统安装。

## 已有实际调用

1. `preinstall` 以当前登录用户身份写持久安装请求，保存版本与旧 receipt token；不向用户目录以 root 写配置。
2. `postinstall` 正常终止旧进程，并通过 `launchctl asuser`、`sudo -H -u` 在该用户 GUI 会话启动固定路径 App，传入 `--sumi-complete-install`。只验证 App 完成启动；不在 root 安装器会话内执行 AX 修复或等待授权。
3. App 启动与再次打开入口读取持久请求，覆盖系统提前启动 App 导致 `open --args` 未交付的情况。`InstallSetupModel` 等待目标版本的新 receipt token，安装器结束后才自动调用 `NativeInputSourceRepair.run`。
4. 已有辅助功能权限直接修复；没有权限则提示用户本人授权，授权后自动继续，不需要再次点击修复。关闭或取消会停止尚未运行的操作，不记成功。
5. 原生系统设置移除/重新添加完成后，分别验证注册、启用源集合、原选择恢复及可选来源；成功显示“开始使用”。用户点击后选择 Faitc5，确认选择成功才写完成标记。

因此用户要求的“安装完成后执行安装修复程序”已有实现。将其搬回 root `postinstall` 会重引入会话、receipt 时序及权限等待导致的错误，应保持分层。

## 本次隔离回归

运行以下生产实现相关测试，未操作真实系统设置、输入源、账号或权限：

| 测试 | 结果 | 本机完整日志 |
|---|---:|---|
| `test-request-user-setup.py` | 7 通过 | `build/install-chain-audit-0.5.0.14/test-request-user-setup.py.log` |
| `test-preinstall.py` | 5 通过 | `build/install-chain-audit-0.5.0.14/test-preinstall.py.log` |
| `test-native-repair.py` | 17 通过 | `build/install-chain-audit-0.5.0.14/test-native-repair.py.log` |
| `test-restart.py` | 16 通过 | `build/install-chain-audit-0.5.0.14/test-restart.py.log` |
| `test-install-setup.py` | 生产 Model 场景通过 | `build/install-chain-audit-0.5.0.14/test-install-setup.py.log` |

合计 45 项 unittest，另有提取生产 `InstallSetupModel` 的 receipt 首次/升级/同版重装、旧 token/错误版本不提前修复、授权后自动续跑、重复启动、等待中取消、资源/AX/选择失败及重试场景。

## 验收边界

- 新机器首次辅助功能权限仍需本人在系统设置中授予，不能自动代替；授权前不能称修复完成。
- 当前修复支持尚无模式或单一简体中文模式；其他已启用模式会明确拒绝，避免静默删除配置。不能承诺所有 macOS 与所有输入法组合一次成功。
- `.12` 历史实机记录 `package-0.5.0.12-installed-verification.json` 记录了安装后自动原生重加、没有手点修复按钮，以及用户真实键盘输入“你好”。它不是本次新包实装或物理按键验收。
- 新包发布前仍须展开核对安装脚本、请求脚本、package-version、App 的包版本/源提交及自动修复代码与冻结源码一致；由发布协调者补充最终包核验。
- 此审计未改产品代码，也未修改既有子模块脏状态或其他并行任务文件。

## 被审计生产文件 SHA-256

- `scripts/sumi-package/preinstall`：`f665c6f12117ee14b88703c9121020ac21435652fd3ea689a75e10a1544182f0`
- `scripts/sumi-package/postinstall`：`5fa2b7087ca245f88a6e773a60130effbe5f9c6a18134b3b879cd9ca33edb0a5`
- `scripts/sumi-package/request-user-setup.sh`：`d37fbd8ba4583d1cc86b8187ef828b94ef2b9e8bffd655edf93555e81ca67a01`
- `src/config/InstallSetup.swift`：`d84313f69f8c26baa330cc17d419b5cac866c829af19cfa2d5b96019af380623`
- `src/config/InstallSetupPolicy.swift`：`43d22ab0b6706c40404891a07b16bd311763419fe8f9a29c6e613d26e0a4e6c1`
- `src/config/NativeInputSourceRepair.swift`：`d0979b66f826391413dedb9aed5e015a97758fe28606e56e112663f655798318`
- `src/server.swift`：`1967d0877de2162561741ccf2047db5d9ba5f121002ca7110d55c1276734849e`
