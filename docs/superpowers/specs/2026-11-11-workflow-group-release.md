# 八组分类正式发布

用户授权：发布宿主、变更过的插件和网站。承接已批准八组方案及最终“其他 / Other”文案。

## 冻结范围
宿主从已公开 v6.1111.1 源开始，只合分类及必要版本/发布日志，不携带 main 的未发布 Smart Lookup。发布 Apple Silicon，与本轮已验收平台范围一致；保留其他平台历史下载。附已批准 Faitc50.5.0.13，输入法 App 公证而 pkg 无 Installer 签名的边界保持明确。

三个实际改过清单的插件：Apple Notes Sync、Roam Research Sync、Health Sync。以线上最高版本递增patch，submenu=record；保持既有支持架构、最低宿主及业务功能不变。Sumi0.1.15与IdeaSpark1.3.9现有包create键已兼容Write，无需无意义重发。网站最终八组已部署，复核公开HTML及实时索引。

## 验收与发布
发布前枚举worktrees、分支未合入提交及stash并核补丁等价。冻结源、构建输入、签名包hash、tag与公开资产相互绑定。宿主正式门禁不跳过；插件通过现有Wrangler3 Account API Token上传R2，完整匿名回读验签，再KV索引及公网回读。禁止覆盖旧包或改变无关历史。按实际二进制与包验收，源码/单测不替代正式资产证据。
