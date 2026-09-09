<script lang="ts">
  import { onMount } from 'svelte'
  import { loadCover } from '../bridge'
  import type { IndexImage } from '../model'
  let { uri, cover, zh }: { uri: string; cover?: IndexImage; zh: boolean } = $props()
  let element: HTMLDivElement
  let visible = $state(false)
  let source = $state('')
  let failed = $state(false)
  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') { visible = true; return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { visible = true; observer.disconnect() }
    }, { rootMargin: '160px' })
    observer.observe(element)
    return () => observer.disconnect()
  })
  $effect(() => {
    const currentUri = uri
    const href = cover?.href
    source = ''
    failed = false
    if (!visible || !href) return
    let disposed = false
    let owned = ''
    void loadCover(currentUri, href).then((url) => {
      if (disposed) { URL.revokeObjectURL(url); return }
      owned = url
      source = url
    }).catch(() => { if (!disposed) failed = true })
    return () => { disposed = true; if (owned) URL.revokeObjectURL(owned) }
  })
</script>
<div bind:this={element} class="cover" class:failed>
  {#if source && !failed}
    <img src={source} alt={cover?.alt || (zh ? '封面' : 'Cover')} onerror={() => { failed = true }} />
  {:else}
    <svg width="34" height="38" viewBox="0 0 24 28" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M5 3h15v22H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"/><path d="M5 3v18M2 22a3 3 0 0 1 3-3h15M9 8h7M9 12h5"/></svg>
    <span>{failed ? (zh ? '封面无法加载' : 'Cover unavailable') : cover ? (zh ? '载入封面' : 'Loading cover') : (zh ? '暂无封面' : 'No cover')}</span>
  {/if}
</div>
<style>
  .cover { aspect-ratio: 4 / 3; background: var(--ui-bg); color: var(--ui-tertiary); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 16px; box-sizing: border-box; overflow: hidden; }
  .cover img { display: block; width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 5px 7px #0002); }
  .cover span { font-size: 11px; }
</style>
