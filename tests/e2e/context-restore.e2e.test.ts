/**
 * Core E2E: a fragmentary site message is restored against existing work and becomes a work event + today's follow-up.
 *
 *   1. 전날 통화 전사: "망원동 현장 문틀 100개 내일 오전에 보내기로 했다" (PC 일지로 들어온 기록)
 *   2. 새 문자:        "사장님, 그때 말씀하셨던 곳 물량 안 들어왔어요"
 *   → 사건: 망원동 현장 · 문틀 100개 · 납품 지연(문제) · 할 일 "망원동 문틀 100개 입고 확인 및 공급처 연락"
 *   3. 아무 맥락 없는 회사의 같은 문자 → 사건은 남되 project_id null · missing ['site'] (현장을 만들어내지 않음)
 *   4. 할 일 완료 표시 → 사건 resolved · 같은 원천은 두 번 처리되지 않음 · 사용량은 공동 원장(channel context)에 정산
 *
 * Runs on the isolated PostgreSQL (SIGONGNOTE_E2E_DB=1, scripts/e2e-db.mjs). The model is the real Claude Agent SDK
 * when CLAUDE_E2E_LIVE=1 (requires a credential); otherwise the recorded fixture in fixtures/claude/context-restore.json
 * replays the structured output so CI stays deterministic. CLAUDE_E2E_RECORD=1 refreshes the fixture from a live run.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import postgres from 'postgres';
import {createApp} from '../../services/api/src/app.js';
import {runContextRestoreOnce,CONTEXT_PROMPT,type ContextResult} from '../../services/api/src/context-restore.js';
import {claudeRuntimeConfig,runClaude,ClaudeUnavailable,type ClaudeRunner,type ClaudeRuntimeConfig} from '../../services/api/src/claude-runtime.js';
import type {CapturePolicy} from '../../services/api/src/capture-scope.js';
import {parseStrictLocalEnv} from '../../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../../scripts/db-gate.mjs';
import {deleteFixtureTenants} from '../fixture-cleanup.js';

const FIXTURE='fixtures/claude/context-restore.json';
const LIVE=process.env.CLAUDE_E2E_LIVE==='1',RECORD=process.env.CLAUDE_E2E_RECORD==='1';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
type Take={text:string;value:unknown;usage:{input_tokens:number;output_tokens:number;cache_creation_input_tokens:number;cache_read_input_tokens:number};costUsd:number;model:string;toolCalls:string[]};
type Recorded={recorded_at:string;runtime:string;takes:Record<string,Take[]>};
function scenarioKey(prompt:string){const p=JSON.parse(prompt) as {text:string};return hash(p.text).slice(0,16);}
/**
 * Replay runner. The same fragment text occurs in two companies (with and without prior context), so takes are
 * recorded as an ordered list per text and replayed in the same order the test claims them. Records when asked.
 */
function fixtureRunner(live:ClaudeRunner,projects:Map<string,string>):ClaudeRunner{
 const recorded:Recorded=existsSync(FIXTURE)&&!RECORD?JSON.parse(readFileSync(FIXTURE,'utf8')):{recorded_at:new Date().toISOString(),runtime:runtime.model,takes:{}};
 const cursor:Record<string,number>={};
 return async(request,rt)=>{
  const key=scenarioKey(request.prompt),text=(JSON.parse(request.prompt) as {text:string}).text;
  if(LIVE||RECORD){const result=await live(request,rt);if(RECORD){const takes=recorded.takes[key]??[];takes.push({text,value:result.value,usage:result.usage,costUsd:result.costUsd,model:result.model,toolCalls:result.toolCalls});recorded.takes[key]=takes;mkdirSync('fixtures/claude',{recursive:true});writeFileSync(FIXTURE,JSON.stringify(recorded,null,1)+'\n');}return result;}
  const takes=recorded.takes[key]??[];const index=cursor[key]??0;const hit=takes[index];cursor[key]=index+1;
  assert.ok(hit,`recorded fixture missing take ${index} for scenario ${key}; run with CLAUDE_E2E_RECORD=1`);
  // Resolve recorded evidence through the real scoped tools. Keeping the reference
  // exercises local-ID persistence and detail reopening in deterministic CI too.
  const value=hit.value as {events:Array<Record<string,unknown>&{project_name:string|null}>;unresolved:boolean};
  const recent=await request.tools?.find(t=>t.name==='recent_journal')?.handler({}) as {items:Array<{id:string;project_name:string|null}>}|undefined;
  const mapped={...value,events:value.events.map(e=>({...e,project_id:e.project_name&&projects.get(e.project_name)?projects.get(e.project_name):null,context_id:null,
   evidence_refs:Array.isArray(e.evidence_refs)&&e.evidence_refs.length?recent?.items.filter(i=>i.project_name===e.project_name).slice(0,e.evidence_refs.length).map(i=>i.id)??[]:[],supersedes_event_id:e.supersedes_event_id}))};
  return {value:request.parse(mapped),usage:hit.usage,costUsd:hit.costUsd,receipt:`fixture-${key}-${index}`,turns:1,durationMs:1,model:hit.model,toolCalls:hit.toolCalls};
 };
}
const runtime:ClaudeRuntimeConfig=LIVE||RECORD?(()=>{const r=claudeRuntimeConfig();assert.ok(r,'CLAUDE_E2E_LIVE needs a Claude credential');return r;})():{model:'claude-sonnet-5',price:{version:'e2e',provider:'anthropic',model:'claude-sonnet-5',input_krw_per_million:3000,output_krw_per_million:15000,valid_until:'2099-01-01T00:00:00Z',conversion_note:'e2e fixture'},maxBudgetUsd:0.5,maxTurns:12,effort:'medium',credential:'api_key'};

async function company(admin:postgres.Sql,name:string,policy:CapturePolicy){
 const c={tenant:randomUUID(),user:randomUUID(),session:randomUUID(),device:randomUUID()};
 await admin`insert into auth.users(id) values(${c.user}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${c.session}::uuid,${c.user}::uuid)`;
 await admin`insert into app.tenants(id,display_name) values(${c.tenant}::uuid,${name})`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${c.tenant}::uuid,${c.user}::uuid,'owner')`;
 await admin`insert into app.devices(tenant_id,id,user_id,platform,public_key_jwk,public_key_sha256,app_version,registration_key,registration_hash) values(${c.tenant}::uuid,${c.device}::uuid,${c.user}::uuid,'windows','{}',${hash(c.device)},'e2e',${randomUUID()}::uuid,${hash('registration')})`;
 await admin`insert into app.local_context_consents(tenant_id,user_id,allowed,processing_policy) values(${c.tenant}::uuid,${c.user}::uuid,true,${admin.json(policy)})`;return c;
}
async function localEntry(admin:postgres.Sql,c:{tenant:string;device:string;user:string},text:string,receivedAt:string,sourceKind:string,project:string|null=null){
 const [row]=await admin`insert into app.local_journal_entries(tenant_id,device_id,local_id,actor_id,file_name,sha256,mime,received_at,project_id,categories,excerpt,source_kind) values(${c.tenant}::uuid,${c.device}::uuid,${randomUUID()}::uuid,${c.user}::uuid,${sourceKind==='sms'?'문자.txt':'통화 전사.txt'},${hash(text)},'text/plain',${receivedAt}::timestamptz,${project}::uuid,'{}',${text},${sourceKind}) returning id`;
 return String(row?.id);
}

test('E2E 맥락 복원: 생략된 현장을 기존 통화 기록에서 되찾아 사건·할 일을 만들고, 맥락이 없으면 현장을 만들어내지 않는다',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(readFileSync('services/api/'+['.env'].join(''),'utf8'));
 const admin=postgres(String(env.MIGRATION_DATABASE_URL),{max:1,onnotice:()=>{}}),api=postgres(String(env.DATABASE_URL),{max:3,onnotice:()=>{}});
 const policy:CapturePolicy={id:`e2e-context-${randomUUID().slice(0,8)}`,purpose:'work_records',provider:'anthropic',processing_location:'provider_cloud',storage_location:'development_computer',retention:'until_user_deletes',external_processing:true};
 const projects=new Map<string,string>();const runner=fixtureRunner(runClaude,projects);const tenants:string[]=[];const users:{user:string}[]=[];
 try{
  // Company A: yesterday's call about 망원동, then today's fragmentary SMS.
  const a=await company(admin,'E2E 맥락 회사',policy);tenants.push(a.tenant);users.push(a);
  const [site]=await admin`insert into app.projects(tenant_id,display_name) values(${a.tenant}::uuid,'망원동 현장') returning id`;const mangwon=String(site?.id);projects.set('망원동 현장',mangwon);
  await admin`insert into app.projects(tenant_id,display_name) values(${a.tenant}::uuid,'성산동 현장')`;
  const yesterday=new Date(Date.now()-26*3600_000).toISOString();
  const callId=await localEntry(admin,a,'[통화 전사] 김반장: 사장님 망원동 현장 문틀 100개 언제 와요? 대표: 내일 오전에 보내기로 했어요, 공급처에 얘기해 뒀어요. 김반장: 네 오전에 받을게요.',yesterday,'call_recording',mangwon);
  const smsId=await localEntry(admin,a,'사장님, 그때 말씀하셨던 곳 물량 안 들어왔어요',new Date().toISOString(),'sms');
  // The call transcript is processed first (newest-first claim takes the SMS first, so run until idle).
  const results:string[]=[];for(let i=0;i<4;i++){const r=await runContextRestoreOnce({db:api,runtime,policy,runner,tenantScope:a.tenant,timeoutMs:170000});results.push(r);if(r==='idle')break;}
  assert.ok(results.filter(r=>r==='stored').length>=2,`expected both sources processed, got ${results.join(',')}`);
  const events=await admin`select e.*,p.display_name project_name from app.work_events e left join app.projects p on p.tenant_id=e.tenant_id and p.id=e.project_id where e.tenant_id=${a.tenant}::uuid and e.source_ref=${smsId}::uuid`;
  assert.ok(events.length>=1,'the SMS must produce at least one work event');
  const linked=events.find(e=>e.project_id===mangwon);
  assert.ok(linked,`the omitted site must be restored to 망원동 (got ${events.map(e=>e.project_name??'null').join(',')})`);
  assert.ok(['problem','change','request'].includes(String(linked.kind)),`kind ${linked.kind}`);
  assert.ok(!linked.missing.includes('site'));
  assert.ok(linked.evidence_refs.includes(callId),'restored context must keep the actual prior local evidence ID');
  const followups=await admin`select f.* from app.work_followups f where f.tenant_id=${a.tenant}::uuid and f.event_id=${linked.id}::uuid and f.state='open'`;
  assert.ok(followups.length>=1,'a follow-up for today is required');
  assert.match(followups.map(f=>String(f.title)).join(' '),/망원동|문틀|입고|공급/);
  // Usage settled on the shared product-AI ledger, channel context, with the source actor as the payer.
  const usage=await admin`select channel,state,actual_krw,config->>'prompt' prompt from app.product_ai_usage where tenant_id=${a.tenant}::uuid and user_id=${a.user}::uuid and channel='context'`;
  assert.ok(usage.length>=2);assert.ok(usage.every(u=>u.state==='settled'&&Number(u.actual_krw)>=0&&u.prompt===CONTEXT_PROMPT));
  // The owner sees it on Today through the existing journal.tasks route; the follow-up carries the restored site.
  const app=createApp({db:api,agentRuntime:false,capturePolicy:policy,verifyToken:async()=>({userId:a.user,sessionId:a.session})});
  try{
   const headers={authorization:'Bearer e2e','x-tenant-id':a.tenant};
   const tasks=await app.inject({method:'GET',url:'/v1/work/journal/tasks',headers});assert.equal(tasks.statusCode,200,tasks.body);
   const body=tasks.json();const mine=body.items.find((t:any)=>t.kind==='followup'&&t.event_id===linked.id);
   assert.ok(mine,'today checklist must list the restored follow-up');assert.equal(mine.project_name,'망원동 현장');assert.equal(mine.done,false);assert.equal(mine.revision_id,smsId);
   assert.ok(Array.isArray(body.events)&&body.events.some((e:any)=>e.id===linked.id&&e.followups.length>=1));
   const detail=await app.inject({method:'GET',url:'/v1/work/events/'+linked.id,headers});assert.equal(detail.statusCode,200,detail.body);
   assert.ok(detail.json().evidence.some((e:any)=>e.id===callId&&e.available&&e.kind==='local'));
   // Marking done is a personal checklist effect only: event resolves, nothing else changes; version CAS guards it.
   const mark=await app.inject({method:'POST',url:'/v1/work/journal/commands',headers:{...headers,'idempotency-key':randomUUID()},payload:{action:'task',id:mine.id,client_command_id:randomUUID(),expected_version:mine.version,done:true}});
   assert.equal(mark.statusCode,200,mark.body);assert.equal(mark.json().done,true);
   const stale=await app.inject({method:'POST',url:'/v1/work/journal/commands',headers:{...headers,'idempotency-key':randomUUID()},payload:{action:'task',id:mine.id,client_command_id:randomUUID(),expected_version:mine.version,done:false}});
   assert.equal(stale.statusCode,409,stale.body);
   // The event resolves only when every follow-up it produced is done (the model may propose more than one).
   for(const other of body.items.filter((t:any)=>t.kind==='followup'&&t.event_id===linked.id&&t.id!==mine.id)){
    const done=await app.inject({method:'POST',url:'/v1/work/journal/commands',headers:{...headers,'idempotency-key':randomUUID()},payload:{action:'task',id:other.id,client_command_id:randomUUID(),expected_version:other.version,done:true}});assert.equal(done.statusCode,200,done.body);
   }
   const [resolved]=await admin`select status from app.work_events where tenant_id=${a.tenant}::uuid and id=${linked.id}::uuid`;assert.equal(resolved?.status,'resolved');
   // Another company cannot see these events or follow-ups.
   const b=await company(admin,'E2E 무맥락 회사',policy);tenants.push(b.tenant);users.push(b);
   const foreign=createApp({db:api,agentRuntime:false,capturePolicy:policy,verifyToken:async()=>({userId:b.user,sessionId:b.session})});
   try{const other=await foreign.inject({method:'GET',url:'/v1/work/journal/tasks',headers:{authorization:'Bearer e2e','x-tenant-id':b.tenant}});assert.equal(other.statusCode,200);assert.equal(other.json().items.length,0);}finally{await foreign.close();}
   // Company B: the same SMS with no prior context → event kept, site unresolved, no project invented.
   const orphanId=await localEntry(admin,b,'사장님, 그때 말씀하셨던 곳 물량 안 들어왔어요',new Date().toISOString(),'sms');
   const r=await runContextRestoreOnce({db:api,runtime,policy,runner,tenantScope:b.tenant,timeoutMs:170000});assert.equal(r,'stored');
   const orphan=await admin`select * from app.work_events where tenant_id=${b.tenant}::uuid and source_ref=${orphanId}::uuid`;
   assert.ok(orphan.length>=1);assert.ok(orphan.every(e=>e.project_id===null&&e.missing.includes('site')),'no site may be invented');
   assert.equal((await admin`select count(*)::int n from app.projects where tenant_id=${b.tenant}::uuid`)[0]?.n,0,'no project row may be created by the model');
   // Idempotent: nothing left to claim for either company.
   assert.equal(await runContextRestoreOnce({db:api,runtime,policy,runner,tenantScope:a.tenant}),'idle');
   assert.equal(await runContextRestoreOnce({db:api,runtime,policy,runner,tenantScope:b.tenant}),'idle');
   const sources=await admin`select state,events from app.work_event_sources where tenant_id=any(${tenants}::uuid[])`;assert.ok(sources.every(s=>s.state==='done'));
   // A budget pause is temporary: it backs off for an hour without consuming the source's retry attempts, then is claimed again.
   const pausedId=await localEntry(admin,b,'내일 오전 자재 들어오는 거 맞죠?',new Date().toISOString(),'sms');
   const claim=async()=>(await api`select app.next_context_input(${b.tenant}::uuid,180,true) value`)[0]?.value as {source_ref:string}|null;
   assert.equal((await claim())?.source_ref,pausedId);
   const markPaused=()=>api.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${b.user},true)`;await tx`select app.save_work_events(${b.tenant}::uuid,${b.user}::uuid,'local',${pausedId}::uuid,'[]'::jsonb,null,'claude-sonnet-5','BUDGET_PAUSED')`;});
   await markPaused();assert.equal(await claim(),null,'paused source is not re-claimed within the back-off window');
   await admin`update app.work_event_sources set updated_at=now()-interval '2 hours' where tenant_id=${b.tenant}::uuid and source_ref=${pausedId}::uuid`;
   assert.equal((await claim())?.source_ref,pausedId,'claimed again after the back-off');await markPaused();
   const [paused]=await admin`select attempts,state,error_code from app.work_event_sources where tenant_id=${b.tenant}::uuid and source_ref=${pausedId}::uuid`;
   assert.equal(Number(paused?.attempts),1,'budget pauses never consume attempts');assert.equal(paused?.state,'failed');assert.match(String(paused?.error_code),/^BUDGET_PAUSED/);
   void callId;
  }finally{await app.close();}
 }finally{
  try{await admin.begin(async tx=>{await deleteFixtureTenants(tx,tenants);for(const u of users){await tx`delete from auth.sessions where user_id=${u.user}::uuid`;await tx`delete from auth.users where id=${u.user}::uuid`;}});}
  finally{await Promise.all([admin.end(),api.end()]);}
 }
});

test('맥락 접점 회귀: 리비전·정정·다현장·근거·장애 재개와 동의 철회',async t=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(readFileSync('services/api/'+['.env'].join(''),'utf8'));
 const admin=postgres(String(env.MIGRATION_DATABASE_URL),{max:1,onnotice:()=>{}}),api=postgres(String(env.DATABASE_URL),{max:3,onnotice:()=>{}});
 const policy:CapturePolicy={id:'context-connection-regression',purpose:'work_records',provider:'anthropic',processing_location:'provider_cloud',storage_location:'development_computer',retention:'until_user_deletes',external_processing:true};
 const tenants:string[]=[],users:Array<{user:string}>=[];
 const companyFor=async()=>{const c=await company(admin,'합성 맥락 접점 회사',policy);tenants.push(c.tenant);users.push(c);return c;};
 const event=(changes:Partial<ContextResult['events'][number]>={}):ContextResult['events'][number]=>({kind:'request',summary:'합성 주문 확인',detail:'회귀시험',project_id:null,project_name:null,context_id:null,party:null,occurred_at:null,quantities:[],evidence_refs:[],missing:['site'],confidence:'high',reasoning:'합성 근거',followups:[{title:'합성 주문 확인',due_on:null}],supersedes_event_id:null,...changes});
 const runner=(events:ContextResult['events'],observe?:()=>Promise<void>|void):ClaudeRunner=>async(request,rt)=>{for(const ref of new Set(events.flatMap(e=>e.evidence_refs)))await request.tools?.find(t=>t.name==='get_evidence')?.handler({id:ref});await observe?.();return {value:request.parse({events,unresolved:false}),usage:{input_tokens:1,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0},costUsd:0,receipt:'synthetic-'+randomUUID(),turns:1,durationMs:1,model:rt.model,toolCalls:[]};};
 const run=(c:{tenant:string},model:ClaudeRunner)=>runContextRestoreOnce({db:api,runtime,policy,runner:model,tenantScope:c.tenant});
 const entry=(c:Awaited<ReturnType<typeof company>>,text:string,received=new Date().toISOString())=>localEntry(admin,c,text,received,'local_file');
 const appFor=(c:Awaited<ReturnType<typeof company>>)=>createApp({db:api,agentRuntime:false,capturePolicy:policy,verifyToken:async()=>({userId:c.user,sessionId:c.session})});
 const headers=(c:{tenant:string})=>({authorization:'Bearer synthetic','x-tenant-id':c.tenant});
 try{
  await t.test('거절이 확인된 0원 공급자 장애는 새 시도로 재개하고 결과 불명은 자동 재호출하지 않는다',async()=>{
   const c=await companyFor(),id=await entry(c,'합성 장애 자료');
   assert.equal(await run(c,async()=>{throw new ClaudeUnavailable('synthetic-unavailable');}),'rejected');
   await admin`update app.work_event_sources set updated_at=now()-interval '2 hours' where tenant_id=${c.tenant}::uuid and source_ref=${id}::uuid`;
   let calls=0;assert.equal(await run(c,runner([event()],()=>{calls++;})),'stored');assert.equal(calls,1);
   const usage=await admin`select state,actual_krw from app.product_ai_usage where tenant_id=${c.tenant}::uuid order by created_at`;
   assert.equal(usage.length,2);assert.equal(Number(usage[0]!.actual_krw),0);assert.equal(usage[1]!.state,'settled');
   await entry(c,'합성 응답 불명 자료');assert.equal(await run(c,async()=>{throw Error('synthetic-outcome-unknown');}),'unknown');
   await admin`update app.work_event_sources set lease_until=now()-interval '2 hours',updated_at=now()-interval '2 hours' where tenant_id=${c.tenant}::uuid`;
   assert.equal(await run(c,runner([event()],()=>{calls++;})),'idle');assert.equal(calls,1);
  });
  await t.test('명시 취소는 이전 사건과 미완료 할 일을 대체하고 다른 회사 사건을 대체하지 못한다',async()=>{
   const c=await companyFor(),first=await entry(c,'합성 첫 주문');assert.equal(await run(c,runner([event()])),'stored');
   const [old]=await admin`select id from app.work_events where tenant_id=${c.tenant}::uuid and source_ref=${first}::uuid`;
   await entry(c,'합성 첫 주문 취소');assert.equal(await run(c,runner([event({kind:'correction',summary:'합성 주문 취소',supersedes_event_id:String(old!.id)})])),'stored');
   const rows=await admin`select id,status,supersedes from app.work_events where tenant_id=${c.tenant}::uuid`;
   assert.equal(rows.find(e=>e.id===old!.id)!.status,'superseded');assert.ok(rows.some(e=>e.supersedes===old!.id));
   assert.equal((await admin`select count(*)::int n from app.work_followups where tenant_id=${c.tenant}::uuid and state='open'`)[0]!.n,1);
   const foreign=await companyFor();await entry(foreign,'다른 회사 합성 정정');assert.equal(await run(foreign,runner([event({supersedes_event_id:String(old!.id)})])),'stored');
   assert.equal((await admin`select supersedes from app.work_events where tenant_id=${foreign.tenant}::uuid`)[0]!.supersedes,null);
  });
  await t.test('제출 직후 프로세스가 끊긴 원천은 모델 설정을 바꿔 재기동해도 중복 제출하지 않는다',async()=>{
   const c=await companyFor(),id=await entry(c,'합성 제출 직후 중단 자료');assert.equal(await run(c,async()=>{throw Error('synthetic-outcome-unknown');}),'unknown');
   // Recreate the persisted boundary immediately after submit, before the old
   // process could classify its outcome or finish its leased source.
   await admin`update app.work_event_sources set state='leased',error_code=null,lease_until=now()-interval '1 hour' where tenant_id=${c.tenant}::uuid and source_ref=${id}::uuid`;
   await admin`update app.product_ai_usage set state='submitted',actual_krw=null where tenant_id=${c.tenant}::uuid and channel='context'`;
   let calls=0;const changed={...runtime,model:'synthetic-runtime-after-restart',price:{...runtime.price,model:'synthetic-runtime-after-restart'}};
   assert.equal(await runContextRestoreOnce({db:api,runtime:changed,policy,runner:runner([event()],()=>{calls++;}),tenantScope:c.tenant}),'unknown');assert.equal(calls,0);
   assert.equal((await admin`select count(*)::int n from app.product_ai_usage where tenant_id=${c.tenant}::uuid`)[0]!.n,1);
  });
  await t.test('PC 자료 revision 2가 재처리되고 이전 사건·할 일은 이력으로 남는다',async()=>{
   const c=await companyFor(),id=await entry(c,'합성 주문 10개');assert.equal(await run(c,runner([event({summary:'합성 주문 10개'})])),'stored');
   const [local]=await admin`select * from app.local_journal_entries where tenant_id=${c.tenant}::uuid and id=${id}::uuid`;
   const app=appFor(c);try{
    const text='합성 주문 20개',push=await app.inject({method:'POST',url:'/v1/local-journal/push',headers:headers(c),payload:{device_id:c.device,items:[{id:local!.local_id,revision:2,received_at:new Date(local!.received_at).toISOString(),file_name:local!.file_name,categories:[],excerpt:text,sha256:hash(text),mime:'text/plain'}]}});
    assert.equal(push.statusCode,200,push.body);assert.equal(push.json().items[0].revision_id,id);
    assert.equal(await run(c,runner([event({summary:'합성 주문 20개'})])),'stored');
    const rows=await admin`select status,summary,source_version from app.work_events where tenant_id=${c.tenant}::uuid`;
    assert.equal(rows.find(e=>e.summary==='합성 주문 10개')!.status,'superseded');assert.equal(rows.find(e=>e.summary==='합성 주문 20개')!.status,'open');
    assert.notEqual(rows[0]!.source_version,rows[1]!.source_version);assert.equal(await run(c,runner([event()])),'idle');
    const tasks=await app.inject({method:'GET',url:'/v1/work/journal/tasks',headers:headers(c)});assert.equal(tasks.json().items.length,1);assert.equal(tasks.json().events.length,1);
   }finally{await app.close();}
  });
  await t.test('복수 현장 자료는 첫 현장에 붙이지 않는다',async()=>{
   const c=await companyFor(),id=await entry(c,'합성 A와 B 현장 자료');
   const sites=await admin`insert into app.projects(tenant_id,display_name) values(${c.tenant}::uuid,'합성 A'),(${c.tenant}::uuid,'합성 B') returning id`;
   assert.equal(await run(c,runner(sites.map(s=>event({project_id:String(s.id),missing:[]})))),'stored');
   assert.equal((await admin`select project_id from app.local_journal_entries where tenant_id=${c.tenant}::uuid and id=${id}::uuid`)[0]!.project_id,null);
  });
  await t.test('로컬 근거 ID·버전을 저장하고 상세·정정·다시 열기·철회까지 연결한다',async()=>{
   const c=await companyFor(),previous=await entry(c,'합성 어제 통화',new Date(Date.now()-86400000).toISOString()),incoming=await entry(c,'합성 후속 요청');
   assert.equal(await run(c,runner([event({evidence_refs:[previous]})])),'stored');
   const [saved]=await admin`select * from app.work_events where tenant_id=${c.tenant}::uuid and source_ref=${incoming}::uuid`;
   assert.deepEqual(saved!.evidence_refs,[previous]);assert.equal(saved!.evidence_snapshots[0].kind,'local');assert.match(saved!.evidence_snapshots[0].version,/^1:/);
   const app=appFor(c);try{
    const detail=await app.inject({method:'GET',url:'/v1/work/events/'+saved!.id,headers:headers(c)});assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().evidence[0].available,true);
    const command={action:'event',id:saved!.id,expected_version:Number(saved!.version),client_command_id:randomUUID(),summary:'대표가 고친 합성 요청',project_id:null,reason:'합성 정정 근거'};
    const correction=await app.inject({method:'POST',url:'/v1/work/journal/commands',headers:headers(c),payload:command});assert.equal(correction.statusCode,200,correction.body);
    const reopened=await app.inject({method:'GET',url:'/v1/work/events/'+saved!.id,headers:headers(c)});assert.equal(reopened.json().event.summary,command.summary);assert.equal(reopened.json().corrections.length,1);
    const conflict=await app.inject({method:'POST',url:'/v1/work/journal/commands',headers:headers(c),payload:{...command,client_command_id:randomUUID()}});assert.equal(conflict.statusCode,409);
    const denied=await app.inject({method:'POST',url:'/v1/local-journal/ai-consent',headers:headers(c),payload:{allowed:false,expected_version:1,client_command_id:randomUUID()}});assert.equal(denied.statusCode,200,denied.body);
    assert.equal((await app.inject({method:'GET',url:'/v1/work/events/'+saved!.id,headers:headers(c)})).statusCode,404);
    assert.equal(await run(c,runner([event()])),'idle');
    const journal=await app.inject({method:'GET',url:'/v1/work/journal',headers:headers(c)});assert.ok(journal.json().items.length>=2,'AI withdrawal keeps the ordinary shared journal');
   }finally{await app.close();}
  });
  await t.test('입력 판이 모델 응답 중 바뀌면 오래된 결과를 저장하지 않고 최신 판을 처리한다',async()=>{
   const c=await companyFor(),id=await entry(c,'합성 처리 전 판');
   assert.equal(await run(c,runner([event()],async()=>{await admin`update app.local_journal_entries set local_revision=2,excerpt='합성 새 판',sha256=${hash('합성 새 판')} where tenant_id=${c.tenant}::uuid and id=${id}::uuid`;})),'scope_blocked');
   assert.equal((await admin`select count(*)::int n from app.work_events where tenant_id=${c.tenant}::uuid`)[0]!.n,0);
   assert.equal(await run(c,runner([event({summary:'합성 새 판 처리'})])),'stored');
   const app=appFor(c);try{
    const revoked=await app.inject({method:'POST',url:'/v1/devices/'+c.device+'/revoke',headers:{...headers(c),'idempotency-key':randomUUID(),'if-match':'"1"'},payload:{}});assert.equal(revoked.statusCode,200,revoked.body);
    const tasks=await app.inject({method:'GET',url:'/v1/work/journal/tasks',headers:headers(c)});assert.equal(tasks.json().items.length,0);assert.equal(tasks.json().events.length,0);
   }finally{await app.close();}
  });
  await t.test('도구가 읽은 근거 판이 응답 중 바뀌면 현재판인 척 인용하지 않는다',async()=>{
   const c=await companyFor(),previous=await entry(c,'합성 근거 첫 판',new Date(Date.now()-86400000).toISOString()),incoming=await entry(c,'합성 이 근거의 후속 요청');
   assert.equal(await run(c,runner([event({evidence_refs:[previous]})],async()=>{await admin`update app.local_journal_entries set local_revision=2,excerpt='합성 근거 새 판',sha256=${hash('합성 근거 새 판')} where tenant_id=${c.tenant}::uuid and id=${previous}::uuid`;})),'scope_blocked');
   assert.equal((await admin`select count(*)::int n from app.work_events where tenant_id=${c.tenant}::uuid`)[0]!.n,0);
   const [stale]=await admin`select error_code from app.work_event_sources where tenant_id=${c.tenant}::uuid and source_ref=${incoming}::uuid`;assert.equal(stale!.error_code,'EVIDENCE_CHANGED');
   assert.equal(await run(c,runner([event({summary:'합성 새 근거를 확인한 요청',evidence_refs:[previous]})])),'stored');
   const [saved]=await admin`select evidence_snapshots from app.work_events where tenant_id=${c.tenant}::uuid and source_ref=${incoming}::uuid`;assert.match(saved!.evidence_snapshots[0].version,/^2:/);
  });
  await t.test('저장 완료 뒤 과거 근거가 정정되어도 후속 원천을 재해석하고 이전 할 일을 대체한다',async()=>{
   const c=await companyFor(),previous=await entry(c,'합성 어제 약속 10개',new Date(Date.now()-86400000).toISOString()),incoming=await entry(c,'합성 그 약속대로 확인 요청');
   assert.equal(await run(c,runner([event({summary:'합성 10개 확인',evidence_refs:[previous]})])),'stored');
   assert.equal(await run(c,runner([])),'stored'); // Finish the prior source's own bookkeeping too.
   const [old]=await admin`select id,interpretation_run from app.work_events where tenant_id=${c.tenant}::uuid and source_ref=${incoming}::uuid`;
   await admin`update app.local_journal_entries set local_revision=2,excerpt='합성 어제 약속 정정 20개',sha256=${hash('합성 어제 약속 정정 20개')} where tenant_id=${c.tenant}::uuid and id=${previous}::uuid`;
   const app=appFor(c);try{
    const waiting=await app.inject({method:'GET',url:'/v1/work/journal/tasks',headers:headers(c)});assert.equal(waiting.json().items.length,0,'a changed citation must not keep showing an obsolete reminder');
    assert.equal(await run(c,runner([event({summary:'합성 정정 20개 확인',evidence_refs:[previous]})])),'stored');
    const rows=await admin`select id,status,interpretation_run,evidence_snapshots from app.work_events where tenant_id=${c.tenant}::uuid and source_ref=${incoming}::uuid`;
    assert.equal(rows.find(r=>r.id===old!.id)!.status,'superseded');const current=rows.find(r=>r.status==='open')!;assert.ok(current);assert.notEqual(current.interpretation_run,old!.interpretation_run);assert.match(current.evidence_snapshots[0].version,/^2:/);
    const tasks=await app.inject({method:'GET',url:'/v1/work/journal/tasks',headers:headers(c)});assert.equal(tasks.json().items.length,1);assert.equal(tasks.json().events[0].summary,'합성 정정 20개 확인');
    const history=await app.inject({method:'GET',url:'/v1/work/events/'+old!.id,headers:headers(c)});assert.equal(history.statusCode,200,history.body);assert.equal(history.json().event.status,'superseded');assert.equal(history.json().evidence[0].reason,'SOURCE_CHANGED');
   }finally{await app.close();}
  });
  await t.test('로그인·발췌 동기화만으로 외부 AI를 허용하지 않는다',async()=>{
   const c=await companyFor();await admin`delete from app.local_context_consents where tenant_id=${c.tenant}::uuid`;
   await entry(c,'합성 미동의 자료');let calls=0;assert.equal(await run(c,runner([event()],()=>{calls++;})),'idle');assert.equal(calls,0);
   const app=appFor(c);try{
    const allow=await app.inject({method:'POST',url:'/v1/local-journal/ai-consent',headers:headers(c),payload:{allowed:true,expected_version:0,client_command_id:randomUUID()}});assert.equal(allow.statusCode,200,allow.body);
    assert.equal(await run(c,runner([event()],()=>{calls++;})),'stored');assert.equal(calls,1);
   }finally{await app.close();}
  });
 }finally{
  try{await admin.begin(async tx=>{await deleteFixtureTenants(tx,tenants);for(const u of users){await tx`delete from auth.sessions where user_id=${u.user}::uuid`;await tx`delete from auth.users where id=${u.user}::uuid`;}});}
  finally{await Promise.all([admin.end(),api.end()]);}
 }
});
