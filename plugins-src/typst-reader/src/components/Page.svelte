<script lang="ts">
  import { loadPage } from '../lib/bridge'

  let { cacheKey, index, label }: { cacheKey: string; index: number; label: string } = $props()
  let element: HTMLElement | undefined = $state()
  let url = $state('')
  let error = $state('')
  let retry: (() => void) | undefined

  $effect(() => {
    const node = element
    const key = cacheKey
    const page = index
    if (!node) return
    let disposed = false
    let visible = false
    let revision = 0
    let objectUrl = ''
    let loading = false
    const release = () => {
      revision++
      loading = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      objectUrl = ''
      url = ''
    }
    const load = async () => {
      if (disposed || !visible || loading || objectUrl) return
      const current = ++revision
      loading = true
      error = ''
      try {
        const svg = await loadPage(key, page)
        // Requests cannot be aborted across the host bridge. Ignore late data
        // before allocating a blob, including data for pages scrolled away.
        if (disposed || !visible || current !== revision) return
        objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
        url = objectUrl
      } catch (value) {
        if (!disposed && visible && current === revision) error = value instanceof Error ? value.message : String(value)
      } finally {
        if (current === revision) loading = false
      }
    }
    retry = () => { void load() }
    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver === 'undefined') {
      visible = true
      void load()
    } else {
      observer = new IntersectionObserver(entries => {
        if (disposed) return
        const entry = entries.find(entry => entry.target === node)
        if (!entry) return
        visible = entry.isIntersecting
        if (visible) void load()
        else release()
      }, { rootMargin: '900px 0px' })
      observer.observe(node)
    }
    return () => {
      disposed = true
      observer?.disconnect()
      release()
      retry = undefined
    }
  })
</script>

<article bind:this={element} id={`page-${index + 1}`} class="page" aria-label={label}>
  {#if url}
    <img src={url} alt={label} />
  {:else if error}
    <div class="page-error" role="alert"><span>{error}</span><button type="button" aria-label={`Retry ${label}`} onclick={() => retry?.()}>↻</button></div>
  {:else}
    <div class="page-loading" role="status">{index + 1}</div>
  {/if}
</article>

<style>
  .page { width: 794px; aspect-ratio: 210 / 297; background: white; box-shadow: 0 2px 14px #0002; flex: 0 0 auto; }
  img { display: block; width: 100%; height: 100%; }
  .page-loading, .page-error { height: 100%; display: grid; place-items: center; color: #8b8b90; font: 12px -apple-system, BlinkMacSystemFont, sans-serif; }
  .page-error { color: #b42318; padding: 24px; box-sizing: border-box; text-align: center; }
</style>
