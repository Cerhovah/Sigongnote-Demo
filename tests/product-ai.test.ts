import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {productAiConfig,tokenCostKrw,type ProductAiConfig} from '../services/api/src/product-ai-config.js';
import {semanticRequest,callSemantic,SemanticInvalidOutput} from '../services/api/src/semantic-provider.js';
import {reserveProductAi,submitProductAi,finishProductAi,runSemantic,type ProductReservation} from '../services/api/src/product-ai.js';
import {runSemanticOnce} from '../services/api/src/semantic-worker.js';
import type {ClaimInput} from '../packages/domain/src/claims.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {deleteFixtureTenants} from './fixture-cleanup.js';
import {createApp} from '../services/api/src/app.js';
import {runParseOnce} from '../services/api/src/parse-worker.js';
const price={version:'test-v1',provider:'openai' as const,model:'gpt-6.1-sol',input_krw_per_million:5500,output_krw_per_million:22000,valid_until:'2099-01-01T00:00:00Z',conversion_note:'test conversion'};
const config:ProductAiConfig={provider:'openai',model:price.model,key:'synthetic-key-never-sent',price,maxOutputTokens:4096};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function input():ClaimInput{const revisionId=randomUUID();return {tenantId:randomUUID(),revisionId,sourceHash:hash('source'),parserVersion:'text/1',promptVersion:'candidate-evidence-v1',schemaVersion:'model-claims-v1',tradePackVersion:'construction-v1',scopeFingerprint:hash('scope'),sourceGeneration:1,externalAiConsent:true,spans:[{revisionId,locator:'section:0',kind:'text',text:'석고보드 12개 요청, 인수 여부 미확인'}]};}
function output(){return {modelRunId:randomUUID(),claims:[{predicate:'requested_quantity',value:{kind:'quantity',value:'12',unitCode:'ea',semantic:'ordered'},speechKind:'request',quote:'석고보드 12개 요청',evidenceLocator:'section:0',confidence:0.9}],candidateLinks:[],uncertainties:[{code:'receipt_unknown',evidenceLocator:null}],evidenceLocators:['section:0']};}
function reply(value=output()){return new Response(JSON.stringify({id:'resp_synthetic',model:config.model,usage:{input_tokens:1200,output_tokens:200},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}),{status:200});}
test('N03 explicit provider price, strict wire schema, masking and forged evidence rejection',async()=>{
 assert.equal(productAiConfig({}),undefined);assert.equal(productAiConfig({SEMANTIC_API_KEY:'not-complete'}),undefined);
 assert.throws(()=>productAiConfig({SEMANTIC_PROVIDER:'openai',SEMANTIC_MODEL:config.model,SEMANTIC_API_KEY:config.key,SEMANTIC_PRICE_JSON:JSON.stringify({...price,valid_until:'2000-01-01T00:00:00Z'})}),/PRICE_INVALID/);
 assert.equal(tokenCostKrw(price,1200,200),11);
 const request=semanticRequest(input(),config),body=JSON.parse(request.serialized);
 assert.equal(body.store,false);assert.equal(body.service_tier,'default');assert.equal(body.reasoning.effort,'low');assert.equal(body.tools,undefined);
 assert.deepEqual(body.text.format.schema.properties.uncertainties.items.required,['code','evidenceLocator']);
 assert.ok(!JSON.stringify(body.text.format.schema).includes('"oneOf"'));
 let calls=0;const result=await callSemantic(input(),config,AbortSignal.timeout(1000),(async()=>{calls++;return reply();}) as typeof fetch);
 assert.equal(result.value.claims[0]?.speechKind,'request');assert.equal(calls,1);
 const forged=output();forged.claims[0]!.quote='인수 완료 12개';
 await assert.rejects(callSemantic(input(),config,AbortSignal.timeout(1000),(async()=>reply(forged)) as typeof fetch),error=>error instanceof SemanticInvalidOutput&&error.inputTokens===1200&&error.outputTokens===200&&error.receipt==='resp_synthetic');
 const incomplete=await reply().json();incomplete.status='incomplete';incomplete.incomplete_details={reason:'max_output_tokens'};
 await assert.rejects(callSemantic(input(),config,AbortSignal.timeout(1000),(async()=>new Response(JSON.stringify(incomplete))) as typeof fetch),SemanticInvalidOutput);
 const malformed=await reply().json();malformed.output[0].content[0].text='{';
 await assert.rejects(callSemantic(input(),config,AbortSignal.timeout(1000),(async()=>new Response(JSON.stringify(malformed))) as typeof fetch),SemanticInvalidOutput);
});

test('N03 user budget is atomic across companies, KST periods, unknown cost held and API RLS',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}}),worker=postgres(env.WORKER_DATABASE_URL!,{max:5}),api=postgres(env.DATABASE_URL!,{max:1});
 const user=randomUUID(),tenants=[randomUUID(),randomUUID()];
 try{
  await admin`insert into auth.users(id) values(${user}::uuid)`;
  for(const tenant of tenants){await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'N03 synthetic')`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;await admin`insert into app.voice_consents(tenant_id,user_id,provider_version,allowed) values(${tenant}::uuid,${user}::uuid,'short-voice-v1',true)`;}
  const rows=await admin`select tenant_id,(extract(epoch from updated_at)*1000000)::bigint::text generation from app.voice_consents where user_id=${user}::uuid`;
  const reservation=(tenant:string=tenants[0]!,krw=5000):ProductReservation=>({tenant,user,id:randomUUID(),channel:'short_stt',source:null,generation:null,revision:null,hash:hash('audio'),config:{consent_generation:rows.find(r=>r.tenant_id===tenant)!.generation},krw});
  const attempts=[reservation(),reservation(tenants[1]),reservation()];
  const results=await Promise.all(attempts.map(r=>reserveProductAi(worker,r)));
  assert.equal(results.filter(r=>r.state==='reserved').length,2);assert.equal(results.filter(r=>r.state==='budget_paused').length,1);
  const selected=attempts[results.findIndex(r=>r.state==='reserved')]!;
  assert.equal(await submitProductAi(worker,selected),true);assert.equal(await submitProductAi(worker,selected),false);
  await finishProductAi(worker,selected,null,null,null,{error_code:'TIMEOUT'});
  await admin`update app.product_ai_usage set created_at=now()-interval '40 days',submitted_at=now()-interval '40 days' where user_id=${user}::uuid`;
  assert.equal((await reserveProductAi(worker,reservation(tenants[0],1))).state,'budget_paused');
  // Settled past-month calls do not consume this month. Unknown calls do.
  await admin`update app.product_ai_usage set state='settled',actual_krw=reserved_krw where user_id=${user}::uuid`;
  assert.equal((await reserveProductAi(worker,reservation(tenants[0],10000))).state,'reserved');
  await admin`update app.product_ai_usage set state='settled',actual_krw=reserved_krw,submitted_at=date_trunc('month',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' where user_id=${user}::uuid`;
  const existing=attempts[0]!;
  // Five settled 10k units in the current month pause a new request even after a new day.
  await admin`update app.product_ai_usage set actual_krw=20000 where user_id=${user}::uuid`;
  assert.equal((await reserveProductAi(worker,reservation(existing.tenant,1))).state,'budget_paused');
  const [clock]=await admin`select extract(hour from date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' at time zone 'UTC')::int h`;assert.equal(clock?.h,15);
  assert.equal((await api`select * from app.product_ai_usage`).length,0);await assert.rejects(worker`select * from app.product_ai_usage`,/permission denied/);
  await admin`update app.voice_consents set allowed=false,updated_at=clock_timestamp() where user_id=${user}::uuid`;
  assert.equal((await reserveProductAi(worker,reservation())).state,'scope_blocked');
  await admin`update app.voice_consents set allowed=true,updated_at=clock_timestamp() where user_id=${user}::uuid`;
  assert.equal((await reserveProductAi(worker,reservation())).state,'scope_blocked');
 }finally{await admin.begin(async tx=>{await deleteFixtureTenants(tx,tenants);await tx`delete from auth.users where id=${user}::uuid`;});await Promise.all([admin.end(),worker.end(),api.end()]);}
});

test('N03 parser job → candidate provider → durable cache; crash/withdrawal never resubmit',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}}),db=postgres(env.DATABASE_URL!,{max:2}),worker=postgres(env.WORKER_DATABASE_URL!,{max:4});
 const tenant=randomUUID(),user=randomUUID(),session=randomUUID(),device=randomUUID(),source=randomUUID();
 const policy={id:'n03-test',purpose:'work_records' as const,provider:'openai',processing_location:'provider_cloud',storage_location:'development_computer',retention:'until_user_deletes' as const,external_processing:true};
 const bytes=Buffer.from('석고보드 12개 요청, 인수 여부 미확인'),digest=hash(bytes.toString());
 const app=createApp({db,capturePolicy:policy,verifyToken:async()=>({userId:user,sessionId:session}),storage:{async sign(){return 'https://storage.invalid/synthetic?token=synthetic-opaque-upload-signature';},async verify(){return {matches:true,sniffedMime:'text/plain'};},async remove(){}}});
 const call=(url:string,payload:object)=>app.inject({method:'POST',url,headers:{authorization:'Bearer synthetic','x-tenant-id':tenant,'idempotency-key':randomUUID()},payload});
 try{
  await admin`insert into auth.users(id) values(${user}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;
  await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'N03 synthetic')`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
  await admin`insert into app.devices(tenant_id,id,user_id,platform,public_key_jwk,public_key_sha256,app_version,registration_key,registration_hash) values(${tenant}::uuid,${device}::uuid,${user}::uuid,'windows','{}',${hash(device)},'test',${randomUUID()}::uuid,${hash('registration')})`;
  const scope={capture_method:'filesystem',history_mode:'all',history_since:null,scope_mode:'work_dedicated',rule_version:1,fingerprint_algorithm:'hmac-sha256-device-v1',processing_policy_id:policy.id};
  await admin`insert into app.capture_sources(tenant_id,id,user_id,device_id,kind,capability,scope_fingerprint,local_selection_consent,server_upload_consent,external_ai_consent,consent_version,scope,processing_policy) values(${tenant}::uuid,${source}::uuid,${user}::uuid,${device}::uuid,'folder','passive',${hash('scope')},true,true,true,2,${admin.json(scope)},${admin.json(policy)})`;
  const prepared=await call('/v1/ingestions',{client_capture_id:randomUUID(),source_id:source,source_generation:1,sha256:digest,byte_length:bytes.length,declared_mime:'text/plain'});assert.equal(prepared.statusCode,201,prepared.body);
  const completed=await call(`/v1/ingestions/${prepared.json().ingestion_id}/complete`,{sha256:digest,byte_length:bytes.length});assert.equal(completed.statusCode,200,completed.body);
  const revision=completed.json().revision_id;
  assert.equal(await runParseOnce({db:worker,policy,tenantScope:tenant,python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker'),download:async()=>bytes}),'stored');
  let calls=0;const transport=(async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body)),data=JSON.parse(body.input);
   if(Array.isArray(data))return reply();
   const c=data.chunks[0];const value={schemaVersion:data.schemaVersion,modelVersion:data.modelVersion,promptVersion:data.promptVersion,candidates:[{key:'request_1',eventKind:'request',actor:null,subject:{kind:'item_type',mention:'석고보드',role:null},predicate:'requested_quantity',object:null,quantity:{value:'12',unitCode:'ea'},amount:null,effectiveAt:null,assertion:{polarity:'positive',modality:'actual',speech:'direct',speaker:null},evidence:[{indexJobId:data.indexJobId,ordinal:c.ordinal,contentHash:c.contentHash,locator:c.locator,quote:'석고보드 12개 요청'}],uncertaintyReasons:[]}]};
   return new Response(JSON.stringify({id:'resp_synthetic',status:'completed',usage:{input_tokens:1200,output_tokens:200},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}));}) as typeof fetch;
  const options={db:worker,policy,tenantScope:tenant,semantic:config,transport};
  const results=await Promise.all([runSemanticOnce(options),runSemanticOnce(options)]);assert.ok(results.includes('stored'),results.join(','));assert.equal(calls,1);
  assert.equal(await runSemanticOnce(options),'idle');
  const promoted=await admin`select semantic from app.fact_candidates where tenant_id=${tenant}::uuid and semantic is not null`;assert.equal(promoted.length,1);assert.equal(promoted[0]?.semantic.eventKind,'request');
  const [stored]=await admin`select * from app.product_ai_usage where tenant_id=${tenant}::uuid`;assert.equal(stored?.state,'settled');assert.equal(stored?.actual_krw,'11');assert.equal(stored?.result.semanticCandidates.candidates[0].eventKind,'request');
  const claim={...input(),tenantId:tenant,revisionId:revision,sourceHash:digest};const productScope={tenant,user,source,generation:1,revision};
  const trace={policy,policy_provider:'openai',purpose:'direct-test'};
  const first=await runSemantic(worker,productScope,claim,config,trace,AbortSignal.timeout(1000),transport);assert.equal(first.state,'candidate');
  const cached=await runSemantic(worker,productScope,claim,config,trace,AbortSignal.timeout(1000),transport);assert.equal(cached.state,'cached');assert.equal(calls,2);
  const forged=output();forged.claims[0]!.quote='인수 완료 12개';let invalidCalls=0;
  const invalidTransport=(async()=>{invalidCalls++;return reply(forged);}) as typeof fetch,invalidTrace={...trace,purpose:'forged'};
  const rejected=await runSemantic(worker,productScope,claim,config,invalidTrace,AbortSignal.timeout(1000),invalidTransport);assert.equal(rejected.state,'rejected');assert.equal(rejected.value,null);
  const [invalidRow]=await admin`select state,actual_krw,result,receipt,usage from app.product_ai_usage where tenant_id=${tenant}::uuid and id=${rejected.runId}::uuid`;
  assert.equal(invalidRow?.state,'settled');assert.equal(invalidRow?.actual_krw,'11');assert.equal(invalidRow?.result,null);assert.equal(invalidRow?.receipt,'resp_synthetic');assert.equal(invalidRow?.usage.error_code,'MODEL_RESPONSE_INVALID');
  assert.equal((await runSemantic(worker,productScope,claim,config,invalidTrace,AbortSignal.timeout(1000),invalidTransport)).state,'rejected');assert.equal(invalidCalls,1);
  const timeout=(async()=>{calls++;throw Error('synthetic connection lost');}) as typeof fetch;
  assert.equal((await runSemantic(worker,productScope,claim,config,{...trace,purpose:'timeout'},AbortSignal.timeout(1000),timeout)).state,'unknown');
  assert.equal((await runSemantic(worker,productScope,claim,config,{...trace,purpose:'timeout'},AbortSignal.timeout(1000),timeout)).state,'unknown');assert.equal(calls,3);
  await admin`update app.capture_sources set external_ai_consent=false where tenant_id=${tenant}::uuid and id=${source}::uuid`;
  assert.equal((await runSemantic(worker,productScope,claim,config,trace,AbortSignal.timeout(1000),transport)).state,'scope_blocked');assert.equal(calls,3);
  assert.equal((await admin`select count(*)::int n from app.product_ai_usage where tenant_id=${tenant}::uuid and result is not null`)[0]?.n,0);
 }finally{await app.close();await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant]);await tx`delete from auth.sessions where user_id=${user}::uuid`;await tx`delete from auth.users where id=${user}::uuid`;});await Promise.all([db.end(),worker.end(),admin.end()]);}
});
