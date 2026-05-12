<script lang="ts">
  import { findState, closeFind } from '../lib/find-replace.svelte'

  let searchInput: HTMLInputElement | undefined = $state()

  $effect(() => {
    if (findState.open && searchInput) {
      searchInput.focus()
      searchInput.select()
    }
  })

  $effect(() => {
    const q = findState.query
    const cs = findState.caseSensitive
    const ww = findState.wholeWord
    const re = findState.useRegex
    window.dispatchEvent(new CustomEvent('mdeditor:find-search', {
      detail: { query: q, caseSensitive: cs, wholeWord: ww, useRegex: re },
    }))
  })

  function next() {
    window.dispatchEvent(new CustomEvent('mdeditor:find-next'))
  }

  function prev() {
    window.dispatchEvent(new CustomEvent('mdeditor:find-prev'))
  }

  function replaceCurrent() {
    window.dispatchEvent(new CustomEvent('mdeditor:find-replace', {
      detail: { replacement: findState.replacement },
    }))
  }

  function replaceAll() {
    window.dispatchEvent(new CustomEvent('mdeditor:find-replace-all', {
      detail: { replacement: findState.replacement },
    }))
  }

  let replaceInput: HTMLInputElement | undefined = $state()

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeFind()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (document.activeElement === replaceInput) {
        replaceCurrent()
      } else {
        next()
      }
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      prev()
    }
  }

  function toggleReplace() {
    findState.showReplace = !findState.showReplace
  }
</script>

{#if findState.open}
  <div class="find-bar" role="search" onkeydown={onKeyDown}>
    <div class="find-row">
      <div class="input-wrap">
        <input
          bind:this={searchInput}
          class="find-input"
          type="text"
          placeholder="查找"
          bind:value={findState.query}
        />
        <button
          class="opt-btn"
          class:active={findState.caseSensitive}
          onclick={() => findState.caseSensitive = !findState.caseSensitive}
          title="区分大小写"
          aria-label="Case sensitive"
        >Aa</button>
        <button
          class="opt-btn"
          class:active={findState.wholeWord}
          onclick={() => findState.wholeWord = !findState.wholeWord}
          title="全字匹配"
          aria-label="Whole word"
        >wd</button>
        <button
          class="opt-btn"
          class:active={findState.useRegex}
          onclick={() => findState.useRegex = !findState.useRegex}
          title="正则表达式"
          aria-label="Regex"
        >.*</button>
      </div>
      <span class="sep"></span>
      <button class="nav-btn" onclick={prev} title="上一个" aria-label="Previous match">‹</button>
      <button class="nav-btn" onclick={next} title="下一个" aria-label="Next match">›</button>
      <span class="match-count">{findState.currentMatch}/{findState.matchCount}</span>
      <button class="close-btn" onclick={closeFind} aria-label="Close">×</button>
    </div>
    {#if findState.showReplace}
      <div class="replace-row">
        <div class="input-wrap">
          <input
            bind:this={replaceInput}
            class="find-input"
            type="text"
            placeholder="替换为…"
            bind:value={findState.replacement}
          />
        </div>
        <span class="sep"></span>
        <button class="action-btn" onclick={replaceCurrent} title="替换">R↵</button>
        <button class="action-btn" onclick={replaceAll} title="全部替换">R*</button>
      </div>
    {:else}
      <button class="toggle-replace" onclick={toggleReplace}>替换 ▾</button>
    {/if}
  </div>
{/if}

<style>
  .find-bar {
    flex-shrink: 0;
    background: color-mix(in srgb, Canvas 82%, CanvasText 18%);
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    padding: 6px 12px;
    font-size: 13px;
    z-index: 100;
  }
  .find-row, .replace-row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
  }
  .replace-row {
    margin-top: 4px;
  }
  .input-wrap {
    display: flex;
    align-items: center;
    flex: 1;
    max-width: 480px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, Canvas 95%, CanvasText 5%);
    overflow: hidden;
  }
  .input-wrap:focus-within {
    border-color: AccentColor;
  }
  .find-input {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    border: none;
    background: transparent;
    color: CanvasText;
    font-size: 13px;
    outline: none;
  }
  .opt-btn {
    padding: 2px 5px;
    margin-right: 2px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: CanvasText;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    opacity: 0.5;
    flex-shrink: 0;
  }
  .opt-btn.active {
    opacity: 1;
    background: color-mix(in srgb, AccentColor 20%, transparent);
    border-color: AccentColor;
  }
  .opt-btn:hover { opacity: 1; }
  .sep {
    width: 1px;
    height: 16px;
    background: color-mix(in srgb, CanvasText 20%, transparent);
    flex-shrink: 0;
  }
  .nav-btn {
    background: transparent;
    border: none;
    color: CanvasText;
    cursor: pointer;
    font-size: 16px;
    padding: 2px 4px;
    opacity: 0.7;
    line-height: 1;
  }
  .nav-btn:hover { opacity: 1; }
  .match-count {
    font-size: 12px;
    opacity: 0.6;
    min-width: 36px;
    text-align: center;
    flex-shrink: 0;
  }
  .close-btn {
    background: transparent;
    border: none;
    color: CanvasText;
    cursor: pointer;
    font-size: 16px;
    padding: 2px 6px;
    opacity: 0.7;
    margin-left: auto;
  }
  .close-btn:hover { opacity: 1; }
  .action-btn {
    padding: 3px 8px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: CanvasText;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    opacity: 0.7;
  }
  .action-btn:hover {
    opacity: 1;
    background: color-mix(in srgb, CanvasText 10%, transparent);
  }
  .toggle-replace {
    background: transparent;
    border: none;
    color: CanvasText;
    font-size: 11px;
    opacity: 0.45;
    cursor: pointer;
    padding: 2px 0;
    margin-top: 3px;
  }
  .toggle-replace:hover { opacity: 0.8; }
</style>
