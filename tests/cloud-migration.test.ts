import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postgres from "postgres";
import { parseStrictLocalEnv } from "../scripts/local-env-values.mjs";
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';

test("cloud function paths apply twice and transaction rollback preserves definitions",async()=>{
  const env=parseStrictLocalEnv(readFileSync("services/api/.env","utf8"));
  assert.ok(['MIGRATION_DATABASE_URL','DATABASE_URL','WORKER_DATABASE_URL'].every(key=>{
    try{const endpoint=new URL(env[key]??'');return endpoint.hostname==='127.0.0.1'&&['postgres:','postgresql:'].includes(endpoint.protocol);}catch{return false;}
  }),'Local database endpoints required before any connection');
  assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
  const url=env.MIGRATION_DATABASE_URL;
  assert.ok(url && new URL(url).hostname==="127.0.0.1");
  const db=postgres(url,{max:1});
  const sql=readFileSync("supabase/migrations/20260929084825_cloud_function_search_paths.sql","utf8");
  const rollback=new Error("intentional rollback");
  const definition=()=>db`select p.oid,p.proconfig,pg_get_functiondef(p.oid) as definition from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' order by p.oid`;
  try {
    const before=await definition();
    await assert.rejects(db.begin(async tx=>{
      await tx.unsafe(sql);await tx.unsafe(sql);
      const [row]=await tx`select count(*)::int as total from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='app' and not exists(select 1 from unnest(coalesce(p.proconfig,array[]::text[])) v where v like 'search_path=%')`;
      assert.equal(row?.total,0);throw rollback;
    }),error=>error===rollback);
    assert.deepEqual(await definition(),before);
    // Keep the local settings for the related money/tenant regression in this bundle.
    await db.unsafe(sql);
  } finally {await db.end();}
});
