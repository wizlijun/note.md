# Claude Agent 1.0.34 发布证据

已发布，真实模型输出验收仍待验证。本机 Claude OAuth 登录过期；按用户先前“先完成代码，真实运行留待验证”与本轮“发布新版本插件”的授权继续发布，未把认证失败计为验收通过。

## 拉取与范围

在独立工作区 `mdeditor-claude-kickoff-release` 拉取最新 main `1682cd3d`。本轮只发布 Claude Agent 1.0.34，兼容已发布的 NEXT 1.12.1，无需重发 NEXT、Codex 或 DeepSeek。

发布前审计 5 个 worktree、本地未合入提交与 3 个历史 stash。主工作区 17 个 tracked 和 9 个 untracked 文件全部保留；其余旧 worktree 干净；初始所有本地分支均无 origin/main 之外的提交。三个 stash 分别为旧市场/下载与 NEXT 生命周期、roam 导入、attention plugin_host，不纳入本次发布。主工作区未执行覆盖式 pull，发布源码在隔离 worktree 通过 `git pull --ff-only origin main` 获取。

## 版本冻结与修复

- 上游功能提交：`1682cd3d92076150e9520953979959a4ffa94a7a`。Claude 声明 readonly_context 与 kickoff_protocol_versions:[2]，使用确认后的完整 prompt、stdin、空临时目录以及无工具/无 MCP/无磁盘规程模式。
- 本轮修复与版本提交：`9ece513d9a5c435d5e8549f24358012db1a8f806`，冻结 tag `plugin-claude-agent-v1.0.34` 指向该提交。
- 独立审查复现 stdout 提前 EOF 后总时限失效：1 秒预算的 stub 原本 3.44 秒后误报 Success。修复后 strict 任务在 child、stderr、stdin 收束阶段继续监听原截止时间和取消信号；超时终止进程组、取消管道任务并回收进程。普通任务保持原语义。
- 新增回归覆盖提前 EOF、后代持有 stderr、stdin 写入挂起，以及这三种阶段的取消。761 个源码输入逐一与 tag 核对，构建和发布后未变，完整哈希见同名 JSON。

## 已通过

- Claude 后端 135 项通过，1 项需真实认证测试默认忽略；界面 64 项通过；Svelte 类型检查 0 错误、0 警告。
- 双架构正式包：minisign、Developer ID codesign、arm64/x86_64 架构、manifest、v2 能力和隔离参数标记；测试 stub 未进入包，包 UI 与构建产物逐字一致。
- 正式 arm64 包的 SDK 能力探测，以及生产 NEXT prepare/start：600 个未完成 Task、60 个无关目录仍选中日记、批注和已完成任务；实际发送内容与确认快照一致。
- 实际 CLI 2.1.280 启动后捕获 argv/stdin/raw stream：prompt 逐字通过 stdin 传输且不在 argv；工作目录初始为空且结束后删除；init tools=[]、mcp_servers=[]。
- 模型认证失败前后 706 个输入文件未改变。生产 NEXT 使用真实错误记录对账为 failed/error，保存真实 OAuth 错误，不生成伪造结果；原 Task 不变。

## 未通过的真实模型项

正常请求与独立恶意探针均返回 `Failed to authenticate: OAuth session expired and could not be refreshed`，token 与费用均为 0。CLI init 选择默认模型 claude-opus-5-5[1m]，不代表模型请求已完成。

真实输出通过 parsePayload、来源与 fact 校验、答案保存，以及恶意提示到达模型后拒绝工具的验证均未完成。认证失败中的零 tool_use、秘密未出现在输出、canary 未变化不能证明恶意模型探针通过。上游提交描述中的其它机器/版本实测不替代本轮证据。未请求用户重新登录，未操作正式 Vault。

## 市场发布

沿用仓库 Wrangler 3.114.17 与 Account API Token，完成 R2 包/签名上传、匿名公网回读验签、KV 单条追加，以及普通/缓存绕过公网索引与 KV 一致复核。索引 285 → 286，原条目全部保持。

| 架构 | 包 SHA-256 |
|---|---|
| arm64 | `1afb7be20257ed7b0c3afe2cc6ad084a24dacd681dca035be626c43394089745` |
| x86_64 | `e0556d104fc8f5024e628ece988618f5b47c7aaddbc8ed64daf18113c336c575` |

本机安装清单确认未安装 Claude Agent，本轮保持不变；已安装 NEXT 1.12.1。发布报告为后续文档提交，不改变冻结 tag 或安装包。
