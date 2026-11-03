import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import Fastify from 'fastify';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
import {runParseOnce} from '../services/api/src/parse-worker.js';
import {reserveProductAi,submitProductAi,finishProductAi} from '../services/api/src/product-ai.js';
import {promoteSemanticOnce} from '../services/api/src/semantic-promotion.js';
import {businessEventBatch,runBusinessEventsOnce,registerBusinessEventRoutes} from '../services/api/src/business-events.js';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
async function setup(text='합성현장 28개 인수\n표 자료'){
 const db=await processingFixture(),f=await db.createFixture(text),project=randomUUID(),context=randomUUID(),order=randomUUID(),bundle=randomUUID();
 await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성현장')`;
 await db.admin`insert into app.work_orders(tenant_id,id,project_id,display_name) values(${f.tenant}::uuid,${order}::uuid,${project}::uuid,'합성계약')`;
 await db.admin`insert into app.work_bundles(tenant_id,id,work_order_id,display_name,trade_pack_id,trade_pack_version,trade_pack_hash) values(${f.tenant}::uuid,${bundle}::uuid,${order}::uuid,'자재 납품','construction','1.0.0',${'a'.repeat(64)})`;
 await db.admin`insert into app.work_contexts(tenant_id,id,project_id,label,bundle_id) values(${f.tenant}::uuid,${context}::uuid,${project}::uuid,'자재 납품',${bundle}::uuid)`;
 const bind=async(revision:string,c=context)=>db.admin`update app.evidence_organizations set state='linked',project_id=${project}::uuid,project_candidates=${[project]}::uuid[],context_id=${c}::uuid,version=version+1 where tenant_id=${f.tenant}::uuid and revision_id=${revision}::uuid`;
 await bind(f.revision);
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
 const semantic=async(source= f,value='28',effectiveAt:string|null=null,copies=1)=>{
  const [chunk]=await db.admin`select * from app.evidence_chunks where tenant_id=${source.tenant}::uuid and job_id=${source.job}::uuid and text like ${'%'+value+'개 인수%'} order by ordinal limit 1`;assert.ok(chunk);
  const reservation={...db.reservation(source,100),config:{...db.config,index_job:source.job,first_ordinal:chunk.ordinal,last_ordinal:chunk.ordinal,model:'internal-fixture',prompt:'candidate-evidence-v1'}};
  const candidate={key:'receipt',eventKind:'receipt',actor:null,subject:{kind:'project',mention:'합성현장',role:null},predicate:'receipt',object:null,quantity:{value,unitCode:'ea'},amount:null,effectiveAt,assertion:{polarity:'positive',modality:'actual',speech:'direct',speaker:null},evidence:[{indexJobId:source.job,ordinal:chunk.ordinal,contentHash:chunk.content_hash,locator:chunk.locator,quote:`합성현장 ${value}개 인수`}],uncertaintyReasons:[]};
  const output={semanticCandidates:{schemaVersion:'semantic-candidates-v1',modelVersion:'internal-fixture',promptVersion:'candidate-evidence-v1',candidates:Array.from({length:copies},(_,i)=>({...candidate,key:`receipt_${i}`}))}};
  assert.equal((await reserveProductAi(db.worker,reservation)).state,'reserved');assert.equal(await submitProductAi(db.worker,reservation),true);assert.equal(await finishProductAi(db.worker,reservation,1,output,'synthetic',{}),true);assert.equal(await promoteSemanticOnce(options),true);
 };
 const identity=async(left:string,right:string,choice='same_transaction')=>{
  const ids=[left,right].sort(),decision=randomUUID();const [e]=await db.admin`select id from app.evidence_index where tenant_id=${f.tenant}::uuid and revision_id=${left}::uuid limit 1`;assert.ok(e);
  await db.admin`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) values(${f.tenant}::uuid,${decision}::uuid,${f.user}::uuid,'economic_transaction_identity',${choice},${ids}::uuid[],array[1,1]::bigint[],${[e.id]}::uuid[],'합성자료 거래 관계 확인',${hash(decision)})`;
  await db.admin`insert into app.transaction_identities(tenant_id,left_revision_id,right_revision_id,choice,version,decision_id) values(${f.tenant}::uuid,${ids[0]!}::uuid,${ids[1]!}::uuid,${choice},2,${decision}::uuid)`;
 };
 const api=Fastify({logger:false});registerBusinessEventRoutes(api,{db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
 const read=async(c=context,tenant=f.tenant)=>api.inject({method:'GET',url:`/v1/work/${c}/state`,headers:{authorization:'Bearer synthetic','x-tenant-id':tenant}});
 const next=async()=>{const [r]=await db.worker`select app.next_business_event_input(${f.tenant}::uuid,${db.worker.json(db.config.policy)}) input`;return r?.input;};
 const save=async(input:any)=>{const b=businessEventBatch(input);return (await db.worker`select app.save_business_event_projection(${f.tenant}::uuid,${input.context}::uuid,${input.context_hash},${input.observedVersion}::bigint,${db.worker.json(b.records)},${db.worker.json(b.reduced)},${db.worker.json(db.config.policy)}) ok`)[0]!.ok;};
 const drain=async()=>{for(let i=0;i<30;i++)if(await runBusinessEventsOnce(options)==='idle')return;throw Error('business queue did not settle');};
 return {db,f,project,context,bundle,options,upload,bind,semantic,identity,read,next,save,drain,cleanup:async()=>{await api.close();await db.cleanup();}};
}

test('N22 corrected transcript retires old meaning and replays current candidates while preserving journal',async()=>{
 const s=await setup();const api=createApp({db:s.db.api,capturePolicy:s.db.config.policy,verifyToken:async()=>({userId:s.f.user,sessionId:s.f.session})});
 try{
  // Synthetic indexed audio metadata isolates correction/replay from STT accuracy.
  await s.db.admin`update app.document_revisions set declared_mime='audio/wav' where tenant_id=${s.f.tenant}::uuid and id=${s.f.revision}::uuid`;
  await s.db.admin`update app.evidence_chunks set locator='audio:0-1000:'||ordinal where tenant_id=${s.f.tenant}::uuid and job_id=${s.f.job}::uuid`;
  await s.semantic();await s.drain();assert.equal((await s.read()).json().coverage.activeCount,1);
  const headers={authorization:'Bearer synthetic','x-tenant-id':s.f.tenant},command={revision_id:s.f.revision,client_command_id:randomUUID(),locator:'audio:0-1000:0',text:'합성현장 20개 인수',expected_id:null};
  const saved=await api.inject({method:'POST',url:'/v1/work/audio/corrections',headers,payload:command});assert.equal(saved.statusCode,200,saved.body);
  assert.equal((await s.read()).json().coverage.activeCount,0,'old meaning is fenced before async replay');await s.drain();
  const [index]=await s.db.admin`select job_id from app.evidence_chunk_indexes where tenant_id=${s.f.tenant}::uuid and revision_id=${s.f.revision}::uuid and published order by created_at desc,job_id desc limit 1`;
  assert.notEqual(index!.job_id,s.f.job);await s.semantic({...s.f,job:index!.job_id},'20');await s.drain();
  const current=(await s.read()).json();assert.equal(current.coverage.activeCount,1);assert.equal(current.coverage.withdrawnCount,1);
  const [counts]=await s.db.admin`select count(*)::int n from app.business_events where tenant_id=${s.f.tenant}::uuid`;assert.equal(counts!.n,2);
  const again=await api.inject({method:'POST',url:'/v1/work/audio/corrections',headers,payload:command});assert.equal(again.statusCode,200);await s.drain();assert.equal((await s.read()).json().coverage.auditCount,2);
  await s.db.admin`update app.capture_sources set active=false,revoked_at=now(),generation=generation+1 where tenant_id=${s.f.tenant}::uuid and id=${s.f.source}::uuid`;
  assert.equal((await s.read()).json().coverage.activeCount,0);
 }finally{await api.close();await s.cleanup();}
});

test('N22 a correction reuses unchanged paid windows and preserves their observations without another model call',async()=>{
 const s=await setup('합성현장 28개 인수\n메모 하나\n메모 둘\n메모 셋\n합성현장 50개 인수\n마지막 메모');
 const api=createApp({db:s.db.api,capturePolicy:s.db.config.policy,verifyToken:async()=>({userId:s.f.user,sessionId:s.f.session})});
 try{
  await s.db.admin`update app.document_revisions set declared_mime='audio/wav' where tenant_id=${s.f.tenant}::uuid and id=${s.f.revision}::uuid`;
  await s.db.admin`update app.evidence_chunks set locator='audio:0-1000:'||ordinal where tenant_id=${s.f.tenant}::uuid and job_id=${s.f.job}::uuid`;
  await s.semantic();await s.semantic(s.f,'50');await s.drain();assert.equal((await s.read()).json().coverage.activeCount,2);
  const unknown=async(job:string,first:number,last:number)=>{const r={...s.db.reservation(s.f,10),config:{...s.db.config,index_job:job,first_ordinal:first,last_ordinal:last}};assert.equal((await reserveProductAi(s.db.worker,r)).state,'reserved');assert.equal(await submitProductAi(s.db.worker,r),true);};
  await unknown(s.f.job,5,5);
  const saved=await api.inject({method:'POST',url:'/v1/work/audio/corrections',headers:{authorization:'Bearer synthetic','x-tenant-id':s.f.tenant},payload:{revision_id:s.f.revision,client_command_id:randomUUID(),locator:'audio:0-1000:0',text:'합성현장 20개 인수',expected_id:null}});assert.equal(saved.statusCode,200,saved.body);
  await s.drain();assert.equal((await s.read()).json().coverage.activeCount,1,'unchanged observation returns without any semantic provider or budget');
  const next=await s.db.next(1,[],s.f.tenant);assert.ok(next);assert.equal(next.chunks[0].ordinal,0);assert.ok(next.chunks.every((c:any)=>c.ordinal<4),'already paid unchanged window is not submitted again');
  const [oldUsage]=await s.db.admin`select config from app.product_ai_usage where tenant_id=${s.f.tenant}::uuid and config->>'first_ordinal'='4'`;
  assert.equal((await s.db.admin`select app.audio_semantic_window_current(${s.f.tenant}::uuid,${s.f.job}::uuid,${next.index_job}::uuid,${s.db.admin.json(oldUsage!.config)}) ok`)[0]!.ok,true);
  await s.semantic({...s.f,job:next.index_job},'20');await s.drain();assert.equal((await s.read()).json().coverage.activeCount,2);
  await unknown(next.index_job,1,3);assert.equal(await s.db.next(1,[],s.f.tenant),null,'unchanged unknown submission is preserved, never retried under a new index');
 }finally{await api.close();await s.cleanup();}
});

test('N07 DB snapshots survive crash/CAS, observe without approval, and rebind immutable events',async()=>{
 const s=await setup();try{
  await s.semantic();const snap=await s.next();assert.equal(snap.facts.length,1);
  assert.equal((await s.db.admin`select count(*)::int n from app.business_events where tenant_id=${s.f.tenant}::uuid`)[0]!.n,0,'snapshot alone does not publish an event');
  const concurrent=await Promise.all([s.save(snap),s.save(snap)]);assert.deepEqual(concurrent.sort(),[false,true]);assert.equal(await s.save(snap),false);
  const [metadata]=await s.db.admin`select actor_kind,actor_id,policy_version,expected_projection_version from app.business_events where tenant_id=${s.f.tenant}::uuid`;
  assert.deepEqual({...metadata},{actor_kind:'model_candidate',actor_id:s.f.user,policy_version:'n07-adapter-v1',expected_projection_version:'0'});
  const initial=await s.read();assert.equal(initial.statusCode,200,initial.body);assert.equal(initial.json().observed_state.receipt[0].quantity,null);assert.equal(initial.json().coverage.auditCount,1);
  assert.equal((await s.read(s.context,randomUUID())).statusCode,404);await assert.rejects(s.db.worker`select * from app.business_events`,/permission denied/);
  // A process exits after claim: lease expiration resumes the exact same durable outbox row.
  const [claim]=await s.db.worker`select app.claim_business_outbox(${s.f.tenant}::uuid) value`;const lease=claim!.value;assert.ok(lease);
  await s.db.admin`update app.outbox set business_lease_until=now()-interval '1 second' where tenant_id=${s.f.tenant}::uuid and id=${lease.id}::uuid`;
  const [again]=await s.db.worker`select app.claim_business_outbox(${s.f.tenant}::uuid) value`;assert.equal(again!.value.id,lease.id);assert.notEqual(again!.value.token,lease.token);
  assert.equal((await s.db.worker`select app.finish_business_outbox(${s.f.tenant}::uuid,${lease.id}::uuid,${again!.value.token}::uuid,false) ok`)[0]!.ok,true);
  await s.db.admin`update app.outbox set business_available_at=now()-interval '1 second' where tenant_id=${s.f.tenant}::uuid and id=${lease.id}::uuid`;
  await s.drain();const [published]=await s.db.admin`select state,business_attempts from app.outbox where tenant_id=${s.f.tenant}::uuid and id=${lease.id}::uuid`;assert.equal(published!.state,'published');assert.equal(published!.business_attempts,3);
  const count=async()=>(await s.db.admin`select count(*)::int n from app.sync_changes where tenant_id=${s.f.tenant}::uuid`)[0]!.n;
  const before=await count();assert.equal((await s.db.worker`select app.finish_business_outbox(${s.f.tenant}::uuid,${lease.id}::uuid,${again!.value.token}::uuid,true) ok`)[0]!.ok,false);assert.equal(await count(),before);
  const newer=randomUUID();await s.db.admin`insert into app.work_contexts(tenant_id,id,project_id,label) values(${s.f.tenant}::uuid,${newer}::uuid,${s.project}::uuid,'다른 업무')`;await s.bind(s.f.revision,newer);
  assert.deepEqual((await s.read()).json().observed_state.receipt,[],'stale context is excluded before worker runs');await s.drain();
  assert.equal((await s.read(newer)).json().coverage.activeCount,1);assert.equal((await s.read()).json().coverage.withdrawnCount,1);
  const journal=await s.db.admin`select id,context_id from app.business_events where tenant_id=${s.f.tenant}::uuid`;assert.equal(journal.length,2);assert.notEqual(journal[0]!.id,journal[1]!.id);
  await assert.rejects(s.db.admin`update app.business_events set event='{}' where tenant_id=${s.f.tenant}::uuid`,/Immutable business event/);
 }finally{await s.cleanup();}
});

test('N07 explicit transaction proof deduplicates copies, late partial facts stay separate, withdrawal races reject',async()=>{
 const s=await setup();try{
  const second=await s.upload('합성현장 28개 인수\nPDF 자료');await s.semantic();await s.semantic(second);await s.identity(s.f.revision,second.revision);await s.drain();
  const pair=(await s.read()).json();assert.equal(pair.observed_state.receipt[0].quantity,'28');assert.equal(pair.coverage.duplicateCount,1);
  const third=await s.upload('합성현장 2개 인수\n늦게 도착한 기록');await s.semantic(third,'2','2020-01-01T00:00:00Z');await s.identity(second.revision,third.revision,'distinct_transaction');await s.drain();
  assert.equal((await s.read()).json().observed_state.receipt[0].quantity,'30');
  // Explicit contradictory proof is fenced; a model's confidence cannot resolve it.
  await s.identity(s.f.revision,third.revision);await s.drain();assert.equal((await s.read()).json().observed_state.receipt[0].quantity,null);
  const fourth=await s.upload('합성현장 1개 인수\n철회 직전 기록');await s.semantic(fourth,'1');const snapshot=await s.next();assert.ok(snapshot.facts.some((x:any)=>x.revision===fourth.revision));
  await s.db.admin`insert into app.evidence_retention_tasks(tenant_id,revision_id,source_id,source_generation) values(${s.f.tenant}::uuid,${fourth.revision}::uuid,${s.f.source}::uuid,1)`;
  assert.equal(await s.save(snapshot),false);assert.equal((await s.db.admin`select count(*)::int n from app.business_events where tenant_id=${s.f.tenant}::uuid and source_revision=${fourth.revision}::uuid`)[0]!.n,0);
  await s.db.admin`update app.capture_sources set server_upload_consent=false,active=false,revoked_at=now(),generation=generation+1 where tenant_id=${s.f.tenant}::uuid and id=${s.f.source}::uuid`;
  const withdrawn=(await s.read()).json();assert.deepEqual(withdrawn.observed_state.receipt,[]);assert.ok(withdrawn.coverage.auditCount>0);await s.drain();
 }finally{await s.cleanup();}
});

test('N07 transaction proof cannot identify multiple compatible events within one original',async()=>{
 const s=await setup();try{
  const copy=await s.upload('합성현장 28개 인수\n여러 인수 기록의 사본');await s.semantic(s.f,'28',null,2);await s.semantic(copy);await s.identity(s.f.revision,copy.revision);await s.drain();
  const value=(await s.read()).json();assert.equal(value.coverage.activeCount,3);assert.equal(value.coverage.duplicateCount,0);
  assert.equal(value.observed_state.receipt[0].quantity,null);assert.equal(value.coverage.ambiguousIdentityCount,3);
 }finally{await s.cleanup();}
});

test('N07 isolates poisoned contexts, publishes while excluded, and retries changed or recovered input',async()=>{
 const s=await setup();try{
  await s.semantic();const good=await s.upload('합성현장 28개 인수\n정상 문맥'),context='ffffffff-ffff-4fff-bfff-ffffffffffff';
  await s.db.admin`insert into app.work_contexts(tenant_id,id,project_id,label) values(${s.f.tenant}::uuid,${context}::uuid,${s.project}::uuid,'정상 업무')`;
  await s.bind(good.revision,context);await s.semantic(good);
  const [fact]=await s.db.admin`select id,semantic from app.fact_candidates where tenant_id=${s.f.tenant}::uuid and source_revision=${s.f.revision}::uuid and semantic is not null`;
  const failures:string[]=[];let now=0,failSave=false,saveAttempts=0;
  const worker=new Proxy(s.db.worker,{apply(target,thisArg,args){
   if(String(args[0]?.[0]).includes('save_business_event_projection')){saveAttempts++;if(failSave){failSave=false;return Promise.reject(new Error('private synthetic error must not be logged'));}}
   return Reflect.apply(target,thisArg,args);
  }});
  const once=()=>runBusinessEventsOnce({...s.options,db:worker,now:()=>now,onFailure:code=>failures.push(code)});
  await s.db.admin`update app.fact_candidates set semantic=jsonb_set(semantic,'{quantity,value}','"invalid"') where tenant_id=${s.f.tenant}::uuid and id=${fact!.id}::uuid`;
  assert.equal(await once(),'stored');assert.equal(failures.length,1);assert.equal((await s.read(context)).json().coverage.auditCount,1);
  assert.equal(await once(),'published','outbox is published even when the only pending context is excluded');
  assert.equal((await s.db.admin`select count(*)::int n from app.outbox where tenant_id=${s.f.tenant}::uuid and topic='work_observed_ready' and state='pending'`)[0]!.n,0);
  const healthySnapshot=async()=>(await s.db.admin`select app.business_context_input(${s.f.tenant}::uuid,${context}::uuid,${s.db.admin.json(s.db.config.policy)}) input`)[0]!.input;
  const healthyBefore=await healthySnapshot();
  await s.db.admin`update app.fact_candidates set semantic=jsonb_set(semantic,'{evidence,0,indexJobId}','"malformed"') where tenant_id=${s.f.tenant}::uuid and id=${fact!.id}::uuid`;
  const healthyAfter=await healthySnapshot();assert.deepEqual(healthyAfter,healthyBefore,'foreign malformed evidence cannot alter or break the healthy snapshot');
  const healthyRead=await s.read(context);assert.equal(healthyRead.statusCode,200);assert.equal(healthyRead.json().coverage.activeCount,1);
  assert.equal(await once(),'retry');assert.equal(failures.length,2,'changed hash retries immediately, including SQL snapshot failures');
  await s.db.admin`update app.fact_candidates set semantic=${s.db.admin.json(fact!.semantic)} where tenant_id=${s.f.tenant}::uuid and id=${fact!.id}::uuid`;
  failSave=true;const before=saveAttempts;assert.equal(await once(),'retry');assert.equal(saveAttempts,before+1,'repaired source is attempted before timeout');
  assert.equal(await once(),'idle');assert.equal(saveAttempts,before+1,'unchanged failed work waits for retry deadline');
  now=60_001;assert.equal(await once(),'stored');assert.equal(saveAttempts,before+2);assert.equal((await s.read()).json().coverage.auditCount,1);
  assert.deepEqual(failures,Array(3).fill('BUSINESS_CONTEXT_RETRY'));assert.equal(await once(),'published');
 }finally{await s.cleanup();}
});

test('N07 applied adapters keep confirmed projection and existing charge balances unchanged',async()=>{
 const s=await setup();try{
  const {db,f,context,bundle}=s;const [evidence]=await db.admin`select id from app.evidence_index where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid limit 1`;assert.ok(evidence);
  const charge=randomUUID(),identity=randomUUID(),previous=randomUUID(),next=randomUUID(),adjustment=randomUUID(),inner=randomUUID(),outer=randomUUID(),command=randomUUID(),effect=randomUUID();
  const decision=async(id:string,scope:string,targets:string[],versions:number[])=>db.admin`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) values(${f.tenant}::uuid,${id}::uuid,${f.user}::uuid,${scope},${scope==='exception_resolution'?'apply_work_answer':'increase'},${targets}::uuid[],${versions}::bigint[],${[evidence.id]}::uuid[],'합성자료 기존 확정 효과',${hash(id)})`;
  await decision(identity,'charge_identity',[charge],[1]);await decision(inner,'charge_adjustment',[charge],[1]);await decision(outer,'exception_resolution',[randomUUID(),context],[6,6]);
  await db.admin`insert into app.charge_cases(tenant_id,id,bundle_id,category,identity_state,status,identity_decision_id) values(${f.tenant}::uuid,${charge}::uuid,${bundle}::uuid,'change','confirmed_distinct','confirmed',${identity}::uuid)`;
  for(const [id,version,amount,parent]of [[previous,1,100,null],[next,2,125,previous]] as const)await db.admin`insert into app.charge_revisions(tenant_id,id,charge_case_id,version,previous_revision_id,actor_id,reason,payload,evidence_ids,confirmed_actual_minor,tax_mode) values(${f.tenant}::uuid,${id}::uuid,${charge}::uuid,${version},${parent}::uuid,${f.user}::uuid,'합성 기존 원가판','{}',${[evidence.id]}::uuid[],${amount},'inclusive')`;
  await db.admin`update app.charge_cases set current_revision_id=${previous}::uuid where tenant_id=${f.tenant}::uuid and id=${charge}::uuid`;
  await db.admin`update app.charge_cases set current_revision_id=${next}::uuid,version=2,status='adjusted' where tenant_id=${f.tenant}::uuid and id=${charge}::uuid`;
  await db.admin`insert into app.charge_adjustments(tenant_id,id,charge_case_id,previous_revision_id,next_revision_id,direction,amount_minor,reason,liability,decision_id) values(${f.tenant}::uuid,${adjustment}::uuid,${charge}::uuid,${previous}::uuid,${next}::uuid,'increase',25,'change','company',${inner}::uuid)`;
  await db.admin`insert into app.charge_adjustment_evidence_ownership values(${f.tenant}::uuid,${evidence.id}::uuid,${adjustment}::uuid)`;
  await db.admin`insert into app.work_projections(tenant_id,context_id,version,state,decision_id) values(${f.tenant}::uuid,${context}::uuid,7,'{"schedule":"2030-01-01"}',${outer}::uuid)`;
  await db.admin`insert into app.work_command_effects(tenant_id,id,command_id,decision_id,context_id,before_state,after_state,effects) values(${f.tenant}::uuid,${effect}::uuid,${command}::uuid,${outer}::uuid,${context}::uuid,'{}','{"schedule":"2030-01-01"}','[{"kind":"schedule","date":"2030-01-01"}]')`;
  const before=await db.admin`select c.version,c.current_revision_id,r.confirmed_actual_minor from app.charge_cases c join app.charge_revisions r on r.tenant_id=c.tenant_id and r.id=c.current_revision_id where c.tenant_id=${f.tenant}::uuid`;
  await s.drain();await s.drain();assert.equal((await s.read()).json().coverage.appliedCount,2);
  const metadata=await db.admin`select actor_kind,actor_id,policy_version,expected_projection_version from app.business_events where tenant_id=${f.tenant}::uuid`;
  assert.equal(metadata.length,2);for(const row of metadata)assert.deepEqual({...row},{actor_kind:'human_approved',actor_id:f.user,policy_version:'n07-adapter-v1',expected_projection_version:'0'});
  const [projection]=await db.admin`select version,state,decision_id from app.work_projections where tenant_id=${f.tenant}::uuid and context_id=${context}::uuid`;assert.equal(projection!.version,'7');assert.deepEqual(projection!.state,{schedule:'2030-01-01'});assert.equal(projection!.decision_id,outer);
  const after=await db.admin`select c.version,c.current_revision_id,r.confirmed_actual_minor from app.charge_cases c join app.charge_revisions r on r.tenant_id=c.tenant_id and r.id=c.current_revision_id where c.tenant_id=${f.tenant}::uuid`;assert.deepEqual([...after],[...before]);
  assert.equal((await db.admin`select count(*)::int n from app.charge_adjustments where tenant_id=${f.tenant}::uuid`)[0]!.n,1);assert.equal((await db.admin`select count(*)::int n from app.business_events where tenant_id=${f.tenant}::uuid`)[0]!.n,2);
 }finally{await s.cleanup();}
});
