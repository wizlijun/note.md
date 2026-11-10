# Linux 插件音频会话回归

基线：冻结发布 `v6.1110.6` / `024d81814b4076def2456428150a4a2cd84095de`。修复分支 `fix/sumi-linux-sound`，不包含 main 后续 Smart Lookup 功能。

## 结果

| 检查 | 结果 |
| --- | --- |
| 修复前生产 `PluginProcess::spawn` 回归 | exit 101，插件收到的运行目录为空，断言失败 |
| 仅 Linux 增加 `XDG_RUNTIME_DIR` 后同一回归 | exit 0，1 passed |
| 原平台白名单/命令回归 | exit 0，2 passed |
| `cargo check --locked --lib` | exit 0，30.16s，6 个已有 warning |

`red.log` 使用基线白名单（`platform.rs` Git blob `9677e138d1910bc282a6cc07043fe4e32f956f33`）和新增测试；`green.log` 使用同一测试及最小修复。测试先启动独立测试进程，再调用生产插件启动函数；子进程必须收到临时运行目录，同时不能收到伪秘密变量和额外控制变量。没有修改测试运行器的全局环境，也没有连接音频服务或播放样本。

## 重跑

```sh
CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path src-tauri/Cargo.toml --lib plugin_runtime::process::tests::linux_plugin_spawn_preserves_runtime_without_secrets -- --exact --nocapture
CARGO_BUILD_JOBS=1 cargo test --locked --manifest-path src-tauri/Cargo.toml --lib platform::tests::
CARGO_BUILD_JOBS=1 cargo check --locked --manifest-path src-tauri/Cargo.toml --lib
```

本轮复用 `/home/bruce/git/note.md/src-tauri/target`，测试命令另设 `RUSTC_WRAPPER` 为随附 `rustc-wrapper.py` 的绝对路径；它仅为宿主测试链接添加 `-fuse-ld=lld`、`--threads=1`，控制资源占用，不替换业务代码。平台两项测试直接运行绿灯构建出的测试二进制。

## 边界

生产变更仅 Linux 环境白名单多一个 `XDG_RUNTIME_DIR`；Mac、Windows 和其他 Unix 白名单内容保持原样。没有改 150ms 音效超时、重启策略或用户偏好，也没有更改签名插件包。已有插件进程环境不会被追溯修改，正式宿主需重新启动插件后验证音频输出。本报告证明源码修复与启动环境回归，正式安装包验收由发布流程另行记录。
