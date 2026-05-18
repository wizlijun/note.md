import { describe, it, expect, vi, beforeEach } from "vitest";
import { listSotvaultMeta } from "./sotvault-fs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

describe("listSotvaultMeta", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("parses YAML for each entry", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { rule_dir: "tech", book_name: "X", meta_yaml: "schema_version: 1\ntitle: X\nsource_filename: x.epub\nsource_format: epub\nsource_sha256: a\nraw_path: r\nimport_time: t\n" },
    ]);
    const res = await listSotvaultMeta("/sot");
    expect(res).toHaveLength(1);
    expect(res[0].book_name).toBe("X");
    expect(res[0].meta.title).toBe("X");
  });
});
