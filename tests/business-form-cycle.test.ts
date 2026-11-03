import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
import {runRenderOnce} from '../services/api/src/document-render-worker.js';
import {seedDocumentAgreement} from '../scripts/work-preview-documents.js';

test('N17 field simulation: new work note → journal → four revised/issued forms → real PDF/XLSX, isolation and immutable business details',async()=>{
 const db=await processingFixture();
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const f=await db.createFixture(`합성 햇살현장 견적 준비\n작업: 창틀 보수\n내일 창틀 납품 수량을 확인해 주세요.\n마진:20%\n부가세:별도 10%\n받는 곳:합성 의뢰업체\n단가 기준일:${today}\n품명 | 규격 | 수량 | 단위 | 매입단가 | 판매단가\n창틀 보수 | 표준 | 1 | 식 | 1000000 | 1250000`);
 const project=randomUUID(),app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
 const call=(url:string,payload?:object,tenant=f.tenant)=>app.inject({method:payload?'POST':'GET',url,headers:{authorization:'Bearer fixture','x-tenant-id':tenant},...(payload?{payload}:{})});
 const form={issuer:{name:'합성 시공업체',business_number:'000-00-00000',representative:'가상 대표',address:'가상시 시험로 1',business_type:'건설업',business_item:'실내건축',contact:'합성 담당자'},recipient:{business_number:'000-00-00001',representative:'가상 의뢰인'},valid_until:'2030-12-31',delivery_date:today,delivery_place:'합성 햇살현장',payment_terms:'검수 확인 후 협의한 날 지급',payment_account:'가상은행 000-000 / 합성 시공업체 (송금 불가)',note:'가상시험 전용 · 실제 계약·납품·청구가 아닙니다.'};
 const out=resolve('.work/n17_forms/field-cycle');mkdirSync(out,{recursive:true});const checks:unknown[]=[];
 try{
  await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성 햇살현장')`;
  const journal=(await call('/v1/work/journal')).json();assert.equal(journal.items[0].id,f.revision);assert.match(journal.items[0].excerpt,/창틀/);assert.equal(journal.items[0].project_id,null,'receipt visible before classification');
  for(const type of ['estimate','delivery_statement','invoice','purchase_order'] as const){
   const [org]=await db.admin`select version from app.evidence_organizations where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;
   if(type==='invoice'){await db.admin`update app.evidence_index set display_title='합성 청구 준비' where tenant_id=${f.tenant}::uuid and revision_id=${f.revision}::uuid`;await seedDocumentAgreement(db.admin,{tenant:f.tenant,user:f.user,project},'창틀 보수');await db.admin`update app.work_contexts set bundle_id=(select bundle_id from app.billing_agreements where tenant_id=${f.tenant}::uuid limit 1) where tenant_id=${f.tenant}::uuid and project_id=${project}::uuid`;} // Explicit synthetic approval/completion, never inferred from the request.
   const prepared=await call('/v1/work/journal/commands',{action:'draft',id:f.revision,project_id:project,expected_version:Number(org!.version),client_command_id:randomUUID(),type});assert.equal(prepared.statusCode,200,prepared.body);
   const old=(await call('/v1/document-drafts/'+prepared.json().id)).json();assert.equal(old.stale,false);assert.deepEqual(old.missing,type==='purchase_order'?['받는 곳']:[],JSON.stringify(old.missing));
   const update={client_command_id:randomUUID(),recipient:'합성 의뢰업체',form};
   assert.equal((await call('/v1/document-drafts/'+old.id+'/complete',{...update,form:{issuer:{internal_cost:'private'}}})).statusCode,400);
   const changed=await call('/v1/document-drafts/'+old.id+'/complete',update);assert.equal(changed.statusCode,200,changed.body);assert.deepEqual((await call('/v1/document-drafts/'+old.id+'/complete',update)).json(),changed.json());
   const d=(await call('/v1/document-drafts/'+changed.json().id)).json();assert.equal(d.document.issuer.name,form.issuer.name);assert.equal(d.document.template_version,'kr-business-v2');assert.deepEqual(d.document.form,form);assert.notEqual(d.document.basis_hash,old.document.basis_hash);
   assert.equal((await call('/v1/document-drafts/'+d.id,undefined,randomUUID())).statusCode,404);
   const issuance={client_command_id:randomUUID(),drafts:[{id:d.id,basis_hash:d.document.basis_hash,...(type==='invoice'?{amount_minor:'550000'}:{})}],recipient_confirmation:d.document.recipient.name};
   const issued=await call('/v1/documents/issue',issuance);assert.equal(issued.statusCode,201,issued.body);assert.deepEqual((await call('/v1/documents/issue',issuance)).json(),issued.json());
   assert.equal(await runRenderOnce({db:db.worker,tenantScope:f.tenant,python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker')}),'stored');
   const id=issued.json().documents[0].id,r=(await call('/v1/documents/'+id)).json();assert.equal(r.render_state,'succeeded');assert.deepEqual(r.document.form,form);assert.equal(r.delivery_state,'unknown');assert.equal(r.payment_confirmed,false);
   if(type==='invoice'){assert.equal(r.document.totals.total,'550000');assert.equal(r.document.lines[0].quantity,null);}
   for(const format of ['pdf','xlsx']){const file=await call(`/v1/documents/${id}/files/${format}`);assert.equal(file.statusCode,200,file.body);const value=file.json(),bytes=Buffer.from(value.base64,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),value.sha256);writeFileSync(resolve(out,type+'.'+format),bytes);assert.equal((await call(`/v1/documents/${id}/files/${format}`,undefined,randomUUID())).statusCode,404);}
   assert.equal((await db.admin`select bool_and(template_version='kr-business-v2') ok from app.document_artifacts where tenant_id=${f.tenant}::uuid`)[0]!.ok,true);
   assert.equal((await db.admin`select bool_and(processor_version='kr-business-v2') ok from app.job_effects where tenant_id=${f.tenant}::uuid and job_type='render_document'`)[0]!.ok,true);
   const after=await call('/v1/document-drafts/'+d.id+'/complete',{client_command_id:randomUUID(),form:{...form,note:'다음 개정용 가상 문구'}});assert.equal(after.statusCode,200,after.body);
   assert.deepEqual((await call('/v1/documents/'+id)).json().document,r.document,'issued snapshot unchanged by the next draft');
   writeFileSync(resolve(out,type+'.json'),JSON.stringify(r.document,null,2));checks.push({type,total:r.document.totals.total,pdf_xlsx:'stored',form_frozen:true,tenant_isolation:true,delivery:r.delivery_state,payment:r.payment_confirmed});
  }
  const entries=(await call('/v1/work/journal?project_id='+project)).json().items;assert.equal(entries.length,1,'outputs do not become new source receipts');
  writeFileSync(resolve(out,'verification.json'),JSON.stringify({mode:'synthetic local DB and actual renderer; provider, phone, printer not run',checks},null,2));
 }finally{await app.close();await db.cleanup();}
});
