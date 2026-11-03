import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';

test('journal follow-up completes/reopens across clients and prepares a source-bound first draft without approving business effects',async()=>{
 const db=await processingFixture(),f=await db.createFixture('내일 창틀 납품 수량을 확인해 주세요.'),other=await db.createFixture('다른 회사의 합성 요청');
 let actor={userId:f.user,sessionId:f.session};
 const app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>actor});
 const headers={authorization:'Bearer fixture','x-tenant-id':f.tenant};
 const get=(path:string)=>app.inject({method:'GET',url:path,headers});
 const send=(payload:object)=>app.inject({method:'POST',url:'/v1/work/journal/commands',headers,payload});
 try{
  const site=randomUUID();await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${site}::uuid,'합성 현장')`;
  const [fact]=await db.admin`select id from app.fact_candidates where tenant_id=${f.tenant}::uuid and source_revision=${f.revision}::uuid limit 1`;
  assert.ok(fact);await db.admin`update app.fact_candidates set assertion_kind='request' where tenant_id=${f.tenant}::uuid and id=${fact.id}::uuid`;
  const items=(await get('/v1/work/journal/tasks')).json().items;assert.equal(items.length,1);assert.equal(items[0].done,false);
  const command={action:'task',id:String(fact.id),client_command_id:randomUUID(),expected_version:0,done:true};
  let r=await send(command);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().version,1);
  assert.deepEqual((await send(command)).json(),r.json());
  assert.equal((await send({...command,done:false})).statusCode,409);
  await db.admin`insert into app.memberships(tenant_id,user_id,role) values(${f.tenant}::uuid,${other.user}::uuid,'operator')`;
  actor={userId:other.user,sessionId:other.session};assert.equal((await get('/v1/work/journal/tasks')).json().items[0].done,false);
  assert.equal((await send({action:'draft',id:f.revision,project_id:site,expected_version:1,client_command_id:randomUUID(),type:'estimate'})).statusCode,404);
  actor={userId:f.user,sessionId:f.session};
  assert.equal((await send({...command,client_command_id:randomUUID(),done:false})).statusCode,409);
  assert.equal((await get('/v1/work/journal/tasks')).json().items[0].done,true);
  assert.equal((await send({...command,client_command_id:randomUUID(),done:false,expected_version:1})).json().version,2);
  const [org]=await db.admin`select version from app.evidence_organizations where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  const draftCommand={action:'draft',id:f.revision,client_command_id:randomUUID(),expected_version:Number(org!.version),project_id:site,type:'estimate'};
  r=await send(draftCommand);assert.equal(r.statusCode,200,r.body);const id=r.json().id;
  assert.equal((await send(draftCommand)).json().id,id);
  const draft=(await get('/v1/document-drafts/'+id)).json();assert.equal(draft.stale,false);assert.ok(draft.source_refs.includes(f.revision));assert.equal(draft.document.totals.total,null);assert.ok(draft.missing.length);
  const [updated]=await db.admin`select version from app.evidence_organizations where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  assert.equal((await send({...draftCommand,client_command_id:randomUUID(),expected_version:Number(updated!.version)})).json().id,id);
  const [effects]=await db.admin`select (select count(*) from app.invoices where tenant_id=${f.tenant}::uuid)::int invoices,(select count(*) from app.work_command_effects where tenant_id=${f.tenant}::uuid)::int effects`;
  assert.deepEqual(effects,{invoices:0,effects:0});
  assert.equal((await send({...draftCommand,id:other.revision,client_command_id:randomUUID()})).statusCode,404);
  await db.admin`update app.capture_sources set server_upload_consent=false where tenant_id=${f.tenant}::uuid and id=${f.source}::uuid`;
  assert.equal((await get('/v1/work/journal/tasks')).json().items.length,0);
  assert.equal((await send(command)).statusCode,404);assert.equal((await get('/v1/document-drafts/'+id)).statusCode,404);
 }finally{await app.close();await db.cleanup();}
});
