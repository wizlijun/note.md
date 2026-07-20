<script lang="ts">
  import { hostRequest } from "$lib/bridge";
  import type { BookMeta } from "$lib/types";

  let { meta, sotvault, ruleDir }: {
    meta: BookMeta; sotvault: string; ruleDir: string;
  } = $props();

  // v1 shelled out via the opener plugin (`plugin:opener|open_path`). A plugin
  // window has no such bridge and exlibris does not carry an opener capability,
  // so we surface the book.md path via a host toast instead (the user can open
  // it from note.md). Deferred: a `host.open` bridge method (see ④ report).
  async function openInMdeditor() {
    const path = `${sotvault}/${ruleDir}/${meta.title}/book.md`;
    try {
      await hostRequest("host.toast", {
        level: "info",
        message: "Book note",
        detail: path,
      });
    } catch (e) {
      console.warn("toast failed", e);
    }
  }
</script>

<aside>
  <h3>{meta.title}</h3>
  <p><strong>Authors:</strong> {meta.authors.join(", ")}</p>
  <p><strong>Publisher:</strong> {meta.publisher ?? "—"}</p>
  <p><strong>Language:</strong> {meta.language ?? "—"}</p>
  <p><strong>ISBN:</strong> {meta.isbn ?? "—"}</p>
  <p><strong>Tags:</strong> {meta.tags.join(", ")}</p>
  <p><strong>Source:</strong> {meta.source_filename} ({meta.source_format})</p>
  <p><strong>Raw path:</strong> <code>{meta.raw_path}</code></p>
  <p><strong>Imported:</strong> {meta.import_time}</p>
  {#if meta.description}
    <p><strong>Description:</strong></p>
    <p>{meta.description}</p>
  {/if}
  <button onclick={openInMdeditor}>Open in mdeditor</button>
</aside>

<style>
  aside { padding: 1rem; border-left: 1px solid #ddd; overflow: auto; }
  aside p { margin: 0.4rem 0; }
  code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    code { background: #2a2a2a; }
  }
</style>
