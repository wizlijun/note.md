import { describe, it, expect } from 'vitest'
import { minHostSatisfied, pickAvailable, pickUpdateTo, platformSatisfied } from './select'
import type { RegistryEntry } from './types'

function entry(id: string, version: string, min_host: string, name = id): RegistryEntry {
  return {
    id,
    version,
    min_host,
    archs: ['universal'],
    size: 1,
    sha256: { universal: 'aa' },
    name,
    description: null,
    download: { universal: `https://plugins.notemd.net/api/download/${id}/${version}/universal` },
  }
}

// The real registry shape: four pos-log versions with mixed floors.
const posLog = [
  entry('notemd.pos-log', '1.0.1', '>=6.716.7', 'Position Log'),
  entry('notemd.pos-log', '1.0.2', '>=6.720.4', 'Position Log'),
  entry('notemd.pos-log', '1.0.3', '>=6.716.7', 'Position Log'),
  entry('notemd.pos-log', '1.1.0', '>=6.720.4', 'Position Log'),
]

describe('minHostSatisfied', () => {
  it('evaluates >= against dotted numeric versions', () => {
    expect(minHostSatisfied('>=6.716.7', '6.716.7')).toBe(true)
    expect(minHostSatisfied('>=6.716.7', '6.720.0')).toBe(true)
    expect(minHostSatisfied('>=6.716.7', '6.716.6')).toBe(false)
  })

  it('compares components numerically, not lexically', () => {
    expect(minHostSatisfied('>=6.9.0', '6.10.0')).toBe(true)
  })

  it('supports comma-separated comparator lists', () => {
    expect(minHostSatisfied('>=1.0.0, <2.0.0', '1.5.0')).toBe(true)
    expect(minHostSatisfied('>=1.0.0, <2.0.0', '2.0.0')).toBe(false)
  })

  it('fails open on unparseable ranges, wildcard, and unknown host', () => {
    // Display selection must never hide what the installer might accept — the
    // installer re-checks engines authoritatively at install time.
    expect(minHostSatisfied('^1.2.3', '0.0.1')).toBe(true)
    expect(minHostSatisfied('*', '0.0.1')).toBe(true)
    expect(minHostSatisfied('>=6.716.7', null)).toBe(true)
  })
})

describe('pickAvailable', () => {
  it('collapses multiple versions of one id to the newest the host satisfies', () => {
    expect(pickAvailable(posLog, new Set(), '6.717.0').map((e) => e.version)).toEqual(['1.0.3'])
    expect(pickAvailable(posLog, new Set(), '6.722.1').map((e) => e.version)).toEqual(['1.1.0'])
  })

  it('falls back to the newest version when the host satisfies none', () => {
    const dl = [entry('notemd.decision-log', '1.0.1', '>=6.722.1', 'Decision')]
    expect(pickAvailable(dl, new Set(), '6.717.0').map((e) => e.version)).toEqual(['1.0.1'])
  })

  it('excludes installed ids entirely', () => {
    expect(pickAvailable(posLog, new Set(['notemd.pos-log']), '6.722.1')).toEqual([])
  })

  it('sorts by id, not by the localized display name', () => {
    // Display names are translated, so ordering on them would reshuffle the
    // catalogue whenever the app language changes. Here the name order is the
    // reverse of the id order, which pins which one wins.
    const mixed = [
      entry('notemd.b', '1.0.0', '>=0.0.0', 'Alpha'),
      entry('notemd.a', '1.0.0', '>=0.0.0', 'Zeta'),
    ]
    expect(pickAvailable(mixed, new Set(), null).map((e) => e.id)).toEqual([
      'notemd.a',
      'notemd.b',
    ])
  })
})

describe('pickUpdateTo', () => {
  it('offers the newest compatible version newer than the installed one', () => {
    expect(pickUpdateTo(posLog, 'notemd.pos-log', '1.0.1', '6.717.0')).toBe('1.0.3')
    expect(pickUpdateTo(posLog, 'notemd.pos-log', '1.0.1', '6.722.1')).toBe('1.1.0')
  })

  it('returns null when nothing newer is compatible', () => {
    expect(pickUpdateTo(posLog, 'notemd.pos-log', '1.0.3', '6.717.0')).toBe(null)
    expect(pickUpdateTo(posLog, 'notemd.pos-log', '1.1.0', '6.722.1')).toBe(null)
    expect(pickUpdateTo(posLog, 'notemd.other', '0.1.0', '6.722.1')).toBe(null)
  })
})

const linux = 'x86_64-unknown-linux-gnu'
const mac = 'aarch64-apple-darwin'
function platformEntry(version: string, arch: string): RegistryEntry {
  return { ...entry('vendor.plugin', version, '>=6.0.0'), archs: [arch],
    download: { [arch]: 'https://plugins.notemd.net/package' }, sha256: { [arch]: 'aa' } }
}

describe('platform-compatible selection', () => {
  it('selects an older Linux package over the latest macOS-only package', () => {
    const entries = [platformEntry('2.0.0', mac), platformEntry('1.0.0', linux)]
    expect(pickAvailable(entries, new Set(), '6.1015.1', linux)[0].version).toBe('1.0.0')
    expect(pickUpdateTo(entries, 'vendor.plugin', '0.9.0', '6.1015.1', linux)).toBe('1.0.0')
    expect(pickUpdateTo(entries, 'vendor.plugin', '1.0.0', '6.1015.1', linux)).toBeNull()
  })

  it('keeps incompatible entries discoverable and universal UI packages installable regardless of id', () => {
    const native = platformEntry('2.0.0', mac)
    expect(pickAvailable([native], new Set(), '6.1015.1', linux)).toEqual([native])
    expect(platformSatisfied(native, linux)).toBe(false)
    expect(platformSatisfied(entry('vendor.native-sounding-name', '1.0.0', '*'), linux)).toBe(true)
  })

  it('requires advertised architecture and resolvable download plus hash metadata', () => {
    const e = platformEntry('1.0.0', linux)
    expect(platformSatisfied({ ...e, download: {} }, linux)).toBe(false)
    expect(platformSatisfied({ ...e, sha256: {} }, linux)).toBe(false)
    expect(platformSatisfied({ ...e, archs: [mac] }, linux)).toBe(false)
    // Installer resolves download and hash independently, falling back to universal.
    expect(platformSatisfied({ ...e, sha256: { universal: 'aa' } }, linux)).toBe(true)
  })

  it('fails closed for unknown platform while preserving callers that omit the optional triple', () => {
    const entries = [platformEntry('2.0.0', mac)]
    expect(platformSatisfied(entries[0], null)).toBe(false)
    expect(pickUpdateTo(entries, 'vendor.plugin', '1.0.0', '6.1015.1', null)).toBeNull()
    expect(pickUpdateTo(entries, 'vendor.plugin', '1.0.0', '6.1015.1')).toBe('2.0.0')
  })
})
