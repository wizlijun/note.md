import YAML from "yaml";
import type { BookMeta } from "./types";

export function defaultMeta(): BookMeta {
  return {
    schema_version: 1,
    title: "",
    authors: [],
    publisher: null,
    language: null,
    isbn: null,
    tags: [],
    pubdate: null,
    description: null,
    source_filename: "",
    source_format: "",
    source_sha256: "",
    raw_path: "",
    import_time: "",
    calibre_version: null,
    applied_rule: null,
  };
}

export function serializeMeta(m: BookMeta): string {
  return YAML.stringify(m, { lineWidth: 0 });
}

export function parseMeta(yaml: string): BookMeta {
  const raw = YAML.parse(yaml);
  if (!raw || typeof raw !== "object") {
    throw new Error("meta.yml is not an object");
  }
  return { ...defaultMeta(), ...raw };
}
