# Sumi 真实 IMK 跨进程标记验证

这套隔离测试检查 `NSTextView.validAttributesForMarkedText` 的自定义标记能否经系统 InputMethodKit 代理抵达另一个进程，以及同一宿主正文→普通搜索框→正文时标记是否正确隔离。本轮已证明真实 IMK 跨进程标记转发和焦点隔离；合成按键未进入 IMK key handler，远端 `insertText` 未得到证明，整项验收未通过。这也不是 Fcitx 拼音验收。

源码位于 `scripts/sumi/macos-ime-marker/`；全部编译产物、恢复快照与日志写入 `tasks/sumi-macos-ime-imk/`，不进入版本控制。

## 当前实际结果

- 初版遗漏的必需图标已补齐，并按官方 Squirrel 配置补齐显式输入源 ID、模式可见性、默认状态、脚本、顺序和图标资源。完整包可在用户输入法目录注册并由新进程枚举。
- 仅调用公开 API 时，`TISEnableInputSource(parent)` 返回 0，但新进程仍看到父输入法 disabled，选择模式返回 -50。随后通过系统设置“键盘 → 文本输入 → 编辑 → 添加”搜索 Sumi 并添加，父源确实变为 enabled。这个正常 UI 路径在本机无需注销登录。
- `tasks/sumi-macos-ime-imk/evidence/ime.jsonl` 中，输入法 PID 为 **14248**，宿主 `host.jsonl` 中 PID 为 **14234**。输入法收到实际系统客户端代理 `_IPMDServerClientWrapperLegacy`；三次 `activate` 对应正文、搜索框、正文，`expectedMarker` 为 **true → false → true**，`markerCount` 为 **1 → 0 → 1**。`deactivate` 也正确反映离开的客户端标记。这证明属性标记经过了真实 IMK 跨进程边界。
- 合成的 `NSTextInputContext.handleEvent` 虽返回 `handled:true`，输入法日志中没有 `phase:"key"`。宿主最终正文为 **ac**、搜索框为 **b**，而不是预期的“验验”与“验”；`success:false`。因此不能把 AppKit 消费事件当作 IMK key handler 或远端 `insertText` 已执行的证据，完整运行测试仍未通过。
- 最终已执行脚本恢复和移除，并通过系统设置移除测试输入源；主代理复核 `inspect` 当前源为 **WeType**、`probe:null`、`parent:null`，用户输入法目录内测试包已不存在。未注销登录、未重启系统服务、未直接改写 HIToolbox 偏好。

## 为什么不能仅在仓库内注册

本机 Apple SDK `TextInputSources.h` 的 `TISRegisterInputSource` 说明明确限制：输入法 bundle 必须位于 `/Library/Input Methods/` 或 `~/Library/Input Methods/`。因此仓库内 `.app` 不是文档支持的注册位置。测试选择用户级目录，不需要 sudo、不替换 Fcitx 或其他现有输入法。

官方 Fcitx5 macOS README 要求首次安装后退出并重新登录。TIS 接口契约说注册后可立即枚举，但注册、父输入法启用、模式启用与选择是不同结果，必须由新的 `tisctl` 进程回读。`TISRegisterInputSource == noErr` 不是输入法可用证明。本机 probe 可通过系统设置添加来启用父源，无需注销；这不证明正式 Fcitx 候选窗的全屏行为也无需首次登录刷新。遇到源缺失即停止，保留证据，不自动注销、不重启系统服务、不改写 HIToolbox 偏好。

一手依据：

- Apple SDK `Carbon.framework/Frameworks/HIToolbox.framework/Headers/TextInputSources.h` 的 `TISRegisterInputSource` 注释。
- [Apple InputMethodKit](https://developer.apple.com/documentation/inputmethodkit)。
- [Fcitx5 macOS 构建和首次安装说明](https://github.com/fcitx/fcitx5-macos/blob/6322853b17aca03ce1f1b694208cc5201944ca69/README.md)。

## 运行步骤

以下命令不是构建的自动后续动作。`install-register` 会新增一个用户输入法；`run` 会短暂显示并激活独立测试窗口，暂时切换输入源，结束后恢复原输入源与原前台应用。主代理应在允许进行实机输入测试时执行。

```sh
./scripts/sumi/macos-ime-marker/build.sh
python3 scripts/sumi/macos-ime-marker/run.py inspect
python3 scripts/sumi/macos-ime-marker/run.py install-register
python3 scripts/sumi/macos-ime-marker/run.py run
python3 scripts/sumi/macos-ime-marker/run.py remove
```

若 `install-register` 注册成功但父源回读 disabled，脚本恢复原源后报错，测试包留在用户目录供进一步正常 UI 添加。系统设置路径为“键盘 → 文本输入 → 编辑 → +”，可搜索 `Sumi`，在简体中文类别添加 `SumiMarkerProbe` 或 `com.notemd.inputmethod.SumiMarkerProbe.Hans`。实际 TIS 本地化名称由 `inspect` 的 `name` 字段给出。添加后再次运行 `inspect`，父源和模式都 enabled 方可 `run`。此 UI 路径由主代理在本机实际验证；依据 [Apple 输入源设置说明](https://support.apple.com/guide/mac-help/mchl84525d76/mac)。

`install-register` 拒绝替换已有 `~/Library/Input Methods/SumiMarkerProbe.app`，并把本次安装前的输入源状态保存到 `evidence/recovery.json`（0600），保存本次复制包的文件哈希。新一次安装会刷新恢复快照；同一次安装的运行和恢复重试继续使用该快照。它注册并启用，不主动选择 probe 输入源。

`run` 创建普通 NSTextView 搜索框和声明固定测试 marker 的正文子类，在 `NSTextInputContext` 上提交三个合成 NSEvent（a、b、c）。独立 IMK 输入法在激活/失活时记录属性标记；只有真正进入其 key handler 时才调用系统文本客户端 `insertText`。本轮前者已执行，后者未执行。合成 NSEvent 不是物理键盘事件，不能仅凭宿主 `handleEvent` 返回值判断其经过了输入法。目标宿主之外的应用输入永远返回未处理。

以下是脚本的完整通过条件，不是本轮已全部达到的结果。当前运行会因实际正文不符合预期而失败：

- IME 和宿主 PID 不同。
- IME 三次输入依次收到 a/b/c。
- 自定义 marker 依次为 true/false/true，数量为 1/0/1。
- 客户端 bundle ID 一直是隔离宿主。
- 宿主正文得到“验验”，搜索框得到“验”，且正常恢复输入源。

正常结束或超时，外部 Python `finally` 再次恢复原输入源；恢复失败会明确报错并保留恢复文件。若终端或运行器被强制中止，使用：

```sh
python3 scripts/sumi/macos-ime-marker/run.py restore
python3 scripts/sumi/macos-ime-marker/run.py remove
```

`remove` 只在已安装文件哈希与本次 manifest 完全一致时删除自己的 probe bundle；先恢复原源、按原状态禁用 probe，并只请求退出该测试 bundle ID/路径的进程。macOS 没有这里可用的公共 TIS unregister；若系统设置仍列出测试输入源，应只移除该测试项并用新进程 `inspect` 复核。本轮脚本移除加系统设置移除后已确认父源与模式均为 null。
