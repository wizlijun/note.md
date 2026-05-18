import YAML from "yaml";
import { invoke } from "@tauri-apps/api/core";
import type { RulesFile } from "./types";

export async function readRules(sotvault: string): Promise<RulesFile> {
  const raw = await invoke<string>("rules_read", { sotvault });
  if (!raw.trim()) return { version: 1, rules: [] };
  const parsed = YAML.parse(raw);
  return { version: 1, rules: parsed?.rules ?? [] };
}

export async function writeRules(sotvault: string, file: RulesFile): Promise<void> {
  const content = YAML.stringify(file);
  await invoke("rules_write", { sotvault, content });
}
