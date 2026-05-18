<script lang="ts">
  import OnboardingBanner from "./components/OnboardingBanner.svelte";
  import type { SharedConfig } from "$lib/types";

  let ready = $state(false);
  let config = $state<SharedConfig | null>(null);

  function onReady(cfg: SharedConfig) {
    config = cfg;
    ready = true;
  }
</script>

<main>
  <h1>ExLibris</h1>
  {#if !ready}
    <OnboardingBanner {onReady} />
  {:else}
    <p>Onboarding complete. Sotvault: {config?.sotvault}</p>
    <p>(Drop zone + library browser coming in later phases.)</p>
  {/if}
</main>

<style>
  main { padding: 2rem; font-family: -apple-system, system-ui, sans-serif; }
</style>
