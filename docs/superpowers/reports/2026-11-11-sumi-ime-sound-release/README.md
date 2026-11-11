# Linux Sumi 组字音效 6.1111.5 发布证据

已公开 [v6.1111.5](https://github.com/wizlijun/note.md/releases/tag/v6.1111.5)，五个附件均匿名完整回读并匹配本地验收字节。GitHub latest 仍为 v6.1111.3，macOS latest.json 未改变。

## 来源与范围

修复提交 `5c9337ae`；冻结标签 `v6.1111.5` → `fa5f701798e6df6b839164c2aa299879b1640e3d`，均已推送。core固定 `1722a6dedec8ee79e7a6ff046e7eeafb7187102e`，容器源码与实际安装dist一致。此次仅 Linux 原生编辑器组字反馈、测试和发布元数据；插件及输入法无需发布新包。所有worktree、旧分支补丁等价与stash审计见pre-release-audit.json，旧版本号提交和依赖链接排除。

## 实际包黑盒对照

两版均使用正式原签 Linux Sumi 0.1.12，后台SHA `d044c31ddac05f654cc5901dde98c0ed7c45bc5f21d579a3b361477db86afecb`，固定r3 Fcitx模块及真实 GTK im-wayland。分别运行在私有 Sway/D-Bus/PipeWire/Pulse/WirePlumber policy会话，无硬件音频设备，无用户音量修改。录制仅指定Sumi进程的音频流。

|验证|旧6.1111.4实包|新6.1111.5实包|
|---|---|---|
|静默基线峰值|0|0|
|n/i/h/a/o各键峰值|全部0|每键0.4894745|
|每键时正文|空，仍在组字|空，仍在组字|
|英文x正控峰值|0.4894745|0.4894745|
|空格提交|你好|你好|

实际新宿主SHA `b5d25ee759b442f6a52b69f83957377f59d8379c9a1e7d7104a0dc050e1d9cad`，Deb与Arch一致。对照、每键preedit日志、截图与原始PCM哈希见audio-comparison.json等文件；PCM与完整运行目录保留在本地tasks/sumi-ime-sound-release/gui，未提交大体积原始录音。所有测试自有宿主/插件/音频/桌面进程均已清理。

## 构建、回归与公网

- 冻结标签中两个原生文件哈希与已通过29单测、fcitx/wayland音效专项及候选综合回归的源码相同。同步本地compose不双响、关闭音效仍静默、重复/清空/隐藏/失败/投影不补声。
- 前端源码、锁文件、core与6.1111.4相同，沿用该基线5883测试/类型检查证据；本次容器重新完成前端正式构建与资源校验，不声称重新跑过全量前端测试。
- 原版release-linux.sh从tag构建Debian12 amd64，Deb结构/ELF/GLIBC2.35、干净Arch依赖与重定位、CLI6.1111.5均通过。Arch包9个载荷文件及目录模式与Deb一致。
- 原版release-publish.sh交互确认Linux amd64范围后公开；由公开Deb运行官方prepare.py生成的PKGBUILD与预验收配方逐字节相同，再追加Arch包和校验文件。
- 五个公网附件均匿名完整回读；精确SHA见public-verification.json。临时构建daemon已停止。

本报告记录发布时状态。随后用户另行授权本机安装，安装结果另记，不把发布成功等同于本机已运行新版。
