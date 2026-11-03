import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";

test("C13f native refresh grant rotates a synthetic local session", async () => {
  assert.notEqual(process.env.SIGONGNOTE_E2E_DB,'1');
  assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
  const env = parseStrictLocalEnv(readFileSync("services/api/.env", "utf8"));
  const url = env.SUPABASE_URL;
  const publishable = env.SUPABASE_PUBLISHABLE_KEY;
  const secret = env.SUPABASE_SECRET_KEY;
  assert.ok(url && publishable && secret);
  const admin = createClient(url, secret, { auth:{ autoRefreshToken:false,
    persistSession:false, detectSessionInUrl:false } });
  const client = createClient(url, publishable, { auth:{ autoRefreshToken:false,
    persistSession:false, detectSessionInUrl:false } });
  const email = `c13f-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm:true });
  assert.ifError(created.error);
  const userId = created.data.user?.id;
  assert.ok(userId);
  try {
    const signed = await client.auth.signInWithPassword({ email, password });
    assert.ifError(signed.error);
    const refreshToken = signed.data.session?.refresh_token;
    assert.ok(refreshToken);
    const refreshed = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method:"POST", headers:{ apikey:publishable, "content-type":"application/json" },
      body:JSON.stringify({ refresh_token:refreshToken }),
    });
    assert.equal(refreshed.status,200);
    const body = await refreshed.json() as {access_token?:string;refresh_token?:string;
      expires_in?:number;user?:{id?:string}};
    assert.ok(body.access_token && body.refresh_token);
    assert.ok((body.expires_in ?? 0) >= 60);
    assert.equal(body.user?.id,userId);
  } finally {
    assert.ifError((await admin.auth.admin.deleteUser(userId)).error);
  }
});
