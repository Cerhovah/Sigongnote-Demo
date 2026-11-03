import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { createApp } from "../services/api/src/app.ts";
import { assertRuntimeRole, createTokenVerifier, RateLimitedAuthError,
  type Db } from "../services/api/src/auth.ts";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";

test("C04 deterministic database and Auth rate failures do not request login or retry forever", async () => {
  const id = randomUUID();
  const db = { begin: async () => {
    throw Object.assign(new Error("deterministic database failure"), { code: "22003" });
  } } as unknown as Db;
  const app = createApp({ db, verifyToken: async () => ({ userId: id, sessionId: id }) });
  const limited = createApp({ db, verifyToken: async () => { throw new RateLimitedAuthError(); } });
  try {
    const args = { method: "GET" as const, url: "/v1/me",
      headers: { authorization: "Bearer fixture.token.value" } };
    const domain = await app.inject(args);
    assert.equal(domain.statusCode, 422);
    assert.equal(domain.json().error.retryable, false);
    const rate = await limited.inject(args);
    assert.equal(rate.statusCode, 429);
    assert.equal(rate.json().error.retryable, true);
  } finally { await app.close(); await limited.close(); }
});

test("C04 real Auth session, membership and device revocation", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const env = parseStrictLocalEnv(readFileSync("services/api/.env", "utf8"));
  const setting = (key: string) => {
    const value = env[key];
    assert.ok(value, `Missing local test setting: ${key}`);
    return value;
  };
  const authUrl = setting("SUPABASE_URL");
  const publishableKey = setting("SUPABASE_PUBLISHABLE_KEY");
  const adminAuth = createClient(authUrl, setting("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const clientAuth = createClient(authUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const adminDb = postgres(setting("MIGRATION_DATABASE_URL"), { max: 1 });
  const runtimeDb = postgres(setting("DATABASE_URL"), { max: 2 });
  await assertRuntimeRole(runtimeDb);
  await assert.rejects(() => assertRuntimeRole(adminDb), /Unsafe API database role/);
  const app = createApp({ db: runtimeDb,
    verifyToken: createTokenVerifier(authUrl, publishableKey) });
  const tenantId = randomUUID();
  const email = `c04-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString("hex");
  let userId: string | undefined;
  let otherOwnerId: string | undefined;
  let tenantCreated = false;
  try {
    const created = await adminAuth.auth.admin.createUser({ email, password, email_confirm: true });
    assert.ifError(created.error);
    userId = created.data.user?.id;
    assert.ok(userId);
    const otherOwner = await adminAuth.auth.admin.createUser({
      email: `c04-owner-${randomUUID()}@example.invalid`,
      password: randomBytes(24).toString("hex"), email_confirm: true,
    });
    assert.ifError(otherOwner.error);
    otherOwnerId = otherOwner.data.user?.id;
    assert.ok(otherOwnerId);
    await adminDb`insert into app.tenants (id, display_name)
      values (${tenantId}::uuid, 'fixture C04 company')`;
    tenantCreated = true;
    await adminDb`insert into app.memberships (tenant_id, user_id, role)
      values (${tenantId}::uuid, ${userId}::uuid, 'owner')`;
    await adminDb`insert into app.memberships (tenant_id, user_id, role)
      values (${tenantId}::uuid, ${otherOwnerId}::uuid, 'owner')`;
    const signed = await clientAuth.auth.signInWithPassword({ email, password });
    assert.ifError(signed.error);
    const token = signed.data.session?.access_token;
    assert.ok(token);
    const headers = { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
    const me = await app.inject({ method: "GET", url: "/v1/me", headers });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().memberships[0].tenant_id, tenantId);
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const payload = { platform: "android", app_version: "0.1", public_key_jwk: jwk };
    const invalidTenant = await app.inject({ method: "POST", url: "/v1/devices",
      headers: { ...headers, "x-tenant-id": randomUUID(), "idempotency-key": randomUUID() },
      payload });
    assert.equal(invalidTenant.statusCode, 404, invalidTenant.body);
    const unreachableAuth = createApp({ db: runtimeDb,
      verifyToken: createTokenVerifier("http://127.0.0.1:1", publishableKey) });
    try {
      const unavailable = await unreachableAuth.inject({ method: "GET", url: "/v1/me", headers });
      assert.equal(unavailable.statusCode, 503, unavailable.body);
      assert.equal(unavailable.json().error.retryable, true);
    } finally { await unreachableAuth.close(); }
    const idempotency = randomUUID();
    const registrationHeaders = { ...headers, "idempotency-key": idempotency };
    const registered = await app.inject({ method: "POST", url: "/v1/devices",
      headers: registrationHeaders, payload });
    assert.equal(registered.statusCode, 201, registered.body);
    const device = registered.json();
    assert.equal(device.active, true);
    const status = await app.inject({ method: "GET", url: `/v1/devices/${device.id}`,
      headers });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().active, true);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y,
    })).digest("hex");
    const byKey = await app.inject({ method: "GET",
      url: `/v1/devices/by-key/${fingerprint}`, headers });
    assert.equal(byKey.statusCode, 200, byKey.body);
    assert.equal(byKey.json().id, device.id);
    const crossTenantStatus = await app.inject({ method: "GET",
      url: `/v1/devices/${device.id}`, headers: { ...headers,
        "x-tenant-id": randomUUID() } });
    assert.equal(crossTenantStatus.statusCode, 404);
    const replay = await app.inject({ method: "POST", url: "/v1/devices",
      headers: registrationHeaders, payload });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json().id, device.id);
    const changed = await app.inject({ method: "POST", url: "/v1/devices",
      headers: registrationHeaders, payload: { ...payload, app_version: "0.2" } });
    assert.equal(changed.statusCode, 409, changed.body);
    const racingJwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .publicKey.export({ format: "jwk" });
    const racingPayload = { ...payload, public_key_jwk: racingJwk };
    const [racingA, racingB] = await Promise.all([randomUUID(), randomUUID()].map(id =>
      app.inject({ method: "POST", url: "/v1/devices",
        headers: { ...headers, "idempotency-key": id }, payload: racingPayload })));
    assert.ok(racingA && racingB);
    assert.deepEqual([racingA.statusCode, racingB.statusCode].sort(), [201, 409]);
    const conflict = racingA.statusCode === 409 ? racingA : racingB;
    assert.equal(conflict.json().error.retryable, false);
    const revoked = await app.inject({ method: "POST", url: `/v1/devices/${device.id}/revoke`,
      headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' }, payload: {} });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(revoked.json().active, false);
    const stopped = await app.inject({ method: "GET", url: `/v1/devices/${device.id}`,
      headers });
    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.equal(stopped.json().active, false);
    const stoppedByKey = await app.inject({ method: "GET",
      url: `/v1/devices/by-key/${fingerprint}`, headers });
    assert.equal(stoppedByKey.statusCode, 200, stoppedByKey.body);
    assert.equal(stoppedByKey.json().active, false);
    await adminDb`update app.memberships set active = false, revoked_at = now()
      where tenant_id = ${tenantId}::uuid and user_id = ${userId}::uuid`;
    const afterMemberRevoke = await app.inject({ method: "GET", url: "/v1/me", headers });
    assert.equal(afterMemberRevoke.statusCode, 200);
    assert.deepEqual(afterMemberRevoke.json().memberships, []);
    const denied = await app.inject({ method: "POST", url: "/v1/devices",
      headers: { ...headers, "idempotency-key": randomUUID() }, payload });
    assert.equal(denied.statusCode, 404, denied.body);
    await adminDb`update app.memberships set active = true, revoked_at = null
      where tenant_id = ${tenantId}::uuid and user_id = ${userId}::uuid`;
    assert.ifError((await clientAuth.auth.signOut({ scope: "global" })).error);
    const afterSessionRevoke = await app.inject({ method: "GET", url: "/v1/me", headers });
    assert.equal(afterSessionRevoke.statusCode, 401, afterSessionRevoke.body);
  } finally {
    await app.close();
    await runtimeDb.end();
    if (tenantCreated) {
      await adminDb.begin(async tx => {
        await tx`alter table app.memberships disable trigger memberships_guard`;
        await tx`delete from app.command_receipts where tenant_id = ${tenantId}::uuid`;
        await tx`delete from app.devices where tenant_id = ${tenantId}::uuid`;
        await tx`delete from app.memberships where tenant_id = ${tenantId}::uuid`;
        await tx`alter table app.memberships enable trigger memberships_guard`;
        await tx`delete from app.tenants where id = ${tenantId}::uuid`;
      });
    }
    await adminDb.end();
    if (userId) assert.ifError((await adminAuth.auth.admin.deleteUser(userId)).error);
    if (otherOwnerId) assert.ifError((await adminAuth.auth.admin.deleteUser(otherOwnerId)).error);
  }
});
