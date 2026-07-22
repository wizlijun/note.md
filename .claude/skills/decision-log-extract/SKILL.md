---
name: decision-log-extract
description: Use when turning a day's raw content (voice transcripts, daily notes, chat/meeting logs) into decision-log candidate JSON (vault/diary/YYYY-MM-DD-decision.json) — surfacing new decisions, verdict suggestions for due/triggered open decisions, and progress-driven updates to open decisions.
---

# Decision Log — Daily Decision Pipeline

## Overview

Turn a day's raw content + the user's current open decisions into ONE candidate JSON for the note.md "Decision Log" plugin. You produce three kinds of entries and **output pure JSON, nothing else**:

1. **`new_candidates`** — new decisions the user made in the content.
2. **`closures`** — verdict suggestions for open decisions that are **due or triggered**.
3. **`edit_decisions`** — progress/breakthrough/resolved/abandoned updates for open decisions the content speaks to (not yet due).

Core principle: **you nominate/suggest, the user decides.** Never invent the user's prediction, confidence, or verdict.

## Inputs

- `date` — `YYYY-MM-DD`.
- `content` — the day's material (transcripts/notes/logs), ideally with speaker, time, `conv_id`.
- `open_decisions` — from `vault/decision/open.decision.note.md` front-matter `decisions[]`; each has `id`, `title`, `prediction`, `check-date`, optional `triggers`.

## Hard rules (violating any = failure)

1. **Never fabricate.** `quoted` = user voiced an expectation → quote verbatim. `nominated` = sounds like a decision but no expectation → `prediction` is a **question** or `null`, never an invented assertion. Same for verdicts/updates: surface, don't decide.
2. **Rather omit than pad.** Only real decisions + real developments. Chit-chat, facts, to-dos are NOT decisions. Nothing today → empty arrays. Normal.
3. **Unsure → leave empty / omit.** `confidence` stays `null` unless the user's words show it; `state` omitted if unknown.
4. **One open decision → at most one array per day.** Due/triggered → `closures`; else content shows a development → `edit_decisions`; else leave it. Never both.
5. **Don't over-close.** Only `resolved`/`abandoned` get terminal actions (close-*/drop). Mere progress → `note`, keep it open.
6. **Output must be `JSON.parse`-able** — no prose, no markdown fences.

## Output shape

```json
{
  "date": "2026-07-22",
  "generated_by": "openclaw",          // producer name; else "agent"
  "new_candidates": [
    { "id": "cand-2026-07-22-01", "title": "…",
      "prediction_source": "quoted|nominated",
      "quote": "…",                    // REQUIRED iff quoted, verbatim
      "prediction": "…",               // quoted: falsifiable expectation. nominated: a QUESTION or null
      "confidence": "low|medium|high|null",  // only if user's words show it
      "check_date": "YYYY-MM-DD|null",
      "triggers": [{ "if": "…", "source": "openclaw" }],   // optional
      "state": { "time": "…", "speech_rate": "slow|normal|fast", "calendar_density": "low|medium|high" }, // omit if unknown
      "source": { "conv_id": "…", "quote": "…", "time": "…" },
      "status": "pending" }
  ],
  "closures": [
    { "decision_id": "…", "reason": "due|trigger",         // due = check-date<=today; trigger = a listed trigger fired
      "suggested_outcome": "hit|partial|miss",             // suggestion; omit if unsure
      "evidence": [{ "conv_id": "…", "quote": "…" }],
      "status": "pending" }
  ],
  "edit_decisions": [
    { "decision_id": "…", "kind": "progress|breakthrough|resolved|abandoned",
      "summary": "…",
      "suggested_action": "note|adjust-check-date|close-hit|close-partial|close-miss|drop",
      "new_check_date": "YYYY-MM-DD|null",                 // only when adjust-check-date
      "evidence": [{ "conv_id": "…", "quote": "…" }],
      "status": "pending" }
  ]
}
```

Every `status` is `"pending"`. `kind → suggested_action`: progress→`note` (or `adjust-check-date`+`new_check_date` if timeline shifted) · breakthrough→`note` · resolved→`close-hit`/`close-partial`/`close-miss` · abandoned→`drop`.

## Example

**Input**
```
date: 2026-07-22
content:
  [08:12 cv_1 user] "决策日志我觉得两周内能发出可用版本。"      # new decision, voiced expectation
  [11:00 cv_1 user] "也许该把每周例会砍了。"                  # new decision, no expectation
  [14:20 cv_2 user] "记得给设计发反馈。"                      # to-do → skip
  [16:00 cv_2 user] "上周那个迁移昨天到期,一直稳,没回滚。"    # open A, DUE → closure
  [17:30 cv_2 user] "多语言今天把 i18n 框架跑通了,大进展。"    # open B, not due, breakthrough → edit
  [19:00 cv_2 user] "上新定价那个方案我们决定不搞了。"          # open C, not due, abandoned → edit
open_decisions:
  - { id: "2026-07-08-01", title: "上线迁移方案", prediction: "上线后不回滚", check-date: "2026-07-22" }
  - { id: "2026-07-15-01", title: "做多语言支持", prediction: "Q3 上线三语", check-date: "2026-09-30" }
  - { id: "2026-07-05-02", title: "上新定价", prediction: "月流水+10%", check-date: "2026-08-01" }
```

**Output**
```json
{
  "date": "2026-07-22",
  "generated_by": "openclaw",
  "new_candidates": [
    { "id": "cand-2026-07-22-01", "title": "先做决策日志 MVP", "prediction_source": "quoted",
      "quote": "决策日志我觉得两周内能发出可用版本", "prediction": "两周内发出可用 MVP",
      "confidence": null, "check_date": "2026-08-05",
      "source": { "conv_id": "cv_1", "quote": "我觉得两周内能发出可用版本", "time": "08:12" }, "status": "pending" },
    { "id": "cand-2026-07-22-02", "title": "砍掉每周例会", "prediction_source": "nominated",
      "prediction": "砍掉每周例会后会更好吗?", "confidence": null, "check_date": null,
      "source": { "conv_id": "cv_1", "quote": "也许该把每周例会砍了", "time": "11:00" }, "status": "pending" }
  ],
  "closures": [
    { "decision_id": "2026-07-08-01", "reason": "due", "suggested_outcome": "hit",
      "evidence": [{ "conv_id": "cv_2", "quote": "上周那个迁移昨天到期,一直稳,没回滚" }], "status": "pending" }
  ],
  "edit_decisions": [
    { "decision_id": "2026-07-15-01", "kind": "breakthrough", "summary": "i18n 框架跑通,多语言取得关键进展",
      "suggested_action": "note", "new_check_date": null,
      "evidence": [{ "conv_id": "cv_2", "quote": "多语言今天把 i18n 框架跑通了,大进展" }], "status": "pending" },
    { "decision_id": "2026-07-05-02", "kind": "abandoned", "summary": "定价方案决定不做了",
      "suggested_action": "drop", "new_check_date": null,
      "evidence": [{ "conv_id": "cv_2", "quote": "上新定价那个方案我们决定不搞了" }], "status": "pending" }
  ]
}
```

Why: migration is **due today** → `closures` (not also edit_decisions). Multilingual is **not due but a breakthrough** → `edit_decisions` with `note` (stays open — don't close on a breakthrough). Pricing is **not due but abandoned** → `edit_decisions` with `drop`. The to-do is skipped.

## Common mistakes

- Confident `prediction` for a `nominated` item (must be a question/null).
- Filling `confidence` because it "feels" medium — only from the user's words.
- Putting the same `decision_id` in both `closures` and `edit_decisions`.
- Closing (close-*/drop) on mere progress — only `resolved`/`abandoned` get terminal actions.
- Inventing a `state` snapshot — omit if unknown.
- Wrapping JSON in ```` ```json ```` fences or adding commentary.

Full contract (note.md repo): `docs/decision-log-agent-prompt.md` / spec `docs/2026-07-21-decision-log-spec.md` §6.1.
