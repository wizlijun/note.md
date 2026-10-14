export type BundleFile = { path: string; dataUrl?: string }
/** Resolve only logical shared paths, with no filesystem or URL authority. */
export function sharedPath(href: string, currentPath: string): string | null {
  if (!href || /^[a-z][a-z\d+.-]*:|^[\\/]|[\\\0]/i.test(href)) return null
  let value: string
  try { value = decodeURIComponent(href.split(/[?#]/, 1)[0]) } catch { return null }
  if (!value || /^[a-z][a-z\d+.-]*:|^[\\/]|[\\\0]/i.test(value)) return null
  const parts = currentPath.split('/').slice(0, -1)
  for (const part of value.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop() }
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}
const rasterData = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i
/** Approved snapshot raster bytes only; draft URLs never carry resource authority. */
export function sharedRaster(files: readonly BundleFile[], currentPath: string, src: string): string {
  const path = sharedPath(src, currentPath), value = files.find(file => file.path === path)?.dataUrl
  return value && rasterData.test(value) ? value : ''
}
