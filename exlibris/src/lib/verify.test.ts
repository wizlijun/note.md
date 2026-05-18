import { describe, it, expect, vi, beforeEach } from "vitest";
import { verify } from "./verify";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./sotvault-fs", () => ({ listSotvaultMeta: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { listSotvaultMeta } from "./sotvault-fs";

describe("verify", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); vi.mocked(listSotvaultMeta).mockReset(); });

  it("reports orphan raw (file in rawvault, no meta refers to it)", async () => {
    vi.mocked(listSotvaultMeta).mockResolvedValueOnce([]);
    vi.mocked(invoke).mockResolvedValueOnce(["books/2025/202501/Orphan.epub"]);
    const r = await verify("/sot", "/raw");
    expect(r.orphan_raw).toEqual(["books/2025/202501/Orphan.epub"]);
  });

  it("reports missing raw (meta refers to non-existent file)", async () => {
    vi.mocked(listSotvaultMeta).mockResolvedValueOnce([{
      rule_dir: "tech", book_name: "X",
      meta: { schema_version: 1, title: "X", authors: [], publisher: null, language: null,
        isbn: null, tags: [], pubdate: null, description: null,
        source_filename: "", source_format: "epub", source_sha256: "",
        raw_path: "books/2025/202501/X.epub", import_time: "", calibre_version: null, applied_rule: null,
      },
    }]);
    vi.mocked(invoke).mockResolvedValueOnce([]); // no raw files
    const r = await verify("/sot", "/raw");
    expect(r.missing_raw).toEqual(["books/2025/202501/X.epub"]);
  });

  it("reports duplicate ISBN", async () => {
    const meta = (title: string, isbn: string) => ({
      schema_version: 1 as const, title, authors: [], publisher: null, language: null,
      isbn, tags: [], pubdate: null, description: null,
      source_filename: "", source_format: "epub", source_sha256: "",
      raw_path: `books/2025/202501/${title}.epub`,
      import_time: "", calibre_version: null, applied_rule: null,
    });
    vi.mocked(listSotvaultMeta).mockResolvedValueOnce([
      { rule_dir: "t", book_name: "A", meta: meta("A", "111") },
      { rule_dir: "t", book_name: "B", meta: meta("B", "111") },
    ]);
    vi.mocked(invoke).mockResolvedValueOnce([
      "books/2025/202501/A.epub", "books/2025/202501/B.epub",
    ]);
    const r = await verify("/sot", "/raw");
    expect(r.duplicate_isbn).toEqual([{ isbn: "111", books: ["A", "B"] }]);
  });
});
