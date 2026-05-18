import type { BookMeta } from "./types";

export function findDuplicate(
  query: { isbn: string | null; sha256: string },
  library: BookMeta[],
): BookMeta | null {
  const qIsbn = query.isbn && query.isbn.length > 0 ? query.isbn : null;
  for (const m of library) {
    if (qIsbn && m.isbn && m.isbn === qIsbn) return m;
    if (query.sha256 && m.source_sha256 === query.sha256) return m;
  }
  return null;
}
