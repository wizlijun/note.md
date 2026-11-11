# Smart Lookup 6.1111.3 发布候选

用户要求在运行合并版本供验收后，将改动合入 main 并发布。main 与远端已同步至冻结 tag `v6.1111.3`（`bcc4be833d1b02b6a1e8eb6fa54ae2fb82afaac4`）。

## 当前状态

签名、公证、构建门禁与六件草稿附件验证已完成；尚未公开。既有 `release-publish-core.mjs` 对省略其他平台明确要求交互确认，目前等待用户确认 `v6.1111.3 mac-arm64-only`。不能把此候选记录称为正式发布证据。

## 范围与验证

- 本轮新增 Smart Lookup 本地检索、SAG2分轮证据、自动回答及编号引用、逐主机许可和保密门禁、CLI及参数；附已批准 Faitc5 for Sumi 0.5.0.14。保留上一版 Sumi与八组分类，不重发无修改插件/网站。
- 431文件/5883前端测试、Svelte0错误、protocol一致、prod audit无high/critical。Rust检索389、SmartLookup224、参数19、CLI13；3个真实端点探针显式忽略。原发布canvas27/mobile3门禁通过。
- 发布前修复两条插件精确版本断言、macOS临时Vault真实路径fixture及取消测试计时竞争，仅测试改动；不降低断言或修改生产隐私逻辑。提交80fa94bb、eef41cf5、9eb02fa6分别记录日志恢复和两类门禁修正。
- App公证 `9b7c8c04-062a-48e8-9033-1ba394944a6a`；DMG公证 `dd2377d1-a189-412c-9695-e51b784ee62f`，均Accepted。Developer ID签名、staple、Gatekeeper、arm64架构、最终tar更新签名已验证。
- 六件草稿回读与冻结源一致：完整App文件、DMG和updater、真实Mach-O内全部前端资产；SmartLookup四命令、中英自动回答文案、完整ANSWER_SYSTEM和SAG2 CRITERION均在实际二进制内。详见artifact-verification.json。
- 原两处EOF未提交修改及原stash精确保留；未替换用户本机App，未宣称真实模型质量或物理键盘验收。仅Apple Silicon宿主；其他平台历史包保持。Faitc5的App已签名公证，pkg本身无Installer签名，依批准元数据如实附带。

最终公开后须补完整匿名六附件browser回读、SHA256/更新签名、实际updater入口和远端tag身份复核。
