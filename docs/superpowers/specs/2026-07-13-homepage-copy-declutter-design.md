# 首页文案减负（copy-only）— 设计

日期：2026-07-13
范围：仅首页 `website/public/index.html`（及其三语生成产物 zh/de/ja）
风格决策：**混合** — Hero 大标题 / 各 section 斜体 lead / Download 收尾等"金句区"原样保留；密集的两组卡片网格 + sidecar 长 why 砍成"1 句核心（+ 可选半句）"。

## 目标
降低首页认知负荷：正文从"每块 2–3 句"压到 1–2 句，字数削减约 40–50%，让卡片自然透气。不动 CSS / 版式 / 视觉框架。

## i18n 机制约束
英文母版 `public/index.html` 是唯一真源。`build_i18n.py` 内有 `STRINGS` 逐字替换表（英文 key → zh/de/ja）。**每改一句英文，必须同步改替换表里的英文 key + 三条译文**，再跑 `python3 build_i18n.py` 重新生成 `public/{zh,de,ja}/index.html`。

## 删改清单（8 处）
1. **Read like it matters** → "Your agent wrote 4,000 words overnight. Open them clean, mark what's true, question the rest."
2. **Marginalia is data** → "Your marks live in a partner file — `file.note.md`. The AI's text stays clean; your judgment stays yours."
3. **Think in outlines** → "Daily notes, `[[links]]` between pages, search that answers as you type. Ideas connect themselves."
4. **It's just files** → "No database. No cloud. A folder of markdown that outlives every app on your dock — including this one."
5. **sidecar why**（最长）→ "Anyone can generate ten thousand words. No one can generate your opinion of them — **the rarest dataset in the world, and it's sitting on your disk.**"（删末句"agents read your margins…"，该点在 agents 区已有）
6. **AGENTS.md** → "The rules live in the folder, in a file any agent reads. Point Claude Code — or next year's agent — at it. No plugins, no adapters."
7. **Memory that compounds** → "Your daily notes are your agent's memory — years of your thinking, searchable, quoted back to you with receipts."
8. **Write → read → learn** → "Agents write. You mark what matters. They read your marks and write better — the whole loop runs on your disk."

## 不动
Hero（kicker/h1/sub）、三处 section lead、file-card 两句、Download、footer、全部 CSS/版式。

## 交付步骤
1. 改 `public/index.html` 上述 8 处 `<p>` 内文。
2. 同步 `build_i18n.py` 的 8 行 `STRINGS`（英文 key + zh/de/ja 三译）。
3. `cd website && python3 build_i18n.py`，确认 0 unmatched。
4. 抽查 zh 页渲染无残留旧文。
