import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {runAgentOnce} from '../services/api/src/agent-runs.js';
import {refreshWorkIssues} from '../services/api/src/work-decisions.js';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
import {runParseOnce} from '../services/api/src/parse-worker.js';
import {reserveProductAi,submitProductAi,finishProductAi} from '../services/api/src/product-ai.js';
import {promoteSemanticOnce} from '../services/api/src/semantic-promotion.js';
import {businessEventBatch,runBusinessEventsOnce,registerBusinessEventRoutes} from '../services/api/src/business-events.js';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
async function setup(){
 const db=await processingFixture(),f=await db.createFixture(`합성현장 견적서\n부가세:별도 10%\n받는 곳:합성 고객\n현장조건:실내\n운반비:포함\n단가 기준일:${new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}\n품명 | 규격 | 수량 | 단위 | 매입단가 | 단가\n창틀 | 표준 | 30 | 개 | 100 | 125\n창틀 최종 30개 합의\n창틀 8개 인수`),project=randomUUID(),context=randomUUID(),order=randomUUID(),bundle=randomUUID();
 await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성현장')`;
 await db.admin`insert into app.work_orders(tenant_id,id,project_id,display_name) values(${f.tenant}::uuid,${order}::uuid,${project}::uuid,'합성계약')`;
 await db.admin`insert into app.work_bundles(tenant_id,id,work_order_id,display_name,trade_pack_id,trade_pack_version,trade_pack_hash) values(${f.tenant}::uuid,${bundle}::uuid,${order}::uuid,'자재 납품','construction','1.0.0',${'a'.repeat(64)})`;
 await db.admin`insert into app.work_contexts(tenant_id,id,project_id,label,bundle_id) values(${f.tenant}::uuid,${context}::uuid,${project}::uuid,'자재 납품',${bundle}::uuid)`;
 const bind=async(revision:string,c=context)=>db.admin`update app.evidence_organizations set state='linked',project_id=${project}::uuid,project_candidates=${[project]}::uuid[],context_id=${c}::uuid,version=version+1 where tenant_id=${f.tenant}::uuid and revision_id=${revision}::uuid`;
 await bind(f.revision);
 const item=randomUUID(),itemType=randomUUID();await db.admin`insert into app.entity_objects(tenant_id,id,kind,display_name,project_id) values(${f.tenant}::uuid,${itemType}::uuid,'item_type','창틀 종류',${project}::uuid)`;await db.admin`insert into app.entity_objects(tenant_id,id,kind,display_name,project_id,item_type_id) values(${f.tenant}::uuid,${item}::uuid,'item_instance','창틀',${project}::uuid,${itemType}::uuid)`;
 const options={db:db.worker,policy:db.config.policy,tenantScope:f.tenant};
 const upload=async(text:string)=>{
  const bytes=Buffer.from(text),digest=hash(text),app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session}),storage:{async sign(){return 'https://storage.invalid/synthetic?token=synthetic-opaque-upload-signature';},async verify(){return {matches:true,sniffedMime:'text/plain'};},async remove(){}}});
  try{
   const headers={authorization:'Bearer fixture','x-tenant-id':f.tenant,'idempotency-key':randomUUID()};
   const prepared=await app.inject({method:'POST',url:'/v1/ingestions',headers,payload:{client_capture_id:randomUUID(),source_id:f.source,source_generation:1,sha256:digest,byte_length:bytes.length,declared_mime:'text/plain'}});assert.equal(prepared.statusCode,201,prepared.body);
   const completed=await app.inject({method:'POST',url:`/v1/ingestions/${prepared.json().ingestion_id}/complete`,headers:{...headers,'idempotency-key':randomUUID()},payload:{sha256:digest,byte_length:bytes.length}});assert.equal(completed.statusCode,200,completed.body);
   assert.equal(await runParseOnce({...options,python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker'),download:async()=>bytes}),'stored');
   const next={...f,revision:completed.json().revision_id,job:completed.json().job_id};await bind(next.revision);return next;
  }finally{await app.close();}
 };
 const semantic=async(source= f,value='8',effectiveAt:string|null=null,copies=1)=>{
  const [chunk]=await db.admin`select * from app.evidence_chunks where tenant_id=${source.tenant}::uuid and job_id=${source.job}::uuid and text like ${'%'+value+'개 인수%'} order by ordinal limit 1`;assert.ok(chunk);
  const [orderChunk]=await db.admin`select * from app.evidence_chunks where tenant_id=${source.tenant}::uuid and job_id=${source.job}::uuid and text like '%창틀 최종 30개 합의%' order by ordinal limit 1`;assert.ok(orderChunk);
  const reservation={...db.reservation(source,100),config:{...db.config,index_job:source.job,first_ordinal:Math.min(chunk.ordinal,orderChunk.ordinal),last_ordinal:Math.max(chunk.ordinal,orderChunk.ordinal),model:'internal-fixture',prompt:'candidate-evidence-v1'}};
  const candidate={key:'receipt',eventKind:'receipt',actor:null,subject:{kind:'item_instance',mention:'창틀',role:null},predicate:'receipt',object:null,quantity:{value,unitCode:'ea'},amount:null,effectiveAt,assertion:{polarity:'positive',modality:'actual',speech:'direct',speaker:null},evidence:[{indexJobId:source.job,ordinal:chunk.ordinal,contentHash:chunk.content_hash,locator:chunk.locator,quote:`창틀 ${value}개 인수`}],uncertaintyReasons:[]};
  const output={semanticCandidates:{schemaVersion:'semantic-candidates-v1',modelVersion:'internal-fixture',promptVersion:'candidate-evidence-v1',candidates:[{...candidate,key:'order',eventKind:'acceptance',predicate:'quantity',quantity:{value:'30',unitCode:'ea'},evidence:[{indexJobId:source.job,ordinal:orderChunk.ordinal,contentHash:orderChunk.content_hash,locator:orderChunk.locator,quote:'창틀 최종 30개 합의'}]},candidate]}};
  assert.equal((await reserveProductAi(db.worker,reservation)).state,'reserved');assert.equal(await submitProductAi(db.worker,reservation),true);assert.equal(await finishProductAi(db.worker,reservation,1,output,'synthetic',{}),true);assert.equal(await promoteSemanticOnce(options),true);
 };
 const identity=async(left:string,right:string,choice='same_transaction')=>{
  const ids=[left,right].sort(),decision=randomUUID();const [e]=await db.admin`select id from app.evidence_index where tenant_id=${f.tenant}::uuid and revision_id=${left}::uuid limit 1`;assert.ok(e);
  await db.admin`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) values(${f.tenant}::uuid,${decision}::uuid,${f.user}::uuid,'economic_transaction_identity',${choice},${ids}::uuid[],array[1,1]::bigint[],${[e.id]}::uuid[],'합성자료 거래 관계 확인',${hash(decision)})`;
  await db.admin`insert into app.transaction_identities(tenant_id,left_revision_id,right_revision_id,choice,version,decision_id) values(${f.tenant}::uuid,${ids[0]!}::uuid,${ids[1]!}::uuid,${choice},2,${decision}::uuid)`;
 };
 return {db,f,project,context,bundle,options,upload,semantic,identity,cleanup:()=>db.cleanup()};
}

test('N16 one receipt answer prepares three types through agent and deducts prior bill without completing the whole work',async()=>{
 const s=await setup();let app:ReturnType<typeof createApp>|undefined;
 try{
  const other=await s.upload('합성현장 별개 자료');await s.identity(s.f.revision,other.revision,'distinct_transaction');await s.semantic();
  const {db,f,project,context,bundle}=s;
  const [e]=await db.admin`select id from app.evidence_index where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid order by id limit 1`;assert.ok(e);
  const decision=randomUUID(),agreement=randomUUID();
  await db.admin`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) values(${f.tenant}::uuid,${decision}::uuid,${f.user}::uuid,'billing_agreement','synthetic_fixture',array[${agreement}::uuid],array[1]::bigint[],array[${e.id}::uuid],'내부 시험 청구 합의',${'d'.repeat(64)})`;
  await db.admin`update app.evidence_index set category='agreement' where tenant_id=${f.tenant}::uuid and id=${e.id}::uuid`;
  await db.admin`insert into app.evidence_attributions(tenant_id,evidence_index_id,bundle_id,state,version,decision_id) values(${f.tenant}::uuid,${e.id}::uuid,${bundle}::uuid,'confirmed',2,${decision}::uuid)`;
  await db.admin`insert into app.billing_agreements(tenant_id,id,bundle_id,source_evidence_id,approved_gross_minor,decision_id) values(${f.tenant}::uuid,${agreement}::uuid,${bundle}::uuid,${e.id}::uuid,4125,${decision}::uuid)`;
  const services={db:db.api,capturePolicy:db.config.policy,agentRuntime:true,verifyToken:async()=>({userId:f.user,sessionId:f.session})};app=createApp(services);
  const call=(url:string,payload?:object)=>app!.inject({method:payload?'POST':'GET',url,headers:{authorization:'Bearer fixture','x-tenant-id':f.tenant},...(payload?{payload}:{})});
  const prepare=async(instruction:string)=>{const r=await call('/v1/agent/runs',{client_turn_id:randomUUID(),project_id:project,instruction,input_kind:'text'});await runAgentOnce(services,{},f.tenant);const v=(await call('/v1/agent/runs/'+r.json().run_id)).json();assert.equal(v.document_refs.length,1,JSON.stringify(v));return (await call('/v1/document-drafts/'+v.document_refs[0].id)).json();};
  const before=await prepare('청구서 준비해줘');assert.ok(before.missing.includes('현재 청구 가능한 작업과 금액'));assert.equal(before.document.lines[0].quantity,'8');
  await db.api.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${f.user},true)`;await refreshWorkIssues(tx,f.tenant,f.user,db.config.policy);});
  const questions=(await call('/v1/work/questions')).json().questions,q=questions.find((q:any)=>q.proposal.semantic_subject);assert.ok(q,JSON.stringify(questions));
  const answer=await call('/v1/work/replies',{command_id:randomUUID(),question_id:q.id,question_version:q.version,text:'이대로 반영'});assert.equal(answer.statusCode,200,answer.body);
  const invoice=await prepare('청구서 준비해줘');assert.equal(invoice.state,'draft_ready',JSON.stringify(invoice));assert.equal(invoice.document.totals.total,'1100');
  const statement=await prepare('거래명세서 준비해줘');assert.equal(statement.state,'draft_ready');assert.equal(statement.document.lines[0].quantity,'8');assert.ok(statement.source_refs.includes(f.revision));
  const order=await prepare('발주서 준비해줘');assert.equal(order.document.lines[0].quantity,'30');assert.ok(order.missing.includes('받는 곳'));assert.ok(order.source_refs.includes(f.revision));
  const issueBody={client_command_id:randomUUID(),drafts:[{id:invoice.id,basis_hash:invoice.document.basis_hash,amount_minor:'400'}],recipient_confirmation:invoice.document.recipient.name};
  const issued=await call('/v1/documents/issue',issueBody);assert.equal(issued.statusCode,201,issued.body);assert.deepEqual((await call('/v1/documents/issue',issueBody)).json(),issued.json());
  const next=await prepare('청구서 준비해줘');assert.equal(next.document.totals.total,'700');assert.equal(next.document.lines[0].quantity,null,'money remainder is not delivery quantity');
  const second=await call('/v1/documents/issue',{client_command_id:randomUUID(),drafts:[{id:next.id,basis_hash:next.document.basis_hash}],recipient_confirmation:next.document.recipient.name});assert.equal(second.statusCode,201,second.body);
  const secondView=(await call('/v1/documents/'+second.json().documents[0].id)).json();assert.ok(secondView.document.terms.some((t:string)=>t.includes('이번 청구 금액 기준')));
  assert.equal((await db.admin`select count(*)::int n from app.outcomes where tenant_id=${f.tenant}::uuid`)[0]!.n,0,'partial acceptance is not whole work completion');
  await db.admin`update app.capture_sources set active=false,server_upload_consent=false,revoked_at=now(),generation=generation+1 where tenant_id=${f.tenant}::uuid and id=${f.source}::uuid`;
  assert.equal((await call('/v1/document-drafts/'+next.id)).statusCode,404);
 }finally{await app?.close();await s.cleanup();}
});
