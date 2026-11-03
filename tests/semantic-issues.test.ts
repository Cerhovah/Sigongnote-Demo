import {runOwnerMemory} from '../services/api/src/owner-memory.js';
import {runParseOnce} from '../services/api/src/parse-worker.js';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {validateSemanticCandidates} from '../packages/domain/src/semantic-candidates.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {semanticWorkSignals} from '../services/api/src/semantic-issues.js';
import type {OperationalFact} from '../services/api/src/normal-facts.js';
import {processingFixture} from './processing-fixture.js';
import {reserveProductAi,submitProductAi,finishProductAi} from '../services/api/src/product-ai.js';
import {promoteSemanticOnce} from '../services/api/src/semantic-promotion.js';
import {createApp} from '../services/api/src/app.js';
const subject=randomUUID(),context=randomUUID();
const fact=(kind:string,value:string,quote:string):OperationalFact=>({id:randomUUID(),revision:randomUUID(),version:'a'.repeat(64),transaction_key:randomUUID(),organization_version:1,context_id:context,project_id:randomUUID(),semantic:{eventKind:kind,assertionStatus:'asserted',quantity:{value,unitCode:'ea'},subject:{kind:'item_instance',mention:'합성물품'},entityCoverage:'complete',entityLinks:[{mentionId:'item_instance:합성물품',status:'linked',targetId:subject}],evidence:[{quote}]}});
test('N12 observed requests and dispatch are not receipts; actual shortages group once and normal totals stay hidden',()=>{
 const o=fact('acceptance','30','발주 30개 합의'),r=fact('receipt','28','28개 인수');
 assert.deepEqual(semanticWorkSignals([fact('request','30','30개 요청'),r],'2030-01-01'),[]);
 assert.deepEqual(semanticWorkSignals([o,fact('dispatch','28','28개 출고')],'2030-01-01'),[]);
 const signals=semanticWorkSignals([o,r,{...r,id:randomUUID()}],'2030-01-01');assert.equal(signals.length,1);assert.equal(signals[0]!.automatic,false);assert.deepEqual(signals[0]!.effects,[{kind:'acceptance',ordered:'30',quantity:'28',unit:'개'}]);
 assert.equal(semanticWorkSignals([o,{...r,semantic:{...r.semantic,quantity:{value:'30',unitCode:'ea'}}}],'2030-01-01')[0]!.automatic,true);
 const conflict={...r,id:randomUUID(),semantic:{...r.semantic,quantity:{value:'29',unitCode:'ea'}}};assert.ok(semanticWorkSignals([o,r,conflict],'2030-01-01')[0]!.blocked);
 const cancel={...r,id:randomUUID(),semantic:{...r.semantic,eventKind:'cancellation'}};assert.deepEqual(semanticWorkSignals([o,r,cancel],'2030-01-01')[0]!.effects,[]);
});
test('N12 agreed schedules use Korean date; inspection and agreed money remain separate from requests',()=>{
 const before=fact('acceptance','1','2029-12-30 일정 합의'),after=fact('acceptance','1','2030-01-01 새 일정 합의');before.semantic.effectiveAt='2029-12-29T15:00:00Z';after.semantic.effectiveAt='2029-12-31T15:00:00Z';
 assert.deepEqual(semanticWorkSignals([before,after],'2030-01-01')[0]!.effects,[{kind:'schedule',date:'2030-01-01'}]);
 const defect=fact('inspection','1','하자 보완, 다시 방문');defect.semantic.object={role:'remedy',mention:'다시 방문'};assert.equal(semanticWorkSignals([defect],'2030-01-01')[0]!.category,'defect');
 const cost=fact('request','1','변경 추가비 회사 부담');cost.semantic.amount={knowledge:'known',minor:'50000'};assert.equal(semanticWorkSignals([cost],'2030-01-01').length,0);cost.semantic.eventKind='acceptance';assert.equal(semanticWorkSignals([cost],'2030-01-01')[0]!.cost,'50000');cost.semantic.amount.knowledge='unknown';assert.equal(semanticWorkSignals([cost],'2030-01-01').length,0);
});
test('N12 stored semantic proof becomes a current question and one answer; withdrawal hides stale text',async()=>{
 const db=await processingFixture();let app:ReturnType<typeof createApp>|undefined;
 try{
  const text='합성현장 점검 결과 하자 보완, 다시 방문',f=await db.createFixture(text),project=randomUUID(),context=randomUUID();
  await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성현장')`;
  await db.admin`insert into app.work_contexts(tenant_id,id,project_id,label) values(${f.tenant}::uuid,${context}::uuid,${project}::uuid,'하자 보완')`;
  const order=randomUUID(),bundle=randomUUID();
  await db.admin`insert into app.work_orders(tenant_id,id,project_id,display_name) values(${f.tenant}::uuid,${order}::uuid,${project}::uuid,'합성계약')`;
  await db.admin`insert into app.work_bundles(tenant_id,id,work_order_id,display_name,trade_pack_id,trade_pack_version,trade_pack_hash) values(${f.tenant}::uuid,${bundle}::uuid,${order}::uuid,'하자 보완','construction','1.0.0',${'a'.repeat(64)})`;
  await db.admin`update app.work_contexts set bundle_id=${bundle}::uuid where tenant_id=${f.tenant}::uuid and id=${context}::uuid`;
  await db.admin`update app.evidence_organizations set state='linked',project_id=${project}::uuid,project_candidates=${[project]}::uuid[],context_id=${context}::uuid,version=version+1 where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  const [chunk]=await db.admin`select * from app.evidence_chunks where tenant_id=${f.tenant}::uuid and job_id=${f.job}::uuid order by ordinal limit 1`;assert.ok(chunk);
  const reservation={...db.reservation(f,100),config:{...db.config,index_job:f.job,first_ordinal:chunk.ordinal,last_ordinal:chunk.ordinal,model:'internal-fixture',prompt:'candidate-evidence-v1'}};
  const candidate={key:'inspection',eventKind:'inspection',actor:null,subject:{kind:'project',mention:'합성현장',role:null},predicate:'inspection',object:{kind:'unknown',mention:'다시 방문',role:'remedy'},quantity:null,amount:null,effectiveAt:null,assertion:{polarity:'positive',modality:'actual',speech:'direct',speaker:null},evidence:[{indexJobId:f.job,ordinal:chunk.ordinal,contentHash:chunk.content_hash,locator:chunk.locator,quote:text}],uncertaintyReasons:[]};
  const output={semanticCandidates:{schemaVersion:'semantic-candidates-v1',modelVersion:'internal-fixture',promptVersion:'candidate-evidence-v1',candidates:[candidate]}};
  await reserveProductAi(db.worker,reservation);await submitProductAi(db.worker,reservation);await finishProductAi(db.worker,reservation,1,output,'internal-test',{});assert.equal(await promoteSemanticOnce({db:db.worker,policy:db.config.policy,tenantScope:f.tenant}),true);
  app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session}),storage:{async sign(){return 'https://storage.invalid/synthetic?token=synthetic-opaque-upload-signature';},async verify(){return {matches:true,sniffedMime:'text/plain'};},async remove(){}}});const headers={authorization:'Bearer test','x-tenant-id':f.tenant};
  const list=()=>app!.inject({method:'GET',url:'/v1/work/questions',headers});let response=await list();assert.equal(response.statusCode,200,response.body);assert.equal(response.json().questions.length,1,response.body);const q=response.json().questions[0];assert.ok(q.proposal.semantic_basis);
  response=await app.inject({method:'POST',url:'/v1/work/replies',headers,payload:{command_id:randomUUID(),question_id:q.id,question_version:q.version,text:'이대로 반영'}});assert.equal(response.statusCode,200,response.body);assert.ok(response.json().decision_id,response.body);
  assert.equal((await list()).json().questions.length,0);
  const decision=response.json().decision_id;
  const post=(value:any)=>app!.inject({method:'POST',url:'/v1/owner-policies/commands',headers,payload:{command_id:randomUUID(),...value}});
  const once=await post({action:'remember',decision_id:decision,scope:'once',valid_days:30,max_amount_minor:'0'});assert.equal(once.statusCode,200,once.body);assert.equal(once.json().automatic,false);
  const remembered=await post({action:'remember',decision_id:decision,scope:'contract',valid_days:30,max_amount_minor:'0'});assert.equal(remembered.statusCode,200,remembered.body);assert.equal(remembered.json().qualification_required,true);
  const policy=remembered.json();const [saved]=await db.admin`select scope_type,scope_id from app.owner_policies where tenant_id=${f.tenant}::uuid and id=${policy.id}::uuid`;assert.equal(saved!.scope_type,'contract');assert.equal(saved!.scope_id,order);
  const currentPolicy=remembered;
  const qualify={action:'qualify',id:currentPolicy.json().id,version:1,sample_decisions:[decision],note:'실제 답변과 근거를 확인한 내부 시험 사례'};
  assert.equal((await post({...qualify,sample_decisions:[randomUUID()]})).statusCode,400);
  const qualified=await post(qualify);assert.equal(qualified.statusCode,200,qualified.body);assert.equal(qualified.json().qualified,true);
  assert.equal((await post({action:'revise',id:currentPolicy.json().id,version:2,valid_days:30,max_amount_minor:'0',effects:[{kind:'quality',action:'다른 조치'}]})).statusCode,400);
  assert.equal((await post({action:'revise',id:currentPolicy.json().id,version:2,valid_days:40,max_amount_minor:'0'})).statusCode,200);
  const view=await app.inject({method:'GET',url:'/v1/owner-policies',headers});assert.equal(view.statusCode,200,view.body);assert.ok(view.json().policies.find((p:any)=>p.id===currentPolicy.json().id).semantic_qualification);
  // A second original with different wording reaches the same typed condition and applies once.
  const nextText='합성현장 다른 표현의 점검 결과 하자 보완, 다시 방문',bytes=Buffer.from(nextText),digest=createHash('sha256').update(bytes).digest('hex');
  const uploadHeaders={...headers,'idempotency-key':randomUUID()},prepared=await app.inject({method:'POST',url:'/v1/ingestions',headers:uploadHeaders,payload:{client_capture_id:randomUUID(),source_id:f.source,source_generation:1,sha256:digest,byte_length:bytes.length,declared_mime:'text/plain'}});assert.equal(prepared.statusCode,201,prepared.body);
  const complete=await app.inject({method:'POST',url:'/v1/ingestions/'+prepared.json().ingestion_id+'/complete',headers:{...headers,'idempotency-key':randomUUID()},payload:{sha256:digest,byte_length:bytes.length}});assert.equal(complete.statusCode,200,complete.body);const next={...f,revision:complete.json().revision_id,job:complete.json().job_id};
  assert.equal(await runParseOnce({db:db.worker,policy:db.config.policy,tenantScope:f.tenant,python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker'),download:async()=>bytes}),'stored');
  await db.admin`update app.evidence_organizations set state='linked',project_id=${project}::uuid,project_candidates=${[project]}::uuid[],context_id=${context}::uuid,version=version+1 where tenant_id=${f.tenant}::uuid and revision_id=${next.revision}::uuid`;
  const [newChunk]=await db.admin`select * from app.evidence_chunks where tenant_id=${f.tenant}::uuid and job_id=${next.job}::uuid order by ordinal limit 1`;
  const nextReservation={...db.reservation(next,100),config:{...db.config,index_job:next.job,first_ordinal:newChunk!.ordinal,last_ordinal:newChunk!.ordinal,model:'internal-fixture',prompt:'candidate-evidence-v1'}};
  const newOutput={semanticCandidates:{...output.semanticCandidates,candidates:[{...candidate,evidence:[{indexJobId:next.job,ordinal:newChunk!.ordinal,contentHash:newChunk!.content_hash,locator:newChunk!.locator,quote:nextText}]}]}};
  await reserveProductAi(db.worker,nextReservation);await submitProductAi(db.worker,nextReservation);await finishProductAi(db.worker,nextReservation,1,newOutput,'internal-test-next',{});assert.equal(await promoteSemanticOnce({db:db.worker,policy:db.config.policy,tenantScope:f.tenant}),true);
  await runOwnerMemory(db.api,()=>false,db.config.policy);await runOwnerMemory(db.api,()=>false,db.config.policy);
  const [applied]=await db.admin`select count(*)::int n from app.decisions where tenant_id=${f.tenant}::uuid and actor_kind='system'`;assert.equal(applied!.n,1);
  await db.admin`update app.capture_sources set server_upload_consent=false,active=false,revoked_at=now(),generation=generation+1 where tenant_id=${f.tenant}::uuid and id=${f.source}::uuid`;
  assert.equal((await list()).json().questions.length,0);
  const withdrawn=await app.inject({method:'GET',url:'/v1/owner-policies',headers});assert.equal(withdrawn.statusCode,200);assert.doesNotMatch(withdrawn.body,/다시 방문/);
 }finally{if(app)await app.close();await db.cleanup();}
});


test('N12 validated future agreement asks about a schedule without asserting completion; typed quantities reach a material question',()=>{
 const job=randomUUID(),revision=randomUUID(),tenant=randomUUID(),hash='a'.repeat(64);
 function validated(kind:string,quote:string,quantity:string|null,date:string|null,key:string){
  const raw={key,eventKind:kind,actor:null,subject:{kind:'item_instance',mention:'합성물품',role:null},predicate:kind,object:null,quantity:quantity?{value:quantity,unitCode:'ea'}:null,amount:null,effectiveAt:date,assertion:{polarity:'positive',modality:'actual',speech:'direct',speaker:null},evidence:[{indexJobId:job,ordinal:0,contentHash:hash,locator:'p:1',quote}],uncertaintyReasons:[]};
  const result=validateSemanticCandidates({schemaVersion:'semantic-candidates-v1',modelVersion:'test',promptVersion:'test',candidates:[raw]},{tenantId:tenant,revisionId:revision,indexJobId:job,observedAt:'2030-01-01T00:00:00Z',modelVersion:'test',promptVersion:'test',chunks:[{ordinal:0,contentHash:hash,locator:'p:1',text:quote,active:true}]}).candidates[0]!;
  const f=fact(kind,quantity??'0',quote);f.semantic={...result,entityCoverage:'complete',entityLinks:f.semantic.entityLinks};return f;
 }
 const before=validated('acceptance','합성물품 2029-12-30 일정 합의',null,'2029-12-29T15:00:00Z','before'),after=validated('acceptance','합성물품 2030-01-02 일정으로 하기로 합의',null,'2030-01-01T15:00:00Z','after');
 assert.equal(after.semantic.assertionStatus,'unasserted');assert.ok(after.semantic.uncertaintyReasons.includes('future_effective_time'));
 assert.equal(semanticWorkSignals([before,after],'2030-01-01')[0]!.category,'schedule');
 const conditional=validated('acceptance','가능하면 합성물품 2030-01-02 일정으로 합의',null,'2030-01-01T15:00:00Z','conditional');assert.equal(semanticWorkSignals([before,conditional],'2030-01-01').length,0);
 const order=validated('acceptance','합성물품 30개 합의','30',null,'order'),receipt=validated('receipt','합성물품 28개 인수','28',null,'receipt');
 const material=semanticWorkSignals([order,receipt],'2030-01-01');assert.equal(material.length,1);assert.equal(material[0]!.category,'material');assert.equal(material[0]!.automatic,false);
});

test('N13 same remedy merges all proof; missing or tied times never choose a different remedy by UUID',()=>{
 const one=fact('inspection','1','점검 하자 보완 다시 방문');one.semantic.object={role:'remedy',mention:'다시 방문'};
 const two={...one,id:randomUUID(),revision:randomUUID()};const same=semanticWorkSignals([two,one],'2030-01-01');assert.equal(same[0]!.facts.length,2);
 const other={...two,semantic:{...two.semantic,object:{role:'remedy',mention:'재도장'},evidence:[{quote:'점검 하자 보완 재도장'}]}};
 for(const inputs of [[one,other],[other,one]]){const conflict=semanticWorkSignals(inputs,'2030-01-01')[0]!;assert.ok(conflict.blocked);assert.equal(conflict.facts.length,2);assert.deepEqual(conflict.effects,[]);}
 one.semantic.observedAt='2030-01-01T00:00:00Z';other.semantic.observedAt=one.semantic.observedAt;assert.ok(semanticWorkSignals([one,other],'2030-01-01')[0]!.blocked);
 other.semantic.observedAt='2030-01-02T00:00:00Z';assert.deepEqual(semanticWorkSignals([one,other],'2030-01-02')[0]!.effects,[{kind:'quality',action:'재도장'}]);
});
