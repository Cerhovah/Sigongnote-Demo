import { readFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import postgres from 'postgres';

// Isolated plain-PostgreSQL E2E database (scripts/e2e-db.mjs): run the same oracle through the PostgreSQL driver with the
// admin connection from .work/e2e/env.json. The oracle wraps itself in begin/rollback, so nothing persists.
if (process.env.SIGONGNOTE_E2E_DB === "1") {
  const envFile = ".work/e2e/env.json";
  if (!existsSync(envFile)) { console.error("BLOCKED: isolated E2E database not prepared (node scripts/e2e-db.mjs)"); process.exit(2); }
  const { admin_url: adminUrl } = JSON.parse(readFileSync(envFile, "utf8"));
  const url=new URL(adminUrl);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/sigongnote_e2e_[a-f0-9_]+$/.test(url.pathname))throw new Error('ISOLATED_E2E_DATABASE_REQUIRED');
  const oracle=readFileSync('supabase/tests/tenant_boundary.sql','utf8');
  if(/^\\/m.test(oracle)||!/rollback;\s*$/.test(oracle))throw new Error('TRANSACTIONAL_TENANT_ORACLE_REQUIRED');
  const db=postgres(adminUrl,{max:1,connect_timeout:5,onnotice:()=>{}});
  try{await db.unsafe(oracle);}catch(error){
    console.error('FAIL: isolated tenant RLS/FK oracle');
    console.error(String(error?.message??'PostgreSQL oracle failed').replaceAll(adminUrl,'<admin url>').slice(0,2000));
    process.exitCode=1;
  }finally{await db.end();}
  if(process.exitCode)process.exit(process.exitCode);
  console.log("PASS");
  process.exit(0);
}
const config = readFileSync("supabase/config.toml", "utf8");
const projectId = config.match(/^project_id = "([a-z0-9-]+)"$/m)?.[1];
if (!projectId) throw new Error("Local Supabase project_id is missing");
const container = `supabase_db_${projectId}`;
const installedDocker = process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? "", "Programs", "DockerDesktop", "resources", "bin", "docker.exe")
  : "docker";
const docker = existsSync(installedDocker) ? installedDocker : "docker";
const inspect = spawnSync(docker, ["inspect", "--format", "{{.State.Running}}", container], { encoding: "utf8" });
if (inspect.status !== 0 || inspect.stdout.trim() !== "true") {
  console.error("BLOCKED: local Supabase Postgres container is not running");
  process.exit(2);
}
const result = spawnSync(docker,
  ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
  {
    input: readFileSync("supabase/tests/tenant_boundary.sql", "utf8"),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
if (result.status !== 0) {
  console.error("FAIL: local tenant RLS/FK oracle");
  console.error((result.stderr || result.error?.message || "psql failed").slice(0, 2000));
  process.exit(result.status ?? 1);
}
console.log("PASS");
