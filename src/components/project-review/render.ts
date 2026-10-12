import DOMPurify from 'dompurify'
import { renderTabBody } from '../../lib/plugins/host-render-html'

export function approvedUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch { return null }
}

/** Browser-host only: nothing reaches a live DOM before resource neutralization. */
export async function renderReviewMarkdown(text: string): Promise<string> {
  const options = {
    USE_PROFILES: { html: true }, ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'link', 'base', 'form', 'video', 'audio', 'source', 'picture', 'input', 'button', 'textarea', 'select', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset', 'ping', 'autofocus', 'poster', 'background'],
  }
  const html = await renderTabBody({ kind: 'markdown', currentContent: text, language: '' }, {
    sanitizeHtml: raw => DOMPurify.sanitize(raw, options),
  })
  const fragment = DOMPurify.sanitize(html, { ...options, RETURN_DOM_FRAGMENT: true })
  for (const img of fragment.querySelectorAll('img')) {
    const url = approvedUrl(img.getAttribute('src') ?? '')
    const placeholder = document.createElement(url ? 'button' : 'span')
    placeholder.textContent = `${img.getAttribute('alt') || '图片'} · ${url ?? '资源未加载'}`
    if (url) {
      placeholder.setAttribute('type', 'button')
      placeholder.setAttribute('data-review-image', url)
      placeholder.textContent = `加载图片：${placeholder.textContent}`
    }
    img.replaceWith(placeholder)
  }
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? ''
    const url = approvedUrl(href)
    if (url) link.setAttribute('href', url)
    else if (!/^#[^\s]*$/.test(href)) link.removeAttribute('href')
    link.removeAttribute('target'); link.removeAttribute('download')
    link.setAttribute('rel', 'noopener noreferrer')
  }
  // Strip any other resource-bearing attributes, including obsolete HTML tags.
  for (const element of fragment.querySelectorAll('*')) {
    for (const attr of ['src', 'srcset', 'background', 'poster', 'action', 'formaction', 'xlink:href']) element.removeAttribute(attr)
  }
  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
}
