import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';import {createApp} from '../services/api/src/app.js';import {productAiConfig} from '../services/api/src/product-ai-config.js';
import Fastify from 'fastify';import {registerActivity} from '../services/api/src/work-activity.js';
test('N30 owner sees scoped congestion and budget reservations after withdrawal; other company/operator denied',async()=>{
 const f=await processingFixture();const a=await f.createFixture('합성 운영 대기'),b=await f.createFixture('합성 다른 회사');
 const app=createApp({activityObserverUserIds:[a.user],db:f.api,verifyToken:async()=>({userId:a.user,sessionId:a.session})});
 try{
  await f.admin`insert into app.product_ai_usage(tenant_id,user_id,id,channel,request_hash,config,state,reserved_krw,actual_krw,evidence_withdrawn) values(${a.tenant}::uuid,${a.user}::uuid,${randomUUID()}::uuid,'short_stt',${'1'.repeat(64)},'{}','unknown',123,null,true),(${b.tenant}::uuid,${b.user}::uuid,${randomUUID()}::uuid,'short_stt',${'2'.repeat(64)},'{}','settled',999,999,false)`;
  await f.admin`update app.jobs set state='leased',lease_owner='synthetic-expired',lease_token=${randomUUID()}::uuid,lease_expires_at=now()-interval '1 minute',created_at=now()-interval '10 minutes' where tenant_id=${a.tenant}::uuid and id=${a.job}::uuid`;
  const headers={authorization:'Bearer synthetic','x-tenant-id':a.tenant},result=await app.inject({url:'/v1/work/activity',headers});assert.equal(result.statusCode,200,result.body);const op=result.json().operations;
  assert.equal(op.budget.monthly_krw,'123');assert.equal(op.budget.unknown_count,1);assert.equal(op.budget.includes_reservations,true);assert.equal(op.budget.scope,'current_user_all_companies');assert.ok(op.storage.used_bytes>0);assert.equal(op.queues[0].expired_leases,1);assert.ok(op.queues[0].oldest_seconds>=600);assert.equal(op.acceptance,'not_evaluated');assert.doesNotMatch(JSON.stringify(op),new RegExp(b.tenant+'|合成|합성 다른 회사'));
  assert.equal((await app.inject({url:'/v1/work/activity',headers:{...headers,'x-tenant-id':b.tenant}})).statusCode,404);
  await f.admin`insert into app.memberships(tenant_id,user_id,role) values(${a.tenant}::uuid,${b.user}::uuid,'owner')`;await f.admin`update app.memberships set role='operator' where tenant_id=${a.tenant}::uuid and user_id=${a.user}::uuid`;assert.equal((await app.inject({url:'/v1/work/activity',headers})).statusCode,404);
 }finally{await app.close();await f.cleanup();}
});
test('N30 explicit semantic pause disables paid config while legacy unset flag remains compatible',()=>{
 const price={version:'synthetic',provider:'openai',model:'synthetic',input_krw_per_million:1,output_krw_per_million:1,valid_until:'2099-01-01T00:00:00Z',conversion_note:'synthetic'};const env={SEMANTIC_PROVIDER:'openai',SEMANTIC_MODEL:'synthetic',SEMANTIC_API_KEY:'x'.repeat(24),SEMANTIC_PRICE_JSON:JSON.stringify(price)};
 assert.ok(productAiConfig(env));assert.equal(productAiConfig({...env,SEMANTIC_ENABLED:'false'}),undefined);assert.equal(productAiConfig({...env,SEMANTIC_ENABLED:'invalid'}),undefined);assert.ok(productAiConfig({...env,SEMANTIC_ENABLED:'true'}));
});

test('N30 optional metrics SQL failure preserves owner activity and commits prior retention work',async()=>{
 const f=await processingFixture(),app=Fastify();
 try{
  const a=await f.createFixture('합성 지표 실패 격리');let attempted=false;
  registerActivity(app,{activityObserverUserIds:[a.user],db:f.api,verifyToken:async()=>({userId:a.user,sessionId:a.session})},async tx=>{attempted=true;await tx`select 1/0`;throw Error('unreachable');});
  const headers={authorization:'Bearer synthetic','x-tenant-id':a.tenant};
  const consent=(await app.inject({method:'POST',url:'/v1/work/activity/consent',headers,payload:{allowed:true}})).json();
  const id=randomUUID(),expired=randomUUID();
  for(const [eventId,age] of [[id,0],[expired,91]] as const)await f.admin`insert into app.activity_events(tenant_id,user_id,consent_id,id,session_id,happened_at,received_at,kind,screen,label,platform,content,truncated) values(${a.tenant}::uuid,${a.user}::uuid,${consent.consent_id}::uuid,${eventId}::uuid,${randomUUID()}::uuid,now(),now()-${age}*interval '1 day','request','synthetic','합성 기록','web','합성 내용',false)`;
  const result=await app.inject({url:'/v1/work/activity',headers});assert.equal(result.statusCode,200,result.body);assert.equal(attempted,true);assert.equal(result.json().operations,null);assert.equal(result.json().summary.requests,1);assert.equal(result.json().events[0].id,id);
  assert.equal((await f.admin`select id from app.activity_events where tenant_id=${a.tenant}::uuid and id=${expired}::uuid`).length,0);
 }finally{await app.close();await f.cleanup();}
});
