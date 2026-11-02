# 2026-11-02 网站发布证据

## 发布结果

- 站点：https://notemd.net/ ，中文：https://notemd.net/zh/ 。
- 冻结源码提交：`dd56ba032ceda6881995909e848e18d6ded6ea05`。
- 使用仓库既有 `.github/workflows/deploy-website.yml`，推送 main 触发；Node 24、Wrangler 4.127.1。
- [GitHub Actions 41387046567](https://github.com/wizlijun/note.md/actions/runs/41387046567) 成功，head SHA 与上述提交一致；完成于 `2026-11-02T04:11:42Z`。
- Cloudflare Worker：`notemd-site`；Version ID：`27cd2c58-910b-4454-b2a2-0663650d3f1e`；配置路由为 `notemd.net`、`www.notemd.net`。
- 本次只发布网站，不发布桌面客户端或插件。

## 发布范围核对

发布前枚举全部 worktree、本地分支及 stash：仅主工作区及 main 分支，无 stash。main 的两个待推送提交为 `3a78fb47`、`dd56ba03`；本次网站内容来自后者。

以下原有未提交文件保持原状，未进入发布源码：`CLAUDE.md`、`README.md`、`README.zh-CN.md`、`website/public/llms-full.txt`、`website/public/llms.txt`，以及未跟踪的 `docs/product-principle-agent-playbook-belongs-to-the-vault.md`。CI 从冻结提交检出构建，不使用本地脏工作区。

## 验证

- 发布前网站 134 项测试通过，包含 en/zh/ja/de 共 52 个 HTML 页面的重新生成一致性检查。完整评审见 [项目评审记录](2026-11-02-project-content-review.md)。
- 发布后匿名 GET 读取全部 52 个 HTML 页面、`llms.txt`、`llms-full.txt`、`sitemap.xml`：共 55 个路径，各检查普通 URL 与附带 `?verify=dd56ba03` 的 URL，110 次检查全部 HTTP 200 且内容一致。
- 比较基准逐文件通过 `git show dd56ba032ceda6881995909e848e18d6ded6ea05:<path>` 读取。HTML 仅排除已确认的 Cloudflare Insights 自动注入脚本（限定完整 script 标签格式、最多一处）后逐字节比较；两个 llms 文件及 sitemap 直接逐字节匹配。未修改 CDN 配置。
- 本地原始证据保存在忽略目录 `tasks/website-release-2026-11-02/`，不作为产品内容发布。
  - `public-verification.json` SHA-256：`1d0861c8ea2123b298ef02542bcd28f34b38e595c8985337c03aa7b783544230`。
  - `deploy.log` SHA-256：`9f0776bd4783540f957712a031467fb93fad59d73b95bff895ebd3f78110a3be`。

本记录是发布后的证据补交，不改变上述已部署源码提交。
