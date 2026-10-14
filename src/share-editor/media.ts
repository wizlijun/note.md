import type { MediaResolver } from '@moraya/core'
import { Plugin } from 'prosemirror-state'
import { sharedRaster, type BundleFile } from './media-policy'
export { sharedPath } from './media-policy'
export function bundleMediaResolver(files: readonly BundleFile[], currentPath: string): MediaResolver {
  return {
    async loadLocalImage(path, source) { return sharedRaster(files, currentPath, source?.src ?? path) },
    async loadLocalMedia() { return '' },
    async loadRemoteMedia() { return '' },
  }
}
/** CORE's general schema can assign remote src directly; override before DOM creation. */
export function shareMediaPlugin(resolver: MediaResolver, notify: (text: string) => void): Plugin {
  const blocked = () => notify('无法添加图片或附件，请在批注中描述')
  return new Plugin({ props: {
    nodeViews: {
      image(node) {
        const dom = document.createElement('span'), img = document.createElement('img')
        dom.className = 'image-node'; img.alt = node.attrs.alt || ''; dom.append(img)
        let alive = true
        void resolver.loadLocalImage(node.attrs.src).then(url => {
          if (!alive) return
          if (url) img.src = url
          else dom.textContent = `![${node.attrs.alt || ''}](${node.attrs.src})`
        })
        return { dom, destroy() { alive = false } }
      },
      html_inline(node) {
        const dom = document.createElement('span'); dom.dataset.type = 'html-inline'
        dom.dataset.value = node.attrs.value; dom.textContent = node.attrs.value
        return { dom }
      },
    },
    handleDOMEvents: {
      paste(view, event) {
        const data = event.clipboardData
        if (data?.files?.length || [...(data?.items ?? [])].some(item => item.kind === 'file')) {
          event.preventDefault(); blocked(); return true
        }
        if (/<(?:img|video|audio|source)\b/i.test(data?.getData('text/html') ?? '')) {
          event.preventDefault(); blocked()
          const text = data?.getData('text/plain'); if (text) view.dispatch(view.state.tr.insertText(text))
          return true
        }
        return false
      },
      drop(_view, event) {
        if (event.dataTransfer?.files.length) { event.preventDefault(); blocked(); return true }
        return false
      },
    },
  } })
}
