import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {improvementFixture} from './improvement-fixture.js';
import {runAgentOnce} from '../services/api/src/agent-runs.js';
import type {ProductAiConfig} from '../services/api/src/product-ai-config.js';
import {EvidenceSearchSchema} from '../services/api/src/evidence-search.js';
import {isolatedProcessingDatabase} from './isolated-processing-db.js';
let isolated:Awaited<ReturnType<typeof isolatedProcessingDatabase>>;
before(async()=>{isolated=await isolatedProcessingDatabase();});
after(async()=>{await isolated?.close();});
const config:ProductAiConfig={provider:'openai',key:'internal-fixture',model:'internal-test',price:{version:'test',provider:'openai',model:'internal-test',input_krw_per_million:100,output_krw_per_million:100,valid_until:'2099-01-01T00:00:00Z',conversion_note:'internal fixture only'},maxOutputTokens:4096};
async function fixture(){
 const x=await improvementFixture(isolated.name),services={db:x.db.api,capturePolicy:x.db.config.policy,verifyToken:async()=>({userId:x.f.user,sessionId:x.f.session})};
 const report=async()=>(await x.report()).strategies;
 const start=async(instruction='합성 검색 요청')=>(await x.ok(x.call('/v1/agent/runs',{client_turn_id:randomUUID(),instruction,input_kind:'text',evidence_refs:[],project_id:x.project}))).run_id;
 const execute=async(input:object,done=true)=>runAgentOnce(services,{config,model:async()=>({value:{calls:[{tool:'search_evidence',input:JSON.stringify(input)}],done,missing:'none'},inputTokens:20,outputTokens:20,receipt:'internal synthetic'})},x.f.tenant);
 const add=async(label:string,scope='search')=>{
  const data=await x.add(label,'문틀 재설치',false),run=await start(scope==='search'?'합성 검색 요청':'처리 항목');
  assert.equal(await execute(scope==='search'?{query:'가상별칭',context_id:data.context}:EvidenceSearchSchema.parse({query:'가상별칭',project_id:x.project})),'stored');
  const payload={action:'strategy.case',scope,run_id:run,sequence:1,context_id:data.context,expected:scope==='search'?{tool:'search_evidence',query:'문틀'}:{tool:'list_exceptions',query:''},evidence_refs:[data.revision],confirmed:true};
  const saved=await x.ok(x.command(payload));return {...data,id:saved.id,run,payload};
 };
 const candidate=async(scope='search')=>{const a=await add('A '+scope,scope),b=await add('B '+scope,scope);await x.ok(x.command({action:'strategy.dataset',scope,case_ids:[a.id,b.id]}));const v=(await report()).versions.find((v:any)=>v.scope===scope);assert.equal(v.state,'awaiting_shadow');assert.equal(v.metrics.test.passed,true);await add('C '+scope,scope);await x.ok(x.command({action:'strategy.evaluate'}));assert.equal((await report()).versions.find((z:any)=>z.id===v.id).state,'proposed');return {a,b,v};};
 const promote=async(id:string,scope='search')=>{const h=(await report()).heads.find((h:any)=>h.scope===scope);assert.equal((await x.ok(x.command({action:'strategy.promote',scope,id,head_version:h.version}))).saved,true);};
 return {...x,report,start,execute,add,candidate,promote,services};
}
test('search strategy compares actual held-out retrieval, awaits independent later work, pins runs, and withdraws without effects',async()=>{
 const x=await fixture();try{const {db,f}=x,a=await x.add('검색 A'),b=await x.add('검색 B');
 const preview=await x.ok(x.command({action:'strategy.preview',scope:'search',run_id:a.run,sequence:1,query:'문틀'}));assert.deepEqual(preview.cards.map((c:any)=>c.revision_id),[a.revision]);
 assert.equal((await x.command({...a.payload,context_id:b.context})).statusCode,404,'a selected label cannot change the source work group');
 const broad=await x.start();await x.execute({query:'가상별칭'});assert.equal((await x.command({...a.payload,run_id:broad})).statusCode,400,'partial result labels cannot create an impossible exact-set evaluation');
 const dataset={action:'strategy.dataset',scope:'search',case_ids:[a.id,b.id],command_id:randomUUID()};await x.ok(x.command(dataset));await x.ok(x.command(dataset));let r=await x.report();assert.equal(r.versions.length,1);const v=r.versions[0];assert.equal(v.state,'awaiting_shadow');assert.equal(v.metrics.test.passed,true);assert.equal(v.metrics.shadow.samples,0);const calls=r.usage.calls;
 for(let i=0;i<2;i++)await x.ok(x.command({action:'strategy.evaluate'}));assert.equal((await x.report()).usage.calls,calls,'waiting alone performs no repeated comparisons');
 assert.equal((await x.command({action:'strategy.promote',scope:'search',id:v.id,head_version:1})).statusCode,422);
 await x.add('検索 C');await x.ok(x.command({action:'strategy.evaluate'}));assert.equal((await x.report()).versions[0].state,'proposed');
 const before=await x.start();await x.promote(v.id);const execution=await x.execute({query:'가상별칭',context_id:a.context});
 const diagnostic=execution==='stored'?[]:await db.admin`select status,error_code,planner_mode,lease_until,tool_count,rounds from app.agent_runs where tenant_id=${f.tenant}::uuid and id=${before}::uuid`;
 assert.equal(execution,'stored',JSON.stringify(diagnostic));
 const [oldStep]=await db.admin`select input,result from app.agent_steps where tenant_id=${f.tenant}::uuid and run_id=${before}::uuid`;assert.equal(oldStep!.input.query,'가상별칭');assert.equal(oldStep!.result.cards.length,0);
 const after=await x.start();assert.equal(await x.execute({query:'가상별칭',context_id:a.context}),'stored');const [step]=await db.admin`select input,result from app.agent_steps where tenant_id=${f.tenant}::uuid and run_id=${after}::uuid`;assert.equal(step!.input.query,'문틀');assert.deepEqual(step!.result.cards.map((c:any)=>c.revision_id),[a.revision]);
 const parked=await x.start();assert.equal(await x.execute({query:'가상별칭',context_id:a.context},false),'limited');const [child]=await db.admin`select strategy_versions from app.agent_runs where tenant_id=${f.tenant}::uuid and parent_run_id=${parked}::uuid`;assert.equal(child!.strategy_versions.search,v.id);
 const other=await db.createFixture();assert.equal((await x.call('/v1/improvements',undefined,other.tenant)).statusCode,404);assert.equal((await db.api`select * from app.strategy_cases`).length,0);await assert.rejects(db.worker`select * from app.strategy_versions`,/permission denied/);
 await x.ok(x.command({action:'strategy.delete',id:a.id}));r=await x.report();assert.equal(r.heads.find((h:any)=>h.scope==='search').active_id,null);assert.equal(r.versions[0].spec,null);assert.equal((await x.call('/v1/agent/runs/'+parked+'/continue',{})).statusCode,409);
 const [purged]=await db.admin`select instruction,input from app.strategy_cases where tenant_id=${f.tenant}::uuid and id=${a.id}::uuid`;assert.equal(purged!.instruction,'');assert.deepEqual(purged!.input,{});assert.ok((await x.report()).usage.calls>calls,'erasure cannot reset usage');
 assert.equal((await db.admin`select count(*)::int n from app.work_command_effects where tenant_id=${f.tenant}::uuid`)[0]!.n,0);
 }finally{await x.close();}
});
test('read-tool strategy uses real prior steps, applies only approved read routing, and correction rolls back immediately',async()=>{
 const x=await fixture();try{const {db,f}=x,{a,v}=await x.candidate('tool_selection');await x.promote(v.id,'tool_selection');const run=await x.start('처리 항목');assert.equal(await runAgentOnce(x.services,{},f.tenant),'stored','actual local search planner defaults use approved routing');
 const [step]=await db.admin`select tool,input,result from app.agent_steps where tenant_id=${f.tenant}::uuid and run_id=${run}::uuid`;assert.equal(step!.tool,'list_exceptions');assert.ok(step!.result.questions.length>0);assert.deepEqual(step!.input,{});
 const report=await x.report();assert.equal(report.heads.find((h:any)=>h.scope==='search').active_id,null);
 await x.ok(x.command({...a.payload,run_id:run,expected:{tool:'get_artifact',query:''}}));assert.equal((await x.report()).heads.find((h:any)=>h.scope==='tool_selection').active_id,null);
 await x.ok(x.learn({action:'consent',purpose:'company-improvement-v1',allowed:false}));assert.equal((await x.report()).cases.length,0);assert.equal((await x.report()).versions[0].spec,null);
 }finally{await x.close();}
});
test('strategy budget counts application-boundary repeats and preserves prior pass once per incident',async()=>{
 const x=await fixture();try{const {db,f}=x,{v}=await x.candidate();await x.promote(v.id);const current=randomUUID();await db.admin`insert into app.strategy_versions(tenant_id,id,scope,members,shadow_members,spec,metrics,fingerprint,state,created_at) select tenant_id,${current}::uuid,scope,members,shadow_members,spec,metrics,${'1'.repeat(64)},'proposed',created_at from app.strategy_versions where tenant_id=${f.tenant}::uuid and id=${v.id}::uuid`;const before=(await x.report()).usage.calls;await x.promote(current);assert.ok((await x.report()).usage.calls>before);
 const next=randomUUID();await db.admin`insert into app.strategy_versions(tenant_id,id,scope,members,shadow_members,spec,metrics,fingerprint,state,created_at) select tenant_id,${next}::uuid,scope,members,shadow_members,spec,metrics,${'2'.repeat(64)},'proposed',created_at from app.strategy_versions where tenant_id=${f.tenant}::uuid and id=${v.id}::uuid`;
 await db.admin`update app.strategy_evaluations set attempts=100 where tenant_id=${f.tenant}::uuid`;
 for(let i=0;i<2;i++){const h=(await x.report()).heads.find((h:any)=>h.scope==='search');assert.equal((await x.ok(x.command({action:'strategy.promote',scope:'search',id:next,head_version:h.version}))).saved,false);assert.equal((await x.report()).heads.find((h:any)=>h.scope==='search').active_id,v.id);}
 }finally{await x.close();}
});
