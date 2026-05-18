import { invoke } from "@tauri-apps/api/core";
import { parseMeta, serializeMeta } from "./meta";
import { listSotvaultMeta } from "./sotvault-fs";
import { computeRebuildDiff, type DiffRow } from "./rules";
import type { Rule } from "./types";

export async function computeDiff(sotvault: string, rules: Rule[]): Promise<DiffRow[]> {
  const entries = await listSotvaultMeta(sotvault);
  return computeRebuildDiff(
    rules,
    entries.map((e) => ({ current_dir: e.rule_dir, book_name: e.book_name, meta: e.meta })),
  );
}

export async function applyRebuildDiff(sotvault: string, diff: DiffRow[]): Promise<void> {
  for (const row of diff) {
    const src = `${sotvault}/${row.from}/${row.book_name}`;
    const dst = `${sotvault}/${row.to}/${row.book_name}`;
    await invoke("fs_rename_strict", { src, dst });
    const yaml = await invoke<string>("read_text_file", { path: `${dst}/meta.yml` });
    const meta = parseMeta(yaml);
    meta.applied_rule = row.new_rule_id;
    await invoke("write_text_file", {
      path: `${dst}/meta.yml`, content: serializeMeta(meta),
    });
  }
}
