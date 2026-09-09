<script lang="ts">
  let { size = 11 }: { size?: number } = $props()
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="9" />
  <path d="M12 8v4l2 1" />
</svg>

<style>
  svg { display: block; }
</style>
