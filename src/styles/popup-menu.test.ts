import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const popupMenuCss = readFileSync(new URL('./popup-menu.css', import.meta.url), 'utf8')
const foundationCss = readFileSync(new URL('./ui-foundation.css', import.meta.url), 'utf8')

describe('shared popup menu focus chrome', () => {
  it('does not draw a container focus ring while preserving item focus handling', () => {
    expect(popupMenuCss).toMatch(/\.menu-panel:focus\s*\{[^}]*outline:\s*none;/s)
    expect(foundationCss).toMatch(/:not\(\.menu-panel\):focus-visible/)
  })
})
