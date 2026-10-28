# NEXT 开个头 v3 实现与验收（未发布）

## 诊断

基线9b965e3c，包含已发布NEXT1.12.1与Claude Agent1.0.34源码；主工作区1.11.0及已有未提交修改未纳入。

只读检查本机10月28日11:04运行：后端success、独立结果已保存、运行登记已清理且有未读。因此没有证据将其称为终态执行失败。实际功能问题是结果只引用当前Task，直接来源的Vault根链接被预检索器误判不安全，目录预算耗尽；v2禁工具，agent无法自行补搜。

## 修改边界

- 移除NEXT前置背景检索器及文件快照，传当前Vault绝对根、Task路径/UUID/哈希/泳道/日期和v3协议。Agent自行调用notemd search CLI和harness联网检索近期相关文章。
- 独立v3任务ID及capability；旧v1/v2运行按原模板对账，v2继续约束快照来源。保留用户自定义旧规程，v3执行协议明确覆盖旧检索禁令。
- Agent不执行Task、不改Vault内容、不发送消息；NEXT校验结构、身份与来源后保存独立结果，用户提交安放才改生命周期。
- 各Agent沿用1–5的最大并发设置，默认3，保留已选值；NEXT按本Vault该provider运行数限流，不声称全应用跨任务硬限流。后端不同Task文件分别加锁、同Task互斥，按run_id隔离进度；v3不扫描产物、不补写OKF。
- 文章引用支持无凭据HTTP(S) URL，网页内容由agent回读，NEXT不代抓取；外链经新增host.link.open打开，不混入Vault editor.open。

## 已完成验证

- NEXT全量830项通过；svelte-check 0错误/0警告；vite生产构建通过。实际JS含v3、notemd search、vault_root、host.link.open，不含旧背景packet标记。
- 新回归覆盖默认3/配置1/3/5/第四个拒绝、同Task拒绝、降额不终止旧运行、路径空格/中文、无背景正文读取、web来源保存、v2旧运行来源限制。
- 三Agent设置与渲染共48项通过，三svelte-check均0/0。宿主agent_provider生产模块16项通过。
- 宿主真实编译后的ui_rpc全64项、host_api能力表1项通过，含外链scheme/凭据/控制字符校验、capability门禁及原Vault打开回归。
- scripts/verify-next-search-readonly.mjs实测Codex0.162.1与DeepSeek Harness0.1.0-rc.7真实sandbox：notemd search冷缓存降级t1-scan、exit0、命中1；Vault写入拒绝且源内容/文件列表未变。只用临时Vault，无模型调用。

## 验收收尾

- Core最终171项、Codex101项、DeepSeek148项、Claude138项通过。带认证或本机工具的opt-in测试不计入默认单测数量。
- Codex实际engine+真实模型：notemd search命中、native web search成功、Vault写入被拒（21.35秒）；进度叙述与最终JSON分离。完整生产client.prepare/start生成的协议随后经真实engine运行78.74秒成功：terminal 4616字节、5条来源（3个网页、Task和检索到的context.md）、1道问题。实际TS parsePayload返回0 repairs；build/parse文档往返成功，OKF lint 1份通过，Task/context字节未变。最后新增的Task路径JSON编码由含换行/中文文件名回归验证。
- DeepSeek生产研究配置经真实harness dump-config和同图挂载，官方bash/read/web_search注册成功；真实CLI查到合成记录、read成功、write与sandbox升级拒绝。其研究模式不继承用户MCP、hooks或plugins。当前官方安装未提供web_fetch包，未新增依赖；真实生产graph通过只读bash + curl匿名回读官方网页成功、不落盘（opt-in 1项通过），协议明确该回读后备及失败披露。网页搜索复用已有credentials-local凭证，不新增密钥。官方ACP每段committed消息单独发送，v3仅取最后完整消息，普通/v2拼接行为保留；新增回归验证。
- 实机发现Codex当前模型依赖code-mode router调用原生工具，完全关闭router会导致工具不可执行。v3保留router，继续禁用户配置、规则、apps/plugins/hooks及MCP来源，原生文件和shell受只读sandbox约束；真实写入拒绝证明该路径有效。
- 独立审查发现并修复两项P2：历史来源路径不应让整份带人工答案的文档不可读（reader保留旧数据、打开入口仍校验）；Task文件名必须JSON编码避免换行拆开参数。没有剩余已确认P1/P2。
- 代码与本验收报告一起精确提交，提交号记录在tasks/todo.md及交付回复；不代表已发布。

## 交付限制

本次不安装或发布NEXT、Agent或宿主，不修改正式Task、提醒或旧技能。新功能需要配套Agent v3 capability与宿主外链/默认并发支持；发布时必须提升NEXT最低宿主并冻结tag、验实际包。Claude真实CLI已确认暴露Bash/Glob/Grep/Read/WebFetch/WebSearch，但本机认证过期且未装Claude Agent，未宣称它完成真实模型检索；保留精确验收边界。
