<script lang="ts">
  import { computeDiff, applyRebuildDiff } from "$lib/rebuild";
  import { verify, type VerifyReport } from "$lib/verify";
  import type { Rule } from "$lib/types";
  import type { DiffRow } from "$lib/rules";
  import { t } from "$lib/strings";

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
      alert(t("rebuild.complete"));
    } finally { busy = false; }
  }
  async function runVerify() {
    busy = true;
    try { report = await verify(sotvault, rawvault); }
    finally { busy = false; }
  }
</script>

<section>
  <h3>{t("rebuild.title")}</h3>
  <button onclick={loadDiff} disabled={busy}>{t("rebuild.computeDiff")}</button>
  {#if diff.length > 0}
    <p>{t("rebuild.willMove", { count: diff.length })}</p>
    <ul>
      {#each diff as d}
        <li>{d.book_name}: {d.from} → {d.to}</li>
      {/each}
    </ul>
    <button onclick={apply} disabled={busy}>{t("rebuild.apply")}</button>
  {:else}
    <p>{t("rebuild.noChanges")}</p>
  {/if}
</section>

<section>
  <h3>{t("rebuild.verify")}</h3>
  <button onclick={runVerify} disabled={busy}>{t("rebuild.runVerify")}</button>
  {#if report}
    <p>{t("rebuild.orphanRaw", { count: report.orphan_raw.length })}</p>
    <p>{t("rebuild.missingRaw", { count: report.missing_raw.length })}</p>
    <p>{t("rebuild.duplicateIsbn", { count: report.duplicate_isbn.length })}</p>
    <details><summary>{t("rebuild.details")}</summary>
      <pre>{JSON.stringify(report, null, 2)}</pre>
    </details>
  {/if}
</section>

<style>
  section { margin: 1rem 0; }
  button { margin-right: 0.5rem; }
  pre { background: #f4f4f4; padding: 0.5rem; max-height: 300px; overflow: auto; font-size: 12px; }
</style>
