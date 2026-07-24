<script lang="ts">
  import { pickPaths } from "$lib/bridge";
  import RulesEditor from "./RulesEditor.svelte";
  import RebuildPanel from "./RebuildPanel.svelte";
  import { readRules, writeRules } from "$lib/rules-io";
  import { writeSharedConfig } from "$lib/shared-config";
  import { t } from "$lib/strings";
  import type { SharedConfig, Rule } from "$lib/types";

  let { config = $bindable<SharedConfig>(), open: isOpen = $bindable<boolean>() }: {
    config: SharedConfig; open: boolean;
  } = $props();

  let rules = $state<Rule[]>([]);

  $effect(() => { if (isOpen && config.sotvault) {
    readRules(config.sotvault).then((r) => rules = r.rules);
  }});

  async function pickDir(field: "sotvault" | "rawvault" | "calibre_path") {
    const [picked] = await pickPaths({ directory: true, multiple: false });
    if (typeof picked === "string") {
      config[field] = picked;
      await writeSharedConfig(config);
    }
  }
  async function saveRules() {
    if (config.sotvault) await writeRules(config.sotvault, { version: 1, rules });
  }
</script>

{#if isOpen}
<div class="overlay" onclick={() => isOpen = false} onkeydown={(e) => e.key === "Escape" && (isOpen = false)} role="presentation">
  <div class="dialog" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
    <h2>{t("settings.title")}</h2>
    <section>
      <h3>{t("settings.paths")}</h3>
      <div>{t("settings.sotvault")} {config.sotvault ?? "—"} <button onclick={() => pickDir("sotvault")}>{t("settings.choose")}</button></div>
      <div>{t("settings.rawvault")} {config.rawvault ?? "—"} <button onclick={() => pickDir("rawvault")}>{t("settings.choose")}</button></div>
      <div>{t("settings.calibre")} {config.calibre_path ?? "—"} <button onclick={() => pickDir("calibre_path")}>{t("settings.choose")}</button></div>
    </section>
    <RulesEditor bind:rules onSave={saveRules} />
    {#if config.sotvault && config.rawvault}
      <RebuildPanel sotvault={config.sotvault} rawvault={config.rawvault} {rules} />
    {/if}
    <button onclick={() => isOpen = false}>{t("settings.close")}</button>
  </div>
</div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .dialog {
    background: white; padding: 1.5rem; border-radius: 8px;
    max-width: 800px; max-height: 80vh; overflow: auto;
  }
  @media (prefers-color-scheme: dark) {
    .dialog { background: #1f1f1f; color: white; }
  }
</style>
