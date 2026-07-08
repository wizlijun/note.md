import { parseDocument, isScalar, isMap } from 'yaml'
import type { FrontmatterViewFactory } from '@moraya/core'
import { segmentFrontmatter } from './frontmatter-segment'
import { renderMarkdownInline } from './plugins/host-render-html'

/**
 * Render YAML frontmatter for the rich editor. The block is segmented into
 * contiguous `key: value` regions (rendered as a table with editable scalar
 * values) and other content (rendered as read-only markdown). See
 * docs/superpowers/specs/2026-07-08-frontmatter-table-render-design.md.
 *
 * `onChange` receives the full new raw YAML after a scalar value is edited.
 * DOM-only and pure enough to unit-test under happy-dom.
 */
export function renderFrontmatter(
  raw: string,
  onChange?: (newRaw: string) => void,
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'frontmatter-segments'
  for (const seg of segmentFrontmatter(raw)) {
    if (seg.kind === 'kv') {
      root.appendChild(renderKvTable(seg.text, seg.start, seg.end, raw, onChange))
    } else if (seg.text.trim() !== '') {
      root.appendChild(renderMdBlock(seg.text))
    }
  }
  return root
}

/** Kept for the DOM-builder tests; renders the whole block as one view. */
export function buildFrontmatterDom(raw: string): HTMLElement {
  return renderFrontmatter(raw)
}

function renderMdBlock(md: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'frontmatter-md'
  div.innerHTML = renderMarkdownInline(md)
  return div
}

function renderKvTable(
  segText: string,
  segStart: number,
  segEnd: number,
  fullRaw: string,
  onChange?: (newRaw: string) => void,
): HTMLElement {
  let doc
  try {
    doc = parseDocument(segText)
  } catch {
    return rawFallback(segText)
  }
  // parseDocument collects syntax errors instead of throwing; a broken segment
  // (or one that isn't a mapping) falls back to wrapped raw text.
  if (doc.errors.length > 0 || !isMap(doc.contents)) return rawFallback(segText)
  const contents = doc.contents

  const table = document.createElement('table')
  table.className = 'frontmatter-table'
  const tbody = document.createElement('tbody')

  for (const pair of contents.items) {
    const key = String((pair.key as { value?: unknown })?.value ?? pair.key)
    const valueNode = pair.value

    const tr = document.createElement('tr')
    const keyCell = document.createElement('td')
    keyCell.className = 'fm-key'
    keyCell.textContent = key

    const valCell = document.createElement('td')
    valCell.className = 'fm-val'

    if (isEditableScalar(valueNode)) {
      const originalValue = (valueNode as { value: unknown }).value
      const original = scalarText(valueNode)
      valCell.classList.add('fm-editable')
      valCell.contentEditable = 'true'
      valCell.spellcheck = false
      valCell.textContent = original
      wireScalarEdit(valCell, key, original, originalValue, segText, segStart, segEnd, fullRaw, onChange)
    } else {
      valCell.appendChild(renderReadonlyValue(valueNode?.toJSON?.() ?? null))
    }

    tr.append(keyCell, valCell)
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  return table
}

function isEditableScalar(node: unknown): boolean {
  if (!isScalar(node)) return false
  const v = (node as { value: unknown }).value
  if (v === null) return true
  if (typeof v === 'string') return !v.includes('\n')  // multi-line stays read-only
  return typeof v === 'number' || typeof v === 'boolean'
}

function scalarText(node: unknown): string {
  const v = (node as { value: unknown }).value
  return v == null ? '' : String(v)
}

/**
 * Interpret edited cell text keeping the field's original scalar type: a
 * numeric field stays numeric, a boolean stays boolean, everything else is a
 * string. Avoids turning `count: 3` into the quoted string `count: "5"`.
 */
function coerceLikeOriginal(text: string, originalValue: unknown): unknown {
  const t = text.trim()
  if (typeof originalValue === 'number') {
    const n = Number(t)
    return t !== '' && !Number.isNaN(n) ? n : text
  }
  if (typeof originalValue === 'boolean') {
    if (t === 'true') return true
    if (t === 'false') return false
    return text
  }
  return text
}

function wireScalarEdit(
  cell: HTMLElement,
  key: string,
  original: string,
  originalValue: unknown,
  segText: string,
  segStart: number,
  segEnd: number,
  fullRaw: string,
  onChange?: (newRaw: string) => void,
): void {
  const commit = () => {
    const next = cell.textContent ?? ''
    if (next === original) return
    try {
      const d = parseDocument(segText)
      d.set(key, coerceLikeOriginal(next, originalValue))
      const newSeg = String(d)
      const newRaw = fullRaw.slice(0, segStart) + newSeg + fullRaw.slice(segEnd)
      onChange?.(newRaw)
    } catch {
      // Keep the edit visible; a re-render will resync if the model changes.
    }
  }
  cell.addEventListener('blur', commit)
  cell.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent
    if (ev.key === 'Enter') { ev.preventDefault(); cell.blur() }
    else if (ev.key === 'Escape') { ev.preventDefault(); cell.textContent = original; cell.blur() }
  })
}

function rawFallback(raw: string): HTMLElement {
  const pre = document.createElement('pre')
  pre.className = 'frontmatter-raw'
  pre.textContent = raw
  return pre
}

function renderReadonlyValue(value: unknown): Node {
  if (value == null) return document.createTextNode('')

  if (Array.isArray(value)) {
    const ul = document.createElement('ul')
    ul.className = 'fm-list'
    for (const item of value) {
      const li = document.createElement('li')
      li.appendChild(renderReadonlyValue(item))
      ul.appendChild(li)
    }
    return ul
  }

  if (typeof value === 'object') {
    const box = document.createElement('div')
    box.className = 'fm-nested'
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const line = document.createElement('div')
      line.className = 'fm-nested-line'
      const keyEl = document.createElement('span')
      keyEl.className = 'fm-nested-key'
      keyEl.textContent = `${k}: `
      line.appendChild(keyEl)
      line.appendChild(renderReadonlyValue(v))
      box.appendChild(line)
    }
    return box
  }

  // Scalar (incl. multi-line strings, which the `.fm-val` pre-wrap keeps intact).
  return document.createTextNode(String(value))
}

/** Factory wired into the moraya editor via `frontmatterViewFactory`. */
export const frontmatterFactory: FrontmatterViewFactory = {
  render(container: HTMLElement, raw: string, onChange?: (newRaw: string) => void) {
    container.appendChild(renderFrontmatter(raw, onChange))
    return { destroy() { /* DOM owned by container; nothing to release */ } }
  },
}
