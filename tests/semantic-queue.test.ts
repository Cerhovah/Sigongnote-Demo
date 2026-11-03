import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {createApp} from '../services/api/src/app.js';
import {runParseOnce} from '../services/api/src/parse-worker.js';
import {reserveProductAi,submitProductAi,finishProductAi,type ProductReservation} from '../services/api/src/product-ai.js';
import type {CapturePolicy} from '../services/api/src/capture-scope.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {deleteFixtureTenants} from './fixture-cleanup.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const modelKey=hash('synthetic-queue-model');
type Fixture={tenant:string;user:string;session:string;device:string;source:string;revision:string;job:string};

async function queueDatabase(){
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
 const api=postgres(env.DATABASE_URL!,{max:2}),worker=postgres(env.WORKER_DATABASE_URL!,{max:2});
 const fixtures:Fixture[]=[];
 // A unique local policy isolates the global queue selection from every other test/account.
 const policy:CapturePolicy={id:`n03-queue-${randomUUID()}`,purpose:'work_records',provider:'openai',processing_location:'provider_cloud',storage_location:'development_computer',retention:'until_user_deletes',external_processing:true};
 const config={policy,policy_provider:'openai',provider:'openai'};
 const createFixture=async()=>{
  const fixture:Fixture={tenant:randomUUID(),user:randomUUID(),session:randomUUID(),device:randomUUID(),source:randomUUID(),revision:'',job:''};fixtures.push(fixture);
  const {tenant,user,session,device,source}=fixture;
  await admin`insert into auth.users(id) values(${user}::uuid)`;
  await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;
  await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'N03 queue synthetic')`;
  await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
  await admin`insert into app.devices(tenant_id,id,user_id,platform,public_key_jwk,public_key_sha256,app_version,registration_key,registration_hash) values(${tenant}::uuid,${device}::uuid,${user}::uuid,'windows','{}',${hash(device)},'test',${randomUUID()}::uuid,${hash('registration')})`;
  const scope={capture_method:'filesystem',history_mode:'all',history_since:null,scope_mode:'work_dedicated',rule_version:1,fingerprint_algorithm:'hmac-sha256-device-v1',processing_policy_id:policy.id};
  await admin`insert into app.capture_sources(tenant_id,id,user_id,device_id,kind,capability,scope_fingerprint,local_selection_consent,server_upload_consent,external_ai_consent,consent_version,scope,processing_policy) values(${tenant}::uuid,${source}::uuid,${user}::uuid,${device}::uuid,'folder','passive',${hash(source)},true,true,true,2,${admin.json(scope)},${admin.json(policy)})`;
  const bytes=Buffer.from('합성 석고보드 요청. 인수 미확인.'),digest=hash(bytes.toString());
  const app=createApp({db:api,capturePolicy:policy,verifyToken:async()=>({userId:user,sessionId:session}),storage:{async sign(){return 'https://storage.invalid/synthetic?token=synthetic-opaque-upload-signature';},async verify(){return {matches:true,sniffedMime:'text/plain'};},async remove(){}}});
  const call=(url:string,payload:object)=>app.inject({method:'POST',url,headers:{authorization:'Bearer synthetic','x-tenant-id':tenant,'idempotency-key':randomUUID()},payload});
  try{
   // API auth sets claim.sub for the N04 upload-intent quota trigger as in production.
   const prepared=await call('/v1/ingestions',{client_capture_id:randomUUID(),source_id:source,source_generation:1,sha256:digest,byte_length:bytes.length,declared_mime:'text/plain'});assert.equal(prepared.statusCode,201,prepared.body);
   const completed=await call(`/v1/ingestions/${prepared.json().ingestion_id}/complete`,{sha256:digest,byte_length:bytes.length});assert.equal(completed.statusCode,200,completed.body);
   fixture.revision=completed.json().revision_id;fixture.job=completed.json().job_id;
   assert.equal(await runParseOnce({db:worker,policy,tenantScope:tenant,python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker'),download:async()=>bytes}),'stored');
  }finally{await app.close();}
  return fixture;
 };
 const next=async(headroom:number,deferred:string[]=[],tenant:string|null=null)=>{
  const [row]=await worker`select app.next_semantic_input(${worker.json(policy)},${modelKey},${tenant}::uuid,${headroom}::bigint,${deferred}::uuid[]) value`;
  return row?.value;
 };
 const reservation=(fixture:Fixture,krw:number):ProductReservation=>({tenant:fixture.tenant,user:fixture.user,source:fixture.source,generation:1,revision:fixture.revision,id:randomUUID(),channel:'semantic',hash:hash(randomUUID()),config,krw});
 const cleanup=async()=>{
  try{await admin.begin(async tx=>{await deleteFixtureTenants(tx,fixtures.map(f=>f.tenant));for(const fixture of fixtures){await tx`delete from auth.sessions where user_id=${fixture.user}::uuid`;await tx`delete from auth.users where id=${fixture.user}::uuid`;}});}
  finally{await Promise.all([admin.end(),api.end(),worker.end()]);}
 };
 return {admin,api,worker,config,createFixture,next,reservation,cleanup};
}

test('N03 semantic queue skips an underfunded or deferred head across independent users',async()=>{
 const db=await queueDatabase();
 try{
  const older=await db.createFixture(),newer=await db.createFixture();
  assert.notEqual(older.user,newer.user);assert.notEqual(older.tenant,newer.tenant);
  await db.admin`update app.jobs set created_at=now()-interval '2 minutes' where tenant_id=${older.tenant}::uuid and id=${older.job}::uuid`;
  await db.admin`update app.jobs set created_at=now()-interval '1 minute' where tenant_id=${newer.tenant}::uuid and id=${newer.job}::uuid`;
  assert.equal((await db.next(100)).index_job,newer.job,'newest otherwise eligible job is the queue head');
  // The worker defers an invalid-input job for a bounded interval without modifying its evidence.
  assert.equal((await db.next(100,[newer.job])).index_job,older.job,'a deferred malformed head must not pin the independent queue');
  assert.equal(await db.next(100,[newer.job,older.job]),null);
  const spent=db.reservation(newer,9950);
  assert.equal((await reserveProductAi(db.worker,spent)).state,'reserved');assert.equal(await submitProductAi(db.worker,spent),true);
  assert.equal(await finishProductAi(db.worker,spent,9950,null,'synthetic-spent',{input_tokens:0,output_tokens:0}),true);
  assert.equal((await db.next(1)).index_job,newer.job,'remaining 50 KRW can satisfy a one-KRW probe');
  const selected=await db.next(100);
  assert.equal(selected.index_job,older.job);assert.equal(selected.user,older.user);assert.equal(selected.tenant,older.tenant);
  assert.equal(await db.next(100,[older.job]),null,'budget-paused work cannot bypass required headroom');
  assert.equal((await db.next(100,[],newer.tenant)),null,'tenant filter does not borrow another account budget');
 }finally{await db.cleanup();}
});

test('N03 retention clears quoted results; withdrawal and revision purge preserve accounting',async()=>{
 const db=await queueDatabase();
 try{
  const fixture=await db.createFixture(),reservation=db.reservation(fixture,100);
  assert.equal((await reserveProductAi(db.worker,reservation)).state,'reserved');assert.equal(await submitProductAi(db.worker,reservation),true);
  const quoted={claims:[{quote:'합성 석고보드 요청',evidenceLocator:'section:0'}]};
  assert.equal(await finishProductAi(db.worker,reservation,50,quoted,'synthetic-quote',{input_tokens:0,output_tokens:0}),true);
  const allowed=async()=> (await db.worker`select app.product_ai_scope_allowed(${fixture.tenant}::uuid,${fixture.user}::uuid,${fixture.source}::uuid,1,${fixture.revision}::uuid,'semantic',${db.worker.json(db.config)}) ok`)[0]?.ok;
  const visible=async()=>db.api.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${fixture.user},true)`;return tx`select result from app.product_ai_usage where tenant_id=${fixture.tenant}::uuid and id=${reservation.id}::uuid`;});
  assert.equal(await allowed(),true);assert.equal((await visible())[0]?.result.claims[0].quote,quoted.claims[0]!.quote);
  await db.admin`insert into app.evidence_retention_tasks(tenant_id,revision_id,source_id,source_generation) values(${fixture.tenant}::uuid,${fixture.revision}::uuid,${fixture.source}::uuid,1)`;
  const [withdrawn]=await db.admin`select result,evidence_withdrawn,state,actual_krw from app.product_ai_usage where tenant_id=${fixture.tenant}::uuid and id=${reservation.id}::uuid`;
  assert.equal(withdrawn?.result,null);assert.equal(withdrawn?.evidence_withdrawn,true);assert.equal(withdrawn?.state,'settled');assert.equal(withdrawn?.actual_krw,'50');
  assert.equal(await allowed(),false);assert.equal((await visible()).length,0);
  assert.equal((await reserveProductAi(db.worker,reservation)).state,'scope_blocked','settled cache cannot bypass evidence withdrawal');
  assert.equal(await db.next(100,[],fixture.tenant),null);
  // A bare historical revision has no job/index/retention dependents: isolate the budget FK.
  const bareRevision=randomUUID(),historicalUsage=randomUUID();
  await db.admin`insert into app.document_revisions(tenant_id,id,document_id,revision_number,blob_id,declared_mime)
   select tenant_id,${bareRevision}::uuid,document_id,revision_number+1,blob_id,declared_mime from app.document_revisions where tenant_id=${fixture.tenant}::uuid and id=${fixture.revision}::uuid`;
  await db.admin`insert into app.product_ai_usage(tenant_id,user_id,id,channel,source_id,source_generation,revision_id,request_hash,config,state,reserved_krw,actual_krw,evidence_withdrawn)
   values(${fixture.tenant}::uuid,${fixture.user}::uuid,${historicalUsage}::uuid,'semantic',${fixture.source}::uuid,1,${bareRevision}::uuid,${hash(historicalUsage)},${db.admin.json(db.config)},'settled',100,75,true)`;
  await db.admin`delete from app.document_revisions where tenant_id=${fixture.tenant}::uuid and id=${bareRevision}::uuid`;
  const [retained]=await db.admin`select tenant_id,user_id,revision_id,state,actual_krw from app.product_ai_usage where tenant_id=${fixture.tenant}::uuid and id=${historicalUsage}::uuid`;
  assert.equal(retained?.tenant_id,fixture.tenant);assert.equal(retained?.user_id,fixture.user);assert.equal(retained?.revision_id,null);
  assert.equal(retained?.state,'settled');assert.equal(retained?.actual_krw,'75');
  const summary=await db.api.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${fixture.user},true)`;return tx`select app.product_ai_summary() value`;});
  assert.equal(summary[0]?.value.daily_krw,'125','withdrawal and purging do not refund spent provider budget');
 }finally{await db.cleanup();}
});
