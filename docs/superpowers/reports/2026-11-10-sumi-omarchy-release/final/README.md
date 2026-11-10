# Sumi Omarchy 正式发布结果

2026-11-10 已公开发布宿主 **6.1110.2（Linux x86_64）**、**Sumi 0.1.11** 和配套 Fcitx 候选模块。未在用户系统安装。宿主、插件及 addon 均使用正式产物验收；预览包未作为发布资产。

- [宿主、Omarchy 安装包、候选模块与源码](https://github.com/wizlijun/note.md/releases/tag/v6.1110.2)
- [Sumi 0.1.11 Linux 签名包](https://plugins.notemd.net/api/download/notemd.sumi/0.1.11/x86_64-unknown-linux-gnu)；[签名](https://plugins.notemd.net/api/download/notemd.sumi/0.1.11/x86_64-unknown-linux-gnu.minisig)
- [插件市场索引](https://plugins.notemd.net/api/index.json)
- [Omarchy 官网下载](https://notemd.net/download?os=linux&format=arch&arch=x86_64)

更新宿主后可从插件市场安装 Sumi。内嵌候选另需本 release 的 `fcitx5-sumi-candidates` 包，适用 Arch x86_64、Fcitx >=5.1.23 且 <5.2；它只安装独立模块，不替换 ClassicUI。缺少兼容模块时使用系统候选界面。安装及回退见[说明](../../2026-11-10-sumi-fcitx-candidates/INSTALL.md)。

## 冻结来源与正式字节

产品源码 tag `v6.1110.2` 始终指向 `1dc72c9b2f5465c0bb9e94be2cdfcbed597bbee4`。候选提交 4dd7c501/e226cc86 已包含在 tag；实际 native/host 源码哈希与已验收整合一致。Fcitx 源码为 [d2c14429](https://github.com/wizlijun/fcitx5/commit/d2c1442957f695b3a3bbd9c2aaec0f753c50a591)，公开源码归档逐文件与该提交匹配。

| 产物 | SHA256 |
| --- | --- |
| Debian amd64 | `0ae726211c3059b1bcfc892b904cf29ea50d8790106fedabc6a4a8b87f375976` |
| Omarchy x86_64 | `81dc102b1118fb8bcc1c33434923c59a65c96c58b2d2571cc03eaede3106ae2c` |
| Sumi 0.1.11 | `b5f6347e84e30709eb429a02fbdcb58b9313c4901cea27ce9b832b0eb4a6bbb8` |
| Fcitx d2 addon | `4bbd003599af85b6d2a4a15f0aaa598d973a63983ca58b00ab457f16a19c9314` |

宿主由冻结 git archive、固定 moraya-core `f581448bce5e9cf557059f0700297a527069b5ae` 在 Debian 12 构建。Debian 与 Arch 包内二进制均为 `cccbc48fc8fb52b9c2b158c6cd640c4ac4633e1e0dd3a33c6e281fb6043d82e7`；Arch 保留全部 Debian 文件与权限。原生宿主最大 GLIBC 2.35，插件最大 2.34，实际动态依赖和 CLI 验证通过。

本次范围从脚本默认双架构收敛至用户要求的 Omarchy/x86_64；原双架构协调进程在 amd64 完整验证后停止。未完成的 ARM 依赖预取不计为构建通过，也未伪造 ARM 资产。发布工具提交 `aacb2f7e` 新增显式单架构门禁，配方工具提交 `547e6346` 生成仅 x86_64 的真实配方；产品 tag 未移动、正式包未重编替换。

## 验收与公开发布

- [正式三件套 GUI 验收](../../2026-11-10-sumi-fcitx-formal/README.md)：核对实际运行 host/backend 与包内 SHA、真实 Fcitx addon 映射；两模式候选、无组字蓝底、鼠标选词、精确保存、关闭重开、Unicode 复制粘贴及窄 Writing Tab 通过。正式窗口实测最小宽度为548，不声称达到了请求的400。该轮为隔离 Wayland/GTK/Fcitx 会话；4x、四行及失败草稿等额外回归来自同源码的既有验收，未冒称在正式包上全部重跑。
- 插件使用原有 minisign 身份，包内29文件、声音/字体元数据和实际二进制 stdio 回归通过；[构建证据](../PLUGIN-ARTIFACT.md)。
- 单架构发布器与构建器190项测试通过；Arch配方9项、下载选择33项通过。4个既有 Mac 公证测试依赖 BSD mktemp，在 GNU 环境的限制单独记载，未修改 Mac 生产脚本。
- 宿主由现有 GitHub publisher 的显式 `--linux-amd64-only` 模式公开，实际下载包核对 checksum 后才发布，`latest=false`。公网全部10个 release 资产与本地已验收字节一致，见 [host-public-verification.json](host-public-verification.json)。
- 插件使用仓库既有 Wrangler 3.114.17 + Account Token，按 R2包/签名上传、普通/无缓存匿名回读验签、KV写入、KV及两种公网索引一致的顺序完成。仅新增1条；原308条逐字段保持，最终309条，Mac Sumi0.1.10不变。见 [plugin-publication.json](plugin-publication.json) 和 [index-preservation.json](index-preservation.json)。
- 官网普通请求已确认 x86_64 Arch/Deb 指向6.1110.2，ARM64 Arch/Deb保留6.1027.1；GitHub latest仍为Mac6.1110.1。短暂旧跳转与fallback已自然恢复，未为此修改或部署网站。见 [website-redirects.json](website-redirects.json)。

临时GUI进程与rootless Docker已停止；用户原上传密钥保留，任务中的密钥/Token工作副本已删除。构建缓存、产物及验证证据保留。所有发布资产清单、签名证明和来源详见本目录JSON记录。
