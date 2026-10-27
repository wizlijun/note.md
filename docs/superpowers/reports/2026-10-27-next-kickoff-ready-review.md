# NEXT 可用性修复独立审查

审查基线：f9c765d7；工作区 /Users/bruce/git/mdeditor-next-ready。只读审产品源码，未重复执行全量测试。

## 首轮冻结范围：UI / core / Codex

结论：当前范围未发现需要阻止发布的问题；Context 与 DeepSeek 实际报告待冻结后补充。

- 进行中 Task 经过同一 kickoffEligible 门禁，在保存答案、刷新当前任务后再次校验有效性。未回答的 commitment / next_action / close_condition 沿用当前 projection，项目沿用 PlaceSheet 原流程。仍经 placeEvent 写相同 Task UUID 的 commit，reducer 更新同一条目，不新增 WIP 占位。App 集成测试直接用生产 placeEvent + reduceEvents 证明 WIP=1、item=1、项目保留；执行和保存答案本身不提前安放。
- 复合按钮共用单一边框与圆角，主动作与下拉区域无间距，内部仅分隔线。两个独立可访问动作保留正确语义，主动作 ArrowDown 亦可选择。未修改弹层全局 hover。
- capabilities.readonly_context 与 terminal_result 作为新增协议能力准入，同时仍要求 harness.ok。列表仍为宿主安装插件列表，不限定 Claude。旧 strict_readonly 字段不会误准入。单测验证无白名单生产配置可准入。
- Shared finalizer 对 strict_readonly 不扫描 artifacts，不 stamp deliverable 或其他 Vault 文档。新增直接测试验证原内容不变。
- Codex 严格模式拒绝 precheck / deliverable，AGENTS.md canonicalize 后限定 Vault 内且非空；stdin 显式携带协议；不拼接 tab/source context/CODEX.md。空临时 cwd 随进程结束删除。
- Codex argv 强制 read-only、ignore-user-config、ignore-rules、project_doc_max_bytes=0，禁用 shell、exec、MCP discovery 相关扩展、hooks、plugins、apps、浏览器、图像、技能发现及 code-mode host。读取过真实探针 stderr，确有执行层 `code-mode host is disabled`；不是仅用模型自述证明。真实 runner 接收完整 JSON 并通过生产 parsePayload 的证据见 ready-codex-report.md。
- 模型选择前的既有 effective_model app-server 仅初始化与 config/model 读取，未启动 thread/turn。未将配置或认证字段拼入模型 prompt。

## 待补充

- Context 模块：声明范围、预算、显式 source、筛选与 scope 排除。
- DeepSeek：冻结实现 + 真实工具拒绝/闭合 service graph 证据。
- 最终发行包及公网结果不在本轮源码审查的证明范围，由发布流程验收。

## 第二轮：Context / DeepSeek

DeepSeek 冻结实现与真实证据审查通过：严格 profile 在临时 DSH_HOME，无 bundle、空用户 patch，只有 10 个白名单服务；未装文件/命令/网络工具或 hooks/settings/MCP 扩展。只链接既有官方 ACP 包；唯一既有本机状态为凭据服务读取，密钥不进入 prompt。API endpoint 固定官方。移除 NODE_OPTIONS/NODE_PATH，强制拒绝 ACP 权限申请。真实验收测试实际设置恶意全局 profile 与 NODE_OPTIONS，marker 未生成、synthetic sentinel 未改变、terminal_result 完整持久化；不能单独依赖模型 tools=[] 自述。日志 /tmp/notemd-deepseek-ready/official-packet-acceptance.log。完整生产协议与 document/answer 验收见 tasks/ready-live/deepseek-verification.json。

Context 设计总体可接受：完整当前 Task、声明路径扫描、相关性和90天筛选、有界候选数、复用生命周期 reducer 判断完成、仅选中 ledger event 摘录，最终不写源文。发现以下发布前必修：

### R1 — 禁用 Task 来源仍会读取直接 sources

context.ts direct source 循环仅验证安全路径，未判断 data_sources 中 Task 来源是否 enabled。即使用户将 task 数据源 enabled:false，引用的笔记仍读入并发送模型，界面与实际授权不一致。须让直接 sources 跟随有效 Task 来源授权；显式禁用时只保留当前 Task，披露省略。回归应证明引用文件未被 io.read。

### R2 — gaps 的 Unicode 字节数可突破96KiB上限

预算预留4096字节，但 gaps 最多21条、每条150 codepoint，UTF-8路径可让gaps超过12KiB。文件先接近budget后再累积gaps时，最终JSON可能超过96KiB。须限制最终序列化字节数或gaps UTF-8预算，保留发生省略的明确提示；加长Unicode路径与接近上限文件组合回归。

### R3 — 严格执行的10分钟预算实际为可无限刷新的静默计时

Codex与DeepSeek engine 都每收到stdout帧就重置 deadline，严格任务的 timeout_seconds=600 因而不是总预算。建议strict_readonly不重置deadline，非严格旧任务保持现有静默语义；持续输出超过短限的fake harness应被Timeout终止。max_turns在Codex/DS没有直接通用映射，但总时限至少必须硬兑现。

上述3项已发送root，待修复后仅复审相应差异和针对性测试。

## R1/R2 修复限定复审

通过。direct sources 现在必须由 id:task、kind:vault、enabled 且 glob 匹配当前Task共同授权；done-tasks 不能覆盖显式关闭。gaps 按序列化 UTF-8 计算4096字节预算并预留最终省略提示，finish 对96KiB作硬校验。新增disabled no-read与Unicode长路径近满Task回归；实施者记录旧实现RED：103141 > 98304字节，修后25 context + 69 client测试通过。未发现新阻塞。

## 发行说明与追加坏文件/容量检查

发行说明描述 NEXT 1.12.0、Codex 1.0.21、DeepSeek 1.1.20 与本次源码一致；未声称 Claude 已验收。实机视觉因 CUA cgWindowNotFound 未完成，应如实记录，不能用 DOM 渲染测试代替。Codex/DS 的 max_turns=40 为模板约束而非CLI通用硬执行，正式说明应区别于已实现的总时限。

追加发现 R4（发布前必修）：discover 遇到任一损坏或重复结果全局throw，使其他Task的kickoff初始化/对账均不可用；terminal成功后输出路径冲突也抛出而不markFailed，registry保留running占据全局容量。须将损坏结果错误限定到所属Task、保留原字节；terminal conflict记录failed释放容量，其他任务继续对账。主工作区另一会话已有未提交同类加固，不属于本次提交范围，不能直接替它提交；需在隔离分支独立实现/验证或明确移植并验证。

## R3 修复最终限定复审

通过。两engine取run入口单调时钟固定deadline，strict stdin/ACP发送和stdout共享总预算且不会reset；普通任务保留quiet timeout。DS严格超时/取消跳过可能阻塞的ACP cancel写，直接终止进程组，强杀后代与stderr drain 1秒限时避免继承FD拖住收尾。新增真实复现的持续40×60ms输出旧实现错误Success为RED；修后strict 1秒Timeout，普通24×60ms输出跨越1秒仍Success。DS另有忽略TERM且后代保留stderr的synthetic launcher测试。记录的完整测试Codex90 passed、DS137 passed / 2 ignored。

后端冻结审查通过；NEXT R4尚待修复或明确处置。

## R4 最终限定源码复审

通过。发现阶段按Task UUID、已知固定输出路径和前次结果路径隔离故障；部分YAML仅UUIDv4可归属。坏/重复/不可读文件原bytes保留，相关Task失败并去掉旧result，未知文件跳过；健康Task继续load和terminal对账。load每Task hash读取失败不再全局抛出，旧hash删除，成功读取或preflight后可恢复。terminal输出冲突记failed，释放running容量。失败经现有status/card view显示，无全局poll toast风暴。回归覆盖未知坏文件、duplicate、terminal中途改文件、不可读/消失文件、hash失败恢复、已知结果不可读；实施者先记录RED后GREEN，最终全量测试正在结束。

最终审查结论：R1–R4均已修复且限定源码复审通过。UI/core/Codex/DeepSeek/Context/故障隔离未发现其他发布前必须修改项。最终测试、冻结tag/包内容/公网验签由root发布流程继续核对；本报告不声称已发布或已完成实机视觉验收。

最终验证补记：ready_codex已确认最终44个测试文件 / 806项测试全部通过，svelte-check 0 errors / 0 warnings，Vite 255 modules构建成功，git diff --check通过。本审查报告在该源码状态冻结；root后续只追加发布日志、spec状态与max_turns澄清。批准进入精确提交及既有插件发布流程。
