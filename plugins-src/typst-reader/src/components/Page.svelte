<script lang="ts">
  import { loadPage } from '../lib/bridge'

  let { cacheKey, index, label }: { cacheKey: string; index: number; label: string } = $props()
  let element: HTMLElement | undefined = $state()
  let url = $state('')
  let error = $state('')
  let loading = $state(false)

  async function load() {
    if (loading || url || error) return
    loading = true
    try {
      const svg = await loadPage(cacheKey, index)
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    } catch (value) {
      error = value instanceof Error ? value.message : String(value)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    const node = element
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') { void load(); return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void load()
        observer.disconnect()
      }
    }, { rootMargin: '900px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  })

  $effect(() => () => { if (url) URL.revokeObjectURL(url) })
</script>

<article bind:this={element} id={`page-${index + 1}`} class="page" aria-label={label}>
  {#if url}
    <img src={url} alt={label} />
  {:else if error}
    <div class="page-error" role="alert">{error}</div>
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
