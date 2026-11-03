import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {createApp} from '../services/api/src/app.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {maskSensitive} from '../packages/domain/src/claims.js';
import {requestTokenBound} from '../services/local-agent/src/ai.js';
import {reportCsv} from '../services/local-agent/src/field-bridge.js';
import {searchEvidence} from '../services/api/src/evidence-search.js';
import {deleteFixtureTenants} from './fixture-cleanup.js';
test('field money masking preserves business amounts and masks contextual identity numbers',()=>{
 assert.equal(maskSensitive('금액 150000원, 세금포함 150,000원'),'금액 150000원, 세금포함 150,000원');
 assert.doesNotMatch(maskSensitive('계좌: 12345678901 전화: 010-1234-5678'),/12345678901|010-1234/);
 assert(requestTokenBound({input:'한글'})>Buffer.byteLength('한글'));
 const csv=reportCsv({generated_at:'2026-09-29T00:00:00Z',events:[{user_id:'test',task_id:'=1+1',actor:'agent_test',received_at:'2026-09-29T00:00:00Z',control_id:'answer',active_ms:0,app_version:'0.1.0'}]});
 assert.match(csv,/'=1\+1/);assert.match(csv,/09:00:00/);assert.match(csv,/agent_test/);
});
test('field handoff authenticates source, deduplicates evidence, stores versioned answers and denies operator impersonation',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8')),admin=postgres(String(env.MIGRATION_DATABASE_URL),{max:1}),runtime=postgres(String(env.DATABASE_URL),{max:3});
 const owner=randomUUID(),outsider=randomUUID(),operator=randomUUID(),colleague=randomUUID(),sessions=[randomUUID(),randomUUID(),randomUUID(),randomUUID()],tenant=randomUUID(),foreignTenant=randomUUID(),device=randomUUID(),source=randomUUID(),project=randomUUID();let originalReads=0;
 const app=createApp({db:runtime,verifyToken:async token=>({userId:token==='outsider'?outsider:token==='operator'?operator:token==='colleague'?colleague:owner,sessionId:token==='outsider'?String(sessions[1]):token==='operator'?String(sessions[2]):token==='colleague'?String(sessions[3]):String(sessions[0])}),storage:{sign:async()=>{throw Error('Field metadata must not upload originals');},verify:async()=>{throw Error('Field metadata must not verify server bytes');},remove:async()=>{},readUrl:async()=>{originalReads++;throw Error('Device-only original must remain unavailable');}}});
 const headers={authorization:'Bearer owner','x-tenant-id':tenant};
 try{
 await admin.begin(async tx=>{
  for(const [i,id] of [owner,outsider,operator,colleague].entries()){await tx`insert into auth.users(id) values(${id}::uuid)`;await tx`insert into auth.sessions(id,user_id) values(${String(sessions[i])}::uuid,${id}::uuid)`;}
  await tx`insert into app.tenants(id,display_name) values(${tenant}::uuid,'Field automated verification')`;
  await tx`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${owner}::uuid,'owner')`;
  await tx`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${colleague}::uuid,'operator')`;
  await tx`insert into app.tenants(id,display_name) values(${foreignTenant}::uuid,'Field foreign synthetic company')`;await tx`insert into app.memberships(tenant_id,user_id,role) values(${foreignTenant}::uuid,${outsider}::uuid,'owner')`;
  await tx`insert into app.projects(tenant_id,id,display_name) values(${tenant}::uuid,${project}::uuid,'검증 현장')`;
  await tx`insert into app.devices(tenant_id,id,user_id,platform,public_key_jwk,public_key_sha256,app_version,registration_key,registration_hash)
   values(${tenant}::uuid,${device}::uuid,${owner}::uuid,'windows','{}'::jsonb,${'a'.repeat(64)},'0.1.0',${randomUUID()}::uuid,${'a'.repeat(64)})`;
  await tx`insert into app.capture_sources(tenant_id,id,device_id,user_id,kind,capability,scope_fingerprint,local_selection_consent,server_upload_consent,external_ai_consent,consent_version)
   values(${tenant}::uuid,${source}::uuid,${device}::uuid,${owner}::uuid,'folder','passive',${'b'.repeat(64)},true,true,false,1)`;
  await tx`insert into app.field_operators(user_id) values(${operator}::uuid)`;await tx`insert into app.field_observation_grants(tenant_id,operator_id,consent_version) values(${tenant}::uuid,${operator}::uuid,1)`;
 });
 const body={source_id:source,source_generation:1,local_document_id:randomUUID(),local_revision:1,sha256:'c'.repeat(64),byte_length:123,parser_version:'test/1',parse_state:'complete',spans:[{locator:'line:1',text:'자재 5개, 금액 150000원'}],title:'검증 자료',category:'delivery_work'};
 const key=randomUUID(),send=(payload:Record<string,unknown>,idem=key,h=headers)=>app.inject({method:'POST',url:'/v1/field/captures',headers:{...h,'idempotency-key':idem},payload});
 const captured=await send(body);assert.equal(captured.statusCode,201,captured.body);const row=captured.json();
 const visible=async(actor:string)=>runtime.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${actor},true)`;return {captures:(await tx`select id from app.field_captures where tenant_id=${tenant}::uuid and id=${row.id}::uuid`).length,evidence:(await tx`select id from app.evidence_index where tenant_id=${tenant}::uuid and id=${row.evidence_id}::uuid`).length,questions:(await tx`select id from app.field_questions where tenant_id=${tenant}::uuid and capture_id=${row.id}::uuid`).length};});
 assert.deepEqual(await visible(owner),{captures:1,evidence:1,questions:1},'creator can reopen the committed field metadata');
 for(const actor of [colleague,outsider])assert.deepEqual(await visible(actor),{captures:0,evidence:0,questions:0},'same-company colleague and foreign company cannot read another actor\'s device metadata');
 assert.equal((await app.inject({url:'/v1/today',headers:{...headers,authorization:'Bearer colleague'}})).json().items.length,0);
 assert.equal((await app.inject({url:`/v1/work/materials/${row.revision_id}/original`,headers})).statusCode,404);assert.equal(originalReads,0,'metadata access never obtains a server original URL');
 assert.equal((await app.inject({url:`/v1/evidence/${row.revision_id}/chunks`,headers})).statusCode,404);
 await runtime.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${owner},true)`;const [allowed]=await tx`select app.revision_accessible(${tenant}::uuid,${row.revision_id}::uuid) original,app.context_source_readable(${tenant}::uuid,'revision',${row.revision_id}::uuid) ai`;assert.deepEqual(allowed,{original:false,ai:false});assert.deepEqual(await searchEvidence(tx,tenant,{query:'자재',versions:'history'},[row.revision_id]),[],'model evidence tools still exclude device-only metadata');});
 assert.equal((await send(body)).json().revision_id,row.revision_id);
 const duplicate=await send({...body,local_document_id:randomUUID()},randomUUID());assert.notEqual(duplicate.json().evidence_id,row.evidence_id,duplicate.body);assert.notEqual(duplicate.json().document_id,row.document_id);
 assert.equal((await send(body,randomUUID(),{...headers,authorization:'Bearer outsider'})).statusCode,404);
 const today=await app.inject({url:'/v1/today',headers});const question=today.json().items[0];assert(question);assert.equal(today.json().items.length,2);
 const command={version:1,attribution_version:1,source_hash:body.sha256,choice:'project',project_id:project,actor:'agent_test'},answerKey=randomUUID();
 const answer=(payload:Record<string,unknown>,idem=answerKey)=>app.inject({method:'POST',url:`/v1/field/questions/${question.id}/answer`,headers:{...headers,'idempotency-key':idem},payload});
 const saved=await answer(command);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().money_confirmed,false);
 assert.deepEqual((await answer(command)).json(),saved.json());assert.equal((await answer(command,randomUUID())).statusCode,409);
 const found=await app.inject({url:`/v1/projects/${project}`,headers});assert.equal(found.statusCode,200,found.body);assert.equal(found.json().documents[0].id,row.evidence_id);assert.equal(found.json().money.confirmed_cost,null);
 const cancel=await answer({...command,version:2,attribution_version:2,choice:'cancel',project_id:null},randomUUID());assert.equal(cancel.statusCode,200,cancel.body);
 const later=await answer({...command,version:3,attribution_version:3,choice:'later',project_id:null},randomUUID());assert.equal(later.statusCode,200,later.body);assert.equal((await app.inject({url:'/v1/today',headers})).json().items.length,1);
 const external=await app.inject({method:'POST',url:'/v1/decisions',headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"3"'},payload:{scope:'project_attribution',choice:'confirm_project',targets:[{type:'evidence_index',id:row.evidence_id,version:3}],evidence_ids:[row.evidence_id],project_id:project,reason:'다른 화면에서 확인한 현장'}});
 assert.equal(external.statusCode,201,external.body);
 await admin`update app.exception_cases set next_review_at=now()-interval '1 second' where tenant_id=${tenant}::uuid and id=${question.id}::uuid`;
 assert.equal((await app.inject({url:'/v1/today',headers})).json().items.length,1);
 assert.equal((await answer({...command,version:4,attribution_version:3},randomUUID())).statusCode,409);
 const changed=await send({...body,local_revision:2,sha256:'d'.repeat(64)},randomUUID());assert.equal(changed.statusCode,201,changed.body);
 assert.equal((await answer({...command,version:4,attribution_version:4},randomUUID())).statusCode,409);
 const secondDoc=duplicate.json();
 const divergent=await send({...body,local_document_id:secondDoc.local_document_id,local_revision:2,sha256:'e'.repeat(64)},randomUUID());assert.equal(divergent.statusCode,201,divergent.body);
 assert.equal(divergent.json().document_id,secondDoc.document_id);assert.notEqual(divergent.json().document_id,row.document_id);
 const reverted=await send({...body,local_revision:3},randomUUID());assert.equal(reverted.statusCode,201,reverted.body);assert.notEqual(reverted.json().revision_id,row.revision_id);assert.equal(reverted.json().document_id,row.document_id);
 const reparsed=await send({...body,local_revision:3,parser_version:'test/2',spans:[{locator:'line:1',text:'더 정확히 읽은 자료'}]},randomUUID());assert.equal(reparsed.statusCode,201,reparsed.body);assert.notEqual(reparsed.json().evidence_id,reverted.json().evidence_id);
 assert.equal((await send({...body,local_revision:3,sha256:'f'.repeat(64)},randomUUID())).statusCode,409);
 const [docVersion]=await admin`select version from app.documents where tenant_id=${tenant}::uuid and id=${row.document_id}::uuid`;
 assert.equal(Number(docVersion?.version),4);
 const [blob]=await admin`select storage_location from app.evidence_blobs where tenant_id=${tenant}::uuid and sha256=${body.sha256}`;assert.equal(blob?.storage_location,'device');
 await admin`update app.capture_sources set generation=2 where tenant_id=${tenant}::uuid and id=${source}::uuid`;
 assert.equal((await app.inject({url:'/v1/today',headers})).json().items.length,0);

 const event={event_id:randomUUID(),session_id:randomUUID(),task_id:question.id,document_id:row.document_id,operation_id:null,actor:'agent_test',client_time:new Date().toISOString(),device_sequence:1,app_version:'0.1.0',screen_id:'today',control_id:'answer',result_code:'observed',active_ms:1234,latency_ms:25,consent_version:1};
 for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url:'/v1/field/events',headers,payload:{device_id:device,events:[event]}})).statusCode,200);
 const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10),url=`/v1/admin/field?from=${day}&to=${day}`;
 assert.equal((await app.inject({url,headers})).statusCode,404);
 const report=await app.inject({url,headers:{authorization:'Bearer operator'}});assert.equal(report.statusCode,200,report.body);assert.equal(report.json().events.length,1);assert.equal(report.json().human_events,null);assert.equal(report.json().active_ms,null);
 await runtime.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${outsider},true)`;assert.equal((await tx`select * from app.field_events where tenant_id=${tenant}::uuid`).length,0);});
 const newSource=async()=>{const id=randomUUID();await admin`insert into app.capture_sources(tenant_id,id,device_id,user_id,kind,capability,scope_fingerprint,local_selection_consent,server_upload_consent,external_ai_consent,consent_version) values(${tenant}::uuid,${id}::uuid,${device}::uuid,${owner}::uuid,'folder','passive',${id.replaceAll('-','').repeat(2)},true,true,false,1)`;return id;};
 // Existing uploaded bytes and an explicitly promoted blob keep their original server policy.
 const serverSource=await newSource(),serverHash='1'.repeat(64),promotionHash='2'.repeat(64);
 await admin`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key,scan_state,storage_location) values(${tenant}::uuid,${serverHash},123,'application/octet-stream',${tenant+'/synthetic-server/'+randomUUID()},'clean','server')`;
 const reusedBody={...body,source_id:serverSource,local_document_id:randomUUID(),sha256:serverHash};
 const reused=await send(reusedBody,randomUUID());assert.equal(reused.statusCode,201,reused.body);
 assert.equal((await send(reusedBody,randomUUID())).json().id,reused.json().id,'existing server blob reuse preserves capture replay identity');
 const promotion=await send({...body,source_id:serverSource,local_document_id:randomUUID(),sha256:promotionHash},randomUUID());assert.equal(promotion.statusCode,201,promotion.body);
 await admin`update app.evidence_blobs set storage_location='server',storage_key=${tenant+'/synthetic-server/'+randomUUID()},scan_state='clean' where tenant_id=${tenant}::uuid and sha256=${promotionHash}`;
 for(const saved of [reused.json(),promotion.json()]){
  await runtime.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${owner},true)`;assert.equal((await tx`select id from app.field_captures where tenant_id=${tenant}::uuid and id=${saved.id}::uuid`).length,1,'server-backed field metadata remains readable after reuse or promotion');});
  const reopened=await app.inject({url:'/v1/today',headers});assert(reopened.json().items.some((q:{evidence_id:string})=>q.evidence_id===saved.evidence_id),'the source owner can reopen its server-backed field question');
  for(const actor of [colleague,outsider])await runtime.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${actor},true)`;assert.equal((await tx`select app.field_metadata_readable(${tenant}::uuid,${saved.evidence_id}::uuid) ok`)[0]?.ok,false);assert.equal((await tx`select id from app.field_captures where tenant_id=${tenant}::uuid and id=${saved.id}::uuid`).length,0);assert.equal((await tx`select id from app.field_questions where tenant_id=${tenant}::uuid and capture_id=${saved.id}::uuid`).length,0);});
 }
 const serverSourceRevoked=await app.inject({method:'POST',url:`/v1/capture-sources/${serverSource}/revoke`,headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"1"'},payload:{}});assert.equal(serverSourceRevoked.statusCode,200,serverSourceRevoked.body);
 const revokedSource=await newSource(),revokedCapture=await send({...body,source_id:revokedSource,local_document_id:randomUUID()},randomUUID());assert.equal(revokedCapture.statusCode,201,revokedCapture.body);assert.equal((await app.inject({url:'/v1/today',headers})).json().items.length,1);
 const revoked=await app.inject({method:'POST',url:`/v1/capture-sources/${revokedSource}/revoke`,headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"1"'},payload:{}});assert.equal(revoked.statusCode,200,revoked.body);assert.equal((await app.inject({url:'/v1/today',headers})).json().items.length,0);
 await runtime.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${owner},true)`;assert.equal((await tx`select id from app.evidence_index where tenant_id=${tenant}::uuid and id=${revokedCapture.json().evidence_id}::uuid`).length,0,'source revocation immediately hides shared metadata');});
 const deviceSource=await newSource(),deviceCapture=await send({...body,source_id:deviceSource,local_document_id:randomUUID()},randomUUID());assert.equal(deviceCapture.statusCode,201,deviceCapture.body);assert.equal((await app.inject({url:'/v1/today',headers})).json().items.length,1);
 const deviceRevoked=await app.inject({method:'POST',url:`/v1/devices/${device}/revoke`,headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"1"'},payload:{}});assert.equal(deviceRevoked.statusCode,200,deviceRevoked.body);assert.equal((await app.inject({url:'/v1/today',headers})).json().items.length,0);
 await runtime.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${owner},true)`;assert.equal((await tx`select id from app.field_captures where tenant_id=${tenant}::uuid and id=${deviceCapture.json().id}::uuid`).length,0,'device revocation immediately hides its field metadata');});
 }finally{
  await app.close();
  await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant,foreignTenant]);for(const id of [owner,outsider,operator,colleague]){await tx`delete from app.field_operator_access where user_id=${id}::uuid`;await tx`delete from app.field_operators where user_id=${id}::uuid`;await tx`delete from auth.sessions where user_id=${id}::uuid`;await tx`delete from auth.users where id=${id}::uuid`;}});
  await Promise.all([admin.end(),runtime.end()]);
 }
});

