import { describe, it, expect, vi, beforeEach } from "vitest";
import { readSharedConfig, writeSharedConfig } from "./shared-config";
import type { SharedConfig } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

describe("shared-config (exlibris)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("readSharedConfig delegates to backend", async () => {
    const fake = {
      version: 1, sotvault: "/x", rawvault: null, calibre_path: null,
    } satisfies Partial<SharedConfig>;
    vi.mocked(invoke).mockResolvedValueOnce(fake);
    expect(await readSharedConfig()).toEqual(fake);
    expect(invoke).toHaveBeenCalledWith("shared_config_read");
  });

  it("writeSharedConfig passes cfg to backend", async () => {
    const cfg: SharedConfig = {
      version: 1, sotvault: "/x", rawvault: "/y", calibre_path: "/z", exlibris: null,
    };
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await writeSharedConfig(cfg);
    expect(invoke).toHaveBeenCalledWith("shared_config_write", { cfg });
  });
});
