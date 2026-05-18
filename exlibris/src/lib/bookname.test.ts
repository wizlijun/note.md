import { describe, it, expect } from "vitest";
import { cleanBookName, resolveDuplicateName } from "./bookname";

describe("cleanBookName", () => {
  it("trims whitespace", () => {
    expect(cleanBookName("  hello  ")).toBe("hello");
  });
  it("collapses internal whitespace", () => {
    expect(cleanBookName("a   b\tc\nd")).toBe("a b c d");
  });
  it("strips fs-illegal characters", () => {
    expect(cleanBookName("a/b:c*d?e\"f<g>h|i\\j")).toBe("abcdefghij");
  });
  it("truncates to 80 chars, preserving CJK boundary", () => {
    const long = "中".repeat(100);
    const got = cleanBookName(long);
    expect(got.length).toBeLessThanOrEqual(80);
    expect([...got].every((c) => c === "中")).toBe(true);
  });
  it("returns empty string when input is only illegal chars or whitespace", () => {
    expect(cleanBookName("   ///   ")).toBe("");
  });
  it("preserves CJK and emoji", () => {
    expect(cleanBookName("三体 — Liu Cixin")).toBe("三体 — Liu Cixin");
  });
});

describe("resolveDuplicateName", () => {
  it("returns the name unchanged when not in existing", () => {
    expect(resolveDuplicateName("Foo", new Set())).toBe("Foo");
  });
  it("adds ' (2)' on first conflict", () => {
    expect(resolveDuplicateName("Foo", new Set(["Foo"]))).toBe("Foo (2)");
  });
  it("increments to (3) when (2) also taken", () => {
    expect(resolveDuplicateName("Foo", new Set(["Foo", "Foo (2)"]))).toBe("Foo (3)");
  });
  it("does not match unrelated similar names", () => {
    expect(resolveDuplicateName("Foo Bar", new Set(["Foo"]))).toBe("Foo Bar");
  });
});
