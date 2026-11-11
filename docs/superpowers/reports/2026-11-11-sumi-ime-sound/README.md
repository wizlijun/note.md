# Linux Sumi 输入法组字音效验证

## 结果

- 修复前真实 Fcitx 输入 nihao，未提交阶段 Key 事件为 0，新断言要求 5，失败见 red.log。
- 修复后 GTK_IM_MODULE=fcitx 与 wayland 均得到五个 Key 事件，正文此时仍为空。选词提交及清空不补声。
- 重复组字文本、投影中、隐藏和失败表面不补声；关闭音效后再次真实输入 nihao 仍静默。
- 两条通路英文 abc 均为三次 Key 和三次 KeyUp；fcitx fixture 切到本地 GTK compose，真实 Multi_key、apostrophe、e 生成 é，恰好三次 Key，验证同步事件去重。
- 原候选综合测试通过，包括富文本提交投影与草稿失败；普通单测 29 通过，7 显示测试默认 ignored，本次单独运行上述三个显示测试。

## 范围与限制

测试运行在私有 Sway、D-Bus、Fcitx 内，以音效 handler 收集生产事件，不播放真实音频、不修改音量、不修改用户文档或桌面配置。未构建/安装/发布正式宿主，本报告不证明已进入安装包。当前修复是组字变化反馈，不保证输入法吞掉且不改变组字文本的候选导航键也有声音。若未知输入法同时透传按键并异步发组字变化，当前仅针对同步 GDK 分发的去重并不保证覆盖；已测试的两种输入法通路无重复。

早期 wayland 完整候选用例在后续查找 focused Sumi context 的既有 fixture 假设处失败，音效部分已通过；最终使用独立音效入口验证 wayland，完整候选回归在 fcitx 跑通。早期测试强制从正在使用的 im-wayland 切换到本地 compose 时发生 GTK reset/preedit 递归栈溢出（测试 PID 7240，coredumpctl 确认 SIGABRT、Rust stack_overflow handler 与 GTK/im-wayland 重复帧，内存充足），不是生产流程；最终不在 wayland fixture 热切换模块，本地 compose 去重在 fcitx fixture 验证。该失败轮不计通过。

## 重跑

```sh
cargo test --manifest-path tauri-plugin-native-editor/Cargo.toml --lib --offline -j 2
SUMI_CANDIDATE_IM_MODULE=wayland scripts/sumi/fcitx-candidates/run-native.sh tauri-plugin-native-editor/target/debug/deps/tauri_plugin_native_editor-5ece4426f1455d02 --artifacts tasks/sumi-ime-sound/recheck-wayland --sway-prefix tasks/omarchy-build/headless/sysroot/usr --test-filter native_ime_typing_sound
```

模块换为 fcitx 验证另一通路；--test-filter native_candidate_roundtrip 跑完整候选回归。二进制文件名以实际构建输出为准。哈希按原始 bytes 计算，见 sha256.json。
