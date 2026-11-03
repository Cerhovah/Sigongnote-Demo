import {createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,idempotencyKey,membership,once,principal,tenantHeader,type Services} from './routes.js';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uid=z.uuid(), sha=z.string().regex(/^[a-f0-9]{64}$/), code=z.string().regex(/^[a-z0-9_]{1,60}$/);
const span=z.object({locator:z.string().min(1).max(300),text:z.string().min(1).max(1000)}).strict();
const capture=z.object({source_id:uid,source_generation:z.number().int().positive(),local_document_id:uid,
 local_revision:z.number().int().positive(),sha256:sha,byte_length:z.number().int().min(1).max(52428800),
 parser_version:z.string().min(1).max(80),parse_state:z.enum(['complete','partial']),
 spans:z.array(span).min(1).max(40),title:z.string().trim().min(1).max(180),
 category:z.enum(['agreement','drawing_material','delivery_work','billing_payment','inspection_defect'])}).strict();
const answer=z.object({version:z.number().int().positive(),attribution_version:z.number().int().positive(),source_hash:sha,choice:z.enum(['project','unknown','later','cancel']),
 project_id:uid.nullable(),actor:z.enum(['human','agent_test'])}).strict();
const event=z.object({event_id:uid,session_id:uid,task_id:uid.nullable(),document_id:uid.nullable(),operation_id:uid.nullable(),
 actor:z.enum(['human','agent_test']),client_time:z.iso.datetime(),device_sequence:z.number().int().nonnegative(),
 app_version:z.literal('0.1.0'),screen_id:z.enum(['today','projects','materials','admin']),
 control_id:z.enum(['screen_enter','screen_exit','question_view','evidence_open','answer','unknown','later','cancel','search','copy_prepare','copy_approve','copy_cancel','error']),
 result_code:code,active_ms:z.number().int().min(0).max(60000),latency_ms:z.number().int().min(0).max(600000),consent_version:z.literal(1)}).strict();
export function registerFieldRoutes(app:FastifyInstance,services:Services){
 app.post('/v1/field/captures',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),key=idempotencyKey(req),p=capture.safeParse(req.body);
  if(!p.success) throw new ApiFault('INVALID_CONTRACT');const b=p.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId))) throw new ApiFault('NOT_FOUND');
   return once(tx,tenant,actor.userId,'POST /v1/field/captures',key,hash(b),async()=>{
    const [source]=await tx`select s.id from app.capture_sources s join app.devices d on d.tenant_id=s.tenant_id and d.id=s.device_id
     where s.tenant_id=${tenant}::uuid and s.id=${b.source_id}::uuid and s.user_id=${actor.userId}::uuid
     and d.user_id=s.user_id and s.active and d.active and s.kind='folder' and s.local_selection_consent and s.server_upload_consent and s.generation=${b.source_generation} for share of s,d`;
    if(!source) throw new ApiFault('NOT_FOUND');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:field-capture`},0))`;
    const [old]=await tx`select * from app.field_captures where tenant_id=${tenant}::uuid and source_id=${b.source_id}::uuid
     and local_document_id=${b.local_document_id}::uuid order by local_revision desc,created_at desc limit 1`;
    if(old && Number(old.local_revision)>b.local_revision) throw new ApiFault('VERSION_CONFLICT');
    const [replayed]=await tx`select * from app.field_captures where tenant_id=${tenant}::uuid and source_id=${b.source_id}::uuid and local_document_id=${b.local_document_id}::uuid and content_hash=${hash(b)}`;
    if(replayed)return {status:200,body:replayed};
    if(old && Number(old.local_revision)===b.local_revision && old.source_hash!==b.sha256) throw new ApiFault('VERSION_CONFLICT',Number(old.local_revision));
    // Content deduplication is confined to blobs. Each local identity owns its version chain.
    let documentId:string,revisionId:string,evidenceId:string;
    {
     if(old) documentId=String(old.document_id);
     else {const [d]=await tx`insert into app.documents(tenant_id) values(${tenant}::uuid) returning id`;documentId=String(d?.id);}
     await tx`select id from app.documents where tenant_id=${tenant}::uuid and id=${documentId}::uuid for update`;
     await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:${b.sha256}:${b.byte_length}`},0))`;
     let [blob]=await tx`select id from app.evidence_blobs where tenant_id=${tenant}::uuid and sha256=${b.sha256} and byte_length=${b.byte_length}`;
     if(!blob) [blob]=await tx`insert into app.evidence_blobs(tenant_id,sha256,byte_length,sniffed_mime,storage_key,scan_state,storage_location)
      values(${tenant}::uuid,${b.sha256},${b.byte_length},'application/octet-stream',${`${tenant}/device-only/${b.sha256}`},'unsupported','device') returning id`;
     const [latest]=await tx`select id,revision_number from app.document_revisions where tenant_id=${tenant}::uuid and document_id=${documentId}::uuid order by revision_number desc limit 1`;
     const [revision]=await tx`insert into app.document_revisions(tenant_id,document_id,revision_number,predecessor_id,blob_id,declared_mime,parse_state)
      values(${tenant}::uuid,${documentId}::uuid,${Number(latest?.revision_number??0)+1},${latest?.id??null}::uuid,${blob?.id}::uuid,'application/octet-stream',${b.parse_state}) returning id`;
     revisionId=String(revision?.id);
     await tx`update app.documents set version=${Number(latest?.revision_number??0)+1} where tenant_id=${tenant}::uuid and id=${documentId}::uuid`;
     // Field metadata becomes readable only after its source/capture provenance is stored.
     evidenceId=randomUUID();
     await tx`insert into app.evidence_index(tenant_id,id,revision_id,scope,category,display_title,search_text,locator,source_kind)
      values(${tenant}::uuid,${evidenceId}::uuid,${revisionId}::uuid,'unassigned',${b.category},${b.title},${b.spans.map(s=>s.text).join('\n').slice(0,10000)},
       ${tx.json({kind:'device',position:{source_id:b.source_id,local_document_id:b.local_document_id,hash:b.sha256,spans:b.spans}})},'original')`;
    }
    const captureId=randomUUID();
    await tx`insert into app.field_captures(tenant_id,id,source_id,local_document_id,local_revision,source_generation,document_id,revision_id,evidence_id,source_hash,parser_version,content_hash)
     values(${tenant}::uuid,${captureId}::uuid,${b.source_id}::uuid,${b.local_document_id}::uuid,${b.local_revision},${b.source_generation},${documentId}::uuid,${revisionId}::uuid,${evidenceId}::uuid,${b.sha256},${b.parser_version},${hash(b)})`;
    const [saved]=await tx`select * from app.field_captures where tenant_id=${tenant}::uuid and id=${captureId}::uuid`;
    if(!saved)throw new ApiFault('NOT_FOUND');
    {
     const [exception]=await tx`insert into app.exception_cases(tenant_id,cause_key,cause,state) values(${tenant}::uuid,${`field:${evidenceId}`},'attribution_conflict','awaiting_decision') returning id`;
     await tx`insert into app.field_questions(tenant_id,id,capture_id,question) values(${tenant}::uuid,${exception?.id}::uuid,${saved?.id}::uuid,'이 자료는 어느 현장 일인가요?')`;
    }
    return {status:201,body:{...saved,parse_state:b.parse_state,analysis_state:'needs_answer',money_confirmed:false}};
   });
  });
 }));
 app.get('/v1/today',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==='viewer') throw new ApiFault('NOT_FOUND');
   const items=await tx`select q.id,q.question,q.answer,e.state,e.version,c.source_hash,c.local_document_id,c.local_revision,c.evidence_id,c.document_id,
    d.display_title,coalesce(a.version,1)::integer attribution_version from app.field_questions q join app.exception_cases e on e.tenant_id=q.tenant_id and e.id=q.id
    join app.field_captures c on c.tenant_id=q.tenant_id and c.id=q.capture_id
    join app.evidence_index d on d.tenant_id=c.tenant_id and d.id=c.evidence_id
    left join app.evidence_attributions a on a.tenant_id=c.tenant_id and a.evidence_index_id=c.evidence_id
    join app.capture_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id
    join app.devices dv on dv.tenant_id=s.tenant_id and dv.id=s.device_id
    where q.tenant_id=${tenant}::uuid and s.active and dv.active and s.generation=c.source_generation
    and (e.state<>'deferred' or e.next_review_at<=now()) and e.state<>'resolved'
    and (a.state is null or a.state<>'confirmed')
    and not exists(select 1 from app.document_revisions newer where newer.tenant_id=c.tenant_id and newer.document_id=c.document_id and newer.revision_number>(select revision_number from app.document_revisions where tenant_id=c.tenant_id and id=c.revision_id))
    order by q.updated_at limit 40`;
   return {status:200,body:{items:items.map(x=>({...x,version:Number(x.version)}))}};
  });
 }));
 app.post<{Params:{id:string}}>('/v1/field/questions/:id/answer',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),key=idempotencyKey(req),p=answer.safeParse(req.body),id=uid.safeParse(req.params.id);
  if(!p.success||!id.success) throw new ApiFault('INVALID_CONTRACT');const b=p.data;
  if((b.choice==='project')!==(b.project_id!==null)) throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId))) throw new ApiFault('NOT_FOUND');
   return once(tx,tenant,actor.userId,`POST /v1/field/questions/${id.data}/answer`,key,hash(b),async()=>{
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:field-capture`},0))`;
    const [q]=await tx`select q.*,e.version,c.evidence_id,c.source_hash,c.revision_id,c.document_id,c.source_id,c.source_generation
     from app.field_questions q join app.exception_cases e on e.tenant_id=q.tenant_id and e.id=q.id join app.field_captures c on c.tenant_id=q.tenant_id and c.id=q.capture_id
     where q.tenant_id=${tenant}::uuid and q.id=${id.data}::uuid for update of q,e`;
    if(!q) throw new ApiFault('NOT_FOUND');
    const [scope]=await tx`select s.id from app.capture_sources s join app.devices d on d.tenant_id=s.tenant_id and d.id=s.device_id where s.tenant_id=${tenant}::uuid and s.id=${q.source_id}::uuid and s.active and d.active and s.generation=${q.source_generation} for share of s,d`;
    if(!scope) throw new ApiFault('NOT_FOUND');
    const [latest]=await tx`select id from app.document_revisions where tenant_id=${tenant}::uuid and document_id=${q.document_id}::uuid order by revision_number desc limit 1`;
    if(Number(q.version)!==b.version||q.source_hash!==b.source_hash||latest?.id!==q.revision_id) throw new ApiFault('VERSION_CONFLICT',Number(q.version));
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:attribution:${q.evidence_id}`},0))`;
    const [attribution]=await tx`select version from app.evidence_attributions where tenant_id=${tenant}::uuid and evidence_index_id=${q.evidence_id}::uuid for update`;
    const attributionVersion=Number(attribution?.version??1);
    if(attributionVersion!==b.attribution_version)throw new ApiFault('VERSION_CONFLICT',attributionVersion);
    if(b.project_id && !(await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${b.project_id}::uuid`).length) throw new ApiFault('NOT_FOUND');
    const [decision]=await tx`insert into app.decisions(tenant_id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash)
     values(${tenant}::uuid,${actor.userId}::uuid,'project_attribution',${b.choice},${tx.array([String(q.evidence_id)],2950)},${tx.array([attributionVersion],20)},${tx.array([String(q.evidence_id)],2950)},'현장 질문에 대한 답변',${hash(b)}) returning id`;
    if(b.choice==='project'||b.choice==='cancel'){
     const [projected]=await tx`insert into app.evidence_attributions(tenant_id,evidence_index_id,project_id,state,version,decision_id)
      values(${tenant}::uuid,${q.evidence_id}::uuid,${b.project_id}::uuid,${b.choice==='project'?'confirmed':'rejected'},${attributionVersion+1},${decision?.id}::uuid)
      on conflict(tenant_id,evidence_index_id) do update set project_id=excluded.project_id,bundle_id=null,state=excluded.state,version=excluded.version,decision_id=excluded.decision_id,updated_at=now()
      where app.evidence_attributions.version=${attributionVersion} returning version`;
     if(!projected)throw new ApiFault('VERSION_CONFLICT');
    }
    const resolved=b.choice==='project';
    await tx`update app.exception_cases set state=${resolved?'resolved':b.choice==='cancel'?'reopened':'deferred'},version=version+1,
     next_review_at=${resolved||b.choice==='cancel'?null:new Date(Date.now()+86400000)},updated_at=now() where tenant_id=${tenant}::uuid and id=${id.data}::uuid`;
    await tx`update app.field_questions set answer=${tx.json(b)},answered_by=${actor.userId}::uuid,actor_kind=${b.actor},updated_at=now() where tenant_id=${tenant}::uuid and id=${id.data}::uuid`;
    await tx`insert into app.exception_events(tenant_id,exception_id,actor_id,kind,decision_id,reason) values(${tenant}::uuid,${id.data}::uuid,${actor.userId}::uuid,'decision',${decision?.id}::uuid,'현장 답변 저장; 금액과 입금은 별도 확인')`;
    return {status:200,body:{saved:true,version:b.version+1,decision_id:decision?.id,project_id:b.project_id,money_confirmed:false}};
   });
  });
 }));
 app.post('/v1/field/events',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=z.object({device_id:uid,events:z.array(event).max(50)}).strict().safeParse(req.body);
  if(!p.success)throw new ApiFault('INVALID_CONTRACT');const b=p.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   await membership(tx,tenant,actor.userId);
   if(!(await tx`select id from app.devices where tenant_id=${tenant}::uuid and id=${b.device_id}::uuid and user_id=${actor.userId}::uuid and active`).length)throw new ApiFault('NOT_FOUND');
   for(const e of b.events) await tx`insert into app.field_events(tenant_id,event_id,user_id,device_id,session_id,task_id,document_id,operation_id,actor,client_time,device_sequence,app_version,screen_id,control_id,result_code,active_ms,latency_ms,consent_version)
    values(${tenant}::uuid,${e.event_id}::uuid,${actor.userId}::uuid,${b.device_id}::uuid,${e.session_id}::uuid,${e.task_id}::uuid,${e.document_id}::uuid,${e.operation_id}::uuid,${e.actor},${e.client_time},${e.device_sequence},${e.app_version},${e.screen_id},${e.control_id},${e.result_code},${e.active_ms},${e.latency_ms},1) on conflict(tenant_id,event_id) do nothing`;
   return {status:200,body:{ack:b.events.map(e=>e.event_id)}};
  });
 }));
 app.get<{Querystring:{from?:string;to?:string}}>('/v1/admin/field',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services);
  const p=z.object({from:z.iso.date(),to:z.iso.date()}).safeParse(req.query);
  if(!p.success||p.data.from>p.data.to||Date.parse(p.data.to)-Date.parse(p.data.from)>90*86400000)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!(await tx`select user_id from app.field_operators where user_id=${actor.userId}::uuid and active`).length)throw new ApiFault('NOT_FOUND');
   await tx`insert into app.field_operator_access(user_id,action) values(${actor.userId}::uuid,'field_metrics_read')`;
   const allRows=await tx`select e.event_id,e.tenant_id,e.user_id,e.task_id,e.document_id,e.actor,e.client_time,e.received_at,e.screen_id,e.control_id,e.result_code,e.active_ms,e.latency_ms,e.app_version
    from app.field_events e join app.field_observation_grants g on g.tenant_id=e.tenant_id and g.operator_id=${actor.userId}::uuid and g.active
    where e.received_at>=${`${p.data.from}T00:00:00+09:00`}::timestamptz and e.received_at<${`${p.data.to}T00:00:00+09:00`}::timestamptz+interval '1 day'
    order by e.received_at limit 10001`;
   const rows=allRows.slice(0,10000);
   return {status:200,body:{events:rows,truncated:allRows.length>10000,generated_at:new Date().toISOString(),period:p.data,
    human_events:rows.filter(e=>e.actor==='human').length||null,active_ms:rows.some(e=>e.actor==='human'&&Number(e.active_ms)>0)?rows.filter(e=>e.actor==='human').reduce((s,e)=>s+Number(e.active_ms),0):null,
    task_completed:null,interpretation:'60초 무동작 제외 활동시간 근사치. 앱 밖 노동시간을 뜻하지 않습니다.'}};
  });
 }));
}
