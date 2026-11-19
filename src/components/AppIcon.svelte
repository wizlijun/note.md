<script lang="ts">
  import { appIcon, type AppGlyph, type AppTone } from '../lib/home-apps/catalog'
  let { id = '', glyph, tone }: { id?: string; glyph?: AppGlyph | 'note' | 'canvas' | 'folder'; tone?: AppTone } = $props()
  const icon = $derived(appIcon(id))
  const shape = $derived(glyph ?? icon.glyph)
</script>

<span class="app-icon" data-tone={tone ?? icon.tone} aria-hidden="true">
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    {#if shape === 'note' || shape === 'pdf'}<path d="M9 4h10l5 5v19H9z M19 4v6h5 M13 16h7 M13 21h7" />
    {:else if shape === 'canvas'}<rect x="5" y="5" width="22" height="22" rx="3"/><path d="m9 22 7-13 7 13z"/>
    {:else if shape === 'folder'}<path d="M4 9h10l3 3h11v14H4z M4 9V6h9l3 3h10v3"/>
    {:else if shape === 'location'}<path d="M25 13c0 7-9 15-9 15S7 20 7 13a9 9 0 1 1 18 0Z"/><circle cx="16" cy="13" r="3"/>
    {:else if shape === 'import'}<path d="M6 19v8h20v-8 M16 4v16 m-6-6 6 6 6-6"/>
    {:else if shape === 'health'}<path d="M16 27 5 16C-2 6 11 0 16 9 21 0 34 6 27 16z M7 17h6l3-7 3 11 3-4h4"/>
    {:else if shape === 'book' || shape === 'dictionary'}<path d="M16 8C12 5 7 5 3 6v20c5-1 9-1 13 2 4-3 8-3 13-2V6c-4-1-9-1-13 2v20 M7 11h5 M20 11h5 M7 16h5 M20 16h5"/>
    {:else if shape === 'search'}<circle cx="14" cy="13" r="9"/><path d="m21 20 7 8"/>
    {:else if shape === 'spark'}<path d="m16 3 3 9 10 4-10 3-3 10-3-10-10-3 10-4z"/>
    {:else if shape === 'brush'}<path d="m12 19 11-15 5 4-13 13 M12 19c-5-2-8 2-7 8 6 1 10-2 10-6"/>
    {:else if shape === 'tasks'}<path d="m4 9 3 3 5-6 M16 9h12 m-24 11 3 3 5-6 M16 20h12"/>
    {:else if shape === 'agent'}<rect x="5" y="8" width="22" height="18" rx="5"/><path d="M16 3v5 M10 21h12 M2 14v6 M30 14v6"/><circle cx="11" cy="14" r="1"/><circle cx="21" cy="14" r="1"/>
    {:else if shape === 'decision'}<path d="M16 28V17 M7 5v5l9 7 9-7V5 M3 9l4-4 4 4 M21 9l4-4 4 4"/>
    {:else if shape === 'review'}<path d="M7 10a11 11 0 1 1-1 13 M3 5v8h8 M16 9v8l5 3"/>
    {:else if shape === 'timeline'}<path d="M9 3v26 M14 7h13 M14 16h9 M14 25h13"/><circle cx="9" cy="7" r="2"/><circle cx="9" cy="16" r="2"/><circle cx="9" cy="25" r="2"/>
    {:else if shape === 'memory'}<path d="M16 7c-7-8-15 2-10 8-6 7 3 15 10 9 7 6 16-2 10-9 5-6-3-16-10-8v17 M7 11l5 3 M25 11l-5 3 M7 22l5-3 M25 22l-5-3"/>
    {:else if shape === 'power'}<path d="m18 3-13 16h10l-1 10 13-17H17z"/>
    {:else if shape === 'meeting'}<circle cx="11" cy="10" r="4"/><circle cx="23" cy="11" r="3"/><path d="M3 26v-4c0-8 16-8 16 0v4 M22 17c5 0 7 3 7 8"/>
    {:else if shape === 'knowledge'}<path d="M5 5h9v9H5z M19 5h8v9h-8z M5 19h9v8H5z M19 19h8v8h-8z M14 10h5 M10 14v5 M23 14v5 M14 23h5"/>
    {:else}<rect x="5" y="5" width="22" height="22" rx="5"/><path d="M11 16h10 M16 11v10"/>{/if}
  </svg>
</span>
