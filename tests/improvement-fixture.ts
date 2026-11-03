import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {processingFixture} from './processing-fixture.js';
import {createApp} from '../services/api/src/app.js';
import {runParseOnce} from '../services/api/src/parse-worker.js';
export async function improvementFixture(databaseName?:string){
 const db=await processingFixture(databaseName),f=await db.createFixture(),project=randomUUID();
 await db.admin`insert into app.projects(tenant_id,id,display_name) values(${f.tenant}::uuid,${project}::uuid,'합성 개선 현장')`;
 const app=createApp({db:db.api,capturePolicy:db.config.policy,verifyToken:async()=>({userId:f.user,sessionId:f.session}),storage:{async sign(){return 'https://storage.invalid/synthetic?token=synthetic-opaque-upload-signature';},async verify(){return {matches:true,sniffedMime:'text/plain'};},async remove(){}}});
 const call=(url:string,payload?:object,tenant=f.tenant)=>app.inject({method:payload?'POST':'GET',url,headers:{authorization:'Bearer synthetic','x-tenant-id':tenant,'idempotency-key':randomUUID()},...(payload?{payload}:{})});
 const ok=async(p:ReturnType<typeof call>)=>{const r=await p;assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);return r.json();};
 const command=(b:object)=>call('/v1/improvements/commands',{command_id:randomUUID(),...b});
 const learn=(b:object)=>call('/v1/learning/commands',{command_id:randomUUID(),...b});
 await ok(learn({action:'consent',purpose:'company-improvement-v1',allowed:true}));
 const add=async(label:string,answer='문틀 재설치',review=true)=>{
  const bytes=Buffer.from(`하자: 문틀 재설치 필요한 합성 ${label}\n조치: 임시 방문`),digest=createHash('sha256').update(bytes).digest('hex'),context=randomUUID();
  const prepared=await ok(call('/v1/ingestions',{client_capture_id:randomUUID(),source_id:f.source,source_generation:1,sha256:digest,byte_length:bytes.length,declared_mime:'text/plain'}));
  const completed=await ok(call(`/v1/ingestions/${prepared.ingestion_id}/complete`,{sha256:digest,byte_length:bytes.length}));
  assert.equal(await runParseOnce({db:db.worker,policy:db.config.policy,tenantScope:f.tenant,python:resolve('services/document-worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),pythonRoot:resolve('services/document-worker'),download:async()=>bytes}),'stored');
  await db.admin`insert into app.work_contexts(tenant_id,id,project_id,label) values(${f.tenant}::uuid,${context}::uuid,${project}::uuid,${label})`;
  await db.admin`update app.evidence_organizations set project_id=${project}::uuid,context_id=${context}::uuid,state='linked' where tenant_id=${f.tenant}::uuid and revision_id=${completed.revision_id}::uuid`;
  const q=(await ok(call('/v1/work/questions'))).questions.find((x:any)=>x.context_id===context);assert.ok(q,'quality question');
  if(!review)return {q,context,revision:completed.revision_id,id:'',version:0};
  const saved=await ok(call('/v1/work-commands',{command_id:randomUUID(),intent:'answer',targets:[{type:'work_issue',id:q.id,version:q.version}],evidence_refs:q.source_refs,effects:[{kind:'quality',action:answer}],policy_version:1}));
  const [row]=await db.admin`select id,learning_version from app.decision_examples where tenant_id=${f.tenant}::uuid and decision_id=${saved.decision_id}::uuid and learning_consent_id is not null`;assert.ok(row);
  const classified=await ok(learn({action:'review',id:row.id,version:row.learning_version,state:q.proposal.effects[0].action===answer?'confirmed':'correction',reason:'합성 담당자가 원문과 실제 조치를 확인'}));
  return {id:String(row.id),version:classified.version,q,context,revision:completed.revision_id};
 };
 const report=async()=>ok(call('/v1/improvements'));
 return {db,f,project,app,call,ok,command,learn,add,report,async close(){await app.close();await db.cleanup();}};
}
