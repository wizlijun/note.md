<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import { outlineGate, setOutlineWidth, MIN_WIDTH, MAX_WIDTH } from '../../lib/outline/gate.svelte'
  import { t } from '../../lib/i18n/store.svelte'

  let { tab }: { tab: Tab } = $props()

  let dragging = false
  function onSplitterDown(e: PointerEvent) {
    dragging = true
    const startX = e.clientX
    const startW = outlineGate.width
    const move = (ev: PointerEvent) => {
      if (!dragging) return
      const w = startW + (startX - ev.clientX)
      outlineGate.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w))
    }
    const up = () => {
      dragging = false
      void setOutlineWidth(outlineGate.width)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
</script>

<aside class="outline-panel" style="width: {outlineGate.width}px">
  <div class="splitter" onpointerdown={onSplitterDown}></div>
  <header>
    <span class="title">{t('outline.title')}</span>
  </header>
  <div class="body">
    <!-- tree mounts here in Task 11 -->
    <p class="empty">{tab.title}</p>
  </div>
</aside>

<style>
  .outline-panel {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color, #3333);
    overflow: hidden;
  }
  .splitter {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 4px;
    cursor: col-resize;
    z-index: 5;
  }
  header {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    border-bottom: 1px solid var(--border-color, #3333);
  }
  .body { flex: 1; overflow-y: auto; padding: 8px; }
  .empty { opacity: 0.5; font-size: 12px; }
</style>
