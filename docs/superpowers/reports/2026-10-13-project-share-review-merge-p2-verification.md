# 项目分享 Review/Merge P2 验证记录

日期：2026-10-13。**P2 实施、独立评审和最终门禁完成；本记录不代替实际部署/发行证明。** P2已随[v6.1013.2正式发行](2026-10-13-v6.1013.2-release-verification.md)，部署/公网证据见该记录。

依据：[批准spec](../specs/2026-10-12-project-share-review-merge-design.md)、[P2计划](../plans/2026-10-13-project-share-review-merge-p2.md)。完整范围 `205a3ce098b8d0a4f15ad67603e620825dde2e7e..8855ef4992df257036416f5f4cb67ecd041ab212`。直接main、一个worktree、串行产品writer；未恢复原stash/backup或纳入用户未跟踪文档。

## 规格覆盖

| 规格 | 交付与验证 |
|---|---|
| §6.3、§16 | v1永久兼容、严格v2收件与UTF-16；Worker/Rust共用161份JSON（17合法/144非法），两invalid命名上限已独立隔离 |
| §6.6、§10 | 公开active-only版本接口；独立receipt前缀、owner/visitor鉴权、过期/撤回/CORS；ProjectState schema不改 |
| §6.4–6.5、§8.5 | 默认回执、关闭撤回、回复、计数、首次纳入hash证明、supersedes仅展示；元数据操作不恢复源写入 |
| §6.7、§11 | DraftV2/伴随批注和发送hash、原字节重试、旧稿迁移/导出/旧版本提交、新版本提示、最近提交回执 |
| I6/I7、P1 B/C | 既有源/Git边界由controller边界JSON与真实Rust no-recover回归验证；不据此声称新Rich已保真 |
| §12、§13 | 未交付；[编辑器源码保真gate](2026-10-13-project-share-editor-fidelity-gate.md)给出E1真实失败与E4静态风险，新增前置仍待人裁决 |

## 独立评审与最终修复

每任务独立spec/quality gate。Task1/2首次通过；Task3首次3个Important（未知PUT无法撤回、apply/批注窗口漏报、旧冻结包误报纳入）由700fdbd9修复，唯一scoped复审关闭。Task4首次2个Important（异步lineage串写、删除/改名旧文件恢复崩溃）由6b95ad16修复，唯一scoped复审关闭。

唯一全范围审查覆盖205a3ce0..6b95ad16，Critical0/Important2/Minor1，With fixes。最终一次统一修复8855ef49关闭：I1非法候选提前冻结导致持续400；I2旧原文坐标命中新同名片段；M1两夹具独立性。随后唯一scoped复审I1/I2/M1全部ADDRESSED，无新增breakage或out-of-scope。没有第二次broad review或无限修复循环。

冻结前校验完整v2形状/边界；已有非法pending仅在同一包实际400且本机证明非法后可显式纠正，未知结果继续原字节重放。每lineage最多一份被明确拒收原包companion，可导出，不扩展DraftV2。批注本机保留base锚点，wire转换到实际afterMarkdown；歧义/缺失阻止组包并保留草稿，允许显式移除恢复。v1迁移/累计supersedes/本机去重共用投影，不改旧wire。

## 最终门禁与证据

所有完整测试均在不可变8855ef4992df257036416f5f4cb67ecd041ab212运行，exit0、headbefore=head after，原始log SHA-256逐份重算：

| 命令 | 结果 | 原始log SHA-256 |
|---|---|---|
| `pnpm exec vitest run` | 327files /4111passed | `fa2446a5d6bd48dd12e45186d1afb735b78b22f6dcffa7fe50f1a8477b83f9a2` |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 22汇总 /1448passed /0failed /0ignored | `cbcc83c93dd1cc1703ca22859873f75da5475ca76914ec360961f778694f1ccc` |
| Worker cwd `pnpm exec vitest run` | 9files /484passed | `63468f6afa676c422bc62c4e65f050ed5958898614f29c4b13d8c10eea611bc0` |

最终affected539项、共享fixture161项、check、build与真实Chromium先于上述完整门禁通过。832个保守构建输入与7个实际browser/Worker/owner源hash均0差异。check 0errors/33warnings、16files，完整原始输出与开工baseline逐字相同（SHA `b4a530f02a8a893259898a4d4a2a60f939ea18d9072af1f366c5e188907f4a4c`）。构建chunk提示、Worker兼容日期回退、Rust ParsedHeader及HappyDOM清理噪声为已登记基线，不称输出pristine。

真实Chromium使用正式serialized bundle→实际Worker handleFeedback（仅memory R2替身）→实际owner anchor：81字署名/2001UTF16说明/超限批注纠正后200；400显式恢复；服务端已存储而连接断开后原字节幂等重试；同名插入后定位17/23、位移11/17；歧义保留；v1迁移及累计supersedes后重开不重复。真实IDB gate证明输入归属/事务失败保旧。所有RED、中间失败及最终GREEN保留。

## 保存与清理

本轮证据归档：`src-tauri/target/release-artifacts/v6.1013.2/p2-verification-evidence.tar.gz`。

归档 SHA-256 `2f6206656048bdc3d6af4c844742079eddf42e5c02c588b2f802ef1c4d88f4bc`，10,639,585 bytes，621个文件；归档内evidence-manifest.json逐文件大小/hash回读全部一致。包括全部brief/报告/评审/diff/日志/截图/源码指纹、原E1失败语料、E4未采纳草稿/preflight及共享保真前置草稿。未保存生产凭据；未上传为发行资产。

归档后仅删除本计划SDD临时workspace；兄弟workspace、原七个untracked、三stash、force-pull backup ref/目录保留。正式发行产物及本轮release-evidence另行维护，未以本机提交代替发布。

## 限制与未完成事项

- 无旧基线且无冻结体的v1旧稿只能导出；具备冻结体则原字节重放。FIFO200淘汰后可能再次显示原包入口，仍幂等；不可可信转换的本机去重保守。
- 首次纳入证明针对实际采纳Markdown result_hash；证明不足省略optional ID，不声称附件历史图已验证。
- P2不加载Kit、不执行rebase。E1真实门槛失败；E4只有静态核对，未声称Tauri实测。新增共享源码来源/局部序列化前置待人裁决，未降低I7或用事后格式过滤。
- 免费Worker旧上传archive reseal/status-cleanup各10ms，strict<10ms尚未通过；代表/限额/KVlegacy最终CPU验收不完整。本轮未修改上传CPU路径，不宣称已解决。
- native owner UI/OS picker/iOS TestFlight未作本轮验收；P3排除。生产部署、七资产匿名下载/验签/公证/latest必须另以实际发行报告证明。
- 发布库存已核对本地/远端所有分支、未提交项、正式tag实际代码、26插件和core57文件。Memory9a14dd7c/Richc49b8e66已在v6.1013.1，当前保持；其他旧产品分支实际等价已发行，Cloud Agent90b97559仅开发环境明确排除。插件源码/registry无变更，避免重复发布相同包。

## Rulings I made

以下为账本按时间顺序原文，含理由与误判代价：

Ruling: 沿用用户已选子代理执行方式，规划后直接实施并继续至发版，不再重复询问执行选项 — 用户明确连续要求继续完成且此前已授权该流程与发布 — 若对授权理解有误，会产生可回退提交及已授权范围内发布。

Ruling: 所有任务直接在现有 main 工作，不创建分支或 worktree — 用户明确要求合并到主干且不要开 worktree — 若判断有误，隔离程度较低，需靠单写者和逐任务提交避免冲突。

Ruling: P2 表单批注使用同库独立 draft2-notes 伴随键，DraftV2 保持 spec 形状 — spec 同时要求 fallback 表单批注与严格 DraftV2，未规定表单批注存储位置 — 若选择有误，E1 需迁移伴随键，必须保持旧草稿兼容。

Ruling: v2 offset 长度和自引用规则在 Worker 与 Rust 都执行 — §6.3 表格明确两端执行且共享 invalid 夹具要求一致，优先于后文额外语义校验的概述 — 若解释有误，格式非法的 v2 包会提前被 Worker 拒收，合法 v1 不受影响。

Ruling: 共享夹具在 Vite 转换或 Node 配置阶段枚举后交给 Worker 测试，而不是在 workerd 内调用 node:fs — RED 已证明 readdirSync 未实现，原计划的运行环境假设错误 — 若载入方式有误，可能漏掉夹具，需断言目录覆盖与非空样本。

Ruling: 回执编排新增本机 feedback-readonly 元数据读取，不调用会恢复源写入意图的 inbox/review — P1 B/C 的无源文件副作用边界也适用于回执元数据操作 — 若新增入口多余，会多维护一个受锁保护的只读 op，代价小于隐式恢复写入。

Ruling: 无旧基线且没有已冻结请求体的旧 v1 草稿只能导出，具备冻结请求体则按原 v1 字节重放 — 旧格式根本没有保存未提交编辑的 baseHash，新页面无法可信重建旧版本提交 — 若判断有误，会少提供一次在线提交途径，但草稿保留且不伪造版本依据。

Ruling: 聚焦测试统一使用 pnpm exec vitest run 加文件参数，不经 pnpm test -- 转发 — 本机 pnpm/Vitest 将该转发形式解释为完整套件，不能假装聚焦或重复昂贵门禁 — 若直接执行形式有误，聚焦过滤可能不完整，最终仍有显式全套门禁兜底。

Ruling: 增加独立 feedback-list-readonly 批量元数据读取，与单份 feedback-readonly 保持明确类型 — 发布补写和批量回执需要枚举记录，现有 inbox 会恢复源写入意图，不能复用；单份接口不改为可选参数多态返回 — 若选择有误，多维护一个受同锁保护的只读 op，但不增加源文件写入路径。

Ruling: included_in_snapshot_id 在项目发布成功后、回执 PUT 前冻结，补写发送失败统一 state=failed 并保留该 ID，不新增 pending_included 字段 — 该字段证明内容在哪次已成功发布，不证明回执网络送达；现有 failed 状态与字段足以让 pull 重试同一首次快照 — 若语义判断有误，界面会把回执更新失败显示为失败，旧远端回执仍在，但不会丢失首次纳入版本或需要第三套状态。

Ruling: 本机回执增加可选 sent_payload_hash，仅以公开 allowlist 投影的 SHA-256 去重，并把已冻结 decided_at 视为可能投递过的撤回依据 — sent 状态本身不能证明计数未变化，远端成功但本机确认前崩溃也必须可撤回 — 若判断有误，多保存一个不含正文的摘要并可能做一次幂等 PUT/DELETE，但不会永久漏报或无法关闭回执。

Ruling: includedInSnapshotId 只在已发布不可变快照逐文件 hash 与采纳决定 result_hash 相符时补写，证明不足不填可选字段 — 计划笼统按完成时全部 sent 回执补写会把旧冻结包误报为包含后来采纳，规格6.5的实际纳入语义优先 — 若证明过严，后续又有合法编辑的文件可能少显示实际纳入版本；正常处理回执继续发送，不作虚假纳入声明。

Ruling: 新 bundle 的 versionUrl 缺省时仅由精确 /feedback/<slug> 路径推导，无法推导就要求显式同源地址；host 仍显式传入，旧 HTML 缺字段继续兼容 — 计划要求每个新页面具备版本查询，而 project_id 不是公开 slug，不能猜测任意 URL 尾段 — 若契约判断有误，非标准 endpoint 调用者须补一个显式参数；当前产品调用不受影响，仅修正一个无 slug 测试夹具。

Ruling: 提交成功保留累计 after 与表单批注，新增独立 draft2-sent companion 保存冻结包内容投影的 submissionId/contentHash，和成功账本同事务落盘 — 规格6.7/11.3/V5要求后续继续累计建议，清空 after 会让用户已送改动从编辑器消失且破坏 both-same；摘要可在不扩展 DraftV2 的前提下跨重启去重 — 若投影选择不当，可能多一次显式建议提交或抑制仅昵称变化的重复包，必须覆盖消息、后续累计编辑及在途输入测试；不储存额外历史全文。

Ruling: 无基线旧 v1 冻结包重放成功后原旧键保持原字，仅原子追加 submitted 并据其隐藏重复重放 — 旧键只读迁移且可能包含冻结后新增输入，不能删除或添加 delivered 字段 — 若200条FIFO日后淘汰该ID，用户可能再次看到旧包重放入口，但显式重放仍是原字节幂等，不丢草稿；不另建无限历史账本。

Ruling: 旧 v1 冻结包的本机发送摘要允许复用迁移的可信基线 quote→selector 转换，无法可信转换则不判等，原请求体完全不改 — v1与v2批注结构不同，直接哈希原wire会让正常迁移后的未改草稿重复提交；同一转换责任避免分叉 — 若转换过严，特殊旧包可能多一次显式提交；若定位不可信绝不猜坐标或吞批注，必须以带批注迁移重放后重启测试兜底。

Ruling: 表单批注的原文锚点仅作本机来源，发送时必须转换到实际 afterMarkdown；非法候选冻结前完整校验，已明确400拒收的非法v2包只能经显式纠正动作退役而不改写原包 — 最终审查复现了错误坐标和永久400，规格6.3的提交文本坐标与协议上限优先于计划的原文定位简写，网络未知仍逐字节重试 — 若定位过严可能阻止一份需重新选文的提交；明确拒收恢复若判错可能多一次幂等建议，因此仅对已证明非法且明确400的包开放，保留草稿与导出。
