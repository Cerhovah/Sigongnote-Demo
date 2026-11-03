import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {searchEvidence,searchPlan} from '../services/api/src/evidence-search.js';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
import {inAuthorizedTransaction} from '../services/api/src/auth.js';
import {reserveProductAi,submitProductAi,finishProductAi} from '../services/api/src/product-ai.js';
import {promoteSemanticOnce} from '../services/api/src/semantic-promotion.js';

test('N09 query plan resolves business synonyms and KST month bounds without a model request',()=>{
 const q=searchPlan('합성현장 지난달 받은 28개 자료 찾아줘',['합성현장'],new Date('2026-10-02T00:00:00Z'));
 assert.deepEqual(q.event_kinds,['receipt']);assert.equal(q.quantity,'28');assert.equal(q.query,'');
 assert.equal(q.from,'2026-08-31T15:00:00.000Z');assert.equal(q.to,'2026-09-30T15:00:00.000Z');
 assert.equal(searchPlan('석고보드 이전 판 찾아줘').versions,'history');
 assert.equal(searchPlan('고친 문서 보여줘').event_kinds[0],'correction');
 assert.equal(searchPlan('발주서 찾아줘').query,'발주서');
 assert.deepEqual(searchPlan('인수증 찾아줘').event_kinds,[]);
 assert.equal(searchPlan('타일 1,000장 찾아줘').quantity,'1000');
 for(const text of ['007개','28.1234567개','123456789012345678901개'])assert.equal(searchPlan(text).quantity,null);
});

test('N09 semantic evidence search has current source references, scope/date/version fences and revocable cached cards',async()=>{
 const db=await processingFixture();let app:ReturnType<typeof createApp>|undefined;
 try{
  const f=await db.createFixture('합성현장 석고보드 28개 인수'),other=await db.createFixture('다른 회사의 합성 석고보드 인수');
  const [chunk]=await db.admin`select * from app.evidence_chunks where tenant_id=${f.tenant}::uuid and job_id=${f.job}::uuid order by ordinal limit 1`;
  const output={modelRunId:randomUUID(),claims:[{predicate:'receipt',quote:'28개 인수',value:{kind:'quantity',value:'28',unitCode:'ea',semantic:'accepted'},speechKind:'observation',evidenceLocator:`section:${chunk!.ordinal}`,confidence:0.9}],candidateLinks:[],uncertainties:[],evidenceLocators:[`section:${chunk!.ordinal}`]};
  const r={...db.reservation(f,100),config:{...db.config,index_job:f.job,first_ordinal:chunk!.ordinal,last_ordinal:chunk!.ordinal,model:'internal-fixture',prompt:'candidate-evidence-v1'}};
  await reserveProductAi(db.worker,r);await submitProductAi(db.worker,r);await finishProductAi(db.worker,r,1,output,'test-receipt',{});
  assert.equal(await promoteSemanticOnce({db:db.worker,policy:db.config.policy,tenantScope:f.tenant}),true);
  app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
  const id=randomUUID(),request={client_turn_id:randomUUID(),text:'받은 석고보드 자료 찾아줘',attachment_refs:[]};
  const call=(payload:object)=>app!.inject({method:'POST',url:`/v1/conversations/${id}/turns`,headers:{authorization:'Bearer test','x-tenant-id':f.tenant},payload});
  const found=await call(request);assert.equal(found.statusCode,200,found.body);assert.equal(found.json().cards.length,1);
  const card=found.json().cards[0];assert.equal(card.match_kind,'semantic');assert.equal(card.revision_id,f.revision);assert.equal(card.evidence_ref.index_job_id,f.job);assert.equal(card.evidence_ref.ordinal,chunk!.ordinal);assert.ok(!card.excerpt.includes('받은'));
  assert.deepEqual((await call(request)).json(),found.json());
  const search=async(input:object)=>(await inAuthorizedTransaction(db.api,{userId:f.user,sessionId:f.session},async tx=>({status:200,body:await searchEvidence(tx,f.tenant,input)})))!.body as any[];
  assert.equal((await search({...searchPlan('28개 인수'),from:'2099-01-01T00:00:00Z'})).length,0);
  assert.equal((await search(searchPlan('30개 인수'))).length,0,'another quantity is not borrowed from another fact');
  await db.admin`insert into app.audio_corrections(tenant_id,revision_id,command_id,locator,text,actor_id) values(${f.tenant}::uuid,${f.revision}::uuid,${randomUUID()}::uuid,${chunk!.locator},'합성현장 석고보드 27개 확인',${f.user}::uuid)`;
  assert.equal((await call(request)).json().cards.length,0,'corrected quote cannot reuse old semantic fact');
  const corrected=await search({query:'27개'});assert.equal(corrected.length,1);assert.match(corrected[0].excerpt,/27개/);assert.doesNotMatch(corrected[0].title,/28개/);
  await db.admin`delete from app.audio_corrections where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  await assert.rejects(search({...searchPlan('인수'),context_id:randomUUID()}));
  const foreign=await app.inject({method:'POST',url:`/v1/conversations/${randomUUID()}/turns`,headers:{authorization:'Bearer test','x-tenant-id':other.tenant},payload:request});assert.equal(foreign.statusCode,404);
  // A later revision must invalidate latest-only cached hits, even if it has not been parsed yet.
  await db.admin`insert into app.document_revisions(tenant_id,id,document_id,revision_number,predecessor_id,blob_id,declared_mime) select tenant_id,${randomUUID()}::uuid,document_id,revision_number+1,id,blob_id,declared_mime from app.document_revisions where tenant_id=${f.tenant}::uuid and id=${f.revision}::uuid`;
  assert.equal((await call(request)).json().cards.length,0);
  assert.equal((await search({...searchPlan('받은 석고보드'),versions:'history'})).length,1);
  await db.admin`insert into app.evidence_retention_tasks(tenant_id,revision_id,source_id,source_generation) values(${f.tenant}::uuid,${f.revision}::uuid,${f.source}::uuid,1)`;
  assert.equal((await search({...searchPlan('받은 석고보드'),versions:'history'})).length,0);
  assert.equal((await call(request)).json().cards.length,0);
 }finally{await app?.close();await db.cleanup();}
});
