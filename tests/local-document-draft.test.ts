import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {createApp} from '../services/api/src/app.js';
import {runRenderOnce} from '../services/api/src/document-render-worker.js';
import {rendererEnvironment} from '../services/api/src/parse-worker.js';
import {deleteFixtureTenants} from './fixture-cleanup.js';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
test('PC journal → source-bound estimate → owner inputs → issued snapshot preserves local hash/version and blocks stale or revoked sources',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8')),admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}}),api=postgres(env.DATABASE_URL!,{max:2,onnotice:()=>{}}),worker=postgres(env.WORKER_DATABASE_URL!,{max:1,onnotice:()=>{}});
 const python=resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot=resolve('services/document-worker');
 const f={tenant:randomUUID(),user:randomUUID(),session:randomUUID(),device:randomUUID(),project:randomUUID(),local:randomUUID()},policy={id:'synthetic-doc-context',purpose:'work_records',provider:'anthropic',processing_location:'provider_cloud',storage_location:'development_computer',retention:'until_user_deletes',external_processing:true} as const;
 const app=createApp({db:api,capturePolicy:policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
 const headers={authorization:'Bearer synthetic','x-tenant-id':f.tenant},call=(url:string,payload?:object)=>app.inject({method:payload?'POST':'GET',url,headers,...(payload?{payload}:{})});
 try{
  await admin`insert into auth.users(id) values(${f.user}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${f.session}::uuid,${f.user}::uuid)`;
  await admin`insert into app.tenants(id,display_name) values(${f.tenant}::uuid,'합성 문서 회사')`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${f.tenant}::uuid,${f.user}::uuid,'owner')`;
  await admin`insert into app.devices(tenant_id,id,user_id,platform,public_key_jwk,public_key_sha256,app_version,registration_key,registration_hash) values(${f.tenant}::uuid,${f.device}::uuid,${f.user}::uuid,'windows','{}',${hash(f.device)},'test',${randomUUID()}::uuid,${hash('synthetic-registration')})`;
  await admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${f.project}::uuid,'합성 현장')`;
  const text='합성 현장 문틀 100개 견적 부탁드립니다.',sourceHash=hash(text);
  const push=(revision:number,text:string)=>call('/v1/local-journal/push',{device_id:f.device,items:[{id:f.local,received_at:'2026-10-21T01:00:00Z',file_name:'합성 업무 연락.txt',project_id:f.project,categories:['agreement'],excerpt:text,sha256:hash(text),mime:'text/plain',revision}]});
  const received=await push(1,text);assert.equal(received.statusCode,200,received.body);const source=received.json().items[0].revision_id;
  // Ordinary drafting works with no external-model consent. No title/table parser is invented for this text.
  const command={action:'draft',id:source,project_id:f.project,type:'estimate',expected_version:1,client_command_id:randomUUID()};
  let result=await call('/v1/work/journal/commands',command);assert.equal(result.statusCode,200,result.body);const first=result.json().id;
  assert.equal((await call('/v1/work/journal/commands',command)).json().id,first);
  let draft=(await call('/v1/document-drafts/'+first)).json();assert.equal(draft.stale,false);assert.equal(draft.document.lines.length,0);assert.deepEqual(draft.source_refs,[source]);
  assert.ok((await call('/v1/documents')).json().prepared.some((d:any)=>d.id===first),'incomplete drafts can be reopened after leaving the screen');
  // A real stored structured event supplies only its bound item/quantity candidate, never a price.
  await admin`insert into app.local_context_consents(tenant_id,user_id,allowed,processing_policy) values(${f.tenant}::uuid,${f.user}::uuid,true,${admin.json(policy)})`;
  await admin`insert into app.work_events(tenant_id,kind,summary,project_id,source_kind,source_ref,source_version,quantities,confidence,actor_id) values(${f.tenant}::uuid,'request','합성 문틀 견적 요청',${f.project}::uuid,'local',${source}::uuid,${'1:'+sourceHash+':1'},${admin.json([{item:'문틀',quantity:'100',unit:'개'}])},'high',${f.user}::uuid)`;
  result=await call('/v1/work/journal/commands',{...command,client_command_id:randomUUID()});assert.equal(result.statusCode,200,result.body);const candidate=result.json().id;
  draft=(await call('/v1/document-drafts/'+candidate)).json();assert.equal(draft.document.lines[0].description,'문틀');assert.equal(draft.document.lines[0].quantity,'100');assert.equal(draft.input_lines[0].unit_price,null);
  const lines=[{id:draft.input_lines[0].id,description:'문틀',spec:'',unit:'개',quantity:'100',unit_price:'20000'}];
  for(const invalid of [[],[{...lines[0],quantity:'1e3'}],[{...lines[0],quantity:'0'}],[{...lines[0],unit_price:'1.5'}],[{...lines[0],unexpected:'field'}],Array.from({length:101},(_,i)=>({...lines[0],id:String(i)})),[lines[0],lines[0]]]){
   const r=await call('/v1/document-drafts/'+candidate+'/complete',{client_command_id:randomUUID(),lines:JSON.stringify(invalid)});assert.equal(r.statusCode,400,r.body);
  }
  const completion={client_command_id:randomUUID(),recipient:'합성 고객',margin_bps:2000,tax_mode:'exclusive',tax_bps:1000,lines:JSON.stringify(lines)};
  result=await call('/v1/document-drafts/'+candidate+'/complete',completion);assert.equal(result.statusCode,200,result.body);const ready=result.json().id;assert.equal((await call('/v1/document-drafts/'+candidate+'/complete',completion)).json().id,ready);
  draft=(await call('/v1/document-drafts/'+ready)).json();assert.equal(draft.state,'draft_ready');assert.equal(draft.stale,false);assert.deepEqual(draft.document.totals,{supply:'2500000',tax:'250000',total:'2750000'});assert.equal(draft.input_lines[0].unit_price,'20000');assert.equal(draft.document.lines[0].unit_price,'25000');
  const [stored]=await admin`select basis_snapshot from app.document_drafts where tenant_id=${f.tenant}::uuid and id=${ready}::uuid`;assert.deepEqual(stored!.basis_snapshot.references,[]);assert.deepEqual(stored!.basis_snapshot.local_sources,[{id:source,sha256:sourceHash,local_revision:1,version:1,project_id:f.project}]);
  result=await call('/v1/documents/issue',{client_command_id:randomUUID(),drafts:[{id:ready,basis_hash:draft.document.basis_hash}],recipient_confirmation:'합성 고객'});assert.equal(result.statusCode,201,result.body);const issued=result.json().documents[0];
  const [approval]=await admin`select d.document_draft_id,d.evidence_ids from app.decisions d join app.business_document_revisions r on r.tenant_id=d.tenant_id and r.approval_decision_id=d.id where r.tenant_id=${f.tenant}::uuid and r.id=${issued.revision_id}::uuid`;assert.equal(approval!.document_draft_id,ready);assert.deepEqual(approval!.evidence_ids,[],'the immutable document basis is kept without forging an evidence-index entry');
  assert.equal((await call('/v1/documents/'+issued.id)).json().document.totals.total,'2750000');assert.equal((await admin`select app.render_authorized(${f.tenant}::uuid,${issued.revision_id}::uuid) ok`)[0]!.ok,true);
  // Run the actual lease/input → Python PDF/XLSX → atomic artifact publication path. Artifacts live in PostgreSQL,
  // so this local-source boundary needs neither a fake renderer nor an invented Storage copy of the PC original.
  const renderOptions={db:worker,tenantScope:f.tenant,python,pythonRoot};
  assert.equal(await runRenderOnce(renderOptions),'stored');assert.equal(await runRenderOnce(renderOptions),'idle');
  const reopened=await call('/v1/documents/'+issued.id);assert.equal(reopened.statusCode,200,reopened.body);const rendered=reopened.json();
  assert.equal(rendered.render_state,'succeeded');assert.deepEqual(rendered.document.totals,{supply:'2500000',tax:'250000',total:'2750000'});
  assert.deepEqual(rendered.files.map((file:any)=>file.format).sort(),['pdf','xlsx']);
  const artifacts:Record<string,{base64:string;sha256:string;bytes:number}>={};
  for(const format of ['pdf','xlsx']){
   const response=await call(`/v1/documents/${issued.id}/files/${format}`);assert.equal(response.statusCode,200,response.body);
   const file=response.json(),bytes=Buffer.from(file.base64,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
   assert.equal(bytes.subarray(0,format==='pdf'?5:2).toString(),format==='pdf'?'%PDF-':'PK');
   assert.equal(rendered.files.find((entry:any)=>entry.format===format).byte_length,bytes.length);
   assert.equal((await call(`/v1/documents/${issued.id}/files/${format}`)).json().base64,file.base64,'reopening returns the exact committed renderer bytes');
   artifacts[format]={base64:file.base64,sha256:file.sha256,bytes:bytes.length};
  }
  const inspected=spawnSync(python,['-c',`import base64,io,json,sys
from pypdf import PdfReader
from openpyxl import load_workbook
data=json.load(sys.stdin)
pdf=PdfReader(io.BytesIO(base64.b64decode(data['pdf'])))
book=load_workbook(io.BytesIO(base64.b64decode(data['xlsx'])),data_only=True)
rows=list(book.active.values)
labels=['공급가액','부가세','합계 (원)']
totals={row[0]:str(next(value for value in row[1:] if isinstance(value,(int,float)))) for row in rows if row[0] in labels and any(isinstance(value,(int,float)) for value in row[1:])}
print(json.dumps({'pages':len(pdf.pages),'text':'\\n'.join(page.extract_text() or '' for page in pdf.pages),'totals':totals,'lines':[list(row) for row in rows if '문틀' in row]},ensure_ascii=False))`],
   {encoding:'utf8',windowsHide:true,timeout:15000,env:rendererEnvironment(pythonRoot),input:JSON.stringify({pdf:artifacts.pdf!.base64,xlsx:artifacts.xlsx!.base64})});
  assert.equal(inspected.status,0,'the actual generated PDF and workbook must reopen with real Python readers');
  const contents=JSON.parse(inspected.stdout);assert.ok(contents.pages>=1);assert.match(contents.text,/문틀/);assert.match(contents.text,/2,500,000/);assert.match(contents.text,/250,000/);assert.match(contents.text,/2,750,000/);
  assert.deepEqual(contents.totals,{'공급가액':'2500000','부가세':'250000','합계 (원)':'2750000'});
  assert.equal(contents.lines.length,1);for(const value of [100,25000,2500000,250000])assert.ok(contents.lines[0].includes(value),'the workbook contains the server-confirmed quantity, sale price, supply and tax');
  assert.equal((await admin`select count(*)::int n from app.job_effects where tenant_id=${f.tenant}::uuid and job_type='render_document'`)[0]!.n,1);
  // A second issued revision is left queued before the source changes, so the real worker must refuse its old basis.
  result=await call('/v1/document-drafts/'+ready+'/complete',{client_command_id:randomUUID(),form:{note:'합성 자료 버전 변경 전 렌더 대기'}});assert.equal(result.statusCode,200,result.body);
  const queuedDraft=(await call('/v1/document-drafts/'+result.json().id)).json();
  result=await call('/v1/documents/issue',{client_command_id:randomUUID(),drafts:[{id:queuedDraft.id,basis_hash:queuedDraft.document.basis_hash}],recipient_confirmation:'합성 고객'});assert.equal(result.statusCode,201,result.body);const queued=result.json().documents[0];
  assert.equal((await admin`select count(*)::int n from app.document_revisions where tenant_id=${f.tenant}::uuid`)[0]!.n,0,'local excerpts never impersonate uploaded originals');
  assert.equal((await admin`select count(*)::int n from app.invoices where tenant_id=${f.tenant}::uuid`)[0]!.n,0,'estimate issuance never creates receivables');
  result=await push(2,'합성 현장 문틀 200개로 견적 부탁드립니다.');assert.equal(result.statusCode,200,result.body);
  assert.equal((await call('/v1/document-drafts/'+ready)).json().stale,true);assert.equal((await admin`select app.render_authorized(${f.tenant}::uuid,${issued.revision_id}::uuid) ok`)[0]!.ok,false,'a renderer cannot read a changed local source as the old one');
  assert.equal(await runRenderOnce(renderOptions),'unavailable','an actual queued render is blocked after its local source hash/version changes');
  assert.equal(await runRenderOnce(renderOptions),'idle','a rejected source is not silently rendered again');
  const blocked=(await call('/v1/documents/'+queued.id)).json();assert.equal(blocked.render_state,'dead');assert.deepEqual(blocked.files,[]);
  assert.equal((await admin`select last_error_code from app.jobs where tenant_id=${f.tenant}::uuid and generated_revision_id=${queued.revision_id}::uuid`)[0]!.last_error_code,'RENDER_SOURCE_UNAVAILABLE');
  for(const format of ['pdf','xlsx']){
   assert.equal((await call(`/v1/documents/${queued.id}/files/${format}`)).statusCode,503,'no artifact is invented for a source version the renderer cannot read');
   const frozen=await call(`/v1/documents/${issued.id}/files/${format}`);assert.equal(frozen.statusCode,200,frozen.body);assert.equal(frozen.json().sha256,artifacts[format]!.sha256);assert.equal(frozen.json().base64,artifacts[format]!.base64,'existing issued bytes stay frozen while source permission remains valid');
  }
  assert.equal((await call('/v1/documents/'+issued.id)).json().document.totals.total,'2750000','an issued snapshot stays frozen');
  result=await call('/v1/work/journal/commands',{...command,expected_version:2,client_command_id:randomUUID()});assert.equal(result.statusCode,200,result.body);const current=(await call('/v1/document-drafts/'+result.json().id)).json();assert.equal(current.document.lines.length,0,'a prior-version event cannot seed the new 200-unit source with 100');
  const revoked=await app.inject({method:'POST',url:'/v1/devices/'+f.device+'/revoke',headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"1"'},payload:{}});assert.equal(revoked.statusCode,200,revoked.body);assert.equal(revoked.json().active,false);
  assert.equal((await call('/v1/document-drafts/'+ready)).statusCode,404);assert.equal((await call('/v1/documents/'+issued.id)).statusCode,404);
  for(const format of ['pdf','xlsx'])assert.equal((await call(`/v1/documents/${issued.id}/files/${format}`)).statusCode,404,'revocation also blocks downloading already generated artifacts');
  mkdirSync('.work/local-document-render',{recursive:true});writeFileSync('.work/local-document-render/verification.json',JSON.stringify({mode:'synthetic local journal with actual Python PDF/XLSX and PostgreSQL artifact publication',actual_model:'NOT_RUN',physical_pc:'NOT_RUN',render:'PASS',pdf_pages:contents.pages,totals:rendered.document.totals,files:Object.fromEntries(Object.entries(artifacts).map(([format,file])=>[format,{sha256:file.sha256,bytes:file.bytes}])),reopen:'PASS',changed_source_render:'BLOCKED',frozen_issued_files:'UNCHANGED',revoked_artifact_fetch:'BLOCKED'},null,2)+'\n');
 }finally{await app.close();await admin.begin(async tx=>{await deleteFixtureTenants(tx,[f.tenant]);await tx`delete from auth.sessions where user_id=${f.user}::uuid`;await tx`delete from auth.users where id=${f.user}::uuid`;});await Promise.all([admin.end(),api.end(),worker.end()]);}
});

test('an empty project can start an estimate and strict owner input computes exact fractional quantities without implying an order',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8')),admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}}),api=postgres(env.DATABASE_URL!,{max:2,onnotice:()=>{}});
 const tenant=randomUUID(),user=randomUUID(),session=randomUUID(),project=randomUUID();const app=createApp({db:api,verifyToken:async()=>({userId:user,sessionId:session})}),headers={authorization:'Bearer synthetic','x-tenant-id':tenant};
 const call=(url:string,payload?:object)=>app.inject({method:payload?'POST':'GET',url,headers,...(payload?{payload}:{})});
 try{await admin`insert into auth.users(id) values(${user}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'합성 새 업무')`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;await admin`insert into app.projects(tenant_id,id,display_name) values(${tenant}::uuid,${project}::uuid,'합성 새 현장')`;
  const command={project_id:project,type:'estimate',client_command_id:randomUUID()},made=await call('/v1/document-drafts',command);assert.equal(made.statusCode,200,made.body);assert.equal((await call('/v1/document-drafts',command)).json().id,made.json().id);const initial=(await call('/v1/document-drafts/'+made.json().id)).json();assert.equal(initial.state,'needs_inputs');assert.equal(initial.document.totals.total,null);
  const completed=await call('/v1/document-drafts/'+made.json().id+'/complete',{client_command_id:randomUUID(),recipient:'합성 고객',margin_bps:0,tax_mode:'not_applicable',lines:JSON.stringify([{description:'도장 작업',spec:'',unit:'㎡',quantity:'1.25',unit_price:'100'}])});assert.equal(completed.statusCode,200,completed.body);const ready=(await call('/v1/document-drafts/'+completed.json().id)).json();assert.equal(ready.state,'draft_ready');assert.deepEqual(ready.document.totals,{supply:'125',tax:'0',total:'125'});assert.equal(ready.input_lines[0].unit_price,'100');
  const issued=await call('/v1/documents/issue',{client_command_id:randomUUID(),drafts:[{id:ready.id,basis_hash:ready.document.basis_hash}],recipient_confirmation:'합성 고객'});assert.equal(issued.statusCode,201,issued.body);const issuedId=issued.json().documents[0].id,view=(await call('/v1/documents/'+issuedId)).json();assert.equal(view.document.totals.total,'125');const cancel=await call('/v1/documents/'+issuedId+'/cancel',{client_command_id:randomUUID(),expected_hash:view.snapshot_hash});assert.equal(cancel.statusCode,200,cancel.body);assert.equal((await call('/v1/documents/'+issuedId)).json().state,'cancelled');
  const sideEffects=await admin`select (select count(*) from app.purchase_orders where tenant_id=${tenant}::uuid)::int orders,(select count(*) from app.invoices where tenant_id=${tenant}::uuid)::int invoices`;assert.equal(sideEffects[0]!.orders,0);assert.equal(sideEffects[0]!.invoices,0);
 }finally{await app.close();await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant]);await tx`delete from auth.sessions where user_id=${user}::uuid`;await tx`delete from auth.users where id=${user}::uuid`;});await Promise.all([admin.end(),api.end()]);}
});
