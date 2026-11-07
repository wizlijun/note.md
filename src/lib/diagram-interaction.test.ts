/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest'
import { desktopDiagramInteraction } from './diagram-interaction'
import { isDiagramInteractionTarget } from './diagram-interaction-target'
import { i18n, type Locale } from './i18n/runtime.svelte'

afterEach(() => { i18n.locale = 'en'; document.body.replaceChildren() })

describe('desktop diagram context', () => {
  it('keeps stable capability identities per locale without mixing translated labels', () => {
    const values = new Map<Locale, ReturnType<typeof desktopDiagramInteraction>>()
    for (const locale of ['en', 'zh', 'ja', 'de'] as const) {
      i18n.locale = locale
      const options = desktopDiagramInteraction()
      expect(desktopDiagramInteraction()).toBe(options)
      expect(Object.values(options.labels!)).toHaveLength(6)
      expect(Object.values(options.labels!).every(label => label && !label.startsWith('diagram.'))).toBe(true)
      values.set(locale, options)
    }
    i18n.locale = 'zh'
    expect(desktopDiagramInteraction()).toBe(values.get('zh'))
    expect(values.get('zh')?.labels?.reset).toBe('恢复默认大小（100%）')
    expect(values.get('en')?.labels?.reset).toBe('Reset to default size (100%)')
    expect(values.get('zh')?.labels?.hint).toContain('点击图表后')
    for (const value of values.values()) {
      expect(value.labels?.hint).toContain('Shift')
      expect(value.labels?.hint).toContain('F')
    }
  })

  it('separates preview and toolbar keys from source text and unrelated controls', () => {
    const wrapper = document.createElement('div')
    wrapper.className = 'code-block-wrapper diagram-interactive'
    wrapper.innerHTML = '<div class="code-block-toolbar" data-diagram-interaction><button><svg><path/></svg></button></div><div data-diagram-interaction><svg><path/></svg></div><pre><code>graph TD</code></pre>'
    document.body.append(wrapper)
    for (const el of wrapper.querySelectorAll('button, path')) expect(isDiagramInteractionTarget(el)).toBe(true)
    expect(isDiagramInteractionTarget(wrapper.querySelector('code'))).toBe(false)
    expect(isDiagramInteractionTarget(document.body)).toBe(false)
    expect(isDiagramInteractionTarget(null)).toBe(false)
    wrapper.classList.remove('diagram-interactive')
    // Source-mode controls retain their context while the code itself stays editable.
    expect(isDiagramInteractionTarget(wrapper.querySelector('button'))).toBe(true)
    expect(isDiagramInteractionTarget(wrapper.querySelector('code'))).toBe(false)
    wrapper.querySelector('.code-block-toolbar')!.removeAttribute('data-diagram-interaction')
    expect(isDiagramInteractionTarget(wrapper.querySelector('button'))).toBe(false)
  })
})
