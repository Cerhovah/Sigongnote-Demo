import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../services/api/src/app.ts";
import { assessDevelopmentDb } from "../scripts/db-gate.mjs";
test("liveness does not expose environment or claim DB readiness", async () => {
 const app = createApp();
 try { const response = await app.inject({url:"/health/live"}); assert.equal(response.statusCode,200); assert.deepEqual(response.json(),{service:"sigongnote-api",status:"alive"}); assert.equal((await app.inject({url:"/v1/projects"})).statusCode,404); } finally { await app.close(); }
});
test("DB gate never marks missing or configured-but-unverified credentials PASS", () => {
 assert.equal(assessDevelopmentDb({}).status,"BLOCKED");
 assert.equal(assessDevelopmentDb({DATABASE_URL:"private",SUPABASE_URL:"private"}).status,"BLOCKED");
 assert.equal(JSON.stringify(assessDevelopmentDb({DATABASE_URL:"do-not-leak"})).includes("do-not-leak"),false);
});
