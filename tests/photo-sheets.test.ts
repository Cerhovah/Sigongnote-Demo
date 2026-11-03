import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {photoFixture} from './photo-fixture.js';
import {runPhotoSheetOnce} from '../services/api/src/photo-sheet-worker.js';
import {runAgentOnce} from '../services/api/src/agent-runs.js';
// Tiny valid PNG: real decoder used in the worker, separate Python layout tests use larger photographs.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('N19 durable photo-sheet -> actual PDF, duplicate intent, conversation replay and withdrawal',async()=>{
 const f=await photoFixture();try{
  const rev=await f.upload(png),saved=await f.post('/v1/photos/groups',{client_command_id:randomUUID(),project_id:f.project,title:'합성 사진대지',photos:[{revision_id:rev,caption:'시험 창틀'}]});assert.equal(saved.statusCode,200,saved.body);
  const body={project_id:f.project,group_id:saved.json().id,layout:4,grayscale:true};const created=await f.post('/v1/photo-sheets',body);assert.equal(created.statusCode,200,created.body);const id=created.json().photo_sheet.id;
  assert.equal((await f.post('/v1/photo-sheets',body)).json().photo_sheet.id,id);assert.equal((await f.admin`select * from app.jobs where tenant_id=${f.f.tenant}::uuid and photo_sheet_id=${id}::uuid`).length,1);
  assert.equal((await f.get('/v1/photo-sheets/'+id+'/file')).statusCode,503);
  assert.equal((await f.get('/v1/work/journal')).json().items.some((item:any)=>item.id===id),false,'unrendered sheet is not a completed journal result');
  const options={db:f.worker,tenantScope:f.f.tenant,python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker'),download:async(i:any)=>f.files.get(i.storage_key)!};
  assert.equal(await runPhotoSheetOnce(options),'stored');assert.equal(await runPhotoSheetOnce(options),'idle');
  const journal=await f.get('/v1/work/journal?project_id='+f.project+'&category=delivery_work');assert.equal(journal.statusCode,200,journal.body);
  const entry=journal.json().items.find((item:any)=>item.id===id);assert.equal(entry?.source_kind,'photo_sheet');assert.equal(entry?.excerpt,'합성 사진대지');
  assert.equal(journal.json().items.filter((item:any)=>item.id===id).length,1,'one render creates one journal entry');
  assert.equal((await f.get('/v1/work/journal?cursor='+id)).json().items.some((item:any)=>item.id===id),false,'sheet cursor advances normally');
  const file=await f.get('/v1/photo-sheets/'+id+'/file');assert.equal(file.statusCode,200,file.body);const bytes=Buffer.from(file.json().base64,'base64');assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.equal(file.json().sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal((await f.get('/v1/photo-sheets/'+id)).json().pages,1);
  assert.equal((await f.get('/v1/photo-sheets/'+id,randomUUID())).statusCode,404);await assert.rejects(f.worker`select * from app.photo_sheet_artifacts`,/permission denied/);
  const feed=(await f.get('/v1/sync/changes?sync_version=2')).json();
  assert.ok(feed.changes.some((c:any)=>c.kind==='photo_sheet'&&c.id===id&&c.files[0]?.sha256===file.json().sha256));
  assert.ok(!(await f.get('/v1/sync/changes')).json().changes.some((c:any)=>c.kind==='photo_sheet'),'old readers never receive unknown kinds');
  assert.equal((await f.get('/v1/sync/changes?kind=photo_sheet&id='+id)).json().changes[0].revision_id,id);
  assert.equal((await f.get('/v1/sync/changes?sync_version=2&cursor='+encodeURIComponent(feed.next_cursor),randomUUID())).statusCode,400);
  const run=await f.post('/v1/agent/runs',{client_turn_id:randomUUID(),project_id:f.project,instruction:'흑백 사진대지 만들어줘',input_kind:'text'});assert.equal(run.statusCode,202,run.body);await runAgentOnce(f.services,{},f.f.tenant);const result=await f.get('/v1/agent/runs/'+run.json().run_id);assert.equal(result.json().photo_sheets[0].id,id,result.body);
  const count=await f.admin`select count(*) n from app.photo_sheets where tenant_id=${f.f.tenant}::uuid`;await f.get('/v1/agent/runs/'+run.json().run_id);assert.equal((await f.admin`select count(*) n from app.photo_sheets where tenant_id=${f.f.tenant}::uuid`)[0]!.n,count[0]!.n);
  const other=randomUUID();await f.admin`insert into app.projects(tenant_id,id,display_name) values(${f.f.tenant}::uuid,${other}::uuid,'합성 다른 현장')`;await f.admin`insert into app.evidence_organizations(tenant_id,revision_id,job_id,source_root_id,project_id,state,categories,project_candidates,rule_version) select tenant_id,id,${f.f.job}::uuid,blob_id,${other}::uuid,'linked',array['delivery_work'],array[${other}::uuid],'test' from app.document_revisions where tenant_id=${f.f.tenant}::uuid and id=${rev}::uuid`;const conflict=await f.post('/v1/agent/runs',{client_turn_id:randomUUID(),project_id:f.project,instruction:'사진대지 만들어줘',input_kind:'text'});await runAgentOnce(f.services,{},f.f.tenant);assert.match((await f.get('/v1/agent/runs/'+conflict.json().run_id)).json().answer,/사진 묶음의 현장 연결/);await f.admin`delete from app.evidence_organizations where tenant_id=${f.f.tenant}::uuid and revision_id=${rev}::uuid`;
  const second=await f.post('/v1/photo-sheets',{...body,layout:2});const next=second.json().photo_sheet.id;
  await f.admin`update app.capture_sources set server_upload_consent=false where tenant_id=${f.f.tenant}::uuid and id=${f.f.source}::uuid`;
  assert.equal((await f.get('/v1/work/journal')).json().items.some((item:any)=>item.id===id),false,'withdrawn photo source removes generated sheet from journal');
  assert.equal((await f.get('/v1/sync/changes?kind=photo_sheet&id='+id)).json().changes[0].tombstone,true);
  assert.equal(await runPhotoSheetOnce(options),'unavailable');assert.equal((await f.get('/v1/photo-sheets/'+id+'/file')).statusCode,404);assert.equal((await f.get('/v1/agent/runs/'+run.json().run_id)).json().photo_sheets.length,0);assert.equal((await f.admin`select * from app.photo_sheet_artifacts where tenant_id=${f.f.tenant}::uuid and sheet_id=${next}::uuid`).length,0);
 }finally{await f.close();}
});
