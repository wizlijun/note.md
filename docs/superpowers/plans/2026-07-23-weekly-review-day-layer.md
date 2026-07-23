# Weekly Review — Day Layer + Fill-Viewport (expansion plan)

> Expansion on the shipped weekly-review plugin (already merged to main). Reverses the earlier "no diary" decision per new user request.
> Data patterns verified against vault `/Users/bruce/git/sotvault`:
> - diary: `diary/YYYY-MM-DD-diary<...>.md` (flat, one+ per day)
> - dailynote: `dailynote/YYYY/YYYY-MM-DD.note.md` (nested by year)
> - weekly-review: `weekly-review/YYYY-Www-weekly-review.md`

**Goal:** Day-level overlays on the year calendar: a day whose `diary/` has an entry shows its number as a clickable link (opens the diary); a day with a `dailynote/YYYY/…​.note.md` shows a small **flat orange sparkle-star (no glow)** that opens the note outline; clicking a week row anywhere else opens that week's review. Window fills the viewport with NO scrollbar. All three scans (weekly-review, diary, dailynote) are cached. Everything opens via the existing `host.editor.open` — no new host API.

## Tasks

### E1 — scan.ts: diary + dailynote indices (TDD)
Add to `plugins-src/weekly-review/src/lib/scan.ts`:
- `export const DIARY_DIR = 'diary'`, `export const DAILYNOTE_DIR = 'dailynote'`.
- `parseDiaryName(name): string | null` — regex `^(\d{4})-(\d{2})-(\d{2})-diary.*\.md$` → date key `YYYY-MM-DD`.
- `parseDailyNoteName(name): string | null` — regex `^(\d{4})-(\d{2})-(\d{2})\.note\.md$` → `YYYY-MM-DD`.
- `buildDayIndex(entries, dirPrefix, parse): Map<string,string>` — date→`${dirPrefix}/${name}`, first-wins for duplicate dates, skips dirs/non-matches.
- `yearsWithData(reviewIndex, diaryMap, noteYears): number[]` helper OR compute the union in App. (Keep union logic in App; scan just parses.)
Tests: diary/dailynote parse (valid, wrong-suffix, junk), buildDayIndex (dedup first-wins, dir prefix, skips dirs).

### E2 — cache.ts: generalize with a `kind` namespace (TDD)
Change signatures to `loadCache(vaultRoot, kind)` / `saveCache(vaultRoot, kind, entries)`; key = `weekly-review:cache:${kind}:${vaultRoot}`. Update existing tests + add a kind-isolation test. (App will use kinds `weekly-review`, `diary`, `dailynote:<year>`.)

### E3 — strings.ts: add day-layer keys
Add MessageKeys + en/zh/ja/de: `legend.diary` ("有日记(点数字)"/…), `legend.note` ("有笔记(点图标)"/…), `tip.diary`, `tip.note`. Keep `重构` for rebuild (user's word).

### E4 — UI: day overlays, 3-zone click, fill-viewport, flat star
- `WeekRow.svelte`: per day render `<span class="num">` (link when `diaryIndex.get(dateKey)`) + flat orange sparkle-star SVG (no glow) when `noteIndex.get(dateKey)`. Click zones: number → open diary (stopPropagation), star → open note (stopPropagation), row background → open review (existing). Props gain `year`, `month0`, `diaryIndex`, `noteIndex`. Star SVG path: `M12 .5 C12.8 7.2 16.8 11.2 23.5 12 C16.8 12.8 12.8 16.8 12 23.5 C11.2 16.8 7.2 12.8 .5 12 C7.2 11.2 11.2 7.2 12 .5Z`, `fill: var(--note)`, ~11px, no `filter`.
- `MonthGrid.svelte` / `YearCalendar.svelte`: thread `diaryIndex`, `noteIndex` (Map<dateKey,string>) through.
- `App.svelte`: load all three (weekly-review + diary flat + dailynote for selected year), cache each; `ensureYear(year)` loads that year's dailynotes (cache-first + live) on init and on every year change (chips/arrows/This week) — plain function, NOT `$effect` (avoid the untrack loop trap). Year selector = union of review years + diary years + dailynote years (list `dailynote/` subdirs). Fill-viewport CSS: root `height:100vh; overflow:hidden; flex column`; `.cal` grid 4×3 `flex:1; min-height:0`; months/weeks/wk `flex:1; min-height:0`. New CSS vars `--link`, `--note` (light+dark). Legend adds diary + note entries.

### E5 — verify + rebuild
`pnpm --filter weekly-review test` + `check` (0/0) + `build`; `(cd src-tauri && cargo test --lib plugin_runtime)` sanity (unchanged); `scripts/dev-install-plugin.sh weekly-review`. Then hand GUI re-verify to user.

## Notes
- No new host API; diary/note/review all open via `openInEditor(path)`.
- `.note.md` opened in the main editor renders as its outline (native format).
- After merge, publish still gated on an app release carrying `host.editor.open` (see [[project_weekly_review_plugin]]).
