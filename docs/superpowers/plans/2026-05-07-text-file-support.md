# Text File Editing Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend mdeditor from markdown-only to support ~36 plain-text extensions plus HTML, with kind-aware default mode (HTML→rich preview; code→source) and code-block syntax highlighting in rich mode for code files.

**Architecture:** Tab gains a `kind: 'markdown' | 'html' | 'code'` field plus optional `language` string. `EditorPane` dispatches on kind: markdown → existing RichEditor; html → new HtmlPreview iframe; code → RichEditor wrapping content in fenced ` ```<lang>...``` ` for hljs colors. Source mode unchanged for all kinds.

**Tech Stack:** TypeScript 5, Svelte 5, Vite 6, Tauri 2, Vitest 4, `@moraya/core@^0.1.0`.

**Spec:** `/Users/bruce/git/mdeditor/docs/superpowers/specs/2026-05-07-text-file-support-design.md`

**Starting state:** mdeditor T1-T14 complete. HEAD: `2d70ad4`. 17 unit tests passing. Working tree clean.

---

## Working Directory Convention

All paths relative to `/Users/bruce/git/mdeditor` unless absolute. Run `cd /Users/bruce/git/mdeditor` once at the start of each task.

---

## Task 1: fs.ts — Classification + Binary Detection (TDD)

**Files:**
- Create: `src/lib/fs.test.ts`
- Modify: `src/lib/fs.ts`

- [ ] **Step 1: Write the failing test**

`/Users/bruce/git/mdeditor/src/lib/fs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyPath, isSupportedPath, looksBinary } from './fs'

describe('classifyPath', () => {
  it('markdown extensions', () => {
    expect(classifyPath('foo.md')).toEqual({ kind: 'markdown' })
    expect(classifyPath('foo.markdown')).toEqual({ kind: 'markdown' })
    expect(classifyPath('foo.mdown')).toEqual({ kind: 'markdown' })
    expect(classifyPath('foo.mkd')).toEqual({ kind: 'markdown' })
  })

  it('html extensions', () => {
    expect(classifyPath('foo.html')).toEqual({ kind: 'html' })
    expect(classifyPath('foo.htm')).toEqual({ kind: 'html' })
  })

  it('code extensions with language', () => {
    expect(classifyPath('foo.py')).toEqual({ kind: 'code', language: 'python' })
    expect(classifyPath('foo.json')).toEqual({ kind: 'code', language: 'json' })
    expect(classifyPath('foo.ts')).toEqual({ kind: 'code', language: 'typescript' })
    expect(classifyPath('foo.rs')).toEqual({ kind: 'code', language: 'rust' })
    expect(classifyPath('foo.yml')).toEqual({ kind: 'code', language: 'yaml' })
    expect(classifyPath('foo.sh')).toEqual({ kind: 'code', language: 'bash' })
  })

  it('plain-text extensions with empty language', () => {
    expect(classifyPath('foo.txt')).toEqual({ kind: 'code', language: '' })
    expect(classifyPath('foo.log')).toEqual({ kind: 'code', language: '' })
    expect(classifyPath('foo.csv')).toEqual({ kind: 'code', language: '' })
  })

  it('special filenames (no extension)', () => {
    expect(classifyPath('/path/to/Dockerfile')).toEqual({ kind: 'code', language: 'dockerfile' })
    expect(classifyPath('/repo/Makefile')).toEqual({ kind: 'code', language: 'makefile' })
    expect(classifyPath('Gemfile')).toEqual({ kind: 'code', language: 'ruby' })
  })

  it('case insensitive', () => {
    expect(classifyPath('FOO.PY')).toEqual({ kind: 'code', language: 'python' })
    expect(classifyPath('README.MD')).toEqual({ kind: 'markdown' })
    expect(classifyPath('DOCKERFILE')).toEqual({ kind: 'code', language: 'dockerfile' })
  })

  it('unknown extensions return null', () => {
    expect(classifyPath('foo.png')).toBe(null)
    expect(classifyPath('foo.exe')).toBe(null)
    expect(classifyPath('noextension')).toBe(null)
  })
})

describe('isSupportedPath', () => {
  it('returns true for supported extensions', () => {
    expect(isSupportedPath('foo.md')).toBe(true)
    expect(isSupportedPath('foo.html')).toBe(true)
    expect(isSupportedPath('foo.py')).toBe(true)
    expect(isSupportedPath('Dockerfile')).toBe(true)
  })

  it('returns false for unsupported', () => {
    expect(isSupportedPath('foo.png')).toBe(false)
    expect(isSupportedPath('foo')).toBe(false)
  })
})

describe('looksBinary', () => {
  it('plain text returns false', () => {
    expect(looksBinary('hello world')).toBe(false)
    expect(looksBinary('# Title\n\nSome text\n')).toBe(false)
    expect(looksBinary('')).toBe(false)
  })

  it('content with NUL byte returns true', () => {
    expect(looksBinary('hello\0world')).toBe(true)
  })

  it('mostly non-printable returns true', () => {
    // 90% control chars
    let s = ''
    for (let i = 0; i < 100; i++) s += '\x01'
    s += 'abcde'
    expect(looksBinary(s)).toBe(true)
  })

  it('common control chars (tab, LF, CR) are OK', () => {
    expect(looksBinary('a\tb\nc\rd')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/bruce/git/mdeditor
pnpm test src/lib/fs.test.ts
```

Expected: FAIL — `classifyPath`, `isSupportedPath`, `looksBinary` do not exist.

- [ ] **Step 3: Implement in `src/lib/fs.ts`**

REPLACE entire file content:

`/Users/bruce/git/mdeditor/src/lib/fs.ts`:

```ts
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

export async function readMd(path: string): Promise<string> {
  return readTextFile(path)
}

export async function writeMd(path: string, content: string): Promise<void> {
  return writeTextFile(path, content)
}

export function basename(path: string): string {
  const seg = path.split('/').filter(Boolean)
  return seg[seg.length - 1] ?? path
}

export type FileKind = 'markdown' | 'html' | 'code'

export interface FileClass {
  kind: FileKind
  language?: string
}

const EXT_TABLE: Record<string, FileClass> = {
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

const NAME_TABLE: Record<string, FileClass> = {
  dockerfile: { kind: 'code', language: 'dockerfile' },
  makefile:   { kind: 'code', language: 'makefile' },
  rakefile:   { kind: 'code', language: 'ruby' },
  gemfile:    { kind: 'code', language: 'ruby' },
}

export function classifyPath(path: string): FileClass | null {
  const base = basename(path).toLowerCase()
  if (NAME_TABLE[base]) return NAME_TABLE[base]
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  if (ext && EXT_TABLE[ext]) return EXT_TABLE[ext]
  return null
}

export function isSupportedPath(path: string): boolean {
  return classifyPath(path) !== null
}

/**
 * Heuristic: does the content look like a binary file?
 * - Returns true if the first 8KB contains a NUL byte, or
 * - more than 5% of bytes are control characters outside whitespace.
 *
 * Limitation: UTF-16 / UTF-32 with BOM will look binary because of NUL bytes.
 * Acceptable for v1.
 */
export function looksBinary(s: string): boolean {
  const sample = s.slice(0, 8192)
  if (sample.indexOf('\0') >= 0) return true
  if (sample.length === 0) return false
  let nonText = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    // Allow 9 (tab), 10 (LF), 13 (CR); reject other control chars
    if (c < 9 || (c > 13 && c < 32)) nonText++
  }
  return nonText / sample.length > 0.05
}
```

The old `isMarkdownPath` and `ALLOWED` are removed — `tabs.svelte.ts` will be updated in Task 3 to use the new functions.

- [ ] **Step 4: Run fs tests, verify pass**

```bash
cd /Users/bruce/git/mdeditor
pnpm test src/lib/fs.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Run full test suite to confirm tabs.test.ts is broken (expected)**

```bash
cd /Users/bruce/git/mdeditor
pnpm test
```

Expected: `fs.test.ts` passes. `tabs.test.ts` may fail because `isMarkdownPath` is gone — Task 3 fixes this. **Continue to commit anyway**; this is a known transitional state.

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/fs.ts src/lib/fs.test.ts
git -c commit.gpgsign=false commit -m "feat(fs): classifyPath / isSupportedPath / looksBinary (TDD)"
```

(Use `-c user.email=bruce@hemory.com -c user.name="bruce"` if commit fails on identity. Do NOT modify global git config.)

---

## Task 2: code-fence.ts (TDD)

**Files:**
- Create: `src/lib/code-fence.ts`
- Create: `src/lib/code-fence.test.ts`

- [ ] **Step 1: Write the failing test**

`/Users/bruce/git/mdeditor/src/lib/code-fence.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildFencedBlock, stripCodeFence } from './code-fence'

describe('buildFencedBlock', () => {
  it('wraps with language', () => {
    expect(buildFencedBlock('x = 1', 'python')).toBe('```python\nx = 1\n```')
  })

  it('wraps with empty language', () => {
    expect(buildFencedBlock('plain text', '')).toBe('```\nplain text\n```')
  })

  it('preserves trailing newline in content', () => {
    expect(buildFencedBlock('a\nb\n', 'js')).toBe('```js\na\nb\n\n```')
  })

  it('handles empty content', () => {
    expect(buildFencedBlock('', 'json')).toBe('```json\n\n```')
  })
})

describe('stripCodeFence', () => {
  it('strips a clean fenced block with language', () => {
    expect(stripCodeFence('```python\nx = 1\n```')).toBe('x = 1')
  })

  it('strips a fenced block without language', () => {
    expect(stripCodeFence('```\nplain text\n```')).toBe('plain text')
  })

  it('preserves multi-line content', () => {
    expect(stripCodeFence('```js\nline 1\nline 2\nline 3\n```')).toBe('line 1\nline 2\nline 3')
  })

  it('returns input as-is when not a single fenced block (no leading ```)', () => {
    expect(stripCodeFence('not a fence')).toBe('not a fence')
  })

  it('returns input as-is when no closing fence', () => {
    expect(stripCodeFence('```python\nx = 1')).toBe('```python\nx = 1')
  })

  it('returns input as-is when extra content surrounds the fence (defensive)', () => {
    const md = '# header\n\n```py\nx = 1\n```'
    expect(stripCodeFence(md)).toBe(md)
  })

  it('round-trips with buildFencedBlock', () => {
    const original = 'def hello():\n    return 42\n'
    const round = stripCodeFence(buildFencedBlock(original, 'python'))
    // buildFencedBlock adds a trailing \n inside fence; stripping returns 'def hello():\n    return 42\n'
    expect(round).toBe(original)
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd /Users/bruce/git/mdeditor
pnpm test src/lib/code-fence.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/code-fence.ts`**

`/Users/bruce/git/mdeditor/src/lib/code-fence.ts`:

```ts
/**
 * Wrap raw content in a markdown fenced code block.
 * Used for code-kind tabs in rich mode so @moraya/core's code-block-view
 * applies hljs syntax highlighting.
 */
export function buildFencedBlock(content: string, language: string): string {
  return '```' + language + '\n' + content + '\n```'
}

/**
 * Strip the surrounding fence from a markdown string that should consist of
 * exactly one fenced code block.
 *
 * If the input doesn't match the "single fenced block" shape, the input is
 * returned unchanged. This is intentional: the rich editor may produce slightly
 * different markdown after editing (e.g., user added paragraph above the
 * code block); preserving the input avoids data loss, even at the cost of
 * potential language mismatch on the next mount.
 */
export function stripCodeFence(md: string): string {
  const lines = md.split('\n')
  if (
    lines.length >= 3 &&
    lines[0]!.startsWith('```') &&
    lines[lines.length - 1]!.trim() === '```' &&
    // No interior fence lines that would suggest multiple blocks
    !lines.slice(1, -1).some((l) => l.trimStart().startsWith('```'))
  ) {
    return lines.slice(1, -1).join('\n')
  }
  return md
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd /Users/bruce/git/mdeditor
pnpm test src/lib/code-fence.test.ts
```

Expected: All 11 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/code-fence.ts src/lib/code-fence.test.ts
git -c commit.gpgsign=false commit -m "feat(code-fence): wrap/strip helpers for code-kind rich mode (TDD)"
```

---

## Task 3: tabs.svelte.ts — Tab.kind/language + classify + defaultModeFor

**Files:**
- Modify: `src/lib/tabs.svelte.ts`
- Modify: `src/lib/tabs.test.ts` (extend; existing 14 tests stay)

- [ ] **Step 1: Update existing test mock + add 4 new tests**

REPLACE the mock block at the top of `/Users/bruce/git/mdeditor/src/lib/tabs.test.ts` (find the existing `vi.mock('./fs', ...)`):

```ts
vi.mock('./fs', () => ({
  readMd: vi.fn(async (p: string) => `# content of ${p}`),
  writeMd: vi.fn(async () => {}),
  basename: (p: string) => p.split('/').pop() ?? p,
  classifyPath: (p: string) => {
    const lower = p.toLowerCase()
    if (/\.(md|markdown|mdown|mkd)$/.test(lower)) return { kind: 'markdown' }
    if (/\.html?$/.test(lower)) return { kind: 'html' }
    if (/\.py$/.test(lower)) return { kind: 'code', language: 'python' }
    if (/\.json$/.test(lower)) return { kind: 'code', language: 'json' }
    if (/\.txt$/.test(lower)) return { kind: 'code', language: '' }
    return null
  },
  isSupportedPath: (p: string) => /\.(md|markdown|mdown|mkd|html?|py|json|txt)$/i.test(p),
  looksBinary: (s: string) => s.indexOf('\0') >= 0,
}))
```

(The existing mock uses `isMarkdownPath`; replace it entirely with the block above.)

ADD 4 new tests inside the `describe('tabs', ...)` block, after the existing 14 tests, before the closing `})`:

```ts
  it('openFile classifies markdown', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    expect(m.tabs[0].kind).toBe('markdown')
    expect(m.tabs[0].language).toBeUndefined()
    expect(m.tabs[0].mode).toBe('source')
  })

  it('openFile classifies html with default rich mode', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/index.html')
    expect(m.tabs[0].kind).toBe('html')
    expect(m.tabs[0].mode).toBe('rich')
  })

  it('openFile classifies code with language', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/script.py')
    expect(m.tabs[0].kind).toBe('code')
    expect(m.tabs[0].language).toBe('python')
    expect(m.tabs[0].mode).toBe('source')
  })

  it('openFile rejects unsupported extension', async () => {
    const m = await import('./tabs.svelte')
    await expect(m.openFile('/tmp/image.png')).rejects.toThrow(/unsupported/i)
    expect(m.tabs.length).toBe(0)
  })

  it('openFile rejects binary content', async () => {
    const fs = await import('./fs')
    ;(fs.readMd as ReturnType<typeof vi.fn>).mockResolvedValueOnce('plain\0text')
    const m = await import('./tabs.svelte')
    await expect(m.openFile('/tmp/foo.md')).rejects.toThrow(/binary/i)
    expect(m.tabs.length).toBe(0)
  })
```

ALSO update existing test 'openFile rejects non-markdown extensions' — change the assertion from `/markdown/i` to `/unsupported/i`:

Find the existing test:

```ts
  it('openFile rejects non-markdown extensions', async () => {
    const m = await import('./tabs.svelte')
    await expect(m.openFile('/tmp/foo.txt')).rejects.toThrow(/markdown/i)
    expect(m.tabs.length).toBe(0)
  })
```

REPLACE with (note: `.txt` is now supported, so use a truly unsupported ext like `.png`):

```ts
  it('openFile rejects unsupported extensions (legacy)', async () => {
    const m = await import('./tabs.svelte')
    await expect(m.openFile('/tmp/foo.png')).rejects.toThrow(/unsupported/i)
    expect(m.tabs.length).toBe(0)
  })
```

- [ ] **Step 2: Run tests to verify failures**

```bash
cd /Users/bruce/git/mdeditor
pnpm test src/lib/tabs.test.ts
```

Expected: Existing tests that depended on `isMarkdownPath` mock will fail (mock no longer provides it; tabs.svelte.ts still imports it). New tests fail because `tab.kind` is undefined.

- [ ] **Step 3: Update `src/lib/tabs.svelte.ts`**

REPLACE entire file:

`/Users/bruce/git/mdeditor/src/lib/tabs.svelte.ts`:

```ts
import { readMd, writeMd, basename, classifyPath, isSupportedPath, looksBinary, type FileKind } from './fs'
import { pushRecentFile, getRecentMode, setRecentMode } from './settings.svelte'

export type Mode = 'source' | 'rich'

export interface Tab {
  id: string
  filePath: string
  title: string
  initialContent: string
  currentContent: string
  mode: Mode
  kind: FileKind
  language?: string
}

export const tabs = $state<Tab[]>([])
export const activeId = $state<{ value: string | null }>({ value: null })

export function activeTab(): Tab | null {
  return tabs.find((t) => t.id === activeId.value) ?? null
}

export function isDirty(id: string): boolean {
  const t = tabs.find((x) => x.id === id)
  return t ? t.currentContent !== t.initialContent : false
}

export function activate(id: string): void {
  if (tabs.some((t) => t.id === id)) activeId.value = id
}

function defaultModeFor(kind: FileKind): Mode {
  return kind === 'html' ? 'rich' : 'source'
}

export async function openFile(path: string): Promise<void> {
  if (!isSupportedPath(path)) {
    throw new Error(`Unsupported file type: ${path}`)
  }
  const cls = classifyPath(path)!
  const existing = tabs.find((t) => t.filePath === path)
  if (existing) {
    activeId.value = existing.id
    return
  }
  const content = await readMd(path)
  if (looksBinary(content)) {
    throw new Error(`Binary file not supported: ${path}`)
  }
  const mode = getRecentMode(path) ?? defaultModeFor(cls.kind)
  const tab: Tab = {
    id: crypto.randomUUID(),
    filePath: path,
    title: basename(path),
    initialContent: content,
    currentContent: content,
    mode,
    kind: cls.kind,
    language: cls.language,
  }
  tabs.push(tab)
  activeId.value = tab.id
  await pushRecentFile(path)
}

export function setContent(id: string, md: string): void {
  const t = tabs.find((x) => x.id === id)
  if (t) t.currentContent = md
}

export function toggleMode(id: string): void {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  setMode(id, t.mode === 'source' ? 'rich' : 'source')
}

export function setMode(id: string, mode: Mode): void {
  const t = tabs.find((x) => x.id === id)
  if (!t || t.mode === mode) return
  t.mode = mode
  setRecentMode(t.filePath, mode).catch((e) => console.warn(e))
}

export async function saveActive(): Promise<void> {
  const t = activeTab()
  if (!t) return
  await writeMd(t.filePath, t.currentContent)
  t.initialContent = t.currentContent
}

export async function saveAs(id: string, newPath: string): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  await writeMd(newPath, t.currentContent)
  t.filePath = newPath
  t.title = basename(newPath)
  t.initialContent = t.currentContent
  // Re-classify in case user changed extension
  const cls = classifyPath(newPath)
  if (cls) {
    t.kind = cls.kind
    t.language = cls.language
  }
  await pushRecentFile(newPath)
  setRecentMode(newPath, t.mode).catch((e) => console.warn(e))
}

export type DirtyChoice = 'save' | 'discard' | 'cancel'

export async function closeTab(
  id: string,
  confirm: () => Promise<DirtyChoice>,
): Promise<boolean> {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx < 0) return false
  if (isDirty(id)) {
    const choice = await confirm()
    if (choice === 'cancel') return false
    if (choice === 'save') {
      const previousActiveId = activeId.value
      activeId.value = id
      await saveActive()
      activeId.value = previousActiveId
    }
  }
  tabs.splice(idx, 1)
  if (activeId.value === id) {
    activeId.value = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null
  }
  return true
}
```

Key changes:
- Imports use `classifyPath / isSupportedPath / looksBinary / FileKind` (no more `isMarkdownPath`)
- `Tab` interface adds `kind` and optional `language`
- `defaultModeFor` helper
- `openFile` classifies, reads, sniffs binary, sets `mode` per kind default (or recentMode)
- `saveAs` re-classifies in case user changed extension

- [ ] **Step 4: Run all unit tests**

```bash
cd /Users/bruce/git/mdeditor
pnpm test
```

Expected: All tests pass — `fs.test.ts` (12+ cases), `code-fence.test.ts` (11), `settings.test.ts` (3), `tabs.test.ts` (14 existing + 4 new + 1 amended = ~19).

- [ ] **Step 5: Type check**

```bash
cd /Users/bruce/git/mdeditor
pnpm check
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/tabs.svelte.ts src/lib/tabs.test.ts
git -c commit.gpgsign=false commit -m "feat(tabs): Tab.kind + classify on openFile + binary reject + html default rich"
```

---

## Task 4: editor-bridge.ts Signature + RichEditor Caller Fix

**Files:**
- Modify: `src/lib/editor-bridge.ts`
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Update `src/lib/editor-bridge.ts`**

REPLACE entire file:

`/Users/bruce/git/mdeditor/src/lib/editor-bridge.ts`:

```ts
import 'katex/dist/katex.min.css'
import { createEditor as coreCreateEditor, type MorayaEditorInstance } from '@moraya/core'
import { tauriMediaResolver } from './adapters/tauri-media-resolver'
import { tauriLinkOpener } from './adapters/tauri-link-opener'
import { emptyRendererRegistry } from './adapters/empty-renderer-registry'
import { activeTab } from './tabs.svelte'

const platform = {
  getCurrentFilePath: () => activeTab()?.filePath ?? null,
  isMacOS: true,
}

/**
 * Mount a rich-text @moraya/core editor.
 *
 * `initialContent` is now an explicit parameter (was previously read from
 * tab.currentContent inside this function). This lets callers wrap content
 * in a fenced code block for code-kind tabs without coupling the bridge
 * to file-kind logic.
 */
export async function mountRichEditor(
  root: HTMLElement,
  initialContent: string,
  onChange: (md: string) => void,
): Promise<MorayaEditorInstance> {
  return coreCreateEditor({
    container: root,
    initialContent,
    mediaResolver: tauriMediaResolver,
    rendererRegistry: emptyRendererRegistry,
    linkOpener: tauriLinkOpener,
    platform,
    enableMath: true,
    enableMermaid: true,
    enableTableResize: true,
    enableImageSelection: true,
    enableHistory: true,
    onChange,
    changeDebounceMs: 200,
  })
}
```

(Removed unused `Tab` type import; signature changed from `(root, tab, onChange)` to `(root, initialContent, onChange)`.)

- [ ] **Step 2: Update RichEditor.svelte caller**

Find this block in `/Users/bruce/git/mdeditor/src/components/RichEditor.svelte` `onMount`:

```ts
const { mountRichEditor } = await import('../lib/editor-bridge')
const inst = await mountRichEditor(host!, tab, (md) => setContent(tabId, md))
```

REPLACE with:

```ts
const { mountRichEditor } = await import('../lib/editor-bridge')
const inst = await mountRichEditor(host!, tab.currentContent, (md) => setContent(tabId, md))
```

(Just pass `tab.currentContent` as the second arg. Wrapping logic comes in Task 5.)

- [ ] **Step 3: Type check**

```bash
cd /Users/bruce/git/mdeditor
pnpm check
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/editor-bridge.ts src/components/RichEditor.svelte
git -c commit.gpgsign=false commit -m "refactor(editor-bridge): explicit initialContent parameter"
```

---

## Task 5: RichEditor wrapAsCodeBlock Prop

**Files:**
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Add wrapAsCodeBlock prop + wrap/strip logic**

REPLACE the entire `<script>` block in `/Users/bruce/git/mdeditor/src/components/RichEditor.svelte`:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'
  import { buildFencedBlock, stripCodeFence } from '../lib/code-fence'

  // NOTE: @moraya/core (ProseMirror + plugins, multi-MB) is dynamically imported
  // inside onMount so it never loads when the user only uses source mode.
  type EditorInstance = {
    view: unknown
    getMarkdown(): string
    setContent(md: string): void
    destroy(): void
  }

  let {
    tab,
    onFlush,
    wrapAsCodeBlock,
  }: {
    tab: Tab
    onFlush?: (md: string) => void
    /**
     * If defined, the editor is mounted with content wrapped in a fenced block
     * (` ```<lang>...``` `) and `onChange` / `onDestroy` strip the fence before
     * propagating raw content back. Used for code-kind tabs.
     */
    wrapAsCodeBlock?: string
  } = $props()

  let host: HTMLDivElement | undefined = $state()
  let editor: EditorInstance | null = null
  let status = $state<'mounting' | 'mounted' | 'error'>('mounting')
  let errorMsg = $state<string | null>(null)

  function unwrapIfNeeded(md: string): string {
    return wrapAsCodeBlock !== undefined ? stripCodeFence(md) : md
  }

  onMount(() => {
    if (!host) {
      errorMsg = 'host element missing'
      status = 'error'
      return
    }
    const tabId = tab.id
    const initial = wrapAsCodeBlock !== undefined
      ? buildFencedBlock(tab.currentContent, wrapAsCodeBlock)
      : tab.currentContent
    ;(async () => {
      try {
        const { mountRichEditor } = await import('../lib/editor-bridge')
        const inst = await mountRichEditor(host!, initial, (md) => {
          setContent(tabId, unwrapIfNeeded(md))
        })
        editor = inst
        status = 'mounted'
      } catch (e) {
        console.error('[RichEditor] mount failed:', e)
        errorMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        status = 'error'
      }
    })()
  })

  onDestroy(() => {
    if (editor) {
      try {
        const md = editor.getMarkdown()
        onFlush?.(unwrapIfNeeded(md))
        editor.destroy()
      } catch (e) {
        console.warn('[RichEditor] destroy failed:', e)
      }
      editor = null
    }
  })
</script>
```

(Markup and styles stay the same. Only the `<script>` changes.)

- [ ] **Step 2: Type check**

```bash
cd /Users/bruce/git/mdeditor
pnpm check
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/components/RichEditor.svelte
git -c commit.gpgsign=false commit -m "feat(rich-editor): wrapAsCodeBlock prop for code-kind tabs"
```

---

## Task 6: HtmlPreview.svelte (NEW)

**Files:**
- Create: `src/components/HtmlPreview.svelte`

- [ ] **Step 1: Write the component**

`/Users/bruce/git/mdeditor/src/components/HtmlPreview.svelte`:

```svelte
<script lang="ts">
  let { html }: { html: string } = $props()
</script>

<!--
  HTML rich mode = sandboxed iframe preview. NOT editable.
  - sandbox attribute with NO allow-scripts → <script> tags do not execute
  - srcdoc renders the raw HTML byte-stably; saving back is a no-op
  - To edit: switch to source mode (Cmd+/)
-->
<div class="html-preview-wrap">
  <iframe
    title="HTML preview"
    sandbox=""
    srcdoc={html}
    class="html-preview-frame"
  ></iframe>
</div>

<style>
  .html-preview-wrap {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    background: Canvas;
  }
  .html-preview-frame {
    width: 100%;
    height: 100%;
    border: 0;
    background: white;
  }
</style>
```

- [ ] **Step 2: Type check**

```bash
cd /Users/bruce/git/mdeditor
pnpm check
```

Expected: 0 errors. (One a11y warning about `<iframe>` without title may appear, but we set `title="HTML preview"`, so no warning.)

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/components/HtmlPreview.svelte
git -c commit.gpgsign=false commit -m "feat(html-preview): sandbox iframe component for HTML rich mode"
```

---

## Task 7: EditorPane Dispatch on tab.kind

**Files:**
- Modify: `src/components/EditorPane.svelte`

- [ ] **Step 1: Update EditorPane**

REPLACE the entire `/Users/bruce/git/mdeditor/src/components/EditorPane.svelte`:

```svelte
<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'
  import RichEditor from './RichEditor.svelte'
  import SourceView from './SourceView.svelte'
  import HtmlPreview from './HtmlPreview.svelte'

  let { tab }: { tab: Tab } = $props()

  function onSourceInput(e: Event) {
    const ta = e.currentTarget as HTMLTextAreaElement
    setContent(tab.id, ta.value)
  }

  function onRichFlush(md: string) {
    setContent(tab.id, md)
  }
</script>

{#if tab.mode === 'source'}
  {#key tab.id}
    <SourceView value={tab.currentContent} oninput={onSourceInput} />
  {/key}
{:else if tab.kind === 'html'}
  {#key tab.id}
    <HtmlPreview html={tab.currentContent} />
  {/key}
{:else}
  {#key tab.id}
    <RichEditor
      {tab}
      onFlush={onRichFlush}
      wrapAsCodeBlock={tab.kind === 'code' ? (tab.language ?? '') : undefined}
    />
  {/key}
{/if}
```

The dispatch:
- `mode === 'source'` → SourceView (works for all kinds)
- `mode === 'rich'`, `kind === 'html'` → HtmlPreview (read-only iframe)
- `mode === 'rich'`, `kind === 'markdown'` → RichEditor without wrap (markdown-native)
- `mode === 'rich'`, `kind === 'code'` → RichEditor with `wrapAsCodeBlock={language ?? ''}`

- [ ] **Step 2: Update App.svelte if needed (verify)**

Run:

```bash
cd /Users/bruce/git/mdeditor
grep -n "rich-wrap\|html-preview" src/App.svelte
```

If `.html-preview-wrap` is not in the `.pane :global(...)` selector, add it. Find this block in `src/App.svelte`:

```css
  .pane :global(.empty),
  .pane :global(.src),
  .pane :global(.rich-wrap) {
    flex: 1;
    min-width: 0;
  }
```

REPLACE with:

```css
  .pane :global(.empty),
  .pane :global(.src),
  .pane :global(.rich-wrap),
  .pane :global(.html-preview-wrap) {
    flex: 1;
    min-width: 0;
  }
```

- [ ] **Step 3: Type check + smoke**

```bash
cd /Users/bruce/git/mdeditor
pnpm check
pnpm build
```

Both must succeed.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/components/EditorPane.svelte src/App.svelte
git -c commit.gpgsign=false commit -m "feat(editor-pane): dispatch on tab.kind (markdown / html / code)"
```

---

## Task 8: dialogs.ts — Open / Save Filters

**Files:**
- Modify: `src/lib/dialogs.ts`

- [ ] **Step 1: Update filters**

REPLACE `pickOpenFile` and `pickSaveFile` in `/Users/bruce/git/mdeditor/src/lib/dialogs.ts`. Final file:

`/Users/bruce/git/mdeditor/src/lib/dialogs.ts`:

```ts
import { ask, message, save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
import type { DirtyChoice } from './tabs.svelte'
import { basename } from './fs'

const ALL_EXTS = [
  'md', 'markdown', 'mdown', 'mkd',
  'html', 'htm',
  'txt', 'log', 'csv', 'tsv', 'env',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml',
  'sh', 'bash', 'zsh',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'rs', 'go', 'java', 'c', 'cpp', 'cc', 'h', 'hpp',
  'rb', 'swift', 'kt', 'php', 'cs',
  'css', 'scss', 'sql',
]

export async function confirmDirtyClose(): Promise<DirtyChoice> {
  const wantSave = await ask('Save changes before closing?', {
    title: 'mdeditor',
    kind: 'warning',
    okLabel: 'Save',
    cancelLabel: 'Cancel',
  })
  if (wantSave) return 'save'
  const wantDiscard = await ask('Close without saving?', {
    title: 'mdeditor',
    kind: 'warning',
    okLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
  })
  return wantDiscard ? 'discard' : 'cancel'
}

export async function pickOpenFile(): Promise<string | null> {
  const picked = await openDialog({
    multiple: false,
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: 'HTML', extensions: ['html', 'htm'] },
      { name: 'All supported', extensions: ALL_EXTS },
    ],
  })
  return typeof picked === 'string' ? picked : null
}

/**
 * Suggest a filter that matches the current file's extension so Save As
 * defaults to the same kind. Falls back to "All supported" if extension is
 * unrecognized.
 */
export async function pickSaveFile(defaultPath?: string): Promise<string | null> {
  const ext = defaultPath
    ? basename(defaultPath).split('.').pop()?.toLowerCase()
    : undefined
  const filters = ext && ALL_EXTS.includes(ext)
    ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All supported', extensions: ALL_EXTS }]
    : [{ name: 'All supported', extensions: ALL_EXTS }]
  const picked = await saveDialog({ defaultPath, filters })
  return picked ?? null
}

export async function showError(text: string): Promise<void> {
  await message(text, { title: 'mdeditor', kind: 'error' })
}
```

- [ ] **Step 2: Type check**

```bash
cd /Users/bruce/git/mdeditor
pnpm check
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/dialogs.ts
git -c commit.gpgsign=false commit -m "feat(dialogs): expand open/save filters to all supported text kinds"
```

---

## Task 9: tauri.conf.json — html/htm fileAssociations

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add html/htm association**

Find the `fileAssociations` array in `/Users/bruce/git/mdeditor/src-tauri/tauri.conf.json`:

```json
    "fileAssociations": [
      {
        "ext": ["md", "markdown", "mdown", "mkd"],
        "name": "Markdown",
        "description": "Markdown document",
        "role": "Editor"
      }
    ]
```

REPLACE with:

```json
    "fileAssociations": [
      {
        "ext": ["md", "markdown", "mdown", "mkd"],
        "name": "Markdown",
        "description": "Markdown document",
        "role": "Editor"
      },
      {
        "ext": ["html", "htm"],
        "name": "HTML",
        "description": "HTML document",
        "role": "Editor"
      }
    ]
```

(Keeping `role: "Editor"` and `LSHandlerRank: Owner` per existing Info.plist; macOS will offer mdeditor as a possible editor for .html alongside the user's existing default.)

- [ ] **Step 2: Cargo check**

```bash
cd /Users/bruce/git/mdeditor/src-tauri
cargo check
```

Use Bash timeout 600000. Expected: succeeds (no Rust changes; only conf JSON).

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/tauri.conf.json
git -c commit.gpgsign=false commit -m "chore(tauri): register html/htm file association"
```

---

## Task 10: README + Final Smoke + Optional Build

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append smoke items 15-20 to README**

Open `/Users/bruce/git/mdeditor/README.md` and find the existing manual smoke checklist (items 1-14). After item 14, ADD:

```markdown
15. Open a `.py` file → source view shows raw content with markdown-style heading colors (irrelevant for Python); switch to rich → renders as Python-highlighted code block (hljs colors)
16. Open a `.html` file → opens in **rich mode by default** (sandboxed iframe preview); switch to source → edit raw HTML
17. Open `Dockerfile` (no extension, exact filename match) → classified as code with `dockerfile` language
18. Drag a `.png` into the window → toast: `Unsupported: png`, no tab opened
19. Open a 6 MB log file → confirm dialog: `File is large (6 MB). Continue?` (manual: prepare such a file with `dd if=/dev/zero of=/tmp/big.log bs=1M count=6`); cancel → no tab; confirm → opens with potential lag
20. Open `.json` file, switch to rich → edit a value inside the rendered code block, switch back to source → see edit; Cmd+S → reopen → contents persist (round-trip byte-stable when fence intact)
```

- [ ] **Step 2: Run all unit tests**

```bash
cd /Users/bruce/git/mdeditor
pnpm test
```

Expected: All tests pass — fs (12+), code-fence (11), settings (3), tabs (~19) = ~45 tests total.

- [ ] **Step 3: Type check**

```bash
cd /Users/bruce/git/mdeditor
pnpm check
```

Expected: 0 errors.

- [ ] **Step 4: Optional release build**

```bash
cd /Users/bruce/git/mdeditor
pnpm tauri build
```

Use Bash timeout 900000. Expected: produces `src-tauri/target/release/bundle/macos/mdeditor.app` (a few MB, similar to or slightly larger than previous ~4.8 MB due to added code-fence + html-preview).

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add README.md
git -c commit.gpgsign=false commit -m "docs: README smoke checklist for text-file support (items 15-20)"
```

---

## Plan Summary

10 tasks. Critical path:
- T1-T2: pure-logic helpers with TDD (~30 min)
- T3: tabs state extension (~20 min)
- T4-T5: editor-bridge + RichEditor wiring (~20 min)
- T6: HtmlPreview (~5 min)
- T7: EditorPane dispatch (~10 min)
- T8-T9: dialog filters + Tauri config (~10 min)
- T10: docs + final tests (~10 min)

**Net new files:** 4 (`fs.test.ts`, `code-fence.ts`, `code-fence.test.ts`, `HtmlPreview.svelte`).
**Modified files:** 6 (`fs.ts`, `tabs.svelte.ts`, `tabs.test.ts`, `editor-bridge.ts`, `RichEditor.svelte`, `EditorPane.svelte`, `App.svelte`, `dialogs.ts`, `tauri.conf.json`, `README.md`) — actually 10, not 6, but ~half are tiny.

**Total LOC delta:** ~250 added, ~30 removed.

## Spec Coverage

- ✅ §1 Data flow → T3 (openFile classifies + reads + sniffs binary), T5 (RichEditor wraps), T7 (EditorPane dispatches)
- ✅ §2 Repository changes → T1-T9 each touch their listed file
- ✅ §3 Extension tables → T1 (EXT_TABLE/NAME_TABLE)
- ✅ §4 Error handling → T1 (looksBinary), T3 (unsupported reject), T6 (sandbox iframe blocks scripts)
- ✅ §5 Save flow → T3 (saveAs re-classify), T5 (rich → strip → save), T6 (HTML rich is read-only, save no-op handled by existing saveActive)
- ✅ §6 Testing → T1, T2, T3 with explicit vitest cases; T10 manual smoke
- ✅ §7 Out of scope items → not implemented (correct)

## No Placeholders Verification

- All "TBD/TODO/implement later" patterns absent
- Every code step shows the actual code
- Every command has expected output
- Type signatures match across tasks (`FileKind`, `Tab.kind`, `Tab.language`, `wrapAsCodeBlock?: string`)

## Known Risks (from spec §8, no plan changes needed)

1. Code-block-view editability — verified via T10 smoke item 20
2. Round-trip stability — verified via T10 smoke item 20
3. HLJS language coverage — language strings (python/javascript/typescript/etc.) match `@moraya/core`'s preloaded set; no test needed unless a language fails in smoke
4. UTF-16 false positives in `looksBinary` — documented in code; v1 acceptable
