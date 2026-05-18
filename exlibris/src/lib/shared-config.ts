import { invoke } from "@tauri-apps/api/core";
import type { SharedConfig } from "./types";

export async function readSharedConfig(): Promise<SharedConfig> {
  return await invoke("shared_config_read");
}

export async function writeSharedConfig(cfg: SharedConfig): Promise<void> {
  await invoke("shared_config_write", { cfg });
}
