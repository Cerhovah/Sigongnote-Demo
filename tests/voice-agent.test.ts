import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
import {runAgentOnce} from '../services/api/src/agent-runs.js';
import {WorkRequestSchema} from '../packages/contracts/src/schemas.js';
import {workHttp} from '../packages/contracts/src/work.js';

test('N21 corrected voice and writing share durable tool plans, site, cancellation and idempotency',async()=>{
 const db=await processingFixture();let app:ReturnType<typeof createApp>|undefined;
 try{
  const f=await db.createFixture('합성 석고보드 28개 인수 미확인'),other=await db.createFixture();
  const services={db:db.api,agentRuntime:true,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})};app=createApp(services);
  const project=randomUUID();await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'햇살현장')`;
  const headers={authorization:'Bearer test','x-tenant-id':f.tenant},conversation=randomUUID();
  const send=async(text:string,kind?:'voice')=>{
   const request=WorkRequestSchema.parse({route:'conversation.turn',id:conversation,client_turn_id:randomUUID(),text,selected_project_id:project,...(kind?{input_kind:kind}:{})});
   const http=workHttp(request);const response=await app!.inject({method:'POST',url:http.path,headers,payload:http.body});
   assert.equal(response.statusCode,200,response.body);assert.ok(response.json().run_id);return {http,response};
  };
  for(const text of ['석고보드 28개 찾아줘','견적서 준비해줘']){
   const written=await send(text),voice=await send(text,'voice');
   assert.equal(await runAgentOnce(services,{},f.tenant),'stored');assert.equal(await runAgentOnce(services,{},f.tenant),'stored');
   const rows=await db.admin`select instruction,input_kind,project_id,plan from app.agent_runs where tenant_id=${f.tenant}::uuid order by created_at,id`;
   const pair=rows.slice(-2);assert.equal(pair.length,2);assert.deepEqual(pair[0]!.plan,pair[1]!.plan);assert.deepEqual(new Set(pair.map(r=>r.input_kind)),new Set(['text','voice']));assert.ok(pair.every(r=>r.project_id===project&&r.instruction===text));
   assert.equal((await app.inject({method:'POST',url:voice.http.path,headers,payload:voice.http.body})).json().run_id,voice.response.json().run_id);
   assert.equal((await app.inject({method:'POST',url:voice.http.path,headers,payload:{...voice.http.body as object,text:'12개 찾아줘'}})).statusCode,409);
   assert.equal((await app.inject({method:'GET',url:`/v1/agent/runs/${written.response.json().run_id}`,headers:{...headers,'x-tenant-id':other.tenant}})).statusCode,404);
  }
  const cancelled=await send('28개 찾아줘','voice');await app.inject({method:'POST',url:`/v1/agent/runs/${cancelled.response.json().run_id}/cancel`,headers,payload:{}});assert.equal(await runAgentOnce(services,{},f.tenant),'idle');
  const history=await app.inject({method:'GET',url:`/v1/conversations/${conversation}/turns`,headers});assert.equal(history.json().turns.length,5);assert.equal(history.json().turns.at(-1).response.status,'cancelled');
 }finally{await app?.close();await db.cleanup();}
});

