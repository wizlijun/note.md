<script lang="ts">
  import { computeDiff, applyRebuildDiff } from "$lib/rebuild";
  import { verify, type VerifyReport } from "$lib/verify";
  import type { Rule } from "$lib/types";
  import type { DiffRow } from "$lib/rules";

  let { sotvault, rawvault, rules }: {
    sotvault: string; rawvault: string; rules: Rule[];
  } = $props();

  let diff = $state<DiffRow[]>([]);
  let report = $state<VerifyReport | null>(null);
  let busy = $state(false);

  async function loadDiff() {
    busy = true;
    try { diff = await computeDiff(sotvault, rules); }
    finally { busy = false; }
  }
  async function apply() {
    busy = true;
    try {
      await applyRebuildDiff(sotvault, diff);
      diff = [];
      alert("Rebuild complete.");
    } finally { busy = false; }
  }
  async function runVerify() {
    busy = true;
    try { report = await verify(sotvault, rawvault); }
    finally { busy = false; }
  }
</script>

<section>
  <h3>Rebuild Sotvault</h3>
  <button onclick={loadDiff} disabled={busy}>Compute Diff</button>
  {#if diff.length > 0}
    <p>{diff.length} books will move:</p>
    <ul>
      {#each diff as d}
        <li>{d.book_name}: {d.from} → {d.to}</li>
      {/each}
    </ul>
    <button onclick={apply} disabled={busy}>Apply</button>
  {:else}
    <p>No changes.</p>
  {/if}
</section>

<section>
  <h3>Verify</h3>
  <button onclick={runVerify} disabled={busy}>Run Verify</button>
  {#if report}
    <p>Orphan raw: {report.orphan_raw.length}</p>
    <p>Missing raw: {report.missing_raw.length}</p>
    <p>Duplicate ISBN: {report.duplicate_isbn.length}</p>
    <details><summary>Details</summary>
      <pre>{JSON.stringify(report, null, 2)}</pre>
    </details>
  {/if}
</section>

<style>
  section { margin: 1rem 0; }
  button { margin-right: 0.5rem; }
  pre { background: #f4f4f4; padding: 0.5rem; max-height: 300px; overflow: auto; font-size: 12px; }
</style>
