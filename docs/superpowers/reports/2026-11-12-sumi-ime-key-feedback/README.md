# Sumi Linux 完整输入法按键音效：6.1112.1 发布验证

Linux amd64 `v6.1112.1` 已公开，10 项附件已上传。正式宿主与 r4 模块联合实包验收通过：旧版漏声的 8 个输入阶段已恢复，24 个目标阶段全部录到非零音频。新旧每阶段正文和 preedit 完全一致。

## 冻结源码与修复

- 发布 tag：`v6.1112.1` → `d21010dece28ccfb9b785fe8be1cfa847e2c5989`。
- 宿主修复：`f1cc4ef83e65f6c9ac39d5c2153c36ea05574231`。
- Fcitx r4：`b07f55ca2415c48190c84a4c6e17df41bec4f9fc`。
- core：`1722a6dedec8ee79e7a6ff046e7eeafb7187102e`；沿用正式签名 Sumi `0.1.12` 插件。

6.1111.5 以非空 preedit 变化补音，遗漏了没有这类变化的中文标点、空格/回车确认、删空、候选导航及数字选词。本次 Fcitx 在 `PreInputMethod` 观察真实按键，只有明确启用的当前候选租约、确切聚焦上下文和拥有者才能接收定向 `TypingKey`。不传文本或 keysym，不改变输入过滤或提交；保留快捷键过滤、按下/释放配对及失焦清理。

宿主按 `(time, hardware code, release)` 对本地与输入法来源一一配对，避免透传双响；同来源长按重复即使复用时间戳也保留。匹配队列上限 128，零身份不猜测去重。新桥接协商成功后关闭 preedit 补音；旧模块兼容回退仍有原来的漏声边界。因此完整修复必须同时更新宿主 6.1112.1 和 r4。

## 验收证据

- 发布前枚举 9 个 note.md worktree、本地分支及 stash；旧 5 组 Sumi 补丁等价且功能仍保留，旧版本 bump、依赖链接及本地任务缓存排除。审计见 `pre-release-audit.json`。
- 冻结原生单测 35 通过，7 显示测试默认 ignored；冻结 Wayland、Fcitx GTK 真实按键专项各通过，覆盖按键角色、释放、确认、标点、删空、导航、选词、英文去重、长按、开关与失焦。候选综合与旧协议回归各通过，后二者在最终仅格式化变更前运行；详情见 `frozen-source-validation.json`。
- 前端/core 沿用此前已验证的 5883 项前端测试基线，本轮未宣称重跑全量；官方冻结容器完成重建。
- Arch 与 Deb 载荷及实际宿主二进制逐字节一致；版本、依赖、文件模式、ELF、`ldd -r` 和 CLI 验证通过。Arch 配方与官方脚本生成的已验证配方相同，见 `arch-verification.json`、`official-recipe-verification.json`。
- r4 实际包仅三个载荷文件，ELF/重定位通过，私有总线确实加载解包 `.so`；十项真实拼音协议回归通过，含租约、串号、定向信号、旧接口、重复时间戳和清理，见 `ime-verification.json`。
- 配套构建 bundle 完整包含冻结 tag 的 8 文件；内部 7 个源码文件匹配 Fcitx `b07f55ca` 与 manifest，安装说明版本为 6.1112.1。完整源码归档随附件提供，不依赖尚未推送的 Fcitx 分支。见 `companion-attachments-verification.json`。

## 实际包音频对照

有效旧轮为 `gui/baseline2/`（6.1111.5+r3），有效新轮为 `gui/verified/`（6.1112.1+r4）。两轮使用相同正式签名插件后台和相同真实时间戳键盘 helper。新轮核实实际 D-Bus 新接口及进程映射的 r4 `.so` 哈希。

仅在私有 Sway/Fcitx、PipeWire/Pulse、WirePlumber 和隔离 Vault 中录制实际 Sumi 后台 PID 的单独音频流，输出到 null sink。未连接用户音频会话、未打开硬件音频设备、未修改用户音量或正式文档；所有测试进程已退出。两轮静默基线峰值均 0，英文正控均 0.48947450518608093。新包 23 个阶段间隙全部峰值 0，排除了把前键拖尾当作后键音效。

下表为 float32 PCM 幅值（保留 6 位），精确值、字节区间及正文/preedit 见 `gui/comparison.json`。非零音频证明播放发生；每键去重另有真实事件断言，不仅凭峰值判断。

| # | 阶段 | 按键 | 旧包峰值 | 新包峰值 |
| --- | --- | --- | ---: | ---: |
| 1 | `pinyin-n` | `n` | 0.489475 | 0.489475 |
| 2 | `pinyin-i` | `i` | 0.489475 | 0.489475 |
| 3 | `pinyin-h` | `h` | 0.489475 | 0.489475 |
| 4 | `pinyin-a` | `a` | 0.489475 | 0.489475 |
| 5 | `pinyin-o` | `o` | 0.489475 | 0.489475 |
| 6 | `space-select` | `Space` | 0.000000 | 0.489475 |
| 7 | `chinese-period` | `.` | 0.000000 | 0.489475 |
| 8 | `chinese-comma` | `,` | 0.000000 | 0.489475 |
| 9 | `return-compose-n` | `n` | 0.489475 | 0.489475 |
| 10 | `return-compose-i` | `i` | 0.489475 | 0.489475 |
| 11 | `return-confirm` | `Return` | 0.000000 | 0.489475 |
| 12 | `delete-compose-n` | `n` | 0.489475 | 0.489475 |
| 13 | `delete-compose-i` | `i` | 0.489475 | 0.489475 |
| 14 | `delete-nonempty` | `BackSpace` | 0.489475 | 0.489475 |
| 15 | `delete-to-empty` | `BackSpace` | 0.000000 | 0.489475 |
| 16 | `navigation-compose-n` | `n` | 0.489475 | 0.489475 |
| 17 | `navigation-compose-i` | `i` | 0.489475 | 0.489475 |
| 18 | `navigation-compose-h` | `h` | 0.489475 | 0.489475 |
| 19 | `navigation-compose-a` | `a` | 0.489475 | 0.489475 |
| 20 | `navigation-compose-o` | `o` | 0.489475 | 0.489475 |
| 21 | `left-navigation` | `Left` | 0.000000 | 0.489475 |
| 22 | `right-navigation` | `Right` | 0.000000 | 0.489475 |
| 23 | `numeric-selection` | `1` | 0.000000 | 0.489475 |
| 24 | `latin-positive-control` | `x` | 0.489475 | 0.489475 |

旧包 16 阶段有声、8 阶段漏声；新包 24 阶段全部有声。最终正文均为 `你好。，ni你好x`，每阶段组字与正文语义一致；新包实际截图已审阅。新录音 10,295,040 bytes，SHA-256 `ff8af5351f812363babf378a19b3c402f57f34f5d2a69ea43cd740e522642279`。

首轮新包 `gui/fixture/`、`gui/evidence/` 不计入通过：首次拼音懒加载约 750ms，固定等待过早读取 GTK，使首键 preedit 断言失败，该键实际 PCM 已非零。最终改为等待 GTK 主循环新采样及预期状态就绪，使用同一冻结 Deb/r4，未修改产品或放宽音频断言。早期 `gui/baseline/` 是参数变量名冲突导致的测试框架失败；有效旧证据为 `baseline2/`。失败轮均已清理，说明见 `audio-fixture-notes.md`。

## 交付哈希

| 对象 | SHA-256 |
| --- | --- |
| `note.md_6.1112.1_amd64.deb` | `48df59897aeed75770d652f2f7fcc141431804b9732b420205fe5fce9480a485` |
| `notemd-6.1112.1-1-x86_64.pkg.tar.zst` | `804ef3a34f2b0bd11c0160d1dcfc13a66204f6561a0c87857744fa53331f68a1` |
| `fcitx5-sumi-candidates-5.1.23.r4.gb07f55ca-1-x86_64.pkg.tar.zst` | `54f6b60e4faa82f3abb111b6f79de679ba41252f829bb397a4008b5d4992fd13` |
| `fcitx5-sumi-candidates-5.1.23.r4.gb07f55ca-build.tar.gz` | `bf92917b5cc88ed171b368546d67cf2ac9f64ca9f60407c3851e3561e237518e` |
| `fcitx5-sumi-source.tar.gz` | `52b6c811c38aa0f471f4c0c9e73ccf6132e052448f3a68c2a7f63b131b92bfe7` |
| 实际宿主二进制 | `6630c8b73d30767074c2e43acf72cdab3fed29b7e6757e975768cfce761b426b` |
| 实际映射 r4 模块 | `a67e71c5dba32fff70294e80b07f150b4d5eadd28fecc1bd2b84baec5ab35173` |
| 正式签名插件后台 | `d044c31ddac05f654cc5901dde98c0ed7c45bc5f21d579a3b361477db86afecb` |

## 发布与安装状态

发布页：https://github.com/wizlijun/note.md/releases/tag/v6.1112.1 。10 项附件清单见 `expected-assets.json`，包括 Deb、Arch、配方、三份校验清单、r4 包、完整构建包、源码归档与安装说明。

匿名公网完整回读 10 项附件全部通过，字节数与 SHA-256 均匹配本地已验收产物；远端 tag 对应冻结提交。验证时间 `2026-11-11T16:20:48.085587+00:00`，见 `public-verification.json`。GitHub latest 保持 `v6.1111.3`，macOS `latest.json` 逐字节未变。

本机联合安装完成：`notemd 6.1112.1-1`、`fcitx5-sumi-candidates 5.1.23.r4.gb07f55ca-1`。经系统管理员认证安装公网回读包，旧宿主通过托盘退出正常保存；Fcitx 已重载，重启后恢复原拼音输入法，新宿主和 Sumi 已启动。实际运行宿主与已验收二进制哈希一致，Fcitx 映射的新模块哈希一致且无 deleted 旧模块，新 TypingKey 接口可用；两包文件检查均 0 altered files。Sumi 正式后台匹配原签插件，音频流 active、未静音；未修改用户音量，也未向正式文档注入测试文字。本机逐键音频未自动测试，按键实声证据来自同一安装包的隔离验收。详见 `local-installation.json`。

测试覆盖当前 Linux amd64、Wayland/Fcitx GTK 及此包组合；无有效时间戳/硬件码的合成事件无法可靠跨来源配对。正式文档中的联合安装说明要求保存工作后重新建立应用与输入法连接。本报告与证据独立提交，精确提交号记于本地 `tasks/todo.md`；发行 tag 不移动。


原始任务目录：`tasks/sumi-ime-keys-release/`。本目录 `audio-comparison.json`、`audio-old-package.json`、`audio-new-package.json` 为对应有效轮完整结果；PCM 本地保留且哈希已记录。官方构建在 Debian12 与干净 Arch 容器运行验证完成，全部测试专用进程与本任务 rootless Docker 已关闭。
