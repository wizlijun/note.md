<!-- src/components/daily/DailyFeed.svelte — the scrolling, lazily-extending feed of
     DailyDay blocks. Owns the visible date window (`dates`, descending: today at
     the top, older below) and enforces the single-active invariant: this window
     is a SEPARATE webview whose outline global store holds ONE document, so at
     most one DailyDay may be `active` at a time (a single `activeDate`). Two
     active days would corrupt the shared singleton.

     Persistence is NOT this component's concern — DailyDay owns flushing its own
     edits to disk when its `active` prop flips to false (intent-save + wipe-guard
     live there). The feed only decides which single day is active.

     Lazy loading: one IntersectionObserver watches a top sentinel (prepend newer
     dates, then compensate scrollTop so the viewport doesn't jump) and a bottom
     sentinel (append older dates). An `isExtending` flag debounces so a single
     intersection doesn't fire repeatedly mid-append.

     Filtering: `setFilter(query)` pushes the query down to each DailyDay via an
     optional `filterQuery` prop; DailyDay self-hides when its own tree doesn't
     match (it owns the tree, so this is the smallest correct change — the feed
     can't read a day's node texts without re-reading disk or reaching internals). -->
<script lang="ts">
  import { onMount, tick, untrack, createEventDispatcher } from 'svelte'
  import DailyDay from './DailyDay.svelte'
  import { dateRange, extendEarlier, extendLater } from '../../lib/daily/dates'
  import { todayStr } from '../../lib/outline/daily'
  import { refreshSotvault } from '../../lib/sotvault.svelte'

  const dispatch = createEventDispatcher<{ linkclick: { raw: string } }>()

  let dates = $state<string[]>(dateRange(todayStr(), 7))
  let activeDate = $state<string | null>(null)
  let filterQuery = $state('')

  let container = $state<HTMLElement | null>(null)
  let topSentinel = $state<HTMLElement | null>(null)
  let bottomSentinel = $state<HTMLElement | null>(null)

  /** Debounce guard: true while a date-window extension is in flight so a single
   *  sustained intersection doesn't fire repeatedly before the DOM settles. */
  let isExtending = false

  /** Live refs to each mounted DailyDay, keyed by date, so refresh() can call
   *  reload() on every day. Populated via a function `bind:this` (get/set pair)
   *  on each keyed block, which also cleans up (sets null) when the block leaves
   *  the #each and the component unmounts. */
  const dayRefs = new Map<string, DailyDay>()

  const PAGE = 7

  /** Append older dates (bottom sentinel entered view). */
  function extendOlder(): void {
    dates = [...dates, ...extendEarlier(dates, PAGE)]
  }

  /** Prepend newer dates (top sentinel entered view), compensating scrollTop so
   *  the viewport stays anchored on the day the user was looking at. */
  async function extendNewer(): Promise<void> {
    const el = container
    const prevScrollHeight = el ? el.scrollHeight : 0
    dates = [...extendLater(dates, PAGE), ...dates]
    await tick()
    if (el) el.scrollTop += el.scrollHeight - prevScrollHeight
  }

  onMount(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        // untrack: this callback both reads `dates`/`container` and writes
        // `dates`; wrap so the reads don't wire this into any effect graph.
        untrack(() => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            if (isExtending) continue
            isExtending = true
            const run = entry.target === topSentinel ? extendNewer() : Promise.resolve(extendOlder())
            void Promise.resolve(run).finally(() => {
              // release the guard only after the DOM has settled, so the same
              // sentinel isn't immediately re-triggered by the reflow.
              void tick().then(() => { isExtending = false })
            })
          }
        })
      },
      { root: container, rootMargin: '200px' },
    )
    if (topSentinel) obs.observe(topSentinel)
    if (bottomSentinel) obs.observe(bottomSentinel)
    return () => obs.disconnect()
  })

  function onRequestActivate(e: CustomEvent<{ date: string }>): void {
    // Single-active invariant: setting one activeDate flips the previously-active
    // DailyDay's `active` prop to false, and that day flushes itself on the flip.
    activeDate = e.detail.date
  }

  function onLinkclick(e: CustomEvent<{ raw: string }>): void {
    dispatch('linkclick', e.detail)
  }

  // ── Exposed API (consumed by the toolbar/routing task) ──────────────────────

  /** Scroll a date into view, rebuilding the window around it if it's not loaded.
   *  Does NOT activate the day — jumping only scrolls. */
  export async function jumpTo(date: string): Promise<void> {
    if (!dates.includes(date)) {
      // Anchor a fresh window a little ABOVE the target (newer dates on top) so
      // the target sits near, not at, the very top and has context above it.
      dates = [...extendLater(dateRange(date, 14), 3).slice(0, 3), ...dateRange(date, 14)]
    }
    await tick()
    const el = container?.querySelector<HTMLElement>(`[data-date="${date}"]`)
    el?.scrollIntoView({ block: 'start' })
  }

  /** Refresh from disk: re-read the vault, then reload every mounted day. */
  export async function refresh(): Promise<void> {
    await refreshSotvault()
    await Promise.all([...dayRefs.values()].map((d) => d?.reload?.().catch(() => {})))
  }

  /** Set the active filter query; empty string clears it. Days self-hide when
   *  their tree doesn't match `filterQuery`. */
  export function setFilter(query: string): void {
    filterQuery = query
  }
</script>

<div class="feed" bind:this={container}>
  <div class="sentinel top" bind:this={topSentinel}></div>
  {#each dates as d (d)}
    <div class="day-wrap" data-date={d}>
      <DailyDay
        bind:this={
          () => dayRefs.get(d) ?? null,
          (v: DailyDay | null) => { if (v) dayRefs.set(d, v); else dayRefs.delete(d) }
        }
        date={d}
        active={d === activeDate}
        {filterQuery}
        on:requestActivate={onRequestActivate}
        on:linkclick={onLinkclick}
      />
    </div>
  {/each}
  <div class="sentinel bottom" bind:this={bottomSentinel}></div>
</div>

<style>
  .feed {
    height: 100%;
    overflow-y: auto;
    background: Canvas;
    color: CanvasText;
  }
  .sentinel { height: 1px; }
  /* Real block (not display:contents) so jumpTo()'s scrollIntoView has a box to
     target reliably across engines. */
  .day-wrap { display: block; }
</style>
