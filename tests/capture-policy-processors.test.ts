import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {CapturePolicySchema,CaptureSourceCreateRequestSchema,capturePolicyEqual,canonicalCapturePolicy,capturePolicyProcessor,workHttp,type CapturePolicy} from '../packages/contracts/src/index.js';
import {sourcePolicyCurrent} from '../services/api/src/capture-scope.js';
import {createApp} from '../services/api/src/app.js';
import {runLongAudioOnce,type AudioProvider} from '../services/api/src/long-audio.js';
import {readLocalAiConsent} from '../services/api/src/local-journal-sync.js';
import {reserveProductAi,submitProductAi,type ProductReservation} from '../services/api/src/product-ai.js';
import {syntheticAudio} from '../scripts/work-preview-audio.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {deleteFixtureTenants} from './fixture-cleanup.js';

const single:CapturePolicy={id:'synthetic-processors-v1',purpose:'work_records',provider:'anthropic',processing_location:'synthetic primary infrastructure',storage_location:'synthetic source storage',retention:'until_user_deletes',external_processing:true};
const processor={purpose:'long_stt' as const,provider:'openai' as const,processing_location:'synthetic account data region',storage_location:'synthetic provider infrastructure',retention:'synthetic request retention policy'};
const multi:CapturePolicy={...single,processors:[processor]};
const scope={capture_method:'filesystem',history_mode:'all',history_since:null,scope_mode:'work_dedicated',rule_version:1,processing_policy_id:single.id,fingerprint_algorithm:'hmac-sha256-device-v1'};
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

test('explicit processor is channel-scoped, preserves old policies and binds every consent field',()=>{
 assert(CapturePolicySchema.safeParse(single).success);
 assert(CapturePolicySchema.safeParse(multi).success);
 assert.equal(capturePolicyProcessor(single,'long_stt'),undefined);
 assert.equal(capturePolicyProcessor({...single,provider:'openai'},'long_stt')?.provider,'openai');
 assert.equal(capturePolicyProcessor({...single,provider:'clova_speech'},'long_stt')?.provider,'clova_speech');
 assert.equal(capturePolicyProcessor(multi,'long_stt')?.provider,'openai');
 assert.equal(multi.provider,'anthropic','an audio processor never replaces the semantic provider');
 for(const processors of [[],[processor,processor],[{...processor,purpose:'semantic'}],[{...processor,provider:'anthropic'}],[{...processor,retention:''}]])assert.equal(CapturePolicySchema.safeParse({...single,processors}).success,false);
 assert.equal(CapturePolicySchema.safeParse({...multi,external_processing:false}).success,false);
 assert.equal(canonicalCapturePolicy({...multi,unknown:'discard me'}),null,'unknown policy fields are not silently stripped');
 assert(capturePolicyEqual(multi,{processors:[{retention:processor.retention,storage_location:processor.storage_location,processing_location:processor.processing_location,provider:'openai',purpose:'long_stt'}],...single}));
 for(const field of ['provider','processing_location','storage_location','retention'] as const){
  const changed={...processor,[field]:field==='provider'?'clova_speech':'changed'};
  assert.equal(capturePolicyEqual(multi,{...single,processors:[changed]}),false);
 }
 assert.equal(capturePolicyEqual(single,multi),false);
 assert.equal(sourcePolicyCurrent(scope,single,multi),false,'same policy ID with newly added processor requires a new grant');
 assert.equal(sourcePolicyCurrent(scope,JSON.parse(JSON.stringify(multi)),multi),true,'separate nested objects compare by complete content');
 const request={device_id:randomUUID(),kind:'call_recording',scope_fingerprint:'a'.repeat(64),consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:true,scope};
 assert(CaptureSourceCreateRequestSchema.safeParse(request).success,'legacy single-policy request shape remains readable');
 assert.deepEqual(CaptureSourceCreateRequestSchema.parse({...request,processing_policy:multi}).processing_policy,multi);
 const mapped=workHttp({route:'ai.consent',allowed:true,expected_version:0,client_command_id:randomUUID(),processing_policy:multi}).body as {processing_policy?:CapturePolicy}|undefined;
 assert.deepEqual(mapped?.processing_policy,multi);
});

test('G actual source/API/SQL consent gates, OpenAI-shaped STT processing and provider-correct transcript reuse',{skip:process.env.SIGONGNOTE_E2E_DB!=='1'},async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8')),url=new URL(String(env.MIGRATION_DATABASE_URL));
 assert(['127.0.0.1','localhost'].includes(url.hostname)&&/^\/sigongnote_e2e_[a-f0-9]+$/.test(url.pathname));
 const admin=postgres(String(env.MIGRATION_DATABASE_URL),{max:1,onnotice:()=>{}}),runtime=postgres(String(env.DATABASE_URL),{max:3,onnotice:()=>{}}),worker=postgres(String(env.WORKER_DATABASE_URL),{max:1,onnotice:()=>{}});
 const tenant=randomUUID(),foreignTenant=randomUUID(),user=randomUUID(),colleague=randomUUID(),session=randomUUID(),bytesByPath=new Map<string,Buffer>();let device='';
 const services={db:runtime,capturePolicy:multi,agentRuntime:false,verifyToken:async()=>({userId:user,sessionId:session}),storage:{
  async sign(){return 'https://storage.invalid/synthetic?token=synthetic-upload-signature-for-policy-fixture';},
  async verify(path:string,digest:string,length:number){const bytes=bytesByPath.get(path);return {matches:!!bytes&&hash(bytes)===digest&&bytes.length===length,sniffedMime:'audio/wav'};},async remove(){},
 }};
 const app=createApp(services),headers={authorization:'Bearer synthetic','x-tenant-id':tenant};
 const call=(url:string,payload?:object,key=randomUUID())=>app.inject({method:payload?'POST':'GET',url,headers:{...headers,'idempotency-key':key},...(payload?{payload}:{})});
 const actorTx=<T>(fn:(tx:postgres.TransactionSql)=>Promise<T>)=>runtime.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${user},true)`;return fn(tx);});
 const sourceBody=(policy:CapturePolicy|null=multi,external=true)=>({device_id:device,kind:'call_recording',scope_fingerprint:hash(randomUUID()),consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:external,scope,...(policy?{processing_policy:policy}:{})});
 const makeSource=async(external=true)=>{const result=await call('/v1/capture-sources',sourceBody(services.capturePolicy,external));assert.equal(result.statusCode,201,result.body);return result.json();};
 const ingest=async(source:{id:string;generation:number},variant=0)=>{
  const bytes=syntheticAudio();if(variant)bytes.writeInt16LE(variant,44);const digest=hash(bytes);
  const prepared=await call('/v1/ingestions',{client_capture_id:randomUUID(),sha256:digest,byte_length:bytes.length,declared_mime:'audio/wav',source_id:source.id,source_generation:source.generation});assert.equal(prepared.statusCode,201,prepared.body);
  bytesByPath.set(tenant+'/'+prepared.json().ingestion_id,bytes);
  const completed=await call('/v1/ingestions/'+prepared.json().ingestion_id+'/complete',{sha256:digest,byte_length:bytes.length});assert.equal(completed.statusCode,200,completed.body);return completed.json();
 };
 const scopeAllowed=async(source:{id:string;generation:number},revision:string,channel='long_stt',provider='openai',actor=user,company=tenant,policy=multi)=>{
  const [row]=await admin`select app.product_ai_scope_allowed(${company}::uuid,${actor}::uuid,${source.id}::uuid,${source.generation}::bigint,${revision}::uuid,${channel},${admin.json({policy,policy_provider:provider,provider,model:provider==='openai'?'whisper-1':'clova-speech'})}) allowed`;return row!.allowed;
 };
 let submitted=0;
 const provider:AudioProvider={name:'openai',billing:{version:'synthetic-audio-price',model:'whisper-1',krw_per_minute:20,valid_until:'2099-01-01T00:00:00Z'},async submit(){submitted++;return {receipt:'synthetic-openai-shaped-receipt',segments:[{start:0,end:1000,text:'합성 전사 첫 구간'},{start:1000,end:3000,text:'수량과 금액은 확인하지 않았습니다.'}]};},async poll(){throw Error('SYNCHRONOUS_FIXTURE_MUST_NOT_POLL');}};
 const audioOptions={db:worker,policy:multi,tenantScope:tenant,audioProvider:provider,audioTenantSeconds:600,audioGlobalSeconds:1200,
  python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker'),
  async download(input:{storage_key:string}){const bytes=bytesByPath.get(input.storage_key);assert(bytes);return bytes;}};
 try{
  for(const actor of [user,colleague])await admin`insert into auth.users(id) values(${actor}::uuid)`;
  await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;
  for(const company of [tenant,foreignTenant])await admin`insert into app.tenants(id,display_name) values(${company}::uuid,'G synthetic policy company')`;
  await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner'),(${tenant}::uuid,${colleague}::uuid,'operator')`;
  const jwk=generateKeyPairSync('ec',{namedCurve:'P-256'}).publicKey.export({format:'jwk'});
  const registered=await call('/v1/devices',{platform:'windows',app_version:'synthetic-policy',public_key_jwk:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y}});assert.equal(registered.statusCode,201,registered.body);
  device=registered.json().id;
  const [selected]=await admin`select app.capture_policy_processor(${admin.json(multi)},'long_stt') processor,app.capture_policy_processor(${admin.json(single)},'long_stt') absent,app.capture_policy_processor(${admin.json(multi)},'semantic') wrong_purpose`;
  assert.deepEqual(selected!.processor,processor);assert.equal(selected!.absent,null);assert.equal(selected!.wrong_purpose,null);
  assert.equal((await call('/v1/capture-sources',sourceBody(null))).statusCode,410,'new processor cannot be consented by a legacy policy-ID-only command');
  const changed={...single,processors:[{...processor,retention:'different retention'}]};
  assert.equal((await call('/v1/capture-sources',sourceBody(changed))).statusCode,410,'same ID cannot substitute different processor terms');
  services.capturePolicy=single;
  const old=await call('/v1/capture-sources',sourceBody(null));assert.equal(old.statusCode,201,old.body);
  services.capturePolicy=multi;
  assert.equal((await call('/v1/ingestions',{client_capture_id:randomUUID(),sha256:hash(syntheticAudio()),byte_length:syntheticAudio().length,declared_mime:'audio/wav',source_id:old.json().id,source_generation:1})).statusCode,410,'old source is not upgraded to new processor consent');
  const consent=(snapshot?:CapturePolicy,allowed=true,version=0)=>call('/v1/local-journal/ai-consent',{allowed,expected_version:version,client_command_id:randomUUID(),...(snapshot?{processing_policy:snapshot}:{})});
  assert.equal((await consent()).statusCode,410);assert.equal((await consent(changed)).statusCode,410);
  assert.equal((await consent(multi)).statusCode,200);
  assert.equal((await actorTx(tx=>readLocalAiConsent(tx,tenant,user,multi))).allowed,true,'nested processors compare by value');
  assert.equal((await actorTx(tx=>readLocalAiConsent(tx,tenant,user,changed))).allowed,false);
  const currentConsent=await actorTx(tx=>readLocalAiConsent(tx,tenant,user,multi));
  services.capturePolicy=changed;
  assert.equal((await consent(multi,false,currentConsent.version)).statusCode,200,'a changed current policy cannot prevent withdrawal with the prior snapshot');
  const [withdrawn]=await admin`select allowed,processing_policy from app.local_context_consents where tenant_id=${tenant}::uuid and user_id=${user}::uuid`;
  assert.equal(withdrawn!.allowed,false);assert(capturePolicyEqual(withdrawn!.processing_policy,multi),'withdrawal does not adopt the changed processor terms');
  services.capturePolicy=multi;
  const revokedConsent=await actorTx(tx=>readLocalAiConsent(tx,tenant,user,multi));
  assert.equal((await consent(undefined,false,revokedConsent.version)).statusCode,200,'withdrawal without a snapshot also remains available');
  const firstSource=await makeSource(),first=await ingest(firstSource);
  assert(capturePolicyEqual(firstSource.processing_policy,multi));
  assert.equal(await scopeAllowed(firstSource,first.revision_id),true);
  assert.equal(await scopeAllowed(firstSource,first.revision_id,'semantic'),false,'audio OpenAI permission never grants OpenAI semantic processing');
  assert.equal(await scopeAllowed(firstSource,first.revision_id,'long_stt','clova_speech'),false);
  assert.equal(await scopeAllowed(firstSource,first.revision_id,'long_stt','openai',colleague),false);
  assert.equal(await scopeAllowed(firstSource,first.revision_id,'long_stt','openai',user,foreignTenant),false);
  assert.equal(await runLongAudioOnce(audioOptions),'waiting','one new provider upload ends its lease after saving the durable checkpoint');assert.equal(submitted,1);
  const [checkpoint]=await admin`select state from app.audio_work where tenant_id=${tenant}::uuid and job_id=${first.job_id}::uuid`;
  assert.equal(checkpoint!.state.chunks[0].status,'completed');
  await admin`update app.jobs set available_at=now() where tenant_id=${tenant}::uuid and id=${first.job_id}::uuid and state='retry_wait'`;
  assert.equal(await runLongAudioOnce(audioOptions),'stored','the next worker lease publishes the saved synchronous result');assert.equal(submitted,1,'checkpoint resume does not submit again');
  const [usage]=await admin`select config from app.product_ai_usage where tenant_id=${tenant}::uuid and channel='long_stt'`;assert(capturePolicyEqual(usage!.config.policy,multi));assert.equal(usage!.config.policy_provider,'openai');
  const copied=await ingest(firstSource);assert.equal(await runLongAudioOnce(audioOptions),'stored');assert.equal(submitted,1,'same-provider immutable transcript is reused with an Anthropic primary policy');
  const [copiedState]=await admin`select state from app.audio_work where tenant_id=${tenant}::uuid and job_id=${copied.job_id}::uuid`;assert.equal(copiedState!.state.provider,'openai');
  const withoutAi=await makeSource(false),withoutAiRevision=await ingest(withoutAi,1);assert.equal(await scopeAllowed(withoutAi,withoutAiRevision.revision_id),false);
  assert.equal(await runLongAudioOnce(audioOptions),'held');assert.equal(submitted,1,'upload consent alone never submits audio');
  const revoked=await makeSource(),revokedRevision=await ingest(revoked,2);
  const reservation:ProductReservation={tenant,user,source:revoked.id,generation:revoked.generation,revision:revokedRevision.revision_id,id:randomUUID(),channel:'long_stt',hash:hash('synthetic reservation'),krw:1,config:{policy:multi,policy_provider:'openai',provider:'openai',model:'whisper-1'}};
  assert.equal((await reserveProductAi(worker,reservation)).state,'reserved');
  await admin`update app.capture_sources set external_ai_consent=false where tenant_id=${tenant}::uuid and id=${revoked.id}::uuid`;
  assert.equal(await submitProductAi(worker,reservation),false,'consent is rechecked after reservation, before a provider can be called');
  assert.equal(await scopeAllowed(revoked,revokedRevision.revision_id),false);
  const stale=await makeSource(),staleRevision=await ingest(stale,3);await admin`update app.capture_sources set generation=generation+1 where tenant_id=${tenant}::uuid and id=${stale.id}::uuid`;
  assert.equal(await scopeAllowed(stale,staleRevision.revision_id),false);
  const inactive=await makeSource(),inactiveRevision=await ingest(inactive,4);
  const stopped=await app.inject({method:'POST',url:'/v1/capture-sources/'+inactive.id+'/revoke',headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"'+inactive.version+'"'},payload:{}});
  assert.equal(stopped.statusCode,200,stopped.body);assert.equal(stopped.json().active,false);assert(stopped.json().generation>inactive.generation);
  assert.equal(await scopeAllowed(inactive,inactiveRevision.revision_id),false);
  const [currentDevice]=await admin`select version from app.devices where tenant_id=${tenant}::uuid and id=${device}::uuid`;
  const stoppedDevice=await app.inject({method:'POST',url:'/v1/devices/'+device+'/revoke',headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"'+currentDevice!.version+'"'},payload:{}});
  assert.equal(stoppedDevice.statusCode,200,stoppedDevice.body);assert.equal(stoppedDevice.json().active,false);
  assert.equal(await scopeAllowed(firstSource,first.revision_id),false);assert.equal(submitted,1);
 }finally{
  await app.close();await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant,foreignTenant]);await tx`delete from auth.sessions where user_id in (${user}::uuid,${colleague}::uuid)`;await tx`delete from auth.users where id in (${user}::uuid,${colleague}::uuid)`;});await Promise.all([runtime.end(),worker.end(),admin.end()]);
 }
});
