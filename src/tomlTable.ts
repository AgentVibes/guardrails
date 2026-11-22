import { existsSync, readFileSync } from "node:fs";

/** Raw key = "value" (or key = 123) pairs of one TOML table; enough for [deploy]/[leaks]/[metrics] lookup. */
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
    // bare or quoted key ('zod-optional-nullable' is a valid bare key, but
    // quoted spellings must read identically)
    // A value is a quoted string, or a bare token (`max_file_sloc = 500`)
    // returned as written, so the caller validates it rather than this
    // reader silently dropping a value it cannot type.
    const m = line.match(
      /^(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*(?:"([^"]*)"|([^"#\s][^#]*?))\s*(?:#.*)?$/,
    );
    const key = m?.[1] ?? m?.[2];
    const value = m?.[3] ?? m?.[4];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}
