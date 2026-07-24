<script lang="ts">
  import { request, pickPaths } from "$lib/bridge";
  import { readSharedConfig, writeSharedConfig } from "$lib/shared-config";
  import { t } from "$lib/strings";
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
      calibreDetected = await request<string | null>("calibre_detect", {
        userConfigured: cfg.calibre_path,
      });
    })();
  });

  async function pickDir(
    field: "sotvault" | "rawvault" | "calibre_path"
  ) {
    const [picked] = await pickPaths({ directory: true, multiple: false });
    if (typeof picked === "string") {
      cfg[field] = picked;
      await writeSharedConfig(cfg);
      if (field === "calibre_path") {
        calibreDetected = await request<string | null>("calibre_detect", {
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
  <h2>{t("onboard.getStarted")}</h2>
  <ol>
    <li class:done={!!cfg.sotvault}>
      <span>{t("onboard.sotvault")} {cfg.sotvault ?? t("onboard.notConfigured")}</span>
      <button onclick={() => pickDir("sotvault")}>{t("onboard.choose")}</button>
    </li>
    <li class:done={!!cfg.rawvault}>
      <span>{t("onboard.rawvault")} {cfg.rawvault ?? t("onboard.notConfigured")}</span>
      <button onclick={() => pickDir("rawvault")}>{t("onboard.choose")}</button>
    </li>
    <li class:done={!!calibreDetected}>
      <span>{t("onboard.calibre")} {calibreDetected ?? t("onboard.notDetected")}</span>
      <button onclick={() => pickDir("calibre_path")}>{t("onboard.choose")}</button>
      {#if !calibreDetected}
        <a href="https://calibre-ebook.com" target="_blank">{t("onboard.installCalibre")}</a>
      {/if}
    </li>
  </ol>
  <button disabled={!ready} onclick={() => onReady(cfg)}>{t("onboard.getStarted")}</button>
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
