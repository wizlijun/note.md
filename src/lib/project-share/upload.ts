export type ProjectUploadProgress = { phase: 'uploading'; loaded: number; total: number } | { phase: 'processing' }

/** XHR exposes request-body progress; completion still waits for the server receipt. */
export function uploadProjectArchive(url: string, headers: Record<string, string>, archive: Uint8Array, onProgress?: (progress: ProjectUploadProgress) => void): Promise<Response> {
  if (!onProgress) return fetch(url, { method: 'POST', headers, body: archive as BodyInit })
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', url)
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    request.upload.onprogress = event => onProgress({ phase: 'uploading', loaded: Math.min(event.loaded, archive.byteLength), total: archive.byteLength })
    request.upload.onload = () => onProgress({ phase: 'processing' })
    request.onerror = () => reject(new Error('ZIP 上传连接失败，请重试。'))
    request.onabort = () => reject(new Error('ZIP 上传已中断，请重试。'))
    request.ontimeout = () => reject(new Error('ZIP 上传超时，请重试。'))
    request.onload = () => {
      if (!request.status) { reject(new Error('ZIP 上传未收到服务端响应，请重试。')); return }
      resolve(new Response(request.responseText || null, { status: request.status }))
    }
    onProgress({ phase: 'uploading', loaded: 0, total: archive.byteLength })
    request.send(archive as XMLHttpRequestBodyInit)
  })
}
