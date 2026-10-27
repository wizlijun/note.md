# NEXT 背景快照评审修复

基线 e5243f57，隔离工作区 fix/next-kickoff-context-review。计划发布 NEXT 1.12.1、Codex Agent 1.0.22、DeepSeek Agent 1.1.21；本文件记录源码验收，正式包、市场与安装结果另见发布报告。

## 修复及证据

- 背景：各来源与锚点公平预算、宽通配受限广度扫描、中文 bigram、账本已完成路径先过滤。650 个未完成 Task / 60 个顶层目录和中文标题部分词语的回归通过；本地账本独立 1 MiB，只发送相关完成片段。context 32 项通过。
- 告知：每次先 prepare 冻结，再展示接收方、文件、字节、数据源和 gaps，确认才运行；取消不发送。Task/规程改变要求新预览，背景改变仍发送已批准字节。
- 来源：registry 保存 context_paths，重启也只承认发送过的来源；旧 run 无清单不冒称 fact。运行模板持久化，旧 v1 run 继续用原 task id 查询。
- 协议：独立 v2 模板保留 v1 用户内容；前端要求 kickoff_protocol_versions:[2]。Codex/DeepSeek 四入口只消费冻结 prompt，不再拼磁盘指令；v2 不能退回普通工具模式，执行前再次验证只读、无 precheck 和 600 秒/40 turns 上限。max_turns 仍是模型协议目标，600 秒为执行层硬总限时。
- 文案：未支持 Agent 明确暂不支持，Claude 本轮仍不发布、不参与真实验收。
- 旧低优先：锁冲突生成 capacity 终态，不覆盖占用者；duration 为非负整数秒。

## 源码验证

- NEXT 45 文件、835 测试通过；Svelte check 0 错误/0 警告。
- agent-run-core 166、Codex 96、DeepSeek 143 测试通过（DeepSeek 两个需认证测试默认忽略，正式包真实验收单独记录）；Claude 125 项兼容测试通过。
- Agent picker 副本同步和插件发布脚本测试 87 项通过。移除发布测试中与设置入口断言无关的陈旧 1.10.0 固定版本值。
- 独立审查者执行 158 项定向测试，发现的锚点饥饿、task.json 指令未冻结和 v2 降级竞态均经修复复审，无剩余阻塞。
- 真实 Chromium 140：实际 App/client、内存 Vault 和模型 stub；每次确认、切服务商、preview-changed 再确认、取消零调用；最终唯一调用使用已确认 DeepSeek/v2 输入。
- 实际浏览器 hover 为全局蓝底白字，复合控件统一外框/分隔线，1080×850 和 440×620 截图已检查。此项不代表真实模型或正式 Vault 验收。

## 发布范围审计

共 4 个 worktree。主工作区 17 个 tracked 修改和 9 个 untracked 路径属另一会话，保留不提交；本轮在独立 worktree实现并验证。另两个 kickoff worktree 干净。所有本地分支均无 origin/main 之外的提交，故无待 cherry-pick 或补丁等价争议。

3 个历史 stash 分别为市场/下载与旧 NEXT 生命周期工作、roam 增量导入、attention plugin_host；逐项列名核对，不属于本轮背景/确认修复，均保留。本次不包含主工作区 capacity fixture 或其它会话未验证代码；本轮 shared/Claude 兼容改动由独立实现与测试覆盖。

待正式包真实模型验收、冻结 tag 与签名发布成功后，发布报告将记录 commit、包哈希、公网回读和安装结果。源码测试不能替代这些证据。
