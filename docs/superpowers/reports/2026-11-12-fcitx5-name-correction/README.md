# Fcitx5 for Sumi 名称全面纠正

2026-11-12 用户指出原名误拼后，现行标准名称统一纠正为 **Fcitx5 for Sumi**。宿主代码/发布契约提交 `8a7d9db7` 已推 main，输入法本地产品分支源码提交 `2f561d84463a225f89acd1cf6f9e561c575642da`；对应完整更正补丁为本目录input-method-name-correction.patch.gz（gzip解压后可查看/应用）。输入法origin为上游官方仓库，未向上游推送产品分支。

## 已交付

- 输入法 [0.5.0.15](https://github.com/wizlijun/note.md/releases/tag/fcitx5-v0.5.0.15)：菜单、关于、设置、首次引导、辅助功能说明、备份命名、所有现行品牌资源及安装器/新包文件名已纠正。新pkg为61,312,645字节，SHA256 `f75d72fa51efa50d09412b956453a0f36f59ced8a47f501bab148867f10c4299`。App已Developer ID签名、公证Accepted并装订；pkg本身无Installer签名、未声称pkg已公证。
- Sumi Write 0.1.16已在原市场上架，Apple Silicon与Linux x86_64两包设置提示都使用正确名称。仅3处UI文案、版本和JS文件hash更新，两个已验签原生后台及14声音资源逐文件复用；无需新宿主。
- 宿主后续发布使用fcitx5.json批准、fcitx5-companion.json、新参数--fcitx5-package与FCITX5_PACKAGE_PATH。旧参数/变量仅保留显式兼容别名，不输出错名新产物。
- 五个旧GitHub发行的可变标题/说明已纠正，并指向新版；所有旧tag、附件实际文件名/URL/大小/签名digest保持，逐项API身份核对。宿主latest保持v6.1111.3。没有用修改历史字串伪称旧包内部已改。

## 验证

- 宿主staging/publisher/arm64 194、Sumi110、publisher14通过；输入法Release38目标、隔离CTest15、request10/native repair17/preinstall5和安装状态机通过。所有Swift语言资源语法、UTF16LE/BOM、占位符及重命名键对照通过；12语言既有35缺失键未扩大，正确英文回退已核对。
- 初次CTest缺官方Rime PNG导致icon-cpp失败；在只读临时XDG fixture中加入该测试的官方资源后15/15，未改产品/断言/跳测试，该fixture未进入App或安装包。来源与SHA见ctest-fixture.json。
- 从已公证装订App重建新pkg并展开：636个文件/链接及权限与staging逐项一致，21个实际strings资源无错误显示名，Info.plist/Distribution/安装脚本/source.json/arm64、代码签名、Gatekeeper和装订票据通过。Apple submission `85a89706-8105-4bf4-9c8d-56a145093688`。原始package构建日志在公证前，最终可交付hash及状态以ime-package-verification.json为准。
- 输入法草稿3附件全部回读，公开后3附件从canonical browser URL完整匿名下载，逐段组装及完整SHA/GitHub digest/批准JSON、SHA256SUMS、远端tag前后身份核对通过，无REST后备。
- 插件严格沿Wrangler3.114.17+Account API Token：4个R2对象上传、匿名normal/fresh完整回读验签后，KV仅追加.16双架构一条。索引319→320，旧319条逐字段不变，权威KV与公网普通/新参数一致。

## 兼容与安装边界

Bundle ID、Fcitx5.app、fcitx5词库/配置及窗口位置保持原身份；读取并正确完成旧安装请求，系统修复精确接受新旧两种显示名以兼容缓存。原有两个宿主EOF修改和三个层级子模块patch/hash保持。残留旧拼写仅为这些显式兼容项、历史包/证据和错拼拒绝测试；已更新经验教训。

本次未执行需要管理员权限的系统安装，也未切换本机正在使用的输入法或手动激活新插件。已将正确新包放在 `/Users/bruce/Downloads/Fcitx5-for-Sumi-0.5.0.15-arm64.pkg`；本机输入菜单与插件设置需安装/更新新版后生效，不能把市场公开或包落盘冒称安装完成。

验证脚本按原执行字节归档，原目录为tasks/fcitx5-name-correction-20261112；大包、展开目录和完整公开回读文件保留在原任务目录及Fcitx5-Releases，不纳入Git。

日志归档仅清除ANSI与行末空白并脱敏，原始日志保留在上述本地目录。源补丁按原始字节gzip压缩，防止将unified diff合法空白误作源码空白错误。
