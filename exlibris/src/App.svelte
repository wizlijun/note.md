<script lang="ts">
  import OnboardingBanner from "./components/OnboardingBanner.svelte";
  import DropZone from "./components/DropZone.svelte";
  import PendingList from "./components/PendingList.svelte";
  import SettingsDialog from "./components/SettingsDialog.svelte";
  import { readSharedConfig } from "$lib/shared-config";
  import { extractMeta } from "$lib/calibre";
  import { invoke } from "@tauri-apps/api/core";
  import { buildPendingEntry, commitEntry, CancelledError } from "$lib/import-pipeline";
  import { loadLibrary } from "$lib/library";
  import { readRules } from "$lib/rules-io";
  import type { SharedConfig, PendingEntry, Rule } from "$lib/types";

  let ready = $state(false);
  let config = $state<SharedConfig | null>(null);
  let pending = $state<PendingEntry[]>([]);
  let importing = $state(false);
  let settingsOpen = $state(false);
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
    const calibreDir = (await invoke<string | null>("calibre_detect", {
      userConfigured: config.calibre_path,
    })) ?? null;
    const library = await loadLibrary(config.sotvault!);
    const existingNames = new Set(pending.map((p) => p.book_name));
    for (const src of paths) {
      const id = crypto.randomUUID();
      const filename = src.split("/").pop() ?? src;
      const ext = filename.split(".").pop()?.toLowerCase() ?? "";
      const sha = await invoke<string>("hash_file_sha256", { path: src });
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
    const calibreDir = await invoke<string | null>("calibre_detect", {
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
    <h1>ExLibris</h1>
    {#if ready}
      <button onclick={() => settingsOpen = true}>⚙ Settings</button>
    {/if}
  </header>
  {#if !ready}
    <OnboardingBanner {onReady} />
  {:else}
    <DropZone {onDropFiles} />
    {#if pending.length > 0}
      <PendingList bind:entries={pending} {onImport} {onRemove} />
      {#if importing}
        <button onclick={onCancel}>Cancel All</button>
      {/if}
    {/if}
  {/if}
  {#if config}
    <SettingsDialog bind:config={config} bind:open={settingsOpen} />
  {/if}
</main>

<style>
  main { padding: 1.5rem; font-family: -apple-system, system-ui, sans-serif; }
  .top { display: flex; justify-content: space-between; align-items: center; }
</style>
