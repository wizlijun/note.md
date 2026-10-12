<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener'
  import { approvedUrl, renderReviewMarkdown } from './render'
  let { text }: { text: string } = $props()
  let html = $state(''), error = $state('')
  $effect(() => {
    let active = true
    html = ''; error = ''
    void renderReviewMarkdown(text).then(value => { if (active) html = value }, e => { if (active) error = String(e) })
    return () => { active = false }
  })
  function actions(node: HTMLElement) {
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const image = target?.closest<HTMLButtonElement>('button[data-review-image]')
      if (image && node.contains(image)) {
        const url = approvedUrl(image.dataset.reviewImage ?? '')
        if (!url) return
        const img = document.createElement('img')
        img.alt = image.textContent ?? '已加载图片'; img.referrerPolicy = 'no-referrer'; img.src = url
        image.replaceWith(img)
        return
      }
      const link = target?.closest<HTMLAnchorElement>('a[href]')
      if (!link || !node.contains(link)) return
      event.preventDefault()
      const href = link.getAttribute('href') ?? ''
      if (href.startsWith('#')) {
        try { node.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)?.scrollIntoView({ block: 'nearest' }) } catch {}
      } else {
        const url = approvedUrl(href)
        if (url) void openUrl(url).catch(e => { error = String(e) })
      }
    }
    node.addEventListener('click', click)
    return { destroy() { node.removeEventListener('click', click) } }
  }
</script>
{#if error}<p role="alert">{error}</p>{/if}
<div class="rendered-preview" use:actions>{@html html}</div>
