# NEXT 本机任务脚本 API

`host.taskHook.*` 仅对持有 `task.hook` capability 的 `notemd.next` UI 开放；其他插件、插件进程通道和旧宿主不能调用。由宿主直接执行用户选择的 Python 脚本，不创建 agent 会话、不调用模型，因此该调用本身不消耗 token。用户选择的自定义脚本仍应自行遵守无模型调用约定。

| 方法 | 参数 | 返回 |
|---|---|---|
| `host.taskHook.get` | `{}` | `{configured:boolean,scriptPath?:string}` |
| `host.taskHook.select` | `{}` | 打开原生 Python 文件选择器，返回同上；取消保留原配置 |
| `host.taskHook.clear` | `{}` | `{configured:false}` |
| `host.taskHook.run` | `{taskId:"UUID v4"}` | 下述同步结果 |

配置按 canonical Vault 隔离，仅保存在宿主应用数据目录 `task-hooks/<Vault 路径 SHA256>.json`；不能通过 `host.settings.set` 授权执行。只允许选择当前 Vault 的 `skills/` 内 `.py` 文件；每次执行重新解析路径，拒绝不存在文件、目录与越界符号链接。更新同一路径脚本无需重选；更换路径需要再次原生选择。

NEXT 保存 Task 生命周期或提醒偏好成功后再调用；调用失败不得撤销已保存的用户操作。未配置时静默跳过。不得从 Task 正文、插件设置或 RPC 参数传入命令、脚本路径、Vault 路径、任意 argv 或环境变量。

宿主执行以下参数数组（不经过 shell），cwd 为当前 canonical Vault：

```text
python3 -X utf8 -E -s <selected.py> --vault <vault-root> --task-id <uuid> --apply
```

清空环境后仅恢复宿主现有插件环境白名单（用户目录、PATH、语言及平台运行必需变量），不传递 API Token。stdin 关闭，stderr 丢弃；stdout 最多 16 KiB，最长运行 30 秒，超时终止；Unix 同时终止进程组。脚本需自行限制网络请求、并发幂等及持久状态写入；Windows 终止主进程，不承诺终止其另行启动的子进程。脚本不应启动后台进程。

stdout 必须为一个 JSON 对象，并使用 `created/updated/deleted` 非负整数；宿主只返回白名单字段：

```json
{"ok":true,"status":"synced","created":0,"updated":1,"deleted":0}
```

允许成功状态 `synced`、`disabled`；部分失败用 `{"ok":false,"status":"pending",...}`。未配置直接返回 `ok:true,status:disabled` 与零计数。非零退出、非法 JSON、字段缺失、异常状态组合、超时等返回 `ok:false,status:pending`。稳定 `errorCode` 包含 `script_failed`、`invalid_output`、`script_pending`、`timeout`、`output_too_large`、`launch_failed`、`invalid_script`；可选 `exitCode` 只表示子进程退出码。输出中的任意诊断文本、Token、路径及额外字段不回传。

脚本应每次按 UUID 重读当前 Task/NEXT/提醒偏好，决定创建、更新或删除其已授权渠道消息；状态事件只是触发，不是事实副本。多个调用可能并发，必须使用文件锁及稳定远端消息身份防重。只有渠道操作确认成功才报告 `synced`；下一次操作或用户重试重新执行当前状态。没有常驻消费者、自动重试服务或远程部署承诺。

验证仅使用临时 Vault 和本机 fixture 脚本，不读取正式 Task、不发真实提醒。部署此能力需要带上述宿主 API 的 note.md；仅更新 NEXT 插件不能给旧宿主增加执行能力。
