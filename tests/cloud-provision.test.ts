import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { test } from "node:test";
import postgres from "postgres";
import { verifyLocalDevelopmentDb } from "../scripts/db-gate.mjs";
import { assertRuntimeRole, type Db } from "../services/api/src/auth.ts";

test("cloud role provisioning is atomic, repeatable, isolated and redacts SQL failures", async () => {
  assert.equal((await verifyLocalDevelopmentDb()).status, "READY");
  const env = parseEnv(readFileSync("services/api/.env", "utf8"));
  const db = postgres(env.MIGRATION_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const script = readFileSync("scripts/provision-cloud-api.sql", "utf8");
  const rollback = new Error("test rollback");
  try {
    const before = await db`select r.rolcanlogin,r.rolconnlimit,r.rolconfig,a.rolpassword
      from pg_roles r join pg_authid a using(oid) where r.rolname='sigongnote_api'`;
    await assert.rejects(db.begin(async tx => {
      await tx`alter role sigongnote_api nologin`;
      await tx`alter role sigongnote_api reset statement_timeout`;
      await tx.unsafe(script);
      await tx.unsafe(script);
      const [check] = await tx`select
        (select count(*)=1 from vault.decrypted_secrets where
          name='sigongnote_api_runtime_password' and length(decrypted_secret)=96) as credential,
        not has_schema_privilege('sigongnote_api','vault','USAGE') and
        not has_table_privilege('sigongnote_api','vault.decrypted_secrets','SELECT') as isolated`;
      assert.ok(check?.credential && check.isolated);
      await tx`set local role sigongnote_api`;
      await assertRuntimeRole(tx as unknown as Db);
      throw rollback;
    }), error => error === rollback);
    const after = await db`select r.rolcanlogin,r.rolconnlimit,r.rolconfig,a.rolpassword
      from pg_roles r join pg_authid a using(oid) where r.rolname='sigongnote_api'`;
    assert.ok(JSON.stringify(before) === JSON.stringify(after), "role/password rollback");
    const [remaining] = await db`select count(*)=0 as empty from vault.secrets
      where name='sigongnote_api_runtime_password'`;
    assert.ok(remaining?.empty);
    await assert.rejects(db.begin(async tx => {
      await tx`alter role sigongnote_api nologin`;
      await tx.unsafe(script.replace("ALTER ROLE sigongnote_api LOGIN PASSWORD",
        "ALTER ROLE nonexistent_sigongnote_test_role LOGIN PASSWORD"));
    }), error => {
      assert.equal((error as Error).message, "API credential provisioning failed");
      assert.ok(!/[a-f0-9]{96}/.test(JSON.stringify(error)), "no credential in error context");
      return true;
    });
    await assert.rejects(db.begin(async tx => {
      await tx`grant pg_read_all_data to sigongnote_api`;
      await assert.rejects(tx.savepoint(async sp => sp.unsafe(script)),
        /API role privileges require operator review/);
      await tx`set local role sigongnote_api`;
      await assert.rejects(assertRuntimeRole(tx as unknown as Db), /Unsafe API database role/);
      throw rollback;
    }), error => error === rollback);
    await assert.rejects(db.begin(async tx => {
      await tx`set local pg_stat_statements.track = 'all'`;
      await tx.unsafe(script);
    }), /Nested SQL logging requires operator review/);
  } finally { await db.end(); }
});
