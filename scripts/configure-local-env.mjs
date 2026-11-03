import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseStrictLocalEnv } from "./local-env-values.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const status = spawnSync(process.execPath,
    ["node_modules/supabase/dist/supabase.js", "status", "-o", "json"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (status.status !== 0) throw new Error("Local Supabase is not running");
  const local = JSON.parse(status.stdout);
  if (!local.API_URL?.startsWith("http://127.0.0.1:") ||
      !local.DB_URL?.startsWith("postgresql://") ||
      !local.PUBLISHABLE_KEY || !local.SECRET_KEY) {
    throw new Error("Local Supabase status is incomplete");
  }
  const path = "services/api/.env";
  const original = readFileSync(path, "utf8");
  const values = {
    SUPABASE_URL: local.API_URL,
    SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: local.SECRET_KEY,
    MIGRATION_DATABASE_URL: local.DB_URL,
    VITE_SUPABASE_URL: local.API_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
    // Claude Agent SDK is the product judgement runtime; the credential lives only in the process environment.
    AI_PROVIDER: "claude",
    AI_DAILY_BUDGET_KRW: "10000",
  };
  const next = configureLocalContent(original, values, process.argv.includes("--replace"));
  if (next !== original) {
    writeFileSync(`${path}.tmp`, next, { encoding: "utf8", mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  console.log("PASS");
}

export function configureLocalContent(original, values, replace = false) {
  parseStrictLocalEnv(original);
  let next = original;
  for (const [name, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error("Local status included an invalid value");
    const line = new RegExp(`^${name}=([^\r\n]*)`, "m");
    if (!line.test(next)) throw new Error(`Expected setting ${name} is missing`);
    next = next.replace(line, (_whole, current) => {
      if (current && current !== value && !replace) {
        throw new Error(`Existing ${name} differs from local Supabase; no settings changed`);
      }
      return `${name}=${value}`;
    });
  }
  const databaseUrl = next.match(/^DATABASE_URL=([^\r\n]*)/m)?.[1];
  if (databaseUrl) {
    let runtime;
    let migration;
    try {
      runtime = new URL(databaseUrl);
      migration = new URL(values.MIGRATION_DATABASE_URL);
    } catch { throw new Error("Existing DATABASE_URL is invalid"); }
    if (runtime.hostname !== migration.hostname || runtime.port !== migration.port ||
        runtime.pathname !== migration.pathname) {
      if (!replace) throw new Error("Existing DATABASE_URL is not the local Supabase database");
      next = next.replace(/^DATABASE_URL=[^\r\n]*/m, "DATABASE_URL=");
    }
  }
  const workerUrl = next.match(/^WORKER_DATABASE_URL=([^\r\n]*)/m)?.[1];
  if (workerUrl) {
    let worker;
    let migration;
    try {
      worker = new URL(workerUrl);
      migration = new URL(values.MIGRATION_DATABASE_URL);
    } catch { throw new Error("Existing WORKER_DATABASE_URL is invalid"); }
    if (worker.username !== "sigongnote_worker" ||
        worker.hostname !== migration.hostname || worker.port !== migration.port ||
        worker.pathname !== migration.pathname) {
      if (!replace) throw new Error("Existing WORKER_DATABASE_URL is not the local worker role");
      next = next.replace(/^WORKER_DATABASE_URL=[^\r\n]*/m, "WORKER_DATABASE_URL=");
    }
  }
  return next;
}
