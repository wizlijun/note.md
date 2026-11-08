# 轻量宿主与插件后台迁移发布记录

宿主 **note.md 6.1108.5** 已公开，范围为 Apple Silicon macOS，Sumi 原生编辑要求 macOS 13+。[正式 Release](https://github.com/wizlijun/note.md/releases/tag/v6.1108.5)不是草稿或预发布。**Sumi 0.1.4 与 Power Mode 1.0.4 已发布到插件市场**，包、签名及公开索引均已核验。两插件要求宿主 `>=6.1108.5`，应先升级并重启宿主，再更新插件。

## 冻结源码与交付内容

宿主 tag `v6.1108.5` 固定在 `02099d206a583400a89ac360bf8f3c0e61acaf14`；宿主集成提交为 `ceac9917369a2e9a91a43ecf5b6f937110f68efd`。插件打包源为 `08ebf73b0768c1e2154194103576c46b4e4936d0`，签名后台编译源为 `c9e32dad525fa5e4d608cf04877ce4b636a7434a`。[最终 tag 审计](2026-11-08-plugin-payload-extraction/final-tag-requirements-audit.json)确认 98 项冻结源码摘要、81 项后台编译输入与最终 tag 一致，两插件源码从打包源到最终 tag 无漂移；实际 ZIP 逐文件清单、manifest 和签名均匹配。

- Power Mode 的 13 个 GIF 随插件提供，宿主保留效果挂载和受限资源接口；缺失、停用或旧版插件没有素材时，不回退加载宿主内置副本。
- Sumi 的 SQLite/WAL、Markdown 投影、持久收据、同步协调/网络及字体下载移入原生插件后台。宿主保留即时内存 CRDT、AppKit 编辑/IME、窗口与 Tab 生命周期，以及 Keychain 和短期令牌窄代理。长期密钥不发送给插件后台。
- 两端使用独立宿主服务请求；普通插件 UI 不能伪造后台绑定。保存确认区分数据库提交和 Markdown 投影，崩溃后按稳定操作身份重放；停用/升级先停入站与排空，再保存最终快照。撤权后的只读交接不再依赖已停止的后台，重新启用恢复授权工作区。
- 字体目录保留最终六组：Plex Mono Light + Plex Sans SC Light、独立 LXGW WenKai Mono Lite、朝华打字机、油茶馓子体、朱雀仿宋，以及「复古绿磷 CRT」的独立 GNU Unifont。七个字体文件均按需后台下载；首次离线使用系统字体，查看设置不会隐式下载。
- 保留四秒一轮的竖线呼吸、常亮及 IME 系统细线抑制；设置面板的组字交接、随字号调整留白、Markdown 复制与文本化粘贴均按冻结源码核对。剪贴板是既有已公开能力，本次双语发布说明只列七条实际新增/修复。

## 实际体积与资源归属

| 产物 | 字节数 | 十进制大小 |
|---|---:|---:|
| 宿主 DMG | 14,175,207 | 14.18 MB |
| 宿主 updater | 14,244,585 | 14.24 MB |
| 公证后 App 文件总和 | 22,017,421 | 22.02 MB |
| 宿主 Mach-O | 21,803,536 | 21.80 MB |
| Sumi 0.1.4 插件包 | 2,302,043 | 2.30 MB |
| Power Mode 1.0.4 插件包 | 169,730 | 169.73 KB |
| Sumi 签名后台原始程序 | 3,788,048 | 3.79 MB |

相较未公开的 6.1108.4 候选，DMG 减少 **271,468 字节**，Mach-O 减少 **330,608 字节**。相较旧 6.1107.4 的 13,505,710 字节 DMG，当前仍多 **669,497 字节**；不把后台程序的 3.79 MB 当作宿主减量。曾内置字体的公开 6.1108.2 DMG 为 70,215,286 字节，本次按需字体与业务拆分后减少 56,040,079 字节。

[实际产物检查](2026-11-08-plugin-payload-extraction/artifact-verification.json)核验宿主 Mach-O 内嵌资源与冻结构建输入：13 GIF 及 Sumi 专属目录已迁出；插件实际包含对应资源，无 Sumi 大字体文件。宿主仍包含共享渲染、旧 KaTeX 字体和共享依赖，不能把“无 Sumi 字体”说成“没有任何字体”。宿主正常依赖图没有 `notemd-sumi-backend` 或 `tokio-tungstenite`；SQLite、write-core、通用 HTTP 等仍有宿主消费者。

## 验证证据及边界

[测试摘要](2026-11-08-plugin-payload-extraction/test-summary.json)保留具体日志摘要与 SHA：正式发布前端 425 套件 / 5,507 项通过；Svelte 0 错误、31 项既有警告；宿主 Sumi 集成 64 通过 / 2 忽略、插件运行时 333、进程测试 16、认证测试 8 均通过。被过滤或忽略的测试没有计为已执行；签名后台与本地 Worker 场景另有明确执行证据。

- [真实签名后台](2026-11-08-plugin-payload-extraction/native-process-probe.json)：隔离环境中实际启动最终签名程序，验证提交事件、丢响应后强杀与重放、同操作不同内容拒绝、请求身份/所有权边界及退出释放。另有宿主真实进程代理测试覆盖保存、重绑定和空返回值处理。
- [本地 Worker](2026-11-08-plugin-payload-extraction/loopback-verification.json)：既有 Wrangler 3.114.17 启动真实 loopback Worker，两项显式执行、无跳过；验证在线增量、双方断线并发编辑、重连合并、重复提交与逐行首次/末次时间收敛。这是传输与内核验证，不冒充正式 CF 容量或完整原生 UI 协调器验收，未升级付费套餐。
- [原生探针](2026-11-08-plugin-payload-extraction/native-regression.json)：六类真实 AppKit 离屏探针覆盖四秒呈现层变化、常亮/markedText 像素、面板交接、快捷键/剪贴板及 system/CRT 留白案例。没有把离屏结果称为最终 DMG 的物理键入或完整安装后 UI 验收。
- 后台 Developer ID 签名为 `T5G56DH47L`，Apple 提交 `7a26a1ae-bbe1-4415-bef2-e10d7e4e61f8` 为 Accepted，CDHash 与包内程序一致。裸 CLI 的 `spctl` 返回“valid code but does not seem to be an app”已原样保留，不改写成通过；公证绑定及真实独立进程测试另行验证。
- 其他平台、定制输入法、VoiceOver、完整物理输入呈现性能矩阵及生产容量仍按主 spec 保留为后续范围。本次没有替换用户已安装应用或修改正式 Vault。

## 发布与公网证明

[宿主发布记录](2026-11-08-plugin-payload-extraction/host-publication.json)确认原 `release.sh` 构建与 `release-publish.sh v6.1108.5 --mac-arm64-only` 发布流程完成。App 公证 `5cd20543-9ef9-4f37-ab3c-9e9692f5fe1f`、DMG 公证 `b4b05dd8-7ad0-4a10-879e-67e32c58ef45` 均 Accepted，签名、stapler、Gatekeeper、updater 签名及 DMG/updater 内 App 一致性通过。

[公开前四文件完整回读](2026-11-08-plugin-payload-extraction/draft-assets-verification.json)逐字节计算 SHA-256，与本地及 GitHub 摘要相符。公开后，[普通下载入口](2026-11-08-plugin-payload-extraction/public-host-verification.json)与[官方 REST 入口](2026-11-08-plugin-payload-extraction/public-host-api-verification.json)均匿名通过：同一 tag 与四个资产身份保持不变；清单和签名全量下载，大文件首尾各 64 KiB 与此前完整文件匹配，公开签名对完整 updater 验证通过。没有把匿名范围抽样称为匿名全量大文件下载，也未执行应用内自动更新 UI。

| 文件 | SHA-256 |
|---|---|
| DMG | `c954f952a4fc874d9f5bfe91595b92f899b1b2ca245012c10308d2f3ff8e2576` |
| updater | `1a18ab775af46bf81f9068a0797a0f9cb8f149e3d322004ab89066e56ae2545d` |
| Sumi 0.1.4 | `84df4e2ef3ee0cdf48ab3d5d1927c0d8134dbd90db868ec56c1e4ebabc025ae1` |
| Power Mode 1.0.4 | `2def9dcecbc7e8accf7471f37720d34181aad455341850c6332b4ba8024852aa` |

插件市场发布沿用既有 Wrangler 3 与 Account API Token。两个包要求宿主 `>=6.1108.5`，Sumi 后台仅发布 arm64 macOS 架构。R2 包与签名的[独立八次完整回读](2026-11-08-plugin-payload-extraction/plugins-parallel-public-packages.json)及四次 Minisign 均通过；原发布脚本再次全量验签后写入索引，[最终 KV/普通/fresh 索引复核](2026-11-08-plugin-payload-extraction/plugins-index-verification.json)全部一致，只追加上述两个版本，原 300 条逐项保留，总计 302 条。旧候选 Sumi 0.1.2/0.1.3 未上架。 [发布后独立复核](2026-11-08-plugin-payload-extraction/plugins-market-independent-verification.json)再次确认三份索引、两条版本/最低宿主/SHA/下载地址与冻结包一致；此复核重验的是发布前已完整下载的本地包证据，没有再次网络下载大包。[完整发布摘要](2026-11-08-plugin-payload-extraction/plugins-publication-summary.json)记录原脚本和独立复核均退出0。上传失败与逐对象回读恢复保留在[暂存记录](2026-11-08-plugin-payload-extraction/r2-stage-summary.json)，没有用 CLI 的 Writing/Upload complete 文案替代远端落盘验证，也未更换 Wrangler 或上传通道。

## 范围保全与回顾

[冻结范围审计](2026-11-08-plugin-payload-extraction/scope-audit.json)枚举六个仓库的 worktree、分支、未提交文件及 stash。两个原有 EOF 改动 `searchidx/src/store.rs` 与 `src-tauri/src/smart_lookup.rs` 未纳入发布；旧候选 6.1108.3/4 与插件 0.1.2/3 不公开或改写。双语七条发布说明保留在冻结 tag；其余各二十条待发布记录经幂等校验恢复，提交 `59999adc`，未冒充本次发布内容。

全部宿主测试结束后仅清理四个可再生成 debug 缓存目录，回收约 **13.17 GiB**；[清理记录](2026-11-08-plugin-payload-extraction/debug-cleanup.json)保留范围，隔离 Acceptance 应用、旧/新签名包、下载回读与构建来源证据均保全。
