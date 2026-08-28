import { existsSync, readFileSync } from "node:fs";

/** Raw key = "value" pairs of one TOML table; enough for [deploy]/[leaks] lookup. */
export function readTomlTable(path: string, table: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  let inTable = false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inTable = line === `[${table}]`;
      continue;
    }
    if (!inTable || line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/);
    const key = m?.[1];
    const value = m?.[2];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}
