import type { ArtifactName } from './multipart'

export type ProjectUploadProgress = { phase: 'uploading'; loaded: number; total: number; artifact?: ArtifactName; partNumber?: number; partCount?: number } | { phase: 'processing' }

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

/** Every part uses the same binary transport, with progress measured across its artifact. */
export function uploadProjectPart(url: string, headers: Record<string, string>, bytes: Uint8Array, position: { artifact: ArtifactName; partNumber: number; partCount: number; confirmedBytes: number; total: number }, onProgress?: (progress: ProjectUploadProgress) => void): Promise<Response> {
  return uploadProjectArchive(url, headers, bytes, onProgress ? progress => {
    if (progress.phase === 'uploading') onProgress({ phase: 'uploading', artifact: position.artifact, partNumber: position.partNumber, partCount: position.partCount,
      loaded: Math.min(position.total, position.confirmedBytes + progress.loaded), total: position.total })
  } : undefined).catch(error => {
    if (error instanceof Error && error.message.startsWith('ZIP 上传')) {
      const label = { entry: '入口文档', reader: '阅读页', archive: '项目 ZIP' }[position.artifact]
      throw new Error(error.message.replace(/^ZIP/, label))
    }
    throw error
  })
}
