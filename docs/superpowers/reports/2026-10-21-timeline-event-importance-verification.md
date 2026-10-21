# Timeline 事件重要程度实现验收（2026-10-21）

实现目标为 `docs/superpowers/specs/2026-10-21-timeline-event-importance.md`（基线 ef9535c9）。查看器实现和本轮紧凑标签调整已验证；本次只交付仓库源码，未安装、推送或发布。外部 Vault 与已安装生成 skill 未修改。跨语言完整一致性仍有下述上游扫描差异，不能宣称全链路验收已全部通过。

## 实现

- 严格消费 `event_metadata` 与末尾稳定事件 ID。三档重要程度、独立反常、理由、来源证据、数值和每层事件绑定均验证；任何坏项使整份视图回退 Markdown。旧文档保留 `line-N`，显示待判断。
- Markdown Lexer 识别真实代码块，包含列表中的围栏和缩进代码；示例不被当成事件，伪围栏不能隐藏重复 ID。保留真实多层议题及所有原链接。
- 保留五类活动底色，以独立色条和文字显示重要程度。状态标签与标题同行，时间和时长共用第二行，最短卡片 44px；窄屏卡片宽度受视口限制，重叠事件仍可横向滚动。正文高度不足时不显示半行文字。
- 每层详情展示自己的理由、证据 ID/行号、反常状态及信号；null 与零区分，缺反常不称为正常。旧文档理由使用界面语言。
- 来源保持既有文件导航；界面明确当前宿主不能定位行号。查看器不读取原文、重算字数/耗时、推断身份、打分或改写内容。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Timeline Vitest 全量 | 7 文件，208 项通过 |
| Parser 定向 | 165 项通过，含 114 个共享契约样例 |
| Svelte/TypeScript | 0 错误、0 警告 |
| Vite 生产构建 | 通过，Safari 15 target |
| 生产浏览器 | Chromium 140.0.7339.16；无未捕获异常 |
| 下游已保存判断选材 | 4/4 场景通过 |
| Python 共享样例对比 | 105/114 一致，9 项扫描差异；退出 1，未掩盖为通过 |
| 独立复核 | 代码块问题已修并复核；最终无查看器阻断问题 |
| 差异检查 | `git diff --check` 通过 |

浏览器加载实际生产 bundle，经真实 iframe `file_view.open/ready/fallback` 消息与模拟宿主 RPC 验证；不是原生 Tauri 安装验收。浅色、深色、390px、短/零时长与重叠事件、父子独立判断、unknown 信号、英文长标签、键盘 Enter/Escape 与焦点恢复、来源调用、无效元数据 fallback、旧文档兼容均通过。真实截图在本机 `tasks/timeline-importance-20261021/browser/`，已逐类检查；任务证据目录未纳入版本控制，脚本和合成输入已纳入以便重现。

生产资产 SHA-256：

- `index-ox4gSVFg.css`：`d6ba03774ff7789325c138d2edfaeb28f572b6cd62f3494771c4c53c27d14049`
- `index-oTmZpf74.js`：`c5832b70bab33e1683e6af634e4022102ca8d97e2d82bbd613df8c48ed34958c`

## 生成端边界与差异

只读核对的 Vault SSOT 为 `agent-rules/event-importance.md` 与 `skills/vault-timeline/references/output-contract.md` v2.5。Vault 的 `skills/vault-timeline/scripts/timeline.py` 与本机已安装版本一致；`select` 已实现 selected/pending_review 可重叠、独立异常复核与 meeting_containers。鲁迅日记 skill 已取消每日四件和全文120字上限，本仓库不重复实现生成流程。

上游 Python 2.5.0 自身 9 项测试通过；共享样例校验仍有以下 9 个差异：

- `legacy malformed marker <!-- event e01 -->`：查看器契约应拒绝，Python 接受。
- `legacy malformed marker <!-- EVENT:e01 -->`：查看器契约应拒绝，Python 接受。
- `marker in prose`：查看器契约应拒绝，Python 接受。
- `marker on heading`：查看器契约应拒绝，Python 接受。
- `fenced legacy marker example`：查看器契约应接受，Python 拒绝。
- `fenced malformed legacy marker example`：查看器契约应接受，Python 拒绝。
- `fenced upgraded marker example`：查看器契约应接受，Python 拒绝。
- `independent nested topics`：查看器契约应接受，Python 拒绝。
- `fenced code inside list is not a topic`：查看器契约应接受，Python 拒绝。

这些差异属于畸形/非事件行标记扫描、代码块排除和三级议题识别；没有修改外部工具或删掉失败样例。完整对照命令会退出 1，供后续生成端修复回归。其余样例的等级、反常、证据、理由、信号与绑定一致。

- 上游脚本 SHA-256：`141b3ac5b290b38d5ae6a31ef866263ee0e314df096ce2b479609968ac426ce9`。
- 共享 fixture SHA-256：`040a62c0fee9775c8e49e3fe595a204232803dd9e4e08b3e86d57be53c443cbc`。

四组选材验证使用临时合成目录：七件重要事件全部保留、普通为主不填名额、短而重要的健康/探访/出行保留、父容器去重/普通反常不升级/unknown可追踪/selected与pending可重叠。它证明已保存判断的筛选行为，不证明模型判断或原文事实。已有生成端三天日记新旧稿比较为抽样，未把它冒称完整全日审计。

## 重现

从仓库根目录执行：

```sh
pnpm --filter timeline test
pnpm --filter timeline check
pnpm --filter timeline build
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  TIMELINE_REVIEW_OUTPUT=tasks/timeline-importance-20261021/browser \
  node scripts/check-timeline-importance-browser.mjs
python3 scripts/check-timeline-importance-contract.py \
  --generator-script /path/to/vault-timeline/scripts/timeline.py
python3 scripts/check-timeline-importance-contract.py \
  --generator-script /path/to/vault-timeline/scripts/timeline.py --select-only
```

## 柔和配色补充验收

以上首次实现证据对应提交 `3bff9c90`。本轮按用户要求参考 [Apple HIG Color](https://developer.apple.com/design/human-interface-guidelines/color) 与 [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode) 的语义色和明暗适配原则，使用项目自定义低饱和色值，不称为Apple官方色板。五分类背景/边框变浅、变灰；等级文字与装饰色条分离，重要为暖沙色、普通为雾蓝、待判断为中性灰；反常为灰玫瑰色浅底标签。未改变两行44px卡片布局、解析或判断。

浅色反常文字初版对比度不足，已压深为 `#8c5860`。最终按sRGB亮度计算三档文字×五分类底色及反常徽标，包含hover亮度后的最小对比度：浅色等级5.12、反常4.63，深色等级6.41、反常5.17；均超过4.5:1。色条仅作辅助，等级仍有文字。

208项插件测试、check 0错误0警告、生产构建、相同生产浏览器验收全部通过。已实看浅/深/390px/英文长标签截图，颜色柔和且标签未溢出。本机证据：`tasks/timeline-palette-20261021/browser/` 和 `contrast.json`。未安装、未push、未发布。外部Python扫描差异未被本轮配色改动处理。

本轮生产资产SHA-256：

- `index-B-Es091F.js`：`c5832b70bab33e1683e6af634e4022102ca8d97e2d82bbd613df8c48ed34958c`
- `index-D5mMftNJ.css`：`aeafae9ce2dae5bd4f46bd7487d7ac55c0e0a01ef4b77c9f348172112a620b51`
