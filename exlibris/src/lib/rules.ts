import type { Rule, BookMeta } from "./types";

export const DEFAULT_RULE: Rule = {
  id: "__default__",
  name: "Uncategorized",
  when: {},
  target: "uncategorized",
};

function containsAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

export function evaluateRule(rule: Rule, meta: BookMeta): boolean {
  const w = rule.when ?? {};
  if (w.ext && w.ext.length > 0) {
    if (!w.ext.map((e) => e.toLowerCase()).includes(meta.source_format.toLowerCase())) return false;
  }
  if (w.tag_contains && w.tag_contains.length > 0) {
    const hay = (meta.tags ?? []).join(" ");
    if (!containsAny(hay, w.tag_contains)) return false;
  }
  if (w.author_contains && w.author_contains.length > 0) {
    const hay = (meta.authors ?? []).join(" ");
    if (!containsAny(hay, w.author_contains)) return false;
  }
  if (w.language && w.language.length > 0) {
    if (!meta.language || !w.language.includes(meta.language)) return false;
  }
  return true;
}

export function applyRules(rules: Rule[], meta: BookMeta): { rule_id: string | null; target: string } {
  for (const r of rules) {
    if (evaluateRule(r, meta)) {
      return { rule_id: r.id, target: r.target };
    }
  }
  return { rule_id: null, target: DEFAULT_RULE.target };
}

export interface DiffRow {
  book_name: string;
  from: string;
  to: string;
  new_rule_id: string | null;
}

export function computeRebuildDiff(
  rules: Rule[],
  entries: Array<{ current_dir: string; book_name: string; meta: BookMeta }>,
): DiffRow[] {
  const out: DiffRow[] = [];
  for (const e of entries) {
    const { rule_id, target } = applyRules(rules, e.meta);
    if (target !== e.current_dir) {
      out.push({ book_name: e.book_name, from: e.current_dir, to: target, new_rule_id: rule_id });
    }
  }
  return out;
}
