import { parse as parseYaml } from 'yaml'
import type { FrontmatterViewFactory } from '@moraya/core'

/**
 * Read-only rendering of YAML frontmatter for the rich editor. `key: value`
 * pairs become a two-column table; lists, nested objects and multi-line / long
 * strings render with wrapping (never collapsed onto one line or overflowing).
 *
 * Pure and DOM-only so it can be unit-tested under happy-dom. Editing frontmatter
 * happens in the source view — this view never mutates the document.
 */
export function buildFrontmatterDom(raw: string): HTMLElement {
  let data: unknown
  try {
    data = parseYaml(raw)
  } catch {
    return rawFallback(raw)
  }
  // Only a mapping (plain object) renders as a table. Scalars, sequences at the
  // root, or malformed input fall back to the wrapped raw YAML.
  if (!isPlainObject(data)) return rawFallback(raw)

  const table = document.createElement('table')
  table.className = 'frontmatter-table'
  const tbody = document.createElement('tbody')
  for (const [key, value] of Object.entries(data)) {
    const tr = document.createElement('tr')
    const keyCell = document.createElement('td')
    keyCell.className = 'fm-key'
    keyCell.textContent = key
    const valCell = document.createElement('td')
    valCell.className = 'fm-val'
    valCell.appendChild(renderValue(value))
    tr.append(keyCell, valCell)
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  return table
}

function rawFallback(raw: string): HTMLElement {
  const pre = document.createElement('pre')
  pre.className = 'frontmatter-raw'
  pre.textContent = raw
  return pre
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function renderValue(value: unknown): Node {
  if (value == null) return document.createTextNode('')

  if (Array.isArray(value)) {
    const ul = document.createElement('ul')
    ul.className = 'fm-list'
    for (const item of value) {
      const li = document.createElement('li')
      li.appendChild(renderValue(item))
      ul.appendChild(li)
    }
    return ul
  }

  if (isPlainObject(value)) {
    const box = document.createElement('div')
    box.className = 'fm-nested'
    for (const [k, v] of Object.entries(value)) {
      const line = document.createElement('div')
      line.className = 'fm-nested-line'
      const keyEl = document.createElement('span')
      keyEl.className = 'fm-nested-key'
      keyEl.textContent = `${k}: `
      line.appendChild(keyEl)
      line.appendChild(renderValue(v))
      box.appendChild(line)
    }
    return box
  }

  // Scalar (string / number / boolean). Multi-line strings keep their newlines;
  // the `.fm-val` CSS uses white-space: pre-wrap so they wrap instead of merging.
  return document.createTextNode(String(value))
}

/** Factory wired into the moraya editor via `frontmatterViewFactory`. */
export const frontmatterFactory: FrontmatterViewFactory = {
  render(container: HTMLElement, raw: string) {
    container.appendChild(buildFrontmatterDom(raw))
    return { destroy() { /* DOM owned by container; nothing to release */ } }
  },
}
