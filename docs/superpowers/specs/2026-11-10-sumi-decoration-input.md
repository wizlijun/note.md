# Sumi Linux 装饰层鼠标穿透

## 问题与证据

正式v6.1110.5（b0393522）包长文稳定性测试通过，但正文click/wheel只到GtkApplicationWindow，无法定位光标或滚动；因此该draft不公开。GtkOverlay的pass-through只设置overlay wrapper，自有GdkWindow的GtkDrawingArea仍默认接收输入。诊断probe仅对唯一全正文装饰窗口设pass-through及空input region后，同一真实点击使selection从line120/offset3493变line119/offset3409，5步wheel使adjustment4050→4600.006，事件到TextView和ScrolledWindow。诊断修改不作为正式包通过证据。

## 最小实现

创建decoration时注册普通realize回调；GtkDrawingArea默认realize先创建自有window，再设置该window的pass-through=true及空input region。保留原GtkOverlay wrapper的pass-through。每次realize均重新应用，禁止只修改首次窗口指针。输入区域不影响绘制；不改变正文、caret、候选层、菜单或其他应用窗口的输入区域。

## 验收与交付

- 原生27项测试、GTK长文稳定/绘制回归和host编译通过。
- 新冻结源码和正式包，不修改旧tag。v5保留为未发布失败构建，新版本覆盖稳定性与鼠标命中修复。
- 正式包不加载任何诊断mutation模块；只读observer确认decoration自有window默认穿透，TextView/candidate仍接收自己的输入。
- 真click改变正文插入点、drag产生预期selection，非0scroll的真实wheel改变offset并保留阅读/恢复输入的焦点行为；实际候选鼠标提交只保存目标中文。
- 长文中段scale2/3、半像素target、全屏F11往返、IME与隐藏滚动条均重验。首次较慢模式过渡保留为边界，不能把静态稳定结论扩大为无过渡。

官方依据：[GtkOverlay](https://github.com/GNOME/gtk/blob/gtk-3-24/gtk/gtkoverlay.c#L775-L784)明确要求自有后代window另设穿透；[GdkWindow](https://github.com/GNOME/gtk/blob/gtk-3-24/gdk/gdkwindow.c#L7261-L7284)规定不接收mask事件会传父级、不会穿过到兄弟；[GtkWidget realize](https://github.com/GNOME/gtk/blob/gtk-3-24/gtk/gtkwidget.c#L1753-L1760)为RUN_FIRST。
