import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {reserveProductAi,submitProductAi,finishProductAi} from '../services/api/src/product-ai.js';
import {promoteSemanticOnce} from '../services/api/src/semantic-promotion.js';
import {SEMANTIC_CANDIDATE_SCHEMA_VERSION} from '../packages/domain/src/semantic-candidates.js';

test('table header context survives DB replay without becoming a new fact or another paid call',async()=>{
 const db=await processingFixture();
 try{
  const f=await db.createFixture('표 문맥 회귀');
  const rows=[['A1','품명'],['B1','단위'],['C1','수량'],['A20','석고보드'],['B20','EA'],['C20','28']];
  for(const [ordinal,[address,text]] of rows.entries()){
   await db.admin`insert into app.evidence_chunks(tenant_id,job_id,revision_id,ordinal,text,locator,position,content_hash)
    values(${f.tenant}::uuid,${f.job}::uuid,${f.revision}::uuid,${ordinal},${text!},${'sheet:0/cell:'+address},'{}',${createHash('sha256').update(text!).digest('hex')})
    on conflict(tenant_id,job_id,ordinal) do update set text=excluded.text,locator=excluded.locator,content_hash=excluded.content_hash`;
  }
  await db.admin`update app.evidence_chunk_indexes set chunk_count=6 where tenant_id=${f.tenant}::uuid and job_id=${f.job}::uuid`;
  const chunks=await db.admin`select * from app.evidence_chunks where tenant_id=${f.tenant}::uuid and job_id=${f.job}::uuid order by ordinal`;
  const proof=(ordinals:number[])=>ordinals.map(ordinal=>{const c=chunks[ordinal]!;return {indexJobId:f.job,ordinal,contentHash:c.content_hash,locator:c.locator,quote:c.text};});
  const candidate={key:'table_row',eventKind:'observation',actor:null,subject:{kind:'item_type',mention:'석고보드',role:null},predicate:'material_quantity',object:null,quantity:{value:'28',unitCode:'ea'},amount:null,effectiveAt:null,assertion:{polarity:'positive',modality:'actual',speech:'direct',speaker:null},uncertaintyReasons:[],evidence:proof([3,4,5])};
  const raw={schemaVersion:SEMANTIC_CANDIDATE_SCHEMA_VERSION,modelVersion:'internal-fixture',promptVersion:'table-test',candidates:[candidate,{...candidate,key:'header_only',subject:null,quantity:null,evidence:proof([0])}]};
  const output={modelRunId:f.job,claims:[],candidateLinks:[],uncertainties:[],evidenceLocators:[],semanticCandidates:{raw}};
  const reservation={...db.reservation(f,100),config:{...db.config,index_job:f.job,first_ordinal:3,last_ordinal:5,context_ordinals:[0,1,2],model:'internal-fixture',prompt:'table-test'}};
  await reserveProductAi(db.worker,reservation);await submitProductAi(db.worker,reservation);await finishProductAi(db.worker,reservation,1,output,'table_receipt',{});
  const [input]=await db.admin`select app.semantic_promotion_input(${f.tenant}::uuid,${reservation.id}::uuid,${f.user}::uuid,${db.admin.json(db.config.policy)}) value`;
  assert.deepEqual(input!.value.chunks.map((c:{contextOnly:boolean})=>c.contextOnly),[true,true,true,false,false,false]);
  const other=await db.createFixture();
  assert.equal((await db.admin`select app.semantic_promotion_input(${other.tenant}::uuid,${reservation.id}::uuid,${other.user}::uuid,${db.admin.json(db.config.policy)}) value`)[0]?.value,null);
  const options={db:db.worker,policy:db.config.policy,tenantScope:f.tenant};assert.equal(await promoteSemanticOnce(options),true);
  const saved=await db.admin`select semantic from app.fact_candidates where tenant_id=${f.tenant}::uuid and semantic is not null`;
  assert.equal(saved.length,1);assert.equal(saved[0]!.semantic.quantity.value,'28');
  assert.equal(await promoteSemanticOnce(options),false);
  assert.equal((await db.admin`select count(*)::int n from app.product_ai_usage where tenant_id=${f.tenant}::uuid`)[0]!.n,1);
 }finally{await db.cleanup();}
});
test('N06 replay stored output without a provider call; preserve meanings, duplicates and revoked source',async()=>{
 const db=await processingFixture();
 try{
  const f=await db.createFixture('30개 요청\n30개 제안\n30개 출고\n28개 인수');
  const chunks=await db.admin`select * from app.evidence_chunks where tenant_id=${f.tenant}::uuid and job_id=${f.job}::uuid order by ordinal`;
  const claims=['request','proposal','dispatch','receipt'].map((kind,i)=>({predicate:kind,quote:['30개 요청','30개 제안','30개 출고','28개 인수'][i],value:{kind:'quantity',value:i===3?'28':'30',unitCode:'ea',semantic:i===3?'accepted':i===2?'moved':'ordered'},speechKind:i===0?'request':'observation',evidenceLocator:`section:${chunks.find(c=>String(c.text).includes(['30개 요청','30개 제안','30개 출고','28개 인수'][i]!))!.ordinal}`,confidence:0.9}));
  const output={modelRunId:randomUUID(),claims,candidateLinks:[],uncertainties:[],evidenceLocators:chunks.map(c=>`section:${c.ordinal}`)};
  const reservation={...db.reservation(f,100),config:{...db.config,index_job:f.job,first_ordinal:chunks[0]!.ordinal,last_ordinal:chunks.at(-1)!.ordinal,model:'internal-fixture',prompt:'candidate-evidence-v1'}};
  assert.equal((await reserveProductAi(db.worker,reservation)).state,'reserved');assert.equal(await submitProductAi(db.worker,reservation),true);
  assert.equal(await finishProductAi(db.worker,reservation,11,output,'test_receipt',{input_tokens:100,output_tokens:100}),true);
  const options={db:db.worker,policy:db.config.policy,tenantScope:f.tenant};
  await Promise.all([promoteSemanticOnce(options),promoteSemanticOnce(options)]);
  const rows=await db.admin`select semantic from app.fact_candidates where tenant_id=${f.tenant}::uuid and semantic is not null order by extraction_key`;
  assert.equal(rows.length,4);assert.deepEqual(rows.map(r=>[r.semantic.eventKind,r.semantic.quantity.value]),[['request','30'],['proposal','30'],['dispatch','30'],['receipt','28']]);
  assert.equal(await promoteSemanticOnce(options),false);
  const [old]=await db.admin`select count(*)::int n from app.fact_candidates where tenant_id=${f.tenant}::uuid and extraction_key='source_statement'`;assert.ok(old!.n>0);
  assert.equal((await db.admin`select count(*)::int n from app.product_ai_usage where tenant_id=${f.tenant}::uuid`)[0]!.n,1);
  const bad={...reservation,id:randomUUID(),hash:'b'.repeat(64)};
  await reserveProductAi(db.worker,bad);await submitProductAi(db.worker,bad);await finishProductAi(db.worker,bad,1,{...output,claims:[{...claims[0],quote:'근거 없는 인수 99개'}]},'bad_output',{});
  assert.equal(await promoteSemanticOnce(options),true);
  assert.equal((await db.admin`select status from app.semantic_promotions where tenant_id=${f.tenant}::uuid and usage_id=${bad.id}::uuid`)[0]?.status,'invalid');
  assert.ok((await db.admin`select reason from app.semantic_promotions where tenant_id=${f.tenant}::uuid and usage_id=${bad.id}::uuid`)[0]?.reason);
  // A new validator may replay a stored response without reserving or submitting another provider call.
  await db.admin`update app.semantic_promotions set validator_version='semantic-validator-v1' where tenant_id=${f.tenant}::uuid and usage_id=${reservation.id}::uuid`;
  assert.equal(await promoteSemanticOnce(options),true);
  assert.equal((await db.admin`select count(*)::int n from app.fact_candidates where tenant_id=${f.tenant}::uuid and semantic is not null`)[0]!.n,4);
  assert.equal((await db.admin`select count(*)::int n from app.product_ai_usage where tenant_id=${f.tenant}::uuid`)[0]!.n,2);
  const late={...reservation,id:randomUUID(),hash:'c'.repeat(64)};
  await reserveProductAi(db.worker,late);await submitProductAi(db.worker,late);await finishProductAi(db.worker,late,1,output,'late_output',{});
  const [input]=await db.worker`select app.next_semantic_promotion(${f.tenant}::uuid,${db.worker.json(db.config.policy)}) ctx`;
  await db.admin`insert into app.evidence_retention_tasks(tenant_id,revision_id,source_id,source_generation) values(${f.tenant}::uuid,${f.revision}::uuid,${f.source}::uuid,1)`;
  const [saved]=await db.worker`select app.save_semantic_candidates(${f.tenant}::uuid,${late.id}::uuid,${f.user}::uuid,${input!.ctx.context_hash},null,${db.worker.json(db.config.policy)}) ok`;
  assert.equal(saved!.ok,false);assert.equal(await promoteSemanticOnce(options),false);
 }finally{await db.cleanup();}
});
