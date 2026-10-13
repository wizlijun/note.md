# 共享编辑器来源映射首切片验证记录

日期：2026-10-13。**本切片已通过；完整 I7、正式保存、网页 E1–E3、桌面 E4 和统一发布仍未完成。** 用户已批准增加共享保真前置，再完成两端协作。P2 v6.1013.2 已发布，不重复实施。

## 实现与边界

依据 [首切片计划](../plans/2026-10-13-shared-editor-source-fidelity.md) 与 [主 spec](../specs/2026-10-12-project-share-review-merge-design.md) §12.4。

- core main：`1cb70441f440f50ac4b023857f6d48d5b70eda5a` → `cafc03894cbc68294a01fafda118d59c61265eda`。真实 parser 捕获来源；单普通段落、单文字 ReplaceStep 按原文范围 splice，重解析仅用于语义否决。
- 宿主 main：`a474eeabe4ff0f164bec2a3be38cbda369486a0b` → `57a99d0a095e10d9a8e9c93a4e46570bb3a852b1` → `ace4ddf238ebc42207174ad8a41b94ea50fa5007`。真实 Kit 新选项 `preserveSource` 默认关闭；正式消费者没有启用。
- 纯 prepare 与接受后 state.apply 分离；后置 filter 拒绝不推进来源。初审发现后置 storedMarks mutation 漏洞，两个行为 RED 后修复，并经 scoped 复审关闭。
- 不同内容的权威 reconcile/remote/recovery 在修改 snapshot/pending 元数据前拒绝；完全相同字节和块身份的 ack 可正常闭环。
- 本阶段不支持全语法、CRLF 工作转换、mark/结构/history、多块文件 envelope 或 Source DOM；严格拒绝是试验边界，不能作为最终产品体验。

## 验证证据

| 检查 | 结果与精确范围 |
| --- | --- |
| core 全量 | 22 files / 275 tests；类型与 tsup build 通过，源码与 tracked dist 同一提交 |
| Kit | 原产品提交 8 files / 103 tests；修复覆盖测试两例 RED → 9/9 GREEN |
| 最终宿主全量 | 固定 ace4ddf2：328 files / 4,120 tests，exit0；813 tracked 源文件前后 SHA-256 零变化 |
| 实际浏览器 | Chromium140.0.7339.16；真实 DOM/键盘甲→乙，输出93 UTF-8 bytes，1个 hunk0..5，0 pageErrors |
| 浏览器失败边界 | 语义失败不改变 PM/source/操作数；异稿 ack 保留 pending，同稿 ack 清除 dirty/saving；默认 canonical 行为另有断言 |
| 实际依赖 | core57个dist文件与宿主安装副本逐一 hash 相等；实际浏览器响应 hash 与 URL 已记录 |
| 产物 | core entry gzip45,440 ≤81,920 bytes；最终审查直接把4张 map 的所有 core sourcesContent 绑定到同一提交源码 |
| 构建/检查 | Svelte0errors/33warnings、purity、Vite与Kit build通过；浏览器/构建证据主要对应57a99d0a，ace4ddf2另有定向回归和最终宿主全量，不冒称重跑浏览器 |
| 独立审查 | Task review → fix1 scoped review → 唯一 strongest whole-range review；最终Critical0/Important0 |

无“无警告通过”声明：既有 Svelte、KaTeX、chunk/import 告警保留；最终宿主日志还有 happy-dom 关闭frame后的 AsyncTaskManager destroyed 输出，归因尚未确定，测试全部通过。最终宿主日志 SHA-256：`534c9ca8e0722950dfbe596ad6a179c8e87f1e25957467b1aa48d816b1b5699b`。

## 连续交付与研究

[下一独立计划](../plans/2026-10-13-shared-editor-full-document-source.md) 已自审：整文档原文、多顶层段落局部改字、纯 EOL 投影。完整语法内部编辑、heading/title、格式/结构意图、Rich 来源历史、Source输入与原生菜单、Kit/CDR/桌面出口和 E1–E4 继续后续计划；不重新索取已给出的实施授权。

归档内另有纯研究证据，不属于已实现产品：Rich governed history15项（含两个预期负例）；Source history23项raw断言，原投影匹配策略门槛失败；独立WKWebView菜单原理18项断言，实际Tauri/Wry/系统IME仍未验证；下一计划纯算法13项检查与真实数组身份/重入实验。研究样本进程已退出，没有操作用户Vault。

## 归档与工作区

原始证据：`src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-13/source-mapping-gate-evidence.tar.gz`；139文件，1,168,397bytes，SHA-256 `3a54a0703bb0b9d516c8b800ce445537ac32b8ff01adb2ae7669c4b96194c923`。归档逐文件回读并对照 bytes/SHA 验证；仅排除两份生成的 Vite cache。包含完整报告、失败与成功日志、双仓 diff/完整map patch、哈希、独立审查和研究脚本。

用户要求直接main，不创建branch/worktree；原七个未跟踪项、三个stash和force-pull备份保持。没有 core tag/npm 发布、push 或应用发布；待两端功能完成后按全部未发布更新统一审计发版。仅删除本计划已归档的own workspace与缓存，其他计划和原缓存不动。

## Rulings I made

Ruling: 以最新答复恢复网页与桌面共同交付，先共享内核保真，再分别接入 — 用户明确选择增加共享前置并完成两端，覆盖此前暂缓网页的选择 — 若误解范围，会增加不必要实现成本；保持独立计划便于回退。

Ruling: 先交付普通段落来源映射与文本事务的独立切片，结果通过后连续扩展共享保真和两端计划 — 现有解析器含多阶段token变换，直接冻结通用接口会把未知当事实；小范围真实门槛可否证设计 — 成本是额外计划与审查，若切片失败需重做来源获取，不能据切片通过声称完整I7。

Ruling: 必要共享内核改动在已存在的moraya-core/main执行并单独记录源码与产物，不创建分支/worktree，不运行npm发布或core tag — 用户明确批准共享编辑器前置，该仓是宿主file依赖的实际维护源；此前仅只读限制已由本次授权更新 — 若误改公共行为将影响其他消费者，因此新增显式API、保持canonical合同并以core+宿主双门禁约束。

Ruling: 首个真实Kit门槛使用实际能力选项preserveSource（默认关闭，后续E1接入时启用），不增加仅为fixture服务的pilot参数 — 新能力必须经真实Kit输出验证，同时不能把尚不完整的语法支持切入现有消费者 — 成本是一个增量API选项与严格unsupported边界；完整前置完成前不允许对外宣称通用保真或启用到正式保存。

Ruling: 明确首切片的远端reconcile失败边界，并允许草稿字节相同的ack正常闭环 — 原草稿只规定未知事务拒绝，可能遗漏snapshot/pending元数据先行变化导致来源不一致 — 成本是opt-in能力的显式限制及额外ack回归，后续CDR计划必须解除限制后才能供正式消费者启用。
