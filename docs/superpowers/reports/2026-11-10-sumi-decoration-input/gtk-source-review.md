# 正文 pointer/wheel 只读诊断

结论：最优先验证 decoration GtkDrawingArea 的自有 GdkWindow 遮挡正文命中。尚未进行运行时 A/B，因此为有明确源码支撑的根因假设，不标为修复完成。

- 正式 v5 私有 fixture 的 input-events.jsonl 显示按下/释放/离散及 smooth wheel 仅到 GtkApplicationWindow，未到 GtkTextView 或 GtkScrolledWindow。
- linux.rs:882-886 创建全幅 GtkDrawingArea decoration，仅对 GtkOverlay child wrapper 设置 pass-through。observer 快照显示 decoration mapped 且覆盖正文 960×628；caret 与候选均隐藏。
- GTK 官方 gtkoverlay.c:780 明确指出该 API 只设置 overlay wrapper，后代自有 GdkWindow 需要单独设置 pass-through。gdk/gdkwindow.c:7279 同样明确 pass-through 父窗口可以具有接收事件的非 pass-through 子窗口。
- linux_caret.rs:66-67 已对 caret 自有窗口设置 pass-through 和空 input region；decoration 未做此处理。
- linux.rs:1199 的 scroll handler 返回 Proceed，reading() 将 focused 清零并移除空间动画；不是显式吞事件路径。
- GtkScrolledWindow External 的 may_vscroll 为真；不可通过改成 Automatic 来解释根因。
- linux_candidates.rs 的候选滚轮 handler 确实 Stop，但候选当前隐藏且没有候选 DrawingArea 的事件，暂不符合此次证据。

最小下一步：在隔离 fixture 对唯一全幅 decoration 自有 GdkWindow 设置 pass-through（并可用空 input region 加固），A/B 记录事件进入 TextView/ScrolledWindow、真实轮滚后 adjustment 变化、退出 focus、pointer 光标定位和拖选。若通过，生产实现应在 decoration 每次 realize 设置其自己的窗口，而不是移除装饰或转发合成滚轮。不得修改候选可交互区域。

只读诊断未修改 production，未操作 UI 代理 fixture，未启动 Docker。

上游源码来自 GNOME 官方 gtk-3-24 分支：
- https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gtk/gtkoverlay.c
- https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gdk/gdkwindow.c
- https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gtk/gtktextview.c
副本保存在同目录。

## realize 回调可靠性

- gtkoverlay.c:143-172 仅设置 wrapper 的 pass_through，再把 wrapper 设为 child 的 parent_window，不会重设 DrawingArea 自有窗口的 pass_through。
- gtkoverlay.c:420-431 仅在 wrapper 为空时重建；map/unmap 仅负责显示状态。
- gtkwidget.c:1753-1760 注册 realize 为 G_SIGNAL_RUN_FIRST，普通 Rust connect_realize 回调执行时类 realize 已创建自有窗口。
- 因此应在 add_overlay/show 前连接 decoration.connect_realize；每次重新 realize 都对新的 area.window() 设置 pass-through，保留现有 wrapper 配置。无需依赖固定 GDK 指针或定时重设。

建议代码（未应用）：

```rust
decoration.connect_realize(|area| {
    if let Some(window) = area.window() {
        window.set_pass_through(true);
        window.input_shape_combine_region(&gtk::cairo::Region::create(), 0, 0);
    }
});
```
