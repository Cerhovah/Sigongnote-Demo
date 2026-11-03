import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
import {recoveryAssets} from '../scripts/recovery-assets.js';
import {runContextRestoreOnce,type ContextResult} from '../services/api/src/context-restore.js';
import type {ClaudeRunner,ClaudeRuntimeConfig} from '../services/api/src/claude-runtime.js';
import type {CapturePolicy} from '../services/api/src/capture-scope.js';

test('desktop records share through phone journal, detail and sites without parse jobs; retry, correction and tenant isolation persist',async()=>{
 const db=await processingFixture(),f=await db.createFixture(),other=await db.createFixture('합성 다른 회사');
 const app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
 const call=(url:string,body?:unknown,tenant=f.tenant)=>app.inject({method:body?'POST':'GET',url,headers:{authorization:'Bearer fixture','x-tenant-id':tenant},...(body?{payload:body as object}:{})});
 try{
  const [before]=await db.admin`select count(*)::int n from app.jobs where tenant_id=${f.tenant}::uuid`;
  const body={device_id:f.device,items:[{id:randomUUID(),revision:1,received_at:'2026-10-07T01:00:00Z',file_name:'합성 거래명세.xlsx',project_name:'합성 공유 현장',categories:['billing_payment'],excerpt:'합성 현장 납품 문서',sha256:'a'.repeat(64),mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',source_kind:'local_file'}]};
  let response=await call('/v1/local-journal/push',body);assert.equal(response.statusCode,200,response.body);const saved=response.json().items[0];
  assert.deepEqual((await call('/v1/local-journal/push',body)).json().items,[saved]);
  const journal=await call('/v1/work/journal');assert.equal(journal.statusCode,200,journal.body);assert.equal(journal.json().items.filter((r:any)=>r.id===saved.revision_id).length,1);
  const materials=await call('/v1/work/materials?project_id='+saved.project_id);assert.equal(materials.statusCode,200,materials.body);assert.equal(materials.json().materials[0].title,'합성 거래명세.xlsx');
  const detail=await call('/v1/work/materials/'+saved.revision_id);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().local_record,true);assert.equal(detail.json().revision.original_available,false);assert.match(detail.json().result.output.spans[0].text,/합성 현장/);
  const project=randomUUID();await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성 보정 현장')`;
  const corrected=await call('/v1/work/materials/'+saved.revision_id+'/organization',{project_id:project,version:1});assert.equal(corrected.statusCode,200,corrected.body);
  assert.equal((await call('/v1/local-journal/changes')).json().items[0].project_id,project);
  await call('/v1/local-journal/push',body);assert.equal((await call('/v1/local-journal/changes')).json().items[0].project_id,project);
  assert.equal((await call('/v1/local-journal/changes',undefined,other.tenant)).statusCode,404);
  assert.equal((await call('/v1/local-journal/push',{...body,device_id:other.device})).statusCode,404);
  assert.equal((await call('/v1/local-journal/push',{...body,items:[{...body.items[0],sha256:'b'.repeat(64)}]})).statusCode,409);
  const [after]=await db.admin`select count(*)::int n from app.jobs where tenant_id=${f.tenant}::uuid`;assert.equal(after!.n,before!.n);
  assert.equal(recoveryAssets([],[]).shared_local_journal.table,'app.local_journal_entries');
 }finally{await app.close();await db.cleanup();}
});

test('PC metadata aliases only its verified native capture; identical bytes without that identity remain separate observations',async()=>{
 const text='합성 같은 PC 원천의 메타데이터와 원본';
 const db=await processingFixture(),f=await db.createFixture(text),foreign=await db.createFixture(text);
 const [native]=await db.admin`select i.client_capture_id,b.sha256 from app.upload_intents i join app.document_revisions r on r.tenant_id=i.tenant_id and r.id=i.completed_revision_id join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id where i.tenant_id=${f.tenant}::uuid and r.id=${f.revision}::uuid`;
 const [otherNative]=await db.admin`select client_capture_id from app.upload_intents where tenant_id=${foreign.tenant}::uuid and completed_revision_id=${foreign.revision}::uuid`;
 const policy={id:'native-source-identity-regression',purpose:'work_records',provider:'anthropic',processing_location:'provider_cloud',storage_location:'development_computer',retention:'until_user_deletes',external_processing:true};
 await db.admin`insert into app.local_context_consents(tenant_id,user_id,allowed,processing_policy) values(${f.tenant}::uuid,${f.user}::uuid,true,${db.admin.json(policy)})`;
 const app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
 const headers={authorization:'Bearer fixture','x-tenant-id':f.tenant};
 const send=(url:string,payload:object)=>app.inject({method:'POST',url,headers,payload});
 try{
  const id=randomUUID(),control=randomUUID(),foreignAlias=randomUUID();
  const item=(localId:string,name:string)=>({id:localId,revision:1,received_at:new Date().toISOString(),file_name:name,categories:[],excerpt:text,sha256:createHash('sha256').update(text).digest('hex'),mime:'text/plain'});
  const pushed=await send('/v1/local-journal/push',{device_id:f.device,items:[item(id,'합성 먼저 공유된 자료.txt'),item(control,'합성 동일내용 다른 자료.txt'),{...item(foreignAlias,'합성 다른 회사 캡처키 자료.txt'),native_capture_id:otherNative!.client_capture_id}]});
  assert.equal(pushed.statusCode,200,pushed.body);const local=pushed.json().items.find((x:any)=>x.local_id===id).revision_id;
  const before=await app.inject({method:'GET',url:'/v1/work/journal',headers});assert.ok(before.json().items.some((x:any)=>x.id===local));
  const linked=await send('/v1/local-journal/native-links',{device_id:f.device,items:[{id,sha256:native!.sha256,native_capture_id:native!.client_capture_id}]});assert.equal(linked.statusCode,200,linked.body);
  assert.deepEqual(linked.json().items,[{local_id:id,revision_id:f.revision,state:'linked'}]);
  const journal=await app.inject({method:'GET',url:'/v1/work/journal',headers});assert.equal(journal.statusCode,200,journal.body);const items=journal.json().items;
  assert.equal(items.some((x:any)=>x.id===local),false,'only the proved metadata rendition is hidden');assert.equal(items.filter((x:any)=>x.id===f.revision).length,1);
  assert.equal(items.filter((x:any)=>x.source_kind==='local_file').length,2,'same bytes and a foreign capture key cannot establish source identity');
  const original=items.find((x:any)=>x.id===f.revision);assert.equal(original.sha256,native!.sha256);assert.equal(original.client_capture_id,native!.client_capture_id);assert.equal(original.capture_device_id,f.device);
  const materials=await app.inject({method:'GET',url:'/v1/work/materials',headers});assert.equal(materials.statusCode,200,materials.body);assert.equal(materials.json().materials.some((x:any)=>x.id===local),false);
  const claim=(await db.api`select app.next_context_input(${f.tenant}::uuid,180,true) value`)[0]!.value;
  assert.notEqual(claim?.source_ref,local,'proved native capture is never also interpreted as local metadata');assert.ok([pushed.json().items[1].revision_id,pushed.json().items[2].revision_id].includes(claim?.source_ref));
  const unknown=await send('/v1/local-journal/native-links',{device_id:f.device,items:[{id:randomUUID(),sha256:native!.sha256,native_capture_id:native!.client_capture_id}]});assert.equal(unknown.statusCode,200);assert.equal(unknown.json().items[0].state,'unshared');
  const [sourceVersion]=await db.admin`select version from app.capture_sources where tenant_id=${f.tenant}::uuid and id=${f.source}::uuid`;
  const revoke=await app.inject({method:'POST',url:'/v1/capture-sources/'+f.source+'/revoke',headers:{...headers,'idempotency-key':randomUUID(),'if-match':`"${sourceVersion!.version}"`},payload:{}});assert.equal(revoke.statusCode,200,revoke.body);
  const withdrawn=await app.inject({method:'GET',url:'/v1/work/journal',headers});assert.equal(withdrawn.json().items.some((x:any)=>x.id===local||x.id===f.revision),false,'a linked metadata rendition cannot revive a withdrawn original');
 }finally{await app.close();await db.cleanup();}
});

test('native source replaces the metadata interpretation once, while an unknown metadata submission remains fenced',async()=>{
 const db=await processingFixture(undefined,'anthropic'),text='합성 PC 원천 업무 요청',fixtures=[await db.createFixture(text),await db.createFixture(text)];
 const policy:CapturePolicy=db.config.policy;
 const runtime:ClaudeRuntimeConfig={model:'synthetic-native-context',price:{version:'synthetic',provider:'anthropic',model:'synthetic-native-context',input_krw_per_million:3000,output_krw_per_million:15000,valid_until:'2099-01-01T00:00:00Z',conversion_note:'synthetic fixture; no external calls'},maxBudgetUsd:0.5,maxTurns:12,effort:'medium',credential:'api_key'};
 const event=(summary:string):ContextResult['events'][number]=>({kind:'request',summary,detail:'합성 회귀',project_id:null,project_name:null,context_id:null,party:null,occurred_at:null,quantities:[],evidence_refs:[],missing:['site'],confidence:'high',reasoning:'합성 원천',followups:[{title:summary,due_on:null}],supersedes_event_id:null});
 const runner=(summary:string,observe?:()=>void):ClaudeRunner=>async(request,rt)=>{observe?.();return {value:request.parse({events:[event(summary)],unresolved:false}),usage:{input_tokens:1,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0},costUsd:0,receipt:'synthetic-native-'+randomUUID(),turns:1,durationMs:1,model:rt.model,toolCalls:[]};};
 try{for(const [index,f] of fixtures.entries()){
  await db.admin`insert into app.local_context_consents(tenant_id,user_id,allowed,processing_policy) values(${f.tenant}::uuid,${f.user}::uuid,true,${db.admin.json(policy)})`;
  const app=createApp({db:db.api,capturePolicy:policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});const headers={authorization:'Bearer fixture','x-tenant-id':f.tenant};
  try{
   const [upload]=await db.admin`select client_capture_id,claimed_sha256 from app.upload_intents where tenant_id=${f.tenant}::uuid and completed_revision_id=${f.revision}::uuid`;
   const id=randomUUID(),push=await app.inject({method:'POST',url:'/v1/local-journal/push',headers,payload:{device_id:f.device,items:[{id,revision:1,received_at:new Date().toISOString(),file_name:'합성 메타데이터.txt',categories:[],excerpt:text,sha256:upload!.claimed_sha256,mime:'text/plain'}]}});assert.equal(push.statusCode,200,push.body);const local=push.json().items[0].revision_id;
   // The newer metadata receipt is claimed first. It cannot be treated as the
   // original's rendition until the device supplies the exact native capture key.
   const first=await runContextRestoreOnce({db:db.api,runtime,policy,tenantScope:f.tenant,runner:index===0?runner('합성 메타데이터 할 일'):async()=>{throw Error('synthetic-outcome-unknown');}});assert.equal(first,index===0?'stored':'unknown');
   const linked=await app.inject({method:'POST',url:'/v1/local-journal/native-links',headers,payload:{device_id:f.device,items:[{id,sha256:upload!.claimed_sha256,native_capture_id:upload!.client_capture_id}]}});assert.equal(linked.statusCode,200,linked.body);
   let calls=0;const result=await runContextRestoreOnce({db:db.api,runtime,policy,tenantScope:f.tenant,runner:runner('합성 원본 할 일',()=>{calls++;})});assert.equal(result,index===0?'stored':'idle');assert.equal(calls,index===0?1:0);
   if(index===0){
    const [old]=await db.admin`select status from app.work_events where tenant_id=${f.tenant}::uuid and source_kind='local' and source_ref=${local}::uuid`;assert.equal(old!.status,'superseded');
    const tasks=await app.inject({method:'GET',url:'/v1/work/journal/tasks',headers});assert.equal(tasks.json().items.length,1);assert.equal(tasks.json().items[0].text,'합성 원본 할 일');assert.equal(tasks.json().items[0].kind,'followup','the legacy parser request cannot duplicate the completed context interpretation');
    assert.equal(await runContextRestoreOnce({db:db.api,runtime,policy,tenantScope:f.tenant,runner:runner('duplicate')}),'idle');
   }else assert.equal((await db.admin`select count(*)::int n from app.product_ai_usage where tenant_id=${f.tenant}::uuid and channel='context'`)[0]!.n,1,'the same capture cannot mint a second paid reservation through the native path');
  }finally{await app.close();}
 }}finally{await db.cleanup();}
});
