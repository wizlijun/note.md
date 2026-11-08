# 最终冻结需求审计

通过。冻结tag `v6.1108.5` 确实指向 `02099d206a583400a89ac360bf8f3c0e61acaf14`；98项frozen-inputs源码哈希全部匹配tag，签名后台的81项编译输入也与最终tag一致。Sumi0.1.4与Power Mode1.0.4的实际包逐文件清单、manifest、SHA及tag公钥Minisign均通过；两插件源码树从打包源提交至最终tag无漂移。

逐项核对8项要求均已进入源码和对应产物链：后台按需字体（不自动下载、可继续写、失败重试、缓存/系统回退、最后选择优先）；六组字体且CRT仅GNU Unifont；4秒竖线呼吸/常亮/IME细线屏蔽；设置composition提交与失败保留；字号留白；Markdown复制/文本化粘贴；Power13GIF随插件；Sumi持久化、同步与下载随签名后台。发布说明保持7条，剪贴板是保留的已公开能力，未虚构为本轮第8条。中英6.1108.2及更早历史原字节一致。

实际artifact-verification已完成并为ok：App原生桥存在、无Qt动态链接，实际Mach-O中宿主模块匹配，迁出素材检查通过，DMG与updater内App一致。Sumi包2,302,043B，Power包169,730B；两包没有Sumi大字体文件。宿主最终DMG14,175,207B、updater14,244,585B。

边界：六个AppKit探针是离屏验收；本轮padding为system/CRT共80例，非最终DMG完整物理输入矩阵。双副本Worker验收是loopback transport+core，不等价正式CF容量；签名后台实际启动/崩溃重放验证不等价最终安装后的全UI升级流程。部分早期host-quiesce/font-engine报告保留中间源码哈希，不能重标为最终tag执行。其他平台、定制输入法、VoiceOver与完整物理性能仍按spec列为后续。此审计不宣称Release或插件市场已经公开；需独立发布公网门禁完成。

精确源码行、哈希、证据链接和逐项限制见`final-tag-requirements-audit.json`；`audit-final-tag-requirements.py`可在最终产物证据更新后只读复跑。未修改源码、未构建、未联网或安装应用。
