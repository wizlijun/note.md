<script lang="ts">
  import OnboardingBanner from "./components/OnboardingBanner.svelte";
  import DropZone from "./components/DropZone.svelte";
  import PendingList from "./components/PendingList.svelte";
  import SettingsDialog from "./components/SettingsDialog.svelte";
  import LibraryBrowser from "./components/LibraryBrowser.svelte";
  import { extractMeta } from "$lib/calibre";
  import { request, bridge } from "$lib/bridge";
  import { setLocale, t } from "$lib/strings";
  import { buildPendingEntry, commitEntry, CancelledError } from "$lib/import-pipeline";
  import { loadLibrary } from "$lib/library";
  import { readRules } from "$lib/rules-io";
  import type { SharedConfig, PendingEntry, Rule } from "$lib/types";

  try { setLocale(bridge().locale); } catch { /* not in a plugin window */ }

  let ready = $state(false);
  let config = $state<SharedConfig | null>(null);
  let pending = $state<PendingEntry[]>([]);
  let importing = $state(false);
  let settingsOpen = $state(false);
  let tab = $state<"import" | "library">("import");
  let cancelSignal = { cancelled: false };

  let rules = $state<Rule[]>([]);

  $effect(() => { if (ready && config?.sotvault) {
    readRules(config.sotvault).then((r) => rules = r.rules);
  }});

  async function onReady(cfg: SharedConfig) {
    config = cfg;
    ready = true;
  }

  async function onDropFiles(paths: string[]) {
    if (!config) return;
    const calibreDir = (await request<string | null>("calibre_detect", {
      userConfigured: config.calibre_path,
    })) ?? null;
    const library = await loadLibrary(config.sotvault!);
    const existingNames = new Set(pending.map((p) => p.book_name));
    for (const src of paths) {
      const id = crypto.randomUUID();
      const filename = src.split("/").pop() ?? src;
      const ext = filename.split(".").pop()?.toLowerCase() ?? "";
      const sha = await request<string>("hash_file_sha256", { path: src });
      let extracted = null;
      try {
        if (calibreDir) {
          extracted = await extractMeta(calibreDir, src, 30);
        }
      } catch (e) {
        console.warn("extractMeta failed", e);
      }
      const entry = buildPendingEntry({
        id, source_path: src, source_filename: filename, source_ext: ext,
        source_sha256: sha, extracted,
        rules, existing_library: library, existing_pending_names: existingNames,
      });
      pending = [...pending, entry];
      existingNames.add(entry.book_name);
    }
  }

  async function onImport() {
    if (!config) return;
    const calibreDir = await request<string | null>("calibre_detect", {
      userConfigured: config.calibre_path,
    });
    if (!calibreDir) return;
    importing = true;
    cancelSignal = { cancelled: false };
    const ctx = {
      sotvault: config.sotvault!, rawvault: config.rawvault!,
      calibre_binary_dir: calibreDir,
      convert_timeout_secs: 300,
    };
    const concurrency = 2;
    const queue = pending.filter((p) => p.selected);
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length && !cancelSignal.cancelled) {
        const entry = queue[cursor++];
        entry.status = "queued";
        try {
          await commitEntry(entry, ctx, cancelSignal, ({ step }) => {
            entry.status = step;
          });
          entry.status = "done";
        } catch (e) {
          if (e instanceof CancelledError) { entry.status = "cancelled"; }
          else { entry.status = "failed"; entry.error = String(e); }
        }
        pending = [...pending];
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    importing = false;
  }

  function onCancel() { cancelSignal.cancelled = true; }
  function onRemove(id: string) { pending = pending.filter((p) => p.id !== id); }
</script>

<main>
  <header class="top">
    <h1>{t("app.title")}</h1>
    {#if ready}
      <nav class="tabs">
        <button class:active={tab === "import"} onclick={() => tab = "import"}>{t("app.tab.import")}</button>
        <button class:active={tab === "library"} onclick={() => tab = "library"}>{t("app.tab.library")}</button>
      </nav>
      <button onclick={() => settingsOpen = true}>{t("app.settings")}</button>
    {/if}
  </header>
  {#if !ready}
    <OnboardingBanner {onReady} />
  {:else if tab === "import"}
    <DropZone {onDropFiles} />
    {#if pending.length > 0}
      <PendingList bind:entries={pending} {onImport} {onRemove} />
      {#if importing}
        <button onclick={onCancel}>{t("app.cancelAll")}</button>
      {/if}
    {/if}
  {:else if tab === "library" && config?.sotvault}
    <LibraryBrowser sotvault={config.sotvault} />
  {/if}
  {#if config}
    <SettingsDialog bind:config={config} bind:open={settingsOpen} />
  {/if}
</main>

<style>
  main { padding: 1.5rem; font-family: -apple-system, system-ui, sans-serif; }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .tabs { display: flex; gap: 0.25rem; }
  .tabs button { padding: 0.25rem 0.75rem; }
  .tabs button.active { font-weight: bold; border-bottom: 2px solid currentColor; }
</style>
