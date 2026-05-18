<script lang="ts">
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { onMount, onDestroy } from "svelte";

  let { onDropFiles }: { onDropFiles: (paths: string[]) => void } = $props();
  let hover = $state(false);
  let unlisteners: UnlistenFn[] = [];

  const SUPPORTED = new Set([
    "epub", "mobi", "azw", "azw3", "pdf", "fb2", "lit", "lrf", "rtf", "txt", "docx",
  ]);

  onMount(async () => {
    unlisteners.push(await listen<{ paths: string[] }>("tauri://drag-enter", () => { hover = true; }));
    unlisteners.push(await listen<{ paths: string[] }>("tauri://drag-leave", () => { hover = false; }));
    unlisteners.push(await listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
      hover = false;
      const paths = (e.payload?.paths ?? []).filter((p) => {
        const ext = p.split(".").pop()?.toLowerCase() ?? "";
        return SUPPORTED.has(ext);
      });
      if (paths.length > 0) onDropFiles(paths);
    }));
  });

  onDestroy(() => { unlisteners.forEach((u) => u()); });
</script>

<section class="drop" class:hover>
  <p>Drop ebook files here</p>
  <p class="sub">Supports epub, mobi, azw, azw3, pdf, fb2, lit, lrf, rtf, txt, docx</p>
</section>

<style>
  .drop {
    border: 2px dashed #888; border-radius: 12px;
    padding: 3rem; text-align: center; transition: all 150ms;
  }
  .drop.hover { border-color: #2a7; background: #2a71; }
  .sub { color: #888; font-size: 0.875rem; }
</style>
