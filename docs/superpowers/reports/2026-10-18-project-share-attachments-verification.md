# 项目分享附件与文件夹树验收（2026-10-18）

范围：用户确认是项目分享，修复其附件扫描、网页文件夹树及直接点击下载；不修改旧单篇分享和 CLI，不发布 Worker、插件或应用版本。

## 实现

普通 Markdown/引用式/HTML 链接的附件读取、dataUrl 快照与 ZIP 保留已经存在。文件树此前仅遍历 Markdown docs，现遍历完整 snapshot，保留旧版本草稿条目；附件按原目录出现，点击复用现有字节下载函数，并在文章导航前返回，当前正文、hash、选中条目和未保存草稿不变。Markdown 仍正常切换阅读/编辑，附件右键菜单继续可用。

Wiki 扫描此前把 PDF/ZIP 等明确扩展名追加 .md，导致附件缺失；现优先保留已有 Markdown 候选及同名解析，无候选时明确扩展名使用附件原路径。隐私文件、项目根边界及批准范围沿用既有实现。保留 Release 1.0.md 等带点文档标题的根目录及跨目录查找。

## 验证

- RED：文件树附件新用例在修改前两项失败（附件目录为空）；Wiki 附件新增用例先失败；初版路径判断发现带点文档标题回归后新增两项 RED，再修正为候选优先。
- GREEN：browser.test.ts 235项；其余项目引用/呈现/打包/归档/发布host/分享弹窗179项通过。最终扫描修正后 references+presentation 49项通过（references从31增至33），合计416项不重复的相关测试。
- svelte-check：0错误、31项既有警告；使用空 envDir 的正式构建及分享资源纯度/预算检查通过；git diff --check通过。
- 真实 Chrome：实际临时文件经生产 scanProject → snapshot → buildProjectBundle → 序列化网页，PDF/ZIP/零字节附件进入快照与目录；树点击及正文Wiki链接触发真实下载，逐字节核对文件和文件名；下载时未保存草稿/正文/hash保持。Markdown导航、1200×850桌面与390×844窄屏、只读下载均通过。已查看两张截图，目录和附件行可见。

验收工具过程保留：首次 Playwright 默认浏览器版本不在缓存，改用已有系统Chrome；随后发现临时服务中间件挂在Vite fallback之后，移到configureServer后成功。上述为本地验收夹具修正，无产品代码变化。初轮全量RED被中止后改用定向RED；最终完整browser 235项通过。没有用失败或中止运行作为通过证据。

## 产物与状态

原始日志、网页夹具、真实下载摘要、截图、源码SHA位于 `.superpowers/sdd/2026-10-18-project-share-attachments/`。未测试移动真机，窄屏Chrome仅代表浏览器视口。未替用户更新安装或重新发布已有项目。修改提交后仍需随新宿主版本分发，并重新发布项目使现有分享网页更新。

## 发布状态

已随 [v6.1018.1](https://github.com/wizlijun/note.md/releases/tag/v6.1018.1) 发布macOS双架构版本；Worker已按同源码重新部署并核100%。升级后重新发布项目使已分享网页更新，详细发行证据见同目录2026-10-18-v6.1018.1-release-verification.md。
