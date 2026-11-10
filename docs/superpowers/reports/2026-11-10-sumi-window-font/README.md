# Linux Sumi 字号与原生全屏测量

2026-11-10，在私有 Wayland/Sway、独立 D-Bus 下执行真实 GTK 测试，未操作用户桌面窗口。

- 原生快捷键测试及普通 crate 测试：27 passed，4 需要显示的测试 ignored；快捷键提交 ecfb6e09。
- 合入正文静止候选修复 bb5e7e2b 后，普通 crate 回归仍为27 passed、5 display tests ignored；本目录JSON已更新为合并后的真实测量。
- `native_fullscreen_font_geometry`：1 passed。3840×2400 输出、scale 2，逻辑全屏 1920×1200，普通窗口 960×720。
- 固定有效字号 22 和 27.5 各自执行普通→全屏→退出。每种字号的 `M`、`Ag中` Pango logical/ink 尺寸在三个阶段严格相等；光标均落在该文本行内，正文保持一致。原始数据见 `gtk-scale2.json`。
- 不同字号之间存在正常的 hinting/fallback 指标差异，不能用单字宽高缩放比完全相等作为断言。
- 宿主生产纯函数抽取测试：全屏比例、字号上限、小视口、非法尺寸和往返恢复；菜单平台修饰键边界，共2项通过。宿主 `cargo check --manifest-path src-tauri/Cargo.toml --lib` 已由并行窗口任务执行并exit0，6项既有警告，日志tasks/plugin-window-fix/host-check.log。

## 重跑原生测试

构建 `cargo test --locked --manifest-path tauri-plugin-native-editor/Cargo.toml --lib --no-run`，取输出中的测试二进制路径。运行器复用 `scripts/sumi/fcitx-candidates/run-native.py`，仅把其输出尺寸 `1600*scale`、`1000*scale` 在临时副本中改为 `1920*scale`、`1200*scale`。使用原 `dbus-test.conf` 和以下参数：

```sh
SUMI_CANDIDATE_PRIVATE_BUS=1 SUMI_CANDIDATE_SCALE=2 \
  dbus-run-session --config-file=scripts/sumi/fcitx-candidates/dbus-test.conf -- \
  python3 tasks/sumi-window-font/run-native.py TEST_BINARY \
    --artifacts tasks/sumi-window-font/scale2 \
    --sway-prefix tasks/omarchy-build/headless/sysroot/usr \
    --test-filter native_fullscreen_font_geometry
```

## 正式宿主仍需验收

隔离 GTK 证据证明在固定字号下原生窗口切换本身不改变字形指标，不能证明用户遇到的 Hyprland/WebKit 过渡错位已解决。正式构建验收应在同一轮采样：DOM `innerWidth/innerHeight` 与编辑器 `getBoundingClientRect()`、Webview 物理尺寸、窗口 scale、GTK allocation、有效字号及 caret。实际按 F11 从正文与弹层分别进入/退出，检查组字、repeat、正文及候选位置；基础字号偏好应保持不变。4K scale2 逻辑1920×1200按宿主纯策略应选择22→27.5，退出回22。若发现仅过渡时坐标不一致，应单独定位几何同步，不能用字号策略掩盖。
