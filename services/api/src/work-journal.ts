import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from './routes.js';

const query=z.strictObject({project_id:z.uuid().optional(),category:z.enum(['agreement','drawing_material','delivery_work','billing_payment','inspection_defect']).optional(),q:z.iso.date().optional(),cursor:z.uuid().optional()});
/** The capture receipt exists before interpretation or work-context resolution. */
export function registerWorkJournal(app:FastifyInstance,services:Services){
 app.get('/v1/work/journal',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),parsed=query.safeParse(req.query);
  if(!parsed.success)throw new ApiFault('INVALID_CONTRACT');const q=parsed.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');
   const rows=await tx`with receipts as (select r.id,r.document_id,r.revision_number,r.created_at received_at,r.declared_mime,b.sha256,i.client_capture_id,s.device_id capture_device_id,null::text file_name,
    coalesce(p.output->>'status',r.parse_state) parse_status,p.output->'issues' issues,
    p.output->'coverage'->>'occurred_at' occurred_at,
    s.kind source_kind,case when o.revision_id is not null then o.project_id else fb.project_id end project_id,pr.display_name project_name,
    coalesce(o.categories,'{}') categories,o.context_id,o.state organization_state,o.version::int organization_version,
    coalesce(x.text,'') excerpt,coalesce(x.count,0)::int readable_spans,
    coalesce(f.items,'[]') observations,app.audio_progress(r.tenant_id,r.id) audio
    from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
    left join lateral(select output from app.parse_results where tenant_id=r.tenant_id and revision_id=r.id order by created_at desc limit 1)p on true
    left join lateral(select string_agg(v->>'text',E'\n' order by n) filter(where n<=8) text,count(*) count from jsonb_array_elements(coalesce(p.output->'spans','[]')) with ordinality a(v,n) where length(trim(v->>'text'))>0)x on true
    left join lateral(select source_id,source_generation,client_capture_id from app.upload_intents where tenant_id=r.tenant_id and completed_revision_id=r.id order by created_at limit 1)i on true
    left join app.capture_sources s on s.tenant_id=r.tenant_id and s.id=i.source_id
    left join app.site_folder_bindings fb on fb.tenant_id=s.tenant_id and fb.source_id=s.id and fb.source_generation=i.source_generation
    left join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id
    left join app.projects pr on pr.tenant_id=r.tenant_id and pr.id=case when o.revision_id is not null then o.project_id else fb.project_id end
    left join lateral(select jsonb_agg(jsonb_build_object('id',id,'kind',assertion_kind,'text',source_text,'locator',locator)) items from (select id,assertion_kind,source_text,locator from app.fact_candidates where tenant_id=r.tenant_id and source_revision=r.id and status<>'rejected' order by span_id,extraction_key limit 12)c)f on true
    where r.tenant_id=${tenant}::uuid and not exists(select 1 from app.jobs a where a.tenant_id=r.tenant_id and a.evidence_revision_id=r.id and a.work_lane='archive') and not r.generated_output and app.revision_accessible(r.tenant_id,r.id)
    and r.declared_mime not in ('image/vnd.dwg','image/x-dwg','application/acad','application/dxf','image/vnd.dxf')
    and not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number)
    union all
    select s.id,s.id,1,a.created_at,'application/pdf',a.sha256,null::uuid,null::uuid,(s.snapshot->>'title')||'.pdf','complete','[]'::jsonb,null::text,
      'photo_sheet',(s.snapshot->>'project_id')::uuid,s.snapshot->>'project_name',
      array['delivery_work']::text[],(s.snapshot->>'context_id')::uuid,'linked',1,
      s.snapshot->>'title',1,'[]'::jsonb,null::jsonb
    from app.photo_sheets s join app.photo_sheet_artifacts a on a.tenant_id=s.tenant_id and a.sheet_id=s.id
    where s.tenant_id=${tenant}::uuid and not exists(
      select 1 from jsonb_array_elements(s.snapshot->'photos') photo
      where not app.revision_accessible(s.tenant_id,(photo->>'revision_id')::uuid)
      or not exists(select 1 from app.document_revisions r
        join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
        left join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id
        where r.tenant_id=s.tenant_id and r.id=(photo->>'revision_id')::uuid
        and b.sha256=photo->>'sha256'
        and (o.project_id is null or o.project_id=(s.snapshot->>'project_id')::uuid)
        and (s.snapshot->>'context_id' is null or o.context_id is null or o.context_id=(s.snapshot->>'context_id')::uuid)))
    union all
    select l.id,l.id,l.local_revision,l.received_at,l.mime,l.sha256,l.native_capture_id,l.device_id,l.file_name,case when l.excerpt='' then 'pending' else 'complete' end,'[]'::jsonb,null::text,
      'local_file',l.project_id,p.display_name,l.categories,null::uuid,case when l.project_id is null then 'unassigned' else 'linked' end,l.version::int,
      l.file_name||E'\n'||l.excerpt,case when l.excerpt='' then 0 else 1 end,'[]'::jsonb,null::jsonb
    from app.local_journal_entries l left join app.projects p on p.tenant_id=l.tenant_id and p.id=l.project_id
    where l.tenant_id=${tenant}::uuid and app.local_native_revision_for_read(l.tenant_id,l.id) is null
    ) select * from receipts
    where (${q.project_id??null}::uuid is null or project_id=${q.project_id??null}::uuid)
    and (${q.category??null}::text is null or ${q.category??null}::text=any(categories))
    and (${q.q??null}::date is null or (received_at at time zone 'Asia/Seoul')::date=${q.q??null}::date)
    and (${q.cursor??null}::uuid is null or (received_at,id)<(select received_at,id from receipts where id=${q.cursor??null}::uuid))
    order by received_at desc,id desc limit 31`;
   reply.header('Cache-Control','no-store');
   return {status:200,body:{items:rows.slice(0,30).map(r=>({...r,excerpt:String(r.excerpt).slice(0,1600),received_at:new Date(r.received_at).toISOString(),revision_number:Number(r.revision_number),reading_state:r.readable_spans>0?'readable':['pending','queued','processing'].includes(r.parse_status)?'waiting':'unreadable'})),next_cursor:rows.length>30?rows[29]!.id:null,date_basis:'received_at'}};
  });
 }));
}
