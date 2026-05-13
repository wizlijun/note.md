export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif',
])

export const ATTACHMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'gz', 'tar', 'rar', '7z',
  'mp3', 'wav', 'ogg', 'flac',
  'mp4', 'mov', 'avi', 'mkv', 'webm',
  'txt', 'csv', 'json', 'xml',
])

export function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1 || dot === path.length - 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

export function basenameOf(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*\//, '')
}

export function isImageExt(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extOf(path))
}

export function isAttachmentExt(path: string): boolean {
  return ATTACHMENT_EXTENSIONS.has(extOf(path))
}

export function isAttachmentUrl(url: string): boolean {
  const clean = url.replace(/[?#].*$/, '')
  const ext = extOf(clean)
  return ATTACHMENT_EXTENSIONS.has(ext)
}

export function resourceFilename(mimeOrExt: string): string {
  const ts = Date.now()
  let ext = mimeOrExt.includes('/') ? mimeOrExt.split('/')[1] : mimeOrExt
  ext = ext?.split('+')[0] ?? 'bin'
  ext = ext === 'jpeg' ? 'jpg' : ext
  const isKnown = IMAGE_EXTENSIONS.has(ext) || ATTACHMENT_EXTENSIONS.has(ext)
  if (!isKnown) ext = 'bin'
  const prefix = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file'
  return `${prefix}-${ts}.${ext}`
}

/** Returns {docDir}/{docBasename}_files  (no trailing slash) */
export function filesDir(docFilePath: string): string {
  const norm = docFilePath.replace(/\\/g, '/')
  const dir = norm.replace(/\/[^/]+$/, '')
  const base = norm.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
  return `${dir}/${base}_files`
}

/** Scan markdown for links/images whose href starts with tempDir. */
export function findTempRefs(
  markdown: string,
  tempDir: string,
): Array<{ absPath: string }> {
  const prefix = tempDir.endsWith('/') ? tempDir : tempDir + '/'
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`!?\\[[^\\]]*\\]\\((${escaped}[^)]+)\\)`, 'g')
  const refs: Array<{ absPath: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    refs.push({ absPath: m[1] })
  }
  return refs
}

/**
 * Move all resources under tempDir to {docBasename}_files/, update markdown refs.
 * Silently keeps absolute paths for any file that fails to move.
 */
export async function migrateTempResources(
  markdown: string,
  tempDir: string,
  newDocFilePath: string,
): Promise<string> {
  const refs = findTempRefs(markdown, tempDir)
  if (refs.length === 0) return markdown

  const norm = newDocFilePath.replace(/\\/g, '/')
  const docDir = norm.replace(/\/[^/]+$/, '')
  const docBasenameWithExt = norm.replace(/^.*\//, '')
  const docBasename = docBasenameWithExt.replace(/\.[^.]+$/, '')
  const targetDir = `${docDir}/${docBasename}_files`

  const { invoke } = await import('@tauri-apps/api/core')
  let result = markdown

  for (const { absPath } of refs) {
    const filename = absPath.replace(/^.*\//, '')
    const newAbsPath = `${targetDir}/${filename}`
    const relPath = `${docBasename}_files/${filename}`
    try {
      await invoke('rename_file', { oldPath: absPath, newPath: newAbsPath })
      result = result.replaceAll(absPath, relPath)
    } catch {
      // leave absolute path intact — file stays in temp dir
    }
  }
  return result
}

// ── Tauri-dependent section ───────────────────────────────────────────────────

const SESSION_ID = Math.random().toString(36).slice(2, 10)
let _cachedTempDir: string | null = null

/** Returns the per-session temp directory for clipboard resources. Cached after first call. */
export async function getTempDir(): Promise<string> {
  if (_cachedTempDir) return _cachedTempDir
  const { appLocalDataDir } = await import('@tauri-apps/api/path')
  const base = (await appLocalDataDir()).replace(/\\/g, '/').replace(/\/$/, '')
  _cachedTempDir = `${base}/paste-temp/${SESSION_ID}`
  return _cachedTempDir
}

/**
 * Save a clipboard File to disk and return the path to use in markdown.
 *
 * Named doc   → saves to {docDir}/{basename}_files/, returns relative path
 * Untitled doc → saves to temp dir, returns absolute path (migrated on first save)
 */
export async function saveClipboardResource(
  file: File,
  docFilePath: string,  // empty string = untitled
): Promise<string> {
  const filename = resourceFilename(file.type || extOf(file.name) || 'bin')

  let targetDir: string
  let returnRelative: boolean

  if (docFilePath) {
    targetDir = filesDir(docFilePath)
    returnRelative = true
  } else {
    targetDir = await getTempDir()
    returnRelative = false
  }

  const absPath = `${targetDir}/${filename}`

  // Encode to base64
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + CHUNK) as unknown as number[]))
  }
  const base64 = btoa(binary)

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('write_file_binary', { path: absPath, base64Data: base64 })

  if (returnRelative) {
    const norm = docFilePath.replace(/\\/g, '/')
    const docBasename = norm.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
    return `${docBasename}_files/${filename}`
  }
  return absPath
}
