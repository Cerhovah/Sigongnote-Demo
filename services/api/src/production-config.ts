import { X509Certificate } from "node:crypto";

export type ProductionConfig = {
  databaseUrl: string; supabaseUrl: string; publishableKey: string; secretKey: string;
  port: number; poolSize: number; ca: string;
};

/** No local .env fallback. Error messages must never include supplied values. */
export function loadProductionConfig(env: NodeJS.ProcessEnv = process.env): ProductionConfig {
  const fail = (): never => { throw new Error("Invalid production API configuration"); };
  // AI_PROVIDER=claude turns on the Claude Agent SDK judgement path (credential via ANTHROPIC_API_KEY);
  // 'fixture' keeps the no-model mode. Any other provider name is refused. The KRW budget is enforced in SQL.
  if (env.APP_ENV !== "production" || !["fixture", "claude"].includes(env.AI_PROVIDER ?? "") ||
      !/^(?:0|[1-9][0-9]{0,6})$/.test(env.AI_DAILY_BUDGET_KRW ?? "") || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail();
  if (env.AI_PROVIDER === "claude" && !(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length >= 20 && !/\s/.test(env.ANTHROPIC_API_KEY))) fail();
  const ref = env.SUPABASE_PROJECT_REF ?? "";
  if (!/^[a-z]{20}$/.test(ref)) fail();
  const supabaseUrl = `https://${ref}.supabase.co`;
  if (env.SUPABASE_URL !== supabaseUrl) fail();
  const databaseUrl = env.DATABASE_URL ?? "";
  try {
    const db = new URL(databaseUrl);
    const direct = db.hostname === `db.${ref}.supabase.co` && db.username === "sigongnote_api";
    const pooled = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(db.hostname) &&
      db.username === `sigongnote_api.${ref}`;
    if (db.protocol !== "postgresql:" || (!direct && !pooled) || db.pathname !== "/postgres" ||
        decodeURIComponent(db.password).length < 32 || db.search || db.hash ||
        (db.port && db.port !== "5432")) fail();
  } catch { fail(); }
  function key(name: string, prefix: string, role: string): string {
    const value = env[name] ?? "";
    if (value.length > 4096 || /\s/.test(value)) return fail();
    if (value.startsWith(prefix) && /^[A-Za-z0-9_-]{20,}$/.test(value.slice(prefix.length))) return value;
    try {
      const parts = value.split(".");
      if (parts.length !== 3) return fail();
      const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
      if (payload.role !== role || payload.ref !== ref) return fail();
      return value;
    } catch { return fail(); }
  }
  const port = Number(env.PORT ?? "10000");
  const poolSize = Number(env.DB_POOL_SIZE ?? "5");
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(poolSize) || poolSize < 1 || poolSize > 10) fail();
  const ca = env.DATABASE_SSL_CA_PEM ?? "";
  try { if (!new X509Certificate(ca).ca) fail(); } catch { fail(); }
  return { databaseUrl, supabaseUrl, port, poolSize, ca,
    publishableKey: key("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_", "anon"),
    secretKey: key("SUPABASE_SECRET_KEY", "sb_secret_", "service_role") };
}
