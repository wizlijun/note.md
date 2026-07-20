import { describe, it, expect, vi, beforeEach } from "vitest";
import { readRules, writeRules } from "./rules-io";

vi.mock("./bridge", () => ({ request: vi.fn() }));
import { request } from "./bridge";

describe("rules-io", () => {
  beforeEach(() => vi.mocked(request).mockReset());

  it("readRules returns empty list when file missing", async () => {
    vi.mocked(request).mockResolvedValueOnce("");
    const res = await readRules("/sot");
    expect(res.rules).toEqual([]);
  });

  it("readRules parses YAML", async () => {
    vi.mocked(request).mockResolvedValueOnce(`version: 1\nrules:\n  - id: r1\n    name: x\n    when: {}\n    target: t\n`);
    const res = await readRules("/sot");
    expect(res.rules).toHaveLength(1);
    expect(res.rules[0].id).toBe("r1");
  });

  it("writeRules serializes and sends to backend", async () => {
    vi.mocked(request).mockResolvedValueOnce(undefined);
    await writeRules("/sot", { version: 1, rules: [] });
    expect(request).toHaveBeenCalledWith("rules_write", {
      sotvault: "/sot",
      content: expect.stringContaining("version: 1"),
    });
  });
});
