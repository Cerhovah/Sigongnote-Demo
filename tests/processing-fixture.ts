import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {createApp} from '../services/api/src/app.js';
import {runParseOnce} from '../services/api/src/parse-worker.js';
import type {ProductReservation} from '../services/api/src/product-ai.js';
import type {CapturePolicy} from '../services/api/src/capture-scope.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {deleteFixtureTenants} from './fixture-cleanup.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const modelKey=hash('synthetic-queue-model');
type Fixture={tenant:string;user:string;session:string;device:string;source:string;revision:string;job:string};

export async function processingFixture(databaseName?:string,policyProvider:'openai'|'anthropic'='openai'){
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8'));
 if(databaseName){
  if(!/^sigongnote_drill_seed_[a-f0-9]{32}$/.test(databaseName))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  for(const key of ['MIGRATION_DATABASE_URL','DATABASE_URL','WORKER_DATABASE_URL']){const url=new URL(env[key]!);url.pathname='/'+databaseName;env[key]=url.href;}
 }
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
 const api=postgres(env.DATABASE_URL!,{max:2}),worker=postgres(env.WORKER_DATABASE_URL!,{max:2});
 const fixtures:Fixture[]=[];
 // A unique local policy isolates the global queue selection from every other test/account.
 const policy:CapturePolicy={id:`n03-queue-${randomUUID()}`,purpose:'work_records',provider:policyProvider,processing_location:'provider_cloud',storage_location:'development_computer',retention:'until_user_deletes',external_processing:true};
 const config={policy,policy_provider:policyProvider,provider:policyProvider};
 const createFixture=async(text='합성 석고보드 요청. 인수 미확인.')=>{
  const fixture:Fixture={tenant:randomUUID(),user:randomUUID(),session:randomUUID(),device:randomUUID(),source:randomUUID(),revision:'',job:''};fixtures.push(fixture);
  const {tenant,user,session,device,source}=fixture;
  await admin`insert into auth.users(id) values(${user}::uuid)`;
  await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;
  await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'N03 queue synthetic')`;
  await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
  await admin`insert into app.devices(tenant_id,id,user_id,platform,public_key_jwk,public_key_sha256,app_version,registration_key,registration_hash) values(${tenant}::uuid,${device}::uuid,${user}::uuid,'windows','{}',${hash(device)},'test',${randomUUID()}::uuid,${hash('registration')})`;
  const scope={capture_method:'filesystem',history_mode:'all',history_since:null,scope_mode:'work_dedicated',rule_version:1,fingerprint_algorithm:'hmac-sha256-device-v1',processing_policy_id:policy.id};
  await admin`insert into app.capture_sources(tenant_id,id,user_id,device_id,kind,capability,scope_fingerprint,local_selection_consent,server_upload_consent,external_ai_consent,consent_version,scope,processing_policy) values(${tenant}::uuid,${source}::uuid,${user}::uuid,${device}::uuid,'folder','passive',${hash(source)},true,true,true,2,${admin.json(scope)},${admin.json(policy)})`;
  const bytes=Buffer.from(text),digest=hash(bytes.toString());
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

