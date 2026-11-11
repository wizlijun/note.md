# 创作分类双插件发布器

本工具只发布 Sumi 0.1.15 arm64 和 IdeaSpark 1.3.9 universal，默认 check 离线；inspect 只读；stage 与 publish-index 由主代理明确执行。复用仓库 Wrangler 3.114.17 和 Account API Token，禁止新CLI/浏览器通道。

冻结 sourceCommit/sourceRepository 与源manifest、全部包内文件摘要、包签名、公钥、生成索引必须一致。Sumi保持>=6.1111.1且公开host门禁；IdeaSpark严格保持>=6.1110.4。

唯一允许的历史元数据变化是全部旧notemd.sumi/notemd.idea-spark条目的category变为create。其他所有字段（包括历史名称、翻译、版本、arch、hash、下载URL、引擎范围）以及其他插件/顶层元数据保持原值。新版本已存在时须整条精确相等，禁止同版本修补。两包合并原子成一次KV索引写入。

R2先全对象检查再逐对象重查；超时和失败先匿名回读再同键重试。正常及cache-busted匿名包/签名均验签后才能写KV；KV写前并发检查，写后回读和双公网索引一致；HTTP不确定、占用不同bytes、索引冲突一律停止。

验收：离线单元测试覆盖保留历史、冲突、幂等、并发写阻断、网络未知不写、失败先回读；实际包到位后check只读验签通过。外部发布结果由执行者另记，不以脚本测试代替。
