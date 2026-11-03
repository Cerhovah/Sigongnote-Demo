import assert from 'node:assert/strict';import {test} from 'node:test';import {randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';import postgres from 'postgres';
import {createApp} from '../services/api/src/app.js';import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
test('D19 owner-only status isolates company and distinguishes unknown cost and unverified backup',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const e=parseStrictLocalEnv(readFileSync('services/api/.env','utf8')),admin=postgres(e.MIGRATION_DATABASE_URL!),db=postgres(e.DATABASE_URL!);
 const t=randomUUID(),u=randomUUID(),s=randomUUID(),foreign=randomUUID();const app=createApp({db,verifyToken:async()=>({userId:u,sessionId:s})});const headers={authorization:'Bearer fixture','x-tenant-id':t};
 try{
  await admin`insert into auth.users(id) values(${u}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${s}::uuid,${u}::uuid)`;
  await admin`insert into app.tenants(id,display_name) values(${t}::uuid,'D19 synthetic'),(${foreign}::uuid,'Foreign')`;
  await admin`insert into app.memberships(tenant_id,user_id,role) values(${t}::uuid,${u}::uuid,'owner')`;
  await admin`insert into app.voice_requests(tenant_id,user_id,id,request_hash,state,model_version,provider_version,reserved_seconds) values(${t}::uuid,${u}::uuid,${randomUUID()}::uuid,${'0'.repeat(64)},'completed','fixture','fixture',31)`;
  const out=await app.inject({url:'/v1/work/maintenance',headers});assert.equal(out.statusCode,200,out.body);const body=out.json();assert.equal(body.usage.voice_reserved_seconds,31);assert.equal(body.usage.total_cost_minor,null);assert.equal(body.usage.voice_unknown_cost_count,1);assert.equal(body.backup.verified_at,null);assert.equal(out.headers['cache-control'],'no-store');assert.ok(!out.body.includes(u));
  assert.equal((await app.inject({url:'/v1/work/maintenance',headers:{...headers,'x-tenant-id':foreign}})).statusCode,404);
  await admin.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update app.memberships set role='operator' where tenant_id=${t}::uuid and user_id=${u}::uuid`;});assert.equal((await app.inject({url:'/v1/work/maintenance',headers})).statusCode,404);
  await admin`delete from auth.sessions where id=${s}::uuid`;assert.equal((await app.inject({url:'/v1/work/maintenance',headers})).statusCode,401);
 }finally{await app.close();try{await admin.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update app.memberships set role='operator' where tenant_id=${t}::uuid`;await tx`set local session_replication_role=origin`;await tx`delete from app.voice_requests where tenant_id=${t}::uuid`;await tx`delete from app.memberships where tenant_id=${t}::uuid`;await tx`delete from app.tenants where id in (${t}::uuid,${foreign}::uuid)`;await tx`delete from auth.sessions where id=${s}::uuid`;await tx`delete from auth.users where id=${u}::uuid`;});}finally{await Promise.all([admin.end(),db.end()]);}}
});
