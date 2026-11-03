import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';

test('N08 a folder correction relinks existing observations with audit while preserving facts and confirmed state',async()=>{
 const f=await processingFixture();let app:ReturnType<typeof createApp>|undefined;
 try{const fixture=await f.createFixture('작업: 주방 시공\n28개 인수 완료');const {tenant,user,session,source,revision}=fixture;
  app=createApp({db:f.api,capturePolicy:f.config.policy,verifyToken:async()=>({userId:user,sessionId:session}),storage:{async sign(){return 'https://storage.invalid';},async verify(){return {matches:true,sniffedMime:'text/plain'};},async remove(){}}});
  const call=(path:string,payload:object)=>app!.inject({method:'POST',url:path,headers:{authorization:'Bearer synthetic','x-tenant-id':tenant,'idempotency-key':randomUUID()},payload});
  const project=await call('/v1/projects',{display_name:'합성 현장'});assert.equal(project.statusCode,201);
  const initial=await call('/v1/site-folder-bindings',{source_id:source,source_generation:1,scope_fingerprint:'a'.repeat(64),scope_mode:'unassigned',project_id:null});assert.equal(initial.statusCode,201,initial.body);
  const facts=await f.admin`select to_jsonb(f)::text v from app.fact_candidates f where tenant_id=${tenant}::uuid order by id`;
  const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const corrected=await call('/v1/site-folder-bindings/batch',{client_command_id:randomUUID(),changes:[{id:initial.json().id,source_generation:1,expected_version:1,scope_mode:'project',project_id:project.json().id}]});assert.equal(corrected.statusCode,200,corrected.body);
  const [org]=await f.admin`select * from app.evidence_organizations where tenant_id=${tenant}::uuid and revision_id=${revision}::uuid`;
  assert.equal(org!.project_id,project.json().id);assert.equal(org!.state,'linked');assert.ok(org!.context_id);
  assert.equal(digest(await f.admin`select to_jsonb(f)::text v from app.fact_candidates f where tenant_id=${tenant}::uuid order by id`),digest(facts));
  assert.equal((await f.admin`select count(*)::int n from app.folder_binding_changes where tenant_id=${tenant}::uuid`)[0]!.n,1);
  const unassigned=await call('/v1/site-folder-bindings/batch',{client_command_id:randomUUID(),changes:[{id:initial.json().id,source_generation:1,expected_version:2,scope_mode:'unassigned',project_id:null}]});assert.equal(unassigned.statusCode,200,unassigned.body);
  const [cleared]=await f.admin`select state,project_id,context_id from app.evidence_organizations where tenant_id=${tenant}::uuid and revision_id=${revision}::uuid`;assert.equal(cleared!.state,'unassigned');assert.equal(cleared!.project_id,null);assert.equal(cleared!.context_id,null);
  assert.equal((await f.admin`select count(*)::int n from app.charge_adjustments where tenant_id=${tenant}::uuid`)[0]!.n,0);
 }finally{await app?.close();await f.cleanup();}
});
