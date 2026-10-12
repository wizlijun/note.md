// @vitest-environment jsdom
// DOMPurify explicitly excludes happy-dom as a safe sanitizer host (its README).
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { renderReviewMarkdown } from './render'
import DOMPurify from 'dompurify'
import { propose } from '../../lib/share-merge'
import HunkView from './HunkView.svelte'

afterEach(cleanup)

it('visualizes the source-view hidden character set in sanitized rendered text nodes', async () => {
  const controls = '\u061C\u200B\u200C\u200D\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2060\u2066\u2067\u2068\u2069\uFEFF'
  const source = `正文${controls}末尾\n\n<b>&#x202e;实体&#x200b;</b>\n\n![图片\u2069](https://tracker.invalid/image)`
  const html = await renderReviewMarkdown(source)
  const root = document.createElement('div'); root.innerHTML = html
  for (const control of controls) expect(root.textContent).toContain(`⟨U+${control.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`)
  expect(html).not.toMatch(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u)
  expect(root.querySelector('img,[src],[srcset],script,svg,iframe')).toBeNull()
  expect(root.querySelector('button[data-review-image]')?.textContent).toContain('图片⟨U+2069⟩')
  expect(source).toContain(controls)
})

it('keeps bidi and zero-width code points visible when a hunk switches to rendered diff', async () => {
  const hunk = propose({ path: 'a.md', base: '甲。', ours: '甲。', theirs: '乙\u202e\u200b。' }).hunks[0]
  const view = render(HunkView, { hunk, onDecide: vi.fn() })
  expect(view.container.textContent).toContain('⟨U+202E⟩⟨U+200B⟩')
  await view.rerender({ rendered: true })
  await vi.waitFor(() => expect(view.container.querySelector('.rendered-diff')?.textContent).toContain('⟨U+202E⟩⟨U+200B⟩'))
  expect(view.container.querySelector('.rendered-diff')?.textContent).not.toMatch(/[\u202E\u200B]/u)
  expect(hunk.theirs).toBe('乙\u202e\u200b。')
})

it('sanitizes both raw and generated HTML before mounting, leaving no active resources', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const sanitize = vi.spyOn(DOMPurify, 'sanitize')
  const html = await renderReviewMarkdown(`<script>window.pwned=1</script>
<img src="https://tracker.invalid/pixel" onerror="window.pwned=2" srcset="https://tracker.invalid/set 2x">
<svg><image href="https://tracker.invalid/svg" /></svg><math href="https://tracker.invalid/math"></math>
<style>@import 'https://tracker.invalid/css';</style><div style="background:url(https://tracker.invalid/bg)">text</div>
<iframe src="https://tracker.invalid/frame"></iframe><video poster="https://tracker.invalid/poster"></video>
<input autofocus><button data-review-image="https://tracker.invalid/fake">fake</button>

[bad](javascript:alert(1)) [data](data:text/html,x) [safe](https://example.org/) [here](#heading)
![two](https://tracker.invalid/two)`)
  const root = document.createElement('div'); root.innerHTML = html
  expect(root.querySelector('script,svg,math,style,iframe,video,input,img,[src],[srcset],[style],[onerror]')).toBeNull()
  expect([...root.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual([null, null, 'https://example.org/', '#heading'])
  expect(root.querySelector('a[href="https://example.org/"]')?.getAttribute('rel')).toBe('noopener noreferrer')
  expect([...root.querySelectorAll('button[data-review-image]')].map(b => b.getAttribute('data-review-image'))).toEqual(['https://tracker.invalid/pixel', 'https://tracker.invalid/two'])
  expect(sanitize.mock.calls.some(([input, options]) => String(input).includes('<script>') && !options?.RETURN_DOM_FRAGMENT)).toBe(true)
  expect(sanitize.mock.calls.some(([, options]) => options?.RETURN_DOM_FRAGMENT)).toBe(true)
  expect(fetch).not.toHaveBeenCalled(); sanitize.mockRestore(); vi.unstubAllGlobals()
})

it('keeps math, highlighted code and owner notes while never running diagrams', async () => {
  const html = await renderReviewMarkdown('$x^2$\n\n```js\nconst x = 1\n```\n\n```mermaid\ngraph LR; A-->B\n```\n\n{==owner==}{>>note<<}')
  expect(html).toContain('katex'); expect(html).toContain('hljs'); expect(html).toContain('language-mermaid')
  expect(html).toContain('crit-anno'); expect(document.querySelector('svg')).toBeNull()
})
