import assert from 'node:assert/strict';import {test} from 'node:test';import {randomUUID,createHash} from 'node:crypto';import {readFileSync} from 'node:fs';import postgres from 'postgres';
import {knownFixtureBytes,inspectRepair,quarantineSyncOrphans,restoreFixtureObject} from '../scripts/recovery-repair.js';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
test('N31b fixture recovery requires exact label, hash and length; names alone prove nothing',()=>{
 const bytes=Buffer.from('합성 석고보드 요청. 인수 미확인.'),row={display_name:'N03 queue synthetic',sha256:createHash('sha256').update(bytes).digest('hex'),byte_length:String(bytes.length)};
 assert.deepEqual(knownFixtureBytes(row)?.bytes,bytes);
 for(const patch of [{display_name:'Actual business'},{sha256:'a'.repeat(64)},{byte_length:'0'}])assert.equal(knownFixtureBytes({...row,...patch}),null);
});

test('N31b fixture upload never overwrites and refuses wrong tenant or hash',async()=>{
 const bytes=Buffer.from('합성 석고보드 요청. 인수 미확인.'),row={tenant_id:randomUUID(),storage_key:'',display_name:'N03 queue synthetic',sha256:createHash('sha256').update(bytes).digest('hex'),byte_length:String(bytes.length)};row.storage_key=row.tenant_id+'/fixture';
 let uploads=0,conflict=false,badHash=false;
 const storage={upload:async(_key:string,body:Buffer,options:{upsert:boolean})=>{uploads++;assert.equal(options.upsert,false);assert.deepEqual(body,bytes);return {error:conflict?new Error('conflict'):null};},download:async()=>({error:null,data:new Blob([badHash?'wrong':bytes])})} as unknown as Parameters<typeof restoreFixtureObject>[1];
 await assert.rejects(()=>restoreFixtureObject({...row,storage_key:'another/fixture'},storage),/REPAIR_OBJECT_SCOPE/);assert.equal(uploads,0);
 conflict=true;await assert.rejects(()=>restoreFixtureObject(row,storage),/REPAIR_UPLOAD_FAILED/);
 conflict=false;badHash=true;await assert.rejects(()=>restoreFixtureObject(row,storage),/REPAIR_OBJECT_VERIFY/);
 badHash=false;await restoreFixtureObject(row,storage);
});
test('N31b only orphan feed rows are removed after verified preservation; stale plan and backup failure keep rows',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const e=parseStrictLocalEnv(readFileSync('services/api/.env','utf8')),db=postgres(e.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
 const keep=randomUUID(),orphan=randomUUID(),rollback=new Error('ROLLBACK_SYNTHETIC_REPAIR');
 try{await assert.rejects(db.begin(async tx=>{
  await tx`insert into app.tenants(id,display_name) values(${keep}::uuid,'N31b synthetic'),(${orphan}::uuid,'N31b synthetic')`;
  for(const tenant of [keep,orphan]){await tx`insert into app.sync_heads(tenant_id,position) values(${tenant}::uuid,1)`;await tx`insert into app.sync_changes(tenant_id,position,kind,target_id,removed) values(${tenant}::uuid,1,'material',${randomUUID()}::uuid,true)`;}
  await tx`set local session_replication_role=replica`;await tx`delete from app.tenants where id=${orphan}::uuid`;await tx`set local session_replication_role=origin`;
  const plan=await inspectRepair(tx);let saved:Buffer|null=null;
  await assert.rejects(tx.savepoint(inner=>quarantineSyncOrphans(inner,'0'.repeat(64),async()=>{throw Error('must not save');})),/REPAIR_PLAN_CHANGED/);
  await assert.rejects(tx.savepoint(inner=>quarantineSyncOrphans(inner,plan.plan_hash,async()=>{throw Error('BACKUP_FAILED');})),/BACKUP_FAILED/);
  assert.equal((await inspectRepair(tx)).plan_hash,plan.plan_hash);
  assert.equal(await quarantineSyncOrphans(tx,plan.plan_hash,async bytes=>{saved=bytes;}),plan.orphan_rows);
  assert.ok(saved);assert.equal(JSON.parse((saved as Buffer).toString()).heads.length,plan.content.heads.length);
  assert.equal((await tx`select count(*)::int n from app.sync_changes where tenant_id=${keep}::uuid`)[0]?.n,1);
  assert.equal((await inspectRepair(tx)).orphan_rows,0);
  throw rollback; // Existing orphan records and every synthetic write are restored by this test transaction.
 }),error=>error===rollback);}finally{await db.end();}
});
