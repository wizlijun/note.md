const FS_ILLEGAL = /[\/:*?"<>|\\]/g;

export function cleanBookName(input: string): string {
  if (!input) return "";
  let out = input.replace(FS_ILLEGAL, "");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length === 0) return "";
  if ([...out].length > 80) {
    out = [...out].slice(0, 80).join("");
  }
  return out;
}

export function resolveDuplicateName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  let n = 2;
  while (existing.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}
