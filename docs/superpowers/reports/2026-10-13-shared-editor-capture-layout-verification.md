# 空段与末硬换行来源验证

2026-10-13。独立计划 `../plans/2026-10-13-shared-editor-capture-layout.md` 完成；共享编辑器整体、网页 E1–E3、桌面 E4 和统一发版仍未完成。本次没有发布。

core `b5602875ad4805b844d476cb9df8d98d5d3b3a22` → `f62d4dcfa32e21d019f0f3fe9703c3d4aa6d8c39`；host `d1d3f0f89013c537ae004b7ea8f6f4dec0235924` → `f11ad5db7c846fd3831275c322022abdb344b293`。两仓 main，单一产品 writer，无新分支/worktree。core 两次提交分别为 `658f2cef`、`f62d4dcf`；host 两次为 `ba4ed15b`、`f11ad5db`；正式文档由 root 另行精确提交。

## 行为与审查

capture 明确真实 blank units、separator、root-tail empty 和 rawless baseline，保持自然 root 完整 raw map；reference 邻接按 runs，纯空 k 个完整 EOL 表示 baseline+k。实际 paragraph/getLines 恢复 terminal hardbreak；独立 source serializer 输出连续尾 hardbreak，仅去一个重复的生成 LF，再完整拼回原 tail。默认 parser/serializer、schema 与生产入口没有改变。保护定义的 serializer 前 guard 和最终 edit guard 均保留。

Task1、Task2 各独立 spec+quality Approved，无 Critical/Important。唯一 whole-range Astra/xhigh 最终审查 Ready，C0/I0/M2，不需 final fix。M1 为 harness 资源加载与 teardown 异常，M2 为既有质量警告；均保留，不据成功退出称输出干净。

| 门槛 | Task1 | Task2/最终 |
| --- | --- | --- |
| core RED | 21 failed | 11 failed /42 passed |
| installed host RED | 1 failed /1 passed | 1 failed /2 passed |
| core focused/full | 103 /464，4/30files | 99 /481，4/31files |
| host focused/full | 33 /4144，4/331files | 34 /4145，4/331files |
| tsc/core build/purity/Vite/Kit | 最终 exit0 | 最终 exit0 |
| 原 single-block Kit browser | 0 pageErrors | 0 pageErrors |
| index gzip /上限81920 | 54040 | 54579 |

最终 committed/build/installed 58 dist 文件全 SHA 一致，15 committed DTS 引用闭包、package exports、无 stale 声明；两仓 committed 和 working 的 14 原字节 fixtures/manifest 全 SHA/bytes 核对通过。入口 SHA256 `0d996b5c157a061689149fb2fbc8dec43aa66e03202c844656f4793e48651320`。4 changed source maps 的 embedded committed sources 全相符。真实大空白回归是 140000 个 LF，正式 preflight 原70k措辞已按实际纠正。

root 最后单次 Svelte check exit0，0errors/33warnings/16files，stdout SHA256 `8b01347630acee12475bf48d37d9909d6f6004b2e77fbe912e25134956c41551` 与此前保存的历史基线逐字一致；前后830host/133core源码与构建配置指纹及HEAD一致。完整 initial/session/final 工具结果保留。

## 失败、警告与证明边界

- L1 首次 tsc exit2：exactOptionalPropertyTypes 下不能显式 previousRoot:undefined，修为条件属性；未继续依赖阶段，最终 tsc通过，原失败保留。
- L1 首次 installed audit exit1：Git将旧→新hashed DTS判为 R076，原diff-filter=D漏旧路径；加 --no-renames、同 frozen BASE→committed HEAD 与单层白名单后精确删除旧声明。只重跑同步/审计，没有重复未变runtime套件。
- root 的 recorder 参数位置、fingerprint basename、git status列表枚举曾纠正；未改变产品，未重复已过Svelte。记录保留，不掩盖为首次全过。
- L1 stderr有AbortError/CSS fetch中止/AsyncTaskManager destroyed；L2有localhost:3000 ECONNREFUSED、editor-kit-v1.css NetworkError与destroyed。Task2报告遗漏由rootledger/最终审查补列。L1已有destroyed不证明L2 ECONNREFUSED在任务前存在；不臆断产品回归或完整baseline因果。
- KaTeX quirks-mode、Svelte a11y/unused CSS、混合导入和大chunk提示真实存在；Svelte基线SHA相同不能外推所有warning均已证明归因。
- 旧browser只有93bytes/1hunk、语义拒绝/exactACK/default单块回归；无新UI截图，不证明结构/native/Source/history/IME或完整语料三轮切换。
- 原7 git-status untracked列表、3stashSHA、force-pull backup ref和目录实际保持；该证据是身份/列表，不是未知文件原内容的byte审计。

## Rulings I made

Ruling: capture-only空段按reference邻接的连续真实blank runs各扣首行separator，全空文件k个EOL显示rawlessbaseline加k空段 — 实际parser/serializer可逆研究支持，加入不可见定义不应凭定义占行制造空段，沿既有空文档serializer表达最小 — 可见空段数量有意区别legacy，故仅capture语义改变、raw零修改逐字保留，显式fixtures验证且后续Kit必须以session.doc materialize；不能把fallback当raw删除权限。

Ruling: terminal hardbreak本计划只由真实paragraph/getLines恢复语义并用独立source-root serializer表达，不导出尚未证明的terminal raw授权字段 — nested容器不能借top-level连续texttrace伪造suffix来源，本切片不先造全AST — 后续结构删除/移动suffix需要另证准确子权限，不能据本计划GREEN声明所有硬换行结构操作已完成；defaultparser/serializer保持，strict allattrs不放宽。

Ruling: root自审修订计划的无界数组spread、R1 serializer前守卫及产物/日志脚本后直接执行 — 已有实际来源合同足够，草稿代码中的spread大空文件栈风险和ignoredDTS/installed旧hash/toolmetadata缺口可在dispatch前精准消除，不增加产品框架 — 实现偏差仍可能在largefixture、原R1回归和committed/installedclosure审计暴露，因此每task独立审查和最终门槛保留，不预填通过。

Ruling: host安装同步明确以--no-renames枚举frozen core-task-base→committedHEAD删除的hashed DTS，再做精确regex与路径删除 — 首次最终审计实际发现Git将旧markdown-Dp-_6v9A→新hash识别为R076，原--diff-filter=D漏枚举，只有新增--no-renames才能按旧路径不存在这一真实事实安全清理 — 若错误扩大到非本task输出可能误删安装数据，故仍限同baseline/HEAD与单层hashed .d.ts白名单，不清未知文件；保留原失败，修正同步脚本后仅重跑安装审计，不重复未变runtime全量门槛。

## 证据归档与持续工作

canonical archive：`/Users/bruce/git/mdeditor/src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-13/capture-layout/capture-layout-evidence.tar.gz`；SHA256 `402d9da2ca33fd026dad20dedcef93cd64110221e313f1aa9b45e7bbbaa82451`；2,865,050 bytes。318 原始/研究文件加 manifest，共319 entries，逐项回读 bytes/SHA通过；仅排除716个可重建Vite cache文件。邻接 `archive-verification.json` 保留核验数据；清理结果另记 `cleanup-verification.json`，不以计划清理冒充已清理。

下一计划 `../plans/2026-10-13-shared-editor-structural-source.md` 已root完整自审修订；新ownworkspace、不逐step全篇比较的N2快路、typed baseline-conversion、generated LF/kept EOL、committed-blob host安装与坐标合同均明确。自含脚本仅做syntax/wiring检查通过，不冒称拟议产品通过。后续list/fence、nested definitions、table持久化、共享文件env/局部parse、Rich/Source/native history、Kit身份/批注、两端和统一发版继续必做。
