<script lang="ts">
  import type { Rule } from "$lib/types";
  import { t } from "$lib/strings";

  let { rules = $bindable<Rule[]>(), onSave }: {
    rules: Rule[];
    onSave: () => void;
  } = $props();

  function addRule() {
    rules = [...rules, {
      id: `r-${Date.now()}`, name: t("rules.newRule"),
      when: {}, target: "uncategorized",
    }];
  }
  function removeRule(idx: number) {
    rules = rules.filter((_, i) => i !== idx);
  }
  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= rules.length) return;
    const copy = [...rules];
    [copy[idx], copy[j]] = [copy[j], copy[idx]];
    rules = copy;
  }
  function csvGet(rule: Rule, field: "ext" | "tag_contains" | "author_contains" | "language"): string {
    return (rule.when[field] ?? []).join(", ");
  }
  function csvSet(rule: Rule, field: "ext" | "tag_contains" | "author_contains" | "language", v: string) {
    rule.when[field] = v.split(",").map((s) => s.trim()).filter(Boolean);
  }
</script>

<header>
  <h3>{t("rules.title")}</h3>
  <button onclick={addRule}>{t("rules.add")}</button>
  <button onclick={onSave}>{t("rules.save")}</button>
</header>

{#each rules as rule, i (rule.id)}
  <fieldset>
    <legend>
      <input bind:value={rule.name} />
      <button onclick={() => move(i, -1)} aria-label={t("rules.moveUp")}>↑</button>
      <button onclick={() => move(i, 1)} aria-label={t("rules.moveDown")}>↓</button>
      <button onclick={() => removeRule(i)} aria-label={t("rules.remove")}>×</button>
    </legend>
    <label>{t("rules.ext")}
      <input value={csvGet(rule, "ext")} oninput={(e) => csvSet(rule, "ext", e.currentTarget.value)} />
    </label>
    <label>{t("rules.tagContains")}
      <input value={csvGet(rule, "tag_contains")} oninput={(e) => csvSet(rule, "tag_contains", e.currentTarget.value)} />
    </label>
    <label>{t("rules.authorContains")}
      <input value={csvGet(rule, "author_contains")} oninput={(e) => csvSet(rule, "author_contains", e.currentTarget.value)} />
    </label>
    <label>{t("rules.language")}
      <input value={csvGet(rule, "language")} oninput={(e) => csvSet(rule, "language", e.currentTarget.value)} />
    </label>
    <label>{t("rules.targetDir")}
      <input bind:value={rule.target} />
    </label>
  </fieldset>
{/each}

<p class="hint">{t("rules.defaultHint")} <code>uncategorized/</code></p>

<style>
  fieldset { border: 1px solid #ccc; margin: 0.75rem 0; padding: 0.5rem; }
  label { display: block; margin: 0.25rem 0; }
  label input { width: 60%; margin-left: 0.5rem; }
  legend { display: flex; gap: 0.25rem; align-items: center; }
  .hint { color: #888; font-size: 0.875rem; }
</style>
