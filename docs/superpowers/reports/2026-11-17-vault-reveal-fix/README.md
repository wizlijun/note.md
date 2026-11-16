# Vault 在文件管理器中显示：权限修复

用户在 v6.1116.1 反馈欢迎页与 Vault 设置的“显示”操作报 `Not allowed to open path`。两个入口都误用了 `openPath`：opener 命令授权与路径 scope 独立，当前 capability 没有 open_path 的路径 allow，fs scope 也不授予 opener 权限。

## 修复

两组件改用项目文件树已有的 `revealItemInDir`，按完整绝对路径在系统文件管理器中定位并选中 Vault 目录。当前 `opener:default` 已包含 `allow-reveal-item-in-dir`，锁定的 Rust 插件 2.5.4 的 reveal 命令直接进入系统 reveal 路径。未扩大 opener 路径 scope，未新增后端命令；`~` 只用于显示。规格与双语 Unreleased 日志同步更新。

## 验证

- 删除两组件测试对整个 opener 模块的恒定成功 mock，改用真实 opener/core SDK 和官方 mockIPC 边界。边界按当前 scope 拒绝 open_path，验证实际命令序列及参数。
- 对两个入口各覆盖含空格/中文的绝对路径，以及系统文件管理器失败后的错误提示和状态恢复。
- 临时恢复旧产品实现、保留最终测试：6 failed / 16 passed；恢复修复后相关四文件：35 passed。原始输出在 `tasks/vault-reveal-fix-20261117/{red,green}.log`。
- Svelte 检查 0 errors / 31 既有 warnings；生产 build 通过；差异检查通过。
- 核对真实 `src-tauri/capabilities/default.json` 与本地锁定插件默认权限及命令实现；这是 SDK/IPC 契约回归加实际权限配置核对，没有将 mocked IPC 声称为原生 WebView/Finder 端到端测试。

用户随后明确要求修复后再发布一个版本，沿用已确认 Apple Silicon macOS 范围。新版本发布验收另行记录；本文不单独证明已进入安装包。
