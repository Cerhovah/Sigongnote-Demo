import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import postgres from 'postgres';
import {foreignKeyGapDetails,originalLocationCounts} from '../scripts/recovery-audit.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';

test('Recovery audit distinguishes missing server originals from unchecked device copies',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(await readFile('services/api/.env','utf8'));
 const db=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}}),rollback=Error('rollback fixture');
 try{await assert.rejects(db.begin(async tx=>{
  const before=await originalLocationCounts(tx),tenant=randomUUID();
  await tx`insert into app.tenants(id,display_name) values(${tenant}::uuid,'recovery audit fixture')`;
  for(const [i,location] of ['server','device'].entries())await tx`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key,storage_location) values(${tenant}::uuid,${String(i).repeat(64)},10,'text/plain',${tenant+'/'+location},${location})`;
  const after=await originalLocationCounts(tx);
  assert.equal(after.missing_original_metadata,before.missing_original_metadata+1);
  assert.equal(after.server_original_references,before.server_original_references+1);
  assert.equal(after.device_originals_not_checked,before.device_originals_not_checked+1);
  throw rollback;
 }),e=>e===rollback);}finally{await db.end();}
});

test('Recovery audit reports validated and NOT VALID broken references separately',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(await readFile('services/api/.env','utf8'));
 const db=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}}),rollback=Error('rollback FK fixture');
 const table='audit_'+randomUUID().replaceAll('-','');
 try{await assert.rejects(db.begin(async tx=>{
  await tx.unsafe(`create table app.${table}(unvalidated uuid, deferred uuid)`);
  await tx.unsafe(`insert into app.${table}(unvalidated) values(gen_random_uuid())`);
  await tx.unsafe(`alter table app.${table} add constraint audit_unvalidated foreign key(unvalidated) references app.tenants(id) not valid`);
  await tx.unsafe(`alter table app.${table} add constraint audit_deferred foreign key(deferred) references app.tenants(id) deferrable initially deferred`);
  await tx.unsafe(`insert into app.${table}(deferred) values(gen_random_uuid())`);
  const details=await foreignKeyGapDetails(tx);
  assert.deepEqual(details[table+'.audit_unvalidated'],{rows:1,validated:false});
  assert.deepEqual(details[table+'.audit_deferred'],{rows:1,validated:true});
  throw rollback;
 }),e=>e===rollback);}finally{await db.end();}
});
