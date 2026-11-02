# 2026-11-02 Grokbot 网站更新与发布

## 已上线内容

- 四语首页突出句以 Grokbot 替换 OpenClaw。
- 所有页面的集成导航统一为 Claude、Codex、Grokbot、OpenClaw、Hermes；Claude 沿用 Cowork 页面，保留原有 ChatGPT Work 页面及其他入站链接。
- 新增 en/zh/de/ja 四版 `/integrations/grokbot/`，含文件协作、设置步骤、本机与云端权限区别、批注示例和 FAQ；同步 sitemap、canonical、hreflang。
- 修复翻译内容页的 EN 切换链接：仅本地化正文链接，不再重写语言切换器的英文目标。
- Grokbot 指 xAI 的 Grok Bot；本机执行权限和云端工作区边界依据 [计算机与应用](https://docs.x.ai/grok-bot/computer-and-apps)、[权限说明](https://docs.x.ai/grok-bot/approvals-security-and-privacy)、[文件与结果](https://docs.x.ai/grok-bot/files-and-results)。页面描述经授权的文件协作，不宣称专用插件或自动同步。

## 提交及部署

- 功能提交：`36adf8ff`。
- 发布前发现远端新增 4 个提交至 `fc14d39f`，首次推送非快进拒绝。获取远端后合并，仅双语更新日志冲突，保留双方全部条目；逐字验证移除本次条目即恢复远端更新日志。
- 最终部署提交：`76c0ac187a0a72a014cbff362d131f65050cdab5`，保留远端 v6.1102.1 客户端发布记录与首页说明。
- [Deploy website 41448514961](https://github.com/wizlijun/note.md/actions/runs/41448514961) 成功，head SHA 与最终部署提交一致；沿用仓库现有 Wrangler 4.127.1 网站工作流。
- Worker `notemd-site`，版本 `ae26a583-81f5-4ed7-85f0-ae8c2b2a40c6`，部署日志时间 `2026-11-02T12:55:10Z`；路由 `notemd.net`、`www.notemd.net`。
- [中文首页](https://notemd.net/zh/)、[中文 Grokbot 集成页](https://notemd.net/zh/integrations/grokbot/)。本次不发布客户端或插件安装包。

## 验证与范围

- 合并前、合并后网站测试均为 5 文件、142 项通过，包含 56 页生成一致性、五项导航顺序、链接目标、语言切换及元数据校验。独立只读复核确认 56 页站内文件链接有效。
- 发布后匿名读取 56 个 HTML 页面及 llms.txt、llms-full.txt、sitemap.xml，共 59 个路径；普通 URL 与附带提交参数的 URL 共 118 次检查，全部 HTTP 200 且与冻结提交一致。HTML 仅排除限定格式且最多一处的 Cloudflare Insights 注入脚本后逐字节比较，其他文件原始字节一致。
- 另以 curl 回读中文 Grokbot 页成功。
- 发布前枚举工作区、分支与 stash：只有主工作区和 main，无 stash。合并远端后待推送提交只有本次功能与合并提交。
- 原有 `CLAUDE.md`、两份 README、两份 llms 未提交修改逐字保留；未跟踪的 `docs/product-principle-agent-playbook-belongs-to-the-vault.md` 未修改，均未进入本次提交。
- 本地证据目录为忽略的 `tasks/website-grokbot-2026-11-02/`：
  - `tests-after-merge.log` SHA-256：`1da28be16a37abdaf6488ce4a7cc63755df29103178fe1d75e379a07edb4c8cb`。
  - `deploy.log` SHA-256：`c567bd8b47e5cd8c7a6293e6964199117fbe7e6d5e0c1129a87b3c4530b51f53`。
  - `public-verification.json` SHA-256：`3738207f0ee96576327db219d9688814556a672874a1cc744a5ad8a16681894a`。

本记录为发布后证据补交，不改变上述部署提交。
