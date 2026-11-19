# 首页应用快捷方式验收记录

日期：2026-11-19。工作分支：`feat/home-app-shortcuts`。基线：`969f8e73`。

本次实现顶部三个创建/打开图标、最多八个常用或固定应用位置、离线已安装应用目录、底部设置与默认折叠的 Vault 概览。仅使用蓝、青、赭三组图标颜色，浅色和近黑深色共享布局，窄窗改为两列。

## 实际界面

以下图片来自真实 Svelte 组件与隔离 Tauri IPC fixture，不是生成式设计稿。示例 Vault 和安装清单均为测试数据。

| 场景 | 截图 |
| --- | --- |
| 桌面浅色 / 深色 | [浅色](home-light.png) · [深色](home-dark.png) |
| 390px 两列 | [浅色窄窗](home-narrow-light.png) · [深色窄窗](home-narrow-dark.png) |
| 全部应用 | [搜索与分类目录](all-apps.png) |
| 右键菜单 | [全局蓝底白字 hover](menu-hover.png) |
| Vault 次要信息展开 | [详情](vault-expanded.png) |
| 长名称 / 初次使用 | [长名称](home-long-name.png) · [无伪造推荐](home-cold.png) |
| Vault 统计失败 | [折叠状态仍显示错误](vault-error.png) |

## 验证范围

- 模型与存储：固定位置、交换、自动与固定去重、八格上限、30个本地日统计、最近7日双倍、30秒去重、时钟回拨、跨午夜与DST、读取/保存失败及并发写入。
- 导航与启动：等待实际编辑器 flush，失败不离开文档；保留标签、未保存内容和自定义编辑器 iframe；窗口及文件视图成功才计数，文件选择取消/失败不计数，按菜单/上下文来源重新检查门禁。
- 目录与交互：本机已安装清单、现有八类筛选、禁用项可查看原因、明确声明的窗口/文件视图和设置入口；不执行任意首条插件命令；PDF 工具显示现有原生“插件 → 数据导入导出”菜单路径。
- 浏览器：图标中心和边界对齐、三色浅深主题、390px 两列不横向溢出、长名称、固定交换/拖放/重载持久化、保存失败保留旧状态、安装清单失败不清理、全局菜单 hover、目录及延迟保存失败后的键盘焦点、Vault 关键统计与异常可见。
- 独立审查发现的问题均以回归测试跟进：异步文件激活、命令入口门禁、详情/保存后的焦点、目录加载与空状态、运行时清单共享、严格安装清单读取、原生窗口失败传播。

## 执行证据

前端功能冻结于 `e4e6b56c513a302dfc0930e8508a418f89656f64`；其后只补充原生错误处理与验收记录。

| 检查 | 结果 | 本地日志 |
| --- | --- | --- |
| 全量前端 | 445 个文件，6006 项测试通过，退出码0 | `tasks/home-full-tests-verified.log` |
| 类型检查 | 0 errors，30 条既有 warnings | `tasks/home-typecheck-verified.log` |
| 完整生产构建管道 | 通过，退出码0 | `tasks/home-build-verified.log` |
| 真实组件浏览器交互 | 14 项 + 修复专项5项，通过，无 pageerror | `tasks/home-ui/check-final.log`、`tasks/home-ui/fixes-final.log` |
| 原生错误处理 | state 8、完整清单7、窗口呈现2、tray 10；共27项通过，退出码0 | `tasks/home-native-final-*.log` |
| 独立评审 | 模型、导航、UI及整分支复核通过；原3个Important均已关闭 | SDD ledger |

精确功能提交：模型 `252062d1`、时钟回拨 `e7003ac0`；保留文档与启动计数 `e68c9de9`、异步激活/入口门禁 `a4e74ff5`；UI `34610ce0`、目录修复 `248be430`、共享运行时 `e4e6b56c`；原生读取/窗口错误传播 `7701d492`、严格schema `df353a18`。最终功能源码为 `df353a18ae4b26827e3e26e8ccdf18d71e0d694b`。

浏览器记录：[主要14项交互](verification.json)、[审查修复及空目录专项5项](fixes-verification.json)。本机可复跑的夹具与脚本保留在该 worktree 的 `tasks/home-ui/`；日志保留于 `tasks/`。

原生回归先复现读取/窗口的5项行为失败；进一步补测缺字段对象及数组形式，分别复现4项和2项schema边界失败，再使用显式对象字段校验修复。使用已有 Rust 1.99.0 缓存，`CARGO_INCREMENTAL=0`、`CARGO_PROFILE_DEV_DEBUG=0`、`CARGO_PROFILE_TEST_DEBUG=0`、`CARGO_BUILD_JOBS=2`、`CARGO_NET_OFFLINE=true`、`CARGO_TARGET_DIR=/Users/bruce/git/mdeditor/src-tauri/target`；分别执行 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 后附 `plugin_runtime::state::tests`、`plugin_runtime::commands::tests::installed_inventory`、`plugin_runtime::windows::tests::present_plugin_window`、`plugin_runtime::tray::tests`。

原生增量编译曾因磁盘峰值不足中止；仅按清单移除了本任务生成的 notemd 中间产物，改用非增量编译后完整宿主库成功编译。该环境失败不计为通过测试。

全量测试使用 `node_modules/.bin/vitest run --config tasks/home-vitest.config.ts`。隔离 worktree 通过 symlink 复用原仓库依赖，wrapper 仅扩展 Vite 的 `server.fs.allow` 以允许从已有依赖读取 `?raw`/字体资源；产品测试配置与断言未改动。首次直接运行发生的三项外部依赖拒绝已在此环境设置后消除。

生产构建依次执行既有 `prepare-sumi-font.py`、`check-share-merge-purity.mjs`、`build-share-editor.mjs`、`vite build`、`check-editor-kit-build.mjs`、`check-share-editor-build.mjs`。无新增依赖。

## 边界

- 彩色墨水屏与 OLED 是配色和静态交互的设计目标；未在真实硬件上测量颜色、刷新或功耗。
- 浏览器使用真实组件和隔离 IPC，原生测试使用临时状态与模拟失败；未操作正式 Vault、调用有副作用的真实插件、发送提醒或安装应用。
- 原生窗口回归覆盖已有单例及普通新建窗口的同步显示、取消最小化与聚焦结果；既有 Sumi 首次全屏异步展示分支保持原行为，未宣称验证其后续所有系统动画/展示结果。
- 本文记录功能实现验收，不是安装包发布证据。用户随后已明确要求发布宿主版本；冻结 tag、安装包与公开回读证据将另行记录。双语变更日志已写入 Unreleased。
- 原工作区的 `searchidx/src/store.rs`、`src-tauri/src/smart_lookup.rs` 既有改动，以及先前生成的 `output/` 设计稿，均未纳入本分支提交。

机读结果与日志/截图哈希：[evidence.json](evidence.json)。
