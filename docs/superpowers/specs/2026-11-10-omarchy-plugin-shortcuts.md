# Omarchy 插件快捷键统一

用户报告插件快捷键混乱。先以本机已安装Omarchy默认/用户绑定与hyprctl实际绑定为准，审计后实施；不能通过覆盖桌面Super绑定修复应用快捷键。

## 已发现

- Omarchy Super+Return启动终端，Super+F全屏，Super+W/Q关闭窗口，Super+I切输入法，Super+Space开菜单。
- Sumi Linux与WebView全屏仍声明Super+Return，主宿主keydown仅检查metaKey，插件清单保留Cmd字面量，存在Linux映射与桌面争抢。

## 目标

1. Linux应用内命令以Ctrl为主修饰键；系统Super由桌面管理。显式修饰键精确匹配，不让Ctrl+Alt/Shift额外组合误触其他动作，IME组合不执行应用命令。
2. Linux Sumi全屏统一F11，WebView和GTK处理/文案一致；Mac保持既有Command行为。
3. 菜单实际注册、前端提示与键盘处理使用一致的平台映射；应用内组合与全局快捷键分开处理，Wayland不虚报全局注册成功。
4. 逐项审计插件命令冲突，复用已有平台探测，优先中央修复，避免无关任务/提醒逻辑改动。
5. 测试Linux Ctrl、Super不劫持、额外修饰键、IME、native/WebView、Mac回归；隔离按键验证实际动作且无双触发。源码精确提交，正式产物按冻结tag验证后才声称交付。

具体冲突和映射表在审计完成后补入。

## 用户补充窗口和全屏需求

- Linux插件普通窗口启用原生标题/窗口边框和可缩放；初次创建按目标显示器工作区裁剪内容/min尺寸，按实际GTK CSD标题高度校正并请求居中。标题区必须实际可点击，不能只证明center API被调用。
- 全屏不显示标题边框；退出恢复。F11在native正文和WebView面板焦点都有效，按住不重复切换。
- 全屏Linux工具菜单移到顶部避开Omarchy dock，并在窄屏换行；正文bounds经现有ResizeObserver同步，不使用x/y非等比transform。
- 按逻辑屏幕大小对全屏有效字号做有界等比调整，保留用户存储字号，退出恢复；候选、正文、光标、行距应共享有效字号。字体拉伸须以实际几何/像素验收，不能用CSS未发现transform冒称修复。
- 增加scale2的4K显示器、低高度/窄窗口、连续全屏进出、标题可达、原生/面板菜单点击与存储回归。

并行候选位置任务依照用户最新指示调整非专注行为：正文位置保持，仅候选固定底部，多行不推正文。该任务独立worktree完成后按精确提交整合，当前旧“正文固定底部”要求已被替代。
