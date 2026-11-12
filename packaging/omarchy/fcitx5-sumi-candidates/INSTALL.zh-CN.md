# Omarchy amd64 联合安装（v6.1112.1）

本发布配套 `notemd-6.1112.1-1-x86_64.pkg.tar.zst` 和 `fcitx5-sumi-candidates-5.1.23.r4.gb07f55ca-1-x86_64.pkg.tar.zst`。后者是 Linux Fcitx 5 addon，不是 macOS 的 Fcitx5。Sumi 候选布局由宿主提供；addon 提供候选桥接、输入中的下划线样式及受当前输入框租约限制的真实按键音效信息，不能单独替代宿主更新。Sumi 插件须使用项目正式签名版本。完整输入法音效需要宿主6.1112.1与本次r4模块同时更新；只升级宿主而保留r3模块无法覆盖中文标点和空格/回车确认。

## 安装

1. 下载同一 release 的宿主、addon 和校验清单，先按清单核对 SHA-256。
2. 确认系统 `fcitx5` 满足 `>=5.1.23` 且 `<5.2`。addon 的包级依赖只有该版本范围、`gcc-libs` 和 `glibc`。使用拼音还需 `fcitx5-chinese-addons`；GTK 应用输入还需 `fcitx5-gtk`，并沿用系统既有输入法环境。Qt 模块不是本次 Sumi/GTK 路径的必要依赖。
3. 对已满足前置条件的 Omarchy/Arch 系统，在下载目录安装两个包：

   ```sh
   sudo pacman -U ./notemd-6.1112.1-1-x86_64.pkg.tar.zst ./fcitx5-sumi-candidates-5.1.23.r4.gb07f55ca-1-x86_64.pkg.tar.zst
   ```

   缺失的拼音/GTK 包请通过系统正常完整更新流程安装，不进行部分升级或强行绕过版本依赖。
4. 保存工作后注销并重新登录，再启动新版宿主。这样 Fcitx 与应用重新建立输入连接；仅替换磁盘文件不会更新已经加载的模块。
5. 在 Sumi 输入 `nihao`，确认编号没有点、编号与词紧凑且词组之间有间距，分别点击和按空格提交“你好”。继续检查中文`。，`、拼音后空格/回车确认、退格至空、左右导航和数字选词都有键盘音效，英文不会双响。再在 GTK 应用验证中文输入正常。`pacman -Q notemd fcitx5-sumi-candidates fcitx5 fcitx5-chinese-addons fcitx5-gtk` 可检查安装版本，但不能替代实际输入验收。

addon 仅安装共享库、addon 描述和 LGPL 许可证三个文件，不覆盖 ClassicUI，不包含用户自定义 theme、字体、DPI、缩放或个人配置。全局输入预编辑去除高亮、保留下划线；正文已有文本的普通选区不在此修改范围，最终显示仍受应用控制。

## 固定源码与重建

公开分发时须把本目录的构建源码包作为同一 release 附件提供，不能只给私有或未推送的仓库链接。`fcitx5-sumi-source.tar.gz` 是固定提交 `b07f55ca2415c48190c84a4c6e17df41bec4f9fc` 的完整 addon 源码、真实拼音测试及 LGPL 许可证，独立于仓库在线状态。`source-manifest.json` 逐文件记录校验值，`PKGBUILD` 保持原包构建配方。

在全新的工作目录解压构建包，以普通用户运行 `./build.sh`。需要 Arch 的 `base-devel`、`fcitx5`（上述版本范围）、`pkgconf`；验证另需 `python`、`python-dbus`、`python-gobject`、`dbus`、`fcitx5-chinese-addons`、`fcitx5-gtk`，以及标准包检查工具 `bsdtar`、`readelf`、`ldd`、`pacman`。这些是构建/测试前置条件，不全部是 addon 的运行依赖。

构建不会自动安装软件或从 git 下载源码。脚本先验证固定源码，再调用 `makepkg`，最后验证实际解包的共享库。单独验证下载的包：

```sh
python3 verify.py --package /绝对路径/fcitx5-sumi-candidates-5.1.23.r4.gb07f55ca-1-x86_64.pkg.tar.zst
```

验证使用独立 XDG 目录和私有 D-Bus，确认测试进程实际加载解包的 `.so`，运行十项真实拼音回归并关闭自己的测试进程；不会安装包、重启全局 Fcitx 或修改正式配置。输出 `verification.json` 和 `audit-*` 日志。源码归档、配方和构建时间固定；编译器及构建环境仍应参照原包 `.BUILDINFO`。跨环境重建应核对实际载荷与测试结果，不把固定源码和时间等同于整个包逐字节可复现。
