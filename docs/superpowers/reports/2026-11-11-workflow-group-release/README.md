# 八组分类宿主、插件与网站正式发布

2026-11-11 用户授权后已公开 note.md 6.1111.2（Apple Silicon）及三个捕捉插件。

## 最终交付

- 宿主 [v6.1111.2](https://github.com/wizlijun/note.md/releases/tag/v6.1111.2)，远端冻结 tag 源 `c4d39ddff04296f66ec80ae72459bb9c8ce2d15f`，从已公开 `a56e861d` 精确移植分类。未带 main 上未发布 Smart Lookup 与两处既有工作区改动。
- 原生菜单与内置市场八组：AI / 捕捉 / 阅读 / 写作 / 推进 / 回顾 / 数据导入导出 / 其他。三同步归捕捉，Sumi与奇思妙想归写作；旧inspiration归写作，旧Other和未知分类归其他。
- Apple Notes 1.0.5、Roam Research 1.2.8、Health Sync 0.2.3，每款 arm64/x86_64 两包。冻结源 `93a8253490c7e649cceb4108c11c22d747192e32`、远端tag `plugins-capture-20261111`。仅manifest版本与分类重包，所有其他payload逐文件复用已验签公开包；不是重新编译或新公证。详细证据见相邻capture-plugin-packages报告。
- 网站 https://plugins.notemd.net/ 已是最终八组部署 `e4486a80`、Worker `1addd9b2-99f6-42a0-9dfd-93a29990c280`。本次更新在线索引并对实际网站复核，没有无意义重复部署。Sumi0.1.15/IdeaSpark1.3.9现有create清单已兼容写作，不重复发包。
- 同宿主发布附 Faitc5 for Sumi 0.5.0.13；包内App签名公证保持，pkg本身无Installer签名。批准大小/hash与正式下载匹配。

## 验收证据

- 全门禁：431文件5764前端测试；Svelte 0错误；protocol一致；production audit无high（既有4moderate/1low）；Rust canvas27/mobile3/分类32。初次symlink依赖导致Vite Denied ID，换本次worktree APFS本地依赖副本重跑全部原门禁，未过滤或改源码绕过。
- App公证Accepted `9564100a-cb21-4936-812d-bc079a03e6d3`，DMG公证Accepted `fa7a7444-350c-4b09-b64d-33b71ebb72a1`。签名/staple/Gatekeeper、DMG与updater完整App文件、真实MachO内嵌市场JS/原生标签及source inputs核对通过。
- 正式发布使用既有release-publish门禁；六附件从官方browser下载URL完整匿名读取，SHA/大小、完整updater签名及远端tag/资产前后身份检查通过，无REST备用。未替换用户本机App，未把单测当真实GUI点击验收。
- 插件既有Wrangler3.114.17+Account API Token，12个R2对象上传后normal/fresh完整匿名回读24次并验签；新宿主公开门禁通过后KV索引316→319，仅追加三个新版，所有旧条目保持。KV/普通/新参数公网索引一致。没有覆盖旧包。
- frozen-source、host-assets、artifact-verification、checks-summary、public审计、plugin-public-packages及index-verification均在本目录。

## 说明

冻结宿主CHANGELOG有一句“legacy and unknown groups remain in Other”表述过宽，实际代码与最终GitHub发布说明均正确区分旧inspiration等已知别名；main发布日志已准确修正，不因此重编或移动冻结tag。Health旧包日德说明保持，main后续文案不回退。宿主这次仅Apple Silicon；插件保留两种Mac架构，其他宿主平台历史包未替换。

最终公网独审提交 `532ec84b`：网站319条索引，HTML与冻结网站源逐字一致，中英八组、三同步新版本及双架构全部通过；见 PUBLIC-AUDIT.md、website-final-verification.json。
