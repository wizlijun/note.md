# 快捷启动验证记录（2026-10-30）

## 结果与范围
新增 Quick Launch / 快捷启动增强插件与配套宿主服务。默认 cmd1「屏幕重连」执行 `uc reconnect`，cmd2为空且停用；支持最多20项App/CLI配置、启停、排序、显式保存、已保存项执行、托盘启动子菜单及配置入口。仅支持macOS；配置存本机应用配置目录，不写Vault。

未发布、未安装至正式note.md、未执行真实uc reconnect；只读确认uc位于 `/opt/homebrew/bin/uc`。插件最低宿主6.1030.1是未发布功能门槛，不能仅发布插件到当前旧宿主。

## 自动验证
- 后端 `cargo +1.99.0 test --manifest-path src-tauri/Cargo.toml --lib quick_launch`：13通过，包含配置原子保存/损坏/上限、身份和停用、只允许UI通道、同项防重、App独立argv、真实隔离zsh登录PATH、非零退出、大输出排空和进程组超时。
- 既有托盘测试：9通过。RPC capability门禁测试：1通过（循环含新增3方法）。
- 生产manifest及协议集成：2通过（旧宿主拒绝、新宿主发现、启停/卸载、真实生产UI资产、桥注入和来源限制）。命令：`cargo +1.99.0 test --manifest-path src-tauri/Cargo.toml --test quick_launch_plugin -- --include-ignored`。生产bundle测试明确要求先构建；默认Rust测试无需dist。
- 插件UI：9项行为测试通过、TypeScript检查通过、Safari15目标生产构建通过，实际pnpm filter与包名匹配。
- 打包/索引/分类/本地化相关：109通过；跳过1项已确认的既有NEXT版本断言（测试固定1.10.0，HEAD manifest已为1.11.0），原完整运行108通过1失败，新增打包测试后109通过。未修改该无关测试。
- 宿主Svelte检查：0错误、31项既有警告。宿主开发库及原生验证程序编译通过。

## 真实macOS窗口验收
使用临时原生验证程序，独立identifier `net.notemd.quick-launch-verify-20261030`；调用生产 `protocol::handle`、`windows::open_plugin_window`、`ui_rpc::dispatch` 与 `quick_launch` 服务，加载正式dist，未预置假bridge。
- 原生plugin://窗口加载默认屏幕重连与command2，无读配置报错。
- 编辑CLI后运行按钮禁用；保存后可运行。`printf 'quick-launch-native-ok\n'` 输出可见且正确显示完成。
- `printf 'fixture failure\n' >&2; exit 7` 可见退出码7与错误文本，无假成功。
- 原生应用选择器选择 `/System/Applications/Calculator.app` 后路径正确回填；启用、保存、运行后计算器实际进程/窗口出现。
- 界面截图核对无重叠；原生下拉类型和选择器可用。
- 验证程序、计算器已退出，隔离配置已移至本地证据目录；临时可执行app和examples源已清理。

此原生验收覆盖配置窗口与执行服务；完整宿主托盘的实际鼠标菜单交互未另行启动验收，托盘组装通过宿主编译、既有菜单回归及生产插件启停集成检查。

## 审查与证据
独立审查发现并修复真实桥接get参数null及打包filter不匹配，均补回归；托盘失败通知改成限长单行摘要，避免大stderr挤满原生菜单。
本地详细日志与验证程序源：`tasks/quick-launch-20261030/`（git忽略）。仅提交本轮插件/宿主/脚本/文档改动，保留其他NEXT与Agent未提交工作。
