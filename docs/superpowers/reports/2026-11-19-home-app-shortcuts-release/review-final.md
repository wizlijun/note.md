# 6.1119.1 宿主发布证据有限复核

复核范围：构建来源、冻结提交和 Apple 公证记录之间的关联。未重建、安装、发布或操作正式 Vault；安装包全量验包与公网回读另行完成后才能据其结果声明通过。

结论：此前关于“逐字证明源码编译为二进制”的 Important 已通过收紧声明边界和补充可信构建证据关闭。可以描述为：冻结源码与验收源码逐字对照，加上受观察的发布构建、输入和 dist 哈希、签名产物与完整嵌入资源见证；不能声称独立可复现构建或仅凭特征字符串证明编译关系。最终包与嵌入资源的具体结论以完成的验包报告为准。

- `build-inputs-candidate.json`、`release-build-prepublish.log` 的实际 SHA-256 分别与 `build-provenance.json` 一致；候选记录的 5446 个受跟踪文件哈希全部匹配当前冻结 clone，207 个 dist 文件和哈希集合完整匹配。`9b4b4272` 到 `c391032e` 的实际差异仅为双语发布日志标题和四个版本号文件。
- 两个 Apple Accepted 日志的提交前归档 SHA-256 分别与捕获记录相同；App submission ID `4f6c1f53-de80-4d51-b42d-00974bb1cf44` 和 DMG submission ID `27f99172-ac9f-45fd-b9cf-a4412d13966b` 均可在冻结构建日志中找到。归档哈希与装订后文件哈希分别记录，不应声称二者相等。实际 CDHash 与票据的绑定仍以验包报告为准。
- 原 Minor 已关闭：来源记录现明确区分 Git 共 5447 个路径与构建时捕获的 5446 个文件，并列出未捕获的普通文档 `docs/2026-07-12-写得更少的时代大纲的价值.md`。独立核对该文件在 pre-bump、冻结提交和当前 clone 中逐字一致；不能将事后核对称为构建时捕获。

本次复核为有限范围静态核对和本地哈希比对；信任已记录的现场构建观察，并不独立证明构建全程或所有外部依赖。

## 整体验包报告一致性复核

`host/artifact-verification.json`、`host/host-assets.json`、`verification/frozen-source.json` 与最新版 `build-provenance.json` 均指向冻结提交 `c391032e80d294c8e941b041e0987e8b9555923f`；验包报告记录的来源文件 SHA-256 与最新版来源文件实际哈希一致。40 个验收源文件的接受版和冻结版哈希均相等。报告有 8 类完整 JS/CSS 特征见证，207 个 dist 文件和 207 个 depfile Brotli 资源证明；源码到产物的边界仍按上述可信构建记录表述。

报告记录签名构建 App、DMG 内 App、updater 中 App 的 7 个文件/链接逐项一致。`codesign -dvvv` 的成功记录给出 App CDHash `f4b5ad8d1e713afa1dffd9144bd7e1a3b1dc138b`、DMG CDHash `38a66d82f504bd0dcb6ef3c3bef2e69d04437541`，分别与 Accepted 票据及独立绑定文件一致；报告的命令均为零退出码。来源记录中的四项打包产物哈希与六附件清单中的对应条目一致。此复核只核对现有报告与关联证据，未重跑验包或重新下载附件。

当时版本尚未公开；匿名公网六附件完整回读和实际 updater endpoint 仍须公开后单独验证，不能提前声称通过。
