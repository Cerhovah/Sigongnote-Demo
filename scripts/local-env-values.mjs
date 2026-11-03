import { parseEnv } from "node:util";

// Reject ambiguous spellings and duplicate assignments before Node parses
// the file. A later value must never silently redirect the local API to prod.
export function parseStrictLocalEnv(content) {
  const seen = new Set();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || seen.has(match[1])) throw new Error("Ambiguous application environment file");
    seen.add(match[1]);
  }
  return parseEnv(content);
}
