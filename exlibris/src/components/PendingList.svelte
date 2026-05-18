<script lang="ts">
  import type { PendingEntry } from "$lib/types";
  let { entries = $bindable<PendingEntry[]>(), onImport, onRemove }: {
    entries: PendingEntry[];
    onImport: () => void;
    onRemove: (id: string) => void;
  } = $props();

  function setAll(selected: boolean) {
    for (const e of entries) {
      if (e.dedup !== "exists" || selected === false) e.selected = selected;
    }
  }

  let allSelected = $derived(entries.length > 0 && entries.every((e) => e.selected));
  let hasSelection = $derived(entries.some((e) => e.selected));
</script>

<header>
  <label>
    <input type="checkbox" checked={allSelected} onchange={(e) => setAll(e.currentTarget.checked)} />
    Select all
  </label>
  <button onclick={onImport} disabled={!hasSelection}>Import {entries.filter((e) => e.selected).length}</button>
</header>

<table>
  <thead><tr>
    <th></th><th>Status</th><th>Book Name</th><th>Target</th><th>Source</th><th></th>
  </tr></thead>
  <tbody>
    {#each entries as e (e.id)}
      <tr class:exists={e.dedup === "exists"} class:attn={e.status === "needs_attention"}>
        <td><input type="checkbox" bind:checked={e.selected} /></td>
        <td>
          {#if e.dedup === "exists"}🔁 exists
          {:else if e.status === "needs_attention"}⚠️ {e.status}
          {:else}{e.status}{/if}
        </td>
        <td><input bind:value={e.book_name} /></td>
        <td><input bind:value={e.target_dir} list="rule-targets" /></td>
        <td title={e.source_path}>{e.source_filename}</td>
        <td><button onclick={() => onRemove(e.id)}>×</button></td>
      </tr>
    {/each}
  </tbody>
</table>

<datalist id="rule-targets">
  {#each [...new Set(entries.map((e) => e.target_dir))] as t}
    <option value={t}></option>
  {/each}
</datalist>

<style>
  header { display: flex; justify-content: space-between; padding: 0.5rem 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; text-align: left; }
  tr.exists { opacity: 0.5; }
  tr.attn { background: #fff8d0; }
  input[type=text], input:not([type]) { width: 100%; }
</style>
