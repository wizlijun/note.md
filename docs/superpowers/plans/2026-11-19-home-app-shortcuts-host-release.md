# 首页快捷方式宿主发布计划

用户已要求发布并确认仅macOS Apple Silicon；目标6.1119.1。沿用既有发布脚本、签名、公证和批准companion。

- [x] 枚举registered worktrees、本地分支未合入提交、stash三父树与独立clone；核实旧合并历史的源码等价及排除项。
- [ ] 将已验证首页提交精确合入main并推送，保留两处EOF与output；将干净发布clone快进到相同源码。
- [ ] 复用批准依赖/配套包和release缓存，运行原release.sh 6.1119.1 --arm64-only；全部原门禁、签名、公证通过后生成草稿和冻结tag。
- [ ] 用冻结tag与实际签名App/DMG/updater核实首页资源、架构、权限、签名及源文件绑定。
- [ ] 原发布器最后人工确认平台省略范围，再公开；匿名完整回读六附件与真实updater入口。
- [ ] 提交发布证据，快进主工作区并记录版本、tag、源提交和下载链接。

不发布市场插件，不运行/安装App到正式Vault；没有硬件显示测量时不作此类声明。完整范围见对应release/scope-audit.md。
