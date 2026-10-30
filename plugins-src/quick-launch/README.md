# Quick Launch / 快捷启动

通过「插件 → 体验增强 → 配置快捷启动…」管理本机应用和 Shell 命令，保存后在托盘「启动」子菜单显示。默认第一项为「屏幕重连」：`uc reconnect`；第二项留空且停用。

- 最多 20 项，支持名称、类型、目标、启停和上下排序。
- 应用可填写名称或绝对路径，也可通过文件选择器选择 `.app`。
- 配置仅保存在本机。读取错误不会恢复默认命令；有未保存修改时不能运行。
- 命令后台执行，最长 60 秒。退出成功不表示外部设备已响应。
- 当前应用启动与 Shell 执行面向 macOS，不注册全局键盘快捷键。

UI-only 官方增强插件，依赖宿主 `host.quickLaunch.get/save/run` 服务。最低宿主版本 `6.1030.1`；需配套宿主发布，不能单靠安装此插件给旧版宿主补齐能力。

开发检查：在本目录使用已有根目录依赖运行 `../../node_modules/.bin/vitest run`、`../../node_modules/.bin/tsc --noEmit` 和 `../../node_modules/.bin/vite build`。

构建后集成验收：`cargo test --manifest-path src-tauri/Cargo.toml --test quick_launch_plugin -- --include-ignored`。默认 Rust 测试不要求已有 dist；生产资产检查需显式运行。
