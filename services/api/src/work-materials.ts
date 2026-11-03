import {readBusinessWork} from './business-events.js';
import { z } from "zod";
import {createHash} from 'node:crypto';
import {readLocalJournal} from './local-journal-sync.js';
import {MESSAGE_MIME,MESSAGE_MAX_BYTES,readMessageBundle} from './message-bundle.js';
import type { FastifyInstance } from "fastify";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, membership, principal, tenantHeader, type Services } from "./routes.js";
const querySchema=z.strictObject({q:z.string().trim().max(80).default(""),cursor:z.uuid().optional(),project_id:z.uuid().optional(),category:z.enum(["agreement","drawing_material","delivery_work","billing_payment","inspection_defect"]).optional()});
export function registerWorkMaterialRoutes(app:FastifyInstance,services:Services){
 app.get<{Params:{id:string}}>('/v1/work/materials/:id/message',async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request),id=z.uuid().safeParse(request.params.id);
  if(!id.success)throw new ApiFault('INVALID_CONTRACT');
  const lookup=()=>inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');
   const [row]=await tx`select b.storage_key,b.sha256,b.byte_length,s.kind source_kind from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id join app.upload_intents i on i.tenant_id=r.tenant_id and i.completed_revision_id=r.id join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id where r.tenant_id=${tenant}::uuid and r.id=${id.data}::uuid and r.declared_mime=${MESSAGE_MIME} and s.kind in ('sms','manual_share') and app.revision_accessible(r.tenant_id,r.id)`;
   if(!row||Number(row.byte_length)>MESSAGE_MAX_BYTES)throw new ApiFault('NOT_FOUND');return {status:200,body:row};
  });
  const found=await lookup();if(!found)throw new ApiFault('NOT_FOUND');const blob=found.body as {storage_key:string;sha256:string;byte_length:number;source_kind:string};if(!services.storage?.readBytes)throw new ApiFault('TEMPORARILY_UNAVAILABLE');
  const bytes=await services.storage.readBytes(String(blob.storage_key),MESSAGE_MAX_BYTES);
  if(bytes.length!==Number(blob.byte_length)||createHash('sha256').update(bytes).digest('hex')!==blob.sha256)throw new ApiFault('TEMPORARILY_UNAVAILABLE');
  const message=readMessageBundle(bytes);if(!await lookup())throw new ApiFault('NOT_FOUND');
  reply.header('Cache-Control','no-store');return {status:200,body:{...message,source_kind:blob.source_kind}};
 }));
 app.post('/v1/work/audio/corrections',async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request);
  const p=z.strictObject({revision_id:z.uuid(),client_command_id:z.uuid(),locator:z.string().regex(/^audio:\d+-\d+(?::\d+)?$/),text:z.string().trim().min(1).max(1000),expected_id:z.uuid().nullable()}).safeParse(request.body);
  if(!p.success)throw new ApiFault('INVALID_CONTRACT');const v=p.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');
   await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':'+v.revision_id},11))`;
   const [r]=await tx`select id from app.document_revisions where tenant_id=${tenant}::uuid and id=${v.revision_id}::uuid and app.revision_accessible(tenant_id,id)`;
   if(!r)throw new ApiFault('NOT_FOUND');
   const [old]=await tx`select * from app.audio_corrections where tenant_id=${tenant}::uuid and command_id=${v.client_command_id}::uuid`;
   if(old){if(old.revision_id!==v.revision_id||old.locator!==v.locator||old.text!==v.text)throw new ApiFault('IDEMPOTENCY_CONFLICT');return {status:200,body:{saved:true,money_confirmed:false}};}
   const [span]=await tx`select 1 from app.evidence_chunks c join app.evidence_chunk_indexes i on i.tenant_id=c.tenant_id and i.job_id=c.job_id where c.tenant_id=${tenant}::uuid and c.revision_id=${v.revision_id}::uuid and c.locator=${v.locator} and i.published limit 1`;
   if(!span)throw new ApiFault('NOT_FOUND');
   const [latest]=await tx`select command_id from app.audio_corrections where tenant_id=${tenant}::uuid and revision_id=${v.revision_id}::uuid and locator=${v.locator} order by created_at desc,command_id desc limit 1`;
   if((latest?.command_id??null)!==v.expected_id)throw new ApiFault('VERSION_CONFLICT');
   await tx`insert into app.audio_corrections(tenant_id,revision_id,command_id,locator,text,actor_id) values(${tenant}::uuid,${v.revision_id}::uuid,${v.client_command_id}::uuid,${v.locator},${v.text},${actor.userId}::uuid)`;
   const [indexed]=await tx`select app.reindex_audio_correction(${tenant}::uuid,${v.revision_id}::uuid,${v.client_command_id}::uuid) job`;
   if(!indexed?.job)throw new ApiFault('VERSION_CONFLICT');
   return {status:200,body:{saved:true,money_confirmed:false}};
  });
 }));
 app.get("/v1/work/materials",async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request),parsed=querySchema.safeParse(request.query);
  if(!parsed.success)throw new ApiFault("INVALID_CONTRACT");
   const {q,cursor,category,project_id}=parsed.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==="viewer")throw new ApiFault("NOT_FOUND");
   const rows=await tx`with material_rows as (select r.id,r.document_id,r.revision_number,r.declared_mime,r.created_at,
    coalesce(p.output->>'status',r.parse_state) status,j.state job_state,app.audio_progress(r.tenant_id,r.id) audio,
    left(coalesce(p.output->'spans'->0->>'text','새 자료'),100) title,
    p.processor_version, p.created_at processed_at,
    (select count(*)::int from jsonb_array_elements(coalesce(p.output->'spans','[]')) v where length(trim(v->>'text'))>0) readable_spans,
    b.sha256, b.byte_length,
    pr.display_name project_name,o.categories,o.state organization_state,o.version organization_version,
    o.project_id,o.context_id,w.label work_label,o.source_root_id,
    (select s.text from (select text from app.revision_search_spans(r.tenant_id,r.id) union all select '고친 내용: '||c.text from (select distinct on(locator) locator,text from app.audio_corrections where tenant_id=r.tenant_id and revision_id=r.id order by locator,created_at desc,command_id desc)c) s where ${q}<>'' and position(lower(${q}) in lower(s.text))>0 limit 1) matched_text
    from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
    left join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id
    left join app.projects pr on pr.tenant_id=o.tenant_id and pr.id=o.project_id
    left join app.work_contexts w on w.tenant_id=o.tenant_id and w.id=o.context_id
    left join lateral(select * from app.parse_results pr where pr.tenant_id=r.tenant_id and pr.revision_id=r.id order by pr.created_at desc limit 1)p on true
    left join lateral(select state from app.jobs jj where jj.tenant_id=r.tenant_id and jj.evidence_revision_id=r.id order by jj.created_at desc limit 1)j on true
     where r.tenant_id=${tenant}::uuid and not r.generated_output and not exists(select 1 from app.document_revisions newer where newer.tenant_id=r.tenant_id and newer.document_id=r.document_id and newer.revision_number>r.revision_number) and app.revision_accessible(r.tenant_id,r.id)
     and (${project_id??null}::uuid is null or o.project_id=${project_id??null}::uuid)
    and (${category??null}::text is null or ${category??null}=any(o.categories))
    and (${q}='' or exists(select 1 from (select text from app.revision_search_spans(r.tenant_id,r.id) union all select c.text from (select distinct on(locator) locator,text from app.audio_corrections where tenant_id=r.tenant_id and revision_id=r.id order by locator,created_at desc,command_id desc)c) s where position(lower(${q}) in lower(s.text))>0))
    union all
    select l.id,l.id,l.local_revision,l.mime,l.received_at,case when l.excerpt='' then 'pending' else 'complete' end,null::text,null::jsonb,l.file_name,
    'desktop-local',l.updated_at,case when l.excerpt='' then 0 else 1 end,l.sha256,0::bigint,p.display_name,l.categories,
    case when l.project_id is null then 'unassigned' else 'linked' end,l.version,l.project_id,null::uuid,null::text,null::uuid,l.excerpt
    from app.local_journal_entries l left join app.projects p on p.tenant_id=l.tenant_id and p.id=l.project_id
    where l.tenant_id=${tenant}::uuid and app.local_native_revision_for_read(l.tenant_id,l.id) is null and (${project_id??null}::uuid is null or l.project_id=${project_id??null}::uuid)
    and (${category??null}::text is null or ${category??null}=any(l.categories))
    and (${q}='' or position(lower(${q}) in lower(l.file_name||' '||l.excerpt))>0)
    ) select * from material_rows where (${cursor??null}::uuid is null or (created_at,id)<(select created_at,id from material_rows where id=${cursor??null}::uuid))
    order by created_at desc,id desc limit 31`;
   return {status:200,body:{materials:rows.slice(0,30).map(r=>({...r,revision_number:Number(r.revision_number)})),next_cursor:rows.length>30?rows[29]!.id:null}};
  });
 }));
 app.get<{Params:{id:string}}>("/v1/work/materials/:id",async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request),id=z.uuid().safeParse(request.params.id);
  if(!id.success)throw new ApiFault("INVALID_CONTRACT");
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==="viewer")throw new ApiFault("NOT_FOUND");
   const [revision]=await tx`select r.id,r.document_id,r.revision_number,r.predecessor_id,r.parse_state status,r.created_at,r.declared_mime,exists(select 1 from app.jobs j where j.tenant_id=r.tenant_id and j.evidence_revision_id=r.id and j.work_lane='archive') archived,(select n.id from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and app.revision_accessible(n.tenant_id,n.id) order by n.revision_number desc limit 1) latest_revision_id from app.document_revisions r where r.tenant_id=${tenant}::uuid and r.id=${id.data}::uuid and app.revision_accessible(r.tenant_id,r.id)`;
   if(!revision){const local=await readLocalJournal(tx,tenant,id.data);if(!local)throw new ApiFault('NOT_FOUND');return {status:200,body:{local_record:true,observed_work:null,revision:{id:local.id,document_id:local.id,revision_number:local.revision_number,status:local.parse_status,created_at:local.received_at,declared_mime:local.declared_mime,latest_revision_id:local.id,archived:false,original_available:false},result:{processor_version:'desktop-local',created_at:local.received_at,output:{status:local.parse_status,spans:[{locator:'local:1',text:local.excerpt||local.file_name}],issues:[]}},organization:{revision_id:local.id,project_id:local.project_id,project_name:local.project_name,categories:local.categories,version:local.organization_version,state:local.organization_state,context_id:null},facts:[],audio:null,corrections:[],entity_links:null}};}
   const [result]=await tx`select output,processor_version,created_at from app.parse_results where tenant_id=${tenant}::uuid and revision_id=${id.data}::uuid order by created_at desc limit 1`;
   const [organization]=await tx`select o.*,w.label work_label from app.evidence_organizations o left join app.work_contexts w on w.tenant_id=o.tenant_id and w.id=o.context_id where o.tenant_id=${tenant}::uuid and o.revision_id=${id.data}::uuid`;
   const facts=await tx`select id,span_id,locator,source_text,assertion_kind,status,semantic from app.fact_candidates where tenant_id=${tenant}::uuid and source_revision=${id.data}::uuid order by span_id,extraction_key limit 1000`;
   const [audio]=await tx`select app.audio_progress(${tenant}::uuid,${id.data}::uuid) progress`;
   const corrections=await tx`select distinct on(locator) command_id,locator,text,created_at from app.audio_corrections where tenant_id=${tenant}::uuid and revision_id=${id.data}::uuid order by locator,created_at desc,command_id desc`;
   const [entities]=await tx`select app.read_entity_links(${tenant}::uuid,${id.data}::uuid,${tx.json(services.capturePolicy??{})}) result`;
   const observed_work=organization?.context_id?await readBusinessWork(tx,tenant,organization.context_id,services.capturePolicy):null;
   return {status:200,body:{observed_work,revision:{...revision,revision_number:Number(revision.revision_number)},result:result??null,organization:organization??null,facts,audio:audio?.progress??null,corrections,entity_links:entities?.result??null}};
  });
 }));
}
