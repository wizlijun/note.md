import { request } from "./bridge";
import type { SharedConfig } from "./types";

export async function readSharedConfig(): Promise<SharedConfig> {
  return await request("shared_config_read");
}

export async function writeSharedConfig(cfg: SharedConfig): Promise<void> {
  await request("shared_config_write", { cfg });
}
