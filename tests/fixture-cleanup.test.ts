import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import postgres from 'postgres';
import {deleteFixtureTenants} from './fixture-cleanup.js';
import {foreignKeyGaps} from '../scripts/recovery-audit.js';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
test('D19 fixture cleanup includes change feed and preserves the neighbouring tenant',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const e=parseStrictLocalEnv(await readFile('services/api/.env','utf8')),db=postgres(e.MIGRATION_DATABASE_URL!,{max:1});
 try{await db.begin(async tx=>{
  const before=await foreignKeyGaps(tx),first=randomUUID(),second=randomUUID();
  await tx`insert into app.tenants(id,display_name) values(${first}::uuid,'cleanup fixture'),(${second}::uuid,'retained fixture')`;
  for(const tenant of [first,second]){await tx`insert into app.sync_heads(tenant_id,position) values(${tenant}::uuid,1)`;await tx`insert into app.sync_changes(tenant_id,position,kind,target_id,removed) values(${tenant}::uuid,1,'material',${randomUUID()}::uuid,true)`;}
  await deleteFixtureTenants(tx,[first]);
  assert.equal((await tx`select count(*)::int n from app.sync_changes where tenant_id=${first}::uuid`)[0]?.n,0);
  assert.equal((await tx`select count(*)::int n from app.sync_changes where tenant_id=${second}::uuid`)[0]?.n,1);
  await deleteFixtureTenants(tx,[second]);assert.deepEqual(await foreignKeyGaps(tx),before);
 });}finally{await db.end();}
});
