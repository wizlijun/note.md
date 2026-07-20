import { describe, it, expect } from "vitest";
import { parseMeta, serializeMeta, defaultMeta } from "./meta";
import type { BookMeta } from "./types";

const sample: BookMeta = {
  schema_version: 1,
  title: "Effective Modern C++",
  authors: ["Scott Meyers"],
  publisher: "O'Reilly",
  language: "en",
  isbn: "9781491903995",
  tags: ["计算机", "C++"],
  pubdate: "2014-12-05",
  description: "42 specific ways…",
  source_filename: "9781491903995.epub",
  source_format: "epub",
  source_sha256: "a1b2c3",
  raw_path: "books/2025/202501/Effective Modern C++.epub",
  import_time: "2026-05-18T10:23:45+08:00",
  calibre_version: "7.21.0",
  applied_rule: "r-tech",
};

describe("meta yaml", () => {
  it("serialize → parse round-trip preserves all fields", () => {
    const yaml = serializeMeta(sample);
    const back = parseMeta(yaml);
    expect(back).toEqual(sample);
  });

  it("parse fills defaults for missing optional fields", () => {
    const minimal = `schema_version: 1\ntitle: Foo\nsource_filename: f.epub\nsource_format: epub\nsource_sha256: x\nraw_path: y\nimport_time: 2026-05-18T00:00:00Z\n`;
    const meta = parseMeta(minimal);
    expect(meta.authors).toEqual([]);
    expect(meta.tags).toEqual([]);
    expect(meta.publisher).toBeNull();
    expect(meta.applied_rule).toBeNull();
  });

  it("parse throws on malformed YAML", () => {
    expect(() => parseMeta("title: : :")).toThrow();
  });

  it("defaultMeta produces a valid empty-ish meta", () => {
    const d = defaultMeta();
    expect(d.schema_version).toBe(1);
    expect(d.authors).toEqual([]);
  });
});
