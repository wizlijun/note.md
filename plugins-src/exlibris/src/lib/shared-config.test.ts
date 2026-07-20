import { describe, it, expect, vi, beforeEach } from "vitest";
import { readSharedConfig, writeSharedConfig } from "./shared-config";
import type { SharedConfig } from "./types";

vi.mock("./bridge", () => ({ request: vi.fn() }));
import { request } from "./bridge";

describe("shared-config (exlibris)", () => {
  beforeEach(() => vi.mocked(request).mockReset());

  it("readSharedConfig delegates to backend", async () => {
    const fake = {
      version: 1, sotvault: "/x", rawvault: null, calibre_path: null,
    } satisfies Partial<SharedConfig>;
    vi.mocked(request).mockResolvedValueOnce(fake);
    expect(await readSharedConfig()).toEqual(fake);
    expect(request).toHaveBeenCalledWith("shared_config_read");
  });

  it("writeSharedConfig passes cfg to backend", async () => {
    const cfg: SharedConfig = {
      version: 1, sotvault: "/x", rawvault: "/y", calibre_path: "/z", exlibris: null,
    };
    vi.mocked(request).mockResolvedValueOnce(undefined);
    await writeSharedConfig(cfg);
    expect(request).toHaveBeenCalledWith("shared_config_write", { cfg });
  });
});
