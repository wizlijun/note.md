import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'

const homes = ['index.html', 'zh/index.html', 'de/index.html', 'ja/index.html']

describe('localized homepage download actions', () => {
  it.each(homes)('offers native Linux downloads on %s', (home) => {
    const window = new Window()
    const html = readFileSync(join(__dirname, '..', 'public', home), 'utf8')
    window.document.body.innerHTML = html
    const script = [...window.document.querySelectorAll('script')].find(el => el.textContent.includes('navigator.userAgentData'))!
    runInNewContext(script.textContent, { document: window.document, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux aarch64)' } })
    const buttons = [...window.document.querySelectorAll('[data-dl]')]
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button.getAttribute('href')).toBe('/download?os=linux&format=arch')
      expect(button.querySelector('.bl')?.textContent).toContain('Omarchy')
    }
    expect(window.document.querySelector('[data-plat="linux"]')?.hidden).toBe(false)
    for (const note of window.document.querySelectorAll('[data-plat="linux"]')) {
      expect(note.textContent).toContain('sudo pacman -U <')
      expect(note.textContent).not.toContain('*.pkg.tar.zst')
    }
    const firstPackage = window.document.querySelector('.fine a[href*="format="]')
    expect(firstPackage?.getAttribute('href')).toContain('format=arch')
    for (const arch of ['x86_64', 'aarch64']) {
      for (const format of ['deb', 'arch']) {
        expect(window.document.querySelector(`a[href="/download?os=linux&format=${format}&arch=${arch}"]`)).not.toBeNull()
      }
    }
    window.happyDOM.abort()
  })

  it.each([
    { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', href: '/download?os=windows', platform: 'win' },
    { ua: 'Mozilla/5.0 (Linux; Android 15; arm64)', href: 'https://github.com/wizlijun/note.md/releases', platform: 'other' },
  ])('preserves the $platform download action', ({ ua, href, platform }) => {
    const window = new Window()
    window.document.body.innerHTML = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8')
    const script = [...window.document.querySelectorAll('script')].find(el => el.textContent.includes('navigator.userAgentData'))!
    runInNewContext(script.textContent, { document: window.document, navigator: { userAgent: ua } })
    expect(window.document.querySelector('[data-dl]')?.getAttribute('href')).toBe(href)
    expect(window.document.querySelector(`[data-plat="${platform}"]`)?.hidden).toBe(false)
    window.happyDOM.abort()
  })
})
