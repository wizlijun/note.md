# Sumi上下导航与空白首行居中：宿主6.1109.4与插件0.1.9发布

状态：**macOS Apple Silicon宿主和插件均已公开，实际签名产物、更新入口与插件市场核验通过。** 宿主冻结tag `v6.1109.4`=`b55a6d0f42b4e948db3d22810be632249668d573`；功能提交`3ac51d342ad8d879549abf8d36f62d2c49234449`。Sumi0.1.9最低宿主`>=6.1109.4`。本记录不声称本机已自动安装0.1.9；Omarchy x86_64/Linux仍为独立未发布范围。

已聚焦时普通Up/Down沿AppKit真实视觉行移动，保留同一聚焦视图，全页按原行距反向滚动，当前行中点保持编辑区50%。上下键不算打字，不刷新10秒idle及alpha计时。Shift选择、带修饰键跳转、左右移动、滚轮和IME交接保留原安全路径。新建或打开就绪空白页时第一行即居中，首1至3字与Return不跳顶部；缺少显式正文的加载占位不激活，不抢firstResponder、不伪造输入或写正文/行时间/撤销。关闭偏好、只读、隐藏、投影中和草稿错误保护保持。

字体、原字号、行距、横向排版与上下渐隐算法不变；10秒停顿后1.2秒慢显、首键0.2秒快淡继续保留。最终实现通过**3654项原生断言与10组旧AppKit回归**，覆盖56步真实上下键、软折行/跨段/空行/首尾、全页位移与中线、正文/revision/undo不变、idle及入场动画和六类空白生命周期。6字体×6主题×3字号矩阵、UI101项与check/build通过。正式release完整前端重跑427套、5551项全部通过，检查为0 errors／31 warnings；Rust定向结果见`host-release-tests.json`，不把filtered-out条目计为通过。

真实CUA在最终合成probe `cead3106712606797b044578706ee6b7b7b8c374fb5c90dda207c12043702b0a` 验证Up/Down保持中线与三段原文，显式New Blank Page菜单使空行/caret立即居中，首字、换行及上下导航均保持，最终正文精确为`abc\ndx`。probe Cmd+N未清空夹具，使用实际菜单动作验证；不把此项冒称生产快捷键通过或失败。仅使用合成内存文本及隔离Vault，未编辑正式写作正文。

DMG为14,296,231字节，SHA256 `4ada0afafe8390bcde19f62e5efa76e760e1f202120c6295f25668d9bdaac437`；更新tar为14,370,144字节，SHA256 `c8d4afb17aa0ee919aa3f749ae14f492ea89149f6b4898a450234364d0fdf869`。插件包为2,465,880字节，SHA256 `db732283cb0e51994e9f03b5b38892a751f464e8929dc86df3e67484167950af`，通过真实签名stdio2项、宿主日志崩溃/重放13项和真实宿主代理1项。大字体继续按需下载，未加入发布payload。

App公证`857cf225-cab3-41c0-a617-2712e776667a`、DMG公证`4bbdb1c6-ec3a-48fb-b046-91c3f5589e3f`均Accepted。实际App arm64 CDHash与两份Apple票据匹配；App临时ZIP已清理，不声称独立重算其归档SHA。未staple的提交DMG与Apple归档SHA匹配，staple后增加1690字节而CDHash保持，stapler validate与codesign strict通过。插件公证`9a8e3eb0-022a-4e55-ab9c-353a28dd76ee`为Accepted，冻结签名包与本次实际进程验收绑定，未复用旧receipt。

原release流程完成tag和draft，本地完整源码/模块嵌入/原生receipt/资源门禁、draft四资产全量回读及完整tar Minisign验签通过后，沿原release-publish公开。公开REST四资产匿名全量下载、完整SHA与更新包签名通过；实际冻结updater端点返回一致manifest，结合完整tar验签通过，未用REST替代真实updater入口，也未额外声称browser整包重复下载。

插件沿既有Wrangler3.114.17与Account API Token通道执行R2包/签名上传、normal/fresh四对象完整回读验签、KV索引发布及独立复核。市场306→307，仅新增`notemd.sumi@0.1.9`，历史条目保持，KV/normal/fresh与冻结candidate一致。独立审计重验发布器保留的完整对象、签名与ZIP清单，不冒称再次联网下载全部插件包。

发布前枚举14个repo/worktree、分支与stash，原root19个dirty文件逐字节保留，stash全空，65个本机日志/CRDT/后台相关文件相对基线未改。物理中文候选窗、完整生产宿主交互、其他平台与Omarchy桌面、生产容量未由本轮证明。原始小型报告、最终源码哈希和验收边界见同名JSON及证据目录。本报告与spec收口为发布后的证据记录，对应文档提交可由本文件Git历史核对；不改变已冻结tag所指功能源码。
