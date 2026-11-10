# Sumi 聚焦抖动与滚动条修复验证

基于正式 6.1110.4 源码 `25157f1d` 的隔离分支。本报告验证原生编辑器源码；不代表新的正式宿主已发布或用户机器已安装修复。

## 根因和修复

GTK 3.24 将 Adjustment 截断为整数计算 TextView yoffset。原中心计算把浮点 Adjustment 加回整数 window-space 坐标，保留前一帧的小数部分。真实 Sumi GTK 测试中，同一插入点反复得到 `1749.5 / y234`、`1750 / y233`，导致正文跳动一个像素（见 red.log）。改用同样的 `trunc()` 抵消 GTK 滚动像素偏移，保留目标小数、上下限夹取和平滑动画。

正文 ScrolledWindow 改用 External policy、None shadow，隐藏滚动条与容器边框，保留视口分配与滚动。不改变普通窗 CSD 或全局 GTK 主题。

## 验证结果

- `red.log`：旧生产公式下新增真实 GTK 稳定性回归失败，捕获一像素往返。
- `green-scale1.log`：修复后 100 行文本，三种字号、奇偶与小数高度、三种小数滚动起点，540 次采样稳定；动画目标与起点保持不变。
- `green-scale3.log`：最终测试扩展到 1280 宽/800 高，scale 3；22、约 23.19（当前全屏比例）、27.5 三种字号，四种高度、三种小数起点，共 720 次采样全部严格一致。三次动画保持目标不漂移且完成；隐藏滚动条后滚动 50px，正文仍精确移动 50px，视口不被长文撑大。
- `ime-scale3.log`：真实私有 Fcitx d2 addon 输入、选词、富文本投影、保存失败草稿、候选换行、两模式与非聚焦原位输入回归通过。该轮与最终轮生产代码相同，之后仅扩展测试覆盖与格式化测试函数。
- `transactions.log`：最终原生 Wayland 编辑事务与聚焦恢复测试通过。
- `unit.log`：最终二进制普通测试 27 项通过，6 项显示测试默认 ignored，显示测试已按上述过滤器独立执行。
- `scrollbar.png`：scale 3 会话内 GTK offscreen 逻辑像素截图，退出聚焦后正常滚动的正文。1280×800，最右 10 列全部 8000 像素均为正文背景 `#111111FF`，无轨道或边框；人工查看也确认。不是用户真实桌面截图。
- `gtk-repro.py` / `gtk-repro-result.json`：独立 GTK 3.24.52 最小复现，旧公式每轮往返，新公式连续一致。私有 Broadway 已停止。

所有 Wayland 测试由 run-native.sh 创建独立 Sway、D-Bus、Fcitx 和配置，退出后清理；未向用户桌面注入输入或修改用户文档。未采集用户运行宿主的实时窗口反馈，因此不把此报告扩大为整个宿主发布验收。

## 复验命令

```sh
RUSTUP_TOOLCHAIN=stable CARGO_BUILD_JOBS=1 \
CARGO_TARGET_DIR=/home/bruce/git/note.md/tasks/sumi-fcitx/target \
cargo rustc --manifest-path tauri-plugin-native-editor/Cargo.toml \
  --profile test --lib --offline -- -C link-arg=-Wl,--threads=1

SUMI_CANDIDATE_SCALE=3 scripts/sumi/fcitx-candidates/run-native.sh \
  /home/bruce/git/note.md/tasks/sumi-fcitx/target/debug/deps/tauri_plugin_native_editor-f6c6a8e8e22225ee \
  --artifacts /home/bruce/git/note.md/tasks/sumi-fcitx/focus-stability/final-scale3 \
  --sway-prefix /home/bruce/git/note.md/tasks/omarchy-build/headless/sysroot/usr \
  --test-filter native_focus_center_is_idempotent_offscreen
```

二进制路径随 worktree 构建变化；新构建时须核对实际输出，不能调用旧二进制。省略 test-filter 跑真实候选测试，改为 native_wayland_transactions 跑事务测试。文件和最终二进制哈希见 verification.json。
