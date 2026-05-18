import { describe, it, expect, vi, beforeEach } from "vitest";
import { readRules, writeRules } from "./rules-io";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

describe("rules-io", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("readRules returns empty list when file missing", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    const res = await readRules("/sot");
    expect(res.rules).toEqual([]);
  });

  it("readRules parses YAML", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(`version: 1\nrules:\n  - id: r1\n    name: x\n    when: {}\n    target: t\n`);
    const res = await readRules("/sot");
    expect(res.rules).toHaveLength(1);
    expect(res.rules[0].id).toBe("r1");
  });

  it("writeRules serializes and sends to backend", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await writeRules("/sot", { version: 1, rules: [] });
    expect(invoke).toHaveBeenCalledWith("rules_write", {
      sotvault: "/sot",
      content: expect.stringContaining("version: 1"),
    });
  });
});
