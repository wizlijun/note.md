// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { frontmatterFactory } from './frontmatter-view'

it.each(['title: draft\n', 'title: "unterminated\n', ''])('hides the entire metadata view without rendering or modifying YAML: %j', raw => {
  const container = document.createElement('div'), onChange = vi.fn()
  const handle = frontmatterFactory.render(container, raw, onChange)
  expect(container.hidden).toBe(true)
  expect(container.style.display).toBe('none')
  expect(container.childNodes.length).toBe(0)
  expect(onChange).not.toHaveBeenCalled()
  handle?.destroy()
  expect(onChange).not.toHaveBeenCalled()
})
