<script lang="ts">
  import { hostRequest } from "$lib/bridge";
  import { t } from "$lib/strings";
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
        message: t("meta.toastTitle"),
        detail: path,
      });
    } catch (e) {
      console.warn("toast failed", e);
    }
  }
</script>

<aside>
  <h3>{meta.title}</h3>
  <p><strong>{t("meta.authors")}</strong> {meta.authors.join(", ")}</p>
  <p><strong>{t("meta.publisher")}</strong> {meta.publisher ?? "—"}</p>
  <p><strong>{t("meta.language")}</strong> {meta.language ?? "—"}</p>
  <p><strong>{t("meta.isbn")}</strong> {meta.isbn ?? "—"}</p>
  <p><strong>{t("meta.tags")}</strong> {meta.tags.join(", ")}</p>
  <p><strong>{t("meta.source")}</strong> {meta.source_filename} ({meta.source_format})</p>
  <p><strong>{t("meta.rawPath")}</strong> <code>{meta.raw_path}</code></p>
  <p><strong>{t("meta.imported")}</strong> {meta.import_time}</p>
  {#if meta.description}
    <p><strong>{t("meta.description")}</strong></p>
    <p>{meta.description}</p>
  {/if}
  <button onclick={openInMdeditor}>{t("meta.openInMdeditor")}</button>
</aside>

<style>
  aside { padding: 1rem; border-left: 1px solid #ddd; overflow: auto; }
  aside p { margin: 0.4rem 0; }
  code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    code { background: #2a2a2a; }
  }
</style>
