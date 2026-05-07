<script lang="ts">
  import { settings, saveSettings } from '../lib/settings.svelte'

  let { open = $bindable(false) }: { open: boolean } = $props()

  async function onToggle(e: Event) {
    settings.autoSave = (e.currentTarget as HTMLInputElement).checked
    await saveSettings()
  }
</script>

{#if open}
  <div
    class="overlay"
    role="presentation"
    onclick={() => (open = false)}
    onkeydown={(e) => e.key === 'Escape' && (open = false)}
  >
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
      <h2>Preferences</h2>
      <label class="row">
        <input type="checkbox" checked={settings.autoSave} onchange={onToggle} />
        Enable auto-save (writes after 800 ms idle)
      </label>
      <div class="actions">
        <button onclick={() => (open = false)}>Done</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.3);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
  }
  .dialog {
    min-width: 320px;
    background: Canvas;
    color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    border-radius: 8px;
    padding: 18px 20px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.25);
  }
  h2 { margin: 0 0 12px 0; font-size: 16px; }
  .row { display: flex; gap: 8px; align-items: center; font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; margin-top: 16px; }
  button {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    cursor: pointer;
  }
</style>
