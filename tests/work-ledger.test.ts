import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';

test('N31m ledger deduplicates categories, pages event history, keeps dates/effects honest and fences company/revocation',async()=>{
 const db=await processingFixture(),f=await db.createFixture('합성현장 28개 인수\n표 자료'),foreign=await db.createFixture('합성 다른 회사'),project=randomUUID(),context=randomUUID(),bundle=randomUUID(),order=randomUUID();
 const app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
 const get=(url:string,tenant=f.tenant)=>app.inject({method:'GET',url,headers:{authorization:'Bearer fixture','x-tenant-id':tenant}});
 try{
  await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성 원장 현장')`;
  await db.admin`insert into app.work_orders(tenant_id,id,project_id,display_name) values(${f.tenant}::uuid,${order}::uuid,${project}::uuid,'합성계약')`;
  await db.admin`insert into app.work_bundles(tenant_id,id,work_order_id,display_name,trade_pack_id,trade_pack_version,trade_pack_hash) values(${f.tenant}::uuid,${bundle}::uuid,${order}::uuid,'자재 납품','construction','1.0.0',${'a'.repeat(64)})`;
  await db.admin`insert into app.work_contexts(tenant_id,id,project_id,label,bundle_id) values(${f.tenant}::uuid,${context}::uuid,${project}::uuid,'주방 자재',${bundle}::uuid)`;
  await db.admin`update app.evidence_organizations set state='linked',project_id=${project}::uuid,project_candidates=${[project]}::uuid[],context_id=${context}::uuid,categories=${['agreement','delivery_work']}::text[],version=version+1 where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  for(const query of ['',`?category=agreement`,`?category=delivery_work`,`?project_id=${project}`]){const r=await get('/v1/work/ledger'+query);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().items.length,1);assert.equal(r.json().items[0].evidence_count,1);assert.deepEqual(r.json().items[0].categories.sort(),['agreement','delivery_work']);}
  assert.equal((await get('/v1/work/ledger?category=billing_payment')).json().items.length,0);
  assert.equal((await get('/v1/work/ledger?cursor=invalid')).statusCode,400);
  assert.equal((await get('/v1/work/agenda')).json().items.length,0,'received date must not become a due date');
  const [ev]=await db.admin`select id from app.evidence_index where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid limit 1`;
  const decision=randomUUID(),hash=createHash('sha256').update(decision).digest('hex');
  await db.admin`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) values(${f.tenant}::uuid,${decision}::uuid,${f.user}::uuid,'exception_resolution','apply_work_answer',${[randomUUID(),context]}::uuid[],${[1,1]}::bigint[],${[ev!.id]}::uuid[],'합성 일정 확인',${hash})`;
  const [clock]=await db.admin`select (now() at time zone 'Asia/Seoul')::date::text today`;
  await db.admin`insert into app.work_projections(tenant_id,context_id,version,state,decision_id) values(${f.tenant}::uuid,${context}::uuid,1,${db.admin.json({schedule:clock!.today})},${decision}::uuid)`;
  assert.equal((await get('/v1/work/agenda')).json().items[0].due_date,clock!.today);
  // A backlog must never push today's explicit schedule out of the bounded response.
  for(let i=0;i<41;i++){
   const older=randomUUID();
   await db.admin`insert into app.work_contexts(tenant_id,id,project_id,label) values(${f.tenant}::uuid,${older}::uuid,${project}::uuid,${'합성 지난 일정 '+i})`;
   await db.admin`insert into app.work_projections(tenant_id,context_id,version,state,decision_id) values(${f.tenant}::uuid,${older}::uuid,1,${db.admin.json({schedule:'2020-01-01'})},${decision}::uuid)`;
  }
  const agenda=(await get('/v1/work/agenda')).json();assert.equal(agenda.items[0].id,context);assert.equal(agenda.items.length,40);assert.equal(agenda.partial,true);
  for(let i=1;i<=102;i++){
   const id=randomUUID(),event={id,tenantId:f.tenant,contextId:context,sequence:i,kind:i===1?'payment':'request',subject:'합성 문틀 900 x 2100',transactionKey:null,quantity:i===102?{value:'28.5',unitCode:'ea'}:null,amount:i===102?{minor:'9007199254740993',knowledge:'known',currency:'KRW'}:{minor:null,knowledge:'unknown',currency:'KRW'},mode:'observed',asserted:false,existingEffect:null,evidenceIds:[f.revision],evidenceWithdrawn:false,effectiveAt:null,recordedAt:new Date(1791000000000+i*1000).toISOString(),supersedes:null,reverses:null};
   await db.admin`insert into app.business_events(tenant_id,id,context_id,sequence,adapter_kind,adapter_id,source_revision,source_version,source_refs,event_key,event,actor_kind,policy_version,expected_projection_version) values(${f.tenant}::uuid,${id}::uuid,${context}::uuid,${i},'work_command',${randomUUID()}::uuid,${f.revision}::uuid,'fixture',${[f.revision]}::uuid[],${createHash('sha256').update(id).digest('hex')},${db.admin.json(event)},'human_approved','fixture',0)`;
  }
  const detail=await get('/v1/work/ledger/'+context);assert.equal(detail.statusCode,200,detail.body);const body=detail.json();assert.equal(body.events.length,100);assert.equal(body.approval_confirmed,false);assert.equal(body.payment_executed,false);assert.equal(body.events[0].occurred_at,null);assert.equal(body.events[0].subject,'합성 문틀 900 x 2100');assert.deepEqual(body.events[0].quantity,{value:'28.5',unitCode:'ea'});assert.equal(body.events[0].amount.minor,'9007199254740993');assert.equal(body.events[1].amount.minor,null);
  const page=(await get(`/v1/work/ledger/${context}?cursor=${body.next_cursor}`)).json();assert.equal(page.events.length,2);assert.equal(page.next_cursor,null);assert.equal(page.events[1].kind,'payment');assert.ok(!page.events.some((e:{id:string})=>body.events.some((old:{id:string})=>e.id===old.id)));
  assert.equal((await get('/v1/work/ledger',foreign.tenant)).statusCode,404);
  const feed=(await get(`/v1/sync/changes?kind=material&id=${f.revision}`)).json().changes[0];assert.equal(feed.project_name,'합성 원장 현장');assert.equal(feed.organization_state,'linked');
  await db.admin`update app.capture_sources set server_upload_consent=false where tenant_id=${f.tenant}::uuid and id=${f.source}::uuid`;
  assert.equal((await get('/v1/work/ledger')).json().items.length,0);assert.equal((await get('/v1/work/ledger/'+context)).statusCode,404);assert.equal((await get('/v1/work/agenda')).json().items.length,0);
 }finally{await app.close();await db.cleanup();}
});
