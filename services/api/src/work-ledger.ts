import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {BusinessEventSchema} from '@sigongnote/domain';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from './routes.js';
import {readIssuedDocument} from './document-issuance.js';
import {readDraft} from './document-drafts.js';

const category=z.enum(['agreement','drawing_material','delivery_work','billing_payment','inspection_defect']);
const cursorSchema=z.tuple([z.iso.datetime(),z.uuid()]);
const query=z.strictObject({project_id:z.uuid().optional(),category:category.optional(),cursor:z.string().max(200).optional()});
const iso=(value:unknown)=>new Date(value as string).toISOString();
function cursor(value:string|undefined){if(!value)return null;try{return cursorSchema.parse(JSON.parse(Buffer.from(value,'base64url').toString('utf8')));}catch{throw new ApiFault('INVALID_CONTRACT');}}

async function visibleSources(tx:Tx,tenant:string,context:string){
 return tx`select r.id,r.created_at,r.parse_state,o.categories,left(coalesce((select p.output->'spans'->0->>'text' from app.parse_results p where p.tenant_id=r.tenant_id and p.revision_id=r.id order by p.created_at desc limit 1),'업무자료'),160) title
 from app.evidence_organizations o join app.document_revisions r on r.tenant_id=o.tenant_id and r.id=o.revision_id
 where o.tenant_id=${tenant}::uuid and o.context_id=${context}::uuid and o.state='linked' and not r.generated_output and app.revision_accessible(r.tenant_id,r.id)
 and not exists(select 1 from app.document_revisions newer where newer.tenant_id=r.tenant_id and newer.document_id=r.document_id and newer.revision_number>r.revision_number)
 order by r.created_at desc,r.id desc limit 101`;
}

export function registerWorkLedger(app:FastifyInstance,services:Services){
 app.get('/v1/work/ledger',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),parsed=query.safeParse(req.query);if(!parsed.success)throw new ApiFault('INVALID_CONTRACT');const q=parsed.data,after=cursor(q.cursor);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');
   const rows=await tx`with live as (
    select o.context_id,date_trunc('milliseconds',max(r.created_at)) updated_at,array_agg(distinct tag) filter(where tag is not null) categories,count(distinct r.id)::int evidence_count
    from app.evidence_organizations o join app.document_revisions r on r.tenant_id=o.tenant_id and r.id=o.revision_id left join lateral unnest(o.categories) tag on true
    where o.tenant_id=${tenant}::uuid and o.state='linked' and o.context_id is not null and not r.generated_output and app.revision_accessible(r.tenant_id,r.id)
    and not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number) group by o.context_id)
    select w.id,w.label,w.project_id,p.display_name project_name,l.updated_at,coalesce(l.categories,'{}') categories,l.evidence_count
    from live l join app.work_contexts w on w.tenant_id=${tenant}::uuid and w.id=l.context_id join app.projects p on p.tenant_id=w.tenant_id and p.id=w.project_id
    where (${q.project_id??null}::uuid is null or w.project_id=${q.project_id??null}::uuid) and (${q.category??null}::text is null or ${q.category??null}::text=any(l.categories))
    and (${after?.[0]??null}::timestamptz is null or (l.updated_at,w.id)<(${after?.[0]??null}::timestamptz,${after?.[1]??null}::uuid))
    order by l.updated_at desc,w.id desc limit 41`;
   const page=rows.slice(0,40),last=page.at(-1);reply.header('Cache-Control','no-store');
   return {status:200,body:{items:page.map(r=>({...r,updated_at:iso(r.updated_at)})),next_cursor:rows.length>40&&last?Buffer.from(JSON.stringify([iso(last.updated_at),last.id])).toString('base64url'):null}};
  });
 }));
 app.get<{Params:{id:string}}>('/v1/work/ledger/:id',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id),q=z.strictObject({cursor:z.uuid().optional()}).safeParse(req.query);if(!id.success||!q.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');
   const [work]=await tx`select w.id,w.label,w.project_id,w.bundle_id,p.display_name project_name from app.work_contexts w join app.projects p on p.tenant_id=w.tenant_id and p.id=w.project_id where w.tenant_id=${tenant}::uuid and w.id=${id.data}::uuid`;
   const sources=work?await visibleSources(tx,tenant,id.data):[];if(!work||!sources.length)throw new ApiFault('NOT_FOUND');
   const [snapshot]=await tx`select app.read_business_work(${tenant}::uuid,${id.data}::uuid,${tx.json(services.capturePolicy??{})}) value`;
   const all=z.array(BusinessEventSchema).parse(snapshot?.value?.events??[]);
   const ordered=all.sort((a,b)=>Date.parse(b.effectiveAt??b.recordedAt)-Date.parse(a.effectiveAt??a.recordedAt)||b.sequence-a.sequence);
   const anchor=q.data.cursor?ordered.findIndex(e=>e.id===q.data.cursor):-1;if(q.data.cursor&&anchor<0)throw new ApiFault('INVALID_CONTRACT');
   const page=ordered.slice(anchor+1,anchor+101),next=ordered.length>anchor+101?page.at(-1)?.id??null:null;
   const events=page.map(e=>({
    id:e.id,kind:e.kind,mode:e.mode,asserted:e.asserted,occurred_at:e.effectiveAt,recorded_at:e.recordedAt,withdrawn:e.evidenceWithdrawn,
    subject:e.evidenceWithdrawn?null:e.subject,quantity:e.evidenceWithdrawn?null:e.quantity,amount:e.evidenceWithdrawn?null:e.amount,
    evidence_ids:e.evidenceWithdrawn?[]:[...new Set(e.evidenceIds.map(x=>x.split(':')[0]).filter(x=>sources.some(s=>s.id===x)))],
    supersedes:e.supersedes,reverses:e.reverses,
   }));
   const documents=[];
   const issued=await tx`select distinct b.document_id from app.business_document_revisions b join app.document_drafts d on d.tenant_id=b.tenant_id and d.id=b.draft_id where d.tenant_id=${tenant}::uuid and (coalesce(d.internal_snapshot->'overrides'->>'context_id',d.internal_snapshot->>'scope')=${id.data} or (d.internal_snapshot->'overrides'->>'context_id' is null and d.internal_snapshot->>'scope'=${work.bundle_id??null}::text)) limit 21`;
   for(const row of issued.slice(0,20)){try{const d=await readIssuedDocument(tx,tenant,String(row.document_id));documents.push({id:d.id,type:d.document.type,number:d.document.document_number,state:d.state});}catch(e){if(!(e instanceof ApiFault)||e.code!=='NOT_FOUND')throw e;}}
   const pending=await tx`select r.draft_id from app.document_readiness r where r.tenant_id=${tenant}::uuid and r.context_id=${id.data}::uuid limit 21`;
   const drafts=[];for(const row of pending.slice(0,20)){try{const d=await readDraft(tx,tenant,String(row.draft_id));if(!d.stale&&d.latest_id===d.id&&!(await tx`select 1 from app.business_document_revisions b where b.tenant_id=${tenant}::uuid and b.draft_id=${d.id}::uuid`).length)drafts.push({id:d.id,type:d.document.type});}catch(e){if(!(e instanceof ApiFault)||e.code!=='NOT_FOUND')throw e;}}
   reply.header('Cache-Control','no-store');return {status:200,body:{...work,events,evidence:sources.slice(0,100).map(s=>({...s,created_at:iso(s.created_at)})),documents,drafts,next_cursor:next,partial:sources.length>100||issued.length>20||pending.length>20,approval_confirmed:false,payment_executed:false}};
  });
 }));
 app.get('/v1/work/agenda',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');
   const [clock]=await tx`select (now() at time zone 'Asia/Seoul')::date::text today`;
   // Only an explicit applied schedule with still-accessible decision evidence is a confirmed due date.
   const rows=await tx`select w.id,w.label,w.project_id,p.display_name project_name,x.state->>'schedule' due_date from app.work_projections x
    join app.work_contexts w on w.tenant_id=x.tenant_id and w.id=x.context_id join app.projects p on p.tenant_id=w.tenant_id and p.id=w.project_id join app.decisions d on d.tenant_id=x.tenant_id and d.id=x.decision_id
    where x.tenant_id=${tenant}::uuid and x.state->>'schedule' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and x.state->>'schedule' <= ((now() at time zone 'Asia/Seoul')::date+1)::text
    and cardinality(d.evidence_ids)>0 and not exists(select 1 from unnest(d.evidence_ids) ref where not exists(select 1 from app.evidence_index e join app.document_revisions r on r.tenant_id=e.tenant_id and r.id=e.revision_id where e.tenant_id=d.tenant_id and e.id=ref and app.revision_accessible(r.tenant_id,r.id) and not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number)))
    order by case when x.state->>'schedule' >= ${clock!.today} then 0 else 1 end,
      case when x.state->>'schedule' >= ${clock!.today} then x.state->>'schedule' end asc,
      case when x.state->>'schedule' < ${clock!.today} then x.state->>'schedule' end desc,w.id limit 41`;
   const items=rows.slice(0,40).filter(r=>z.iso.date().safeParse(r.due_date).success);reply.header('Cache-Control','no-store');
   return {status:200,body:{today:clock!.today,items,partial:rows.length>40,basis:'confirmed_schedule'}};
  });
 }));
}
