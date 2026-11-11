# Smart Lookup 6.1111.3 正式发布

用户要求在运行合并版本供验收后，将改动合入 main 并发布。发布源码已合入并推送 main，冻结 tag `v6.1111.3` 为 `bcc4be833d1b02b6a1e8eb6fa54ae2fb82afaac4`；后续 main 仅追加发布证据。

## 当前状态

用户明确确认 `v6.1111.3 mac-arm64-only` 后，经既有 release-publish 门禁于 2026-11-11 10:12:20 UTC 正式公开，非草稿、非预发布。正式地址：https://github.com/wizlijun/note.md/releases/tag/v6.1111.3 。六附件已完整匿名从 browser 下载地址回读并通过 SHA256、GitHub digest、更新 Minisign、配套包与元数据核对；发布前后资产身份和远端 tag 未变化。实际配置的自动更新 latest 入口也返回与冻结产物逐字相同的6.1111.3，仅 darwin-aarch64。

## 范围与验证

- 本轮新增 Smart Lookup 本地检索、SAG2分轮证据、自动回答及编号引用、逐主机许可和保密门禁、CLI及参数；附已批准 Faitc5 for Sumi 0.5.0.14。保留上一版 Sumi与八组分类，不重发无修改插件/网站。
- 431文件/5883前端测试、Svelte0错误、protocol一致、prod audit无high/critical。Rust检索389、SmartLookup224、参数19、CLI13；3个真实端点探针显式忽略。原发布canvas27/mobile3门禁通过。
- 发布前修复两条插件精确版本断言、macOS临时Vault真实路径fixture及取消测试计时竞争，仅测试改动；不降低断言或修改生产隐私逻辑。提交80fa94bb、eef41cf5、9eb02fa6分别记录日志恢复和两类门禁修正。
- App公证 `9b7c8c04-062a-48e8-9033-1ba394944a6a`；DMG公证 `dd2377d1-a189-412c-9695-e51b784ee62f`，均Accepted。Developer ID签名、staple、Gatekeeper、arm64架构、最终tar更新签名已验证。
- 六件草稿回读与冻结源一致：完整App文件、DMG和updater、真实Mach-O内全部前端资产；SmartLookup四命令、中英自动回答文案、完整ANSWER_SYSTEM和SAG2 CRITERION均在实际二进制内。详见artifact-verification.json。
- 原两处EOF未提交修改及原stash精确保留；未替换用户本机App，未宣称真实模型质量或物理键盘验收。仅Apple Silicon宿主；其他平台历史包保持。Faitc5的App已签名公证，pkg本身无Installer签名，依批准元数据如实附带。

## 公网发布证据

- `public-host-full-browser-verification.json`：六附件整包匿名回读、全部分段组合与SHA256/资产digest、最终tar签名、批准Faitc5元数据、发布及tag前后身份一致。`updater-endpoint-verification.json`：实际latest入口200且740字节逐字匹配。
- 首轮输入法包一个分段长度不足被校验器拒绝；同一canonical地址单段诊断正常，原校验器重试后全部通过，已成功验证分段逐一复核复用。保留首轮失败与诊断记录；未改HTTP/长度/Range/hash门槛，也未改走REST。
- 六件最终资产：DMG 15,832,513字节、updater 15,937,251字节、更新签名416字节、latest740字节、Faitc5 .14包61,310,549字节、配套JSON372字节；精确SHA见host-assets.json。
- 源码与草稿证据提交 `28e3fd99`、脱敏门禁日志 `75a371a9` 已推main。此记录与公网验证随后精确提交，不移动冻结tag，不重打或替换已发布附件。
- 验证脚本按原执行字节归档；原执行目录为 `tasks/smart-lookup-release-20261111`，签名产物、完整回读文件及分段保存在该目录。
