# Omarchy 插件窗口、快捷键及全屏修复交付

宿主 **6.1110.4**、**Sumi 0.1.12**、**NEXT 1.13.3**、**Idea Spark 1.3.8** 已公开发布，并安装到本机。旧宿主经正常托盘退出/保存保护关闭；当前运行PID65707的程序SHA与正式包一致，Sumi已在真实Omarchy桌面居中打开。三个插件逐文件与已验签正式包相同。

- [正式宿主与Omarchy安装包](https://github.com/wizlijun/note.md/releases/tag/v6.1110.4)
- [市场索引](https://plugins.notemd.net/api/index.json)：312条，原309条逐字段保持，普通/新鲜公网及KV最终一致。

## 用户要求与修复

- Linux插件使用原生标题栏，可拖动/缩放。新建按目标工作区和实际GTK标题高度裁剪并请求居中；不恢复旧越界/全屏窗口状态。当前Omarchy浮动工作区的真实探针及实际Sumi都居中且标题可达；Wayland最终位置由合成器管理。
- 插件与主窗口分开拥有原生菜单。旧代码继承主窗GTK加速键组，CtrlN/S可能操作主文档；现在隐藏的独立Close菜单只处理自己的CtrlW，并防止全局菜单向主窗误发编辑命令。NEXT/Idea标准应用命令用Ctrl，Mac保留Command；IME、连发和已处理事件不重复执行。
- Sumi正文和面板以F11全屏；全屏无CSD，退出恢复。Linux全屏工具区与错误提示位于顶部，底部保留安全区。字号按逻辑视口单一比例调整（1–1.25，最大96），保留用户基础字号，退出恢复；没有x/y非等比拉伸。
- 用户最新候选要求已整合：非专注正文位置保持，候选独立在底部展开；专注模式候选仍在当前行下方。

## 冻结来源与正式字节

`v6.1110.4`固定为`25157f1db07b5be9fb2962346894ab316bb27f22`。核心提交：d915882f/754c4204（宿主Ctrl/IME）、ecfb6e09/89a1df81（原生F11/菜单）、5e188f74（插件UI）、bb5e7e2b（正文静止候选，patch等价5fd8c461）、57d08a90（全屏字号）、36e69fd2/b3a2f3ce（窗口/菜单作用域）。构建固定moraya-core f581448bce5e9cf557059f0700297a527069b5ae，Debian12 Linux x86_64；最高GLIBC2.35，依赖和CLI检查通过。

| 产物 | SHA256 |
| --- | --- |
| Debian amd64 | `40e4b86e7408fefe7e16072df875ae007973452be0f0201ed1704028f2ea8bca` |
| Omarchy x86_64 | `d8d179a8286043f8a560a98aec8e7a2b53a1f191da4e0ba2ce820f4555323575` |
| Sumi 0.1.12 | `64ebdd9ffdcab1a740b3d56a0cc59874484d8fd8fc62422955b64ac7b68799cb` |
| NEXT 1.13.3 | `e0221ef0621444fc0bb11b302ecdd15b986a9fb916bad5c1e7a38a62c227abf2` |
| Idea Spark 1.3.8 | `1a6817c6924dce05a643301af883452b9de69a223a3ac11ed3069ea8ac9dd9e5` |

Debian与Arch的程序SHA均为`8bb5f2c42e77ae64f46a3b40c22e8a82e1da387fb1710e2c702b69fe5c941357`，全部9个Debian载荷文件及权限保持。Sumi后端仍为已验证的d044c31ddac05f654cc5901dde98c0ed7c45bc5f21d579a3b361477db86afecb；此次修改宿主/插件UI，无新Fcitx addon。既有d2 addon继续使用。

## 实际验收

[正式GUI](formal-gui/verification.json)使用实际包内host与3个原身份签名包，真实GTK/WebKit/native HTTP。三窗标题实际拖动、真实边缘宽高调整；1920×600低高度与scale3标题均可达。NEXT经过菜单重建仍不修改主窗sentinel，Idea复制粘贴正确、CtrlS只写一次、CtrlW只关自身。Sumi正文及WebKit面板各两次F11往返，无标题→恢复标题；真实Pango字号22→27.5→22。私有Sway主显示3840×2400/scale2，另低高/scale3；实际Omarchy dock没有在私有会话启动，顶部工具区几何证明其避开底部区域。原始gtk_cursor测量与自绘caret分开陈述。测试键盘保活溢出导致的fixture退出已修复，未当作应用崩溃。

[旧正式6.1110.3发现新4](formal-gui/old-client/verification.json)：旧进程SHA194c15…、旧Sumi0.1.11、新鲜独立缓存，真实公网启动发现4，原生菜单强制刷新时间前进，native opener发出精确v6.1110.4下载页。没有模拟版本/HTTP，没有改用户缓存。

[本机实际F11](local-install/actual-f11-roundtrip.json)：Sumi正常(230,128,820,544)→全屏(0,0,1280,800)→原位置/尺寸；没有发送文字输入。程序与插件安装来源见local-install。

单项回归包括：主宿主相关64项最终整合通过（final-core-tests.log）、插件UI223项、原生27项与scale2固定字号六阶段、窗口策略/几何11项、菜单作用域2项；宿主cargo check及完整构建、前端类型检查0错误31既有警告均通过。早期SourceView合并运行受5秒冷编译时限影响失败，独立30秒时限保持原断言通过，原日志保留。

主窗欢迎页仍有旧Cmd提示文字；实际Ctrl功能与本轮插件Ctrl/F11提示已验证，未声称所有历史宿主文案均已统一。音频与字体下载不在本次窗口回归范围。

## 发布与清理

沿用原Wrangler3.114.17与Account Token，逐插件R2包/签名上传→普通/新鲜匿名回读验签→KV索引发布→公网复核；3个profile串行，原市场历史与Mac/ARM兼容包保留。全部6个GitHub资产匿名回读与已验收字节一致，Mac latest仍为6.1110.1。签名和索引证据见publication，宿主见host-public-verification.json。

所有私有GUI/旧客户端fixture及任务Docker已停止，实际安装的宿主/Sumi后端保持运行。任务token工作副本已删除，用户上传的原签名钥保留。未编辑用户Hyprland/Omarchy配置。官网快捷下载存在缓存，用户交付使用精确release链接。

## 用户后续反馈（4发布时尚未解决）

安装4后用户报告聚焦模式整屏抖动及滚动条边框破坏全黑。此项尚未修复，独立分支`fix/sumi-focus-stability`（base25157f1d，worktree note.md-sumi-focus-stability）正复现与验证，root未并行修改native布局。4的短文/固定字号及窗口测试不证明长文聚焦稳定性；下一版须补用户相近文档、持续帧几何与滚动条像素回归，不能把本报告误读为该新增问题已解决。

后续：该问题已在正式v6.1110.6修复并发布；长文稳定、真实鼠标/滚轮与边缘像素已在包内验收，见[6.1110.6交付报告](../2026-11-10-sumi-focus-and-pointer-release/README.md)。6.1110.5未通过鼠标命中门禁，保留为未公开验收构建，4的历史测试结论不变。
