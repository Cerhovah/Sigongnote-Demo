import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {photoFixture} from './photo-fixture.js';
test('N18 same-photo dedup, order/captions, other-site conflict, version concurrency and withdrawal',async()=>{
 const f=await photoFixture();try{
  const a=await f.upload(Buffer.from('synthetic photo A')),b=await f.upload(Buffer.from('synthetic photo B')),duplicate=await f.upload(Buffer.from('synthetic photo A'));
  const listing=(await f.get('/v1/photos?project_id='+f.project)).json();assert.equal(listing.photos.length,2);assert.equal(listing.original_metadata,'preserved');
  for(let n=0;n<51;n++)await f.upload(Buffer.from('synthetic pagination '+n));
  const newest=await f.upload(Buffer.from('synthetic latest'));const first=(await f.get('/v1/photos?project_id='+f.project)).json();assert.equal(first.photos[0].id,newest);assert.equal(first.photos.length,50);assert.ok(first.next_cursor);const second=(await f.get('/v1/photos?project_id='+f.project+'&cursor='+first.next_cursor)).json();assert.equal(second.photos.length,4);assert.ok(!second.photos.some((p:any)=>first.photos.some((q:any)=>p.id===q.id)));
  const body={client_command_id:randomUUID(),project_id:f.project,title:'합성 현장 점검',photos:[{revision_id:b,caption:'창틀',taken_date:null},{revision_id:a},{revision_id:duplicate}]};
  const saved=await f.post('/v1/photos/groups',body);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().photo_count,2);assert.deepEqual((await f.post('/v1/photos/groups',body)).json(),saved.json());
  const id=saved.json().id,g=(await f.get('/v1/photos/groups/'+id)).json();assert.deepEqual(g.photos.map((p:any)=>p.revision_id),[b,a]);assert.equal(g.photos[0].taken_date,null);assert.equal(g.photos[0].caption,'창틀');
  assert.equal((await f.get('/v1/photos/groups/'+id,randomUUID())).statusCode,404);assert.equal((await f.api`select * from app.photo_groups`).length,0);await assert.rejects(f.worker`select * from app.photo_group_versions`,/permission denied/);
  const update={...body,id,expected_version:1,client_command_id:randomUUID(),photos:[{revision_id:a,caption:'보완 위치는 확인 전'},{revision_id:b}]};assert.equal((await f.post('/v1/photos/groups',update)).statusCode,200);assert.equal((await f.post('/v1/photos/groups',{...update,client_command_id:randomUUID()})).statusCode,409);
  const other=randomUUID();await f.admin`insert into app.projects(tenant_id,id,display_name) values(${f.f.tenant}::uuid,${other}::uuid,'다른 합성 현장')`;
  await f.admin`insert into app.evidence_organizations(tenant_id,revision_id,job_id,source_root_id,project_id,state,categories,project_candidates,rule_version) select tenant_id,id,${f.f.job}::uuid,blob_id,${other}::uuid,'linked',array['delivery_work'],array[${other}::uuid],'synthetic-photo' from app.document_revisions where tenant_id=${f.f.tenant}::uuid and id=${b}::uuid on conflict(tenant_id,revision_id) do update set project_id=excluded.project_id`;
  assert.equal((await f.get('/v1/photos/groups/'+id)).json().context_conflict,true);assert.equal((await f.post('/v1/photos/groups',{...body,client_command_id:randomUUID()})).json().error.code,'SOURCE_SCOPE_MISMATCH');
  await f.admin`update app.capture_sources set server_upload_consent=false where tenant_id=${f.f.tenant}::uuid and id=${f.f.source}::uuid`;
  assert.equal((await f.get('/v1/photos/groups/'+id)).statusCode,404);assert.equal((await f.get('/v1/photos?project_id='+f.project)).json().photos.length,0);
 }finally{await f.close();}
});
