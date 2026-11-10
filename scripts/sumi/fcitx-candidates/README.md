# Sumi 候选区隔离回归

本脚本使用独立 headless Sway、会话总线及 XDG 配置/词库目录。D-Bus 配置禁止自动启动桌面服务；不访问正式 Vault，不替换或重启桌面 Fcitx，不连接现有 Wayland socket。`wtype` 是虚拟键盘，不能称为物理键盘或真实显示器验收。

前置：Fcitx 5.1.23、拼音引擎、Fcitx GTK 模块、g++/pkg-config、Sway、wtype、grim、dbus-run-session，以及包含 sumicandidates 模块的 Fcitx 源码。

```sh
cargo test --manifest-path tauri-plugin-native-editor/Cargo.toml --lib --offline
# 上一命令输出的 unittest 可执行文件路径（不要选旧二进制）：
scripts/sumi/fcitx-candidates/run-native.sh /absolute/path/to/tauri_plugin_native_editor-HASH \
  --artifacts /absolute/path/to/private-results --fcitx-source ~/git/fcitx5
```

可传 `--test-filter native_caret_geometry_offscreen` 或 `--test-filter native_wayland_transactions` 复核原生基础桥回归。

Sway 可以只解包、不安装；此时传 `--sway-prefix /path/to/extracted/usr`。构建输入源码与测试二进制必须来自同一份改动。可用 `SUMI_CANDIDATE_SCALE=4` 验证 4 倍缩放；`SUMI_CANDIDATE_IM_MODULE=wayland` 请求 GTK Wayland IM module（实际使用的后端仍须结合 Fcitx 日志确认）。默认使用 `fcitx` GTK module。

覆盖真实拼音候选、异步选词提交、Markdown 富投影删除格式符/改变选区、同程序其他输入框隔离、窄窗口回退、四行布局与分页、Fcitx 重启恢复、保存失败草稿保护。截图包含真实 nihao 候选，以及注入的四行展示样本；后者不代表引擎扩充了候选数量。布局样本不修改正文。

产物包括测试日志、Fcitx/Sway 日志和截图。脚本结束时停止其创建的私有进程，保留目录供审阅；不会退出或重启正式输入法。

## 部署依赖

宿主须包含原生 Sumi 候选实现；Fcitx 须加载 fork 中的 sumicandidates addon。addon 不可用、其他 UI 或无法安全接管时，Sumi 保留普通输入法候选，不会重写用户输入。仅构建或测试不表示已安装到正在运行的 note.md/Fcitx；安装与发布应记录对应产物哈希。
