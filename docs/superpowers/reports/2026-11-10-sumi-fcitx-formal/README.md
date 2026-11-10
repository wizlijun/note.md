# v6.1110.2 正式三件套 GUI/Fcitx 验收

结论：正式 Debian amd64 宿主、正式签名 Sumi 0.1.11 插件与 d2 Fcitx 模块在独立 Sway/D-Bus 会话联合验收通过。本任务未公开发布、未安装到物理桌面，未修改生产源码。

## 冻结来源

- Tag `v6.1110.2`，提交 `1dc72c9b2f5465c0bb9e94be2cdfcbed597bbee4`。
- 宿主 deb SHA256 `0ae726211c3059b1bcfc892b904cf29ea50d8790106fedabc6a4a8b87f375976`。
- `/proc/125410/exe` 实际指向该 deb 提取程序，SHA256 `cccbc48fc8fb52b9c2b158c6cd640c4ac4633e1e0dd3a33c6e281fb6043d82e7`。
- Sumi 包 SHA256 `b5f6347e84e30709eb429a02fbdcb58b9313c4901cea27ce9b832b0eb4a6bbb8`；使用冻结 tag 的生产公钥，minisign 包签名和 comment 签名均通过。29 文件逐项记录，manifest 与冻结源码完全一致：0.1.11、最低宿主 6.1110.2。
- `/proc/126041/exe` 实际指向隔离环境 `notemd.sumi/0.1.11/bin/notemd-sumi`，SHA256 `d044c31ddac05f654cc5901dde98c0ed7c45bc5f21d579a3b361477db86afecb`。
- Fcitx 模块来自 `d2c14429` 实际 Arch 包，包 SHA256 `4bbd003599af85b6d2a4a15f0aaa598d973a63983ca58b00ab457f16a19c9314`；`/proc` 映射与包内 `.so` SHA256 一致。
- 冻结 tag 的 7 个宿主/原生关键文件哈希与此前 `8d55434e` 整合验收完全一致。详见 [插件签名与源码核对](plugin-verification.json) 和 [完整产物及进程证据](verification.json)。

## 实际 GUI 步骤

1. 由菜单打开正式 Sumi，载入隔离 Vault 原有七次“你好”。启用专注时真实输入 `nihao`：组字仅下划线，候选在下一行、左侧起排、同字号行距、无独立框；鼠标选择首词后保存精确为八次“你好”。[专注截图](formal-focus-preedit.png)
2. Appearance 关闭 Focused typing 并 Apply，再输入 `nihao`：正文输入行固定底部，候选位于其下；鼠标选择后保存精确为九次“你好”。[非专注截图](formal-bottom-preedit.png)
3. Ctrl+A/Ctrl+C 后显式读取 `text/plain;charset=utf-8`，内容精确为九次“你好”。未把其他 clipboard target 的编码输出作为 UTF-8 正文比较。[复制内容](formal-clipboard-plain.txt)
4. Ctrl+W 关闭 Sumi，经菜单重新打开，确认新的 Fcitx IC 获焦，再输入 `nihao` + Space + Ctrl+S；正文精确为十次“你好”，没有原始拼音或重复提交。
5. 经真实剪贴板粘贴换行及 `CLIPBOARD 中文 😀`，保存内容逐字相同。[粘贴截图](formal-pasted.png)
6. 关闭独立窗口，使用正式宿主 `--gui <同一 writing.md>` 打开原生写作标签。主窗口从 1000 缩至 600 像素，真实候选由一行变两行，正文随候选占用向上移动；继续请求 400 时 GTK 最小尺寸约束使实际宽度为 548，按 compositor 实测记录，不声称正式宿主验证了 400 像素。[600 截图](formal-tab-narrow.png)、[548 截图](formal-tab-400.png) 及对应 tree JSON。
7. 在窄标签中鼠标选择首词并保存，正文尾部精确追加“你好”；恢复 1000 像素成功。[恢复截图](formal-tab-restored.png)

最终正文：

```text
你好你好你好你好你好你好你好你好你好你好
CLIPBOARD 中文 😀你好
```

## 验收边界

正式包运行于 Arch x86_64 上的独立 Sway/私有 D-Bus，使用真实 GTK/Fcitx、虚拟键鼠以及隔离 Vault；不是物理桌面安装验收。此前同一原生源码的 4 倍缩放、四行/分页、失败草稿、输入框隔离、重启重连及裁剪红绿已通过，本轮正式包没有重新执行全部自动化组合。不验收无头环境的音频输出。

准备脚本 [stage-release.py](stage-release.py) 使用发布方给出的哈希及冻结 tag 公钥，验签后才解包并切换隔离插件版本；报告不含私钥或发布凭据。正式公开发布由发布任务负责。
