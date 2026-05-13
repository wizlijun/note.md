import { describe, it, expect } from 'vitest'
import {
  IMAGE_EXTENSIONS,
  ATTACHMENT_EXTENSIONS,
  isImageExt,
  isAttachmentExt,
  isAttachmentUrl,
  extOf,
  basenameOf,
  resourceFilename,
  filesDir,
  findTempRefs,
} from './paste-resources'

describe('extension sets', () => {
  it('IMAGE_EXTENSIONS contains common image types', () => {
    expect(IMAGE_EXTENSIONS.has('png')).toBe(true)
    expect(IMAGE_EXTENSIONS.has('jpg')).toBe(true)
    expect(IMAGE_EXTENSIONS.has('webp')).toBe(true)
    expect(IMAGE_EXTENSIONS.has('pdf')).toBe(false)
  })

  it('ATTACHMENT_EXTENSIONS contains doc/archive/media types', () => {
    expect(ATTACHMENT_EXTENSIONS.has('pdf')).toBe(true)
    expect(ATTACHMENT_EXTENSIONS.has('zip')).toBe(true)
    expect(ATTACHMENT_EXTENSIONS.has('mp4')).toBe(true)
    expect(ATTACHMENT_EXTENSIONS.has('png')).toBe(false)
  })
})

describe('isImageExt', () => {
  it('returns true for image paths', () => {
    expect(isImageExt('/some/dir/photo.PNG')).toBe(true)
    expect(isImageExt('file.jpeg')).toBe(true)
  })
  it('returns false for non-image paths', () => {
    expect(isImageExt('/docs/report.pdf')).toBe(false)
    expect(isImageExt('archive.zip')).toBe(false)
  })
})

describe('isAttachmentExt', () => {
  it('returns true for document/archive/media paths', () => {
    expect(isAttachmentExt('/docs/report.pdf')).toBe(true)
    expect(isAttachmentExt('data.xlsx')).toBe(true)
    expect(isAttachmentExt('video.mp4')).toBe(true)
  })
  it('returns false for images', () => {
    expect(isAttachmentExt('photo.jpg')).toBe(false)
  })
})

describe('isAttachmentUrl', () => {
  it('returns true for URLs ending in attachment extension', () => {
    expect(isAttachmentUrl('https://example.com/report.pdf')).toBe(true)
    expect(isAttachmentUrl('https://example.com/data.xlsx?v=1')).toBe(true)
  })
  it('returns false for plain URLs', () => {
    expect(isAttachmentUrl('https://example.com/')).toBe(false)
    expect(isAttachmentUrl('https://example.com/page.html')).toBe(false)
  })
  it('returns false for image URLs', () => {
    expect(isAttachmentUrl('https://example.com/photo.jpg')).toBe(false)
  })
})

describe('extOf', () => {
  it('returns lowercase extension without dot', () => {
    expect(extOf('report.PDF')).toBe('pdf')
    expect(extOf('/path/to/image.JPEG')).toBe('jpeg')
    expect(extOf('no-extension')).toBe('')
  })
})

describe('basenameOf', () => {
  it('returns filename from unix path', () => {
    expect(basenameOf('/home/user/docs/report.pdf')).toBe('report.pdf')
    expect(basenameOf('report.pdf')).toBe('report.pdf')
  })
  it('returns filename from windows path', () => {
    expect(basenameOf('C:\\Users\\user\\report.pdf')).toBe('report.pdf')
  })
})

describe('resourceFilename', () => {
  it('generates image-{timestamp}.{ext} format', () => {
    const name = resourceFilename('png')
    expect(name).toMatch(/^image-\d+\.png$/)
  })
  it('normalizes jpeg to jpg', () => {
    const name = resourceFilename('jpeg')
    expect(name).toMatch(/^image-\d+\.jpg$/)
  })
  it('uses bin for unknown type', () => {
    const name = resourceFilename('application/octet-stream')
    expect(name).toMatch(/^file-\d+\.bin$/)
  })
})

describe('filesDir', () => {
  it('returns {docDir}/{basename}_files for a named document', () => {
    expect(filesDir('/home/user/notes/report.md')).toBe('/home/user/notes/report_files')
  })
  it('handles windows paths', () => {
    expect(filesDir('C:/Users/bruce/notes/report.md')).toBe('C:/Users/bruce/notes/report_files')
  })
  it('strips only the last extension', () => {
    expect(filesDir('/docs/my.doc.md')).toBe('/docs/my.doc_files')
  })
})

describe('findTempRefs', () => {
  const tempDir = '/tmp/mdeditor-paste/abc123'

  it('finds image refs in temp dir', () => {
    const md = '![alt](/tmp/mdeditor-paste/abc123/image-1.png)'
    const refs = findTempRefs(md, tempDir)
    expect(refs).toHaveLength(1)
    expect(refs[0].absPath).toBe('/tmp/mdeditor-paste/abc123/image-1.png')
  })

  it('finds link refs in temp dir', () => {
    const md = '[report.pdf](/tmp/mdeditor-paste/abc123/file-2.pdf)'
    const refs = findTempRefs(md, tempDir)
    expect(refs).toHaveLength(1)
    expect(refs[0].absPath).toBe('/tmp/mdeditor-paste/abc123/file-2.pdf')
  })

  it('finds multiple refs', () => {
    const md = [
      '![a](/tmp/mdeditor-paste/abc123/image-1.png)',
      '![b](/tmp/mdeditor-paste/abc123/image-2.jpg)',
      '[doc](/tmp/mdeditor-paste/abc123/file.pdf)',
    ].join('\n')
    expect(findTempRefs(md, tempDir)).toHaveLength(3)
  })

  it('ignores refs outside temp dir', () => {
    const md = '![a](/other/dir/image.png) [b](/tmp/mdeditor-paste/abc123/image.png)'
    expect(findTempRefs(md, tempDir)).toHaveLength(1)
  })

  it('returns empty array when no temp refs', () => {
    expect(findTempRefs('plain text', tempDir)).toHaveLength(0)
  })
})
