# Roam Research Sync 1.2.7 发布验收

用户最终范围为“不连接设备，只发布插件”。本次仅发布插件市场更新；没有安装用户设备或运行真实 Roam / Vault 同步。

## 修复与冻结源码

源码提交 `0841b18f57f4b65dbe30edb6c7a7fd9bd0cf2ad5`，冻结 tag `plugin-roam-import-v1.2.7`，均已推送并回读远端 SHA。独立提交仅包含 10 个插件实现、回归、版本和日志文件。

共享 `procutil::run_with_timeout` 将两个父进程管道设为非阻塞，在同一 deadline 内交替限量读取 stdout/stderr 与检查子进程退出状态；必须同时拿到两个 EOF 和退出状态才能返回成功。超时或 I/O 错误关闭管道、kill 并 wait 回收子进程。没有增加生产查询的 60 秒超时。

失败报告保留可用 ledger 标题、uid 和超时秒数；没有标题时保留 uid。未改变 `--since`、`--graph`、`--dry-run` 或 Roam 查询参数。保留首个失败即停止、相同 edit timestamp 分组成功才推进 watermark 的规则；未实现可选的失败后继续同步。manifest、package、Cargo、lock 均为 1.2.7，双语未发布日志已有条目。

## 测试

- 旧实现 RED：同一 fake roam 的大 JSON / 大 stderr 两项均在 2 秒内超时失败；修复后完整保留数据并解析。
- Rust：261 passed（230 library、22 binary、4 pipe integration、5 golden）；1 个真实 Roam 测试按最终范围保持 ignored。
- 插件前端：4 文件、48 tests；发布契约：76 tests；svelte-check：0 errors / 0 warnings。
- 宿主最终全量：405 文件、5256 tests 全通过。执行 `RUSTUP_TOOLCHAIN=1.99.0 pnpm exec vitest run --testTimeout=30000`。本机默认 stable 缺 cargo，使用现有 1.99.0；先前全量轮次有 Linux 打包脚本触发 runner 默认 5 秒超时，独立 25 项复验及最终全量均通过。30 秒仅为本次 Vitest runner 配置，未修改源码或 Roam 的 60 秒超时。
- 4 项管道集成测试覆盖 >1 MiB JSON stdout、前后各 1.2 MB stderr、完整非零错误 stderr、sleep 超时后的 PID 不存在（包含排除僵尸）、子进程退出但后代仍持管道的 deadline。
- 测试脚本以系统 `/bin/sh` 显式执行，避开 macOS 首次运行临时 shebang 文件的启动延迟；该延迟独立 Python Popen 也复现。计时前完成登录 shell PATH 探测，生产 wrapper/管道实现和测试的 1 秒/2 秒限额保持。连续 10 轮 40/40 通过；没有放宽产品超时掩盖死锁。

## 实际包离线验收

直接解压实际签名 ARM 包运行 NDJSON 协议，隔离 HOME / shared config / fake roam / 合成 vault。构造 04-28、04-30、06-16、10-22、10-23 共 5 个页面，每页 stdout 1,048,714 bytes，每次查询 stderr 308,000 bytes。

dry-run 0.627 秒，5 页全部处理且 vault 零写入；合成同步 0.607 秒，5 份笔记正文完整、failed=0、errors=[]、进程 rc=0，合成 watermark 为 `2026-10-23T00:00:00.004Z`。这些是合成数据验收，不是 Mac mini 或真实日期笔记同步证据。

## 安装包与公开发布

使用既有 `scripts/release-plugins.sh roam-import` 构建 macOS 双架构包。首次 Apple timestamp 返回缺失，流程停止；原命令重试成功，没有取消时间戳或降低签名校验。两个包的 manifest 与冻结 tag 逐字节一致，UI 与构建输出一致，二进制与对应 target 输出一致；ZIP CRC、路径/重复/符号链接检查、架构、可执行位、Developer ID / timestamp 和 minisign 全通过。

| 架构 | 包大小 | SHA-256 |
| --- | ---: | --- |
| aarch64-apple-darwin | 812015 | `9b64247352dd3335936188292092c57fe6add2339a0cff81eb8bc35afae012e0` |
| x86_64-apple-darwin | 879920 | `f14e70b1ec6c3ccb0d3f185405a5ace77fbdcfb7b563644728bc43c1a8c04130` |

沿现有 Wrangler 3.114.17 + Account API Token 流程：四个 R2 包/签名对象上传均一次 exit 0；先匿名逐字节回读并验签，再发布 KV。普通下载 URL 和绕缓存 URL 的包/签名均与本地一致；未替换 Wrangler 或上传渠道。

KV 仅追加 `notemd.roam-import@1.2.7`，267 → 268，历史条目与其他插件完全不变。发布前再次读取 KV 确认无并发变更。发布后 KV、普通公网索引和绕缓存索引逐字节一致，最新版本 1.2.7，最低宿主仍为 `>=6.828.3`。索引 SHA-256：`f955d2fcfb3bbe6056f0187a76baa975c8ca35c06fda20761c1b5ed0b26964a3`。

- [Apple Silicon 安装包](https://plugins.notemd.net/api/download/notemd.roam-import/1.2.7/aarch64-apple-darwin)
- [Intel 安装包](https://plugins.notemd.net/api/download/notemd.roam-import/1.2.7/x86_64-apple-darwin)
- [公开市场索引](https://plugins.notemd.net/api/index.json)

## 范围和原始证据

发布前枚举 worktree、分支和 stash：仅 main 一个 worktree / 分支，没有未合入本地支线；3 个 stash 保留，涉及 Roam 的历史修复按实际补丁和 main 对应行为核对，未恢复或混入。原有 .pnpm-store 和 6 项 docs 未跟踪入口保留，不纳入提交。没有发布宿主或其他插件。

完整原始证据在忽略目录 `tasks/roam-pipe-20261023/`：`release-scope.txt`、`source-freeze.json`、`red-final.log`、`rust-tests-final.log`、`frontend-tests.log`、`release-tests.log`、`check.log`、`host-tests-verified.log`、`package-build-retry.log`、`package-proof.json`、`artifact-e2e/result.json` / `protocol.jsonl`、`public-packages.json`、`public-normal-proof.json`、`index-verification.json` 和 `remote-refs.txt`。失败轮次日志保留，未将其覆盖或冒称首轮成功。
