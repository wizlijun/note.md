# 共享文件编辑器：源码、身份与历史验证

2026-10-14。源码前置阶段已受理；网页 E1–E3、桌面离线 E4、统一发行仍需继续。本报告不表示全平台验收或已发布。

## 冻结范围

| 仓库 | 阶段 BASE | 最终产品 HEAD |
| --- | --- | --- |
| moraya-core | `d0807fa278bd4cdf1724435c4262a6295b64d61e` | `6a6d0f940383c1e2cd19dc3c9c3df8f63e69baff` |
| mdeditor | `40604da627de4fbfb3e1187bdfbba1a4d0d7272f` | `8a0b555ca6a0e8df226700fc74f67ffa64f3925e` |

沿用现有 main，无新分支/worktree。实际 HOST installed CORE 与上述提交的64个 dist 文件逐字节一致；公开JS出口、声明、maps/source、锁及两仓各14份原始 corpus/manifest 均已核对。

已交付：真实原 Step/docs 的源码准入、稳定 bindings、同一 Rich/Source 原生历史、Source 换行投影和失败草稿、共享批注生命周期、布局撤销、实际 owner/mount、耐久恢复与精确保存回执、原生菜单 epoch 路由，以及桌面原有图片入口的保真兼容。原生 API 编译或 mock 的证据范围与实机验收分开记录。

## 独立审查与最终修复

Task1–5 均经独立规格/质量审查。唯一全阶段审查提出 C0/I1/M3；随后一次合并修补和一次 scoped 复审，I1/M1/M2 全部 ADDRESSED，无新破坏：

- Rich composition 开始立即取消在途表格宽度预览；组合及结束收尾窗口内禁止新手势/提交。正常组合文字原始事务继续准入，结束后恢复 resize。
- colwidth 负例改用真实 doc/table/row/cell，并增加同结构 null 正向控制。
- recovery 浏览器 gate 明确要求 pageErrors 为空。

最终修补提交 `8a0b555c`，精确5文件。原实际 RED（generation0→1、undoDepth1、width110px）保留；同一 probe 修后 generation不变、undoDepth0、width空。没有用合成事件宣称系统 IME 已验证。

## 验证及准确输入

| 验证 | 结果和范围 |
| --- | --- |
| CORE 最终完整套件 | 63 files / 1495 tests，最终6a6d源/dist；strict/type/build通过 |
| HOST 完整基线 | 361 files / 4660 tests，Task5产品01f2及文档395b；不是最终修补后的重新全量 |
| 最终修补覆盖 | 19 files / 276 tests、累计严格类型检查、原 reviewer probe、新 composition RED→GREEN，通过 |
| ROOT 最终 I7 | 29/29；真实 factory、14原fixtures三次切换零diff、按原raw索引改一字且实际propose单hunk、nested位置/跨模式历史 |
| 最终 Svelte | 0 errors / 33 warnings / 16 files；告警完整保留 |
| Chromium | mount15、resize9、recovery1 cases通过，pageErrors均空；原图片HTTP SVG120×60渲染与历史证据保留 |
| Rust | Task4 focused4、offline locked check/build通过；后续未改Rust，不外推系统菜单实机 |
| 最终实际构建 | 空env应用、Kit导出/CSS检查、静态HTTP真实built factory、三次切换零diff/history空通过；ROOT已目视截图 |
| 最终输入指纹 | CORE241/HOST1025 tracked 输入前后相同，摘要 `3fdde6c55aa47d59a862f2f81f64ae21ac6f59ef234d21693b7d51ab5778f60c` |

CORE主入口 Node 默认 gzip104293 bytes，门槛104448；分享主 IIFE 的900KiB为后继独立门槛，尚未实测。最终应用172 JS，raw9620862、逐chunk默认gzip总和3182800；相对阶段BASE增加138462 raw/46063 gzip。总chunk数据不作为IIFE预算证明。

实际命令、cwd、stdout/stderr、退出码和工具生命周期保存在下列归档中。所有预期功能RED与工具/夹具错误分列保留；包括I7首次ESM解析工具错误、ROOT首次以python运行shell review-package的解释器错误。没有删除失败后声称从未失败，也没有把recorder的包装exit0当作产品RED通过。

## 待验与保留项

- 用户于2026-10-14明确：**暂时没有移动设备，保留移动端待验记录**。iOS Safari、Android Chrome 的真实中文/日文 IME，含列表/表格、候选操作、保存与撤销，保持未实机；不再重复询问，不停止独立实现。
- macOS Safari/Chrome系统中日IME、系统菜单/dialog/clipboard/drop、外部文件IO和ImageToolbar真实点击仍未验。此前三次CUA库存为Sky native pipe失败；headless、合成事件、编译及API mock不能替代。
- M3既有Svelte/a11y/CSS、KaTeX quirks、happy-dom资源/清理、Vite chunk/import告警保留，不关规则或捆绑无关清理。
- 网页富文本协作、收到项目的离线协作、真正IIFE、免费Worker CPU遗留及宿主/插件/Worker统一发行尚未完成。

## 归档及继续执行

规范归档：`src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-14/file-bindings-history/file-bindings-history-evidence.tar.gz`。

- 大小114151910 bytes；SHA256 `739d46805134553210d54fd5daf36cfb26ecdd5ac1bfcdc4211a690e551a567e`。
- manifest SHA256 `5c8e88104bda0f1caa12e23f2bd228375eb20901730e20253b8c1581e4f69549`。
- 34718份普通文件、34719个归档成员逐项回读SHA验证；不跟随符号链接，不收凭据、依赖或可重建cache。
- 后继所需39份输入按归档manifest精确回读后转交新的 delivery OWN；原前置OWN只在归档及正式记录完成后精确清理，不碰其他任务。

本阶段裁定按账本原顺序完整保存在[裁定记录](2026-10-14-file-bindings-history-rulings.md)，含被后续更正取代的原决定及代价。后继计划消费已受理接口，不再实现第二套编辑器或保存回执。发行必须继续盘点并包含所有未发布更新，不能以这些本地提交代替发行源码、正式产物和线上状态核验。
