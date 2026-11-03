/**
 * E2E showcase: runs the real context-restoration flow on the isolated PostgreSQL with synthetic company data,
 * records every step (inputs, Claude tool calls, structured output, DB rows, API responses, screen renders)
 * and writes a human-readable report with screenshots to .work/showcase/.
 *
 *   SIGONGNOTE_E2E_DB=1 node --import tsx scripts/e2e-showcase.mts            # real Claude Agent SDK (needs a credential)
 *
 * Synthetic data only (가상 회사·가상 현장·가상 문자). Nothing here touches production.
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import postgres from 'postgres';
import {chromium} from 'playwright-core';
import {createApp} from '../services/api/src/app.js';
import {runContextRestoreOnce} from '../services/api/src/context-restore.js';
import {claudeRuntimeConfig,claudeProductAiConfig,runClaude,type ClaudeRunner} from '../services/api/src/claude-runtime.js';
import {claudeAgentPlanner} from '../services/api/src/claude-planner.js';
import {runAgentOnce} from '../services/api/src/agent-runs.js';
import type {CapturePolicy} from '../services/api/src/capture-scope.js';
import {parseStrictLocalEnv} from './local-env-values.mjs';
import {verifyLocalDevelopmentDb} from './db-gate.mjs';
import {deleteFixtureTenants} from '../tests/fixture-cleanup.js';
import {TaskRows,type Task} from '../apps/web/src/work-tasks.js';
import {ListHead} from '../apps/web/src/work-shell.js';

const OUT='.work/showcase';mkdirSync(OUT,{recursive:true});
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const clip=(v:unknown,n=1500)=>{const s=typeof v==='string'?v:JSON.stringify(v);return s.length>n?s.slice(0,n)+' …(생략)':s;};
type Step={n:number;at:string;phase:string;title:string;detail:Record<string,unknown>};
const steps:Step[]=[];const started=Date.now();
const step=(phase:string,title:string,detail:Record<string,unknown>={})=>{const s={n:steps.length+1,at:new Date().toISOString(),phase,title,detail};steps.push(s);console.log(`[${String(s.n).padStart(2,'0')}] ${phase} · ${title}`);return s;};

/** Wraps the real runner so every in-process tool call and the final structured output are recorded. */
function recordingRunner(label:string):ClaudeRunner{
 return async(request,runtime)=>{
  const calls:{tool:string;args:unknown;result:unknown;ms:number}[]=[];
  const tools=(request.tools??[]).map(t=>({...t,handler:async(args:unknown)=>{const t0=Date.now();const result=await t.handler(args);calls.push({tool:t.name,args,result:clip(result,1800),ms:Date.now()-t0});return result;}}));
  step(label,'Claude 세션 시작',{model:runtime.model,prompt:JSON.parse(request.prompt),tools:tools.map(t=>t.name),subagents:(request.subagents??[]).map(s=>s.name)});
  const result=await runClaude({...request,tools},runtime);
  step(label,'Claude 구조화 출력',{tool_calls:calls,output:result.value,usage:result.usage,cost_usd:result.costUsd,turns:result.turns,duration_ms:result.durationMs,session:result.receipt});
  return result;
 };
}
async function company(admin:postgres.Sql,name:string){
 const c={tenant:randomUUID(),user:randomUUID(),session:randomUUID(),device:randomUUID(),name};
 await admin`insert into auth.users(id) values(${c.user}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${c.session}::uuid,${c.user}::uuid)`;
 await admin`insert into app.tenants(id,display_name) values(${c.tenant}::uuid,${name})`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${c.tenant}::uuid,${c.user}::uuid,'owner')`;
 await admin`insert into app.devices(tenant_id,id,user_id,platform,public_key_jwk,public_key_sha256,app_version,registration_key,registration_hash) values(${c.tenant}::uuid,${c.device}::uuid,${c.user}::uuid,'windows','{}',${hash(c.device)},'showcase',${randomUUID()}::uuid,${hash('registration')})`;
 return c;
}
async function entry(admin:postgres.Sql,c:{tenant:string;device:string;user:string},text:string,receivedAt:string,kind:string,fileName:string,project:string|null=null){
 const [row]=await admin`insert into app.local_journal_entries(tenant_id,device_id,local_id,actor_id,file_name,sha256,mime,received_at,project_id,categories,excerpt,source_kind) values(${c.tenant}::uuid,${c.device}::uuid,${randomUUID()}::uuid,${c.user}::uuid,${fileName},${hash(text)},'text/plain',${receivedAt}::timestamptz,${project}::uuid,'{}',${text},${kind}) returning id`;return String(row?.id);
}
const css=()=>['apps/web/src/tokens.css','apps/web/src/style.css','apps/web/src/work.css','apps/web/src/work-journal.css'].map(f=>readFileSync(f,'utf8').replace(/@import[^;]+;/g,'')).join('\n')+'\n:root{--font:"NanumGothic","Noto Sans KR",sans-serif}body{margin:0;background:var(--bg,#fff);font-family:var(--font)}.shot{padding:16px;max-width:390px}';
function todayScreen(items:Task[],title:string){
 const html=renderToStaticMarkup(React.createElement('section',{className:'today-section shot','aria-labelledby':'t'},React.createElement(ListHead,{id:'t',title,count:items.length}),React.createElement(TaskRows,{items,busy:'',onMark:()=>{},onOpen:()=>{}})));
 return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css()}</style></head><body>${html}</body></html>`;
}
/** Installed Edge/Chrome first (Windows dev PC, same as ui-shots.mjs), then an explicit path (SIGONGNOTE_CHROMIUM or the Linux CI browser). */
async function launchBrowser(){
 const errors:string[]=[];
 for(const channel of ['msedge','chrome'] as const){try{return await chromium.launch({channel,headless:true});}catch(e){errors.push(`${channel}: ${String((e as Error).message).split('\n')[0]}`);}}
 for(const executablePath of [process.env.SIGONGNOTE_CHROMIUM,'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter((p):p is string=>!!p)){
  try{return await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});}catch(e){errors.push(`${executablePath}: ${String((e as Error).message).split('\n')[0]}`);}
 }
 throw new Error(`No browser for playwright-core (set SIGONGNOTE_CHROMIUM).\n${errors.join('\n')}`);
}
async function screenshot(browser:Awaited<ReturnType<typeof chromium.launch>>,html:string,file:string){
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});await page.setContent(html,{waitUntil:'load'});
 const el=await page.$('.shot');await (el??page).screenshot({path:`${OUT}/${file}`});await page.close();return file;
}

async function main(){
 if((await verifyLocalDevelopmentDb()).status!=='READY')throw new Error('isolated E2E database not ready (node scripts/e2e-db.mjs, SIGONGNOTE_E2E_DB=1)');
 const runtime=claudeRuntimeConfig();if(!runtime)throw new Error('Claude credential required');
 const env=parseStrictLocalEnv(readFileSync('services/api/'+['.env'].join(''),'utf8'));
 const admin=postgres(String(env.MIGRATION_DATABASE_URL),{max:1,onnotice:()=>{}}),api=postgres(String(env.DATABASE_URL),{max:4,onnotice:()=>{}});
 const policy:CapturePolicy={id:'showcase-anthropic',purpose:'work_records',provider:'anthropic',processing_location:'provider_cloud',storage_location:'development_computer',retention:'until_user_deletes',external_processing:true};
 const tenants:string[]=[],users:string[]=[];const shots:Record<string,string>={};
 const browser=await launchBrowser();
 try{
  step('준비','격리 Postgres·Claude 런타임 확인',{database:'isolated postgres (sigongnote_e2e_*)',model:runtime.model,credential:runtime.credential,price_krw_per_million:{input:runtime.price.input_krw_per_million,output:runtime.price.output_krw_per_million}});
  // ── Company A: a virtual joinery company with two sites and yesterday's call about 망원동.
  const a=await company(admin,'가상 목공·창호 회사');tenants.push(a.tenant);users.push(a.user);
  const [mw]=await admin`insert into app.projects(tenant_id,display_name) values(${a.tenant}::uuid,'망원동 현장') returning id`;const mangwon=String(mw?.id);
  await admin`insert into app.projects(tenant_id,display_name) values(${a.tenant}::uuid,'성산동 현장')`;
  const yesterday=new Date(Date.now()-26*3600_000).toISOString(),twoDays=new Date(Date.now()-50*3600_000).toISOString();
  const call='[통화 전사 · 김반장] 김반장: 사장님 망원동 현장 문틀 100개 언제 와요? 대표: 내일 오전에 보내기로 했어요, 공급처에 얘기해 뒀어요. 김반장: 네, 오전에 받을게요.';
  const quote='[문자 · 성산동 타일] 성산동 욕실 타일 20박스 견적 부탁드립니다. 다음주 착공이에요.';
  const callId=await entry(admin,a,call,yesterday,'call_recording','통화 전사 10-09.txt',mangwon);
  await entry(admin,a,quote,twoDays,'sms','문자 10-08.txt');
  const sms='사장님, 그때 말씀하셨던 곳 물량 안 들어왔어요';
  const smsId=await entry(admin,a,sms,new Date().toISOString(),'sms','문자 오늘.txt');
  step('입력','가상 회사 A 자료 3건 (전부 가상 데이터)',{company:a.name,projects:['망원동 현장','성산동 현장'],records:[{kind:'통화 전사(어제)',text:call,project:'망원동 현장'},{kind:'문자(그제)',text:quote,project:null},{kind:'문자(오늘, 새로 도착)',text:sms,project:null}]});
  const runner=recordingRunner('맥락 복원 A');const outcomes:string[]=[];
  for(let i=0;i<5;i++){const r=await runContextRestoreOnce({db:api,runtime,policy,runner,tenantScope:a.tenant,timeoutMs:170000});outcomes.push(r);if(r==='idle')break;}
  step('맥락 복원 A','워커 결과',{outcomes});
  const events=await admin`select e.id,e.kind,e.summary,e.detail,e.project_id,p.display_name project_name,e.party,e.quantities,e.missing,e.confidence,e.reasoning,e.status,e.source_ref,e.model,
   (select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'title',f.title,'due_on',f.due_on,'state',f.state,'version',f.version) order by f.created_at),'[]') from app.work_followups f where f.tenant_id=e.tenant_id and f.event_id=e.id) followups
   from app.work_events e left join app.projects p on p.tenant_id=e.tenant_id and p.id=e.project_id where e.tenant_id=${a.tenant}::uuid order by e.created_at`;
  const smsEvents=events.filter(e=>e.source_ref===smsId);
  step('저장','DB에 남은 업무 사건과 할 일 (회사 A)',{events:events.map(e=>({kind:e.kind,summary:e.summary,project:e.project_name,party:e.party,quantities:e.quantities,missing:e.missing,confidence:e.confidence,reasoning:e.reasoning,source:e.source_ref===smsId?'오늘 문자':e.source_ref===callId?'어제 통화':'그제 문자',followups:e.followups})),sms_linked_to_mangwon:smsEvents.some(e=>e.project_id===mangwon)});
  const [usage]=await admin`select count(*)::int calls,sum(actual_krw)::int krw,jsonb_agg(jsonb_build_object('state',state,'krw',actual_krw,'usage',usage)) rows from app.product_ai_usage where tenant_id=${a.tenant}::uuid and channel='context'`;
  step('비용','공동 AI 사용량 원장 (channel context)',{calls:usage?.calls,total_krw:usage?.krw,rows:usage?.rows});
  // ── Today screen through the real API and the real React component.
  const app=createApp({db:api,agentRuntime:true,capturePolicy:policy,verifyToken:async()=>({userId:a.user,sessionId:a.session})});
  const headers={authorization:'Bearer showcase','x-tenant-id':a.tenant};
  try{
   const tasks=await app.inject({method:'GET',url:'/v1/work/journal/tasks',headers});const body=tasks.json();
   step('API','GET /v1/work/journal/tasks (오늘 화면이 읽는 응답)',{status:tasks.statusCode,items:body.items.map((t:any)=>({kind:t.kind,text:t.text,project_name:t.project_name,done:t.done,event_summary:t.event_summary,missing:t.missing})),events:body.events.length});
   shots.before=await screenshot(browser,todayScreen(body.items,'오늘 할 일'),'today-before.png');
   const mine=body.items.filter((t:any)=>t.kind==='followup'&&smsEvents.some(e=>e.id===t.event_id));
   const marks=[];for(const t of mine){const r=await app.inject({method:'POST',url:'/v1/work/journal/commands',headers:{...headers,'idempotency-key':randomUUID()},payload:{action:'task',id:t.id,client_command_id:randomUUID(),expected_version:t.version,done:true}});marks.push({title:t.text,status:r.statusCode,body:r.json()});}
   const stale=mine[0]?await app.inject({method:'POST',url:'/v1/work/journal/commands',headers:{...headers,'idempotency-key':randomUUID()},payload:{action:'task',id:mine[0].id,client_command_id:randomUUID(),expected_version:mine[0].version,done:false}}):null;
   const after=await app.inject({method:'GET',url:'/v1/work/journal/tasks',headers});const afterBody=after.json();
   const [ev]=await admin`select status from app.work_events where tenant_id=${a.tenant}::uuid and id=${smsEvents[0]?.id??randomUUID()}::uuid`;
   step('API','할 일 완료 표시 → 사건 종결 (버전 충돌은 409)',{marks,stale_version_retry:stale?{status:stale.statusCode,code:stale.json()?.error?.code??stale.json()?.code}:null,event_status_after:ev?.status});
   shots.after=await screenshot(browser,todayScreen(afterBody.items,'오늘 할 일'),'today-after.png');
   // ── Request understanding through the SDK planner.
   const turn=randomUUID();const start=await app.inject({method:'POST',url:'/v1/agent/runs',headers,payload:{client_turn_id:turn,project_id:mangwon,instruction:'망원동 문틀 어떻게 됐어? 오늘 뭐 챙겨야 해?',input_kind:'text'}});
   const runId=start.json().run_id;step('요청 이해','POST /v1/agent/runs',{status:start.statusCode,instruction:'망원동 문틀 어떻게 됐어? 오늘 뭐 챙겨야 해?',run_id:runId,initial:start.json().status});
   const services={db:api,agentRuntime:true,capturePolicy:policy,verifyToken:async()=>({userId:a.user,sessionId:a.session})};
   const planner=claudeAgentPlanner(services,runtime,recordingRunner('요청 이해'));
   // The production worker loops forever; here we drive it until the run leaves queued/running. runAgentOnce returns 'inflight' after 30s while the
   // run continues in the background, and a run whose model call ends near the 30s interactive deadline is parked as 'queued' for the next pass.
   const background=new Set<Promise<unknown>>();let outcome='';const passes:string[]=[];
   const readRun=async()=>(await app.inject({method:'GET',url:`/v1/agent/runs/${runId}`,headers})).json();
   let rb=await readRun();
   for(const started=Date.now();['queued','running'].includes(rb.status)&&Date.now()-started<240_000;rb=await readRun()){
    outcome=await runAgentOnce(services,{config:claudeProductAiConfig(runtime),model:planner,interactiveMs:30000,background},a.tenant);passes.push(outcome);
    if(background.size)await Promise.allSettled([...background]);else if(outcome==='idle')await new Promise(r=>setTimeout(r,1000));
   }
   step('요청 이해','GET /v1/agent/runs/:id — 사람이 읽는 답과 근거 카드',{worker:outcome,passes,status:rb.status,planner_mode:rb.planner_mode,answer:rb.answer,cards:(rb.cards??[]).map((c:any)=>({title:c.title,project:c.project_name,excerpt:c.excerpt})),coverage:rb.coverage,usage:rb.usage_summary});
   shots.ask=await screenshot(browser,`<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css()}.ask{display:grid;gap:12px}.q{font-weight:700}.a{white-space:pre-wrap;line-height:1.5}.card{border:1px solid var(--line);border-radius:8px;padding:10px;font-size:15px}</style></head><body><section class="shot ask"><h1 style="font-size:20px;margin:0">요청 결과</h1><p class="q">“망원동 문틀 어떻게 됐어? 오늘 뭐 챙겨야 해?”</p><p class="a">${String(rb.answer??'').replace(/</g,'&lt;')}</p>${(rb.cards??[]).slice(0,3).map((c:any)=>`<div class="card"><strong>${String(c.title).replace(/</g,'&lt;')}</strong><br>${String(c.excerpt).replace(/</g,'&lt;')}</div>`).join('')}</section></body></html>`,'ask-answer.png');
  }finally{await app.close();}
  // ── Company B: the same message with no history at all.
  const b=await company(admin,'가상 회사 B (기록 없음)');tenants.push(b.tenant);users.push(b.user);
  const orphanId=await entry(admin,b,sms,new Date().toISOString(),'sms','문자 오늘.txt');
  step('입력','가상 회사 B: 같은 문자, 과거 기록·현장 0건',{company:b.name,text:sms});
  const rB=await runContextRestoreOnce({db:api,runtime,policy,runner:recordingRunner('맥락 복원 B'),tenantScope:b.tenant,timeoutMs:170000});
  const orphan=await admin`select kind,summary,project_id,missing,confidence,reasoning,(select coalesce(jsonb_agg(f.title),'[]') from app.work_followups f where f.tenant_id=e.tenant_id and f.event_id=e.id) followups from app.work_events e where tenant_id=${b.tenant}::uuid and source_ref=${orphanId}::uuid`;
  const [pc]=await admin`select count(*)::int n from app.projects where tenant_id=${b.tenant}::uuid`;
  step('저장','회사 B 결과: 현장을 만들어내지 않음',{outcome:rB,events:orphan,projects_created:pc?.n});
  const appB=createApp({db:api,agentRuntime:false,capturePolicy:policy,verifyToken:async()=>({userId:b.user,sessionId:b.session})});
  try{const t=await appB.inject({method:'GET',url:'/v1/work/journal/tasks',headers:{authorization:'Bearer showcase','x-tenant-id':b.tenant}});shots.orphan=await screenshot(browser,todayScreen(t.json().items,'오늘 할 일'),'today-orphan.png');
   const cross=await appB.inject({method:'GET',url:'/v1/work/journal/tasks',headers:{authorization:'Bearer showcase','x-tenant-id':a.tenant}});step('경계','회사 B 계정으로 회사 A 할 일 조회 → 차단',{status:cross.statusCode,code:cross.json()?.error?.code??cross.json()?.code});
  }finally{await appB.close();}
  step('멱등','같은 원천 재처리 시도 → idle',{a:await runContextRestoreOnce({db:api,runtime,policy,runner,tenantScope:a.tenant}),b:await runContextRestoreOnce({db:api,runtime,policy,runner,tenantScope:b.tenant})});
  const [cost]=await admin`select count(*)::int calls,sum(actual_krw)::int krw from app.product_ai_usage where tenant_id=any(${tenants}::uuid[])`;
  const run={started_at:new Date(started).toISOString(),finished_at:new Date().toISOString(),duration_ms:Date.now()-started,model:runtime.model,total_calls:cost?.calls,total_krw:cost?.krw,shots,steps};
  writeFileSync(`${OUT}/run.json`,JSON.stringify(run,null,1));
  console.log(`showcase written: ${OUT}/run.json (${steps.length} steps, ${run.duration_ms} ms)`);
 }finally{
  await browser.close();
  try{await admin.begin(async tx=>{await deleteFixtureTenants(tx,tenants);for(const u of users){await tx`delete from auth.sessions where user_id=${u}::uuid`;await tx`delete from auth.users where id=${u}::uuid`;}});}
  finally{await Promise.all([admin.end(),api.end()]);}
 }
}
await main();
