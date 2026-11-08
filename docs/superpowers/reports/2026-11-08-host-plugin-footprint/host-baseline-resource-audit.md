# v6.1107.4 基线宿主资源归属审计

结论：旧约13.5MB安装包不是一批独立插件包的集合。最明确的插件专属素材候选是 **Power Mode 的13个GIF**；Editor Kit、图表/公式渲染和分享编辑器有宿主或多方消费者，不能整体归为某个插件私货。对未做等价拆分构建的部分，不给出“移走可省多少DMG”的承诺。

审计只读冻结tag `v6.1107.4`；源文件字节来自Git对象。实际二进制复核使用root已提取的 `host-cost-audit/notemd-6.1107.4`，20,341,056 bytes，SHA-256 `cc759bc841383498bc5b2a2b2521512dbab59a52574c7e7228b7a2d151d2bdca`；与旧正式产物证据一致。未再次解包、构建、修改源码或发布。

| 项目 | 归属与可证明的量 |
|---|---|
| Power Mode GIF | 特定插件功能的素材，`public/assets/power-mode/**` 共13文件，**173,472原始源码bytes**。其中11个重建Brotli序列在实际旧Mach-O中均仅找到一次，合计**56,604实际内嵌bytes**；另两个lightning GIF未匹配该编码输出，不能说它们不存在，也不能把56,604当全部13文件总量。 |
| Power Mode 引擎/桥 | `src/lib/power-mode/` 非测试源码9文件、23,100 bytes，另有 `src-tauri/src/plugin_runtime/power_mode.rs`。明确绑定 `notemd.power-mode`，未安装/停用时返回null；实际效果执行于主Rich编辑器和Editor Kit。素材可优先随插件交付；引擎要迁移则需宿主扩展接口，不能只把JS挪到隔离插件窗口。源码bytes不等于编译后占用。 |
| Editor Kit v1/v2 | 面向多个插件的共享SDK。旧构建精确入口为v1 JS **3,424B**、v2 JS **27,971B**、CSS **28,370B**；CSS在旧实际Mach-O完整恢复，内嵌Brotli **5,219B**。核心依赖共享，不能把共用chunk全部算给Kit。v1实际消费者包括Idea Spark、Trace Source、Power Mode；v2还被Memory以及宿主file editor/分享路径使用。 |
| 分享编辑器独立资源 | 是宿主项目分享/浏览器导出能力，不是某个安装插件的私有包。旧二进制完整恢复4项：manifest **419B**、standalone JS **488,696B**、CSS **3,680B**、图表IIFE **232,532B**，按offset去重合计 **725,327实际内嵌Brotli bytes**。未来可评估按需分发的共享Web资源，但需保留离线/分享语义；此数不是DMG边际可省量。 |
| Mermaid语言/Pele、Graphviz、KaTeX | 宿主Rich、PDF/HTML、分享等共用。旧默认图表引擎是Pele；`share-editor-mermaid...js`是兼容文件名，已恢复内容含Pele归属声明，不能仅凭名字算成另一个完整Mermaid库。旧build有Pele/Viz/KaTeX chunk及59项KaTeX字体输出；这些字体在前端嵌入资源内，早于Sumi。依赖或接口叫“plugin”不等于仅为一个安装插件服务。 |
| 独立Tauri资源 | 旧tag的 `bundle.resources` 仅 `resources/themes/**/*`：default.css **1,521B**、effie.css **5,412B**，属于宿主主题。root实际归档另有icon **199,574B**，未见独立插件包；详细目录表沿用root的actual-bundle-comparison.json。 |

## Power Mode 是否重复放进 Editor Kit

源实现 `src/lib/power-mode/presets.ts` 以相对URL访问 `/assets/power-mode/` 或 `plugin://…/__host__/assets/power-mode/`，不是给每个Kit构造一份GIF base64。已核的11个压缩文件各有唯一实际字节位置；另外对本次已完整恢复的模块搜索13个GIF的完整base64串，没有发现匹配。

边界：这覆盖旧证据能定位的完整模块，不等于已遍历全部JS资产。两个较大lightning文件的压缩字节暂未定位；本次按要求停止扩展探索，不能声称所有13文件完全无重复或给出完整压缩总量。

## 证据与后续量化边界

- `host-baseline-resource-audit.json`：逐项冻结路径、source bytes/SHA、消费者、旧构建日志行号及分类。
- `host-baseline-embedded-recheck.json`：实际旧二进制13次校验、11个去重片段；完整Brotli解压后的SHA/长度与冻结记录匹配。分享四资源按offset去重725,327B，不与其他重复证据累加。
- `host-baseline-power-gif-check.json`：13原始GIF摘要、11个唯一实际压缩匹配、两个未匹配文件及base64检查边界。
- `host-cost-audit/actual-bundle-comparison.json`：root对实际归档目录与Mach-O section的整体比较，未由本子审计重解包。

编辑器共享模块、图表/公式库、59份KaTeX字体等的进一步可移出体积，需要对同一工具链、同一功能契约做受控对照构建，验证包内资源与行为，再比较实际压缩安装包。不能将源码目录总字节、build日志的rounded kB、Brotli片段长度三者相加后当作DMG节省量。
