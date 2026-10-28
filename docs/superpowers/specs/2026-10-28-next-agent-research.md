# NEXT 开个头：agent 自主检索 v3

用户要求：检查失败原因；并发可调、默认3；NEXT不代agent检索或列文件，agent在计算的用户Vault调用notemd search CLI，并用harness联网检索近期相关文章。

## 证据与边界
本机NEXT1.12.1唯一已查到的运行成功且结果已落盘，不能称为终态失败。实际结果仅引用当前Task，直接来源的Vault根链接被context.ts误拒绝，目录扫描耗尽预算。v2禁全部工具，agent无法补足背景。此次在9b965e3c（包含已发布NEXT1.12.1与Claude1.0.34源码）上独立开发，不修改正式Vault，不安装或发布。

## 分工
- NEXT只核验Task UUID/当前生命周期、计算Vault绝对根目录与原文哈希，传Task相对路径、身份、日期、泳道和执行协议。无背景扫描、文件列表、正文快照。
- Agent读取Task，自行规划关键词，通过notemd search --vault <运行时根目录>检索相关上下文，再按harness能力联网搜索近期相关文章，读取原文、区分事实推断、返回结构化JSON。网络查询不得附送私密原文；联网结果不代表用户决定。命令不可用或来源不足明确记gaps。
- Agent不修改Vault内容、不执行Task、不发送消息、不变更NEXT生命周期。CLI派生搜索缓存由CLI维护；只读沙箱不可写缓存时，CLI直接扫描降级，stderr警告本身不等于失败。NEXT校验JSON、Task身份及来源路径/URL后写独立kickoff文件，用户确认才安放。
- 首次/运行前UI展示服务商、Vault与任务及检索权限，不伪称已冻结或发送特定文件。

## 协议
新task ID next-task-kickoff-v3 / protocol_version 3，不复用v2 input-only模式。旧v1/v2运行继续按原task ID对账，旧快照来源约束保留。v3 capability显式公布并检查；未升级provider给出升级提示。模板与协议版本一致、预算max_turns<=40、timeout<=600、禁止precheck/deliverable。使用provider既有只读检索能力，强制实际运行权限，不依赖prompt模拟安全边界。隔离用户MCP/plugins/hooks；Codex保留调用原生工具必需的code-mode router，受native只读sandbox约束。v3最终载荷只取最后完整assistant消息，过程叙述仍展示为进度。Skill只提供判断方法，旧快照/无工具指令不得覆盖v3执行协议。

来源支持合法Vault相对路径和无凭据http(s) URL；禁止目录穿越、元数据目录和其它scheme。URL只表示agent引用，不由NEXT代抓取；UI外链走宿主shell。v3不要求来源存在于事先选定文件包。

## 并发
复用每个Agent现有最大并发设置（1–5），默认3，旧显式选择保留。NEXT按所选provider额度限制本Vault开个头；不宣称全App所有任务共享硬限流。后端按当前Task路径分锁、进度按run_id隔离；同Task仍禁止重复运行。下调额度不终止正在运行的任务。

## 验收
临时Vault覆盖：准备/启动无背景正文读取或目录扫描；真实Vault路径包括空格/Unicode正确传递；v3工具可用、v2仍input-only；近期文章URL保存和打开；三个Task并发、第四个受限、配置1/5、同Task互斥；预算与权限不可放宽、错误原因可见；旧运行/旧结果仍可读。NEXT全量测试/check/build及相关Rust/设置回归。正式数据只读检查，不启动真实提醒或改任务。
