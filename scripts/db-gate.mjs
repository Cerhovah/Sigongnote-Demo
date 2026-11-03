import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import postgres from "postgres";
import { parseStrictLocalEnv } from "./local-env-values.mjs";

/** @param {Record<string,string|undefined>} env */
export function assessDevelopmentDb(env) {
  const configured = ["DATABASE_URL", "MIGRATION_DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]
    .every(key => Boolean(env[key]));
  return {
    status: "BLOCKED",
    scope: "C03-C08",
    reason: configured
      ? "Configured; live isolated DB/Auth/Storage verification required."
      : "Local Supabase unavailable or isolated development credentials missing.",
  };
}

export function localEnvironmentMatches(content, local) {
  let parsed;
  try { parsed = parseStrictLocalEnv(content); } catch { return false; }
  const value = name => parsed[name];
  for (const [name, expected] of Object.entries({
    SUPABASE_URL: local.API_URL,
    SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: local.SECRET_KEY,
    MIGRATION_DATABASE_URL: local.DB_URL,
    VITE_SUPABASE_URL: local.API_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
  })) if (!expected || value(name) !== expected) return false;
  if (!["fixture", "claude"].includes(value("AI_PROVIDER") ?? "") || !/^(?:0|[1-9][0-9]{0,6})$/.test(value("AI_DAILY_BUDGET_KRW") ?? "")) return false;
  const runtime = value("DATABASE_URL");
  if (runtime) {
    try {
      const url = new URL(runtime);
      const migration = new URL(local.DB_URL);
      if (url.username !== "sigongnote_api" ||
          url.hostname !== migration.hostname || url.port !== migration.port ||
          url.pathname !== migration.pathname) return false;
    } catch { return false; }
  }
  const worker = value("WORKER_DATABASE_URL");
  if (worker) {
    try {
      const url = new URL(worker);
      const migration = new URL(local.DB_URL);
      if (url.username !== "sigongnote_worker" ||
          url.hostname !== migration.hostname || url.port !== migration.port ||
          url.pathname !== migration.pathname) return false;
    } catch { return false; }
  }
  return true;
}

/**
 * E2E mode: a plain PostgreSQL database prepared by scripts/e2e-db.mjs (CI, or a developer machine without
 * Docker/Supabase). Enabled with SIGONGNOTE_E2E_DB=1. The same role checks apply; Auth/Storage health is not
 * available and the API tests stub token verification and storage.
 */
export async function verifyE2eDatabase(envPath = "services/api/.env") {
  let configured;
  try { configured = parseStrictLocalEnv(readFileSync(envPath, "utf8")); } catch { return { status: "BLOCKED", reason: "E2E application environment is missing (run node scripts/e2e-db.mjs)" }; }
  for (const [key, role] of [["DATABASE_URL", "sigongnote_api"], ["WORKER_DATABASE_URL", "sigongnote_worker"]]) {
    if (!configured[key]) return { status: "BLOCKED", reason: `${key} is missing` };
    const sql = postgres(configured[key], { max: 1, connect_timeout: 5 });
    try {
      const [row] = await sql`select current_user as name, rolsuper, rolbypassrls, to_regclass('app.memberships') is not null as migrated from pg_roles where rolname = current_user`;
      if (row?.name !== role || row.rolsuper || row.rolbypassrls) return { status: "BLOCKED", reason: `${role} runtime role is unsafe` };
      if (!row.migrated) return { status: "BLOCKED", reason: "Tenant migration is not live in the E2E database" };
    } catch { return { status: "BLOCKED", reason: `${role} runtime role is unreachable` }; }
    finally { await sql.end(); }
  }
  if (!configured.MIGRATION_DATABASE_URL) return { status: "BLOCKED", reason: "MIGRATION_DATABASE_URL is missing" };
  return { status: "READY", scope: "e2e", reason: "Isolated PostgreSQL with every migration applied (no Supabase Auth/Storage)" };
}

export async function verifyLocalDevelopmentDb(envPath = "services/api/.env", options = {}) {
  if (process.env.SIGONGNOTE_E2E_DB === "1") return verifyE2eDatabase(envPath);
  const cli = spawnSync(process.execPath,
    ["node_modules/supabase/dist/supabase.js", "status", "-o", "json"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (cli.status !== 0) return { status: "BLOCKED", reason: "Local Supabase is not running" };
  let local;
  try { local = JSON.parse(cli.stdout); } catch {
    return { status: "BLOCKED", reason: "Local Supabase status is invalid" };
  }
  let apiUrl;
  try { apiUrl = new URL(local.API_URL); } catch {
    return { status: "BLOCKED", reason: "Local Supabase endpoint is missing" };
  }
  if (apiUrl.hostname !== "127.0.0.1" ||
      !local.DB_URL?.startsWith("postgresql://") ||
      !local.PUBLISHABLE_KEY || !local.SECRET_KEY) {
    return { status: "BLOCKED", reason: "Local Supabase endpoints or keys are incomplete" };
  }
  try {
    const content = readFileSync(envPath, "utf8");
    const matching = options.requireRuntimeRole === false
      ? localEnvironmentMatches(content.replace(/^DATABASE_URL=[^\r\n]*/m, "DATABASE_URL="), local)
      : localEnvironmentMatches(content, local);
    if (!matching) {
      return { status: "BLOCKED", reason: "Application environment differs from local Supabase" };
    }
  } catch { return { status: "BLOCKED", reason: "Application environment is missing" }; }
  try {
    const [auth, storage] = await Promise.all([
      fetch(`${local.API_URL}/auth/v1/health`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${local.API_URL}/storage/v1/status`, { signal: AbortSignal.timeout(5000) }),
    ]);
    if (!auth.ok || !storage.ok) return { status: "BLOCKED", reason: "Auth or Storage is not healthy" };
  } catch { return { status: "BLOCKED", reason: "Auth or Storage is unreachable" }; }
  const installedDocker = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? "", "Programs", "DockerDesktop", "resources", "bin", "docker.exe")
    : "docker";
  const docker = existsSync(installedDocker) ? installedDocker : "docker";
  const projectId = readFileSync("supabase/config.toml", "utf8")
    .match(/^project_id = "([a-z0-9-]+)"$/m)?.[1];
  if (!projectId) return { status: "BLOCKED", reason: "Local project ID is missing" };
  const database = spawnSync(docker,
    ["exec", `supabase_db_${projectId}`, "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-c", "select to_regclass('app.memberships')"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (database.status !== 0 || database.stdout.trim() !== "app.memberships") {
    return { status: "BLOCKED", reason: "Tenant migration is not live in local Postgres" };
  }
  if (options.requireRuntimeRole !== false) {
    const configured = parseStrictLocalEnv(readFileSync(envPath, "utf8"));
    if (!configured.DATABASE_URL) return { status: "BLOCKED", reason: "API runtime role is missing" };
    const runtime = postgres(configured.DATABASE_URL, { max: 1, connect_timeout: 5 });
    try {
      const [role] = await runtime`select current_user as name, rolsuper, rolbypassrls
        from pg_roles where rolname = current_user`;
      if (role?.name !== "sigongnote_api" || role.rolsuper || role.rolbypassrls) {
        return { status: "BLOCKED", reason: "API runtime role is unsafe" };
      }
    } catch { return { status: "BLOCKED", reason: "API runtime role is unreachable" }; }
    finally { await runtime.end(); }
    if (!configured.WORKER_DATABASE_URL) {
      return { status: "BLOCKED", reason: "Worker runtime role is missing" };
    }
    const worker = postgres(configured.WORKER_DATABASE_URL, { max: 1, connect_timeout: 5 });
    try {
      const [role] = await worker`select current_user as name, rolsuper, rolbypassrls
        from pg_roles where rolname = current_user`;
      if (role?.name !== "sigongnote_worker" || role.rolsuper || role.rolbypassrls) {
        return { status: "BLOCKED", reason: "Worker runtime role is unsafe" };
      }
    } catch { return { status: "BLOCKED", reason: "Worker runtime role is unreachable" }; }
    finally { await worker.end(); }
  }
  return { status: "READY", scope: "local", reason: "Postgres tenant migration, Auth and Storage are live" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyLocalDevelopmentDb();
  console.log(result.status === "READY" ? "PASS" : `BLOCKED: ${result.reason}`);
  if (result.status !== "READY") process.exitCode = 2;
}
