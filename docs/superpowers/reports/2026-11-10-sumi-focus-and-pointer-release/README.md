# Sumi 聚焦与鼠标修复：正式 6.1110.6

已公开 [v6.1110.6](https://github.com/wizlijun/note.md/releases/tag/v6.1110.6)，仅Linux x86_64。冻结源码024d81814b4076def2456428150a4a2cd84095de；现有Sumi0.1.12、NEXT1.13.3、Idea1.3.8及d2 Fcitx addon保持原版本/签名/字节。无需重装插件。此轮仅发布，未安装或重启用户本机程序。

## 改动与来源

- e8e8e26a（690154c8补丁等价）：以GTK同样的整数滚动offset抵消viewport坐标，消除固定插入点的半像素回授；局部External+NoneShadow隐藏正文滚动条和边框，保留滚动。
- 693e5feb：GtkOverlay wrapper的穿透不自动覆盖DrawingArea自有GdkWindow。在decoration每次realize后设置自有窗口穿透及空input region，让真实点击、拖选和滚轮到达正文。只改装饰窗口，不改caret/候选的输入语义。

正式5构建曾通过固定布局稳定性但失败于真实正文鼠标命中，因此未公开，tag/b0393522及原包保留为blocked draft；原生回归与诊断A/B见[输入修复证据](../2026-11-10-sumi-decoration-input/README.md)。最终6包独立验收不加载该诊断修改模块。

并发Smart Lookup远程变更已正常整合到main cd87f8ec，129项相关测试与host check通过，保留其Unreleased日志；它们不在冻结024 tag、不在此安装包。所有构建、包、GUI和公开回读均按实际tag核对，未用后续main代替。

## 正式产物

| 资产 | SHA256 |
| --- | --- |
| note.md_6.1110.6_amd64.deb | 8f11cc89f73832b3ab2106552408c8289ac0fe87aaff47a02d81a9d8f48927d8 |
| notemd-6.1110.6-1-x86_64.pkg.tar.zst | 97e454f388cbcc523e9425d22f1f8b7cee80046afc5ea35f9e0828c142c113e2 |

两包内/usr/bin/notemd相同：efd58b8a0b3e523b3499a2eba8ead39ba018b0ae69695a21456ae180758504bb。官方校验、Arch recipe/verification及全部6公开资产均匿名下载逐字节比对通过，公开tag commit准确，Mac latest保持v6.1110.1。见[公开回读](host-public-verification.json)、[Arch验证](omarchy-6.1110.6-verification.json)。

原正式release构建已成功产包，但Arch镜像下载超时使首次runtime步骤失败。保留原release-build.log；对同一8f11包执行原release-linux-verify.sh完整重试一次通过，Debian12/Arch ELF、依赖、符号、CLI和GLIBC2.35检查齐全，见runtime-retry-result.json。此后复核tag/draft、按原格式生成SHA文件并上传，沿用原release-publish.sh公开Linux amd64-only且不改Mac latest。

## 验收与边界

[正式GUI报告](formal-gui/README.md)及其[验收结果](formal-gui/verification.json)：正式包在独立Sway/DBus/Fcitx/Vault中运行，/proc binary与包内hash一致，只允许只读观测模块，无diagnostic/probe。

- 240行长文中段、非0scroll并远离上下clamp：scale2/3、奇偶viewport/caret、实际Pango22/27.5/约23.19px等6场景，持续输入与稳定段严格通过；after-paint真实绘制帧和定时静态样本分开统计。
- 真正文click改变插入点，拖选形成范围；5步真实wheel推动中段Adjustment；聚焦/非聚焦各一次真实候选鼠标提交只新增你好、无raw拼音。非聚焦候选出现与清空不改变scroll、viewport或行Y。
- F11进入/退出恢复布局和字号。两scale正文边缘2000行与内侧RGB相同，scrollbar unmapped、shadow=0。
- 旧正式4（原binary8bb5…）以真实native HTTP、新鲜私有缓存启动发现6；菜单强制刷新时间更新仍发现6，真实下载操作交给native opener精确版本页。仅外部浏览器用私有sink，未mock检测HTTP或版本。

有限过渡不等于固定布局抖动：本轮长文模式切换观察约4.06s退出、4.15s进入，旧5首次约5.153s重排证据保留；稳定后无持续1px往返，未承诺全屏切换瞬时。本轮不扩大为所有剪贴板编码/音频/字体下载测试；拖选的Unicode剪贴板取值另有未确认观察，不据此声称Unicode复制全覆盖。

所有私有fixture和任务Docker已停止，未编辑用户Hyprland/Omarchy/Fcitx配置或用户文档。发布审计含全部worktree、branch、stash及补丁等价，不将其他任务未发布功能装入冻结包。
