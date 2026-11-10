# 未发布v6.1110.5正式包失败与诊断A/B

正式v5 b039352262fb86086434b6ab54de9584a8471085 / Deb631c6f02fb62c6b2afe166bc8572a513c111938af6e4b9b151c0e3d80e4b17e6不得发布。

正式包只读观测：240行长文中段固定布局稳定矩阵8项通过，1项最初全屏退出重排段失败；首次首见退出状态9869197045µs至最终layout9874349730µs共5.153秒。原F11调用时间和CPU负载未采集，不推定原因。后续定时三轮往返最终收敛0.434–0.720秒，固定布局中连续输入与静态/自然帧无持续1px跳动。首次慢过渡边界保留，不能声称所有模式切换瞬时或小于1秒。

发布阻断：真正body click/wheel只到GtkApplicationWindow，不到GtkTextView/ScrolledWindow；fixedscale3重启后也复现。新鲜重启先scroll0，之后真实按键滚入中段3487/upper8168/page628仍不能wheel，判定不依赖clamp0。事件工具实际发送Down和smooth delta1.5。

独立diagnostic-input-pass目录为运行时修改实验，绝不能作为正式包验收成功。对唯一可见全正文普通GtkDrawingArea自己的GdkWindow（非顶层、非caret/候选，owner匹配）从pass-through=false改true并空input region，click offset3493→3409，wheel4050→4600.006且事件进入TextView+ScrolledWindow。probe源码/修改地址/前后状态/事件全保留。

正式source/tag/包未改；三插件复用已签版本。全部私有host/fixture已停止，没有操作用户桌面。production最小修复与新正式v6包由root负责，必须重新实测click/drag/wheel/candidate与稳定性，不携带diagnostic mutation模块。

inventory.json列最小证据字节数/SHA。matrix.json中的raw路径指向原tasks文件，review/保留关键红绿片段，其余原始日志仍在tasks/sumi-focus-v5/evidence/frames。所有日志明确kind=after-paint或poll，后者不冒充绘制帧。
