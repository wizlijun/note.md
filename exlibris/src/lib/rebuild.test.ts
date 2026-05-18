import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyRebuildDiff } from "./rebuild";
import type { DiffRow } from "./rules";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

describe("applyRebuildDiff", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("renames each book dir using rename_strict", async () => {
    const diff: DiffRow[] = [
      { book_name: "X", from: "tech", to: "fiction", new_rule_id: "r-fiction" },
      { book_name: "Y", from: "fiction", to: "tech", new_rule_id: "r-tech" },
    ];
    // Mock: every invoke call returns appropriate values for rename + read + write
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "fs_rename_strict") return Promise.resolve(undefined as any);
      if (cmd === "read_text_file") return Promise.resolve(
        "schema_version: 1\ntitle: T\nsource_filename: x\nsource_format: epub\nsource_sha256: a\nraw_path: r\nimport_time: t\n" as any,
      );
      if (cmd === "write_text_file") return Promise.resolve(undefined as any);
      return Promise.resolve(undefined as any);
    });
    await applyRebuildDiff("/sot", diff);
    expect(invoke).toHaveBeenCalledWith("fs_rename_strict", {
      src: "/sot/tech/X", dst: "/sot/fiction/X",
    });
    expect(invoke).toHaveBeenCalledWith("fs_rename_strict", {
      src: "/sot/fiction/Y", dst: "/sot/tech/Y",
    });
  });
});
