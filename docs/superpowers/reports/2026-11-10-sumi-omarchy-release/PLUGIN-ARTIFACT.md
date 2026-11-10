# Sumi 0.1.11 Linux 正式包验收

本报告证明冻结源码的 Linux 插件已完成构建、原身份签名和本地产物验收。此时没有上传 R2，也没有修改市场 KV；宿主正式资产仍由发布负责人补入完整 receipt。

## 来源与构建

- 正式 tag：`v6.1110.2`，源码 `1dc72c9b2f5465c0bb9e94be2cdfcbed597bbee4`。
- `moraya-core`：`f581448bce5e9cf557059f0700297a527069b5ae`。
- Debian 12 / glibc 2.36，实际镜像、工具版本与安全归档哈希见 `plugin-build-inputs.json`、`plugin-build-environment.txt`。
- 在独立容器和缓存中执行冻结源码原有的 `scripts/release-plugins.sh --release sumi`，Cargo jobs=2。联网依赖准备不挂载私钥；签名阶段禁止网络，原私钥仅只读挂载，不进入源码或镜像。
- 容器 Git 元数据仅含原始 commit 对象，重算后匹配冻结 SHA；它供原发布脚本读取来源，不伪造源码提交或挂载宿主 Git 配置。
- 归档与宿主发布脚本的凭据排除规则字节一致，证据见 `archive-filter-equivalence.json`。包内仅含发行内容，无字体二进制。

## 实际产物

产物根目录：`/home/bruce/git/note.md/tasks/sumi-plugin-release-0.1.11/output/`。

| 文件 | SHA256 |
| --- | --- |
| `notemd.sumi/0.1.11/x86_64-unknown-linux-gnu.notemdpkg` | `b5f6347e84e30709eb429a02fbdcb58b9313c4901cea27ce9b832b0eb4a6bbb8` |
| `notemd.sumi/0.1.11/x86_64-unknown-linux-gnu.notemdpkg.minisig` | `7c5e0ad6e533a9b4c674ff961c974996fa5ae085f5393519700b4ac8d5a2665a` |
| 包内 `bin/notemd-sumi` | `d044c31ddac05f654cc5901dde98c0ed7c45bc5f21d579a3b361477db86afecb` |

包大小 2,739,383 字节，共 29 个非目录文件。完整文件清单与哈希在 `plugin-package-receipt.json`。该 receipt 明确标记 `hostReceiptPending: true`，没有虚构宿主资产。正式发布前须加入真实 `host` 资产清单，并相应更新待定标记。

## 已完成验证

- 冻结宿主内的原 minisign 公钥验签成功，包和签名哈希已冻结。
- ELF64 x86_64，可执行权限存在，最高 GLIBC 符号版本为 **2.34**；Debian 12 `ldd -r` 无缺失依赖或未定义符号。
- 14 个声音文件和 10 个字体目录/许可证元数据文件逐字节匹配冻结源码，声音只在 `resources/sounds` 保留一份。
- `tsc --noEmit` 和 Vite 正式构建通过；原发布器的声音、字体资源门禁通过。
- 以 `SUMI_TEST_BINARY=/output/notemd-sumi` 运行冻结源码现有 stdio 集成测试，确实启动与签名包相同的二进制。原子观察、提交后杀进程/重开恢复、私有边界两项通过；一项依赖另行提供旧版本二进制的历史兼容测试按原定义忽略。测试容器无网络、无签名密钥，仅使用隔离临时 Vault。详见 `packaged-stdio-proof.json` 和 `packaged-stdio.log`。
- 原 `scripts/gen-plugin-index.mjs` 访问市场并生成 309 条索引。本次条目只声明 Linux x86_64，最低宿主 `>=6.1110.2`；源码 manifest 继续保留双平台，既有 Mac 0.1.10 包哈希仍在。实际条目与受控发布器构造的条目完全一致。

## 发布交接

完整生成器输出：上述产物根目录的 `generated-index.json`；精确新条目：同目录及本报告目录的 `generated-entry.json`。不得把完整生成器输出直接覆盖 KV：发布器须读取最新 KV，只追加本条目，逐字段保留历史。

负责人将真实宿主资产加入 receipt 后，依 `PLUGIN-PUBLISHING.md` 执行现有 Wrangler 3 / Account API Token 流程：离线检查、对象检查、R2 包/签名上传、匿名回读验签、宿主公开资产门禁、KV 发布及公网复核。`publish-plugin.py` 需要可执行的现有 minisign；本轮工具位于 `tasks/omarchy-build/minisign-tool/usr/bin`，配套动态库位于其 `usr/lib/x86_64-linux-gnu`。

本目录的构建/核验工具和产物证据在冻结 tag 之后提交；它们不改变已冻结源码或已签名包。Fcitx addon 是宿主配套独立发布资产，不在插件 ZIP 内。
