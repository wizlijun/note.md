import { describe, it, expect, vi } from 'vitest'
import { classifyPath, isSupportedPath, looksBinary, modeKeyFor } from './fs'

describe('classifyPath', () => {
  it('markdown extensions', () => {
    expect(classifyPath('foo.md')).toEqual({ kind: 'markdown' })
    expect(classifyPath('foo.markdown')).toEqual({ kind: 'markdown' })
    expect(classifyPath('foo.mdown')).toEqual({ kind: 'markdown' })
    expect(classifyPath('foo.mkd')).toEqual({ kind: 'markdown' })
  })

  it('html extensions', () => {
    expect(classifyPath('foo.html')).toEqual({ kind: 'html' })
    expect(classifyPath('foo.htm')).toEqual({ kind: 'html' })
  })

  it('code extensions with language', () => {
    expect(classifyPath('foo.py')).toEqual({ kind: 'code', language: 'python' })
    expect(classifyPath('foo.json')).toEqual({ kind: 'code', language: 'json' })
    expect(classifyPath('foo.ts')).toEqual({ kind: 'code', language: 'typescript' })
    expect(classifyPath('foo.rs')).toEqual({ kind: 'code', language: 'rust' })
    expect(classifyPath('foo.yml')).toEqual({ kind: 'code', language: 'yaml' })
    expect(classifyPath('foo.sh')).toEqual({ kind: 'code', language: 'bash' })
  })

  it('plain-text extensions with empty language', () => {
    expect(classifyPath('foo.txt')).toEqual({ kind: 'code', language: '' })
    expect(classifyPath('foo.log')).toEqual({ kind: 'code', language: '' })
    expect(classifyPath('foo.csv')).toEqual({ kind: 'code', language: '' })
  })

  it('special filenames (no extension)', () => {
    expect(classifyPath('/path/to/Dockerfile')).toEqual({ kind: 'code', language: 'dockerfile' })
    expect(classifyPath('/repo/Makefile')).toEqual({ kind: 'code', language: 'makefile' })
    expect(classifyPath('Gemfile')).toEqual({ kind: 'code', language: 'ruby' })
  })

  it('case insensitive', () => {
    expect(classifyPath('FOO.PY')).toEqual({ kind: 'code', language: 'python' })
    expect(classifyPath('README.MD')).toEqual({ kind: 'markdown' })
    expect(classifyPath('DOCKERFILE')).toEqual({ kind: 'code', language: 'dockerfile' })
  })

  it('unknown extensions return null', () => {
    expect(classifyPath('foo.png')).toBe(null)
    expect(classifyPath('foo.exe')).toBe(null)
    expect(classifyPath('noextension')).toBe(null)
  })
})

describe('isSupportedPath', () => {
  it('returns true for supported extensions', () => {
    expect(isSupportedPath('foo.md')).toBe(true)
    expect(isSupportedPath('foo.html')).toBe(true)
    expect(isSupportedPath('foo.py')).toBe(true)
    expect(isSupportedPath('Dockerfile')).toBe(true)
  })

  it('returns false for unsupported', () => {
    expect(isSupportedPath('foo.png')).toBe(false)
    expect(isSupportedPath('foo')).toBe(false)
  })
})

describe('looksBinary', () => {
  it('plain text returns false', () => {
    expect(looksBinary('hello world')).toBe(false)
    expect(looksBinary('# Title\n\nSome text\n')).toBe(false)
    expect(looksBinary('')).toBe(false)
  })

  it('content with NUL byte returns true', () => {
    expect(looksBinary('hello\x00world')).toBe(true)
  })

  it('mostly non-printable returns true', () => {
    let s = ''
    for (let i = 0; i < 100; i++) s += '\x01'
    s += 'abcde'
    expect(looksBinary(s)).toBe(true)
  })

  it('common control chars (tab, LF, CR) are OK', () => {
    expect(looksBinary('a\tb\nc\rd')).toBe(false)
  })
})

describe('modeKeyFor', () => {
  it('returns lowercased extension for normal files', () => {
    expect(modeKeyFor('/tmp/foo.md')).toBe('md')
    expect(modeKeyFor('/tmp/script.PY')).toBe('py')
    expect(modeKeyFor('relative/path/index.html')).toBe('html')
  })

  it('returns full basename for files without extension', () => {
    expect(modeKeyFor('/repo/Dockerfile')).toBe('dockerfile')
    expect(modeKeyFor('Makefile')).toBe('makefile')
  })

  it('treats dotfiles as full-name keys (not extensions)', () => {
    expect(modeKeyFor('/proj/.env')).toBe('.env')
    expect(modeKeyFor('.gitignore')).toBe('.gitignore')
  })

  it('handles multiple dots — uses the last one', () => {
    expect(modeKeyFor('/tmp/archive.tar.gz')).toBe('gz')
    expect(modeKeyFor('/proj/.env.local')).toBe('local')
  })
})

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  stat: vi.fn(async () => ({ mtime: new Date(1_700_000_000_000), size: 42 })),
}))

describe('statFile', () => {
  it('returns mtime in ms and size from plugin-fs.stat', async () => {
    const { statFile } = await import('./fs')
    const info = await statFile('/tmp/foo.md')
    expect(info).not.toBeNull()
    expect(info!.mtime).toBe(1_700_000_000_000)
    expect(info!.size).toBe(42)
  })

  it('returns null when stat throws', async () => {
    const fsPlug = await import('@tauri-apps/plugin-fs')
    ;(fsPlug.stat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT'))
    const { statFile } = await import('./fs')
    expect(await statFile('/tmp/missing.md')).toBe(null)
  })
})
