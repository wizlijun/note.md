# Ebook Import 1.5.6：Unlimited-OCR 2 上传限制

背景：百度 2026-10-27 官方文档 https://cloud.baidu.com/doc/OCR/s/fmr1p39gb 已说明现有 unlimited-ocr-parser API 基于 Unlimited OCR 2，且 file_data 大于50M须用file_url，PDF最大500页。插件1.5.5同一接口未锁定旧模型，但仅支持本地Base64上传，错误地放行100MiB且不检查页数。

实施：将本地上传上限保守设为50,000,000字节（官方M未精确到字节），先检查文件大小，再通过现有Quartz只读取得PDF页数，接受1..=500页。超过上限或文档不可读时在OAuth/提交/轮询前失败，提示压缩或拆分。复用系统框架，不渲染页面、不引入解析器依赖。UI与CLI共享BaiduOcr流程。

范围：不增加云端托管/URL上传、不自动拆书、不改变默认OCR选择、不改变现有异步任务协议。README明确云端模型升级与API服务限制；不宣称调用过真实百度账号。

验证：字节上限及上限+1、500/501页、无效PDF、被拒绝输入零网络请求；现有合法PDF mock提交/轮询/结果下载和Quartz渲染回归。冻结tag后用实际签名包验证CLI门禁及既有导入，双架构构建与验签；Intel运行限于本机无Rosetta而未验。

发布：仅提交本功能文件，保留其他worktree在途变更；记录全worktree/分支/stash审计，沿用仓库Wrangler3/Account Token：R2上传→匿名回读验签→KV索引→公网复核→本机安装与包字节核对。
