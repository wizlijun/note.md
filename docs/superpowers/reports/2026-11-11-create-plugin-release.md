# 创作分类插件重新发布准备

基于 main `3f83f01396d2a2218df8f3c48f3f75de940a4de7` 创建独立 worktree `/Users/bruce/git/mdeditor-plugin-release-20261111`，分支 `release/plugins-20261111-create`。主工作区两处既有未提交修改不包含。

匿名公网索引准备时最新版本为 Sumi `0.1.14`（Apple silicon，minimum host `>=6.1111.1`）及 Idea Spark `1.3.8`（universal，minimum host `>=6.1110.4`）。本次分别升级到 `0.1.15` / `1.3.9`，保留最低宿主。Idea Spark 的 package.json 旧值 `1.1.1` 仅为滞后的开发元数据，已与新manifest版本同步，不据此判断公开最新版本。

Idea Spark 相对已发布 `v6.1110.4` / 发布记录源 `25157f1db07b5be9fb2962346894ab316bb27f22` 的产品目录只变更 submenu `inspiration`→`create`（加本次版本）；没有夹带未发布产品代码。Sumi backend、协议和存储相对已发布改名源 `23e4ad11a66461b96f75568130d66c9def8020fe` 保持相同。

两包的manifest菜单均为 `create`。但已发旧宿主中的官方插件分类覆盖和“灵感”标签不会被插件包替换，完整原生分类合并仍需宿主更新；本次不发布宿主，不把源码中的宿主修改说成已安装。Smart Lookup 等宿主未发布功能不在这两个插件包内。

构建使用仓库现有 `scripts/release-plugins.sh --release sumi idea-spark`；复用已有Node依赖和独立于host的backend编译缓存。Sumi必须正式签名、公证并记录Accepted receipt，两个包均以既有minisign密钥签名。产物核验和外部市场发布记录由后续独立证据补充；此准备记录不表示已经发布，不改Linux旧包或历史条目。
