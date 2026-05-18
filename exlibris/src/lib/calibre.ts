import { invoke } from "@tauri-apps/api/core";

export interface ExtractedMeta {
  title: string;
  authors: string[];
  publisher: string | null;
  language: string | null;
  isbn: string | null;
  tags: string[];
  pubdate: string | null;
  description: string | null;
  calibre_version: string | null;
}

export async function extractMeta(
  binaryDir: string, file: string, timeoutSecs = 30,
): Promise<ExtractedMeta> {
  return await invoke("calibre_extract_meta", {
    binaryDir, file, timeoutSecs,
  });
}

export async function convert(
  binaryDir: string, src: string, dst: string, timeoutSecs = 300,
): Promise<void> {
  await invoke("calibre_convert", { binaryDir, src, dst, timeoutSecs });
}
