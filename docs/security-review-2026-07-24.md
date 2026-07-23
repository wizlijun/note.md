# 安全审查报告 — 2026-07-24

全工程安全审查(review 分支 `worktree-review-2026-07-24`)。分三部分:本次已修复、
核验为安全无需处理、**遗留风险(需要产品决策,未自动修改)**。

## 一、本次已修复

| 项 | 位置 | 修复 |
|---|---|---|
| 分享链接 slug 后缀用 `Math.random()` | `src/lib/share/slug.ts` | 改为 `crypto.getRandomValues()` + 拒绝采样(248=62×4 阈值),消除可预测性与取模偏差 |

## 二、核验为安全(无需处理)

- **路径穿越**:`safe_path()` canonicalize + 前缀校验(`src-tauri/src/lib.rs`);插件窗口资源加载 canonicalize + 包含性检查(`plugin_runtime/protocol.rs`),symlink 逃逸被防住。
- **XSS**:markdown 渲染经 marked 默认转义;HTML 预览 iframe 用 `sandbox`(无 allow-scripts 的 srcdoc 不能提权);`{@html}` 仅一处且非用户内容注入。
- **分享后端鉴权**:worker 全部写端点(publish/upload/delete/media)校验 Bearer token;token 为 `crypto.getRandomValues` 16 字节。
- **更新器**:minisign 公钥钉死在 tauri.conf.json,端点 HTTPS(GitHub Releases);v5.0.3 起构建后自重签修复了签名不匹配。
- **插件供应链**:安装时校验 SHA256 + minisign 签名(钉死公钥),未签名包拒绝(`cli/builtin.rs`)。
- **git 命令注入**:`run_git` 走 `Command::args`(非 shell 拼接),抽查调用点均为硬编码参数数组。
- **`.env.release`(Apple 公证凭据)**:已核验 `git log --all` 从未入库、`.gitignore` 覆盖、无任何 `.env*` 被 track。凭据仅存本地,为 app-specific password。**无需吊销**。注意:永远不要 `git add -f` 该文件;若怀疑泄露,在 appleid.apple.com 撤销该 app 专用密码即可。

## 三、遗留风险(未修,需产品决策)

### 1. CSP 完全关闭(`csp: null`)— 中高
`src-tauri/tauri.conf.json` → `app.security.csp: null`。
渲染层一旦出现 XSS,没有第二道防线。未自动修的原因:上 CSP 需要逐项放行
Vite 注入的内联样式、`asset:`/`blob:`/`data:` 图片、插件隔离 webview 与
share/beacon 的 connect-src,盲上必然打断功能,需要实机回归。
**建议**:单独排期,从 `default-src 'self'; object-src 'none'` 起步,配合
dev 实测逐项收紧。

### 2. fs capability 全盘读写 scope `**` — 中(设计使然)
`src-tauri/capabilities/default.json` 所有 fs 权限 scope 为 `**` + `/**`,
assetProtocol scope 也是 `**`。对"打开任意路径文件"的编辑器这是产品需求,
但意味着渲染层被攻破即等于全盘读写。
**建议**:长期可考虑把「vault 内操作」与「任意文件打开」拆成两个能力集;
短期接受现状。

### 3. `http:default` 允许非 TLS 请求 — 低中
capabilities 里 http 权限同时放行 `http://`。若仅 localhost 调试需要,
可收紧为 `https://**` + `http://localhost:*`。需先确认无 http 端点依赖
(beacon/共享/插件市场均为 https)。

### 4. 插件读文件上限 200MB 的内存放大 — 低中
`plugin_runtime/ui_rpc.rs` `MAX_TEXT_BYTES = 200MB`(为 Roam 大导出放宽),
`read_bytes` base64 后单次 RPC 物化约 266MB 字符串,恶意/失控插件反复调用
可造成内存耗尽。代码注释已声明该代价。
**建议**:后续为大文件读提供流式/分片 API,并考虑按插件限频。

### 5. 分享 slug 后缀熵天然有限 — 低(残余风险)
后缀固定 3 位 base62(62³≈23.8 万),即使换 CSPRNG,知道日期+文件名格式
的攻击者仍可枚举。分享链接本质是"知道链接即可读"。
**建议**:若要"不可猜测"级别,需把后缀加长(如 8 位)——会改变链接美学,
属产品决策,故未改。

### 6. 主窗口/渲染层与全盘权限的组合放大效应 — 说明
上述 1+2 组合意味着:任意一处前端注入漏洞≈本地全盘读写。当前渲染管线
核验干净(见第二部分),该项列此作为威胁模型备忘,提醒新增 `{@html}`、
远端内容渲染、插件桥命令时保持警惕。

---
*审查方法:4 个并行只读审查代理(UI/i18n/CLI/安全)+ 人工核验关键论断;
所有"已核验安全"条目均实读源码确认,非仅凭代理报告。*
