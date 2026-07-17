import { describe, it, expect } from "vitest";
import { evaluateRule, applyRules, computeRebuildDiff, DEFAULT_RULE } from "./rules";
import type { Rule, BookMeta } from "./types";

const techRule: Rule = {
  id: "r-tech",
  name: "Tech",
  when: { ext: ["pdf", "epub"], tag_contains: ["programming"] },
  target: "tech",
};

const fictionRule: Rule = {
  id: "r-fiction",
  name: "Fiction",
  when: { tag_contains: ["novel"] },
  target: "fiction",
};

function metaOf(over: Partial<BookMeta>): BookMeta {
  return {
    schema_version: 1, title: "", authors: [], publisher: null, language: null,
    isbn: null, tags: [], pubdate: null, description: null,
    source_filename: "", source_format: "", source_sha256: "",
    raw_path: "", import_time: "", calibre_version: null, applied_rule: null,
    ...over,
  };
}

describe("evaluateRule", () => {
  it("matches when all conditions satisfied", () => {
    const m = metaOf({ source_format: "pdf", tags: ["programming"] });
    expect(evaluateRule(techRule, m)).toBe(true);
  });
  it("fails when ext mismatched", () => {
    const m = metaOf({ source_format: "mobi", tags: ["programming"] });
    expect(evaluateRule(techRule, m)).toBe(false);
  });
  it("treats empty `when` as match-all", () => {
    expect(evaluateRule(DEFAULT_RULE, metaOf({}))).toBe(true);
  });
  it("tag_contains uses substring match (case-insensitive)", () => {
    const m = metaOf({ tags: ["Programming Languages"] });
    expect(evaluateRule(
      { id: "r", name: "r", when: { tag_contains: ["programming"] }, target: "t" },
      m
    )).toBe(true);
  });
  it("author_contains matches concatenated authors", () => {
    const m = metaOf({ authors: ["Donald Knuth"] });
    expect(evaluateRule(
      { id: "r", name: "r", when: { author_contains: ["knuth"] }, target: "ref" },
      m
    )).toBe(true);
  });
});

describe("applyRules", () => {
  it("first match wins", () => {
    const m = metaOf({ source_format: "epub", tags: ["programming", "novel"] });
    const res = applyRules([techRule, fictionRule], m);
    expect(res.rule_id).toBe("r-tech");
    expect(res.target).toBe("tech");
  });
  it("falls back to default uncategorized when nothing matches", () => {
    const m = metaOf({ source_format: "mobi", tags: [] });
    const res = applyRules([techRule, fictionRule], m);
    expect(res.rule_id).toBeNull();
    expect(res.target).toBe("uncategorized");
  });
});

describe("computeRebuildDiff", () => {
  it("returns rows whose current path differs from new target", () => {
    const rules = [techRule];
    const entries = [
      { current_dir: "fiction", book_name: "X", meta: metaOf({ tags: ["programming"], source_format: "pdf" }) },
      { current_dir: "tech", book_name: "Y", meta: metaOf({ tags: ["programming"], source_format: "pdf" }) },
    ];
    const diff = computeRebuildDiff(rules, entries);
    expect(diff.length).toBe(1);
    expect(diff[0].from).toBe("fiction");
    expect(diff[0].to).toBe("tech");
  });
});
