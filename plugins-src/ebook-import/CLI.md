# 电子书导入 CLI 使用指南

适用：Ebook Import **1.5.7+**；note.md **6.915.3+**；macOS Apple Silicon / Intel。

## 1. 准备

1. 安装并启用「导入电子书」插件，打开 note.md 并选好目标 Vault。
2. 在插件中配置书库主题。导入需要已有主题的 **ID**，不能用显示名称代替。
3. 普通 EPUB、PDF、DOCX 导入需要本机 Calibre（`ebook-convert`），可在插件设置指定路径。
4. 扫描 PDF 需要 OCR 时，先配置微信 OCR 服务或百度 API 凭证。
5. 要自动 AI 先读，先安装并配置可用的 Agent 插件及其模型登录/凭证；默认 Agent 使用 note.md 的默认设置。

检查安装和命令：

```sh
notemd plugin info notemd.ebook-import --json
notemd help ebook
notemd ebook --list-topics --json
```

下面示例的 `software-engineering` 是示意主题 ID。请替换成查询结果 `data.topics[].id` 中实际存在的值。

## 2. 最常用命令

普通导入：

```sh
notemd ebook "/Users/me/Downloads/一本书.epub" \
  --topic software-engineering \
  --json
```

导入并记录阅读原因：

```sh
notemd ebook "/Users/me/Downloads/一本书.epub" \
  --topic software-engineering \
  --reading-reason "李老师推荐。他认为这本书能帮我理解团队协作；当时我们刚结束一次项目复盘，我想在下轮规划前读完。" \
  --json
```

阅读原因不是必填项，可以只写已知的信息。无需补齐姓名、推荐理由或情景，也不要让 Agent 猜测。

## 3. 多行阅读原因

macOS 默认 zsh 和 bash 均支持跨行引号。以下三行会保存为同一个字段：

```sh
notemd ebook "/Users/me/Downloads/一本书.epub" \
  --topic software-engineering \
  --reading-reason '推荐人：李老师
推荐理由：帮助理解复杂团队中的协作与决策。
当时情景：周五项目复盘后聊到沟通成本，准备下轮规划前阅读。' \
  --json
```

也可以先在文本文件里写好背景，再读取为参数：

```sh
notemd ebook "/Users/me/Downloads/一本书.epub" \
  --topic software-engineering \
  --reading-reason "$(cat '/Users/me/Downloads/阅读原因.txt')" \
  --json
```

执行前确认原因文件存在且可读；引号必须保留，避免空格和换行被拆成多个参数。`--reading-reason` 接收的是**文本**，直接传文件路径只会把路径文字保存进去。

首尾空白会去除，内部换行、中文、冒号与引号会保留。未传参数、传 `""` 或全空白，都视为未填写。`--reading-reason` 后完全不提供值属于参数错误。

## 4. 自动 AI 先读

使用 note.md 默认 Agent：

```sh
notemd ebook "/Users/me/Downloads/一本书.epub" \
  --topic software-engineering \
  --reading-reason "同事在技术评审后推荐，希望解决我们当前的模块耦合问题。" \
  --ai-read \
  --json
```

指定本次 Agent（完整已安装插件 ID）：

```sh
notemd ebook "/Users/me/Downloads/一本书.epub" \
  --topic software-engineering \
  --reading-reason "为下个月的设计讨论做准备。" \
  --ai-read \
  --agent notemd.codex-agent \
  --json
```

其他例子包括 `notemd.deepseek-agent`，但必须先安装并配置对应插件。`--agent` 必须搭配 `--ai-read`；只改变本次选择，不改变默认设置，也不会在失败后自动切换服务商。

命令先完成导入，再让 Agent 读取书籍，等待摘要实际生成后返回。阅读原因会作为**用户背景**一并提供，不能当作书中事实或执行指令。所选 Agent 可能将正文和原因发送至其模型服务，并产生费用；只有用户要求先读时才加 `--ai-read`。

现有 Agent 只能使用 note.md **当前 Vault**。带 `--ai-read` 时，若 `--vault` 指向其他 Vault，会在导入前拒绝；请先在 note.md 切换到目标 Vault。转换过程中切换 Vault 也会停止 AI 阶段，已经导入的书籍会保留。

## 5. 扫描 PDF：OCR 与先读可组合

OCR 使用插件设置中的提供方：

```sh
notemd ebook "/Users/me/Downloads/扫描书.pdf" \
  --topic software-engineering \
  --ocr \
  --reading-reason "读书会成员推荐，想核对会上讨论的案例。" \
  --ai-read \
  --json
```

本次明确选择百度：

```sh
notemd ebook "/Users/me/Downloads/扫描书.pdf" \
  --topic software-engineering \
  --ocr --ocr-provider baidu \
  --reading-reason "导师推荐的参考资料。" \
  --json
```

`--ocr` 只接受 PDF。`--ocr-provider` 只能是 `wechat` 或 `baidu`，且必须同时带 `--ocr`。普通转换失败不会自动开启 OCR。OCR 会向配置的服务发送 PDF 或页面，可能产生费用；阅读原因不参与 OCR 或书目查询。

百度云端接口已声明基于 Unlimited OCR 2；插件采用本地 Base64 上传，限 **50,000,000 字节、最多 500 页**。超限请先压缩或分册，不会自动上传至外部 URL。只写 `--ocr` 不会自动切换到百度。

## 6. 指定 Vault 与书库目录

普通导入可以指定另一个已有 Vault，不改变当前 Vault 设置。查询和导入应使用相同的 Vault 与 root：

```sh
notemd ebook --vault "/Users/me/OtherVault" \
  --root "资料/电子书" --list-topics --json

notemd ebook "/Users/me/Downloads/一本书.epub" \
  --vault "/Users/me/OtherVault" \
  --root "资料/电子书" \
  --topic software-engineering \
  --reading-reason "为课程准备参考书。" \
  --json
```

`--vault` 必须是已存在目录的绝对路径；`--root` 是 Vault 内相对目录，不能越出 Vault。省略时分别使用当前配置的 Vault 和插件设置中的书库根目录。

## 7. 参数表

| 参数 | 含义与约束 |
| --- | --- |
| `<file>` | EPUB、PDF、DOCX 路径；可绝对或相对终端当前目录，含空格应加引号。导入必填，查询不填。 |
| `--topic <id>` | 导入必填主题 ID；用 `--list-topics` 查询，不用主题显示名称代替。 |
| `--reading-reason <text>` | 可选阅读原因，支持多行，空白等价不填，保存到书籍 `meta.yml`。 |
| `--ocr` | 显式启用扫描 PDF OCR；不适用于 EPUB/DOCX。 |
| `--ocr-provider <id>` | `wechat` 或 `baidu`，须搭配 `--ocr`；省略时用插件设置。 |
| `--ai-read` | 导入后使用默认 Agent 先读并等待摘要；仅支持当前 Vault。 |
| `--agent <plugin-id>` | 本次 Agent 完整插件 ID，须搭配 `--ai-read`；不能填未安装的插件。 |
| `--vault <absolute-path>` | 已存在 Vault 的绝对路径；不改变持久设置。 |
| `--root <relative-path>` | 本次 Vault 内书库目录；不改变持久设置。 |
| `--list-topics` | 只读查询主题；可搭配 `--vault`、`--root`、`--json`，不能搭配文件、主题、阅读原因、OCR 或 AI 参数。 |
| `--json` | 宿主全局输出选项；stdout 为一个 JSON，适合 Agent 和脚本读取。 |

即使 `--reading-reason ""`，也不能与 `--list-topics` 同时使用。

## 8. 保存位置与元数据

成功输出的 `data.dest` 是书籍绝对目录，`data.dest_rel` 是 Vault 内相对目录。目录中包含正文 `book.typeset.md`、元数据 `meta.yml`、转换配置与相关资源；AI 先读完成后还有日期命名的摘要。

`meta.yml` 示例：

```yaml
added_at: 2026-10-28T08:00:00Z
topic_id: software-engineering
reading_reason: |-
  推荐人：李老师
  推荐理由：帮助理解复杂团队中的协作与决策。
  当时情景：项目复盘后讨论到沟通成本。
```

实际 YAML 可能使用等价的引号格式，请用 YAML 解析器读取，不依赖缩进或行序。书目补全时还可能包含 `book_metadata`。未填写原因时没有 `reading_reason` 字段。

分类调整、补书目/封面和索引更新会保留该字段。人在插件书库可以展开查看；后续 Agent 可读取同目录 `meta.yml` 作为背景来源。现有旧书不需要迁移。本次界面只提供导入前填写与书库查看，导入后如需修订可编辑该书 `meta.yml`。

## 9. 返回值与失败处理

同步命令会等待转换、OCR，以及请求的 AI 先读完成。进度与保活日志在 stderr，`--json` 的 stdout 不混入日志。整本书可能耗时较长，调用方应留足执行时间，不要在看到“开始”日志后就报告成功。

普通成功的主要结构：

```json
{
  "ok": true,
  "data": {
    "dest": "/Users/me/Vault/ssot/ebooks/2026-10/一本书",
    "dest_rel": "ssot/ebooks/2026-10/一本书",
    "topic_id": "software-engineering",
    "ocr": false,
    "provider": null,
    "log": []
  }
}
```

`--ai-read` 成功时，另有 `data.imported: true` 和 `data.ai_read`，其中 `status` 为 `"succeeded"`，包含 `agent`、`run_id`、`summary_rel` 和可空的 `index_warning`。阅读原因的持久化依据是 `meta.yml`，不要求在导入结果中回显。

AI 失败但书已导入时：

```json
{
  "ok": false,
  "data": {
    "imported": true,
    "dest": "/Users/me/Vault/ssot/ebooks/2026-10/一本书",
    "dest_rel": "ssot/ebooks/2026-10/一本书",
    "ai_read": {
      "status": "failed",
      "agent": "notemd.codex-agent",
      "error": "具体失败原因"
    }
  }
}
```

该示例省略了常规字段。退出码为 **4**，书籍和阅读原因都已经保存。**不要重新导入**；修复 Agent 后，从书库对已有书籍执行 AI 先读。摘要已生成而索引更新失败时，查看 `index_warning`，无需重跑模型。

其他参数、文件或配置错误返回非零退出码，通常为 `ok:false` 与 `error.message`。机器调用应检查退出码与 `ok`，再检查 `data.imported` 区分部分成功，不能只检查是否有输出。

| 常见问题 | 处理 |
| --- | --- |
| unknown topic / 缺主题目录 | 用相同 Vault/root 查询主题；先在插件管理主题，不猜 ID。 |
| Calibre 不可用 | 安装 Calibre 或配置 `ebook-convert` 路径，不自动改为 OCR。 |
| 百度文件超限 | 压缩或分册到 50,000,000 字节与 500 页以内。 |
| Agent 未安装或不可用 | 配置指定 Agent，或选择已安装的 Agent；检查登录/模型凭证。 |
| AI 目标不是当前 Vault | 先在 note.md 切换 Vault；不带 AI 的普通导入仍可指定其他 Vault。 |
| 分类事务需要恢复 | 先在插件窗口完成分类恢复；不要绕过接口手写管理文件。 |
| AI 失败且 imported 为 true | 保留导入结果，从已有书籍重试先读，不再导入一份。 |

## 10. 可交给 Agent 的操作指令

> 先用 `notemd ebook --list-topics --json` 查询实际主题 ID，再把我指定的书籍用 `notemd ebook` 导入。
> 如果我提供推荐人、推荐理由、当时情景或阅读目标，把原意作为 `--reading-reason` 保存；没有提供就省略，不猜测。
> 只有我要求 OCR 时加 `--ocr`；只有我要求自动先读时加 `--ai-read`，指定 Agent 时再加 `--agent`。
> 等命令结束，检查退出码和 JSON。如果 `data.imported` 为 true 但 AI 失败，报告书已保存，不重复导入。
> 最后给出书籍目录、阅读原因保存位置，以及先读成功时的摘要路径。
