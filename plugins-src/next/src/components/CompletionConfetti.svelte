<script lang="ts">
  import { onMount } from 'svelte'

  let visible = $state(false)
  const colors = ['#ffb340', '#ff657b', '#5b9bff', '#73d8a4', '#b494ff']
  const pieces = Array.from({ length: 48 }, (_, index) => ({
    x: `${(index % 2 ? 1 : -1) * (80 + (index * 73) % 520)}px`,
    y: `${-100 - (index * 47) % 360}px`,
    rotation: `${(index * 137) % 720 - 360}deg`,
    delay: `${(index % 6) * 35}ms`,
    color: colors[index % colors.length],
  }))

  onMount(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    visible = true
    const timer = setTimeout(() => visible = false, 1800)
    return () => clearTimeout(timer)
  })
</script>

{#if visible}
  <div class="confetti" aria-hidden="true" data-completion-confetti>
    {#each pieces as piece}
      <i style={`--x:${piece.x};--y:${piece.y};--rotation:${piece.rotation};animation-delay:${piece.delay};background:${piece.color}`}></i>
    {/each}
  </div>
{/if}

<style>
  .confetti { position: fixed; inset: 0; z-index: 40; pointer-events: none; overflow: hidden; }
  i { position: absolute; left: 50%; top: 65%; width: 7px; height: 11px; border-radius: 2px; opacity: 0; animation: burst 1.5s ease-out forwards; }
  @keyframes burst {
    0% { opacity: 1; transform: translate(0, 0) rotate(0); }
    55% { opacity: 1; transform: translate(var(--x), var(--y)) rotate(var(--rotation)); }
    100% { opacity: 0; transform: translate(var(--x), calc(var(--y) + 180px)) rotate(var(--rotation)); }
  }
  @media (prefers-reduced-motion: reduce) { .confetti { display: none; } }
</style>
