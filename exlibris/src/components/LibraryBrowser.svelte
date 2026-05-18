<script lang="ts">
  import { listSotvaultMeta, type SotvaultEntry } from "$lib/sotvault-fs";
  import MetaPreview from "./MetaPreview.svelte";

  let { sotvault }: { sotvault: string } = $props();

  let entries = $state<SotvaultEntry[]>([]);
  let query = $state("");
  let selectedRule = $state<string | null>(null);
  let selected = $state<SotvaultEntry | null>(null);

  $effect(() => { (async () => {
    entries = await listSotvaultMeta(sotvault);
  })(); });

  let ruleDirs = $derived([...new Set(entries.map((e) => e.rule_dir))].sort());

  let filtered = $derived(entries.filter((e) => {
    if (selectedRule && e.rule_dir !== selectedRule) return false;
    if (query) {
      const q = query.toLowerCase();
      return e.meta.title.toLowerCase().includes(q)
        || e.meta.authors.join(" ").toLowerCase().includes(q)
        || e.meta.tags.join(" ").toLowerCase().includes(q);
    }
    return true;
  }));

  async function refresh() {
    entries = await listSotvaultMeta(sotvault);
  }
</script>

<section class="browser">
  <nav>
    <h4>Library</h4>
    <button onclick={refresh}>↻</button>
    <input bind:value={query} placeholder="Search…" />
    <ul>
      <li class:active={selectedRule === null}>
        <button onclick={() => selectedRule = null}>All ({entries.length})</button>
      </li>
      {#each ruleDirs as d}
        {@const count = entries.filter((e) => e.rule_dir === d).length}
        <li class:active={selectedRule === d}>
          <button onclick={() => selectedRule = d}>{d} ({count})</button>
        </li>
      {/each}
    </ul>
  </nav>
  <main class="list">
    <table>
      <thead><tr><th>Title</th><th>Authors</th><th>Rule</th></tr></thead>
      <tbody>
        {#each filtered as e}
          <tr class:active={selected === e} onclick={() => selected = e}>
            <td>{e.meta.title}</td>
            <td>{e.meta.authors.join(", ")}</td>
            <td>{e.rule_dir}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </main>
  {#if selected}
    <MetaPreview meta={selected.meta} {sotvault} ruleDir={selected.rule_dir} />
  {/if}
</section>

<style>
  .browser { display: grid; grid-template-columns: 200px 1fr 300px; gap: 1rem; height: 60vh; }
  nav { border-right: 1px solid #ddd; padding-right: 0.5rem; }
  nav ul { list-style: none; padding: 0; }
  nav li.active button { font-weight: bold; }
  nav button { background: none; border: none; cursor: pointer; padding: 0.25rem 0; text-align: left; width: 100%; }
  .list { overflow: auto; }
  table { width: 100%; border-collapse: collapse; cursor: pointer; }
  th, td { padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; text-align: left; }
  tr.active { background: #def; }
  @media (prefers-color-scheme: dark) {
    tr.active { background: #224; }
    th, td { border-bottom-color: #333; }
    nav { border-right-color: #333; }
  }
</style>
