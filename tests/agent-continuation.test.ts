import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
import {inAuthorizedTransaction} from '../services/api/src/auth.js';
import {runAgentOnce,drainAgentTasks} from '../services/api/src/agent-runs.js';
import {agentConfiguration,type ProductAiConfig} from '../services/api/src/product-ai-config.js';
import {buildReadiness} from '../services/api/src/readiness.js';
import {workHttp,WorkRequestSchema} from '../packages/contracts/src/index.js';
import {isolatedProcessingDatabase} from './isolated-processing-db.js';
let isolated:Awaited<ReturnType<typeof isolatedProcessingDatabase>>;
before(async()=>{isolated=await isolatedProcessingDatabase();});
after(async()=>{await isolated?.close();});
const config:ProductAiConfig={provider:'openai',key:'internal-test-no-provider-key',model:'internal-test',price:{version:'test',provider:'openai',model:'internal-test',input_krw_per_million:100,output_krw_per_million:100,valid_until:'2099-01-01T00:00:00Z',conversion_note:'internal fixture only'},maxOutputTokens:4096};
const call={tool:'search_evidence' as const,input:JSON.stringify({query:'석고보드'})};
const result=(calls=[call],done=true)=>({value:{calls,done,missing:'none' as const},inputTokens:20,outputTokens:20,receipt:'internal synthetic'});

test('continuation retains paid plan tail, scope, feedback, usage and root history without duplicate starts',async()=>{
 const db=await processingFixture(isolated.name);let app:ReturnType<typeof createApp>|undefined;
 try{const f=await db.createFixture(),other=await db.createFixture();
 const services={db:db.api,agentRuntime:true,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})};app=createApp(services);
 const headers={authorization:'Bearer test','x-tenant-id':f.tenant};
 const start=async(refs:string[]=[])=>{const response=await app!.inject({method:'POST',url:'/v1/agent/runs',headers,payload:{client_turn_id:randomUUID(),instruction:'자료 확인',input_kind:'text',evidence_refs:refs}});assert.equal(response.statusCode,202,response.body);return response.json().run_id;};
 const read=async(id:string)=>(await app!.inject({method:'GET',url:`/v1/agent/runs/${id}`,headers})).json();
 const resume=(id:string)=>app!.inject({method:'POST',url:`/v1/agent/runs/${id}/continue`,headers,payload:{}});
 const root=await start();let modelCalls=0;
 const options={config,model:async()=>{modelCalls++;return result(Array(modelCalls===1?7:3).fill(call),modelCalls!==1);}};
 assert.equal(await runAgentOnce(services,options,f.tenant),'limited');
 const first=await read(root);assert.equal(first.coverage.tools,8);assert.equal(first.usage_summary.calls,2);assert.ok(first.next_job);assert.equal(first.run_id,root);
 assert.equal(await runAgentOnce(services,options,f.tenant),'idle','parked jobs require one explicit continuation');
 assert.equal((await app.inject({method:'POST',url:`/v1/agent/runs/${root}/continue`,headers:{...headers,'x-tenant-id':other.tenant},payload:{}})).statusCode,404);
 const resumed=await Promise.all([resume(root),resume(root)]);assert.ok(resumed.every(r=>r.statusCode===202));assert.equal(resumed[0]!.json().run_id,first.next_job.id);assert.equal(resumed[1]!.json().run_id,first.next_job.id);
 assert.equal(await runAgentOnce(services,options,f.tenant),'stored');assert.equal(modelCalls,2,'paid tail is reused');
 const final=await read(root);assert.equal(final.coverage.tools,10);assert.equal(final.status,'completed');assert.equal(final.run_id,first.next_job.id);assert.equal(final.usage_summary.calls,2);assert.equal(final.cards.length,1);
 const foreignUsage=await inAuthorizedTransaction(db.api,{userId:other.user,sessionId:other.session},async tx=>({status:200,body:(await tx`select app.agent_chain_usage(${f.tenant}::uuid,${root}::uuid) value`)[0]?.value}));assert.deepEqual(foreignUsage?.body,{krw:'0',calls:0});
 assert.equal((await resume(root)).json().status,'completed');assert.equal(modelCalls,2);
 const loop=await start([f.revision]);let feedbackSeen=0;
 const loopOptions={config,model:async(input:any)=>{feedbackSeen=Math.max(feedbackSeen,input.feedback.length);return result([call],false);}};
 assert.equal(await runAgentOnce(services,loopOptions,f.tenant),'limited');assert.equal((await read(loop)).coverage.model_rounds,4);
 const child=(await resume(loop)).json().run_id;
 assert.equal(await runAgentOnce(services,{config,model:async(input)=>{assert.ok(input.feedback.length>=5);return result();}},f.tenant),'stored');assert.ok(feedbackSeen>=4);assert.equal((await read(loop)).coverage.model_rounds,5);
 assert.equal((await read(child)).root_run_id,loop);
 const nested=await start();await runAgentOnce(services,loopOptions,f.tenant);await resume(nested);await runAgentOnce(services,loopOptions,f.tenant);
 const newest=await read(nested);assert.ok(newest.next_job);assert.notEqual(newest.run_id,nested);assert.equal((await resume(nested)).statusCode,409,'an old parent must not silently activate a different continuation');
 await app.inject({method:'POST',url:`/v1/agent/runs/${nested}/cancel`,headers,payload:{}});assert.equal((await read(nested)).next_job,null);
 const withdrawn=await start([f.revision]);await runAgentOnce(services,loopOptions,f.tenant);
 await db.admin`insert into app.evidence_retention_tasks(tenant_id,revision_id,source_id,source_generation) values(${f.tenant}::uuid,${f.revision}::uuid,${f.source}::uuid,1)`;
 assert.equal((await resume(withdrawn)).statusCode,404);assert.equal((await read(withdrawn)).cards.length,0);
 const cancelled=await start();await runAgentOnce(services,loopOptions,f.tenant);
 await app.inject({method:'POST',url:`/v1/agent/runs/${cancelled}/cancel`,headers,payload:{}});
 const cancelledResult=await read(cancelled);assert.equal(cancelledResult.status,'cancelled');assert.equal(cancelledResult.next_job,null);assert.deepEqual(cancelledResult.missing,[]);assert.equal((await resume(cancelled)).statusCode,409);
 assert.equal(await runAgentOnce(services,options,f.tenant),'idle');
 }finally{await app?.close();await db.cleanup();}
});
test('interactive deadline yields while provider finishes once; another job proceeds; cancellation keeps usage',async()=>{
 const db=await processingFixture(isolated.name);let app:ReturnType<typeof createApp>|undefined;
 try{const f=await db.createFixture();const services={db:db.api,agentRuntime:true,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})};app=createApp(services);
 const headers={authorization:'Bearer test','x-tenant-id':f.tenant};
 const start=async()=>{const response=await app!.inject({method:'POST',url:'/v1/agent/runs',headers,payload:{client_turn_id:randomUUID(),instruction:'자료 확인',input_kind:'text'}});assert.equal(response.statusCode,202);return response.json().run_id;};
 let calls=0;let release!:()=>void;let entered!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
 const root=await start();const task=runAgentOnce(services,{config,interactiveMs:100,model:async()=>{calls++;entered();await gate;return result();}},f.tenant);
 await enteredPromise;assert.equal(await task,'inflight');
 const second=await start();assert.equal(await runAgentOnce(services,{},f.tenant),'stored');
 assert.equal((await app.inject({method:'GET',url:`/v1/agent/runs/${second}`,headers})).json().status,'completed');
 release();await drainAgentTasks(services);assert.equal(calls,1);
 assert.equal(await runAgentOnce(services,{config,model:async()=>{throw Error('duplicate paid call');}},f.tenant),'stored');
 const completed=(await app.inject({method:'GET',url:`/v1/agent/runs/${root}`,headers})).json();assert.equal(completed.usage_summary.calls,1);assert.equal(completed.coverage.tools,1);
 let releaseCancel!:()=>void;let enteredCancel!:()=>void;const enteredCancelPromise=new Promise<void>(resolve=>{enteredCancel=resolve;});const cancelGate=new Promise<void>(resolve=>{releaseCancel=resolve;});
 const cancel=await start();const pending=runAgentOnce(services,{config,interactiveMs:100,model:async()=>{enteredCancel();await cancelGate;return result();}},f.tenant);
 await enteredCancelPromise;assert.equal(await pending,'inflight');await app.inject({method:'POST',url:`/v1/agent/runs/${cancel}/cancel`,headers,payload:{}});releaseCancel();await drainAgentTasks(services);
 const cancelled=(await app.inject({method:'GET',url:`/v1/agent/runs/${cancel}`,headers})).json();assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.coverage.tools,0);assert.equal(cancelled.usage_summary.calls,1);assert.ok(Number(cancelled.usage_summary.krw)>0);
 }finally{await app?.close();await db.cleanup();}
});
test('malformed configuration is explicit; absent/disabled local mode and long audio support are distinct',()=>{
 assert.equal(agentConfiguration({}).mode,'local');assert.equal(agentConfiguration({SEMANTIC_ENABLED:'false',SEMANTIC_API_KEY:'invalid'}).mode,'local');
 for(const env of [{SEMANTIC_ENABLED:'true'},{SEMANTIC_PROVIDER:'openai'},{SEMANTIC_ENABLED:'typo'},{SEMANTIC_PROVIDER:'openai',SEMANTIC_API_KEY:'invalid',SEMANTIC_MODEL:'test',SEMANTIC_PRICE_JSON:'{}'}])assert.equal(agentConfiguration(env).mode,'blocked');
 assert.equal(agentConfiguration({SEMANTIC_PROVIDER:config.provider,SEMANTIC_API_KEY:config.key,SEMANTIC_MODEL:config.model,SEMANTIC_PRICE_JSON:JSON.stringify(config.price)}).mode,'model');
 const ready=buildReadiness([],{SEMANTIC_ENABLED:'true'});assert.equal(ready.capabilities.find(c=>c.id==='agent_planner')?.state,'needs_setup');
 for(const ext of ['mp3','wav','m4a'])assert.equal(ready.formats.find(f=>f.extensions.includes(ext))?.status,'provider_required');
 const id=randomUUID();assert.deepEqual(workHttp({route:'agent.continue',id}),{path:`/v1/agent/runs/${id}/continue`,method:'POST',body:{}});assert.equal(WorkRequestSchema.safeParse({route:'agent.continue',id,command:'{}'}).success,false);
});
test('configuration failure does not silently search or interpret ambiguous sending as fax',async()=>{
 const db=await processingFixture(isolated.name);let app:ReturnType<typeof createApp>|undefined;
 try{const f=await db.createFixture();const services={db:db.api,agentRuntime:true,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})};app=createApp(services);const headers={authorization:'Bearer test','x-tenant-id':f.tenant};
 for(const [instruction,options,expected] of [['자료 찾아줘',{configurationBlocked:true},'configuration_blocked'],['이거 보내줘',{},'unsupported_action'],['견적서 보내',{},'unsupported_action'],['팩스로 보내줘',{},null]] as const){
 const started:{statusCode:number;json:()=>any}=await app.inject({method:'POST',url:'/v1/agent/runs',headers,payload:{client_turn_id:randomUUID(),instruction,input_kind:'text'}});assert.equal(started.statusCode,202);await runAgentOnce(services,options,f.tenant);
 const value:any=(await app.inject({method:'GET',url:`/v1/agent/runs/${started.json().run_id}`,headers})).json();if(expected){assert.deepEqual(value.missing,[expected]);assert.equal(value.coverage.tools,0);}else{assert.equal(value.delivery_choices,true);assert.equal(value.planner_mode,'local');assert.ok(value.planner_notice);}
 }
 }finally{await app?.close();await db.cleanup();}
});
