import {resolve} from 'node:path';
import {runParseOnce} from '../services/api/src/parse-worker.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {reserveProductAi,submitProductAi,finishProductAi} from '../services/api/src/product-ai.js';
import {promoteSemanticOnce} from '../services/api/src/semantic-promotion.js';
import {runAgentOnce} from '../services/api/src/agent-runs.js';
import {createApp} from '../services/api/src/app.js';
test('N15 actual parser and validated stored change reach agent estimate; policy and live identity remain authoritative',async()=>{
 const db=await processingFixture();let app:ReturnType<typeof createApp>|undefined;
 try{
  const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),change='창틀 최종 35개 합의';
  const f=await db.createFixture(`합성현장 견적서\n부가세:별도 10%\n받는 곳:합성 의뢰인\n단가 기준일:${day}\n현장조건:실내\n운반비:포함\n품명 | 규격 | 수량 | 단위 | 매입단가 | 단가\n창틀 | 표준 | 30 | 개 | 100 | 125\n${change}`);
  const project=randomUUID(),context=randomUUID(),item=randomUUID();
  await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성현장')`;
  await db.admin`insert into app.work_contexts(tenant_id,id,project_id,label) values(${f.tenant}::uuid,${context}::uuid,${project}::uuid,'창틀 작업')`;
  await db.admin`insert into app.entity_objects(tenant_id,id,kind,display_name,project_id) values(${f.tenant}::uuid,${item}::uuid,'item_type','창틀',${project}::uuid)`;
  await db.admin`update app.evidence_organizations set state='linked',project_id=${project}::uuid,context_id=${context}::uuid,project_candidates=${[project]}::uuid[],version=version+1 where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  const [chunk]=await db.admin`select * from app.evidence_chunks where tenant_id=${f.tenant}::uuid and job_id=${f.job}::uuid and text like ${'%'+change+'%'} order by ordinal limit 1`;assert.ok(chunk);
  const reservation={...db.reservation(f,100),config:{...db.config,index_job:f.job,first_ordinal:chunk.ordinal,last_ordinal:chunk.ordinal,model:'internal-fixture',prompt:'candidate-evidence-v1'}};
  const candidate={key:'quantity',eventKind:'acceptance',actor:null,subject:{kind:'item_type',mention:'창틀',role:null},predicate:'quantity',object:null,quantity:{value:'35',unitCode:'ea'},amount:null,effectiveAt:null,assertion:{polarity:'positive',modality:'actual',speech:'direct',speaker:null},evidence:[{indexJobId:f.job,ordinal:chunk.ordinal,contentHash:chunk.content_hash,locator:chunk.locator,quote:change}],uncertaintyReasons:[]};
  await reserveProductAi(db.worker,reservation);await submitProductAi(db.worker,reservation);await finishProductAi(db.worker,reservation,1,{semanticCandidates:{schemaVersion:'semantic-candidates-v1',modelVersion:'internal-fixture',promptVersion:'candidate-evidence-v1',candidates:[candidate]}},'internal-test',{});assert.equal(await promoteSemanticOnce({db:db.worker,policy:db.config.policy,tenantScope:f.tenant}),true);
  const services={db:db.api,agentRuntime:true,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})};app=createApp(services);
  const headers={authorization:'Bearer synthetic','x-tenant-id':f.tenant},call=(url:string,payload?:object)=>app!.inject({method:payload?'POST':'GET',url,headers,...(payload?{payload}:{})});
  const run=await call('/v1/agent/runs',{client_turn_id:randomUUID(),project_id:project,instruction:'견적서 준비해줘',input_kind:'text'});await runAgentOnce(services,{},f.tenant);
  const result=await call('/v1/agent/runs/'+run.json().run_id);assert.equal(result.json().document_refs.length,1,result.body);const id=result.json().document_refs[0].id;
  const draft=(await call('/v1/document-drafts/'+id)).json();assert.equal(draft.document.lines[0].quantity,'35');assert.ok(draft.missing.includes('마진 기준'));assert.equal(draft.document.totals.total,null);
  const complete=await call('/v1/document-drafts/'+id+'/complete',{client_command_id:randomUUID(),margin_bps:2000});assert.equal(complete.statusCode,200,complete.body);const ready=(await call('/v1/document-drafts/'+complete.json().id)).json();assert.equal(ready.document.totals.total,'4813');assert.equal(ready.state,'draft_ready');
  // Read a real second parser input in the same tenant: supplier prices with an independent date.
  const priceText=`매입 단가표\n부가세:별도 10%\n현장조건:실내\n단가 기준일:${day}\n품목 | 규격 | 단위 | 단가\n창틀 | 표준 | 개 | 120`,bytes=Buffer.from(priceText),digest=createHash('sha256').update(bytes).digest('hex');
  const uploadApp=createApp({...services,storage:{async sign(){return 'https://storage.invalid/synthetic?token=synthetic-opaque-upload-signature';},async verify(){return {matches:true,sniffedMime:'text/plain'};},async remove(){}}});
  let priceRevision:string;
  try{const prepared=await uploadApp.inject({method:'POST',url:'/v1/ingestions',headers:{...headers,'idempotency-key':randomUUID()},payload:{client_capture_id:randomUUID(),source_id:f.source,source_generation:1,sha256:digest,byte_length:bytes.length,declared_mime:'text/plain'}});assert.equal(prepared.statusCode,201,prepared.body);
   const done=await uploadApp.inject({method:'POST',url:'/v1/ingestions/'+prepared.json().ingestion_id+'/complete',headers:{...headers,'idempotency-key':randomUUID()},payload:{sha256:digest,byte_length:bytes.length}});assert.equal(done.statusCode,200,done.body);priceRevision=done.json().revision_id;
   assert.equal(await runParseOnce({db:db.worker,policy:db.config.policy,tenantScope:f.tenant,python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker'),download:async()=>bytes}),'stored');
  }finally{await uploadApp.close();}
  await db.admin`update app.evidence_organizations set state='linked',project_id=${project}::uuid,context_id=${context}::uuid,version=version+1 where tenant_id=${f.tenant}::uuid and revision_id=${priceRevision}::uuid`;
  const [parsed]=await db.admin`select output from app.parse_results where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  const output={...parsed!.output,spans:parsed!.output.spans.filter((p:any)=>!p.text.startsWith('단가 기준일'))};
  await db.admin`update app.parse_results set output=${db.admin.json(output)} where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
  const refreshed=await call('/v1/document-drafts/'+ready.id+'/complete',{client_command_id:randomUUID()});let latest=(await call('/v1/document-drafts/'+refreshed.json().id)).json();assert.equal(latest.state,'draft_ready');assert.equal(latest.document.totals.total,'5775');assert.deepEqual(latest.document.terms,[]);
  const [prices]=await db.admin`select output from app.parse_results where tenant_id=${f.tenant}::uuid and revision_id=${priceRevision}::uuid`;
  const oldPrices={...prices!.output,spans:prices!.output.spans.map((p:any)=>({...p,text:p.text.replace(day,'2000-01-01')}))};
  await db.admin`update app.parse_results set output=${db.admin.json(oldPrices)} where tenant_id=${f.tenant}::uuid and revision_id=${priceRevision}::uuid`;
  const expired=await call('/v1/document-drafts/'+latest.id+'/complete',{client_command_id:randomUUID()});latest=(await call('/v1/document-drafts/'+expired.json().id)).json();assert.ok(latest.missing.includes('창틀의 최신 단가'));assert.equal(latest.state,'needs_inputs');
  await db.admin`update app.entity_objects set display_name='다른 물품',version=version+1 where tenant_id=${f.tenant}::uuid and id=${item}::uuid`;
  assert.equal((await call('/v1/document-drafts/'+ready.id)).json().stale,true);
  const changed=await call('/v1/document-drafts/'+ready.id+'/complete',{client_command_id:randomUUID()});assert.ok((await call('/v1/document-drafts/'+changed.json().id)).json().missing.includes('변경 자료의 품목 연결'));
  assert.equal((await db.api`select app.document_facts(${f.tenant}::uuid,${context}::uuid) v`)[0]!.v,null);await assert.rejects(db.worker`select app.document_facts(${f.tenant}::uuid,${context}::uuid)`,/permission denied/);
 }finally{await app?.close();await db.cleanup();}
});
