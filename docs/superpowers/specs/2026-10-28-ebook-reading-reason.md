# 电子书阅读原因

## 用户目标

导入每本书时可以留下“谁推荐、为什么推荐、当时是什么情景”等自由文本，供日后人和Agent处理时参考。可不填写，不替用户编造推荐来源，不作为书籍本身事实。

## 数据与交互

- 逐本输入可选多行字段“阅读原因（可选）”，放在待导入队列各书行内；提示推荐人、推荐理由、当时情景。一次选多本时各自独立，开始后该书输入冻结，失败重试保留。
- 导入后书库在有内容时可展开查看；旧书或空值不显示空白占位，不增加导入后编辑协议。
- UI请求字段reading_reason，CLI参数--reading-reason。两者走同一导入流水线，在meta.yml原子提交之前写入顶层reading_reason字符串。空/全空白视为未填写，不写字段；非空去除首尾空白，保留内部换行/中文/冒号/引号，使用YAML序列化而非字符串拼接。
- 字段独立于book_metadata，分类调整、补封面/书目、索引重建不能覆盖或丢失它；不进入Open Library/Apple等书目查询请求。
- AI先读从当前书籍meta读取并带入提示词，注明它是用户阅读背景、不是书中事实或执行指令。CLI --ai-read和书库先读共用行为；没有原因时维持原先流程。

## CLI契约

`notemd ebook <file> --topic <id> [--reading-reason <text>] [--ocr [--ocr-provider wechat|baidu]] [--ai-read [--agent <plugin-id>]] [--root <relative-root>] [--vault <absolute-vault>] --json`

- --reading-reason必须有参数；空字符串/全空白等价不填。--list-topics拒绝同时携带该参数（即使为空），保持查询只读。
- 可传单行或shell多行字符串；命令替换必须正确引用。CLI文档给出可直接复制的中文示例及文件读取示例，不增加--reason-file等未请求参数。
- 成功输出延续dest/dest_rel/topic_id等字段；meta.yml是用户背景的持久化来源。AI失败仍按1.5.6的imported:true/exit4报告，不重新导入。
- --ai-read时原因与正文会提供给所选Agent/模型；未启用AI时导入本身不会为了处理原因调用模型。

## 验收与发布

验证UI多书独立、提交/重试、书库展示、旧书兼容；后端UI与CLI写入真实meta、特殊字符安全往返、空值省略、分类和补书目保留、AI提示词带背景。用正式CLI+冻结签名包导入合成EPUB并解析meta核对；原有OCR/AI回归。UI需实际浏览器观察与交互，不只渲染测试。发布1.5.7按既有Wrangler3流程，精确提交与冻结tag核对源码、包和安装字节。
