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
