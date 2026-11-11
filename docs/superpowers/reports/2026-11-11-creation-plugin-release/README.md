# 创作分组插件与网站发布

2026-11-11 已公开 Sumi Write／玄霜写作0.1.15（Apple Silicon）和 Idea Spark／奇思妙想1.3.9（universal），网站 https://plugins.notemd.net/ 已更新。插件源冻结 `b88edb93c5c09611ad9d888177b3814ce2ab3d64`，标签 `plugins-create-20261111`。网站冻结源 `e786cf0b67f2d05fa7af4116e1866c07ff59451b`，Worker版本 `0f70cf9a-f27f-4a55-b04c-94fa8e0d10a5`。

## 范围

将灵感合并为唯一创作组，位置在阅读之后；两款插件新manifest及旧索引category均为create。网站兼容旧inspiration和旧Sumi experience分类。插件业务代码与共享依赖对已公开版本无变化，仅manifest分类与版本、package版本更新。未构建或发布宿主；旧host6.1111.1的原生菜单和内置插件市场仍有IdeaSpark=>inspiration硬编码；该代码修复已提交，但客户端分组显示需后续宿主发布生效。

## 发布与验证

- 既有Wrangler3.114.17与Account API Token；Worker部署、R2四对象上传、匿名normal/fresh包与签名回读验签，再更新KV并核对KV/公网normal/fresh一致。
- 索引314→316，追加两款新版。28条两款插件的历史category迁移，所有其他历史字段及其他插件完全保留；未覆盖已发布包。
- Sumi新原生后台公证Accepted，精确签名binary的stdio两项（含kill/reopen/private boundary）通过；两包manifest、ZIP清单、大小、签名与源码绑定通过。
- 分类源回归43+31项；网站23项；publisher16项，含冲突拒绝、幂等/并发与回读门禁。
- 主工作区两处既有EOF改动未动，未构建未发布Smart Lookup宿主。三个构建缓存symlink已移除，发布工作区clean，实际缓存保留。

见同目录包清单、build-verification、signed-native-process-probe、plugins-public-packages与plugins-index-verification，以及网站最终验收报告。
