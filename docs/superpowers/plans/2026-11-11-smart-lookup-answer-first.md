# Smart Lookup answer-first: implementation plan

> For agentic workers: run this with superpowers:subagent-driven-development. Every task follows TDD: write the failing test, implement, then commit.

**Goal:** apply the user's product principle to the Smart Lookup window: *the user is busy and only wants valid, relevant results — a question answered correctly, unambiguously and with evidence — and wants to do nothing else.* One Return gives a grounded, cited answer automatically. Only relevant sources are shown, and there are no per-search operations.

**Source of truth for the look and copy:** the 9 design boards, copied to `.superpowers/sdd/2026-11-11-smart-lookup-answer-first/design/`: `Launch`, `Working`, `Main`, `Ambiguous`, `NoAnswer`, `Fallback`, `Settings`, `Indexing`, `Compact` (`.dc.html`). The blue notes in `canvas.json` there give each board's technical points. The visible text on the boards is binding copy. Sample data (names, numbers) is not.

**Base:** branch `feat/smart-lookup-answer-first`, from `feat/smart-lookup-sag2` at ff5b0e9 (SAG2 multi-round evidence, cited answer, run totals; all merged).

## User rulings (2026-11-11)

- **A. Automatic answer.** When the evidence rounds finish and the answer model's host is allowed, the window calls `smart_lookup_answer` by itself. There is no "生成简答" button. If that host is not allowed, the window shows the confirmed sources and one line saying no answer was written, with a "设置" link.
- **B. Ambiguity.** Append one sentence to `ANSWER_SYSTEM`, after the SAG2 text: 「问题可能指不同对象时，分别回答并说明区别。」 This is a declared deviation from SAG2; record it in spec H.5.
- **C. Correction.** 「这条判断对吗」 moves from the preview pane into the ⌘K actions menu, as two actions on the selected row: 「标为符合」 and 「标为不相关」. It still writes only to the local feedback file.

## Behaviour (binding)

1. **Return.**
   - Local results show at once, as today.
   - Evidence rounds start automatically under the existing rules: `shouldStartEvidence`, one automatic claim per run, consent per host.
   - When the rounds are `done`, the answer starts automatically (ruling A), using the evidence ids on screen.
2. **Progress (Working board).**
   - The query bar's right side shows 「正在找依据 · N 秒」.
   - The answer area shows three steps: 「本机找到 N 条」 → 「逐段核对是否有依据 · 已确认 N 处」 → 「写回答」.
   - "已确认 N 处" is the count of `fit` items in the latest completed round. No host change is needed.
   - Local results stay listed under 「本地结果 · 可以先看」 until the answer arrives.
   - esc stops, as today. The footer shows 「正在发送到 {hosts} · 保密笔记不发送」.
3. **Answer (Main board).**
   - The answer text is on top, under the label 「回答」. Citations render as small numbered chips that link to sources.
   - 「依据」 lists the sources the answer cites, in citation-number order, numbered to match.
   - Clicking a number or a source row shows that passage in the right pane (the existing preview), with the cited lines marked.
   - Everything else goes behind a closed 「其他结果 N 条」 disclosure: fit-but-uncited evidence first, then local results.
     - The list is deduplicated: a block already shown as a source or as evidence is not listed again (same path + line range).
     - Rows tiered `unfit` are not shown anywhere.
4. **Status chip** (query bar, right):
   - 「有依据 · N 处」, where N is the number of distinct cited sources;
   - 「没有依据」;
   - 「只有本地结果」.
5. **Footer.**
   - Passive line, with no click: 「本次发送到 {host1}、{host2} · 共 N 段 · 保密笔记未发送」.
   - The hosts are the Jev host and, if an answer was requested, the answer host.
   - N is the run's `sentBlocks` total. The answer's sources are a subset of the evidence, so they are not counted twice.
   - Right side: 「esc 关闭」 (「esc 停止」 while working).
6. **No answer (NoAnswer board).**
   - Shown when the rounds are done and no shown evidence is `fit`. No answer request is sent.
   - Text: 「笔记里没有找到能回答这个问题的内容。」 plus 「换个你记得的原词再问，可能更快找到。」
   - A passive 「已经自动试过」 list of the steps that actually ran, each with its count. Steps: local search; rephrase and re-search (only on zero local hits, as today, and automatic); line-by-line scan.
   - With zero local hits, rephrase is automatic (existing route) and, if still zero, the line-by-line scan is automatic too. Set `autoDeepOnZero` to default `true`.
   - With local hits but no fit evidence, no repair or scan runs (repaired results would not be verified). The list shows only the steps that ran.
   - Unfit rows go behind 「其他结果 N 条（都不相关）」.
7. **Fallbacks (Fallback board).** Exactly one line above the local results (or above the confirmed sources), no buttons, re-pressing Return retries:
   - not configured: 「未开启查找增强，只显示本地结果。」 with a 「设置」 link;
   - no consent for the Jev host: 「没有允许发送到 {host}，只显示本地结果。」 with a 「设置」 link;
   - timeout, unreachable, key refused or invalid: 「没能确认依据：{host} {reason}。下面是本机按相关度排的结果，再按一次回车会重试。」;
   - answer host not allowed (ruling A): 「没有允许发送到 {host}，没有写回答。」 with a 「设置」 link, shown above the confirmed sources;
   - answer invalid, out of budget or failed: 「没能写出有依据的回答，下面是确认过的依据。」
   - Only the host name and the reason class are ever shown.
8. **Ambiguity (Ambiguous board).** No UI of its own. The prompt sentence (ruling B) makes the model answer each reading separately, with its own citations.
9. **Removed from the window.** Remove each of these, with its copy and its tests:
   - the criterion chip and the time-mode chip with its menu. Time phrases still group and prioritise automatically, as today.
   - the expansion-terms lines and the round badges (本地 / 第 N 轮扩展);
   - 「恢复到本地 / 第 N 轮」;
   - 「顺序有更新 · 应用」 (⌘R). Rounds now apply as they arrive, and the selection stays on its row if that row is still present;
   - the 「证据」 details popover, replaced by the footer line;
   - the 「生成简答」 button;
   - 「换个说法」 on no-evidence;
   - the editable wordings A/B and 「用这些说法再搜」 in RepairStrip. The repair result can still be shown passively, or folded into the NoAnswer list;
   - the NoMatch panel buttons (改写问题 ⌘L, 编辑说法, 查看/扩大), replaced by the passive list;
   - the first-run explainer (Task C);
   - the preview-pane correction (moved to ⌘K by ruling C).
10. **Unchanged.**
    - Privacy: sendable_block, consent per host, keys, confidential handling, and no remote text except the answer as plain text.
    - The CLI and eval (`notemd lookup`).
    - The host commands' contracts, except where this plan names a change.
    - The narrow window (Compact board) follows the same single-column order: answer → sources (the selected one expands inline) → 其他结果.

## Tasks

### Task A: prompt, defaults, spec and docs (Rust plus docs; runs in parallel with B)
- `src-tauri/src/smart_enhance/answer.rs`:
  - append the ruling-B sentence to `ANSWER_SYSTEM`;
  - update the SAG2 message test so it states the deviation explicitly: the SAG2 text is a prefix and the added sentence is the suffix.
- `src/lib/smart-search/settings.ts`: `autoDeepOnZero` defaults to `true`, and its test follows. B does not touch this file.
- Spec `docs/superpowers/specs/2026-11-10-smart-lookup-local-first-feasibility-design.md`:
  - add an Appendix I, "answer-first window (2026-11-11)", summarising this plan's behaviour and rulings;
  - amend H.4 (automatic answer after consent);
  - amend H.5 (the prompt sentence);
  - amend H.8 (the UI this plan supersedes).
  - Keep the document's Chinese style.
- `docs/smart-lookup-parameters.md`: correct anything this plan changes (autoDeepOnZero, the answer trigger).
- Both CHANGELOGs, Unreleased:
  - rewrite the Evidence and answer bullets for the answer-first behaviour, user-facing, in zh and en;
  - `node scripts/changelog.mjs check` must pass.

### Task B: the answer-first window (frontend; the large task)
Files:
- `src/SmartLookupApp.svelte`;
- `src/lib/smart-search/{evidence-flow.ts, enhance-flow.ts, api.ts, lookup-view.ts}` as needed;
- `src/components/smart-lookup/{NoMatchPanel,RepairStrip}.svelte`;
- `src/lib/i18n/{zh,en,de,ja}.ts` and `src/lib/i18n/store.test.ts` (removed keys go on the removed-copy list);
- `src/SmartLookupApp.test.ts` and the smart-search tests.

Implement behaviour 1–9, except the first-run explainer and Settings, which are Task C.

Pure logic belongs in `evidence-flow.ts` or a new small module, with unit tests:
- the source list built from the answer's citations;
- the dedupe;
- the 其他结果 contents;
- the status chip;
- the footer line;
- the NoAnswer decision.

The window tests must cover:
- the auto answer starting only after `done` and only with consent;
- no answer request when nothing is fit;
- the dedupe;
- unfit rows hidden;
- the fallback lines;
- the ⌘K correction;
- esc stopping both evidence and answer.

Run `svelte-check` (0 errors, 31 warnings baseline) and the vitest set:

```
vitest run src/lib/smart-search src/SmartLookupApp.test.ts src/lib/i18n src/components/SettingsDialog.search-tab.test.ts
```

### Task C: Settings and Launch (frontend, after B)
- `SettingsDialog.svelte` lookup-enhancement tab, following the Settings board's copy:
  - the switch title becomes 「回车直接给出有依据的回答」, with its hint;
  - the section titles become 「核对依据 · Jev」 and 「写回答与换说法 · OpenAI 兼容接口」;
  - the budget line now includes 「再写 1 次回答」;
  - the request example collapses behind 「查看发送内容示例」 (closed by default);
  - the answer-host consent hint becomes 「每次回答发送问题和依据段落…」.
- `LaunchView.svelte` and its call site: remove the first-run explainer. Keep `firstRunSeen` readable for old settings, but stop showing the explainer.
  - The placeholder becomes 「问一个问题」 and the Return hint becomes 「回答」.
  - The footer chip text becomes 「有依据的回答 · 已开启」 when on.
- i18n in all four languages; tests.

## Verification (controller, main tree, after each merge)

- Rust:

  ```
  cargo test --manifest-path src-tauri/Cargo.toml --lib -- smart_enhance lookup_params search:: cli::lookup smart_lookup smart_model
  ```

- vitest:

  ```
  vitest run src/lib/smart-search src/SmartLookupApp.test.ts src/lib/i18n src/components/SettingsDialog.search-tab.test.ts
  ```

- `svelte-check`, plus `node scripts/changelog.mjs check`.
