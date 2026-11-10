# 最终正式App隔离验收计划

约束：不再编译宿主；仅最终正式App、0.1.13签名包，不能更改HOME/CFFIXED_USER_HOME或用debug acceptanceApp代替正式binary。

只读准备结论：正式版本没有AppSupport/portable覆盖开关。Rust dirs的macOS配置数据路径来自HOME，Foundation的CFFIXED_USER_HOME无法单独隔离Rust。sumi-acceptance独立identifier仅debug可编译，release编译明确拒绝。single-instance socket固定/tmp/net_notemd_app_si.sock。不得同时启动以为是隔离副本。

可行最小路径：先由主agent正常退出旧debug，安装正式App并通过官方市场运行中保护入口更新Sumi。之后备份实际settings.json/shared.json及其hash，记录当时输入源、窗口和原Vault。原生托盘菜单tray-sync-repo打开标题Select Vault Git Repository的系统目录选择器；选task下新建、git init且没有remote的gui-vault。只通过正式UI切换，不直接覆盖原配置。通过shared.json回读与lsof证明当前写入仅临时Vault的Sumi数据。

在临时Vault通过实际Sumi插件创建空白纸页，正文先明确获得焦点。选择正式Faitc5.zhHans，使用CUA pressKey('n')、pressKey('i')逐键，不能用typeText/paste把字面ni当IME证据。检查预编辑、候选区位置与系统默认窗隐藏；Escape取消不改已提交正文。再一次ni+数字1确认一次提交，并核临时CRDT与投影，不碰正式正文。仅在此合成页测试普通/聚焦、搜索失焦回退。

结束通过保存保护关闭测试Sumi，再用原生选择器选回原Vault，恢复此前输入源和视图。读取shared.sotvault确认恢复，审计备份/当前配置只含预期UI变动，绝不把备份整文件覆盖并发用户设置。记录实际App/host/backend/plugin hash、进程路径、marker与候选行为证据，失败边界如实保留。

工具可达性：本机CUA仅绑定App/window，无全局桌面截屏API。托盘menu extra是否在AX树内需实际观察；若不可达，不能用osascript/JXA/CGEvent或私有AX脚本替代，须请主agent/用户点击托盘“选择Vault”这一普通UI入口，再继续系统选择器操作。
