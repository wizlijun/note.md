# 表格与语言生产计划 root 自审

计划：`../plans/2026-10-13-shared-editor-table-producers.md`。直接main、用户已授权持续实现，不再请求阶段批准。前置source-only结构产品7ec5d621/440e7302与文档闭包fc541441已受理，canonical archive d897e5ea…选取11份资料逐SHA验证；本表为root自审，不派额外plan-reviewer。脚本准备agent仅编写scratch工具，不审查产品。

| 配对 / 自审对象 | 生产→消费 / 核验 | 处理 |
| --- | --- | --- |
| Task1 self | table schema基数、parser createAndFill、TableMap、header-only旧负例一致；language默认/DOM/sync/async/source serializer与actualproducer一致 | 更新两个仓库旧负例，精确只改两grammar默认；async阈值当前50000，样例60000+实际分支 |
| Task2 self |共享schema-local Command、Kit typed union、Rich actions/menu/i18n、真实事件dispatch | root与commands导出同签名，Task2先针对现有Kitalignment实际RED，不能missingimport冒RED |
| Task1→Task2 schema/markdown/commands/tests | Task1 header-only+空language，Task2添加表格commands并使用受理schema | Task1审查/fix全部关闭才freezeTask2；source-structure-commands.spec已存在，纳正式重点回归 |
| Task1→Task2 dist/installedmanifest | 新committed dist与B-authorized package metadata供两端 | 六自含脚本验证所有exports目标、actualimports、DTS/maps与14fixed字节；安装metadata原子替换，不写store硬链接 |
| Task1 SDK→common gates | baseline唯一style缺项必须修复而非masked | 原失败和alltargets=false保留；最终gate不接受缺项；README说明宿主样式，主入口+全部现存JS actualimport |
| Task2 commands→later width/file/history | PM完整attrs、shared动作与确切列索引 | 本片不ignore colwidth、不引layout sidecar/第二history；后续必须处理真实resize和single-history |
| Tasks UI→Rich fixture | 实际Svelte Rich挂载/Kit execute与菜单hover | canonical选取已验fixture只作起点，新的动作与结果独立记录；不冒称native/IME |
| Task loops→final | 单fresh reviewer同时spec+quality→fix新commit→唯一wholefinal | 修正候选两reviewer重复seat；root检查最终输入，必要新fix复验不覆旧记录 |
| preserved state→stage/build | ignored/nottracked tasks/lessons和7原untracked；build clean:true | 精确stage allowlist；dist未知先归属/保存，不能clean/reset/addall/amend；完整toolmetadata且非预期nonzero即throw |

Ruling: 接受header-only GFM表，将table body基数+改*，不紧缩row/cell、不补伪body；TableMap/doc.check/strict Source正例一起验 — 真实GFM允许分隔行后无body，当前schema自动生成零cell body导致合法输入无效 — 旧非法负例必须转正且保留真正非法doc；若失败不能用fixTables或额外节点掩盖。

Ruling: 缺省代码语言统一空串，显式text保持text并序列化为text，toggleCodeBlock只取state.schema — 实际InputRule/Enter/Kit/Rich已产空串，parser的text与serializer抹text使真实producer不能严格回读 — legacy JSON默认与显式text输出会变，旧挂载state不批改；DOM/sync/async/source/picker与图表精确路由回归必须通过。

Ruling: 共享gfmTableCommand从root与既有commands子入口导出，Kit/Rich及已有insertTable委托，一事件一笔结构和selection事务 — 两端复制算法造成新行alignment丢失与行为分歧，schema-local命令是最少单一维护点 — 现有attrs/marks/colwidth必须保留，merged/异形拒绝，不能因Source表达不足清attrs或制造第二历史栈。

Ruling: 本计划只交付表格与语言生产/契约，width/file/cache/bindings/同一history/Source/native/人工IME/E1–E4和统一发行保持主任务必做 — 这些能力的依赖与本次可独立验证schema/commands不同，具体fail-closed不能作为最终用户体验 — 若分片边界错误会掩盖未接线能力，故报告/UI平台/原文保真与人工验收限制逐项明列，不标整体完成。

脚本实际正文/语法与quote/元数据检查完成后才dispatch Task1；静态检查不证明产品GREEN。完整主spec I7、三次Rich/Source零diff、一字一hunk及两端/发行仍后续必过。

执行工具自审完成：全部原audit.mjs与六入口已读；修正误带未来prepareFileSourceEdits断言，artifact/stage统一冻结snapshot并核package/dist SHA及源码allowlist；显式main guard、去除无关parser私有shape探针。ROOT-script-syntax-003为ast/node-check/sh-n静态通过，尚未运行产品gate。actualinstalled package bytes与BASE同SHA且nlink7，故committed manifest须rename原子替换。正式计划脚本正文已同步实际文件，stage只处理授权dist与源码，不commit。
