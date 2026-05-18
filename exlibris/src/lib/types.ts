export interface SharedConfig {
  version: number;
  sotvault: string | null;
  rawvault: string | null;
  calibre_path: string | null;
  exlibris: ExlibrisPrefs | null;
}

export interface ExlibrisPrefs {
  import_concurrency?: number;
  convert_timeout_seconds?: number;
  last_used_rule_dirs?: string[];
}

export type PendingStatus =
  | "extracting"
  | "ready_for_review"
  | "needs_attention"
  | "queued"
  | "writing_raw"
  | "converting"
  | "writing_sot"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

export interface PendingEntry {
  id: string;
  source_path: string;
  source_filename: string;
  source_ext: string;
  source_sha256: string | null;
  meta: BookMeta | null;
  book_name: string;
  target_rule_id: string | null;
  target_dir: string;
  dedup: "new" | "exists" | "unknown";
  status: PendingStatus;
  error?: string;
  error_detail?: string;
  selected: boolean;
}

export interface BookMeta {
  schema_version: 1;
  title: string;
  authors: string[];
  publisher: string | null;
  language: string | null;
  isbn: string | null;
  tags: string[];
  pubdate: string | null;
  description: string | null;
  source_filename: string;
  source_format: string;
  source_sha256: string;
  raw_path: string;
  import_time: string;
  calibre_version: string | null;
  applied_rule: string | null;
}

export interface Rule {
  id: string;
  name: string;
  when: {
    ext?: string[];
    tag_contains?: string[];
    author_contains?: string[];
    language?: string[];
  };
  target: string;
}

export interface RulesFile {
  version: 1;
  rules: Rule[];
}
