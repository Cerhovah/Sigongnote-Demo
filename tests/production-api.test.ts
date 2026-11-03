import assert from "node:assert/strict";
import { test } from "node:test";
import { rootCertificates } from "node:tls";
import postgres from "postgres";
import { loadProductionConfig } from "../services/api/src/production-config.ts";
import { loadLocalApiConfig } from "../services/api/src/config.ts";
import { createProductionApp } from "../services/api/src/production-app.ts";
import { ApiFault, execute } from "../services/api/src/routes.ts";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";

const ref = "a".repeat(20);
const sampleDb = new URL(`postgresql://db.${ref}.supabase.co/postgres`);
sampleDb.username = "sigongnote_api";
sampleDb.password = "fixture".repeat(6);
const sample: NodeJS.ProcessEnv = {
  APP_ENV: "production", AI_PROVIDER: "fixture", AI_DAILY_BUDGET_KRW: "0",
  SUPABASE_PROJECT_REF: ref, SUPABASE_URL: `https://${ref}.supabase.co`,
  DATABASE_URL: sampleDb.href,
  DATABASE_SSL_CA_PEM: rootCertificates[0]!,
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_" + "x".repeat(24),
  SUPABASE_SECRET_KEY: "sb_secret_" + "x".repeat(24),
};
test("production config refuses privileged role, wrong project, TLS bypass and client secrets", () => {
  assert.equal(loadProductionConfig(sample).port, 10000);
  const pooled = sample.DATABASE_URL!.replace("sigongnote_api:", `sigongnote_api.${ref}:`)
    .replace(`db.${ref}.supabase.co`, "aws-1-ap-northeast-2.pooler.supabase.com:5432");
  assert.equal(loadProductionConfig({ ...sample, DATABASE_URL: pooled }).databaseUrl, pooled);
  // Claude Agent SDK runtime: accepted only with a real-looking credential in the process environment.
  assert.equal(loadProductionConfig({ ...sample, AI_PROVIDER: "claude", AI_DAILY_BUDGET_KRW: "10000", ANTHROPIC_API_KEY: "sk-ant-" + "x".repeat(40) }).port, 10000);
  for (const override of [
    { APP_ENV: "development" }, { AI_PROVIDER: "openai" }, { AI_DAILY_BUDGET_KRW: "x" },
    { AI_PROVIDER: "claude" }, { AI_PROVIDER: "claude", ANTHROPIC_API_KEY: "short" },
    { DATABASE_URL: sample.DATABASE_URL!.replace("sigongnote_api:", "postgres:") },
    { DATABASE_URL: `${sample.DATABASE_URL}?sslmode=disable` },
    { DATABASE_URL: pooled.replace(":5432/", ":6543/") },
    { DATABASE_URL: sample.DATABASE_URL!.replace(`db.${ref}.supabase.co`, "db.foreign.supabase.co") },
    { DATABASE_URL: pooled.replace(`sigongnote_api.${ref}:`, `sigongnote_api.${"b".repeat(20)}:`) },
    { SUPABASE_URL: "http://127.0.0.1:54321" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { DATABASE_SSL_CA_PEM: "invalid certificate" },
    { DATABASE_SSL_CA_PEM: undefined },
    { SUPABASE_PUBLISHABLE_KEY: sample.SUPABASE_SECRET_KEY }, { PORT: "NaN" }, { DB_POOL_SIZE: "100" },
  ]) {
    assert.throws(() => loadProductionConfig({ ...sample, ...override }), error => {
      assert.equal((error as Error).message, "Invalid production API configuration");
      return true;
    });
  }
});

test("production routes check real local DB readiness and deny unauthenticated access", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const local = loadLocalApiConfig();
  const db = postgres(local.databaseUrl, { max: 1, connection: { statement_timeout: 15000 } });
  const app = createProductionApp({ db, verifyToken: async () => null });
  app.get("/test/domain-conflict", (_request, reply) => execute(reply, async () => {
    throw new ApiFault("VERSION_CONFLICT", 42);
  }));
  app.get("/test/thrown-domain", async () => { throw new ApiFault("NOT_FOUND"); });
  try {
    const ready = await app.inject("/health/ready");
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().database, "ready");
    assert.equal(ready.headers["cache-control"], "no-store");
    assert.equal((await app.inject("/v1/me")).statusCode, 401);
    const conflict = await app.inject("/test/domain-conflict");
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "VERSION_CONFLICT");
    assert.equal(conflict.json().error.details.current_version, 42);
    assert.equal((await app.inject("/test/thrown-domain")).json().error.code, "NOT_FOUND");
    const malformed = await app.inject({ method: "POST", url: "/v1/devices",
      headers: { "content-type": "application/json" }, payload: "private bad json" });
    assert.equal(malformed.statusCode, 400);
    assert.ok(!malformed.body.includes("private"));
    await db.end();
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
    assert.equal((await app.inject("/health/live")).statusCode, 200);
  } finally { await app.close(); await db.end(); }
});


test("N31c permanent production API runs the improvement retention and workspace scheduler", async context => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const local = loadLocalApiConfig();
  let seen!: () => void;
  const queried = new Promise<void>(resolve => { seen = resolve; });
  const db = postgres(local.databaseUrl, { max: 2, debug: (_connection, query) => {
    if(query.includes('app.improvement_workspaces()')) seen();
  }});
  context.mock.timers.enable({apis:['setInterval']});
  const app = createProductionApp({db,verifyToken:async()=>null});
  try {
    context.mock.timers.tick(60000);
    await Promise.race([queried, new Promise((_,reject)=>setTimeout(()=>reject(Error('improvement scheduler missing')),5000).unref())]);
    // The debug hook observes scheduling; separately require the same API role's query to finish successfully.
    const workspaces=await db`select * from app.improvement_workspaces()`;
    assert.ok(Array.isArray(workspaces));
  } finally { await app.close(); context.mock.timers.reset(); await db.end(); }
});
