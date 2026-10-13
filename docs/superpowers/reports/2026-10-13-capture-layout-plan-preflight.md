# 下一 layout 计划 root 自审（已修订采纳）

root已完整读776行草稿与notes，对照master§12.4/I7、实际core b5602875源和host a7136c29消费点；未派plan-reviewer，不运行草稿代码。以下修正已在正式计划inline接入；产品验证待实施。

| Task / pair | producer → consumer | finding → root修正 |
| --- | --- | --- |
| L1 self | 真实work行/ProtectedSource→BlankDraft | 单次物理行游标、真实raw片段、reference端点Set、flowtail独立container均与研究一致。runs/k+1规则是root显式选择，不当成既有默认；legacy默认完整保留。result.push(...run)/result.push(...before)对未设上限空白文档会溢出JS参数个数；改有序for循环；最终真实回归使用140000个LF（原自审写70k），仅验证内容/来源数量非毫秒预算。 |
| L1↔N2 | natural完整map/actualhandler emission→ownerByChild | natural事件先注册、synthetic不在rootchildrange内，root-tail不能挂空gap；固定list7/empty2/B3坐标有真实来源。stable bodymark只复制原tail，synthetic/root删除继续拒绝，完整结构后续必做。 |
| L1↔L2 | SourceSession.layout/paragraph/getLines→terminalrenderer | layout类型一致，L2仅同实际paragraph规则恢复末LF，nested不伪造连续rawtrace；不增加未经证实TerminalHardbreak raw删除权限。toptextspan继续严格匹配实际发出内容；已有捕获测试的legacy eq仅在具体语义改变输入改明确expected，不全局删guard。 |
| L2 self | ProtectedSource→局部serializer | 草稿完整renderChangedRoot替换丢掉前置R1 serializer前guard、只靠最终editguard。必须保留overlapsProtectedSource(base,root.sourceFrom,root.sourceTo)前置拒绝，不能撤回已采纳合同。 |
| L2 self | actualterminal→serializer/newEOL+原tail | 仅新生成LF去一个、原tail全部保留；连续末hardbreak用原Markdown语法反斜杠。sourceRootSerializer独立实例不改默认serializer；严格全部attrs/marks重捕获不放宽。未证软换行/tablecell/未知container仍后续，不冒称全部能力完成。 |
| L1/L2 artifact | tsup clean+hashedDTS→stage/installed | 草稿新DTS用git add而非精确-f会重复既有ignored失败，改仅已证明被引用newDTS精确-f。host cpSync不会删除旧hash、随后unexpectedInstalled必失败；hostsync增加只删除本task基线→已提交HEAD明确删除的dist声明路径，不泛清安装目录。最终DTS闭包必须从committed blobs逐specifier核对，不能只检查working输出。 |
| L1/L2 logs | subprocess→tool session/exit | 草稿run.py把子进程metadata记.exec.json却没保存工具初次/session/final结果，与现有经验要求不一致。最终command.json记子进程全metadata，.tool.json独立存完整工具返回链，rawstdout/stderr不丢。前置失败停止所有依赖下游；不预填通过。 |
| L1/L2 review/process | completecode→TDD+commit+independentreview | 草稿写“root自审”不能替代每task独立spec+qualityreview；改commit→independentreview。任务标题改Task1/2供task-brief真实脚本，root追加GlobalConstraints/commongates，含完整已定义接口。 |

剩余spec硬门槛明确：结构/属性、保留片段、history、SourceDOM/native/局部解析/IME、Kit身份和全出口、两端/完整语料UI/统一发版。该切片有独立可验证来源模型，不能勾选整体。后续正式baseline为当前coreb5602875；hostroot文档闭包commit将记录实际值，不猜未来SHA。
