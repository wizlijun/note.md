import { describe, it, expect } from "vitest";
import { computeBucketDir, computeRawPath } from "./rawvault-fs";

describe("computeBucketDir", () => {
  it("formats year/yearmonth", () => {
    const d = new Date("2026-05-18T12:00:00+08:00");
    expect(computeBucketDir(d)).toBe("books/2026/202605");
  });
  it("pads single-digit months", () => {
    const d = new Date("2025-01-01T00:00:00Z");
    expect(computeBucketDir(d)).toBe("books/2025/202501");
  });
});

describe("computeRawPath", () => {
  it("joins bucket + bookname + ext", () => {
    const d = new Date("2026-05-18T00:00:00Z");
    expect(computeRawPath("My Book", "epub", d)).toBe("books/2026/202605/My Book.epub");
  });
  it("lowercases the extension", () => {
    const d = new Date("2026-05-18T00:00:00Z");
    expect(computeRawPath("Foo", "PDF", d)).toBe("books/2026/202605/Foo.pdf");
  });
});
