import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
test('archive remains preserved and paused, current work wins when enabled, and journal excludes history',async()=>{
 const db=await processingFixture(),f=await db.createFixture('합성 새 업무'),old=await db.createFixture('합성 과거 자료');
 const app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:old.user,sessionId:old.session})});
 const headers={authorization:'Bearer fixture','x-tenant-id':old.tenant};
 try{
  await db.admin`update app.jobs set state='queued',attempt_count=0,work_lane='archive',available_at=now()-interval '1 day' where tenant_id=${old.tenant}::uuid and id=${old.job}::uuid`;
  const claim=()=>db.worker`select * from app.claim_parse_job_for_tenant('archive-test',60,'document-python-v1',${old.tenant}::uuid)`;
  assert.equal((await claim()).length,0);
  await db.admin`update app.jobs set state='succeeded' where tenant_id=${old.tenant}::uuid and id=${old.job}::uuid`;
  assert.equal((await db.next(1,[],old.tenant)),null,'completed archive parse must not invoke semantic analysis while paused');
  await db.admin`update app.jobs set state='queued' where tenant_id=${old.tenant}::uuid and id=${old.job}::uuid`;
  assert.equal((await app.inject({url:'/v1/work/journal',headers})).json().items.length,0);
  const status=(await app.inject({url:'/v1/work/archive',headers})).json();assert.equal(status.enabled,false);assert.equal(status.waiting,1);
  const cmd={client_command_id:randomUUID(),expected_version:0,enabled:true};const send=(payload:object)=>app.inject({method:'POST',url:'/v1/work/archive',headers,payload});
  let response=await send(cmd);assert.equal(response.statusCode,200,response.body);assert.deepEqual((await send(cmd)).json(),response.json());
  assert.equal((await send({...cmd,client_command_id:randomUUID(),enabled:false})).statusCode,409);
  const current=randomUUID();await db.admin`insert into app.jobs(tenant_id,id,job_type,evidence_revision_id,processor_version,input_hash,work_lane) select tenant_id,${current}::uuid,job_type,evidence_revision_id,'archive-priority-fixture',${'0'.repeat(64)},'current' from app.jobs where tenant_id=${old.tenant}::uuid and id=${old.job}::uuid`;
  assert.equal((await db.admin`select work_lane from app.jobs where tenant_id=${old.tenant}::uuid and id=${current}::uuid`)[0]!.work_lane,'archive','resumed work inherits archive');
  await db.admin`update app.jobs set work_lane='current' where tenant_id=${old.tenant}::uuid and id=${current}::uuid`;
  // Use the same processor to prove lane ordering, independently of separate audio/photo loops.
  await db.admin`update app.jobs set processor_version='archive-priority-fixture' where tenant_id=${old.tenant}::uuid and id=${old.job}::uuid`;
  const [first]=await db.worker`select * from app.claim_parse_job_for_tenant('archive-test',60,'archive-priority-fixture',${old.tenant}::uuid)`;assert.equal(first!.job_id,current);
  assert.equal((await db.worker`select * from app.claim_parse_job_for_tenant('archive-test',60,'archive-priority-fixture',${old.tenant}::uuid)`)[0]!.job_id,old.job);
  response=await send({client_command_id:randomUUID(),expected_version:1,enabled:false});assert.equal(response.statusCode,200);
  assert.equal((await db.admin`select count(*)::int n from app.document_revisions where tenant_id=${old.tenant}::uuid`)[0]!.n,1);
  assert.equal((await app.inject({url:'/v1/work/archive',headers:{...headers,'x-tenant-id':f.tenant}})).statusCode,404);
  await db.admin`insert into app.memberships(tenant_id,user_id,role) values(${old.tenant}::uuid,${f.user}::uuid,'operator')`;
  const operator=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session})});
  try{assert.equal((await operator.inject({url:'/v1/work/archive',headers})).statusCode,404);assert.equal((await operator.inject({method:'POST',url:'/v1/work/archive',headers,payload:{client_command_id:randomUUID(),expected_version:2,enabled:true}})).statusCode,404);}finally{await operator.close();}
  const ref={client_command_id:randomUUID(),revision_id:old.revision};response=await send(ref);assert.equal(response.statusCode,200,response.body);assert.equal((await send(ref)).statusCode,200);
  assert.equal((await db.admin`select count(*)::int n from app.jobs where tenant_id=${old.tenant}::uuid and work_lane='archive'`)[0]!.n,0);
  assert.equal((await app.inject({url:'/v1/work/journal',headers})).json().items.length,1);
 }finally{await app.close();await db.cleanup();}
});
