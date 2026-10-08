import { describe, expect, it } from 'vitest'
import { districtLabelTarget } from './city-scene'

describe('district label target', () => {
  it('opens the named representative rather than the first aggregated member', () => {
    expect(districtLabelTarget('obsidian', ['recording-app', 'obsidian'], false)).toBe('obsidian')
  })

  it('opens a visible member when filtering hides the representative', () => {
    expect(districtLabelTarget('obsidian', ['recording-app'], true)).toBe('recording-app')
  })
})
