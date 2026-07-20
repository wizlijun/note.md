import { request } from "./bridge";
import { parseMeta } from "./meta";
import type { BookMeta } from "./types";

export interface SotvaultEntry {
  rule_dir: string;
  book_name: string;
  meta: BookMeta;
}

interface RawEntry {
  rule_dir: string;
  book_name: string;
  meta_yaml: string;
}

export async function listSotvaultMeta(sotvault: string): Promise<SotvaultEntry[]> {
  const raw = await request<RawEntry[]>("sotvault_list_meta", { sotvault });
  return raw.map((r) => ({
    rule_dir: r.rule_dir,
    book_name: r.book_name,
    meta: parseMeta(r.meta_yaml),
  }));
}
