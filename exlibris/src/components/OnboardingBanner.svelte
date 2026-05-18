<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { invoke } from "@tauri-apps/api/core";
  import { readSharedConfig, writeSharedConfig } from "$lib/shared-config";
  import type { SharedConfig } from "$lib/types";

  let { onReady }: { onReady: (cfg: SharedConfig) => void } = $props();

  let cfg = $state<SharedConfig>({
    version: 1,
    sotvault: null,
    rawvault: null,
    calibre_path: null,
    exlibris: null,
  });
  let calibreDetected = $state<string | null>(null);

  $effect(() => {
    (async () => {
      cfg = await readSharedConfig();
      calibreDetected = await invoke<string | null>("calibre_detect", {
        userConfigured: cfg.calibre_path,
      });
    })();
  });

  async function pickDir(
    field: "sotvault" | "rawvault" | "calibre_path"
  ) {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      cfg[field] = picked;
      await writeSharedConfig(cfg);
      if (field === "calibre_path") {
        calibreDetected = await invoke<string | null>("calibre_detect", {
          userConfigured: cfg.calibre_path,
        });
      }
    }
  }

  let ready = $derived(
    !!cfg.sotvault && !!cfg.rawvault && !!calibreDetected
  );
</script>

<section class="onboarding">
  <h2>Get Started</h2>
  <ol>
    <li class:done={!!cfg.sotvault}>
      <span>Sotvault: {cfg.sotvault ?? "Not configured"}</span>
      <button onclick={() => pickDir("sotvault")}>Choose…</button>
    </li>
    <li class:done={!!cfg.rawvault}>
      <span>Rawvault: {cfg.rawvault ?? "Not configured"}</span>
      <button onclick={() => pickDir("rawvault")}>Choose…</button>
    </li>
    <li class:done={!!calibreDetected}>
      <span>calibre: {calibreDetected ?? "Not detected"}</span>
      <button onclick={() => pickDir("calibre_path")}>Choose…</button>
      {#if !calibreDetected}
        <a href="https://calibre-ebook.com" target="_blank">Install calibre</a>
      {/if}
    </li>
  </ol>
  <button disabled={!ready} onclick={() => onReady(cfg)}>Get Started</button>
</section>

<style>
  .onboarding {
    padding: 1.5rem;
    border: 1px solid #ccc;
    border-radius: 8px;
    max-width: 600px;
  }
  ol {
    list-style: none;
    padding: 0;
  }
  li {
    padding: 0.5rem 0;
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  li.done span::before {
    content: "✓ ";
    color: green;
  }
</style>
