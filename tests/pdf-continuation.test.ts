import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID,generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import postgres from 'postgres';
import {createClient} from '@supabase/supabase-js';
import {createApp} from '../services/api/src/app.js';
import {createStorageGateway,ORIGINAL_BUCKET} from '../services/api/src/storage.js';
import {LOCAL_CAPTURE_POLICY} from '../services/api/src/capture-scope.js';
import {parseBytes,runParseOnce,type EvidenceChunk} from '../services/api/src/parse-worker.js';
import {mergePdfManifest,mergePdfOutput,configuredPdfBatchPages} from '../services/api/src/pdf-continuation.js';
import {parseStrictLocalEnv} from '../scripts/local-env-values.mjs';
import {verifyLocalDevelopmentDb} from '../scripts/db-gate.mjs';
import {deleteFixtureTenants} from './fixture-cleanup.js';

const python={python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker')};
const pdfBytes=(pages:number)=>{
 const result=spawnSync(python.python,['-c','import sys; from reportlab.pdfgen import canvas; c=canvas.Canvas(sys.stdout.buffer); [(c.drawString(40,700,"tail%d" % (i+1)),c.showPage()) for i in range(int(sys.argv[1]))]; c.save()',String(pages)]);
 assert.equal(result.status,0);return result.stdout;
};

test('N02 PDF durable windows survive expired leases, partial staging, publication and withdrawal',async()=>{
 assert.equal((await verifyLocalDevelopmentDb()).status,'READY');
 const env=parseStrictLocalEnv(readFileSync('services/api/.env','utf8'));
 const admin=postgres(env.MIGRATION_DATABASE_URL!,{max:1}),db=postgres(env.DATABASE_URL!,{max:3}),worker=postgres(env.WORKER_DATABASE_URL!,{max:2});
 const storage=createClient(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from(ORIGINAL_BUCKET);
 const tenant=randomUUID(),user=randomUUID(),session=randomUUID(),other=randomUUID(),keys:string[]=[];
 const app=createApp({db,capturePolicy:LOCAL_CAPTURE_POLICY,verifyToken:async()=>({userId:user,sessionId:session}),storage:createStorageGateway(env.SUPABASE_URL!,env.SUPABASE_SECRET_KEY!)});
 const headers={authorization:'Bearer fixture','x-tenant-id':tenant};
 const call=(url:string,payload?:object)=>app.inject({method:payload?'POST':'GET',url,headers:{...headers,'idempotency-key':randomUUID()},...(payload?{payload}:{})});
 try{
  await admin`insert into auth.users(id) values(${user}::uuid),(${other}::uuid)`;await admin`insert into auth.sessions(id,user_id) values(${session}::uuid,${user}::uuid)`;
  await admin`insert into app.tenants(id,display_name) values(${tenant}::uuid,'PDF resume fixture')`;await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
  const key=generateKeyPairSync('ec',{namedCurve:'P-256'}).publicKey.export({format:'jwk'});
  const device=await call('/v1/devices',{platform:'windows',app_version:'pdf-resume-fixture',public_key_jwk:{kty:'EC',crv:'P-256',x:key.x,y:key.y}});assert.equal(device.statusCode,201);
  const source=await call('/v1/capture-sources',{device_id:device.json().id,kind:'folder',scope_fingerprint:'b'.repeat(64),consent_version:1,local_selection_consent:true,server_upload_consent:true,external_ai_consent:false});assert.equal(source.statusCode,201);
  const bytes=pdfBytes(203),sha256=createHash('sha256').update(bytes).digest('hex');
  const prepared=await call('/v1/ingestions',{client_capture_id:randomUUID(),sha256,byte_length:bytes.length,declared_mime:'application/pdf',source_id:source.json().id,source_generation:1});assert.equal(prepared.statusCode,201,prepared.body);
  const receipt=prepared.json(),path=`${tenant}/${receipt.ingestion_id}`;keys.push(path);
  assert.ifError((await storage.uploadToSignedUrl(path,new URL(receipt.upload_url).searchParams.get('token')!,bytes,{contentType:'application/pdf'})).error);
  const complete=await call(`/v1/ingestions/${receipt.ingestion_id}/complete`,{sha256,byte_length:bytes.length});assert.equal(complete.statusCode,200,complete.body);
  const revision=complete.json().revision_id,job=complete.json().job_id;
  const options={db:worker,policy:LOCAL_CAPTURE_POLICY,tenantScope:tenant,...python,pdfBatchPages:200,download:async()=>bytes};
  assert.equal(await runParseOnce(options),'continued');
  const [checkpoint]=await admin`select i.*,j.state,j.attempt_count from app.evidence_chunk_indexes i join app.jobs j on j.tenant_id=i.tenant_id and j.id=i.job_id where i.tenant_id=${tenant}::uuid and i.job_id=${job}::uuid`;
  assert.equal(checkpoint?.checkpoint_page,201);assert.equal(checkpoint?.checkpoint_chunks,200);assert.equal(checkpoint?.state,'queued');assert.equal(checkpoint?.attempt_count,0);assert.equal(checkpoint?.published,false);
  const pending=await call(`/v1/evidence/${revision}/chunks`);assert.equal(pending.statusCode,200,pending.body);assert.equal(pending.json().chunks.length,0);
  assert.equal(pending.json().coverage.pdf_processing.pages_processed,200);assert.equal(pending.json().coverage.pdf_processing.pages_seen,203);
  assert.equal((await app.inject({url:`/v1/evidence/${revision}/chunks`,headers:{...headers,'x-tenant-id':other}})).statusCode,404);
  // A genuinely timed-out child shrinks the persisted window without losing the checkpoint.
  const slowRoot=await mkdtemp(join(tmpdir(),'sigongnote-slow-parser-'));
  try{
   await mkdir(join(slowRoot,'src','sigongnote_worker'),{recursive:true});
   await writeFile(join(slowRoot,'src','sigongnote_worker','__init__.py'),'');
   await writeFile(join(slowRoot,'src','sigongnote_worker','__main__.py'),'import time; time.sleep(30)');
   assert.equal(await runParseOnce({...options,pythonRoot:slowRoot,pdfBatchPages:20,timeoutMs:250}),'retry');
   const [shrunk]=await admin`select pdf_page_limit,state from app.jobs where tenant_id=${tenant}::uuid and id=${job}::uuid`;
   assert.equal(shrunk?.pdf_page_limit,10);assert.equal(shrunk?.state,'retry_wait');
  }finally{await rm(slowRoot,{recursive:true,force:true});}
  await admin`update app.jobs set state='dead',last_error_code='PARSER_RETRY',attempt_count=5 where tenant_id=${tenant}::uuid and id=${job}::uuid`;
  const stopped=await call(`/v1/evidence/${revision}/chunks`);assert.equal(stopped.json().coverage.pdf_processing.can_resume,true);
  const resume={job_id:job,resume_generation:0};
  assert.equal((await app.inject({url:`/v1/evidence/${revision}/resume`,method:'POST',headers:{...headers,'x-tenant-id':other},payload:resume})).statusCode,404);
  await admin`insert into app.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${other}::uuid,'owner')`;
  await admin`update app.memberships set role='viewer' where tenant_id=${tenant}::uuid and user_id=${user}::uuid`;
  assert.equal((await call(`/v1/evidence/${revision}/resume`,resume)).statusCode,404);
  await admin`update app.memberships set role='owner' where tenant_id=${tenant}::uuid and user_id=${user}::uuid`;
  assert.equal((await call(`/v1/evidence/${revision}/resume`,resume)).statusCode,200);
  await admin`update app.jobs set state='dead',last_error_code='PARSER_RETRY' where tenant_id=${tenant}::uuid and id=${job}::uuid`;
  assert.equal((await call(`/v1/evidence/${revision}/resume`,resume)).statusCode,200,'lost response retry is idempotent');
  assert.equal((await admin`select state from app.jobs where id=${job}::uuid`)[0]?.state,'dead','old resume cannot restart a later failed run');
  assert.equal((await call(`/v1/evidence/${revision}/resume`,{...resume,resume_generation:1})).statusCode,200);
  assert.equal((await admin`select checkpoint_page from app.evidence_chunk_indexes where job_id=${job}::uuid`)[0]?.checkpoint_page,201);
  await admin`update app.jobs set pdf_page_limit=null where tenant_id=${tenant}::uuid and id=${job}::uuid`;
  const [lease]=await worker`select * from app.claim_parse_job_for_tenant('resume-crash',60,'document-python-v1',${tenant}::uuid)`;assert.ok(lease);
  assert.equal((await worker`select app.pdf_parse_progress(${other}::uuid,${job}::uuid,${lease.lease_token}::uuid,${worker.json(LOCAL_CAPTURE_POLICY)}) p`)[0]?.p,null);
  const chunks:EvidenceChunk[]=[];
  const tail=await parseBytes(bytes,'application/pdf',python,AbortSignal.timeout(20000),{begin:async()=>{},append:async batch=>{chunks.push(...batch);}},{startPage:201,pageLimit:200});
  assert.equal(chunks[0]?.locator,'page:201');assert.equal(chunks.length,3);
  const combined=mergePdfOutput(checkpoint!.checkpoint_output,tail,201);combined.processorVersion='document-python-v1';
  assert.equal((await worker`select app.begin_pdf_evidence_batch(${tenant}::uuid,${job}::uuid,${lease.lease_token}::uuid,1,${worker.json(combined.evidence!)},${worker.json(LOCAL_CAPTURE_POLICY)}) ok`)[0]?.ok,false);
  assert.equal((await worker`select app.begin_pdf_evidence_batch(${tenant}::uuid,${job}::uuid,${lease.lease_token}::uuid,201,${worker.json(combined.evidence!)},${worker.json(LOCAL_CAPTURE_POLICY)}) ok`)[0]?.ok,true);
  const partial=chunks.slice(0,1).map(c=>({...c,ordinal:c.ordinal+200}));
  const stage=()=>worker`select app.stage_evidence_chunks(${tenant}::uuid,${job}::uuid,${lease.lease_token}::uuid,${worker.json(partial)},${worker.json(LOCAL_CAPTURE_POLICY)}) ok`;
  assert.equal((await stage())[0]?.ok,true);
  assert.equal((await worker`select app.checkpoint_pdf_parse(${tenant}::uuid,${job}::uuid,${lease.lease_token}::uuid,201,${worker.json(combined)},${worker.json(LOCAL_CAPTURE_POLICY)}) ok`)[0]?.ok,false,'partial staging cannot publish');
  await admin`update app.jobs set lease_expires_at=now()-interval '1 second' where tenant_id=${tenant}::uuid and id=${job}::uuid`;
  assert.equal(await runParseOnce(options),'stored');assert.equal((await stage())[0]?.ok,false);
  const [stored]=await admin`select output from app.parse_results where tenant_id=${tenant}::uuid and job_id=${job}::uuid`;
  assert.equal(stored?.output.coverage.pages_processed,203);assert.equal(stored?.output.coverage.pages_read,203);assert.equal(stored?.output.coverage.next_page,undefined);
  assert.equal(stored?.output.status,'complete');assert.equal(stored?.output.issues.includes('page_limit_exceeded'),false);
  assert.equal((await admin`select count(*)::int n from app.evidence_chunks where tenant_id=${tenant}::uuid and job_id=${job}::uuid`)[0]?.n,203);
  assert.equal((await admin`select count(*)::int n from app.job_effects where tenant_id=${tenant}::uuid and job_id=${job}::uuid`)[0]?.n,1);
  const first=await call(`/v1/evidence/${revision}/chunks?limit=200`);assert.equal(first.json().indexed_chunks,203);assert.equal(first.json().coverage.pdf_processing,undefined);
  await admin`insert into app.jobs(tenant_id,job_type,evidence_revision_id,processor_version,input_hash,state,created_at) values(${tenant}::uuid,'parse_original',${revision}::uuid,'document-evidence-v1',${sha256},'dead','2000-01-01')`;
  assert.equal((await call(`/v1/evidence/${revision}/chunks`)).json().coverage.pdf_processing,undefined,'an older failed job does not hide a newer successful result');
  const last=await call(`/v1/evidence/${revision}/chunks?cursor=${first.json().next_cursor}`);assert.equal(last.json().chunks[0].locator,'page:201');assert.equal(last.json().chunks.at(-1).text,'tail203');
  assert.equal((await call('/v1/work/materials?q=tail201')).json().materials[0].id,revision);
  const downloaded=await storage.download(path);assert.ifError(downloaded.error);assert.equal(createHash('sha256').update(Buffer.from(await downloaded.data!.arrayBuffer())).digest('hex'),sha256);
  await assert.rejects(worker`select * from app.evidence_chunk_indexes`,/permission denied/);assert.equal((await db`select * from app.evidence_chunk_indexes`).length,0);
  // A second job demonstrates that a withdrawal blocks a persisted continuation as well as published evidence.
  await admin`insert into app.jobs(tenant_id,job_type,evidence_revision_id,processor_version,input_hash) values(${tenant}::uuid,'parse_original',${revision}::uuid,'document-pdf-pages-v1',${sha256})`;
  for(let page=0;page<6;page++)assert.equal(await runParseOnce({...options,pdfBatchPages:1}),'continued','successful page windows do not exhaust the five-retry allowance');
  const [held]=await worker`select * from app.claim_parse_job_for_tenant('withdraw-resume',60,'document-pdf-pages-v1',${tenant}::uuid)`;assert.ok(held);
  const revoked=await app.inject({method:'POST',url:`/v1/capture-sources/${source.json().id}/revoke`,payload:{},headers:{...headers,'idempotency-key':randomUUID(),'if-match':'"1"'}});assert.equal(revoked.statusCode,200,revoked.body);
  assert.equal((await worker`select app.pdf_parse_progress(${tenant}::uuid,${held.job_id}::uuid,${held.lease_token}::uuid,${worker.json(LOCAL_CAPTURE_POLICY)}) p`)[0]?.p,null);
  assert.equal((await worker`select app.begin_pdf_evidence_batch(${tenant}::uuid,${held.job_id}::uuid,${held.lease_token}::uuid,201,${worker.json(combined.evidence!)},${worker.json(LOCAL_CAPTURE_POLICY)}) ok`)[0]?.ok,false);
  assert.equal((await call(`/v1/evidence/${revision}/chunks?cursor=${first.json().next_cursor}`)).statusCode,404);
  assert.equal((await call(`/v1/evidence/${revision}/resume`,{job_id:held.job_id,resume_generation:0})).statusCode,404,'withdrawal blocks resuming');
 }finally{
  await app.close();if(keys.length)await storage.remove(keys);
  await admin.begin(async tx=>{await deleteFixtureTenants(tx,[tenant]);await tx`delete from auth.sessions where id=${session}::uuid`;await tx`delete from auth.users where id in (${user}::uuid,${other}::uuid)`;});
  await Promise.all([admin.end(),db.end(),worker.end()]);
 }
});

test('N02 page aggregation keeps earlier OCR uncertainty and the 1000-span display contract',async()=>{
 assert.equal(configuredPdfBatchPages(undefined),20);assert.equal(configuredPdfBatchPages('1'),1);assert.equal(configuredPdfBatchPages('200'),200);
 for(const value of ['0','201','NaN','1.5',''])assert.throws(()=>configuredPdfBatchPages(value),/INVALID/);
 const bytes=pdfBytes(2),first=await parseBytes(bytes,'application/pdf',python,AbortSignal.timeout(10000),undefined,{startPage:1,pageLimit:1});
 const second=await parseBytes(bytes,'application/pdf',python,AbortSignal.timeout(10000),undefined,{startPage:2,pageLimit:1});
 first.spans=Array.from({length:1000},(_,i)=>({text:'source'+i,locator:'page:1'}));first.coverage.pages_partial=1;first.evidence!.coverage.pages_partial=1;
 const merged=mergePdfOutput(first,second,2);assert.equal(merged.spans.length,1000);assert.equal(merged.excerptTruncated,true);assert.equal(merged.evidence?.sourceStatus,'partial');assert.equal(merged.coverage.pages_processed,2);
 assert.throws(()=>mergePdfManifest(first,{...second.evidence!,parserVersion:'different'},2),/MISMATCH/);
 assert.throws(()=>mergePdfManifest(first,second.evidence!,1),/MISMATCH/);
});
