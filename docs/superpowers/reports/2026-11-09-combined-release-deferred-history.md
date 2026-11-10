# 合并发布前的二十条旧说明归档

以已发布基线 `a7f4b35c24cd1fe829ebf20e8f04bf7dbed36c95` 为准，原 Unreleased 的二十条说明不是二十个新的未合入功能：原始提交均已在公开宿主源码历史中，多项独立插件的指定版本也已进入市场。按本轮用户要求不再机械移到下一次 Unreleased；保留原文与来源，避免本次发布重复宣称。既有正式版本历史没有删除或改写。

[逐条中英文原文、提交与市场证据](2026-11-09-combined-release-deferred-history.json)。以下“最早宿主 tag”只证明源码祖先包含关系，不把独立插件或网站代码当作宿主安装包内容。网站上线与旧 Linux 包未在本次重新发布或验收。

| 项 | 旧说明 | 来源提交 | 最早包含源码的宿主 tag |
|---|---|---|---|
| 1 | Sumi 0.1.1 requires note.md 6.1108.2 or later. | `f1bd9bc5` | `v6.1108.3` |
| 2 | NEXT kickoff results stay tied to their Task. | `b7c5edbb` | `v6.1104.1` |
| 3 | Update website agent integrations. | `36adf8ff` | `v6.1104.1` |
| 4 | NEXT 1.13.2: hide empty placed lanes. | `1baf7212` | `v6.1030.1` |
| 5 | NEXT 1.13.1: card actions use compact split buttons. | `f7dd2b8b` | `v6.1030.1` |
| 6 | NEXT 1.13.0 with Codex 1.1.0, DeepSeek 1.2.0 and Claude 1.1.0: the Agent retrieves its own kickoff context. | `167eb330` | `v6.1028.1` |
| 7 | Ebook Import 1.5.6: optional AI reading from the import CLI. | `cfc00686` | `v6.1028.1` |
| 8 | Ebook Import 1.5.6: check Baidu OCR upload limits before sending. | `cfc00686` | `v6.1028.1` |
| 9 | Ebook Import 1.5.5: import books from an Agent or terminal. | `2985619b` | `v6.1028.1` |
| 10 | Claude Agent 1.0.34: “Help me start” now works with Claude. | `9ece513d` | `v6.1028.1` |
| 11 | NEXT 1.12.1: review each background snapshot before sending. | `f97f5b17` | `v6.1028.1` |
| 12 | NEXT 1.12.0: start an in-progress Task with your installed Agent. | `6f0bb356` | `v6.1028.1` |
| 13 | NEXT 1.11.0: “Help me start” on Task cards. | `d6b9a023` | `v6.1028.1` |
| 14 | Agents can manage the same NEXT Tasks through a validated CLI. | `0a77ef37` | `v6.1027.1` |
| 15 | Health Sync 0.1.1: preview a selected export before the first import. | `7d1aa68c` | `v6.1024.1` |
| 16 | Health Sync 0.1.0 (separate Mac plugin): collect one daily health archive. | `dfc64b6f` | `v6.1024.1` |
| 17 | Roam Research Sync 1.2.7: fix large-page stdout pipe deadlocks. | `0841b18f` | `v6.1024.1` |
| 18 | Prioritize Omarchy downloads and provide an ARM64 Arch package. | `bf643f50` | `v6.1024.1` |
| 19 | Website: download the correct Linux architecture. | `e81bd593` | `v6.1024.1` |
| 20 | Refresh product documentation across languages. | `dd56ba03` | `v6.1102.1` |

特别边界：NEXT 1.11/1.12 与旧 Claude 的预扫描快照或禁用 Agent 方案后来被自主检索版本替代，不作为当前并列新能力重发。Health 0.1.1 没有独立市场条目，不能断言该版本曾上架；其源码修复已存在，并有后继 Health 发布。Sumi 0.1.1、旧 NEXT/Agent/Ebook/Roam 版本已有明确市场记录，不能再次当成本轮新插件。

本次新功能说明仅保留 Rich YAML 显示设置、Sumi 五行聚焦和常规提示收起，以及 Sumi 0.1.7 / note.md 6.1109.2 兼容要求。实际发布与验收以后续冻结 tag 和产物报告为准。
