# NEXT 与 skills 直接同步 Cube 验收

已实现用户要求的固定脚本入口。NEXT 设置选择当前 Vault `skills/` 中的 Python 脚本；Task 状态、提醒偏好或规划元数据保存后，宿主直接执行脚本，不启动 agent 或模型。定时任务、agent 和人工可执行同一命令。脚本每次重读本机任务库，按规则创建、更新、删除 Cube 消息并回读结果。

## 使用

全库同步：

```bash
python3 /path/to/sotvault/skills/proactive-reminder-push/scripts/sync_task_reminders.py \
  --vault /path/to/sotvault --apply
```

单任务增加 `--task-id <UUID>`；省略 `--apply` 只生成计划。NEXT 通过原生文件选择器配置脚本，由宿主传入当前 Vault 和 UUID。普通插件配置不能授予命令执行权限。Python 依赖及本机 Cube 凭据按 skill 配置。

脚本新建消息必须有到期且有效的提醒规则，文案直接读取 Task。没有提醒规则不会自动上屏。同任务优先展示最早有效规则；每轮最多新增 3 条，可见 bot 总数不超过 6。完成、停止、转移、静音、暂停或规则失效时撤下对应消息。模型仍可用于上游语义提取，但消息同步本身不使用模型 token。

## 提交与来源

- 宿主 API：`2e273023`；macOS Python 发现修复：`8830a5ac`。
- NEXT 设置、保存后触发、失败重试与规则文档：`25caf77444efe980c490ce758694ceaeb865a59b`。
- Vault 的 10 个相关文件逐字节匹配自动同步提交 `5f1b03ec209c26f8d0acd70a32d35f14d9c7e7f0`，包括三个 skills、根 AGENTS、操作规则、cron 指令、同步脚本及测试、定时脚本及测试。未代提交自动同步中的其他工作。
- Cube 服务：`ae9ed8ae0e16865a8a3dc4e8bd74aefed94d2dd2`，仅新增安全创建能力及测试/接口文档，保留该仓库原有 7 项修改和 `upstream/`。

协议与逻辑见 [设计说明](../specs/2026-10-27-next-cube-script-hook.md)。Vault agent 由根 AGENTS 路由至 skill 的《固定脚本同步 Cube》，任务保存成功后直接执行命令；失败只重试同步，不重复完成或创建任务。

## 验证结果

- NEXT 433 项测试通过，类型检查零错误/警告，生产构建通过。
- 发布/索引契约 94 项、协议 69 项通过。
- 宿主 `plugin_runtime::` 308 项通过；Python 发现修复后定向 8 项通过。使用现有 Rust `1.99.0`，未安装工具链。
- Python proactive 81 项与 scheduled 22 项通过；包含强杀后释放本机锁、旧服务降级、容量冲突及回执验证。
- Cube 服务 19 项测试通过，包括两个线程争夺最后一个空位，一个成功、另一个 409。
- 实际 NEXT 生产 JS 的 10 项隔离检查通过：先保存后调用、执行延迟不阻塞完成礼花、失败保留完成、重试不重复写事件、停用和旧宿主降级。bundle SHA256：`f910c32b0d06cef3dd9bfb48f0799c6a21e846403eb390fcb3b332fd07eb1863`。
- 从任意工作目录执行真实 Task CLI、提醒 CLI 和同步 CLI，连接本机临时 Cube 真实 Handler/Store，6 阶段前向验收通过：到期创建、重复无操作、原 ID 更新、未到期不发、完成删除、重复完成不恢复。最终客户端安全创建修改后重新验收通过。
- 真实服务隔离验收复现并修正了满屏隐式挤掉未知 bot 的问题。新版服务原子拒绝满屏新增；原消息保持。

通用 skill validator 因 Vault 既有 OKF 扩展字段拒绝 frontmatter。保留 Vault 必需元数据，另行验证 YAML、必填字段、命令引用、无伴随 note、空行与实际命令行为。

## 发布与运行边界

本轮未发布插件或宿主、未安装本机版本、未部署 Cube 或远程定时器，未调用正式 Cube 或修改正式 Task。运行测试只使用临时 Vault、合成 token 和 loopback 服务。Windows 本机锁分支有实现，未做 Windows 实机验收。

完整接入需要新 note.md 宿主、新 NEXT 和同步脚本。Cube 必须部署 `safe_create` 能力后才能创建/更新；旧服务仍可查询、撤回，其他操作返回待同步。每台设备须先同步 Vault 并配置本机凭据。本机锁、脚本回读不能证明远端 Vault 已同步；Cube 尚无跨设备任务版本保护。

完整本地证据保存在 `tasks/next-script-hook-20261027/`：源码哈希、测试日志、实际构建检查、真实 CLI 前向验收及安全容量验证。
