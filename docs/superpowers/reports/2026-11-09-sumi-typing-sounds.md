# Sumi Typewriter 打字音效发布与验收证据

宿主 **[note.md 6.1108.6](https://github.com/wizlijun/note.md/releases/tag/v6.1108.6)** 与插件市场 **Sumi 0.1.5** 已发布（Apple Silicon macOS）。本轮包含复古蓝磷 CRT、英文 **Sumi Typewriter**／中文「玄霜打字机」／日文「すみ」的本地化，以及两套键盘音效。插件要求宿主 `>=6.1108.6`，默认开启、默认 Typewriter，可切换 Thock；仅在 Sumi 原生正文获得输入焦点时生效。

冻结 tag `v6.1108.6` 指向 `b38dc722e6ab0e455147b07c39a972da297a9242`；功能源码为 `ec4fdcc691223f211249cf685cf3641f6e7bc157`，前序本地化为 `f27144529bdb812f2712bbd79d680d6db8c3a0d9`。已核对最终 tag 中 130 个源码文件、100 个原生后台构建输入及三项需求的 28 个源码锚点，实际宿主与插件包一致。[冻结源码和产物审计](2026-11-09-sumi-typing-sounds/final-tag-audit.json)

| 已发布产物 | 实际字节数 | SHA-256 |
|---|---:|---|
| 宿主 DMG | 14,207,586 | `9b658ffb138569ef14d46b63ffe9fd9c4918e1e24a74c52fb729dbf28cb04718` |
| Sumi 插件包 | 2,459,159 | `aacda8be58893058ec251b6c21d0c24f86c64b75de7cc0a8655a24ac81840ff3` |

DMG 比 6.1108.5 增加 32,379 字节；12 个 WAV、音频引擎业务及既有后台均在插件中，Sumi 大字体仍按需下载。Power Mode 保持 1.0.4，本轮没有重新发布。

## 实施范围

- 插件提供 `typewriter` 和 `thock` 两套音色。开关与音色通过独立的 `sound_state`、`sound_set` 接口管理，不修改字体、主题、正文或逐行时间。关闭声音时切换音色不会打开声音；加载设置不主动请求权限或播放样本。
- 输入侧按物理键事件分类，处理自动重复、修饰键与松键。宿主检查当前编辑面、焦点、生命周期及会话身份；队列和后端请求有过期限制，关闭或停止使旧事件失效。音频请求传角色和受控会话标识，不传正文。
- 插件后台负责资源校验、解码和 `AVAudioEngine` 播放；原生输入监控及编辑面判断留在宿主。界面提供中英日提示、失败重试及单独的权限操作。
- 音效只进入插件包的 `resources/sounds/`。Vite 产物中的 `sounds/` 在校验后移入该位置，不再保留 `ui/sounds/` 副本；既有按需字体门禁保留。最终宿主 Mach-O／嵌入资源与插件成品均已核验，宿主无这两套音效资源。

## 资源与角色

用户指定的 `project/sumi/sounds` 内共 12 个普通 WAV 文件，已原样复制；未从 TapNoise 安装包批量提取资源。全部为 **48,000 Hz、单声道、16 位 PCM**。

| 音色 | 文件数 | 音频字节数 | 角色 |
|---|---:|---:|---|
| `typewriter` | 5 | 94,588 | 普通键、空格、回车、删除、修饰键；无松键样本 |
| `thock` | 7 | 38,996 | 上述五类，加 release 与 click；release 同时供 `keyUp`、`spaceUp` 使用 |
| 合计 | 12 | **133,584** | 约 133.6 KB，未含两个 JSON 清单 |

`typewriter` 不用按下音伪造松键音。`thock` 的 click 文件保留在目录和清单中，不代表本轮增加了鼠标音效功能。文件 SHA、帧数、大小及角色以插件 [manifest](../../../plugins-src/write/resources/sounds/manifest.json) 为准，来源说明见 [provenance](../../../plugins-src/write/resources/sounds/provenance.json) 与 [资源摘要](2026-11-09-sumi-typing-sounds/resource-summary.json)。

用户提供的 12 个文件与本机 TapNoise 同名资源字节相同；这是来源核对事实，不是授权证明。用户提供目录未附许可证或署名文件，清单如实记录，未推断版权归属或补写不存在的许可证。

## 验证结果及实际边界

以下数字来自保存的日志或探针记录，包含既有回归用例，不表示全部是本轮新增测试。

| 验证层 | 记录结果 | 已证明的范围 |
|---|---|---|
| 资源与打包门禁 | 20 项通过 | 精确清单、SHA、WAV 参数、来源比对；缺失、多余、篡改、符号链接与错误角色拒绝；实际打包资源片段及资源专用 ZIP 全读校验 |
| 插件设置 UI | 85 项通过；类型检查、构建通过 | 三语、开关与音色独立、请求串行、关闭面板后迟到响应防护、失败重试；使用测试 RPC，不等于实际原生音频验收 |
| 原生 AppKit 探针 | 5 项编译、运行通过 | 输入角色、重复和修饰键、隐藏窗口真实 responder 树；语言、快捷键、面板交接、剪贴板回归；前台条件采用模拟，组字状态由探针设置 |
| 原生桥接 Rust | 5 项通过 | 数据契约及既有外观/语言回归；不是系统授权测试 |
| 后台 Rust | 91 项通过、2 项 ignored；另 stdio 集成 1 项通过 | 包含真实音频解码、手动离线渲染、重叠调度、停止静音、缺失松键样本及会话/过期限制；ignored 项不计通过 |
| 宿主 Sumi 筛选测试 | 71 项通过、2 项 ignored | 保存/恢复与音效会话、焦点、代际、队列停止、过期边界等回归；不是完整宿主全量测试 |
| 宿主插件运行时筛选测试 | 333 项通过 | 共享插件运行时回归，不代表最终安装包的物理键盘/TCC验收 |
| 发布辅助脚本 | 28 + 10 + 7 项通过 | 离线发布状态机、最终 source 绑定、音效路径映射及既有宿主校验器等价/语法；此行仅说明辅助脚本测试；实际上传和包验签另见下方发布证据 |

对应证据：[资源门禁](2026-11-09-sumi-typing-sounds/resource-gates.json)、[UI](2026-11-09-sumi-typing-sounds/ui-sound.json)、[原生探针](2026-11-09-sumi-typing-sounds/native-probes.json)、[Rust 日志摘要](2026-11-09-sumi-typing-sounds/rust-test-summary.json)、[发布脚本审计](2026-11-09-sumi-typing-sounds/release-helper-audit.json)。原始大日志仍留在任务目录，摘要保留其 SHA，不重复提交日志或音频。

另用生产 C 音频接口为两套音色启动并停止了真实输出引擎：设备输出格式为 **48 kHz、双声道**，两套均 ready，**scheduled=0**，没有向扬声器提交样本。Stop 与对象释放检查通过。这证明当前机器可初始化输出设备，不能证明实际听感或按键到扬声器的延迟。初版探针在 autorelease pool 排空前检查释放而失败，修正探针后通过，未因此修改生产音频代码。[实时静音探针](2026-11-09-sumi-typing-sounds/realtime-silent.json)

离线渲染则实际解码并调度样本，观察非零渲染峰值、连续按键的调度结果和停止后的静音；`typewriter` 松键无声、`thock` 松键有样本的断言均通过。这里的离线音频输出与上面的“真实设备初始化但不提交样本”是两项不同验证，不能合称已完成实际打字试听。

## 最终构建与发布证据

- 正式宿主构建的前端 **425 个测试套件、5,516 项测试通过**；Svelte 检查 0 错误、31 项既有警告。最终宿主锁文件指向插件后台 0.1.5，重新执行宿主 Sumi 测试为 71 通过、2 项明确忽略。[最终源码测试](2026-11-09-sumi-typing-sounds/final-source-tests.json)、[最终锁文件测试](2026-11-09-sumi-typing-sounds/final-host-lockfile-tests.json)
- 宿主 App、DMG 和插件原生后台均完成 Developer ID 签名与 Apple 公证；App／DMG 已 stapled。实际签名插件包解包后的 stdio 崩溃重放通过，两套音色真实输出引擎初始化通过，未调度扬声器样本。[实际产物](2026-11-09-sumi-typing-sounds/host-artifacts.json)、[插件包](2026-11-09-sumi-typing-sounds/plugin-package.json)、[签名后台进程](2026-11-09-sumi-typing-sounds/signed-plugin-process.json)
- GitHub 草稿四个资产已完整下载并核 SHA；正式发布后用匿名普通入口与 REST 核公开资产身份、清单、签名和范围字节，并确认实际配置的 `releases/latest/download/latest.json` 返回 6.1108.6。公开后未重复全量下载大文件。[草稿全读](2026-11-09-sumi-typing-sounds/host-draft-full-download.json)、[公开核验](2026-11-09-sumi-typing-sounds/host-public.json)、[更新入口](2026-11-09-sumi-typing-sounds/host-updater-endpoints.json)
- 插件沿用仓库 Wrangler **3.114.17** 和 Account API Token：R2 包／签名上传，普通及 fresh 匿名完整回读并验 Minisign，再追加 KV 索引。市场 **302→303**，仅新增 `notemd.sumi@0.1.5`；历史条目不变，KV／普通公网／fresh 公网一致。独立发布后审查再次核索引与本地冻结包；完整公网包下载发生在索引发布前。[R2 独立全读](2026-11-09-sumi-typing-sounds/r2-independent.json)、[市场写入](2026-11-09-sumi-typing-sounds/market-publication.json)、[市场独立复核](2026-11-09-sumi-typing-sounds/market-final.json)
- 发布前已盘点六个仓库及其 worktree、分支与 stash，最终文档提交前再次[复核范围](2026-11-09-sumi-typing-sounds/release-scope.json)：两处既有 EOF 改动排除，外部 Omarchy 未合入提交排除，stash 为空。三条本轮更新说明进入冻结 tag，20 条延期说明在发布后由 `7c2a17ae` 恢复。测试完成后仅清理本轮隔离构建的可重建缓存，回收 **13,724,942,336 字节**，14 个正式产物摘要不变。[缓存清理证据](2026-11-09-sumi-typing-sounds/generated-cache-cleanup.json)

## 验收边界

本轮没有安装真实 event tap、请求系统授权或修改 TCC；没有用物理键盘和真实中文输入法完成按键到扬声器的端到端试听。安全输入框、实际权限变化、物理窗口焦点切换及设备恢复仍需在最终签名宿主上验证。离屏 AppKit／离线音频／真实设备静音初始化的通过，不冒充这部分实机验收。

默认开启仅代表应用偏好。首次尚未获得 Input Monitoring 权限时，设置显示权限要求；用户需在 macOS 系统授权，正文编辑继续正常工作。本轮未替换用户已安装的应用、未修改正式 Vault，也不把发布等同用户已经安装更新。其他平台、VoiceOver、完整物理性能矩阵和云端容量仍按主 spec 保留。

两份早期 Rust 输入快照早于 Configure deadline 补充，作为历史观察保留；后续最终源码测试、最终锁文件测试及冻结 tag 审计完成了最终来源绑定，不能反向将旧快照改成最终源码。[源码边界与最终补充](2026-11-09-sumi-typing-sounds/source-boundary.json)

证据文件及 SHA 索引：[evidence-index.json](2026-11-09-sumi-typing-sounds/evidence-index.json)。
