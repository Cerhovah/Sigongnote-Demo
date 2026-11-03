import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {photoFixture} from './photo-fixture.js';
import {runPhotoSheetOnce} from '../services/api/src/photo-sheet-worker.js';
import {runDeliveryOnce} from '../services/api/src/delivery-worker.js';
import {runAgentOnce} from '../services/api/src/agent-runs.js';
import type {FaxRuntime,FaxResult,FaxProvider} from '../services/api/src/fax-provider.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(provider:FaxProvider){
 const fax:FaxRuntime={binding:'synthetic-test',accounts:[],provider:()=>provider,webhookKey:'synthetic-webhook-key-for-tests-only',webhookUntil:'2099-01-01T00:00:00Z'},f=await photoFixture({fax});fax.accounts.push({tenant:f.f.tenant,corp:'0000000000',user:'synthetic',sender:'00000000000',max_page_krw:10,day_krw:100,month_krw:100,valid_until:'2099-01-01T00:00:00Z'});
 const revision=await f.upload(png),group=(await f.post('/v1/photos/groups',{client_command_id:randomUUID(),project_id:f.project,title:'합성 사진대지',photos:[{revision_id:revision}]})).json().id;
 const sheet=(await f.post('/v1/photo-sheets',{project_id:f.project,group_id:group,layout:4,grayscale:true})).json().photo_sheet.id;
 assert.equal(await runPhotoSheetOnce({db:f.worker,tenantScope:f.f.tenant,python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker'),download:async(i:any)=>f.files.get(i.storage_key)!}),'stored');
 const draft=async(number='00000000000')=>{const r=await f.post('/v1/deliveries/prepare',{source_kind:'photo_sheet',source_id:sheet,project_id:f.project,recipient_name:'합성 수신처',recipient_number:number});assert.equal(r.statusCode,200,r.body);return r.json().delivery;};
 const authorize=async(d:any,extra={})=>f.post('/v1/deliveries/authorize',{id:d.id,scope_hash:d.scope_hash,max_cost_krw:10,client_command_id:randomUUID(),...extra});
 const wake=()=>f.admin`update app.outbox set business_available_at=now(),business_lease_until=null where tenant_id=${f.f.tenant}::uuid and topic='delivery_ready'`;
 return {...f,fax,sheet,revision,draft,authorize,wake};
}
const unknown:FaxResult={state:'unknown',receipt:null,chargePages:null};
test('N20 unknown survives restart without resending; authenticated webhook only wakes verified status and cost',async()=>{
 let sends=0,lookups=0,answer=unknown;const f=await fixture({price:async()=>5,send:async()=>{sends++;throw Error('mock response lost');},lookup:async()=>{lookups++;return answer;}});
 try{const d=await f.draft();assert.equal((await f.draft()).id,d.id);const key=randomUUID();const auth=await f.authorize(d,{client_command_id:key});assert.equal(auth.statusCode,200,auth.body);assert.equal((await f.authorize(d,{client_command_id:key})).statusCode,200);
  assert.equal((await f.authorize(d,{scope_hash:'0'.repeat(64)})).statusCode,409);const changed=await f.draft('00000000001');assert.notEqual(changed.scope_hash,d.scope_hash);assert.equal((await f.authorize(changed,{scope_hash:d.scope_hash})).statusCode,409);
  assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'unknown');assert.equal(sends,1);const state=(await f.get('/v1/deliveries/'+d.id)).json();assert.equal(state.actual_krw,null);assert.equal(state.reserved_krw,10);
  const [a]=await f.admin`select * from app.delivery_attempts where tenant_id=${f.f.tenant}::uuid and delivery_id=${d.id}::uuid`;assert.ok(a!.submitted_at);const webhook={method:'POST' as const,url:'/v1/fax/webhook',headers:{'x-api-key':f.fax.webhookKey!,'pb-webhook-mid':'synthetic-event','pb-webhook-type':'FAX.STATE','pb-webhook-corpnum':'0000000000'},payload:{corpNum:'0000000000',requestNum:a!.id,state:3,result:100}};
  assert.equal((await f.app.inject({...webhook,headers:{...webhook.headers,'x-api-key':'invalid'}})).statusCode,401);f.fax.webhookUntil='2000-01-01T00:00:00Z';assert.equal((await f.app.inject(webhook)).statusCode,401);f.fax.webhookUntil='2099-01-01T00:00:00Z';assert.equal((await f.app.inject(webhook)).statusCode,200);assert.equal((await f.app.inject(webhook)).statusCode,200);
  assert.equal((await f.get('/v1/deliveries/'+d.id)).json().state,'unknown');assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'unknown');assert.equal(sends,1);assert.equal(lookups,1);
  answer={state:'delivered',receipt:'000000000000000001',chargePages:null};await f.wake();assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'delivered');assert.equal((await f.get('/v1/deliveries/'+d.id)).json().actual_krw,null);
  answer=unknown;await f.wake();await runDeliveryOnce(f.services,f.f.tenant);assert.equal((await f.get('/v1/deliveries/'+d.id)).json().state,'delivered');
  answer={state:'delivered',receipt:'000000000000000001',chargePages:1};await f.wake();assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'delivered');assert.equal((await f.get('/v1/deliveries/'+d.id)).json().actual_krw,5);
  await f.app.inject({...webhook,headers:{...webhook.headers,'pb-webhook-mid':'synthetic-old-failure'},payload:{...webhook.payload,result:999}});assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'idle');assert.equal((await f.get('/v1/deliveries/'+d.id)).json().state,'delivered');assert.equal(sends,1);
  assert.equal((await f.get('/v1/deliveries/'+d.id,randomUUID())).statusCode,404);await assert.rejects(f.worker`select * from app.delivery_attempts`,/permission denied/);assert.equal((await f.api`select * from app.deliveries`).length,0);
  const run=await f.post('/v1/agent/runs',{client_turn_id:randomUUID(),project_id:f.project,instruction:'팩스로 보내줘',input_kind:'text'});await runAgentOnce(f.services,{},f.f.tenant);assert.equal((await f.get('/v1/agent/runs/'+run.json().run_id)).json().delivery_choices,true);assert.equal(sends,1);
 }finally{await f.close();}
});
test('N20 cancellation vs submit, expiry and withdrawal never send; OS sharing cancellation is not delivery',async()=>{
 let sends=0,release:()=>void=()=>{},waiting=false;const f=await fixture({price:async()=>{waiting=true;await new Promise<void>(r=>{release=r;});return 5;},send:async()=>{sends++;return {state:'submitted',receipt:'000000000000000001',chargePages:null};},lookup:async()=>unknown});
 try{const d=await f.draft();assert.equal((await f.authorize(d)).statusCode,200);const processing=runDeliveryOnce(f.services,f.f.tenant);for(let i=0;!waiting&&i<50;i++)await new Promise(r=>setTimeout(r,20));assert.ok(waiting);assert.equal((await f.post('/v1/deliveries/cancel',{id:d.id,scope_hash:d.scope_hash})).json().cancelled,true);release();await processing;assert.equal(sends,0);assert.equal((await f.get('/v1/deliveries/'+d.id)).json().actual_krw,0);
  f.fax.provider=()=>({price:async()=>5,send:async()=>{sends++;return unknown;},lookup:async()=>unknown});const e=await f.draft('00000000001');await f.authorize(e);await f.admin`update app.delivery_attempts set expires_at=now()-interval '1 minute' where tenant_id=${f.f.tenant}::uuid and delivery_id=${e.id}::uuid`;assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'cancelled');assert.equal(sends,0);
  const intent=randomUUID();assert.equal((await f.post('/v1/photo-sheets/share',{id:f.sheet,intent_id:intent,outcome:'unknown'})).statusCode,404);assert.equal((await f.post('/v1/photo-sheets/share',{id:f.sheet,intent_id:intent,outcome:'prepared'})).statusCode,200);const cancelled=await f.post('/v1/photo-sheets/share',{id:f.sheet,intent_id:intent,outcome:'cancelled'});assert.equal(cancelled.json().delivery_confirmed,false);
  const next=await f.draft('00000000002');await f.authorize(next);await f.admin`update app.capture_sources set server_upload_consent=false where tenant_id=${f.f.tenant}::uuid and id=${f.f.source}::uuid`;await f.wake();await runDeliveryOnce(f.services,f.f.tenant);await runDeliveryOnce(f.services,f.f.tenant);assert.equal(sends,0);assert.equal((await f.get('/v1/deliveries/'+next.id)).json().available,false);
 }finally{release();await f.close();}
});
test('N20 explicit retry keeps old unknown attempt reserved; sending budget and account binding enforced',async()=>{
 let sends=0;const f=await fixture({price:async()=>5,send:async()=>{sends++;return unknown;},lookup:async()=>unknown});try{
  f.fax.accounts[0]!.month_krw=20;const d=await f.draft();await f.authorize(d);await runDeliveryOnce(f.services,f.f.tenant);
  assert.equal((await f.authorize(d,{retry:true})).statusCode,422);assert.equal((await f.authorize(d,{retry:true,duplicate_risk_ack:true})).statusCode,200);await f.wake();await runDeliveryOnce(f.services,f.f.tenant);await runDeliveryOnce(f.services,f.f.tenant);assert.equal(sends,2);
  const [cost]=await f.admin`select sum(coalesce(actual_krw,reserved_krw))::int n from app.delivery_attempts where tenant_id=${f.f.tenant}::uuid`;assert.equal(cost!.n,20);assert.equal((await f.authorize(d,{retry:true,duplicate_risk_ack:true})).statusCode,422);
  f.fax.binding='synthetic-live';await f.wake();assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'account_changed');assert.equal(sends,2);f.fax.binding='synthetic-test';
  f.fax.accounts[0]!.corp='0000000001';await f.wake();assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'account_changed');assert.equal(sends,2);
 }finally{await f.close();}
});

test('N20 unsubmitted account change, excessive price and expiry release reservations with a reason; delivered retry is explicit',async()=>{
 let sends=0,price=5,quotes=0;const f=await fixture({price:async()=>{quotes++;return price;},send:async()=>{sends++;return {state:'delivered',receipt:'000000000000000001',chargePages:1};},lookup:async()=>unknown});
 try{
  const d=await f.draft();await f.authorize(d);f.fax.binding='synthetic-live';assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'cancelled');
  let shown=(await f.get('/v1/deliveries/'+d.id)).json();assert.equal(shown.cancel_reason,'account_changed');assert.equal(shown.pending_cost_krw,0);assert.equal(shown.actual_krw,0);assert.equal(sends,0);
  price=11;assert.equal((await f.authorize(d,{retry:true})).statusCode,200);assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'cancelled');assert.equal((await f.get('/v1/deliveries/'+d.id)).json().cancel_reason,'price_over_cap');
  await f.authorize(d,{retry:true});await f.admin`update app.delivery_attempts set expires_at=now()-interval '1 minute' where tenant_id=${f.f.tenant}::uuid and delivery_id=${d.id}::uuid and state='authorized'`;const oldQuotes=quotes;assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'cancelled');assert.equal(quotes,oldQuotes);assert.equal((await f.get('/v1/deliveries/'+d.id)).json().cancel_reason,'expired');
  price=5;assert.equal((await f.authorize(d,{retry:true})).statusCode,200);assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'delivered');assert.equal(sends,1);
  assert.equal((await f.authorize(d,{retry:true})).statusCode,422);assert.equal((await f.authorize(d,{retry:true,duplicate_risk_ack:true})).statusCode,200);assert.equal(await runDeliveryOnce(f.services,f.f.tenant),'delivered');assert.equal(sends,2);
  shown=(await f.get('/v1/deliveries/'+d.id)).json();assert.equal(shown.submitted_attempts,2);assert.equal(shown.known_cost_krw,10);assert.equal(shown.pending_cost_krw,0);
 }finally{await f.close();}
});
