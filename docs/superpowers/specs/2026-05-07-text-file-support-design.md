# mdeditor — Text File Editing Support

**Date:** 2026-05-07
**Status:** Approved (brainstormed)
**Owner:** bruce@hemory.com
**Builds on:** `2026-05-07-mdeditor-design.md` (initial mdeditor app)

## Goal

Extend mdeditor from "markdown only" to "any common plain-text file plus HTML", with sensible mode defaults and content-aware rich rendering. Stay aligned with the existing minimal-app philosophy; preserve byte-stable saves wherever possible.

## Locked-in decisions

| Decision | Choice |
|---|---|
| Q1 — Supported file types | **B** — whitelist (~36 extensions + 4 filename matches) |
| Q2 — HTML rich mode semantics | **B** — sandboxed iframe preview (read-only); source mode is the only editor |
| Q3 — Default mode per kind | markdown: source (or recent); html: rich; code: source |
| Code-kind rich mode | Wrap content in fenced ` ```<lang>...``` ` and feed to `@moraya/core`; hljs colors via existing core integration |

## File classification

Three kinds:
- `markdown` — md / markdown / mdown / mkd
- `html` — html / htm
- `code` — everything else in the whitelist (programming languages, config, structured data, plain text, log)

For code, a `language` string is also assigned per extension and fed into the fenced block (so hljs picks the right lexer).

## §1 Data flow

Reading a file:

```
classifyPath('foo.py') → { kind: 'code', language: 'python' }
        ↓
readMd(path) → raw bytes as string
        ↓
looksBinary(content) ? → reject + toast
        ↓
Tab {
  kind: 'code',
  language: 'python',
  currentContent: <raw>,
  initialContent: <raw>,
  mode: getRecentMode(path) ?? defaultModeFor(kind),
}
```

`defaultModeFor`:

```ts
function defaultModeFor(kind: FileKind): Mode {
  return kind === 'html' ? 'rich' : 'source'
}
```

(Markdown defaults to source per the original mdeditor spec.)

### Source mode (all kinds)

`SourceView.svelte` unchanged. Renders raw `tab.currentContent` in a textarea with line numbers + heading colors (heading rule only matters for markdown; harmless for code/html).

### Rich mode dispatch

`EditorPane.svelte` switches on `tab.kind`:

```svelte
{#if tab.mode === 'source'}
  <SourceView value={tab.currentContent} oninput={onSourceInput} />
{:else if tab.kind === 'html'}
  <HtmlPreview html={tab.currentContent} />
{:else}
  <RichEditor
    {tab}
    onFlush={onRichFlush}
    wrapAsCodeBlock={tab.kind === 'code' ? (tab.language ?? '') : undefined}
  />
{/if}
```

### Code-kind rich serialization

`RichEditor.svelte` accepts `wrapAsCodeBlock?: string` (undefined for markdown, language tag for code).

```ts
// On mount
const initial = wrapAsCodeBlock !== undefined
  ? wrapAsCodeBlock
    ? '```' + wrapAsCodeBlock + '\n' + tab.currentContent + '\n```'
    : '```\n' + tab.currentContent + '\n```'
  : tab.currentContent

mountRichEditor(host, initial, (md) => {
  const raw = wrapAsCodeBlock !== undefined ? stripCodeFence(md) : md
  setContent(tab.id, raw)
})
```

`code-fence.ts`:

```ts
export function stripCodeFence(md: string): string {
  const lines = md.split('\n')
  if (lines.length >= 3
      && lines[0]!.startsWith('```')
      && lines[lines.length - 1]!.trim() === '```') {
    return lines.slice(1, -1).join('\n')
  }
  // Fallback: user edited rich view in a way that broke the single-fence
  // structure (e.g. added a paragraph above). Return md as-is to avoid
  // data loss; hljs may not match the language on next render.
  return md
}
```

### HTML rich mode

`HtmlPreview.svelte` is ~30 lines: a single `<iframe>` with `sandbox` (no `allow-scripts`) and `srcdoc={tab.currentContent}`. Read-only. No `onChange`. Saving in this mode is a no-op (current content is already on disk if previously saved).

## §2 Repository changes

```
src/lib/
├── fs.ts                       # MODIFY: EXT_TABLE / NAME_TABLE / classifyPath / looksBinary; isSupportedPath replaces isMarkdownPath
├── tabs.svelte.ts              # MODIFY: Tab adds {kind, language}; openFile classifies; defaultModeFor
├── editor-bridge.ts            # MODIFY: mountRichEditor signature accepts initialContent: string
├── code-fence.ts               # NEW: stripCodeFence + buildFencedBlock helpers
src/components/
├── EditorPane.svelte           # MODIFY: switch on tab.kind
├── RichEditor.svelte           # MODIFY: wrapAsCodeBlock prop + initialContent computation + onChange strip
├── HtmlPreview.svelte          # NEW: <iframe sandbox srcdoc>
src/lib/dialogs.ts              # MODIFY: pickOpenFile filters expanded; pickSaveFile uses current ext
src-tauri/tauri.conf.json       # MODIFY: fileAssociations += html / htm
```

New files: 2 (`code-fence.ts`, `HtmlPreview.svelte`).
Modified files: 6.
Net new LOC: ~150.

## §3 Extension → kind + language tables

```ts
// src/lib/fs.ts

export type FileKind = 'markdown' | 'html' | 'code'

const EXT_TABLE: Record<string, { kind: FileKind; language?: string }> = {
  // markdown
  md:        { kind: 'markdown' },
  markdown:  { kind: 'markdown' },
  mdown:     { kind: 'markdown' },
  mkd:       { kind: 'markdown' },

  // html
  html:      { kind: 'html' },
  htm:       { kind: 'html' },

  // plain text (no syntax highlight)
  txt:       { kind: 'code', language: '' },
  log:       { kind: 'code', language: '' },
  csv:       { kind: 'code', language: '' },
  tsv:       { kind: 'code', language: '' },
  env:       { kind: 'code', language: '' },

  // structured data
  json:      { kind: 'code', language: 'json' },
  jsonc:     { kind: 'code', language: 'json' },
  yaml:      { kind: 'code', language: 'yaml' },
  yml:       { kind: 'code', language: 'yaml' },
  toml:      { kind: 'code', language: 'ini' },
  ini:       { kind: 'code', language: 'ini' },
  conf:      { kind: 'code', language: 'ini' },
  xml:       { kind: 'code', language: 'xml' },

  // shell
  sh:        { kind: 'code', language: 'bash' },
  bash:      { kind: 'code', language: 'bash' },
  zsh:       { kind: 'code', language: 'bash' },

  // languages
  py:        { kind: 'code', language: 'python' },
  js:        { kind: 'code', language: 'javascript' },
  mjs:       { kind: 'code', language: 'javascript' },
  cjs:       { kind: 'code', language: 'javascript' },
  ts:        { kind: 'code', language: 'typescript' },
  tsx:       { kind: 'code', language: 'typescript' },
  jsx:       { kind: 'code', language: 'javascript' },
  rs:        { kind: 'code', language: 'rust' },
  go:        { kind: 'code', language: 'go' },
  java:      { kind: 'code', language: 'java' },
  c:         { kind: 'code', language: 'c' },
  cpp:       { kind: 'code', language: 'cpp' },
  cc:        { kind: 'code', language: 'cpp' },
  h:         { kind: 'code', language: 'c' },
  hpp:       { kind: 'code', language: 'cpp' },
  rb:        { kind: 'code', language: 'ruby' },
  swift:     { kind: 'code', language: 'swift' },
  kt:        { kind: 'code', language: 'kotlin' },
  php:       { kind: 'code', language: 'php' },
  cs:        { kind: 'code', language: 'csharp' },

  // styles
  css:       { kind: 'code', language: 'css' },
  scss:      { kind: 'code', language: 'scss' },

  // sql
  sql:       { kind: 'code', language: 'sql' },
}

const NAME_TABLE: Record<string, { kind: FileKind; language?: string }> = {
  dockerfile: { kind: 'code', language: 'dockerfile' },
  makefile:   { kind: 'code', language: 'makefile' },
  rakefile:   { kind: 'code', language: 'ruby' },
  gemfile:    { kind: 'code', language: 'ruby' },
}

export function classifyPath(path: string): { kind: FileKind; language?: string } | null {
  const base = basename(path).toLowerCase()
  if (NAME_TABLE[base]) return NAME_TABLE[base]
  const ext = base.split('.').pop()?.toLowerCase()
  if (ext && EXT_TABLE[ext]) return EXT_TABLE[ext]
  return null
}

export function isSupportedPath(path: string): boolean {
  return classifyPath(path) !== null
}

export function looksBinary(s: string): boolean {
  const sample = s.slice(0, 8192)
  if (sample.indexOf('\0') >= 0) return true
  let nonText = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c < 9 || (c > 13 && c < 32)) nonText++
  }
  return sample.length > 0 && nonText / sample.length > 0.05
}
```

`isMarkdownPath` is removed; all call sites use `isSupportedPath`.

## §4 Error handling

| Scenario | Behavior |
|---|---|
| Unsupported extension via Cmd+O | dialog filter prevents selection |
| Unsupported extension via drag-drop | toast: `Unsupported: <ext>`, no tab opened |
| Read fails | errorDialog (existing behavior), no tab |
| File reads OK but contains NUL or >5% non-printable in first 8KB | toast: `Binary file not supported`, no tab |
| File size > 5 MB | native confirm: `File is large (X MB). Continue? Performance may degrade.`; user can cancel |
| Code rich → user edits in a way that breaks single-fence structure | `stripCodeFence` returns md as-is (no data loss; potential lang mismatch on next mount) |
| HTML contains `<script>` | iframe `sandbox` (no `allow-scripts`) → script does not execute |
| HTML rich → user presses Cmd+S | no-op (currentContent unchanged); does not error |

## §5 Save flow

| Kind | source mode save | rich mode save |
|---|---|---|
| markdown | write `currentContent` (md) | flush PM → md → write |
| code | write `currentContent` (raw) | flush PM → md → `stripCodeFence` → raw → write |
| html | write `currentContent` (raw HTML) | no-op (rich is read-only); user must switch to source to edit |

`saveAs` retains current extension as default filter; Save dialog allows changing to any supported ext (post-save the new path is re-classified — kind/language may flip if user changes ext).

## §6 Testing

### Unit tests (vitest)

`src/lib/fs.test.ts` — NEW:
- `classifyPath('foo.md')` → markdown
- `classifyPath('foo.py')` → code/python
- `classifyPath('Dockerfile')` → code/dockerfile (filename match)
- `classifyPath('foo.unknown')` → null
- `classifyPath('FOO.PY')` → matches case-insensitive
- `isSupportedPath` positive + negative cases
- `looksBinary('hello world')` → false
- `looksBinary('hello\0bin')` → true
- `looksBinary('\xff\xfe\x00\x01...random bytes')` → true

`src/lib/code-fence.test.ts` — NEW:
- `stripCodeFence("```python\\nx=1\\n```")` → `'x=1'`
- `stripCodeFence("```\\ntext\\n```")` → `'text'` (no lang)
- `stripCodeFence("plain content")` → `'plain content'` (fallback)
- `stripCodeFence("# header\\n\\n```py\\nx\\n```")` → returns input as-is (extra prose above)

`src/lib/tabs.test.ts` — extend (existing 14 tests stay):
- openFile `.py` → `tab.kind === 'code'` && `tab.language === 'python'`
- openFile `.html` → `tab.kind === 'html'` && `tab.mode === 'rich'`
- openFile binary fixture (mock readMd → string with `\0`) → throws `Binary file not supported`
- openFile unsupported ext (`.png`) → throws `Unsupported`

### Manual smoke (append to README, items 15–20)

15. Open `.py` file → source view shows raw; switch to rich → renders as Python-highlighted code block
16. Open `.html` file → opens in rich (iframe preview); switch to source → edit raw HTML
17. Open `Dockerfile` (no extension) → classified as `code/dockerfile`
18. Drag `.png` into window → toast rejects
19. Open 6 MB log file → confirm dialog appears; user can cancel
20. Code rich mode: edit code block content → Cmd+S → reopen file → contents match (round-trip byte-stable when fence intact)

## §7 Out of scope

- Multi-language detection from content (only filename-based)
- Custom hljs language packs beyond what `@moraya/core` already preloads
- Rich-mode HTML editing (Q2 chose preview-only)
- Soft wrap in source mode (still `white-space: pre`, horizontal scroll on long lines)
- New File / Empty buffer (still no, per original spec)
- Open Recent submenu (still deferred from original spec)

## §8 Risks & verification

1. **Code-block-view editability** — `@moraya/core`'s code-block-view should let users type inside the fenced block in rich mode. Verify in dev that pressing Enter / typing inside the rendered code block works without breaking out.
2. **Round-trip stability for code rich** — typing in code block adds tokens to `node.attrs.source`; serialization should produce the same fence shape. Verify with a sample file: open .py, switch to rich, type a line, switch to source, see the new line in raw form.
3. **HLJS language coverage** — `@moraya/core` preloads ~38 hljs languages (see `src/setup.js`). Our table sticks to those; verify each mapped language exists in the preloaded set.
4. **`looksBinary` false positives on UTF-16 / BOM** — most text files are UTF-8; UTF-16 will look binary due to NUL bytes. Acceptable for v1; document the limitation.

## §9 Implementation phases (informational, real plan in writing-plans)

1. fs.ts tables + classifyPath + looksBinary + tests
2. code-fence.ts + tests
3. tabs.svelte.ts: Tab.kind/language, openFile classify, defaultModeFor + tests
4. editor-bridge.ts signature update + RichEditor wrapAsCodeBlock prop
5. EditorPane dispatch on kind
6. HtmlPreview.svelte
7. dialogs.ts open/save filters
8. tauri.conf.json file associations (html/htm)
9. README smoke checklist update
