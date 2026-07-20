import { request } from "./bridge";
import { listSotvaultMeta } from "./sotvault-fs";

export interface VerifyReport {
  orphan_raw: string[];                       // raw_path that no meta refers to
  missing_raw: string[];                      // raw_path from meta but not in rawvault
  duplicate_isbn: { isbn: string; books: string[] }[];
}

export async function verify(sotvault: string, rawvault: string): Promise<VerifyReport> {
  const sot = await listSotvaultMeta(sotvault);
  const raw = await request<string[]>("rawvault_list_files", { rawvault });

  const referenced = new Set(sot.map((e) => e.meta.raw_path));
  const rawSet = new Set(raw);

  const orphan_raw = raw.filter((p) => !referenced.has(p));
  const missing_raw = sot.map((e) => e.meta.raw_path).filter((p) => p && !rawSet.has(p));

  const byIsbn = new Map<string, string[]>();
  for (const e of sot) {
    const isbn = e.meta.isbn;
    if (!isbn) continue;
    const arr = byIsbn.get(isbn) ?? [];
    arr.push(e.book_name);
    byIsbn.set(isbn, arr);
  }
  const duplicate_isbn = [...byIsbn.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([isbn, books]) => ({ isbn, books }));

  return { orphan_raw, missing_raw, duplicate_isbn };
}
