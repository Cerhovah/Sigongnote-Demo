import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function loadLocalApiConfig(file: URL = new URL("../.env", import.meta.url)) {
  const content = readFileSync(file, "utf8");
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || seen.has(match[1] ?? "")) throw new Error("Ambiguous local API environment");
    seen.add(match[1] ?? "");
  }
  const env = parseEnv(content);
  // AI_PROVIDER names the product judgement path: 'claude' (Claude Agent SDK) or 'fixture' (no model; local rules only).
  if (env.APP_ENV !== "development" || !["fixture", "claude"].includes(env.AI_PROVIDER ?? "") ||
      !/^(?:0|[1-9][0-9]{0,6})$/.test(env.AI_DAILY_BUDGET_KRW ?? "")) throw new Error("Local API environment is unsafe");
  const databaseUrl = env.DATABASE_URL;
  const supabaseUrl = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = env.SUPABASE_SECRET_KEY;
  let localConnections = false;
  try {
    localConnections = Boolean(databaseUrl && supabaseUrl &&
      new URL(databaseUrl).hostname === "127.0.0.1" &&
      new URL(databaseUrl).username === "sigongnote_api" &&
      new URL(supabaseUrl).hostname === "127.0.0.1");
  } catch { localConnections = false; }
  if (!localConnections || !databaseUrl || !supabaseUrl || !publishableKey || !secretKey) {
    throw new Error("Local API connections are incomplete");
  }
  return { databaseUrl, supabaseUrl, publishableKey, secretKey };
}
