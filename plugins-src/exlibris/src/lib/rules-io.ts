import YAML from "yaml";
import { request } from "./bridge";
import type { RulesFile } from "./types";

export async function readRules(sotvault: string): Promise<RulesFile> {
  const raw = await request<string>("rules_read", { sotvault });
  if (!raw.trim()) return { version: 1, rules: [] };
  const parsed = YAML.parse(raw);
  return { version: 1, rules: parsed?.rules ?? [] };
}

export async function writeRules(sotvault: string, file: RulesFile): Promise<void> {
  const content = YAML.stringify(file);
  await request("rules_write", { sotvault, content });
}
