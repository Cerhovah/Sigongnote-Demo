import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseStrictLocalEnv } from "./local-env-values.mjs";

const values = parseStrictLocalEnv(readFileSync("services/api/.env", "utf8"));
const apiBaseUrl = values.API_BASE_URL;
const supabaseOrigin = values.SUPABASE_URL;
const publishableKey = values.SUPABASE_PUBLISHABLE_KEY;
for (const raw of [apiBaseUrl, supabaseOrigin]) {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("Windows local connection requires loopback origins");
  }
}
if (!publishableKey || /[\r\n]/.test(publishableKey))
  throw new Error("Local publishable key is missing");
if (!process.env.LOCALAPPDATA) throw new Error("Windows LocalAppData is missing");
const directory = join(process.env.LOCALAPPDATA, "Sigongnote");
mkdirSync(directory, { recursive: true });
const target = join(directory, "connection.json");
const temporary = `${target}.new`;
writeFileSync(temporary, JSON.stringify({ apiBaseUrl, supabaseOrigin, publishableKey }),
  { encoding: "utf8", mode: 0o600 });
renameSync(temporary, target);
console.log("PASS");
