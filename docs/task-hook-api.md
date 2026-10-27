# NEXT 本机任务脚本 API

`host.taskHook.*` 仅对持有 `task.hook` capability 的 `notemd.next` UI 开放；其他插件、插件进程通道和旧宿主不能调用。由宿主直接执行用户选择的 Python 脚本，不创建 agent 会话、不调用模型，因此该调用本身不消耗 token。用户选择的自定义脚本仍应自行遵守无模型调用约定。

| 方法 | 参数 | 返回 |
|---|---|---|
| `host.taskHook.get` | `{}` | `{configured:boolean,scriptPath?:string,pythonPath:string,environmentSupported:true,environmentKeys:string[]}` |
| `host.taskHook.select` | `{}` | 打开原生 Python 文件选择器，返回配置（无 pythonPath）；取消保留原配置 |
| `host.taskHook.clear` | `{}` | `{configured:false,environmentSupported:true,environmentKeys:string[]}` |
| `host.taskHook.setEnvironment` | `{text:"KEY=value\nKEY=value"}` | 返回配置（无 pythonPath），只返回变量名；空字符串清除环境覆盖 |
| `host.taskHook.run` | `{taskId:"UUID v4"}` | 下述同步结果 |

配置按 canonical Vault 隔离，仅保存在宿主应用数据目录 `task-hooks/<Vault 路径 SHA256>.json`；不能通过 `host.settings.set` 授权执行。只允许选择当前 Vault 的 `skills/` 内 `.py` 文件；每次执行重新解析路径，拒绝不存在文件、目录与越界符号链接。更新同一路径脚本无需重选；更换路径需要再次原生选择。

NEXT 保存 Task 生命周期或提醒偏好成功后再调用；调用失败不得撤销已保存的用户操作。未配置时静默跳过。不得从 Task 正文、插件设置或 run 参数传入命令、脚本路径、Vault 路径、任意 argv 或环境变量。环境变量仅通过下述独立配置入口保存。

## 环境变量设置

设置中可粘贴以下格式（示例均为占位值）：

```dotenv
DESK_DISPLAY_URL=https://cube.example.invalid
DESK_DISPLAY_TOKEN=your-token
```

`setEnvironment` 仅支持这两个键，替换当前 Vault 的全部覆盖。按第一个 `=` 分隔，忽略空行和整行 `#` 注释，去除首尾空白及成对的单/双引号；不执行 shell、插值或转义。未知/重复键、缺少等号、空值、未配对引号、NUL及超长输入被拒绝，错误不包含原值。总输入最多16KiB，单值最多8KiB。

环境覆盖独立保存在 `task-hooks/<Vault路径SHA256>.environment.json`，原子写入（Unix 0600），不写入 Vault。保存不授予脚本权限、不启动脚本；停用或重新选择脚本保留环境设置。空字符串（或仅空白/注释）清除覆盖。所有响应仅返回 `environmentKeys`，不提供密钥回读接口。NEXT保存成功后清空输入草稿，只显示已保存变量名；旧宿主没有 `environmentSupported:true` 时提示更新。

配置仅注入NEXT启动的脚本进程，优先于技能脚本原有 `~/.config/desk-display/env`；清除后恢复脚本原来的配置读取方式，定时任务及其他调用者的环境不变。它是本机私有文件存储，并非系统密钥链。

## 执行与结果

宿主执行以下参数数组（不经过 shell），cwd 为当前 canonical Vault：

```text
python3 -X utf8 -E -s <selected.py> --vault <vault-root> --task-id <uuid> --apply
```

macOS 优先使用已存在且可执行的 `/opt/homebrew/bin/python3`，其次 `/usr/local/bin/python3`，最后使用 PATH 中的 `python3`；其他平台使用 PATH 中的 `python3`。`get.pythonPath` 返回选择的程序路径（PATH 后备时为 `python3`）。这样 Finder 启动时仅含系统目录的 PATH 不会误选缺少技能依赖的系统 Python；PyYAML 等依赖仍需预先安装到选中的解释器，不会自动安装或加载 shell 配置。

清空环境后仅恢复宿主现有插件环境白名单（用户目录、PATH、语言及平台运行必需变量），不继承其他 API Token；随后仅注入当前 Vault 明确保存的两个环境变量。stdin 关闭，stderr 丢弃；stdout 最多 16 KiB，最长运行 30 秒，超时终止；Unix 同时终止进程组。脚本需自行限制网络请求、并发幂等及持久状态写入；Windows 终止主进程，不承诺终止其另行启动的子进程。脚本不应启动后台进程。

stdout 必须为一个 JSON 对象，并使用 `created/updated/deleted` 非负整数；宿主只返回白名单字段：

```json
{"ok":true,"status":"synced","created":0,"updated":1,"deleted":0}
```

允许成功状态 `synced`、`disabled`；部分失败用 `{"ok":false,"status":"pending",...}`。未配置直接返回 `ok:true,status:disabled` 与零计数。非零退出、非法 JSON、字段缺失、异常状态组合、超时等返回 `ok:false,status:pending`。稳定 `errorCode` 包含 `script_failed`、`invalid_output`、`script_pending`、`timeout`、`output_too_large`、`launch_failed`、`invalid_script`；可选 `exitCode` 只表示子进程退出码。合法 pending JSON 中的 `error` 仅将 `missing_cube_config`、`cube_unavailable`、`sync_busy`、`cube_safe_create_unavailable` 映射为 `errorCode`，非零退出也保留这些固定码，但不得将非零退出判为成功。输出中的任意诊断文本、Token、路径及额外字段不回传。

脚本应每次按 UUID 重读当前 Task/NEXT/提醒偏好，决定创建、更新或删除其已授权渠道消息；状态事件只是触发，不是事实副本。多个调用可能并发，必须使用文件锁及稳定远端消息身份防重。只有渠道操作确认成功才报告 `synced`；下一次操作或用户重试重新执行当前状态。没有常驻消费者、自动重试服务或远程部署承诺。

验证仅使用临时 Vault 和本机 fixture 脚本，不读取正式 Task、不发真实提醒。部署此能力需要带上述宿主 API 的 note.md；仅更新 NEXT 插件不能给旧宿主增加执行能力。
