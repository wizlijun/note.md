# 八组分类发布独立公网审计

## 宿主

- 正式 v6.1111.2，冻结源码 c4d39ddff04296f66ec80ae72459bb9c8ce2d15f。
- 官方 GitHub browser 下载 URL，六个附件全部匿名完整回读成功；无下载失败，无 REST 备用。大文件取所有连续区间后重组，对整文件核 SHA-256 与字节数，不是抽样。
- 六文件与本地冻结 host-assets.json 以及 GitHub digest 一致；开始和结束的远端 tag、asset ID/size/digest/state 均未变化。
- 对匿名下载的整个 updater tar 验证 minisign，latest.json 内签名、版本及官方 URL 一致。
- Faitc5 .13 安装包完整 hash/bytes 与冻结源码 approved companion 相同，approval JSON 逐字段一致。输入法 App 的公证不等于 pkg 签名；本轮不改变其原有 unsigned pkg 状态。
- 此审计不安装或替换用户 App，不声明 GUI/物理键盘验收。

运行脚本：tasks/writing-host-release-20261111/verify-public-host-full.py（10项离线回归）。原始匿名下载与每段回读证据保留在 tasks/writing-host-release-20261111/host-public-full-browser/。

发布前 worktree/branch/stash 快照见 pre-release-source-audit.json；main 的 SmartLookup 与两个既有 dirty 不能由此分类版本带入，宿主构建代理另有冻结差异证明。

## 网站与新插件

插件索引发布后再次完整匿名读取普通和新参数站点与索引：319条一致，HTML仍逐字等于 e4486a80 已部署源码。运行公开HTML脚本+实时索引的JSDOM中英渲染，八组顺序精确为AI/捕捉/阅读/写作/推进/回顾/数据导入导出/其他。

Apple Notes 1.0.5、Roam Research 1.2.8、健康数据同步0.2.3均在捕捉，均含arm64与x86_64两架构，页面对应卡片显示最新版本和上下文来源标签。Sumi0.1.15、奇思妙想1.3.9仍在写作。网站源码未变化，无需重复部署；此为HTTP全文与JSDOM验收，不是实际浏览器截图。

最终网站证据：website-final-verification.json。原始回读及渲染HTML保留tasks/20261111-workflow-release-audit/final/；脚本verify-final-public.mjs。插件R2完整回读与验签、KV发布证据由publisher单独提供。
