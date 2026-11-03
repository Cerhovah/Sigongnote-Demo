import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp} from '../services/api/src/app.js';
import {identifyNext,linkDirectoryEvidence} from '../services/api/src/entity-links.js';
import {processingFixture} from './processing-fixture.js';
test('N05 directory -> worker -> material, alias withdrawal and tenant isolation',async()=>{
 const db=await processingFixture();let app:ReturnType<typeof createApp>|undefined;
 try{
  const f=await db.createFixture(),foreign=await db.createFixture();
  app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
  const call=(method:'GET'|'POST',url:string,payload?:object,tenant=f.tenant,key=randomUUID())=>app!.inject({method,url,headers:{authorization:'Bearer fixture','x-tenant-id':tenant,'idempotency-key':key},...(payload?{payload}:{})});
  const p=await call('POST','/v1/projects',{display_name:'합성 현장'});assert.equal(p.statusCode,201,p.body);
  const object={kind:'item_type',display_name:'석고보드',project_id:null,contract_id:null,party_id:null,role:null,item_type_id:null};
  const key=randomUUID(),created=await call('POST','/v1/entities/objects',object,f.tenant,key);assert.equal(created.statusCode,201,created.body);
  assert.equal((await call('POST','/v1/entities/objects',object,f.tenant,key)).json().id,created.json().id);
  assert.equal((await call('POST','/v1/entities/objects',{...object,kind:'item_instance'})).statusCode,400);
  assert.equal((await call('POST','/v1/entities/objects',{...object,project_id:randomUUID()})).statusCode,404);
  assert.equal((await call('GET','/v1/entities',undefined,foreign.tenant)).statusCode,404);
  const binding=await call('POST','/v1/site-folder-bindings',{source_id:f.source,source_generation:1,scope_fingerprint:'b'.repeat(64),scope_mode:'project',project_id:p.json().id});assert.equal(binding.statusCode,201,binding.body);
  const reread=async()=>{await db.admin`update app.entity_link_runs set updated_at=now()-interval '6 minutes' where tenant_id=${f.tenant}::uuid`;
   assert.equal(await identifyNext({db:db.worker,policy:db.config.policy,tenantScope:f.tenant}),true);};
  await reread();
  await db.admin`update app.entity_link_runs set updated_at=now()-interval '6 minutes' where tenant_id=${f.tenant}::uuid`;
  assert.equal(await identifyNext({db:db.worker,policy:db.config.policy,tenantScope:f.tenant}),false,'unchanged directory is not resolved or upserted again');
  const material=await call('GET',`/v1/work/materials/${f.revision}`);assert.equal(material.statusCode,200,material.body);
  const links=material.json().entity_links;assert.ok(links);assert.equal(links.links.find((l:any)=>l.targetKind==='project').targetId,p.json().id);
  assert.equal(links.links.find((l:any)=>l.targetKind==='item_type').targetId,created.json().id);
  const [span]=await db.admin`select locator from app.evidence_chunks where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid order by ordinal limit 1`;
  const aliasBody={target_kind:'item_type',target_id:created.json().id,alias_text:'합성',scope:'company',scope_id:f.tenant,role:null,valid_from:null,valid_until:null,evidence_revision:f.revision,evidence_locator:String(span!.locator)};
  const alias=await call('POST','/v1/entities/aliases',aliasBody);assert.equal(alias.statusCode,201,alias.body);
  assert.equal((await call('GET',`/v1/work/materials/${f.revision}`)).json().entity_links,null,'changed directory hides stale result immediately');
  await reread();assert.ok((await call('GET',`/v1/work/materials/${f.revision}`)).json().entity_links);
  const retired=await call('POST',`/v1/entities/aliases/${alias.json().id}/status`,{expected_version:1,status:'retired'});assert.equal(retired.statusCode,200,retired.body);
  assert.equal((await call('POST',`/v1/entities/aliases/${alias.json().id}/status`,{expected_version:1,status:'active'})).statusCode,409);
  const [input]=await db.worker`select app.entity_link_input(${f.tenant}::uuid,${f.job}::uuid,${db.worker.json(db.config.policy)}) input`;
  const result=linkDirectoryEvidence(input!.input);
  await db.admin`insert into app.evidence_retention_tasks(tenant_id,revision_id,source_id,source_generation) values(${f.tenant}::uuid,${f.revision}::uuid,${f.source}::uuid,1)`;
  const [late]=await db.worker`select app.save_entity_links(${f.tenant}::uuid,${f.job}::uuid,${input!.input.context_hash},${db.worker.json(result)},${db.worker.json(db.config.policy)}) ok`;
  assert.equal(late!.ok,false);assert.equal((await call('GET',`/v1/work/materials/${f.revision}`)).statusCode,404);
 }finally{if(app)await app.close();await db.cleanup();}
});
test('N05 project alias candidate cannot bootstrap its own scope or a contract',()=>{
 const raw={tenant_id:'t',revision_id:'r',job_id:'j',context_hash:'h',bindings:[],identity_spans:[{locator:'text:0',text:'별칭 새 계약'}],catalog:[
  {tenant_id:'t',id:'p',kind:'project',display_name:'현장'},
  {tenant_id:'t',id:'c',kind:'contract',display_name:'새 계약',project_id:'p'}],aliases:[
  {id:'a',target_kind:'project',target_id:'p',alias_text:'별칭',scope:'project',scope_id:'p',status:'active',evidence_revision:'r',evidence_locator:'text:0',evidence_text:'별칭'}]};
 const result=linkDirectoryEvidence(raw);assert.ok(result.links.length);assert.equal(result.links.some(l=>l.status==='linked'),false);
 raw.aliases[0]!.scope='company';raw.aliases[0]!.scope_id='t';raw.aliases[0]!.status='conflict';
 assert.equal(linkDirectoryEvidence(raw).links.some(l=>l.status==='linked'),false);
});
