<script lang="ts">
  import { version } from '../../package.json'
  import { pickOpenFile, showError } from '../lib/dialogs'
  import { openFile, newCanvas, newFile } from '../lib/tabs.svelte'
  import { t } from '../lib/i18n/store.svelte'

  const majorVersion = version.split('.')[0]

  async function onOpen() {
    const p = await pickOpenFile()
    if (p) {
      try { await openFile(p) } catch (e) { console.warn(e); showError(String(e)) }
    }
  }

  function onNew() {
    newFile()
  }

  function onDblClick() {
    newFile()
  }

  async function onNewCanvas() {
    try { await newCanvas() } catch (e) { console.warn(e); showError(String(e)) }
  }
</script>

<div class="empty" ondblclick={onDblClick}>
  <div class="welcome">
    <div class="artwork">
      <div class="identity">
        <span class="wordmark">note.md</span>
        <span class="version">v{version}</span>
      </div>
      <span class="major-version" aria-hidden="true">{majorVersion}</span>
    </div>
    <p class="hint">{t('emptyState.hint')}</p>
    <div class="actions">
      <button onclick={onNew}>{t('emptyState.new')}</button>
      <button onclick={onNewCanvas}>{t('canvas.new')}</button>
      <button onclick={onOpen}>{t('emptyState.open')}</button>
    </div>
  </div>
</div>

<style>
  .empty {
    flex: 1;
    display: flex;
    min-width: 0;
    min-height: 0;
    padding: 32px 24px;
    box-sizing: border-box;
    overflow: auto;
    container-type: size;
    color: GrayText;
  }
  .welcome {
    width: 520px;
    max-width: 100%;
    margin: auto;
  }
  .artwork {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 28px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    user-select: none;
  }
  .identity { display: flex; flex-direction: column; gap: 12px; }
  .wordmark {
    font-size: 28px;
    font-size: clamp(28px, 7cqi, 48px);
    font-weight: 650;
    letter-spacing: -0.06em;
    line-height: 1;
    color: color-mix(in srgb, CanvasText 42%, Canvas);
  }
  .version {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    letter-spacing: 0.12em;
  }
  .major-version {
    font-size: 120px;
    font-size: clamp(120px, 45cqi, 300px);
    font-weight: 800;
    letter-spacing: -0.08em;
    line-height: 0.72;
    color: color-mix(in srgb, CanvasText 13%, Canvas);
  }
  .hint { margin: 24px 0 12px; font-size: 13px; }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  button {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    cursor: pointer;
    font-size: 13px;
  }
  button:hover { background: color-mix(in srgb, CanvasText 8%, Canvas); }
  @container (max-height: 300px) {
    .major-version { font-size: 80px; }
    .wordmark { font-size: 28px; }
    .artwork { padding-bottom: 16px; }
    .hint { margin-top: 16px; }
  }
</style>
