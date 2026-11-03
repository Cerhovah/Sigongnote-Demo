import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID,generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {createClient} from '@supabase/supabase-js';
import {createApp} from '../services/api/src/app.js';
import {LOCAL_CAPTURE_POLICY,sourceAllowsMime} from '../services/api/src/capture-scope.js';
import {createStorageGateway,ORIGINAL_BUCKET} from '../services/api/src/storage.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {deleteFixtureTenants} from './fixture-cleanup.js';

test('N04 current original hash, completion and source access are all required for reclamation',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1}),db=postgres(env.DATABASE_URL!,{max:4});
 const user=randomUUID(),session=randomUUID(),tenant=randomUUID(),other=randomUUID();
 let failReadUrl=false;
 const storage=createStorageGateway(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!);
 const readUrl=storage.readUrl!;storage.readUrl=async key=>{if(failReadUrl)throw Error('synthetic signing failure');return readUrl(key);};
 const bucket=createClient(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false}}).storage.from(ORIGINAL_BUCKET);
 const app=createApp({db,verifyToken:async()=>({userId:user,sessionId:session}),capturePolicy:LOCAL_CAPTURE_POLICY,storage});
 const headers={authorization:'Bearer synthetic','x-tenant-id':tenant};let path:string|undefined;
 const call=(url:string,payload?:object)=>app.inject({url,method:payload?'POST':'GET',headers:{...headers,'idempotency-key':randomUUID()},...(payload?{payload}:{})});
 try{
  await admin`insert into auth.users(id) values(${user}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;
  await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'N04 synthetic')`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
  const key=generateKeyPairSync('ec',{namedCurve:'P-256'}).publicKey.export({format:'jwk'});
  const device=await call('/v1/devices',{platform:'windows',app_version:'n04-fixture',public_key_jwk:{kty:'EC',crv:'P-256',x:key.x,y:key.y}});assert.equal(device.statusCode,201,device.body);
  const source=await call('/v1/capture-sources',{device_id:device.json().id,kind:'folder',scope_fingerprint:'a'.repeat(64),consent_version:1,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false});assert.equal(source.statusCode,201,source.body);
  const bytes=Buffer.from('N04 synthetic recoverable original'),hash=createHash('sha256').update(bytes).digest('hex'),body={sha256:hash,byte_length:bytes.length};
  const prepared=await call('/v1/ingestions',{client_capture_id:randomUUID(),...body,declared_mime:'text/plain',source_id:source.json().id,source_generation:1});assert.equal(prepared.statusCode,201,prepared.body);
  const id=prepared.json().ingestion_id;path=`${tenant}/${id}`;
  assert.ifError((await bucket.uploadToSignedUrl(path,new URL(prepared.json().upload_url).searchParams.get('token')!,bytes,{contentType:'text/plain'})).error);
  const completed=await call(`/v1/ingestions/${id}/complete`,body);assert.equal(completed.statusCode,200,completed.body);
  const route=`/v1/ingestions/${id}/durability`;
  assert.equal((await call(route,body)).statusCode,404,'active processing keeps local copy');
  await admin`update app.jobs set state='succeeded' where tenant_id=${tenant}::uuid`;
  const proof=await call(route,body);assert.equal(proof.statusCode,200,proof.body);assert.equal(proof.json().revision_id,completed.json().revision_id);
  assert.equal((await call('/v1/capture-status')).json().recovery.checked,1);
  assert.equal((await call('/v1/capture-status')).json().recovery.failed,0);
  const restored=Buffer.from(await (await fetch(proof.json().restore_url)).arrayBuffer());assert.equal(createHash('sha256').update(restored).digest('hex'),hash);
  assert.equal((await call(route,{...body,sha256:'f'.repeat(64)})).statusCode,422);
  assert.equal((await app.inject({url:route,method:'POST',headers:{...headers,'x-tenant-id':other},payload:body})).statusCode,404);
  await bucket.remove([path]);assert.equal((await call(route,body)).statusCode,503,'DB ACK without bytes cannot reclaim');
  assert.equal((await call('/v1/capture-status')).json().recovery.failed,1);
  assert.equal((await app.inject({url:'/v1/capture-status',headers:{...headers,'x-tenant-id':other}})).statusCode,404);
  assert.ifError((await bucket.upload(path,bytes,{contentType:'text/plain'})).error);
  assert.equal((await call(route,body)).statusCode,200,'restored original clears failed metric');
  assert.equal((await call('/v1/capture-status')).json().recovery.failed,0);
  failReadUrl=true;assert.equal((await call(route,body)).statusCode,503);assert.equal((await call('/v1/capture-status')).json().recovery.failed,1,'failed URL cannot be recorded as recoverable');
  failReadUrl=false;assert.equal((await call(route,body)).statusCode,200);assert.equal((await call('/v1/capture-status')).json().recovery.failed,0);
  const revoked=await app.inject({url:`/v1/capture-sources/${source.json().id}/revoke`,method:'POST',headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"1"'},payload:{}});assert.equal(revoked.statusCode,200,revoked.body);
  assert.equal((await call(route,body)).statusCode,404,'revoked original unavailable');
 }finally{
  if(path)await bucket.remove([path]);await app.close();await db.end();
  await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant]);await tx`delete from auth.users where id=${user}::uuid`;});await admin.end();
 }
});

test('N04 100GB per user is atomic across companies, counts pending originals once, isolates users',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:4}),db=postgres(env.DATABASE_URL!,{max:3});
 const user=randomUUID(),tenant=randomUUID(),other=randomUUID(),session=randomUUID();
 const app=createApp({db,verifyToken:async()=>({userId:user,sessionId:session}),capturePolicy:LOCAL_CAPTURE_POLICY,storage:{async sign(){throw Error('quota must precede signing');},async verify(){throw Error('unused');},async remove(){}}});
 try{
  await admin`insert into auth.users(id) values(${user}::uuid)`;
  await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;
  for(const t of [tenant,other]){await admin`insert into app.tenants(id,display_name) values(${t}::uuid,'N04 quota synthetic')`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${t}::uuid,${user}::uuid,'owner')`;}
  await admin.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${user},true)`;
   await tx`insert into app.upload_intents(tenant_id,actor_id,client_capture_id,idempotency_key,request_hash,claimed_sha256,claimed_byte_length,declared_mime,storage_key)
    select ${tenant}::uuid,${user}::uuid,gen_random_uuid(),gen_random_uuid(),repeat('a',64),lpad(to_hex(i),64,'0'),200000000,'text/plain',${tenant}||'/'||gen_random_uuid()::text from generate_series(1,499) i`;
  });
  const reserve=(t:string,hash:string)=>admin.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${user},true)`;return tx`insert into app.upload_intents(tenant_id,actor_id,client_capture_id,idempotency_key,request_hash,claimed_sha256,claimed_byte_length,declared_mime,storage_key)
   values(${t}::uuid,${user}::uuid,gen_random_uuid(),gen_random_uuid(),repeat('a',64),${hash},120000000,'text/plain',${t}||'/'||gen_random_uuid()::text)`;});
  const result=await Promise.allSettled([reserve(tenant,'b'.repeat(64)),reserve(other,'c'.repeat(64))]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.match(String((result.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/quota reached/);
  const [winner]=await admin`select tenant_id,claimed_sha256 from app.upload_intents where actor_id=${user}::uuid and claimed_byte_length=120000000`;
  await reserve(String(winner!.tenant_id),String(winner!.claimed_sha256));
  await db.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${user},true)`;const [r]=await tx`select app.capture_storage_usage() usage`;assert.equal(r?.usage.reserved_bytes,99920000000);assert.equal(r?.usage.limit_bytes,100000000000);});
  assert.equal((await db`select app.capture_storage_usage() usage`)[0]?.usage.reserved_bytes,0,'no caller identity sees another user usage');
  const blocked=await app.inject({method:'POST',url:'/v1/ingestions',headers:{authorization:'Bearer synthetic','x-tenant-id':tenant,'idempotency-key':randomUUID()},payload:{client_capture_id:randomUUID(),sha256:'d'.repeat(64),byte_length:100000000,declared_mime:'text/plain'}});
  assert.equal(blocked.statusCode,409,blocked.body);assert.equal(blocked.json().error.code,'STORAGE_QUOTA_EXCEEDED');assert.equal(blocked.json().error.retryable,false);
 }finally{await app.close();await db.end();await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant,other]);await tx`delete from auth.users where id=${user}::uuid`;});await admin.end();}
 assert.equal(sourceAllowsMime('folder',null,'image/vnd.dwg'),false);
});
