<script lang="ts">
  import { onMount } from 'svelte'

  let { title, initialValue = '', link = false, onClose }: {
    title: string
    initialValue?: string
    link?: boolean
    onClose: (value: string | null) => void
  } = $props()
  let dialog: HTMLDialogElement
  let input: HTMLInputElement
  let error = $state('')

  function submit(event: SubmitEvent): void {
    event.preventDefault()
    let value = input.value.trim()
    if (link) {
      try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
        value = url.href
      } catch {
        error = '请输入完整的 http:// 或 https:// 链接。'
        input.focus()
        return
      }
    }
    onClose(value)
  }

  onMount(() => {
    dialog.showModal()
    input.focus()
    input.select()
  })
</script>

<dialog
  class="canvas-input-dialog"
  bind:this={dialog}
  aria-label={title}
  oncancel={(event) => { event.preventDefault(); onClose(null) }}
>
  <form onsubmit={submit}>
    <label>
      <strong>{title}</strong>
      <input bind:this={input} value={initialValue} aria-label={title} aria-invalid={!!error} placeholder={link ? 'https://example.com' : '分组'} />
    </label>
    {#if error}<p role="alert">{error}</p>{/if}
    <footer>
      <button type="button" onclick={() => onClose(null)}>取消</button>
      <button type="submit" class="confirm">确定</button>
    </footer>
  </form>
</dialog>

<style>
  .canvas-input-dialog {
    width: min(360px, calc(100vw - 48px));
    box-sizing: border-box;
    padding: 20px;
    border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
    border-radius: 14px;
    background: Canvas;
    color: CanvasText;
    box-shadow: 0 16px 48px #0003;
  }
  .canvas-input-dialog::backdrop { background: #0004; }
  label { display: grid; gap: 12px; }
  input { width: 100%; box-sizing: border-box; padding: 9px; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: 6px; background: Canvas; color: CanvasText; font: inherit; }
  p { color: #cf3f46; font-size: 12px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  button { padding: 7px 14px; border: 0; border-radius: 6px; background: color-mix(in srgb, CanvasText 9%, transparent); color: inherit; font: inherit; cursor: pointer; }
  button.confirm { background: var(--accent, #4d88ff); color: white; }
</style>
