import { invoke } from "@tauri-apps/api/core";
import { computeRawPath } from "./rawvault-fs";
import { serializeMeta } from "./meta";
import { convert } from "./calibre";
import { cleanBookName, resolveDuplicateName } from "./bookname";
import { applyRules } from "./rules";
import { findDuplicate } from "./dedup";
import type { ExtractedMeta } from "./calibre";
import type { BookMeta, PendingEntry, Rule } from "./types";

export interface BuildArgs {
  id: string;
  source_path: string;
  source_filename: string;
  source_ext: string;
  source_sha256: string | null;
  extracted: ExtractedMeta | null;     // null = extraction failed
  rules: Rule[];
  existing_library: BookMeta[];
  existing_pending_names: Set<string>;
}

export function buildPendingEntry(a: BuildArgs): PendingEntry {
  const stem = a.source_filename.replace(/\.[^.]+$/, "");
  let title = "";
  let attention = false;
  if (a.extracted) {
    title = cleanBookName(a.extracted.title);
    if (!title) { title = stem; attention = true; }
  } else {
    title = stem; attention = true;
  }
  const book_name = resolveDuplicateName(title, a.existing_pending_names);

  const meta: BookMeta = {
    schema_version: 1,
    title: a.extracted?.title ?? "",
    authors: a.extracted?.authors ?? [],
    publisher: a.extracted?.publisher ?? null,
    language: a.extracted?.language ?? null,
    isbn: a.extracted?.isbn ?? null,
    tags: a.extracted?.tags ?? [],
    pubdate: a.extracted?.pubdate ?? null,
    description: a.extracted?.description ?? null,
    source_filename: a.source_filename,
    source_format: a.source_ext.toLowerCase(),
    source_sha256: a.source_sha256 ?? "",
    raw_path: "",
    import_time: "",
    calibre_version: a.extracted?.calibre_version ?? null,
    applied_rule: null,
  };

  const { rule_id, target } = applyRules(a.rules, meta);

  const dup = findDuplicate({ isbn: meta.isbn, sha256: meta.source_sha256 }, a.existing_library);
  const dedup: PendingEntry["dedup"] = dup ? "exists" : "new";

  return {
    id: a.id,
    source_path: a.source_path,
    source_filename: a.source_filename,
    source_ext: a.source_ext,
    source_sha256: a.source_sha256,
    meta,
    book_name,
    target_rule_id: rule_id,
    target_dir: target,
    dedup,
    status: attention ? "needs_attention" : "ready_for_review",
    selected: dedup === "new",
  };
}

export interface CommitContext {
  sotvault: string;
  rawvault: string;
  calibre_binary_dir: string;
  convert_timeout_secs: number;
}

export interface CommitProgress {
  step: "writing_raw" | "converting" | "writing_sot" | "done";
}

export type CommitCallback = (p: CommitProgress) => void;

export class CancelledError extends Error {
  constructor() { super("cancelled"); }
}

export async function commitEntry(
  entry: PendingEntry,
  ctx: CommitContext,
  signal: { cancelled: boolean },
  onProgress?: CommitCallback,
): Promise<BookMeta> {
  if (signal.cancelled) throw new CancelledError();

  // 5. write-rawvault
  onProgress?.({ step: "writing_raw" });
  const now = new Date();
  const raw_rel = computeRawPath(entry.book_name, entry.source_ext, now);
  const raw_dst_abs = `${ctx.rawvault}/${raw_rel}`;
  const final_raw_abs = await invoke<string>("fs_atomic_copy", {
    src: entry.source_path, dst: raw_dst_abs,
  });
  const final_raw_rel = final_raw_abs.startsWith(ctx.rawvault + "/")
    ? final_raw_abs.slice(ctx.rawvault.length + 1)
    : raw_rel;

  if (signal.cancelled) throw new CancelledError();

  // 6. convert (output to a temp file under sotvault/.exlibris/.tmp/)
  onProgress?.({ step: "converting" });
  const tmp_md = `${ctx.sotvault}/.exlibris/.tmp/${entry.id}.book.md`;
  await convert(ctx.calibre_binary_dir, entry.source_path, tmp_md, ctx.convert_timeout_secs);

  if (signal.cancelled) throw new CancelledError();

  // 7. write-sotvault
  // Move tmp_md into place (rename clears the tmp; book.md cannot exist yet
  // because the parent book directory is freshly created)
  onProgress?.({ step: "writing_sot" });
  const sot_book_dir = `${ctx.sotvault}/${entry.target_dir}/${entry.book_name}`;
  await invoke("fs_rename_strict", { src: tmp_md, dst: `${sot_book_dir}/book.md` });

  const finalized_meta: BookMeta = {
    ...entry.meta!,
    schema_version: 1,
    source_filename: entry.source_filename,
    source_format: entry.source_ext.toLowerCase(),
    source_sha256: entry.source_sha256 ?? "",
    raw_path: final_raw_rel,
    import_time: now.toISOString(),
    applied_rule: entry.target_rule_id,
  };
  const yaml = serializeMeta(finalized_meta);
  await invoke<string>("write_text_file", {
    path: `${sot_book_dir}/meta.yml`, content: yaml,
  });

  onProgress?.({ step: "done" });
  return finalized_meta;
}
