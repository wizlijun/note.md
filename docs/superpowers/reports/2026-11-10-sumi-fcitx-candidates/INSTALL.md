# Linux 候选模块交付与回退

此模块只为 Sumi 原生正文提供候选呈现和组字下划线；不替换 Fcitx 的词库、提交逻辑或系统 Classic UI。其他应用及 Sumi 内普通输入框沿用原输入法 UI。

## 配套版本与平台

- 宿主需包含候选整合提交。发布任务计划 note.md Linux x86_64 6.1110.2、Sumi 0.1.11（最低宿主 6.1110.2）；计划版本不代表已经发布，须以最终 tag/市场验签结果为准。
- Arch/Omarchy x86_64 模块包依赖 `fcitx5>=5.1.23`、`fcitx5<5.2`、`gcc-libs`、`glibc`。真实拼音验收另使用 `fcitx5-chinese-addons` 与 GTK Fcitx 输入模块。
- 源码：Fcitx `d2c1442957f695b3a3bbd9c2aaec0f753c50a591`，包含去组字蓝底。旧 `47da99c` 包不满足该样式要求。
- 包：`fcitx5-sumi-candidates-5.1.23.r2.gd2c14429-1-x86_64.pkg.tar.zst`。
- SHA256：`4bbd003599af85b6d2a4a15f0aaa598d973a63983ca58b00ab457f16a19c9314`。
- 包内 `libsumicandidates.so` SHA256：`7d2f92d6c0f1b403cc1d409e466f6f31d955eab528c84cfc6d7077c9e1e9092e`。

该 Arch 包不适用于 Debian 的包管理器；Debian 12 默认旧版 Fcitx 不在本模块支持范围。宿主没有模块时仍可使用普通输入法候选，不应将 Linux 宿主可运行等同于所有 Linux 发行版均支持内嵌候选。

## 安装及确认

正式资产发布并核对校验值后，在 Arch/Omarchy 执行：

```sh
sudo pacman -U ./fcitx5-sumi-candidates-5.1.23.r2.gd2c14429-1-x86_64.pkg.tar.zst
```

保存正在编辑的内容、完成当前组字后，正常重启 Fcitx 或重新登录。打开配套 Sumi，在原生正文输入拼音，确认组字无蓝底、候选仅细下划线；再在普通输入框验证系统候选仍正常。模块只装入独立 `.so`、addon 配置和许可证，不覆盖 Classic UI 或个人词典。

若模块缺失、版本不兼容、当前输入上下文无法安全接管、可用宽度太窄或 D-Bus 连接失效，Sumi 释放候选租约并保留普通输入法界面。遇到正在显示的系统候选时，结束当前组字后再尝试接管。

## 回退

保存内容、结束组字后移除此独立包：

```sh
sudo pacman -R fcitx5-sumi-candidates
```

正常重启 Fcitx 或重新登录，恢复系统输入法候选。个人词典和历史数据不受影响；宿主和 Sumi 无需卸载。以上命令是发布交接说明，本次隔离验收没有在用户桌面执行安装或卸载。
