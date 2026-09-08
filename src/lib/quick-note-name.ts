// Naming rules for quick notes. Pure (no Tauri imports) so it is directly
// testable and safe to import from both the store and the save paths.

import { sanitizeFileName } from './outline/slug'

/** Auto-generated quick-note basename, capturing its `YYYY-MM-DD` date. */
const AUTO_QUICK_RE = /^(\d{4}-\d{2}-\d{2})-\d{6}-quick\.md$/i
const UNTITLED_RE = /^untitled(?:-(?:[2-9]|[1-9]\d+))?\.md$/i

/** Longest slug kept from a title, in characters. */
const MAX_SLUG_LEN = 50

/** Local `YYYY-MM-DD-HHmmss` for automatic document filenames. */
export function fileNameTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${date}-${time}`
}

/** Legacy `YYYY-MM-DD-HHmmss-quick.md` name. */
export function quickNoteFileName(d: Date): string {
  return `${fileNameTimestamp(d)}-quick.md`
}

/** True while `basename` is still the untouched auto-generated quick-note name. */
export function isAutoQuickNoteName(basename: string): boolean {
  return AUTO_QUICK_RE.test(basename) || UNTITLED_RE.test(basename)
}

/**
 * A title turned into a filename fragment. Non-ASCII (CJK) is kept verbatim per
 * the project's file-over-app naming rule — only filesystem-illegal characters
 * are replaced. Returns null when nothing usable survives, so callers skip the
 * rename rather than produce a `…-untitled.md`.
 */
export function titleSlug(title: string): string | null {
  if (!/[\p{L}\p{N}]/u.test(title)) return null
  const collapsed = title.replace(/\s+/g, '-')
  const safe = sanitizeFileName(collapsed)
  if (safe === 'untitled') return null
  const slug = safe
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_SLUG_LEN)
    .replace(/^-+|-+$/g, '')
  return slug === '' ? null : slug
}

/** 首部 YAML frontmatter 块(其中的 `# ...` 是 YAML 注释,不是标题)。 */
const FM_BLOCK = /^---\r?\n(?:[\s\S]*?\r?\n)?---(\r?\n|$)/

/** First ATX H1 in `text`, or null. Mirrors folder-view's `parseFirstH1`. */
export function firstH1(text: string): string | null {
  const m = text.replace(FM_BLOCK, '').match(/^#[ \t]+(.+?)[ \t]*$/m)
  return m ? m[1] : null
}

/**
 * True once the first H1 line is terminated by a newline — the user pressed
 * Enter and moved off the title, so it is finished rather than half-typed.
 *
 * Auto-save fires ~800 ms after a keystroke, so without this an autosave landing
 * mid-word would name the file after a partial title ("产" instead of "产品思考")
 * and the rename-once rule would make that stick.
 */
export function isTitleFinished(text: string): boolean {
  return /^#[ \t]+.+?[^\S\n]*\n/m.test(text.replace(FM_BLOCK, ''))
}

/**
 * Name a temporary note once. Untitled notes use the current date plus an H1
 * slug; an explicit save without a usable title falls back to HHmmss. Legacy
 * timestamped quick notes retain their creation date and title-only rename.
 *
 * Auto-save requires a completed title line so a half-typed heading never
 * becomes the permanent filename. Already-named files are left alone.
 */
export function quickNoteRenameTarget(
  basename: string,
  content: string,
  requireFinishedTitle = false,
  now: Date = new Date(),
): string | null {
  const stamped = AUTO_QUICK_RE.exec(basename)
  const untitled = UNTITLED_RE.test(basename)
  if (!stamped && !untitled) return null
  if (requireFinishedTitle && !isTitleFinished(content)) return null
  const title = firstH1(content)
  const slug = title ? titleSlug(title) : null
  const timestamp = fileNameTimestamp(now)
  if (slug) return `${stamped?.[1] ?? timestamp.slice(0, 10)}-${slug}.md`
  return untitled && !requireFinishedTitle ? `${timestamp}.md` : null
}
