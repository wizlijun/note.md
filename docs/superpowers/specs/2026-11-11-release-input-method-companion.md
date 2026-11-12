# macOS 发布附带 Fcitx5 安装包

用户要求所有 macOS 发布附带最后批准的改造输入法。本轮更正包为 Fcitx5 for Sumi 0.5.0.15，保留独立版本，不将输入法加入 note.md 自动更新载荷。

- `scripts/release-companions/fcitx5.json` 保存批准版本、平台、规范文件名、字节数、SHA256、输入法源码提交及签名状态。后续输入法更新须同步此文件，不能靠目录修改时间猜“最新版”。
- `release.sh` 从 `--fcitx5-package`、`FCITX5_PACKAGE_PATH` 或 Downloads 中的批准文件名读取安装包。构建前检查精确字节，独立暂存，缺失或不符即停止；draft 自动上传 pkg 和 `fcitx5-companion.json`。
- publisher 对全部含 macOS 的发布强制要求这两个附件，下载并核对元数据与仓库批准值、实际包大小和摘要，拒绝额外 pkg。Linux-only 发布继续使用原有独立门禁。
- 发布说明区分 App 已签名公证与 pkg 自身签名状态；本轮 pkg 未签名，不将校验和称为签名或公证。
- 首次批准包已通过展开内容、App 签名/公证与资源核验。发布脚本按已批准完整包摘要绑定，不能将任意同名包放行。

验证：错误字节、错文件名、重复暂存、缺包/错版本/篡改批准元数据/多余 pkg 拒绝；正常发布允许且 updater manifest 无 pkg。使用真实 0.5.0.13 重新暂存后，与已验收包的摘要完全一致。

旧命令参数 `--faitc5-package` 和环境变量 `FAITC5_PACKAGE_PATH` 仅作为显式兼容别名读取，新文档及输出统一 `fcitx5`。旧版0.5.0.13/.14附件和批准记录由其冻结tag解释，不改写原始包名或签名；新批准JSON必须来自内部显示名已更正的新包。
