# 电子书 Agent CLI

## 目标与范围

将插件窗口“选择文件→指定主题→可选 OCR→导入”的流程作为 Agent 可直接调用的正式 `notemd ebook` 命令。沿用既有宿主路由和 UI 同一 pipeline，不引入后台任务系统、分类猜测或新的模型调用。发布 Ebook Import 1.5.5 双 macOS 架构包；最低宿主升至 6.915.3，以使用无窗口 CLI 和仅启动阶段的 watchdog。

## 命令契约

- `notemd ebook --list-topics [--vault <absolute-vault>] [--root <vault-relative>] --json`：返回 `{ebooks_root, topics}`；主题包含稳定 `id` 与显示 `label`。拒绝同时传文件、topic、ocr、ocr-provider。不创建分类、模板或重建索引；缺失主题配置明确报错。
- `notemd ebook <file> --topic <id> [--vault <absolute-vault>] [--root <vault-relative>] [--ocr [--ocr-provider wechat|baidu]] --json`：同步执行完整导入，保留既有 `dest` / `log`，增加 `dest_rel`、`topic_id`、`ocr` 和 `provider`（无 OCR 为 null）。所有结果受宿主 `{ok,data}` / `{ok:false,error}` 封装。
- `--vault` 为插件级参数，必须是现存目录的绝对路径；查询与导入可显式选择目标，否则沿用已配置 Vault，不改持久设置。
- manifest 的 file 为可选 path 类型，允许无文件查询，并由宿主按调用者 cwd 规范化路径；导入在 backend 强制验证 file 和 trimmed topic。
- `--ocr` 只用于 PDF，provider 必须受支持且必须搭配 OCR；提前校验，不静默降级或外发内容。root 沿用相对路径与符号链接边界检查。
- 启用 OCR 使用现有服务设置/本机凭证；明确说明页面会发送至配置的微信 OCR 或百度服务。`--ocr` 是本次显式启用，不额外弹 UI。普通导入不自动切换 OCR。
- 查询期间不恢复分类事务；实际导入先恢复目标书库未完成的分类事务，恢复失败阻止新增书籍，避免破坏恢复清单。
- 阶段与页数进度走宿主日志（stderr）；静默转换每 30 秒报告仍在运行，避免宿主 300 秒空闲超时。既有 Calibre 与网络时限保持，不伪造完成度。

## 验收

1. 单元及真实 SDK 子进程：参数矩阵、只读主题查询、普通导入、OCR、结果结构、错误及保活。
2. 正式宿主 CLI + 可分发包：隔离 Vault，合成 EPUB/PDF，本地 OCR 服务，验证相对路径、主题、正文/资源/索引、退出码及 stdout JSON。
3. UI 回归：现有测试、类型检查和构建。
4. 发布：所有 worktree/分支/stash 范围审计；精确提交与冻结 tag；双架构 codesign/minisign；R2 匿名回读验签后发布 KV，再公网复核与安装检查。不能仅用源码测试声称安装包验收。
