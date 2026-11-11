# 捕捉插件发布器

只准备与离线测试；此工具文件的存在不代表已经上传或发布。

固定 Apple Notes 1.0.5、Roam Research 1.2.8、Health Sync 0.2.3，各 arm64/x86_64，共六个不可变包。冻结输入由构建代理写 frozen-plugin-packages.json，包含sourceCommit/sourceRepository及每包完整摘要、清单和签名摘要。由该源码dist-plugins/index.json读取三个候选，与六包和精确git manifest逐项比对；size取每插件两架构最大值。

check默认无网络/无外写，inspect只读；stage先全部对象占用检查再逐键重检/R2上传/完整匿名normal+fresh回读并验签；publish-index先检查公开正式6.1111.2宿主和更新清单，再重复包回读验签，KV乐观并发前置比对、幂等合并及完整公网复核。只追加三个新entry，所有旧entry完全保留，索引已经迁移好的record分类不再次重写。既有Wrangler3.114.17与Account API Token，不升级/OAuth。

命令：`python3 tasks/capture-plugin-release-20261111/publish-plugin.py check --source <冻结完整SHA>`。其他mode必须由发布协调者明确执行。HOST固定6.1111.2；若版本改动需同步源码与门禁后重新验。

18项离线回归通过，覆盖双架构聚合、缺架构/重复架构拒绝、minHost/源清单/全部候选字段精确校验、历史不变与幂等、冲突拒绝、R2超时落盘先回读、KV并发及超时回读、宿主/签名失败阻止写入。最初3项红验证发现合并列表别名导致原输入被改，已改复制list后全绿。
