import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {improvementFixture} from './improvement-fixture.js';
import {runLocalShadow} from '../services/api/src/improvements.js';
import {improvedEffects} from '../services/api/src/improvement-runtime.js';
import {readWorkIssues} from '../services/api/src/work-decisions.js';
import {interpretImprovement} from '../packages/domain/src/improvement.js';
import {runAgentOnce} from '../services/api/src/agent-runs.js';

test('N28 fixed held-out and prospective shadow precede owner promotion; frozen runs and rollback preserve effects',async()=>{
 const x=await improvementFixture();try{
  const {db,f}=x,a=await x.add('평가 A'),b=await x.add('평가 B'),initial=await x.report();assert.equal((await db.admin`select tenant_id from app.improvement_heads where tenant_id=${f.tenant}::uuid`).length,0,'reading never enrolls a workspace into background improvement');
  const dataset={action:'dataset',command_id:randomUUID(),case_ids:[a.id,b.id],criteria:initial.criteria};await x.ok(x.command(dataset));await x.ok(x.command(dataset));
  let r=await x.report();assert.equal(r.versions.length,1);const v=r.versions[0];assert.equal(v.state,'awaiting_shadow');assert.equal(v.metrics.test.passed,true);assert.equal(v.metrics.shadow.passed,false);assert.equal(v.metrics.shadow.samples,0);assert.equal(r.head.active_id,null);
  assert.equal((await x.command({action:'promote',id:v.id,head_version:r.head.version})).statusCode,422);
  const [datasetRow]=await db.admin`select members from app.improvement_datasets where tenant_id=${f.tenant}::uuid`;assert.deepEqual(new Set(datasetRow!.members.map((m:any)=>m.split)),new Set(['train','test']));
  const shadow=await x.add('이후 업무 C');await x.ok(x.command({action:'evaluate'}));r=await x.report();assert.equal(r.versions[0].state,'proposed');assert.equal(r.versions[0].metrics.shadow.applied_samples,1);assert.equal(r.head.active_id,null);
  const baselineRun=await x.ok(x.call('/v1/agent/runs',{client_turn_id:randomUUID(),instruction:'합성 작업 확인',input_kind:'text',evidence_refs:[],project_id:x.project}));
  await x.ok(x.command({action:'promote',id:v.id,head_version:r.head.version}));r=await x.report();assert.equal(r.head.active_id,v.id);
  assert.equal((await x.command({action:'rollback',head_version:r.head.version-1,reason:'합성 충돌 검증'})).statusCode,409);
  const after=await x.add('새 작업 D','문틀 재설치',false);assert.equal(after.q.proposal.effects[0].action,'문틀 재설치');assert.equal(after.q.improvement_version,v.id);
  const questions=(await x.ok(x.call('/v1/work/questions'))).questions;assert.ok(!questions.some((q:any)=>[a.context,b.context,shadow.context].includes(q.context_id)),'promotion never reopens answered sources');
  const run=await x.ok(x.call('/v1/agent/runs',{client_turn_id:randomUUID(),instruction:'합성 다음 작업 확인',input_kind:'text',evidence_refs:[],project_id:x.project}));
  const runs=await db.admin`select id,improvement_version from app.agent_runs where tenant_id=${f.tenant}::uuid`;assert.equal(runs.find(z=>z.id===baselineRun.run_id)?.improvement_version,null);assert.equal(runs.find(z=>z.id===run.run_id)?.improvement_version,v.id);
  await db.api.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${f.user},true)`;const baseline=await readWorkIssues(tx,f.tenant,f.user,false,db.config.policy,true,null);assert.equal(baseline.questions.find(z=>z.context_id===after.context)?.proposal.effects[0].action,'임시 방문');const pinned=await readWorkIssues(tx,f.tenant,f.user,false,db.config.policy,true,v.id);assert.equal(pinned.questions.find(z=>z.context_id===after.context)?.proposal.effects[0].action,'문틀 재설치');});
  const before=(await db.admin`select count(*)::int n from app.work_command_effects where tenant_id=${f.tenant}::uuid`)[0]!.n;
  await x.ok(x.command({action:'rollback',head_version:r.head.version,reason:'합성 이전판 복귀'}));r=await x.report();assert.equal(r.head.active_id,null);assert.equal(r.versions[0].state,'rolled_back');
  await db.api.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${f.user},true)`;assert.equal((await improvedEffects(tx,f.tenant,{sourceText:'문틀 재설치',proposal:[{kind:'quality',action:'임시 방문'}]},v.id)).unavailable,true);});
  assert.equal((await db.admin`select count(*)::int n from app.work_command_effects where tenant_id=${f.tenant}::uuid`)[0]!.n,before);
 }finally{await x.close();}
});

test('N28 one budget incident preserves the prior pass across pending candidates and repeated ticks',async()=>{
 const x=await improvementFixture();try{
  const {db,f}=x,a=await x.add('예산 A'),b=await x.add('예산 B');let r=await x.report();await x.ok(x.command({action:'dataset',case_ids:[a.id,b.id],criteria:r.criteria}));await x.add('예산 그림자 C');await x.ok(x.command({action:'evaluate'}));r=await x.report();const prior=r.versions[0].id;
  await x.ok(x.command({action:'promote',id:prior,head_version:r.head.version}));
  // Copy this genuinely evaluated synthetic pass to prepare the two-version incident graph.
  const current=randomUUID();for(const [i,id] of [current,randomUUID(),randomUUID()].entries())await db.admin`insert into app.improvement_versions(tenant_id,id,dataset_id,spec,state,metrics,shadow_members,fingerprint) select tenant_id,${id}::uuid,dataset_id,spec,${i===0?'proposed':'evaluating'},metrics,shadow_members,${String(i).repeat(64)} from app.improvement_versions where tenant_id=${f.tenant}::uuid and id=${prior}::uuid`;
  r=await x.report();await x.ok(x.command({action:'promote',id:current,head_version:r.head.version}));
  const run=await x.ok(x.call('/v1/agent/runs',{client_turn_id:randomUUID(),instruction:'예산 복귀 안내 합성',input_kind:'text',evidence_refs:[],project_id:x.project}));
  const services={db:db.api,capturePolicy:db.config.policy} as Parameters<typeof runLocalShadow>[0];await runLocalShadow(services,f.tenant,f.user,current,a.id,{name:'synthetic-incident',kind:'local',predict:async(input,spec)=>interpretImprovement(input,spec)},new AbortController().signal);
  r=await x.report();await x.ok(x.command({action:'delegation',head_version:r.head.version,delegation:{...r.head.delegation,max_calls:2}}));
  for(let i=0;i<3;i++){await x.ok(x.command({action:'evaluate'}));r=await x.report();assert.equal(r.head.active_id,prior);assert.equal(r.versions.find((v:any)=>v.id===prior).state,'active');}
  assert.equal(r.versions.filter((v:any)=>v.state==='rejected').length,2);assert.equal(r.versions.find((v:any)=>v.id===current).state,'rolled_back');
  assert.equal(await runAgentOnce(services,{},f.tenant),'blocked');const message=await x.ok(x.call('/v1/agent/runs/'+run.run_id));assert.match(message.answer,/해석 기준이 바뀌어 멈췄어요/);assert.doesNotMatch(message.answer,/처리 권한/);
 }finally{await x.close();}
});

test('N28 local shadow is durable, label-free, cancellable and cannot change protected effects; budget and consent fence results',async()=>{
 const x=await improvementFixture();try{
  const {db,f}=x,a=await x.add('지역 A'),b=await x.add('지역 B');let r=await x.report();await x.ok(x.command({action:'dataset',case_ids:[a.id,b.id],criteria:r.criteria}));r=await x.report();const id=r.versions[0].id,services={db:db.api} as Parameters<typeof runLocalShadow>[0];let calls=0;
  const port={name:'synthetic-local',kind:'local' as const,async predict(input:any,spec:any){calls++;assert.equal('expected' in input,false);assert.equal('answer' in input,false);return interpretImprovement(input,spec);}};
  assert.equal(await runLocalShadow(services,f.tenant,f.user,id,a.id,port,new AbortController().signal),'completed');assert.equal(await runLocalShadow(services,f.tenant,f.user,id,a.id,port,new AbortController().signal),'not_repeated');assert.equal(calls,1);
  const bad={...port,name:'synthetic-protected',async predict(){return {effects:[{kind:'schedule' as const,date:'2027-01-01'}],confidence:1};}};assert.equal(await runLocalShadow(services,f.tenant,f.user,id,a.id,bad,new AbortController().signal),'rejected');
  const controller=new AbortController();const hung=runLocalShadow(services,f.tenant,f.user,id,a.id,{...port,name:'synthetic-hung',async predict(){controller.abort();return new Promise<never>(()=>{});}},controller.signal);assert.equal(await hung,'unknown');assert.equal(await runLocalShadow(services,f.tenant,f.user,id,a.id,{...port,name:'synthetic-hung'},new AbortController().signal),'not_repeated');
  r=await x.report();assert.equal(r.usage.calls,4);assert.equal(r.usage.unknown,2);assert.equal(r.versions[0].state,'awaiting_shadow','local port cannot promote itself');
  const withheld={...port,name:'synthetic-withdraw',async predict(input:any,spec:any){await x.ok(x.learn({action:'delete',id:a.id,version:a.version}));return interpretImprovement(input,spec);}};
  assert.equal(await runLocalShadow(services,f.tenant,f.user,id,a.id,withheld,new AbortController().signal),'withdrawn');assert.equal((await x.report()).versions.length,0);
  await db.api`select app.purge_improvements()`;const [erased]=await db.admin`select spec,metrics from app.improvement_versions where tenant_id=${f.tenant}::uuid and id=${id}::uuid`;assert.deepEqual(erased!.spec.rules,[]);assert.deepEqual(erased!.metrics,{});
  const other=await db.createFixture();assert.equal((await x.call('/v1/improvements',undefined,other.tenant)).statusCode,404);assert.equal((await db.api`select id from app.improvement_versions`).length,0);await assert.rejects(db.worker`select id from app.improvement_versions`,/permission denied/);
  await db.api.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${f.user},true)`;assert.equal((await tx`select app.improvement_budget_usage(${f.tenant}::uuid) value`)[0]!.value.calls,5,'hidden/deleted samples cannot reset daily experiment usage');});
 }finally{await x.close();}
});

test('N28 delegation is exact criteria only and an observed important error invalidates an active version immediately',async()=>{
 const x=await improvementFixture();try{
  const {db,f}=x,a=await x.add('위임 A'),b=await x.add('위임 B');let r=await x.report();await x.ok(x.command({action:'delegation',head_version:r.head.version,delegation:{...r.head.delegation,allowed:true}}));
  await x.ok(x.command({action:'dataset',case_ids:[a.id,b.id],criteria:r.criteria}));const v=(await x.report()).versions[0];await x.add('위임 이후 C');await x.ok(x.command({action:'evaluate'}));r=await x.report();assert.equal(r.head.active_id,v.id);
  const changed=await x.add('사용 후 D','임시 방문');assert.equal(changed.q.improvement_version,v.id);r=await x.report();assert.equal(r.head.active_id,null,'manual important correction blocks before a later timer tick');
  const [effects]=await db.admin`select count(*)::int n from app.work_command_effects where tenant_id=${f.tenant}::uuid`;assert.equal(effects!.n,4);
  // A changed criterion creates a separate immutable dataset, not an in-place relaxation.
  await x.ok(x.command({action:'dataset',case_ids:[a.id,b.id],criteria:{...r.criteria,min_shadow_groups:2}}));await x.add('새 기준 E');await x.add('새 기준 F');await x.ok(x.command({action:'evaluate'}));r=await x.report();const proposed=r.versions.find((z:any)=>z.id!==v.id);assert.equal(proposed.state,'proposed');assert.equal(r.head.active_id,null,'default delegation cannot approve a different criteria object');
  await x.ok(x.command({action:'promote',id:proposed.id,head_version:r.head.version}));r=await x.report();await x.ok(x.command({action:'delegation',head_version:r.head.version,delegation:{...r.head.delegation,max_calls:2}}));await x.ok(x.command({action:'evaluate'}));assert.equal((await x.report()).head.active_id,null,'exceeded separate experiment budget rolls active version back');
 }finally{await x.close();}
});
