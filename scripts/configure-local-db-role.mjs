import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { parseStrictLocalEnv } from "./local-env-values.mjs";
import { verifyLocalDevelopmentDb } from "./db-gate.mjs";

async function isSafeConnection(url, name) {
  if (!url) return false;
  const connection = postgres(url, { max: 1, connect_timeout: 5 });
  try {
    const [role] = await connection`select current_user, rolsuper, rolbypassrls
      from pg_roles where rolname = current_user`;
    return role?.current_user === name && !role.rolsuper && !role.rolbypassrls;
  } catch { return false; }
  finally { await connection.end(); }
}

export async function configureLocalDbRole() {
  if ((await verifyLocalDevelopmentDb("services/api/.env", { requireRuntimeRole: false })).status !== "READY") {
    throw new Error("Local Supabase environment gate is not ready");
  }
  const path = "services/api/.env";
  const original = readFileSync(path, "utf8");
  const env = parseStrictLocalEnv(original);
  const roles = [
    { setting: "DATABASE_URL", name: "sigongnote_api" },
    { setting: "WORKER_DATABASE_URL", name: "sigongnote_worker" },
  ];
  let next = original;
  const admin = postgres(env.MIGRATION_DATABASE_URL, { max: 1, connect_timeout: 5 });
  try {
    for (const roleSpec of roles) {
      if (await isSafeConnection(env[roleSpec.setting], roleSpec.name)) continue;
      const password = randomBytes(32).toString("hex");
      await admin.unsafe(`alter role ${roleSpec.name} with login password '${password}'`);
      const [role] = await admin`select rolsuper, rolbypassrls from pg_roles
        where rolname = ${roleSpec.name}`;
      if (!role || role.rolsuper || role.rolbypassrls) throw new Error("Runtime role is too privileged");
      const url = new URL(env.MIGRATION_DATABASE_URL);
      url.username = roleSpec.name;
      url.password = password;
      const line = new RegExp(`^${roleSpec.setting}=[^\\r\\n]*$`, "m");
      next = line.test(next) ? next.replace(line, `${roleSpec.setting}=${url}`) :
        `${next.trimEnd()}\n${roleSpec.setting}=${url}\n`;
    }
  } finally { await admin.end(); }
  if (next !== original) {
    writeFileSync(`${path}.tmp`, next, { encoding: "utf8", mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  console.log("PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await configureLocalDbRole();
}
