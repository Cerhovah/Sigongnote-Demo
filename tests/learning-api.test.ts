import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';

test('N27 purpose consent, immutable replay, manual classification, isolation, erasure and withdrawal',async()=>{
 const db=await processingFixture();let app:ReturnType<typeof createApp>|undefined;
 try{
  const f=await db.createFixture('합성 업무\n작업: 도장 보완\n하자: 벽 도장\n조치: 다시 방문'),other=await db.createFixture();
  const project=randomUUID(),context=randomUUID();
  await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성 현장')`;
  await db.admin`insert into app.work_contexts(tenant_id,id,project_id,label) values(${f.tenant}::uuid,${context}::uuid,${project}::uuid,'도장 보완')`;
  await db.admin`update app.evidence_organizations set project_id=${project}::uuid,context_id=${context}::uuid,state='linked' where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
  const headers={authorization:'Bearer synthetic','x-tenant-id':f.tenant};
  const get=(url:string,scope=f.tenant)=>app!.inject({url,headers:{...headers,'x-tenant-id':scope}});
  const post=(url:string,payload:object)=>app!.inject({method:'POST',url,headers,payload});
  const cmd=(b:object)=>post('/v1/learning/commands',{command_id:randomUUID(),...b});
  const consent=(allowed:boolean)=>cmd({action:'consent',purpose:'company-improvement-v1',allowed});
  const questions=await get('/v1/work/questions');assert.equal(questions.statusCode,200,questions.body);const q=questions.json().questions.find((q:any)=>q.category==='defect');assert.ok(q,questions.body);
  // Clone only the synthetic input case to exercise independent real command executions.
  const answer=async()=>{
   const id=randomUUID();await db.admin`insert into app.exception_cases(tenant_id,id,cause_key,cause,state) values(${f.tenant}::uuid,${id}::uuid,${id},'other','awaiting_decision')`;
   await db.admin`insert into app.work_decision_cases(tenant_id,id,context_id,project_id,category,issue_key,basis_hash,source_refs,evidence_ids,prompt,proposal) select tenant_id,${id}::uuid,context_id,project_id,category,${id},basis_hash,source_refs,evidence_ids,prompt,proposal from app.work_decision_cases where tenant_id=${f.tenant}::uuid and id=${q.id}::uuid`;
   const payload={command_id:randomUUID(),intent:'answer',targets:[{type:'work_issue',id,version:1}],evidence_refs:q.source_refs,effects:q.proposal.effects,policy_version:1};
   const result=await post('/v1/work-commands',payload);assert.equal(result.statusCode,200,result.body);assert.deepEqual((await post('/v1/work-commands',payload)).json(),result.json());return result.json().decision_id;
  };
  assert.equal((await get('/v1/learning')).json().consent.allowed,false);await answer();
  await post('/v1/work/activity/consent',{allowed:true});await answer();
  assert.equal((await get('/v1/learning')).json().cases.length,0,'usage consent and clicks are not learning permission');
  assert.equal((await consent(true)).statusCode,200);
  const reservation=db.reservation(f,10);const config={...reservation.config,model:'synthetic-model',prompt:'synthetic-prompt-v1',schema:'synthetic-schema-v1',parser:'document-python-v1'};
  await db.worker`select app.reserve_product_ai(${f.tenant}::uuid,${f.user}::uuid,${reservation.id}::uuid,'semantic',${f.source}::uuid,1,${f.revision}::uuid,${reservation.hash},${db.worker.json(config)},10)`;
  const decision=await answer();
  const listed=await get('/v1/learning');assert.equal(listed.headers['cache-control'],'no-store');assert.equal(listed.json().cases.length,1);const c=listed.json().cases[0];assert.equal(c.state,'unreviewed');
  const read=()=>get('/v1/learning/'+c.id);const detail=(await read()).json();assert.equal(detail.ground_truth,false);assert.equal(detail.snapshot.transaction_group,context);assert.deepEqual(detail.answer,q.proposal.effects);assert.equal(detail.snapshot.rule_version,'work-command-v1');assert.equal(detail.evidence[0].id,f.revision);assert.equal(detail.current.effects.length,1);
  const before=(await db.admin`select state from app.work_projections where tenant_id=${f.tenant}::uuid and context_id=${context}::uuid`)[0]!.state;
  assert.equal(detail.trace.length,1);assert.equal(detail.trace[0].model,'synthetic-model');assert.equal(detail.trace[0].cost_known,false);assert.equal(detail.trace[0].cost_minor,'10');assert.ok(!('result' in detail.trace[0]),'raw provider data never exposed');
  const review={action:'review',id:c.id,version:1,state:'new_fact',reason:'이후에 새 작업이 생김',command_id:randomUUID()};assert.equal((await cmd(review)).statusCode,200);assert.equal((await cmd(review)).statusCode,200);assert.equal((await read()).json().ground_truth,false);assert.equal((await read()).json().history.length,1);
  assert.equal((await cmd({...review,command_id:randomUUID(),state:'confirmed'})).statusCode,409);
  assert.equal((await cmd({...review,version:2,command_id:randomUUID(),state:'correction',reason:'제안과 달리 실제 반영한 답이 맞음'})).statusCode,200);assert.equal((await read()).json().ground_truth,true);
  assert.deepEqual((await db.admin`select state from app.work_projections where tenant_id=${f.tenant}::uuid and context_id=${context}::uuid`)[0]!.state,before);
  assert.equal((await get('/v1/learning/'+c.id,other.tenant)).statusCode,404);assert.equal((await db.api`select id from app.decision_examples where learning_consent_id is not null`).length,0);await assert.rejects(db.worker`select id from app.decision_examples`,/permission denied/);
  await db.admin`insert into app.memberships(tenant_id,user_id,role) values(${f.tenant}::uuid,${other.user}::uuid,'owner')`;
  await db.admin`update app.memberships set role='operator' where tenant_id=${f.tenant}::uuid and user_id=${f.user}::uuid`;assert.equal((await read()).statusCode,404);
  await db.admin`update app.memberships set role='owner' where tenant_id=${f.tenant}::uuid and user_id=${f.user}::uuid`;
  const remembered=await post('/v1/owner-policies/commands',{command_id:randomUUID(),action:'remember',decision_id:decision,scope:'once',valid_days:30,max_amount_minor:'0'});assert.equal(remembered.statusCode,200,remembered.body);
  assert.equal((await cmd({action:'delete',id:c.id,version:3})).statusCode,200);assert.equal((await read()).statusCode,404);
  const [scrubbed]=await db.admin`select proposal,answer,result,learning_snapshot,learning_history,learning_reason from app.decision_examples where tenant_id=${f.tenant}::uuid and id=${c.id}::uuid`;assert.deepEqual(scrubbed,{proposal:{},answer:{},result:{},learning_snapshot:{},learning_history:[],learning_reason:null});
  assert.equal((await db.admin`select id from app.decision_examples where tenant_id=${f.tenant}::uuid and learning_consent_id is null`).length,1,'business policy example preserved');
  assert.equal((await db.admin`select id from app.decisions where tenant_id=${f.tenant}::uuid and id=${decision}::uuid`).length,1);
  await answer();await consent(false);assert.equal((await get('/v1/learning')).json().cases.length,0);await consent(true);assert.equal((await get('/v1/learning')).json().cases.length,0,'new consent cannot resurrect old generation');
  await answer();const retained=(await get('/v1/learning')).json().cases[0];await db.admin`update app.decision_examples set created_at=now()-interval '91 days' where tenant_id=${f.tenant}::uuid and id=${retained.id}::uuid`;assert.equal((await get('/v1/learning')).json().cases.length,0);
  await answer();const withdrawn=(await get('/v1/learning')).json().cases[0];await db.admin`insert into app.evidence_retention_tasks(tenant_id,revision_id,source_id,source_generation) values(${f.tenant}::uuid,${f.revision}::uuid,${f.source}::uuid,1)`;
  assert.equal((await get('/v1/learning/'+withdrawn.id)).statusCode,404,'withdrawal blocks immediately before purge');assert.equal((await get('/v1/learning')).json().cases.length,0);
  assert.equal((await db.admin`select learning_state from app.decision_examples where id=${withdrawn.id}::uuid`)[0]!.learning_state,'deleted');
 }finally{await app?.close();await db.cleanup();}
});
