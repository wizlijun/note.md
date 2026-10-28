# 电子书 CLI 自动 AI 先读

## 范围

Ebook Import 1.5.6 在1.5.5导入CLI上增加两个可选参数，不改变未启用AI时的行为。复用窗口AI先读的任务、提示词、结果校验和索引更新，不增加另一个Agent协议。

## 命令契约

- `notemd ebook <file> --topic <id> --ai-read [--agent <plugin-id>] --json`：导入成功后自动AI先读，等待摘要写入并返回结果；可同时使用OCR参数。
- `--ai-read` 默认使用 `host.agent.providers` 返回的默认Agent。`--agent` 仅本次覆盖，必须是已安装的完整插件ID，例如 `notemd.codex-agent`；不更改用户设置、不静默回退。
- `--agent` 必须搭配 `--ai-read`；`--list-topics` 不接受AI参数。导入前核对provider是否安装/可用。
- 现有宿主与Agent插件只支持当前Vault，无法覆盖run-task的Vault。带AI时将目标与 `host.vault.info` 的根目录规范化比较；异库在导入前明确拒绝。普通 `--vault` 导入仍可独立指定其他Vault。
- `--ai-read` 是本次AI调用授权：所选Agent按其设置读取书籍并可能发送正文到模型服务，可能产生费用；命令不额外弹窗。
- CLI固定解析出的Agent供run与status共用，设置中途变化不转到另一provider。使用当前语言、已导入的实际书籍路径、同目录日期摘要；不得仅以任务启动或模型声称成功判断完成。
- 同步等待期间报告保活。导入失败不启动AI；AI失败不回滚已导入书籍，使用既有 `__notemd_cli_result` 返回非零退出码、`ok:false`、`data.imported:true`、书籍路径和 `data.ai_read` 错误。不要因先读失败重新导入。
- 正常导入原有返回字段保持；带AI增加 `imported`、`ai_read` 状态及成功时摘要路径、provider和run信息。摘要存在才成功，索引投影失败作为警告保留摘要。

## SDK必需调整

现SDK在协议读取循环中同步调用命令，命令等待宿主RPC会阻止读取RPC响应。将读取/响应路由与串行插件回调分离，保持回调顺序和单一写流；在EOF/关闭时释放pending请求，不引入新的wire协议。不改宿主或Agent发布包。

## 验收

1. SDK回归：同步回调等待宿主回复不死锁、回调保持串行、EOF/停用可结束。
2. 真实后端子进程：默认/指定Agent固定路由，参数冲突、缺失provider、异库导入前失败；导入失败无run、AI失败保留导入、缺摘要不假成功、正常摘要和索引。
3. 冻结签名包：隔离Vault、合成电子书、mock宿主Agent协议；正式notemd CLI验参数/普通导入/OCR和返回码。无真实用户书籍或付费模型调用，mock成功不声称真实模型验收。
4. 同版本包含OCR50MB/500页修复，按既有双架构签名与R2→匿名验签→KV→公网复核发布，安装后逐字节核验。
