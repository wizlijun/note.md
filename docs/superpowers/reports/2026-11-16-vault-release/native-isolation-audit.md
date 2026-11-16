# 最终 App 原生隔离验收可行性审计

结论：本次正式 macOS App 没有可用的运行时配置/Vault 根覆盖开关。在当前账号下不修改 HOME、不接触正式配置/Vault 的约束下，不能安全启动最终 App 做原生 E2E。此次仅审查源码，没有运行 App。

## 证据

- `src-tauri/src/app_dirs.rs:5`：`sumi-acceptance` 在非 debug 构建直接 compile_error；正式 BUNDLE_ID 固定 `net.notemd.app`。隔离验证只存在于重新编译的 debug acceptance App。
- `src-tauri/src/shared_config.rs:38` 与 `src-tauri/src/cli/mod.rs:63`：共享配置和 CLI 使用 `dirs::config_dir()` 加固定 Bundle ID，没有环境变量覆盖根目录。
- 锁定依赖 Tauri 2.11.1 的 `src/path/desktop.rs:238`：`app_config_dir` 和 `app_data_dir` 通过 dirs 计算，再追加配置中的 identifier；源码中的 identifier 已嵌入最终包。
- 锁定依赖 dirs 5.0.1/6.0.0 的 mac.rs：配置和数据目录固定由 `home_dir()/Library/Application Support` 构成，macOS 不使用 XDG_CONFIG_HOME/XDG_DATA_HOME。
- `src-tauri/src/platform.rs:222`：XDG_RUNTIME_DIR 只影响 IPC mcp.sock，不影响配置、插件及 Vault。
- `src-tauri/src/lib.rs:1774` 起启动流程会初始化 Vault 同步、agents sync、search、MCP、插件、位置权限及主题持久化；不能把直接启动当作无副作用读取。

## 可行的后续环境

同字节最终 App 的首次引导、菜单、设置和统计功能验收应在独立 macOS 账号的登录会话或干净 macOS VM 中进行，使用合成目录及文档；该环境不能映射当前用户配置/Vault。需要记录最终包哈希、原始未配置状态、创建/跳过/重入、欢迎页真实统计、可选 Git 初始化不提交/不推送、更改路径确认与取消。

现有 acceptance feature 改变 Bundle ID、编译配置与签名，适合补充源码功能验收，不可当作最终公证包的原生运行证明。临时替换正式 shared.json/settings.json、重签改 identifier 或伪造 XDG 配置隔离都不满足本任务边界，因此未准备此类启动脚本。

本次 artifact-verification.json 仍明确只读源码/实际包证据，不声称 GUI E2E 通过。
