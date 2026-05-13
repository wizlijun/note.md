import { describe, it, expect } from 'vitest'
import {
  isYouTubeUrl,
  isBilibiliUrl,
  isVideoUrl,
  extractYouTubeId,
  extractBilibiliId,
  youTubeThumbnailUrl,
} from './video-links'

describe('isYouTubeUrl', () => {
  it('matches standard watch URL', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  })
  it('matches short URL', () => {
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
  })
  it('matches mobile URL', () => {
    expect(isYouTubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  })
  it('rejects non-youtube URL', () => {
    expect(isYouTubeUrl('https://example.com')).toBe(false)
  })
  it('rejects bilibili URL', () => {
    expect(isYouTubeUrl('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(false)
  })
})

describe('isBilibiliUrl', () => {
  it('matches BV format', () => {
    expect(isBilibiliUrl('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(true)
  })
  it('matches AV format', () => {
    expect(isBilibiliUrl('https://www.bilibili.com/video/av12345/')).toBe(true)
  })
  it('rejects non-bilibili URL', () => {
    expect(isBilibiliUrl('https://example.com')).toBe(false)
  })
})

describe('isVideoUrl', () => {
  it('returns true for YouTube', () => {
    expect(isVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
  })
  it('returns true for Bilibili', () => {
    expect(isVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(true)
  })
  it('returns false for plain URL', () => {
    expect(isVideoUrl('https://example.com/report.pdf')).toBe(false)
  })
})

describe('extractYouTubeId', () => {
  it('extracts from watch URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts from short URL', () => {
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts from URL with extra params', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s')).toBe('dQw4w9WgXcQ')
  })
  it('returns null for non-YouTube URL', () => {
    expect(extractYouTubeId('https://example.com')).toBeNull()
  })
})

describe('extractBilibiliId', () => {
  it('extracts BV number', () => {
    expect(extractBilibiliId('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe('BV1xx411c7mD')
  })
  it('extracts AV number as string', () => {
    expect(extractBilibiliId('https://www.bilibili.com/video/av12345/')).toBe('av12345')
  })
  it('returns null for non-bilibili URL', () => {
    expect(extractBilibiliId('https://example.com')).toBeNull()
  })
})

describe('youTubeThumbnailUrl', () => {
  it('constructs mqdefault thumbnail URL', () => {
    expect(youTubeThumbnailUrl('dQw4w9WgXcQ')).toBe(
      'https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg'
    )
  })
})
