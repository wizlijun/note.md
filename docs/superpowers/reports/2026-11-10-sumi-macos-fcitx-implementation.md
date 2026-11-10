# Sumi macOS Fcitx5 源码改造记录

状态：配套源码已实现，组件与隔离引擎验证见下；尚未正式安装、打包发布，也未通过配套 Fcitx5 + Sumi 的完整实机验收。遵循 [跨平台规范](../specs/sumi-ime-cross-platform.md) 和 [本轮协议规格](../specs/2026-11-10-sumi-macos-fcitx-bridge.md)。

## 源码与实现

- 输入法 checkout：`/Users/bruce/git/fcitx5-macos-sumi`，分支 `sumi-candidates`；官方上游 `6322853b17aca03ce1f1b694208cc5201944ca69`，Fcitx5 macOS 0.4.3；core 固定 `5ffd9e5f905078880f1e21752e10b63490734809`（5.1.23）。
- 输入法实现提交 `0b4b866`，未推送；宿主实现随本报告精确提交，完整提交号另记于任务回顾。core 的业务改动以独立 patch 纳入上层提交，gitlink 保持固定；现有子模块工作区 dirty 是已重放的补丁，不是漏交源码。
- 宿主基线：note.md `d8df740c`。原有 `searchidx/src/store.rs` 和 `src-tauri/src/smart_lookup.rs` 的末尾换行改动保留，不属于本轮。
- 正文用稳定 UUID 的 `validAttributesForMarkedText` 属性声明能力，CFMessagePort 双向异步握手，以精确输入上下文、文档代次、租约和候选序号校验。先布局确认，再隐藏默认窗口并展示候选；失焦、关闭、超时或能力不支持时恢复默认窗口。
- AppKit 候选继承正文排版，最多四行，可本地翻页；普通模式固定底部、保持原滚动与选区，专注模式在完整当前行之后预留展示空间。候选和留白不进入文档。Sumi 正文的预编辑样式不等待候选握手，首键即归一化；断连不提前恢复组字选区底色，commit/unmark 恢复普通选区。其他输入框不变；正文仍可滚动但不显示滚动条。
- CommonCandidateList 额外上下文过滤层仅在接管期间屏蔽自动 emoji，保留引擎原过滤；点击和数字键共同使用真实列表。退出接管恢复原候选。未修改用户全局拼音设置、词库或正文 emoji。
- 点选/翻页在精确上下文的同步事件内刷新延迟 UI，再返回原客户端的 commit/preedit，防止旧预编辑落到后续输入框。

## 已验证的层级

| 验证 | 实际结果与边界 |
| --- | --- |
| 原生候选布局 | 20,877 个循环、几何、索引、Unicode 和离屏绘制断言通过；属于离屏组件验证 |
| 真实 NSTextView 宿主 | 60 项通过，覆盖普通候选变化不动滚动/视区/选区、专注留白、未连接首键样式、组字中断连不写正文/修订/选区、原生组字与单次提交“你好”、搜索失焦、普通选区恢复；使用合成隔离文档和测试焦点条件。属性断言不替代真屏蓝底检查 |
| ObjC 双进程协议 | client 13 + host 12 项通过，覆盖握手、两阶段显示、点击、清空、旧租约和超时 |
| ObjC ↔ Swift 生产桥 | 两进程生产桥通过握手、快照、点击、清空与撤销；Swift 引擎入口为桩，不能当作完整输入法验收 |
| 输入法构建和回归 | arm64 完整 Fcitx5.app 构建成功，无编译 warning/error，KEY_LOGGING=OFF；11/11 项选定 CTest 通过，包含 core 原候选测试、上下文过滤、同步 flush、Swift 协议和安全上游回归 |
| 真实拼音引擎 | 官方 pinyin 5.1.15 与 core 5.1.23，隔离配置、词库和缓存，关闭云端；原始 nihao 第二项为 👋，接管后为“拟好”，点击 index 1 与生产 frontend.keyEvent 的数字 2 均恰好提交一次，释放恢复 👋；另验证“你好”、shi 翻页、空列表和切焦拒绝。这是实际引擎，不是物理键盘或系统安装后的 IMK 测试 |
| 可复现 core 补丁 | 临时 Git 索引在固定上游重放 tempmode、safe-pipe 和本轮过滤 patch；六个文件与当前 core 逐字节一致，没有改变子模块索引或分支 |
| 旧原生回归 | draft、caret、focus-raster、focus-return 通过；没有操作正式 Vault |
| 光标渲染已知失败 | caret-render 的 KVO 次数门槛要求 ≥20，本机实际 12，gaps=0、visible_system_colors=0；相同探针对照 HEAD 原始生产源码也同样失败，未改门槛、未称全套通过 |

原生候选复现命令：

```sh
scripts/sumi/test-macos-candidates.sh /Users/bruce/git/fcitx5-macos-sumi/build/arm64/tests/sumi-bridge-swift
```

该命令只运行离屏 AppKit 与独立进程协议测试，不安装或切换输入法。构建输出和原始日志在 `tasks/sumi-macos-ime/` 与 `tasks/sumi-macos-ime-candidates/`；固定证据副本见同目录 `2026-11-10-sumi-macos-fcitx-evidence/`。

输入法构建与引擎复现见证据中的 `final-candidates-validation.md`，源码与二进制哈希见 `fcitx-source.json`、`app-final-candidates.sha256`。产物为 `/Users/bruce/git/fcitx5-macos-sumi/build/arm64/src/Fcitx5.app`。未运行会写用户配置或依赖正式安装路径的 `config-cpp`、`icon-cpp`、`layout-cpp`，不声称全套 CTest 通过。

接管时通过无预编辑回放的 WebPanel 重绘路径，让尚未隐藏的默认窗同步采用已过滤列表。这个实际窗口分支得到源码审查与完整编译验证，隔离引擎测试不实例化 WebPanel；默认窗真屏交接仍在后续实机门槛内。

预编辑改为正文同色后，旧 caret-render 的全页面同色像素扫描会把字形也算成光标。本轮将光标形状采样限定在真实光标视图的区域，保留全局系统光标审计、原尺寸断言和原 KVO 门槛；这份探针同时运行于新旧生产源码。未连接首键与断连样式的新增回归还在隔离副本恢复旧逻辑进行红测，两条旧路径分别失败。

## 真实 InputMethodKit 测试与清理

经用户明确授权，临时安装独立 `SumiMarkerProbe.app` 到 `~/Library/Input Methods`，在合成文档窗口测试。仅 TISRegister/TISEnable 不足以启用父源；通过系统设置正常添加后启用，本机无需注销登录。

真实 IMK 代理 `_IPMDServerClientWrapperLegacy` 在不同进程间成功传递自定义属性。正文→搜索→正文的激活日志记录 marker 数量 `1 → 0 → 1`，证明能力标记和控件隔离可行。

完整 probe 未通过：合成 `NSTextInputContext.handleEvent` 没有进入 IMK key handler，正文收到 `ac`、搜索收到 `b`，未得到预期远端 `insertText` 的“验验”/“验”。因此只证明 marker 通道，不把这次测试称为真实拼音输入或跨进程提交成功。

测试后已恢复 `com.tencent.inputmethod.wetype.pinyin`，移除测试 bundle，并通过系统设置移除缓存输入源。最终 `run.py inspect` 返回 `probe: null, parent: null`，文件不存在。测试源码及复现边界在 [marker harness](../../../scripts/sumi/macos-ime-marker/README.md)。

## 正式使用前仍需验收

- 配套宿主与 Fcitx5 的系统安装、实际加载和物理键盘输入，真实候选窗隐藏/恢复、点击恰好提交一次。
- 真屏缩放、全屏往返、长文、字体切换与连续输入的像素稳定性；离屏测试不能证明屏幕表现。
- 真实输入法进程重启、窗口切换、组字取消与撤销、保存失败及关闭重开组合。
- 尚未构建新的 note.md 分发包或 Sumi 插件包，未公证、未推送、未发布。构建目录中的 Fcitx5.app 依赖上游约定的安装资源路径，不能当作可直接分发的安装包。

这些是安装包验收门槛；本轮源码和局部测试通过不等于跨平台规范全部验收通过。
