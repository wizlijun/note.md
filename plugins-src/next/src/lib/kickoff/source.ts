/** Links are agent evidence claims, not a promise that NEXT fetched the page. */
export function isWebSource(resource: string): boolean {
  if (resource.length > 8192 || !/^https?:\/\//i.test(resource) || /[\s\\\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(resource)) return false
  try {
    const url = new URL(resource)
    return !!url.hostname && !url.username && !url.password
  } catch { return false }
}

export function safeVaultSource(resource: string): boolean {
  return !!resource && !/[\\:\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(resource)
    && resource.split('/').every(segment => !!segment && segment !== '.' && segment !== '..'
      && !['.notemd', '.git', '.claude', '.codex'].includes(segment.toLowerCase()))
}
