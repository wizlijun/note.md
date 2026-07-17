import { describe, it, expect } from "vitest";
import { buildPendingEntry } from "./import-pipeline";
import type { ExtractedMeta } from "./calibre";
import type { BookMeta, Rule } from "./types";

const techRule: Rule = {
  id: "r-tech", name: "Tech", when: { tag_contains: ["programming"] }, target: "tech",
};

function extractedOk(title = "Hello"): ExtractedMeta {
  return {
    title, authors: ["A"], publisher: null, language: "en",
    isbn: "111", tags: ["programming"], pubdate: null, description: null,
    calibre_version: "7.0",
  };
}

describe("buildPendingEntry", () => {
  it("happy path: clean title, applies rule, dedup new", () => {
    const entry = buildPendingEntry({
      id: "x1",
      source_path: "/u/dropped.epub",
      source_filename: "dropped.epub",
      source_ext: "epub",
      source_sha256: "sha-x",
      extracted: extractedOk(),
      rules: [techRule],
      existing_library: [],
      existing_pending_names: new Set(),
    });
    expect(entry.book_name).toBe("Hello");
    expect(entry.target_dir).toBe("tech");
    expect(entry.target_rule_id).toBe("r-tech");
    expect(entry.dedup).toBe("new");
    expect(entry.status).toBe("ready_for_review");
    expect(entry.selected).toBe(true);
  });

  it("falls back to stem when calibre returns no title", () => {
    const entry = buildPendingEntry({
      id: "x", source_path: "/u/foo.epub", source_filename: "foo.epub",
      source_ext: "epub", source_sha256: "s", extracted: { ...extractedOk(), title: "" },
      rules: [], existing_library: [], existing_pending_names: new Set(),
    });
    expect(entry.book_name).toBe("foo");
    expect(entry.status).toBe("needs_attention");
  });

  it("dedup hit by ISBN sets exists + not selected", () => {
    const lib: BookMeta[] = [{
      schema_version: 1, title: "Old", authors: [], publisher: null, language: null,
      isbn: "111", tags: [], pubdate: null, description: null,
      source_filename: "", source_format: "epub", source_sha256: "other",
      raw_path: "", import_time: "", calibre_version: null, applied_rule: null,
    }];
    const entry = buildPendingEntry({
      id: "x", source_path: "/u/foo.epub", source_filename: "foo.epub",
      source_ext: "epub", source_sha256: "s",
      extracted: extractedOk(), rules: [], existing_library: lib,
      existing_pending_names: new Set(),
    });
    expect(entry.dedup).toBe("exists");
    expect(entry.selected).toBe(false);
  });

  it("appends (2) suffix when book_name collides with pending", () => {
    const entry = buildPendingEntry({
      id: "x", source_path: "/u/a.epub", source_filename: "a.epub",
      source_ext: "epub", source_sha256: "s",
      extracted: extractedOk("Hello"), rules: [], existing_library: [],
      existing_pending_names: new Set(["Hello"]),
    });
    expect(entry.book_name).toBe("Hello (2)");
  });

  it("falls back to uncategorized when no rule matches", () => {
    const entry = buildPendingEntry({
      id: "x", source_path: "/u/a.mobi", source_filename: "a.mobi",
      source_ext: "mobi", source_sha256: "s",
      extracted: { ...extractedOk("Z"), tags: [] }, rules: [techRule],
      existing_library: [], existing_pending_names: new Set(),
    });
    expect(entry.target_dir).toBe("uncategorized");
    expect(entry.target_rule_id).toBeNull();
  });
});
