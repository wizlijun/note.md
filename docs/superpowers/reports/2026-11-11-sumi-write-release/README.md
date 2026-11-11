# Sumi Write／玄霜写作正式发布

2026-11-11 已公开 [note.md 6.1111.1](https://github.com/wizlijun/note.md/releases/tag/v6.1111.1)，tag `a56e861dd71708feb98a623a50dc45bd73b8300d`。Apple 芯片 DMG、更新 tar/signature/latest、Faitc5 for Sumi 0.5.0.13 pkg 和 companion JSON 共六个附件。Sumi Write 插件 0.1.14 已上架，要求宿主 >=6.1111.1；历史313条市场记录原样保留，索引增加至314条。

## 本次交付
- 写作产品英文 Sumi Write、中文玄霜写作，日语使用英文品牌。note.md 与 Faitc5 名称保持，稳定插件/正文/字体身份不改。
- macOS 新窗口按当前显示器可用区域协调尺寸；绿色按钮进入原生全屏；启动全屏默认开，显式关闭持久保存，仅影响下次新建独立窗口。
- macOS/Linux聚焦触发、全屏字号与底部留白对齐；修复保存冻结及快捷键误打字音、Linux Shift+Return，以及同步echo阻塞保存/外观设置。
- 输入法0.5.0.13默认开启中文与英文间空格。包内App已Developer ID签名、公证并staple；pkg本身未签名。
- CD对macOS发行自动附带仓库批准的改造pkg与元数据，缺包/错版本/错hash拒绝发布；下载附件回读验证，pkg不混入宿主updater。

## 验证与来源

实际App/plugin构建源 `23e4ad11a66461b96f75568130d66c9def8020fe`；最终tag随后只加入发布脚本、批准附件元数据与文档。157项宿主源码摘要、102项native输入摘要及四件host资产字节均相同，见 `host-source-equivalence.json`。未重复签名或将最终tag说成实际编译时的commit。完整三容器/签名/公证/更新包核验通过，见 `host-artifact-verification.json`。

三语言插件110测试、相关宿主177测试、CD193测试通过；原生菜单/辅助功能probe保持组字与正文。精确签名插件真实stdio、journal/crash/echo与完整宿主transport共21项通过，见 `plugin-process-probe.json`。窗口功能已在隔离真实App验证默认全屏、false持久、绿色按钮全屏与正文保存；后续品牌仅改变显示字符串。

GitHub发行经新版publisher回读全部所需附件并核对批准pkg，已公开；另对Faitc5进行匿名完整下载核hash。插件使用既有Wrangler 3.114.17与Account API Token，R2包/签名匿名normal+fresh回读验签后发布KV；KV/公网normal/fresh一致，见 `plugins-index-verification.json`。

## 边界

用户曾报告回车后上方所有行消失，后反馈暂未再现；未确证根因，本次不声明已找到其根因。Linux只有源码/单元验证，本次不分发新的Linux二进制。Faitc5 .13未在正式用户环境重装或完成物理键盘混输验收，不能把此前.12实机结果套用为.13验收。主工作区原有Smart Lookup未发布改动与两处EOF修改原样保留，未纳入安装包。
