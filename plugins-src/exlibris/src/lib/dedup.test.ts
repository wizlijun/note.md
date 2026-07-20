import { describe, it, expect } from "vitest";
import { findDuplicate } from "./dedup";
import type { BookMeta } from "./types";

function metaOf(over: Partial<BookMeta>): BookMeta {
  return {
    schema_version: 1, title: "X", authors: [], publisher: null, language: null,
    isbn: null, tags: [], pubdate: null, description: null,
    source_filename: "", source_format: "epub", source_sha256: "",
    raw_path: "", import_time: "", calibre_version: null, applied_rule: null,
    ...over,
  };
}

describe("findDuplicate", () => {
  const library = [
    metaOf({ title: "A", isbn: "111", source_sha256: "aaa" }),
    metaOf({ title: "B", isbn: "222", source_sha256: "bbb" }),
    metaOf({ title: "C", isbn: null, source_sha256: "ccc" }),
  ];

  it("matches by ISBN when both have one", () => {
    const hit = findDuplicate({ isbn: "111", sha256: "zzz" }, library);
    expect(hit?.title).toBe("A");
  });
  it("matches by SHA256 when ISBN absent", () => {
    const hit = findDuplicate({ isbn: null, sha256: "bbb" }, library);
    expect(hit?.title).toBe("B");
  });
  it("returns null when no match", () => {
    const hit = findDuplicate({ isbn: "999", sha256: "zzz" }, library);
    expect(hit).toBeNull();
  });
  it("treats empty-string ISBN as absent (does not match other empties)", () => {
    const hit = findDuplicate({ isbn: "", sha256: "zzz" }, [metaOf({ isbn: "" })]);
    expect(hit).toBeNull();
  });
});
