# 覆盖安装后语言栏保留旧显示名

2026-11-12用户安装Fcitx5 for Sumi 0.5.0.15后，反馈macOS语言栏仍显示旧误拼名。已通过一次菜单进程刷新并由用户真实菜单复核解决。

## 因果证据

- 实际安装receipt为.15；/Library/Input Methods/Fcitx5.app的Info.plist及6份实际InfoPlist.strings均为Fcitx5 for Sumi，源提交2f561d8/build2026111201，正在运行新版App PID55013。
- fresh TIS四个源名称正确，父源和简体模式已启用；CUA实际“系统设置→键盘→文本输入”列表也显示Fcitx5 for Sumi。menu-status仅为候选源诊断，不当作真实菜单画面。
- TextInputMenuAgent旧PID28276已连续运行一天多，早于改名；安装流程只重启输入法App，未刷新这类长驻系统UI进程。HIToolbox偏好保存稳定ID，没有错名文本。
- 保存当前选择及完整启用集合后，仅对已核路径/UID的旧菜单agent发送SIGTERM，launchd自动启动新PID64114。未结束输入法engine、未删除缓存/偏好、未重新添加输入源。
- 前后当前输入源及完整启用集合逐项一致。用户重新展开语言栏，明确确认“Fcitx5 for Sumi（已正确）”。这确认了旧菜单驻留进程的名称缓存，而非新包或注册名称错误。

## 处理边界

本次是系统UI缓存刷新，不改代码、不发新安装包、不改词库或配置。CUA可读Settings列表但当前连接器无法读取无常规窗口的菜单栏代理，因此最终渲染结果由用户直接确认，未用API候选快照替代视觉验收。

以后改名的覆盖安装验收必须区分包内资源、实际已装/运行版本、fresh TIS、Settings列表和长驻菜单画面。若前四层正确但语言栏仍旧，优先保存选择/启用集合后只刷新相应用户菜单进程，再验证真实菜单；不盲目重装、清IntlDataCache或改HIToolbox。
