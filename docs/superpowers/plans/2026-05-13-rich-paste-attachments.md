# Rich Paste & Attachment Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add clipboard paste (screenshots → `_files/` dir) and drag-drop (images + documents → absolute links) to the rich editor, with automatic resource migration when an untitled document is first saved.

**Architecture:** Paste/drop handling lives entirely in `RichEditor.svelte` (DOM capture-phase listeners + Tauri drag-drop events). Path logic is extracted to `paste-resources.ts` (pure functions + Tauri invoke). Visual chip/card rendering uses pure CSS on existing `<a>` elements — no ProseMirror schema changes needed.

**Tech Stack:** Svelte 5, Tauri v2, ProseMirror (via `@moraya/core`), Vitest, Rust (tauri::command)

---

## File Map

| Status | Path | Responsibility |
|--------|------|---------------|
| Create | `src/lib/paste-resources.ts` | Path utilities, clipboard save, temp→`_files/` migration |
| Create | `src/lib/paste-resources.test.ts` | Unit tests for pure functions and mocked Tauri calls |
| Create | `src/lib/attachment-insert.ts` | ProseMirror insertion helpers |
| Create | `src/lib/styles/attachment.css` | Chip / card visual styles |
| Modify | `src/components/RichEditor.svelte` | Paste handler, drag-drop, migration `$effect` |
| Modify | `src-tauri/src/lib.rs` | `write_file_binary` + `rename_file` Tauri commands |

---

## Task 1: Rust – write_file_binary and rename_file

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add helper functions before the `#[tauri::command]` blocks in lib.rs**

Open `src-tauri/src/lib.rs` and insert this block right after the `dlog` function (around line 45):

```rust
// ── File helpers ─────────────────────────────────────────────────────────────

fn sanitize_io_err(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound       => "File not found".to_string(),
        std::io::ErrorKind::PermissionDenied => "Permission denied".to_string(),
        std::io::ErrorKind::AlreadyExists  => "File already exists".to_string(),
        _                                  => "Operation failed".to_string(),
    }
}

/// Validate that the path is under the user's home directory.
/// Walks up ancestor dirs to handle not-yet-existing files.
fn safe_path(path: &str) -> Result<std::path::PathBuf, String> {
    use std::path::{Path, PathBuf};
    let p = Path::new(path);
    let canonical = std::fs::canonicalize(p).or_else(|_| {
        let mut parts: Vec<&std::ffi::OsStr> = Vec::new();
        if let Some(fname) = p.file_name() { parts.push(fname); }
        let mut ancestor = p.parent();
        loop {
            match ancestor {
                Some(dir) if dir.as_os_str().is_empty() => break,
                Some(dir) if dir.exists() => {
                    let mut base = std::fs::canonicalize(dir)
                        .map_err(|e| e.to_string())?;
                    for part in parts.iter().rev() { base.push(part); }
                    return Ok(base);
                }
                Some(dir) => {
                    if let Some(n) = dir.file_name() { parts.push(n); }
                    ancestor = dir.parent();
                }
                None => break,
            }
        }
        Err("Cannot resolve path".to_string())
    })?;

    let home = dirs::home_dir().ok_or("Cannot determine home dir")?;
    if canonical.starts_with(&home) { return Ok(canonical); }
    // Also allow /tmp and macOS /private/var (tempdir location)
    for prefix in &["/tmp", "/var", "/private"] {
        if canonical.starts_with(prefix) { return Ok(canonical); }
    }
    Err("Path outside allowed directories".to_string())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input = input.as_bytes();
    let mut buf: Vec<u8> = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in input {
        if matches!(b, b'\n' | b'\r' | b' ') { continue; }
        if b == b'=' { break; }
        let val = TABLE.iter().position(|&c| c == b)
            .ok_or_else(|| "Invalid base64".to_string())? as u32;
        acc = (acc << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(buf)
}
```

- [ ] **Step 2: Add the two Tauri commands after the helpers**

Insert right after the helpers block:

```rust
/// Write base64-encoded binary data to a file. Creates parent directories.
/// Strips optional `data:...;base64,` prefix automatically.
#[tauri::command]
fn write_file_binary(path: String, base64_data: String) -> Result<(), String> {
    use std::io::Write;
    let dest = safe_path(&path)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(sanitize_io_err)?;
    }
    let raw = base64_data.find(',').map_or(base64_data.as_str(), |i| &base64_data[i+1..]);
    let bytes = base64_decode(raw)?;
    let mut f = std::fs::File::create(&dest).map_err(sanitize_io_err)?;
    f.write_all(&bytes).map_err(sanitize_io_err)
}

/// Move a file from old_path to new_path. Creates parent directories of new_path.
/// Silently succeeds if old_path does not exist (already migrated).
#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let src = safe_path(&old_path)?;
    if !src.exists() { return Ok(()); }
    let dst = safe_path(&new_path)?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(sanitize_io_err)?;
    }
    std::fs::rename(&src, &dst).map_err(sanitize_io_err)
}
```

- [ ] **Step 3: Register both commands in invoke_handler**

Find the `.invoke_handler(tauri::generate_handler![` block (around line 363) and add:

```rust
            write_file_binary,
            rename_file,
```

(add before the closing `]`)

- [ ] **Step 4: Check the `dirs` crate is available**

Run:
```bash
grep "dirs" src-tauri/Cargo.toml
```

If not found, add to `src-tauri/Cargo.toml` under `[dependencies]`:
```toml
dirs = "5"
```

- [ ] **Step 5: Build to verify Rust compiles**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

Expected: `Finished` with no errors. Fix any type errors before proceeding.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(rust): add write_file_binary and rename_file commands"
```

---

## Task 2: paste-resources.ts – pure utility functions + tests

**Files:**
- Create: `src/lib/paste-resources.ts`
- Create: `src/lib/paste-resources.test.ts`

- [ ] **Step 1: Write failing tests for pure utilities**

Create `src/lib/paste-resources.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  IMAGE_EXTENSIONS,
  ATTACHMENT_EXTENSIONS,
  isImageExt,
  isAttachmentExt,
  isAttachmentUrl,
  extOf,
  basenameOf,
  resourceFilename,
  filesDir,
  findTempRefs,
} from './paste-resources'

describe('extension sets', () => {
  it('IMAGE_EXTENSIONS contains common image types', () => {
    expect(IMAGE_EXTENSIONS.has('png')).toBe(true)
    expect(IMAGE_EXTENSIONS.has('jpg')).toBe(true)
    expect(IMAGE_EXTENSIONS.has('webp')).toBe(true)
    expect(IMAGE_EXTENSIONS.has('pdf')).toBe(false)
  })

  it('ATTACHMENT_EXTENSIONS contains doc/archive/media types', () => {
    expect(ATTACHMENT_EXTENSIONS.has('pdf')).toBe(true)
    expect(ATTACHMENT_EXTENSIONS.has('zip')).toBe(true)
    expect(ATTACHMENT_EXTENSIONS.has('mp4')).toBe(true)
    expect(ATTACHMENT_EXTENSIONS.has('png')).toBe(false)
  })
})

describe('isImageExt', () => {
  it('returns true for image paths', () => {
    expect(isImageExt('/some/dir/photo.PNG')).toBe(true)
    expect(isImageExt('file.jpeg')).toBe(true)
  })
  it('returns false for non-image paths', () => {
    expect(isImageExt('/docs/report.pdf')).toBe(false)
    expect(isImageExt('archive.zip')).toBe(false)
  })
})

describe('isAttachmentExt', () => {
  it('returns true for document/archive/media paths', () => {
    expect(isAttachmentExt('/docs/report.pdf')).toBe(true)
    expect(isAttachmentExt('data.xlsx')).toBe(true)
    expect(isAttachmentExt('video.mp4')).toBe(true)
  })
  it('returns false for images', () => {
    expect(isAttachmentExt('photo.jpg')).toBe(false)
  })
})

describe('isAttachmentUrl', () => {
  it('returns true for URLs ending in attachment extension', () => {
    expect(isAttachmentUrl('https://example.com/report.pdf')).toBe(true)
    expect(isAttachmentUrl('https://example.com/data.xlsx?v=1')).toBe(true)
  })
  it('returns false for plain URLs', () => {
    expect(isAttachmentUrl('https://example.com/')).toBe(false)
    expect(isAttachmentUrl('https://example.com/page.html')).toBe(false)
  })
  it('returns false for image URLs', () => {
    expect(isAttachmentUrl('https://example.com/photo.jpg')).toBe(false)
  })
})

describe('extOf', () => {
  it('returns lowercase extension without dot', () => {
    expect(extOf('report.PDF')).toBe('pdf')
    expect(extOf('/path/to/image.JPEG')).toBe('jpeg')
    expect(extOf('no-extension')).toBe('')
  })
})

describe('basenameOf', () => {
  it('returns filename from unix path', () => {
    expect(basenameOf('/home/user/docs/report.pdf')).toBe('report.pdf')
    expect(basenameOf('report.pdf')).toBe('report.pdf')
  })
  it('returns filename from windows path', () => {
    expect(basenameOf('C:\\Users\\user\\report.pdf')).toBe('report.pdf')
  })
})

describe('resourceFilename', () => {
  it('generates image-{timestamp}.{ext} format', () => {
    const name = resourceFilename('png')
    expect(name).toMatch(/^image-\d+\.png$/)
  })
  it('normalizes jpeg to jpg', () => {
    const name = resourceFilename('jpeg')
    expect(name).toMatch(/^image-\d+\.jpg$/)
  })
  it('uses bin for unknown type', () => {
    const name = resourceFilename('application/octet-stream')
    expect(name).toMatch(/^file-\d+\.bin$/)
  })
})

describe('filesDir', () => {
  it('returns {docDir}/{basename}_files for a named document', () => {
    expect(filesDir('/home/user/notes/report.md')).toBe('/home/user/notes/report_files')
  })
  it('handles windows paths', () => {
    expect(filesDir('C:/Users/bruce/notes/report.md')).toBe('C:/Users/bruce/notes/report_files')
  })
  it('strips only the last extension', () => {
    expect(filesDir('/docs/my.doc.md')).toBe('/docs/my.doc_files')
  })
})

describe('findTempRefs', () => {
  const tempDir = '/tmp/mdeditor-paste/abc123'

  it('finds image refs in temp dir', () => {
    const md = '![alt](/tmp/mdeditor-paste/abc123/image-1.png)'
    const refs = findTempRefs(md, tempDir)
    expect(refs).toHaveLength(1)
    expect(refs[0].absPath).toBe('/tmp/mdeditor-paste/abc123/image-1.png')
  })

  it('finds link refs in temp dir', () => {
    const md = '[report.pdf](/tmp/mdeditor-paste/abc123/file-2.pdf)'
    const refs = findTempRefs(md, tempDir)
    expect(refs).toHaveLength(1)
    expect(refs[0].absPath).toBe('/tmp/mdeditor-paste/abc123/file-2.pdf')
  })

  it('finds multiple refs', () => {
    const md = [
      '![a](/tmp/mdeditor-paste/abc123/image-1.png)',
      '![b](/tmp/mdeditor-paste/abc123/image-2.jpg)',
      '[doc](/tmp/mdeditor-paste/abc123/file.pdf)',
    ].join('\n')
    expect(findTempRefs(md, tempDir)).toHaveLength(3)
  })

  it('ignores refs outside temp dir', () => {
    const md = '![a](/other/dir/image.png) [b](/tmp/mdeditor-paste/abc123/image.png)'
    expect(findTempRefs(md, tempDir)).toHaveLength(1)
  })

  it('returns empty array when no temp refs', () => {
    expect(findTempRefs('plain text', tempDir)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npm test -- paste-resources 2>&1 | tail -20
```

Expected: multiple `Cannot find module './paste-resources'` errors.

- [ ] **Step 3: Create paste-resources.ts with pure functions**

Create `src/lib/paste-resources.ts`:

```ts
export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif',
])

export const ATTACHMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'gz', 'tar', 'rar', '7z',
  'mp3', 'wav', 'ogg', 'flac',
  'mp4', 'mov', 'avi', 'mkv', 'webm',
  'txt', 'csv', 'json', 'xml',
])

export function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1 || dot === path.length - 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

export function basenameOf(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*\//, '')
}

export function isImageExt(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extOf(path))
}

export function isAttachmentExt(path: string): boolean {
  return ATTACHMENT_EXTENSIONS.has(extOf(path))
}

export function isAttachmentUrl(url: string): boolean {
  // Strip query string/fragment before checking extension
  const clean = url.replace(/[?#].*$/, '')
  const ext = extOf(clean)
  return ATTACHMENT_EXTENSIONS.has(ext)
}

export function resourceFilename(mimeOrExt: string): string {
  const ts = Date.now()
  // Normalise: strip mime prefix, jpeg→jpg, unknown→bin
  let ext = mimeOrExt.includes('/') ? mimeOrExt.split('/')[1] : mimeOrExt
  ext = ext?.split('+')[0] ?? 'bin'  // strip e.g. "svg+xml" → "svg"
  ext = ext === 'jpeg' ? 'jpg' : ext
  const isKnown = IMAGE_EXTENSIONS.has(ext) || ATTACHMENT_EXTENSIONS.has(ext)
  if (!isKnown) ext = 'bin'
  const prefix = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file'
  return `${prefix}-${ts}.${ext}`
}

/** Returns {docDir}/{docBasename}_files  (no trailing slash) */
export function filesDir(docFilePath: string): string {
  const norm = docFilePath.replace(/\\/g, '/')
  const dir = norm.replace(/\/[^/]+$/, '')
  const base = norm.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
  return `${dir}/${base}_files`
}

/** Scan markdown for links/images whose href starts with tempDir. */
export function findTempRefs(
  markdown: string,
  tempDir: string,
): Array<{ absPath: string }> {
  const prefix = tempDir.endsWith('/') ? tempDir : tempDir + '/'
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`!?\\[[^\\]]*\\]\\((${escaped}[^)]+)\\)`, 'g')
  const refs: Array<{ absPath: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    refs.push({ absPath: m[1] })
  }
  return refs
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- paste-resources 2>&1 | tail -20
```

Expected: all tests pass (green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/paste-resources.ts src/lib/paste-resources.test.ts
git commit -m "feat: paste-resources pure utilities with tests"
```

---

## Task 3: paste-resources.ts – migrateTempResources + tests

**Files:**
- Modify: `src/lib/paste-resources.ts`
- Modify: `src/lib/paste-resources.test.ts`

- [ ] **Step 1: Write failing tests for migration**

Append to `src/lib/paste-resources.test.ts`:

```ts
import { vi } from 'vitest'

// Mock Tauri invoke — must be before importing the function
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

describe('migrateTempResources', () => {
  it('migrates image refs and returns updated markdown', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const { migrateTempResources } = await import('./paste-resources')

    const md = '![alt](/tmp/mdeditor-paste/s1/image-1.png)\n\nSome text.'
    const result = await migrateTempResources(md, '/tmp/mdeditor-paste/s1', '/docs/report.md')

    // invoke should have been called with rename_file
    expect(invoke).toHaveBeenCalledWith('rename_file', {
      oldPath: '/tmp/mdeditor-paste/s1/image-1.png',
      newPath: '/docs/report_files/image-1.png',
    })
    // markdown should use relative path
    expect(result).toContain('report_files/image-1.png')
    expect(result).not.toContain('/tmp/mdeditor-paste')
  })

  it('returns unchanged markdown when no temp refs', async () => {
    const { migrateTempResources } = await import('./paste-resources')
    const md = '![alt](./images/photo.png)'
    const result = await migrateTempResources(md, '/tmp/mdeditor-paste/s1', '/docs/report.md')
    expect(result).toBe(md)
  })

  it('keeps absolute path when rename_file throws', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Permission denied'))
    const { migrateTempResources } = await import('./paste-resources')

    const md = '![alt](/tmp/mdeditor-paste/s1/image-1.png)'
    const result = await migrateTempResources(md, '/tmp/mdeditor-paste/s1', '/docs/report.md')
    expect(result).toBe(md)  // unchanged — kept absolute path
  })
})
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- paste-resources 2>&1 | tail -20
```

Expected: `migrateTempResources is not a function`.

- [ ] **Step 3: Implement migrateTempResources in paste-resources.ts**

Append to `src/lib/paste-resources.ts`:

```ts
/**
 * Move all resources under tempDir to {docBasename}_files/, update markdown refs.
 * Silently keeps absolute paths for any file that fails to move.
 */
export async function migrateTempResources(
  markdown: string,
  tempDir: string,
  newDocFilePath: string,
): Promise<string> {
  const refs = findTempRefs(markdown, tempDir)
  if (refs.length === 0) return markdown

  const norm = newDocFilePath.replace(/\\/g, '/')
  const docDir = norm.replace(/\/[^/]+$/, '')
  const docBasenameWithExt = norm.replace(/^.*\//, '')
  const docBasename = docBasenameWithExt.replace(/\.[^.]+$/, '')
  const targetDir = `${docDir}/${docBasename}_files`

  const { invoke } = await import('@tauri-apps/api/core')
  let result = markdown

  for (const { absPath } of refs) {
    const filename = absPath.replace(/^.*\//, '')
    const newAbsPath = `${targetDir}/${filename}`
    const relPath = `${docBasename}_files/${filename}`
    try {
      await invoke('rename_file', { oldPath: absPath, newPath: newAbsPath })
      result = result.replaceAll(absPath, relPath)
    } catch {
      // leave absolute path intact — file stays in temp dir
    }
  }
  return result
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- paste-resources 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/paste-resources.ts src/lib/paste-resources.test.ts
git commit -m "feat: migrateTempResources with temp→_files/ migration"
```

---

## Task 4: paste-resources.ts – saveClipboardResource + getTempDir

**Files:**
- Modify: `src/lib/paste-resources.ts`

These functions depend on Tauri (`invoke`, `appLocalDataDir`). Add them to the module:

- [ ] **Step 1: Append to paste-resources.ts**

```ts
// ── Tauri-dependent section ───────────────────────────────────────────────────

const SESSION_ID = Math.random().toString(36).slice(2, 10)
let _cachedTempDir: string | null = null

/** Returns the per-session temp directory for clipboard resources. Cached after first call. */
export async function getTempDir(): Promise<string> {
  if (_cachedTempDir) return _cachedTempDir
  const { appLocalDataDir } = await import('@tauri-apps/api/path')
  const base = (await appLocalDataDir()).replace(/\\/g, '/').replace(/\/$/, '')
  _cachedTempDir = `${base}/paste-temp/${SESSION_ID}`
  return _cachedTempDir
}

/**
 * Save a clipboard File to disk and return the path to use in markdown.
 *
 * Named doc   → saves to {docDir}/{basename}_files/, returns relative path
 * Untitled doc → saves to temp dir, returns absolute path (migrated on first save)
 */
export async function saveClipboardResource(
  file: File,
  docFilePath: string,  // empty string = untitled
): Promise<string> {
  const filename = resourceFilename(file.type || extOf(file.name) || 'bin')

  let targetDir: string
  let returnRelative: boolean

  if (docFilePath) {
    targetDir = filesDir(docFilePath)
    returnRelative = true
  } else {
    targetDir = await getTempDir()
    returnRelative = false
  }

  const absPath = `${targetDir}/${filename}`

  // Encode to base64
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  const base64 = btoa(binary)

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('write_file_binary', { path: absPath, base64Data: base64 })

  if (returnRelative) {
    const norm = docFilePath.replace(/\\/g, '/')
    const docBasename = norm.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
    return `${docBasename}_files/${filename}`
  }
  return absPath
}
```

- [ ] **Step 2: Run all paste-resources tests to confirm nothing broke**

```bash
npm test -- paste-resources 2>&1 | tail -20
```

Expected: all tests pass (the new functions aren't unit-tested here as they require Tauri runtime, but the pure tests should still pass).

- [ ] **Step 3: Commit**

```bash
git add src/lib/paste-resources.ts
git commit -m "feat: saveClipboardResource and getTempDir"
```

---

## Task 5: attachment-insert.ts

**Files:**
- Create: `src/lib/attachment-insert.ts`

No unit tests — these require a live ProseMirror view (covered by manual testing in Task 9).

- [ ] **Step 1: Create the file**

```ts
import { Slice, Fragment } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'

/** Insert an image node at the cursor position. */
export function insertImageAtCursor(view: EditorView, src: string): void {
  const node = view.state.schema.nodes.image.create({ src, alt: '' })
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
}

/** Insert an image node at a specific ProseMirror position. */
export function insertImageAtPos(view: EditorView, src: string, pos: number): void {
  const node = view.state.schema.nodes.image.create({ src, alt: '' })
  view.dispatch(view.state.tr.insert(pos, node).scrollIntoView())
}

/**
 * Insert a markdown link [filename](href) at pos or cursor.
 * Uses the link mark from the ProseMirror schema.
 */
export function insertAttachmentLink(
  view: EditorView,
  href: string,
  pos?: number,
): void {
  const filename = href.replace(/[?#].*$/, '').replace(/^.*[/\\]/, '') || href
  const { schema } = view.state
  const linkMark = schema.marks.link.create({ href, title: null })
  const textNode = schema.text(filename, [linkMark])
  const slice = new Slice(Fragment.from(textNode), 0, 0)
  const tr = pos !== undefined
    ? view.state.tr.insert(pos, textNode)
    : view.state.tr.replaceSelection(slice)
  view.dispatch(tr.scrollIntoView())
}
```

- [ ] **Step 2: Confirm TypeScript compiles**

```bash
npm run check 2>&1 | grep -E "error|warning" | head -20
```

Expected: no errors in the new file.

- [ ] **Step 3: Commit**

```bash
git add src/lib/attachment-insert.ts
git commit -m "feat: attachment-insert ProseMirror helpers"
```

---

## Task 6: attachment.css – chip and card visual styles

**Files:**
- Create: `src/lib/styles/attachment.css`

- [ ] **Step 1: Create the CSS file**

```css
/* ── Attachment link chip / card styles ────────────────────────────────────── */
/* Chip: attachment link inline among other text                                */
/* Card: attachment link as the only child of a paragraph                      */

/* === Base chip styles (all attachment extensions) === */
.ProseMirror a[href$=".pdf"],
.ProseMirror a[href$=".doc"],
.ProseMirror a[href$=".docx"],
.ProseMirror a[href$=".xls"],
.ProseMirror a[href$=".xlsx"],
.ProseMirror a[href$=".ppt"],
.ProseMirror a[href$=".pptx"],
.ProseMirror a[href$=".zip"],
.ProseMirror a[href$=".gz"],
.ProseMirror a[href$=".tar"],
.ProseMirror a[href$=".rar"],
.ProseMirror a[href$=".7z"],
.ProseMirror a[href$=".mp3"],
.ProseMirror a[href$=".wav"],
.ProseMirror a[href$=".ogg"],
.ProseMirror a[href$=".flac"],
.ProseMirror a[href$=".mp4"],
.ProseMirror a[href$=".mov"],
.ProseMirror a[href$=".avi"],
.ProseMirror a[href$=".mkv"],
.ProseMirror a[href$=".webm"],
.ProseMirror a[href$=".txt"],
.ProseMirror a[href$=".csv"],
.ProseMirror a[href$=".json"],
.ProseMirror a[href$=".xml"] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px 1px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, AccentColor 10%, Canvas);
  border: 1px solid color-mix(in srgb, AccentColor 30%, Canvas);
  font-size: 0.88em;
  text-decoration: none;
  white-space: nowrap;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  color: inherit;
  cursor: pointer;
}

/* === Card: when the link is the only child of its paragraph === */
.ProseMirror p:has(> a[href$=".pdf"]:only-child),
.ProseMirror p:has(> a[href$=".doc"]:only-child),
.ProseMirror p:has(> a[href$=".docx"]:only-child),
.ProseMirror p:has(> a[href$=".xls"]:only-child),
.ProseMirror p:has(> a[href$=".xlsx"]:only-child),
.ProseMirror p:has(> a[href$=".ppt"]:only-child),
.ProseMirror p:has(> a[href$=".pptx"]:only-child),
.ProseMirror p:has(> a[href$=".zip"]:only-child),
.ProseMirror p:has(> a[href$=".gz"]:only-child),
.ProseMirror p:has(> a[href$=".tar"]:only-child),
.ProseMirror p:has(> a[href$=".rar"]:only-child),
.ProseMirror p:has(> a[href$=".7z"]:only-child),
.ProseMirror p:has(> a[href$=".mp3"]:only-child),
.ProseMirror p:has(> a[href$=".wav"]:only-child),
.ProseMirror p:has(> a[href$=".ogg"]:only-child),
.ProseMirror p:has(> a[href$=".flac"]:only-child),
.ProseMirror p:has(> a[href$=".mp4"]:only-child),
.ProseMirror p:has(> a[href$=".mov"]:only-child),
.ProseMirror p:has(> a[href$=".avi"]:only-child),
.ProseMirror p:has(> a[href$=".mkv"]:only-child),
.ProseMirror p:has(> a[href$=".webm"]:only-child),
.ProseMirror p:has(> a[href$=".txt"]:only-child),
.ProseMirror p:has(> a[href$=".csv"]:only-child),
.ProseMirror p:has(> a[href$=".json"]:only-child),
.ProseMirror p:has(> a[href$=".xml"]:only-child) {
  margin: 4px 0;
}

.ProseMirror p:has(> a[href$=".pdf"]:only-child) > a,
.ProseMirror p:has(> a[href$=".doc"]:only-child) > a,
.ProseMirror p:has(> a[href$=".docx"]:only-child) > a,
.ProseMirror p:has(> a[href$=".xls"]:only-child) > a,
.ProseMirror p:has(> a[href$=".xlsx"]:only-child) > a,
.ProseMirror p:has(> a[href$=".ppt"]:only-child) > a,
.ProseMirror p:has(> a[href$=".pptx"]:only-child) > a,
.ProseMirror p:has(> a[href$=".zip"]:only-child) > a,
.ProseMirror p:has(> a[href$=".gz"]:only-child) > a,
.ProseMirror p:has(> a[href$=".tar"]:only-child) > a,
.ProseMirror p:has(> a[href$=".rar"]:only-child) > a,
.ProseMirror p:has(> a[href$=".7z"]:only-child) > a,
.ProseMirror p:has(> a[href$=".mp3"]:only-child) > a,
.ProseMirror p:has(> a[href$=".wav"]:only-child) > a,
.ProseMirror p:has(> a[href$=".ogg"]:only-child) > a,
.ProseMirror p:has(> a[href$=".flac"]:only-child) > a,
.ProseMirror p:has(> a[href$=".mp4"]:only-child) > a,
.ProseMirror p:has(> a[href$=".mov"]:only-child) > a,
.ProseMirror p:has(> a[href$=".avi"]:only-child) > a,
.ProseMirror p:has(> a[href$=".mkv"]:only-child) > a,
.ProseMirror p:has(> a[href$=".webm"]:only-child) > a,
.ProseMirror p:has(> a[href$=".txt"]:only-child) > a,
.ProseMirror p:has(> a[href$=".csv"]:only-child) > a,
.ProseMirror p:has(> a[href$=".json"]:only-child) > a,
.ProseMirror p:has(> a[href$=".xml"]:only-child) > a {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-radius: 7px;
  max-width: 100%;
  font-size: 0.9em;
}

/* === Per-category icons via ::before === */
/* Documents */
.ProseMirror a[href$=".pdf"]::before  { content: "📄 "; }
.ProseMirror a[href$=".doc"]::before,
.ProseMirror a[href$=".docx"]::before { content: "📝 "; }
.ProseMirror a[href$=".txt"]::before  { content: "📄 "; }
.ProseMirror a[href$=".csv"]::before,
.ProseMirror a[href$=".xls"]::before,
.ProseMirror a[href$=".xlsx"]::before { content: "📊 "; }
.ProseMirror a[href$=".ppt"]::before,
.ProseMirror a[href$=".pptx"]::before { content: "📋 "; }
.ProseMirror a[href$=".json"]::before,
.ProseMirror a[href$=".xml"]::before  { content: "🗒 "; }
/* Archives */
.ProseMirror a[href$=".zip"]::before,
.ProseMirror a[href$=".gz"]::before,
.ProseMirror a[href$=".tar"]::before,
.ProseMirror a[href$=".rar"]::before,
.ProseMirror a[href$=".7z"]::before   { content: "🗜 "; }
/* Audio */
.ProseMirror a[href$=".mp3"]::before,
.ProseMirror a[href$=".wav"]::before,
.ProseMirror a[href$=".ogg"]::before,
.ProseMirror a[href$=".flac"]::before { content: "🎵 "; }
/* Video */
.ProseMirror a[href$=".mp4"]::before,
.ProseMirror a[href$=".mov"]::before,
.ProseMirror a[href$=".avi"]::before,
.ProseMirror a[href$=".mkv"]::before,
.ProseMirror a[href$=".webm"]::before { content: "🎬 "; }
```

- [ ] **Step 2: Import the CSS in RichEditor.svelte**

Open `src/components/RichEditor.svelte` and add at the top of the `<script>` block (after existing imports):

```ts
import '../lib/styles/attachment.css'
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/styles/attachment.css src/components/RichEditor.svelte
git commit -m "feat: attachment chip/card CSS styles"
```

---

## Task 7: RichEditor.svelte – clipboard paste handler

**Files:**
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Add imports at the top of the script block**

Add after the existing imports in `RichEditor.svelte`:

```ts
import { saveClipboardResource, isAttachmentUrl } from '../lib/paste-resources'
import { insertImageAtCursor, insertAttachmentLink } from '../lib/attachment-insert'
import type { EditorView } from 'prosemirror-view'
```

- [ ] **Step 2: Add handlePaste function**

Add after the `let lastSync` declaration:

```ts
async function handlePaste(event: ClipboardEvent) {
  if (!editor || !event.clipboardData) return

  // ── 1. Binary blob in clipboard (screenshot, copied image from browser) ──
  const items = Array.from(event.clipboardData.items)
  const binaryItem = items.find(item => item.kind === 'file')
  if (binaryItem) {
    const file = binaryItem.getAsFile()
    if (file) {
      event.preventDefault()
      event.stopImmediatePropagation()
      try {
        const path = await saveClipboardResource(file, tab.filePath)
        const view = editor.view as unknown as EditorView
        if (binaryItem.type.startsWith('image/')) {
          insertImageAtCursor(view, path)
        } else {
          insertAttachmentLink(view, path)
        }
      } catch (e) {
        console.warn('[RichEditor] paste save failed:', e)
      }
      return
    }
  }

  // ── 2. URL with attachment extension ──
  const text = event.clipboardData.getData('text/plain')?.trim()
  if (text && isAttachmentUrl(text)) {
    try { new URL(text) } catch { return }  // confirm it's a valid URL
    event.preventDefault()
    event.stopImmediatePropagation()
    const view = editor.view as unknown as EditorView
    insertAttachmentLink(view, text)
  }
  // 3. Everything else: let ProseMirror handle
}
```

- [ ] **Step 3: Register listener in onMount, remove in onDestroy**

In the `onMount` callback, after `editor = inst` and `status = 'mounted'`, add:

```ts
// Register paste handler on the ProseMirror element (capture phase)
const pmEl = host!.querySelector('.ProseMirror') as HTMLElement | null
pmEl?.addEventListener('paste', handlePaste as EventListener, true)
```

And add a cleanup variable at the top of the script:

```ts
let _pmEl: HTMLElement | null = null
```

Replace the `pmEl?.addEventListener` line with:

```ts
_pmEl = host!.querySelector('.ProseMirror') as HTMLElement | null
_pmEl?.addEventListener('paste', handlePaste as EventListener, true)
```

In `onDestroy`, add before the editor cleanup:

```ts
_pmEl?.removeEventListener('paste', handlePaste as EventListener, true)
```

- [ ] **Step 4: TypeScript check**

```bash
npm run check 2>&1 | grep "error" | head -20
```

Expected: no errors. Fix any type errors before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/components/RichEditor.svelte
git commit -m "feat: clipboard paste handler for images and attachment URLs"
```

---

## Task 8: RichEditor.svelte – Tauri drag-drop

**Files:**
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Add drag-drop imports**

Add to imports in `RichEditor.svelte`:

```ts
import { isImageExt, isAttachmentExt } from '../lib/paste-resources'
import { insertImageAtPos, insertAttachmentLink } from '../lib/attachment-insert'
```

(These are already imported from previous tasks — skip if already present.)

- [ ] **Step 2: Add setupDragDrop function**

Add after `handlePaste`:

```ts
async function setupDragDrop() {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  return getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type !== 'drop' || !editor) return
    const { paths, position } = event.payload

    const view = editor.view as unknown as EditorView
    let dropPos: number | null = null
    try {
      const result = view.posAtCoords({ left: position.x, top: position.y })
      if (result) dropPos = result.pos
    } catch { /* fallback: insert at cursor */ }

    for (const path of paths) {
      if (isImageExt(path)) {
        dropPos !== null
          ? insertImageAtPos(view, path, dropPos)
          : insertImageAtCursor(view, path)
      } else if (isAttachmentExt(path)) {
        insertAttachmentLink(view, path, dropPos ?? undefined)
      }
    }
  })
}
```

- [ ] **Step 3: Add drag-drop state and wire into onMount**

Add at top of script:

```ts
let _dragDropUnlisten: (() => void) | null = null
```

In `onMount`, after the paste listener registration:

```ts
// Prevent browser default file drop behaviour
host!.addEventListener('dragover', (e) => e.preventDefault())
host!.addEventListener('drop',     (e) => e.preventDefault())

// Tauri native file drag-drop
setupDragDrop().then(fn => { _dragDropUnlisten = fn }).catch(console.warn)
```

In `onDestroy`, add:

```ts
_dragDropUnlisten?.()
```

- [ ] **Step 4: TypeScript check**

```bash
npm run check 2>&1 | grep "error" | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/RichEditor.svelte
git commit -m "feat: Tauri drag-drop handler for images and attachment files"
```

---

## Task 9: RichEditor.svelte – migration $effect on first save

**Files:**
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Add migration imports**

Add to imports:

```ts
import { migrateTempResources, getTempDir } from '../lib/paste-resources'
```

- [ ] **Step 2: Add migration state and $effect**

Add near top of script, after `let lastSync`:

```ts
// true if this component was mounted with an already-named file
const _mountedWithPath = !!tab.filePath
let _didMigrate = false
```

Add a new `$effect` block (after the existing inbound-sync `$effect`):

```ts
// Resource migration: when an untitled doc is first saved, move temp
// clipboard resources to {docBasename}_files/ and update markdown refs.
$effect(() => {
  const fp = tab.filePath
  if (_mountedWithPath || _didMigrate || !fp || status !== 'mounted' || !editor) return
  _didMigrate = true

  void (async () => {
    try {
      const tempDir = await getTempDir()
      const updated = await migrateTempResources(tab.currentContent, tempDir, fp)
      if (updated === tab.currentContent) return
      lastSync = updated
      setContent(tab.id, updated)
      editor!.setContent(updated)
    } catch (e) {
      console.warn('[RichEditor] resource migration failed:', e)
    }
  })()
})
```

- [ ] **Step 3: TypeScript check**

```bash
npm run check 2>&1 | grep "error" | head -20
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
npm test 2>&1 | tail -30
```

Expected: all existing tests still pass, paste-resources tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/RichEditor.svelte
git commit -m "feat: migrate temp clipboard resources on first document save"
```

---

## Task 10: Manual integration test checklist

Build and run the app (`npm run tauri dev`), then verify:

- [ ] **Clipboard screenshot paste**
  - Take a screenshot (Cmd+Ctrl+Shift+4 on macOS), paste into a **named** doc → image saved to `{docBasename}_files/`, `![](docname_files/image-xxx.png)` in source view
  - Paste into an **untitled** doc → absolute temp path in source view; save doc → path updates to `{docBasename}_files/`, file moved

- [ ] **Drag-drop image**
  - Drag an image file from Finder onto the editor → `![](/absolute/path/photo.jpg)` inserted at drop point

- [ ] **Drag-drop document**
  - Drag a PDF/ZIP from Finder → `[filename.pdf](/absolute/path/filename.pdf)` inserted; renders as card (standalone line) or chip (inline)

- [ ] **Paste attachment URL**
  - Copy `https://example.com/report.pdf`, paste → `[report.pdf](https://example.com/report.pdf)` as attachment chip/card
  - Copy a plain URL like `https://example.com/` → ProseMirror handles normally, no interception

- [ ] **Visual styles**
  - PDF link on its own line → card (full-width, icon, border)
  - PDF link inside a sentence → chip (inline badge with icon)
  - Image files → no chip/card style (normal image display)

- [ ] **Source mode round-trip**
  - Switch to source mode → markdown links are clean and standard
  - Switch back to rich mode → chips/cards render correctly

- [ ] **Commit final**

```bash
git add -A
git commit -m "feat: rich paste, attachment links, and resource migration complete"
```
