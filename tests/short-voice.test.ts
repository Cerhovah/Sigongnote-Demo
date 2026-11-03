import {deleteFixtureTenants} from './fixture-cleanup.js';
import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import postgres from "postgres";
import {verifyLocalDevelopmentDb} from "../scripts/db-gate.mjs";
import {parseStrictLocalEnv} from "../scripts/local-env-values.mjs";
import {createApp} from "../services/api/src/app.js";
import {configuredShortStt,shortAudio,measuredVoiceSeconds,VOICE_VERSION,ShortSttNotAccepted,type ShortStt} from "../services/api/src/short-stt.js";

test("D10 decoder and provider are explicit, bounded and disabled by default",()=>{
 assert.equal(configuredShortStt({}),undefined);
 assert.throws(()=>measuredVoiceSeconds({format:{duration:"5"},streams:[{codec_type:"audio"}],packets:[{pts_time:"119",duration_time:"1"}]}),/DURATION/);
 assert.throws(()=>measuredVoiceSeconds({format:{duration:"5"},streams:[{codec_type:"audio"}],packets:[]}),/DURATION/);
 assert.equal(measuredVoiceSeconds({format:{duration:"N/A"},streams:[{codec_type:"audio"}],packets:[{pts_time:"4",duration_time:"1"}]}),5);
 assert.equal(configuredShortStt({SHORT_STT_ENABLED:"true"}),undefined);
 assert.throws(()=>shortAudio(Buffer.alloc(20),"audio/webm"),/FORMAT/);
 assert.throws(()=>shortAudio(Buffer.alloc(786433),"audio/webm"),/SIZE/);
});
test("D10 consent, one transcription per request, cancellation, tenant and shared budget",async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,"READY");
 const env=parseStrictLocalEnv(readFileSync("services/api/.env","utf8"));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1}),db=postgres(env.DATABASE_URL!,{max:4});
 const tenant=randomUUID(),user=randomUUID(),second=randomUUID(),session=randomUUID(),secondSession=randomUUID();
 let calls=0,probeDuration=3,release:((s:string)=>void)|undefined,started:(()=>void)|undefined,hold=false;
 const engine:ShortStt={label:"합성 음성",model:"fixture",version:VOICE_VERSION,dailySeconds:93,async probe(){return probeDuration;},async transcribe(){calls++;started?.();return hold?new Promise<string>(r=>{release=r;}):"석고보드 12개 찾아줘";}};
 const app=createApp({db,shortStt:engine,verifyToken:async token=>token==="second"?{userId:second,sessionId:secondSession}:{userId:user,sessionId:session}});
 const call=(url:string,payload?:object,token="first",scope=tenant)=>app.inject({method:payload?"POST":"GET",url,headers:{authorization:`Bearer ${token}`,"x-tenant-id":scope},...(payload?{payload}:{})});
 const bytes=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.alloc(20)]);
 const body=()=>({id:randomUUID(),mime:"audio/webm",audio:bytes.toString("base64"),consent_version:VOICE_VERSION});
 try{
  await admin`insert into auth.users(id) values(${user}::uuid),(${second}::uuid)`;
  await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid),(${secondSession}::uuid,${second}::uuid)`;
  await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'D10 synthetic')`;
  await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner'),(${tenant}::uuid,${second}::uuid,'operator')`;
  assert.equal((await call('/v1/voice/transcribe',body())).statusCode,422);assert.equal(calls,0);
  for(const token of ['first','second'])assert.equal((await call('/v1/voice/consent',{allowed:true,consent_version:VOICE_VERSION},token)).statusCode,200);
  const first=body(),result=await call('/v1/voice/transcribe',first);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().state,'completed');
  assert.equal((await call('/v1/voice/transcribe',first)).json().transcript,result.json().transcript);assert.equal(calls,1);
  const changed=Buffer.from(bytes);changed[10]=1;
  assert.equal((await call('/v1/voice/transcribe',{...first,audio:changed.toString('base64')})).statusCode,409);
  assert.equal((await call(`/v1/voice/${first.id}`,undefined,'second')).statusCode,404);
  assert.equal((await call(`/v1/voice/${first.id}`,undefined,'first',randomUUID())).statusCode,404);
  hold=true;const pending=body();const begun=new Promise<void>(r=>{started=r;});const request=call('/v1/voice/transcribe',pending);void request.then(()=>{});await begun;
  assert.equal((await call('/v1/voice/transcribe',pending)).json().state,'working');assert.equal(calls,2);
  await call('/v1/voice/consent',{allowed:false,consent_version:VOICE_VERSION});release?.('취소한 음성');assert.notEqual((await request).json().state,'completed');
  assert.equal((await call(`/v1/voice/${pending.id}`)).json().transcript,null);
  hold=false;probeDuration=60;assert.equal((await call('/v1/voice/transcribe',body(),'second')).json().state,'failed');assert.equal(calls,2);
  assert.equal((await call('/v1/voice/transcribe',body(),'second')).json().state,'limited');
  assert.equal((await db`select * from app.voice_requests`).length,0);
 }finally{
  release?.('cleanup');await app.close();
  try{await admin.begin(async tx=>{
   await deleteFixtureTenants(tx,[tenant]);
   await tx`delete from auth.sessions where user_id in (${user}::uuid,${second}::uuid)`;await tx`delete from auth.users where id in (${user}::uuid,${second}::uuid)`;
  });}finally{await db.end();await admin.end();}
 }
});
test('N03 short STT distinguishes explicit request rejection from ambiguous server failure',async()=>{
 const env={SHORT_STT_ENABLED:'true',SHORT_STT_API_KEY:'synthetic',SHORT_STT_FFPROBE:process.execPath,SHORT_STT_DAILY_SECONDS:'3600',SHORT_STT_PRICE_JSON:JSON.stringify({version:'test-v1',model:'gpt-transcribe',krw_per_minute:30,valid_until:'2099-01-01T00:00:00Z'})};
 for(const status of [400,401,403,404,413,422,429,500,503]){
  const engine=configuredShortStt(env,(async()=>new Response('{"error":"synthetic"}',{status})) as typeof fetch)!;
  await assert.rejects(engine.transcribe(Buffer.alloc(20),'audio/webm',AbortSignal.timeout(1000)),error=>status<500?error instanceof ShortSttNotAccepted&&error.status===status:error instanceof Error&&!(error instanceof ShortSttNotAccepted));
 }
});

test('N03 paid voice joins user money budget and freezes the consent generation',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}}),db=postgres(env.DATABASE_URL!,{max:3});
 const tenant=randomUUID(),user=randomUUID(),session=randomUUID();let calls=0,hold=false,providerError:Error|undefined,release:((s:string)=>void)|undefined,started:(()=>void)|undefined;
 const engine:ShortStt={label:'시험 음성',model:'gpt-transcribe',version:VOICE_VERSION,dailySeconds:3600,billing:{version:'test-v1',model:'gpt-transcribe',krw_per_minute:30,valid_until:'2099-01-01T00:00:00Z'},async probe(){return 3;},async transcribe(){calls++;started?.();if(providerError)throw providerError;return hold?new Promise<string>(r=>{release=r;}):'자료 찾아줘';}};
 const app=createApp({db,shortStt:engine,verifyToken:async()=>({userId:user,sessionId:session})});
 const call=(url:string,payload:object)=>app.inject({method:'POST',url,headers:{authorization:'Bearer test','x-tenant-id':tenant},payload});
 const request=()=>({id:randomUUID(),mime:'audio/webm',audio:Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.alloc(20)]).toString('base64'),consent_version:VOICE_VERSION});
 try{
  await admin`insert into auth.users(id) values(${user}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'N03 voice synthetic')`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
  await call('/v1/voice/consent',{allowed:true,consent_version:VOICE_VERSION});
  await admin`insert into app.product_ai_usage(tenant_id,user_id,id,channel,request_hash,config,reserved_krw,actual_krw,state) values(${tenant}::uuid,${user}::uuid,${randomUUID()}::uuid,'short_stt',${'a'.repeat(64)},'{}',9999,9999,'settled')`;
  assert.equal((await call('/v1/voice/transcribe',request())).json().state,'limited');assert.equal(calls,0);
  await admin`update app.product_ai_usage set actual_krw=9900 where tenant_id=${tenant}::uuid`;
  const complete=request();assert.equal((await call('/v1/voice/transcribe',complete)).json().state,'completed');assert.equal(calls,1);
  assert.equal((await admin`select actual_krw from app.product_ai_usage where tenant_id=${tenant}::uuid and id=${complete.id}::uuid`)[0]?.actual_krw,'2');
  hold=true;const begun=new Promise<void>(r=>{started=r;}),pending=request();const promise=call('/v1/voice/transcribe',pending);void promise.then(()=>{});await begun;
  await call('/v1/voice/consent',{allowed:false,consent_version:VOICE_VERSION});await call('/v1/voice/consent',{allowed:true,consent_version:VOICE_VERSION});release?.('철회된 발화');assert.notEqual((await promise).json().state,'completed');
  const [row]=await admin`select state,reserved_krw,actual_krw from app.product_ai_usage where tenant_id=${tenant}::uuid and id=${pending.id}::uuid`;assert.equal(row?.state,'settled');assert.equal(row?.reserved_krw,'2');assert.equal(row?.actual_krw,'2');
  assert.equal((await admin`select transcript from app.voice_requests where tenant_id=${tenant}::uuid and id=${pending.id}::uuid`)[0]?.transcript,null);
  const cancelBegun=new Promise<void>(r=>{started=r;}),cancelled=request(),cancelRequest=call('/v1/voice/transcribe',cancelled);void cancelRequest.then(()=>{});await cancelBegun;
  await call(`/v1/voice/${cancelled.id}/cancel`,{});release?.('취소 후 완료된 발화');assert.notEqual((await cancelRequest).json().state,'completed');
  assert.equal((await admin`select actual_krw from app.product_ai_usage where tenant_id=${tenant}::uuid and id=${cancelled.id}::uuid`)[0]?.actual_krw,'2');
  assert.equal((await admin`select transcript from app.voice_requests where tenant_id=${tenant}::uuid and id=${cancelled.id}::uuid`)[0]?.transcript,null);
  hold=false;started=undefined;providerError=new ShortSttNotAccepted(429);const denied=request();assert.equal((await call('/v1/voice/transcribe',denied)).json().state,'failed');
  const [deniedRow]=await admin`select state,actual_krw,usage from app.product_ai_usage where tenant_id=${tenant}::uuid and id=${denied.id}::uuid`;assert.equal(deniedRow?.state,'settled');assert.equal(deniedRow?.actual_krw,'0');assert.equal(deniedRow?.usage.http_status,429);
  providerError=new Error('VOICE_PROVIDER_UNAVAILABLE');const ambiguous=request();assert.equal((await call('/v1/voice/transcribe',ambiguous)).json().state,'failed');
  const [ambiguousRow]=await admin`select state,actual_krw from app.product_ai_usage where tenant_id=${tenant}::uuid and id=${ambiguous.id}::uuid`;assert.equal(ambiguousRow?.state,'unknown');assert.equal(ambiguousRow?.actual_krw,null);
 }finally{release?.('cleanup');await app.close();await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant]);await tx`delete from auth.sessions where user_id=${user}::uuid`;await tx`delete from auth.users where id=${user}::uuid`;});await Promise.all([admin.end(),db.end()]);}
});
