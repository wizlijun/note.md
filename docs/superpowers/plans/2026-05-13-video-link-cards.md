# Video Link Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When pasting a YouTube or Bilibili URL, fetch the video title via oEmbed/API and insert a styled link `[title](url)` that renders as a branded card with a ▶ play button in rich mode; single-clicking the card opens the video in the browser.

**Architecture:** `video-links.ts` handles URL detection and async title/thumbnail-URL fetching (YouTube via regular `fetch()` oEmbed; Bilibili via `@tauri-apps/plugin-http` to bypass CORS). `attachment.css` adds CSS card styles keyed on `a[href*="youtube.com"]` etc. `RichEditor.svelte` and `SourceView.svelte` each get a video-URL paste branch that calls `fetchVideoInfo` then inserts `[title](url)`. A click listener on the `.ProseMirror` element intercepts single clicks on video cards and opens them via `plugin-opener`.

**Note on thumbnails:** `@moraya/core` image nodes have `marks: ""` (no link marks allowed) and `html_inline` only handles bare `<img>`, `<video>`, `<audio>` — so inline thumbnail images inside links are not possible without modifying `@moraya/core`. This plan delivers a card without an embedded thumbnail; upgrading to a thumbnail card requires a separate `@moraya/core` change.

**Tech Stack:** Svelte 5, Tauri v2, `@tauri-apps/plugin-http`, YouTube oEmbed API (no key), Bilibili Web API, CSS system colors

---

## File Map

| Status | Path | Responsibility |
|--------|------|----------------|
| Modify | `src-tauri/Cargo.toml` | Add `tauri-plugin-http = "2"` |
| Modify | `src-tauri/src/lib.rs` | Initialize http plugin |
| Modify | `src-tauri/capabilities/default.json` | Add `http:default` permission |
| Create | `src/lib/video-links.ts` | URL detection + oEmbed/API fetch |
| Create | `src/lib/video-links.test.ts` | Unit tests for URL detection helpers |
| Modify | `src/lib/styles/attachment.css` | Video card CSS |
| Modify | `src/components/RichEditor.svelte` | Paste handler + click-to-open |
| Modify | `src/components/SourceView.svelte` | Paste handler |

---

## Task 1: Add @tauri-apps/plugin-http

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Install npm package**

```bash
cd /Users/bruce/git/mdeditor && pnpm add @tauri-apps/plugin-http
```

- [ ] **Step 2: Add Rust crate**

Open `src-tauri/Cargo.toml` and add to `[dependencies]`:

```toml
tauri-plugin-http = "2"
```

- [ ] **Step 3: Initialize plugin in lib.rs**

Find the plugin chain in `src-tauri/src/lib.rs` (the block with `.plugin(tauri_plugin_fs::init())` etc.) and add:

```rust
        .plugin(tauri_plugin_http::init())
```

Add it before `.invoke_handler(...)`.

- [ ] **Step 4: Add http permissions to capabilities**

Open `src-tauri/capabilities/default.json` and add to the `"permissions"` array:

```json
    {
      "identifier": "http:default",
      "allow": [
        { "url": "https://**" },
        { "url": "http://**" }
      ]
    },
```

- [ ] **Step 5: Build check**

```bash
cd /Users/bruce/git/mdeditor/src-tauri && cargo check 2>&1 | tail -10
```

Expected: `Finished` with no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json package.json pnpm-lock.yaml
git commit -m "feat: add tauri-plugin-http for video API calls"
```

---

## Task 2: video-links.ts — URL detection helpers + tests

**Files:**
- Create: `src/lib/video-links.ts`
- Create: `src/lib/video-links.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/video-links.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  isYouTubeUrl,
  isBilibiliUrl,
  isVideoUrl,
  extractYouTubeId,
  extractBilibiliId,
  youTubeThumbnailUrl,
} from './video-links'

describe('isYouTubeUrl', () => {
  it('matches standard watch URL', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  })
  it('matches short URL', () => {
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
  })
  it('matches mobile URL', () => {
    expect(isYouTubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  })
  it('rejects non-youtube URL', () => {
    expect(isYouTubeUrl('https://example.com')).toBe(false)
  })
  it('rejects bilibili URL', () => {
    expect(isYouTubeUrl('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(false)
  })
})

describe('isBilibiliUrl', () => {
  it('matches BV format', () => {
    expect(isBilibiliUrl('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(true)
  })
  it('matches AV format', () => {
    expect(isBilibiliUrl('https://www.bilibili.com/video/av12345/')).toBe(true)
  })
  it('rejects non-bilibili URL', () => {
    expect(isBilibiliUrl('https://example.com')).toBe(false)
  })
})

describe('isVideoUrl', () => {
  it('returns true for YouTube', () => {
    expect(isVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
  })
  it('returns true for Bilibili', () => {
    expect(isVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(true)
  })
  it('returns false for plain URL', () => {
    expect(isVideoUrl('https://example.com/report.pdf')).toBe(false)
  })
})

describe('extractYouTubeId', () => {
  it('extracts from watch URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts from short URL', () => {
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts from URL with extra params', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s')).toBe('dQw4w9WgXcQ')
  })
  it('returns null for non-YouTube URL', () => {
    expect(extractYouTubeId('https://example.com')).toBeNull()
  })
})

describe('extractBilibiliId', () => {
  it('extracts BV number', () => {
    expect(extractBilibiliId('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe('BV1xx411c7mD')
  })
  it('extracts AV number as string', () => {
    expect(extractBilibiliId('https://www.bilibili.com/video/av12345/')).toBe('av12345')
  })
  it('returns null for non-bilibili URL', () => {
    expect(extractBilibiliId('https://example.com')).toBeNull()
  })
})

describe('youTubeThumbnailUrl', () => {
  it('constructs mqdefault thumbnail URL', () => {
    expect(youTubeThumbnailUrl('dQw4w9WgXcQ')).toBe(
      'https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg'
    )
  })
})
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/bruce/git/mdeditor && npm test -- video-links 2>&1 | tail -10
```

Expected: `Cannot find module './video-links'`.

- [ ] **Step 3: Implement video-links.ts**

Create `src/lib/video-links.ts`:

```ts
export interface VideoInfo {
  title: string
  thumbnailUrl: string
  videoUrl: string
  platform: 'youtube' | 'bilibili'
}

// ── URL detection ─────────────────────────────────────────────────────────────

export function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.|m\.)?youtube\.com\/watch/.test(url)
    || /^https?:\/\/youtu\.be\//.test(url)
}

export function isBilibiliUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?bilibili\.com\/video\//.test(url)
}

export function isVideoUrl(url: string): boolean {
  return isYouTubeUrl(url) || isBilibiliUrl(url)
}

// ── ID extraction ─────────────────────────────────────────────────────────────

export function extractYouTubeId(url: string): string | null {
  const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
    || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

export function extractBilibiliId(url: string): string | null {
  const bv = url.match(/\/video\/(BV[a-zA-Z0-9]+)/)
  if (bv) return bv[1]
  const av = url.match(/\/video\/(av\d+)/i)
  if (av) return av[1].toLowerCase()
  return null
}

export function youTubeThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
}

// ── Async fetch (Tauri-dependent) ─────────────────────────────────────────────

export async function fetchVideoInfo(url: string): Promise<VideoInfo | null> {
  try {
    if (isYouTubeUrl(url)) return await fetchYouTubeInfo(url)
    if (isBilibiliUrl(url)) return await fetchBilibiliInfo(url)
    return null
  } catch {
    return null
  }
}

async function fetchYouTubeInfo(url: string): Promise<VideoInfo | null> {
  const videoId = extractYouTubeId(url)
  if (!videoId) return null

  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
  const resp = await fetch(oembedUrl)
  if (!resp.ok) return null
  const data = await resp.json() as { title?: string; thumbnail_url?: string }

  return {
    title: data.title || 'YouTube Video',
    thumbnailUrl: data.thumbnail_url || youTubeThumbnailUrl(videoId),
    videoUrl: url,
    platform: 'youtube',
  }
}

async function fetchBilibiliInfo(url: string): Promise<VideoInfo | null> {
  const id = extractBilibiliId(url)
  if (!id) return null

  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  const apiUrl = id.startsWith('av')
    ? `https://api.bilibili.com/x/web-interface/view?aid=${id.slice(2)}`
    : `https://api.bilibili.com/x/web-interface/view?bvid=${id}`

  const resp = await tauriFetch(apiUrl)
  if (!resp.ok) return null
  const data = await resp.json() as { code?: number; data?: { title?: string; pic?: string } }
  if (data.code !== 0 || !data.data) return null

  return {
    title: data.data.title || 'Bilibili Video',
    thumbnailUrl: data.data.pic || '',
    videoUrl: url,
    platform: 'bilibili',
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/bruce/git/mdeditor && npm test -- video-links 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/video-links.ts src/lib/video-links.test.ts
git commit -m "feat: video-links URL detection and oEmbed/API fetch"
```

---

## Task 3: CSS video card styles

**Files:**
- Modify: `src/lib/styles/attachment.css`

- [ ] **Step 1: Append video card styles to attachment.css**

Append to the end of `src/lib/styles/attachment.css`:

```css
/* ── Video link cards (YouTube / Bilibili) ──────────────────────────────────── */

/* === Chip style (inline) === */
.ProseMirror a[href*="youtube.com"],
.ProseMirror a[href*="youtu.be"],
.ProseMirror a[href*="bilibili.com"] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px 2px 6px;
  border-radius: 4px;
  text-decoration: none;
  font-size: 0.88em;
  white-space: nowrap;
  vertical-align: middle;
  color: inherit;
  cursor: pointer;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ProseMirror a[href*="youtube.com"]::before,
.ProseMirror a[href*="youtu.be"]::before {
  content: "▶";
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  background: #ff0000;
  color: white;
  border-radius: 3px;
  font-size: 8px;
  line-height: 1;
}

.ProseMirror a[href*="bilibili.com"]::before {
  content: "▶";
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  background: #00aeec;
  color: white;
  border-radius: 3px;
  font-size: 8px;
  line-height: 1;
}

/* === Card style (standalone line) === */
.ProseMirror p:has(> a[href*="youtube.com"]:only-child),
.ProseMirror p:has(> a[href*="youtu.be"]:only-child),
.ProseMirror p:has(> a[href*="bilibili.com"]:only-child) {
  margin: 4px 0;
}

.ProseMirror p:has(> a[href*="youtube.com"]:only-child) > a,
.ProseMirror p:has(> a[href*="youtu.be"]:only-child) > a,
.ProseMirror p:has(> a[href*="bilibili.com"]:only-child) > a {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  max-width: 100%;
  font-size: 0.92em;
  font-weight: 500;
}

.ProseMirror p:has(> a[href*="youtube.com"]:only-child) > a,
.ProseMirror p:has(> a[href*="youtu.be"]:only-child) > a {
  background: color-mix(in srgb, #ff0000 8%, Canvas);
  border: 1px solid color-mix(in srgb, #ff0000 25%, Canvas);
}

.ProseMirror p:has(> a[href*="bilibili.com"]:only-child) > a {
  background: color-mix(in srgb, #00aeec 8%, Canvas);
  border: 1px solid color-mix(in srgb, #00aeec 25%, Canvas);
}

/* Larger play icon in card mode */
.ProseMirror p:has(> a[href*="youtube.com"]:only-child) > a::before,
.ProseMirror p:has(> a[href*="youtu.be"]:only-child) > a::before {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  font-size: 12px;
}

.ProseMirror p:has(> a[href*="bilibili.com"]:only-child) > a::before {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  font-size: 12px;
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd /Users/bruce/git/mdeditor && npm run check 2>&1 | grep "error" | head -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/styles/attachment.css
git commit -m "feat: YouTube and Bilibili video card CSS styles"
```

---

## Task 4: RichEditor.svelte — video paste + click-to-open

**Files:**
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Add import**

In the imports section of `RichEditor.svelte`, add:

```ts
import { isVideoUrl, fetchVideoInfo } from '../lib/video-links'
```

- [ ] **Step 2: Extend handlePaste to handle video URLs**

In `handlePaste`, find the block:

```ts
  // ── 2. URL with attachment extension ──
  const text = event.clipboardData.getData('text/plain')?.trim()
  if (text && isAttachmentUrl(text)) {
```

Replace that entire block (the `const text = ...` declaration and the `if` block) with this expanded version that checks for video URLs first, then attachment URLs:

```ts
  // ── 2. URL paste (video or attachment) ──
  const text = event.clipboardData.getData('text/plain')?.trim()
  if (text && isVideoUrl(text) && /^https?:\/\//.test(text)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    const view = editor.view as unknown as EditorView
    // Insert placeholder link immediately
    insertAttachmentLink(view, text)
    // Async: fetch real title and replace the placeholder link text
    fetchVideoInfo(text).then(info => {
      if (!info || !editor) return
      const v = editor.view as unknown as EditorView
      const { doc } = v.state
      let replaceTr = v.state.tr
      let updated = false
      doc.descendants((node, pos) => {
        if (updated) return false
        const linkMark = node.marks.find(m => m.type.name === 'link' && m.attrs.href === text)
        if (linkMark && node.isText && node.text === text) {
          const newText = v.state.schema.text(info.title, node.marks)
          replaceTr = replaceTr.replaceWith(pos, pos + node.nodeSize, newText)
          updated = true
          return false
        }
      })
      if (updated) v.dispatch(replaceTr)
    }).catch(() => {})
    return
  }
  if (text && isAttachmentUrl(text)) {
    try { new URL(text) } catch { return }
    event.preventDefault()
    event.stopImmediatePropagation()
    const view = editor.view as unknown as EditorView
    insertAttachmentLink(view, text)
  }
  // 3. Everything else: let ProseMirror handle
```

This fully replaces the old "URL with attachment extension" block — do NOT leave the old `if (text && isAttachmentUrl(text))` block in place.

- [ ] **Step 3: Add video click handler**

After the `handleImageClick` function, add:

```ts
function handleVideoLinkClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  const anchor = target.closest('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''
  if (!isVideoUrl(href)) return
  event.preventDefault()
  event.stopImmediatePropagation()
  import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(href))
    .catch(() => {})
}
```

- [ ] **Step 4: Register video click listener in onMount**

After `_pmEl?.addEventListener('click', handleImageClick as EventListener)`, add:

```ts
_pmEl?.addEventListener('click', handleVideoLinkClick as EventListener, true)
```

- [ ] **Step 5: Remove video click listener in onDestroy**

After `_pmEl?.removeEventListener('click', handleImageClick as EventListener)`, add:

```ts
_pmEl?.removeEventListener('click', handleVideoLinkClick as EventListener, true)
```

- [ ] **Step 6: TypeScript check + tests**

```bash
cd /Users/bruce/git/mdeditor && npm run check 2>&1 | grep "error" | head -10
npm test 2>&1 | tail -5
```

Expected: no errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/components/RichEditor.svelte
git commit -m "feat: video URL paste and click-to-open in rich mode"
```

---

## Task 5: SourceView.svelte — video paste handler

**Files:**
- Modify: `src/components/SourceView.svelte`

- [ ] **Step 1: Add import**

In `SourceView.svelte`, add to imports:

```ts
import { isVideoUrl, fetchVideoInfo } from '../lib/video-links'
```

- [ ] **Step 2: Extend handlePaste to handle video URLs**

In `handlePaste`, find the block:

```ts
    // 2. 附件扩展名 URL
    const text = event.clipboardData.getData('text/plain')?.trim()
    if (text && isAttachmentUrl(text)) {
```

Replace the entire block with this expanded version:

```ts
    // 2. URL paste (video or attachment)
    const text = event.clipboardData.getData('text/plain')?.trim()
    if (text && isVideoUrl(text) && /^https?:\/\//.test(text)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      const tab = activeTab()
      if (!tab) return
      // Insert placeholder immediately, then replace with real title
      insertAtCursor(tab.id, `[${text}](${text})`)
      fetchVideoInfo(text).then(info => {
        if (!info) return
        const t = activeTab()
        if (!t) return
        const placeholder = `[${text}](${text})`
        const real = `[${info.title}](${text})`
        if (t.currentContent.includes(placeholder)) {
          setContent(t.id, t.currentContent.replace(placeholder, real))
        }
      }).catch(() => {})
      return
    }
    if (text && isAttachmentUrl(text)) {
      try { new URL(text) } catch { return }
      event.preventDefault()
      event.stopImmediatePropagation()
      const tab = activeTab()
      if (!tab) return
      const filename = basenameOf(text.replace(/[?#].*$/, '')) || text
      insertAtCursor(tab.id, `[${filename}](${text})`)
    }
```

`setContent`, `activeTab`, `insertAtCursor`, and `basenameOf` are all already in scope from existing imports/declarations at the top of `SourceView.svelte`. This fully replaces the old attachment URL block — do NOT leave the old `if (text && isAttachmentUrl(text))` block in place.

- [ ] **Step 4: TypeScript check + tests**

```bash
cd /Users/bruce/git/mdeditor && npm run check 2>&1 | grep "error" | head -10
npm test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/components/SourceView.svelte
git commit -m "feat: video URL paste handler in source mode"
```

---

## Manual Integration Test

After `npm run tauri dev`:

- [ ] Open a `.md` file in **rich mode**
- [ ] Copy `https://www.youtube.com/watch?v=dQw4w9WgXcQ`, paste → card appears with red ▶ icon + video title fetched from oEmbed
- [ ] Paste on its own line → card style; paste inline in text → chip style
- [ ] **Click the card** → video opens in default browser
- [ ] Copy a Bilibili URL like `https://www.bilibili.com/video/BV1xx411c7mD/`, paste → blue card with Bilibili ▶ icon + video title
- [ ] Switch to **source mode** → markdown is `[Video Title](url)` (clean link)
- [ ] Open a `.md` file in **source mode**, paste YouTube/Bilibili URL → `[title](url)` inserted at cursor
