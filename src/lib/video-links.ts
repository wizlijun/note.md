export interface VideoInfo {
  title: string
  thumbnailUrl: string
  videoUrl: string
  platform: 'youtube' | 'bilibili'
}

// ── URL detection ─────────────────────────────────────────────────────────────

export function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.|m\.)?youtube\.com\/watch/.test(url)
    || /^https?:\/\/youtu\.be\//.test(url)
}

export function isBilibiliUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?bilibili\.com\/video\//.test(url)
}

export function isVideoUrl(url: string): boolean {
  return isYouTubeUrl(url) || isBilibiliUrl(url)
}

// ── ID extraction ─────────────────────────────────────────────────────────────

export function extractYouTubeId(url: string): string | null {
  const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
    || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

export function extractBilibiliId(url: string): string | null {
  const bv = url.match(/\/video\/(BV[a-zA-Z0-9]+)/)
  if (bv) return bv[1]
  const av = url.match(/\/video\/(av\d+)/i)
  if (av) return av[1].toLowerCase()
  return null
}

export function youTubeThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
}

// ── Async fetch (Tauri-dependent) ─────────────────────────────────────────────

export async function fetchVideoInfo(url: string): Promise<VideoInfo | null> {
  try {
    if (isYouTubeUrl(url)) return await fetchYouTubeInfo(url)
    if (isBilibiliUrl(url)) return await fetchBilibiliInfo(url)
    return null
  } catch {
    return null
  }
}

async function fetchYouTubeInfo(url: string): Promise<VideoInfo | null> {
  const videoId = extractYouTubeId(url)
  if (!videoId) return null

  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
  const resp = await fetch(oembedUrl)
  if (!resp.ok) return null
  const data = await resp.json() as { title?: string; thumbnail_url?: string }

  return {
    title: data.title || 'YouTube Video',
    thumbnailUrl: data.thumbnail_url || youTubeThumbnailUrl(videoId),
    videoUrl: url,
    platform: 'youtube',
  }
}

async function fetchBilibiliInfo(url: string): Promise<VideoInfo | null> {
  const id = extractBilibiliId(url)
  if (!id) return null

  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  const apiUrl = id.startsWith('av')
    ? `https://api.bilibili.com/x/web-interface/view?aid=${id.slice(2)}`
    : `https://api.bilibili.com/x/web-interface/view?bvid=${id}`

  const resp = await tauriFetch(apiUrl)
  if (!resp.ok) return null
  const data = await resp.json() as { code?: number; data?: { title?: string; pic?: string } }
  if (data.code !== 0 || !data.data) return null

  return {
    title: data.data.title || 'Bilibili Video',
    thumbnailUrl: data.data.pic || '',
    videoUrl: url,
    platform: 'bilibili',
  }
}
