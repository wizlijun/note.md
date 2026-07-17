import { listSotvaultMeta } from "./sotvault-fs";
import type { BookMeta } from "./types";

export async function loadLibrary(sotvault: string): Promise<BookMeta[]> {
  const entries = await listSotvaultMeta(sotvault);
  return entries.map((e) => e.meta);
}
