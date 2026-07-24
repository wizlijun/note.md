<script lang="ts">
  import { pickPaths } from "$lib/bridge";
  import { t } from "$lib/strings";

  let { onDropFiles }: { onDropFiles: (paths: string[]) => void } = $props();

  // v1 used `listen('tauri://drag-drop')`, but plugin windows have ZERO Tauri
  // IPC so `listen()` is unavailable. The PRIMARY import path is now the native
  // file picker via the host bridge (`host.dialog.open`, multiple files, ebook
  // extensions). Host-side drag-drop forwarding to plugin windows is deferred.
  const SUPPORTED = [
    "epub", "mobi", "azw", "azw3", "pdf", "fb2", "lit", "lrf", "rtf", "txt", "docx",
  ];
  const SUPPORTED_SET = new Set(SUPPORTED);

  async function addBooks() {
    const paths = await pickPaths({
      title: t("drop.pickTitle"),
      multiple: true,
      filters: [{ name: t("drop.filterEbooks"), extensions: SUPPORTED }],
    });
    const accepted = paths.filter((p) => {
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      return SUPPORTED_SET.has(ext);
    });
    if (accepted.length > 0) onDropFiles(accepted);
  }
</script>

<section class="drop">
  <p>{t("drop.prompt")}</p>
  <p class="sub">{t("drop.supports", { formats: SUPPORTED.join(", ") })}</p>
  <button class="add" onclick={addBooks}>{t("drop.addBooks")}</button>
</section>

<style>
  .drop {
    border: 2px dashed #888; border-radius: 12px;
    padding: 3rem; text-align: center;
  }
  .sub { color: #888; font-size: 0.875rem; }
  .add { margin-top: 1rem; padding: 0.5rem 1.25rem; font-size: 1rem; cursor: pointer; }
</style>
