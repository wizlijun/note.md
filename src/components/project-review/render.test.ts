// @vitest-environment jsdom
// DOMPurify explicitly excludes happy-dom as a safe sanitizer host (its README).
import { expect, it, vi } from 'vitest'
import { renderReviewMarkdown } from './render'
import DOMPurify from 'dompurify'

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
