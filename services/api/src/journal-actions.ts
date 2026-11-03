import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
import {prepareDocument,readDraft} from './document-drafts.js';
import {readWorkEvents,readWorkEventDetail} from './context-restore.js';
import {captureContextCorrection} from './context-learning.js';

const command=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('task'),id:z.uuid(),client_command_id:z.uuid(),expected_version:z.number().int().nonnegative(),done:z.boolean()}),
 z.strictObject({action:z.literal('event'),id:z.uuid(),client_command_id:z.uuid(),expected_version:z.number().int().positive(),project_id:z.uuid().nullable(),summary:z.string().trim().min(1).max(400),reason:z.string().trim().min(1).max(1000)}),
 z.strictObject({action:z.literal('draft'),id:z.uuid(),client_command_id:z.uuid(),expected_version:z.number().int().positive(),project_id:z.uuid(),type:z.enum(['estimate','purchase_order','invoice','delivery_statement'])})
]);
export function registerJournalActions(app:FastifyInstance,services:Services){
 app.get<{Params:{id:string}}>('/v1/work/events/:id',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id);if(!id.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');const result=await readWorkEventDetail(tx,tenant,id.data);if(!result)throw new ApiFault('NOT_FOUND');return {status:200,body:result};});
 }));
 app.get('/v1/work/events',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),q=z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(30),project_id:z.uuid().optional()}).safeParse(req.query);if(!q.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');const rows=await tx`select id from app.work_events where tenant_id=${tenant}::uuid and app.work_event_readable(tenant_id,id) and (${q.data.project_id??null}::uuid is null or project_id=${q.data.project_id??null}::uuid) order by created_at desc,id desc limit ${q.data.limit}`;const items=[];for(const row of rows){const detail=await readWorkEventDetail(tx,tenant,String(row.id));if(detail)items.push(detail);}return {status:200,body:{items,next_cursor:null}};});
 }));
 app.get('/v1/work/journal/tasks',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');
   const rows=await tx`select f.id,f.source_revision revision_id,f.source_text text,f.assertion_kind kind,f.effective_at,
    o.project_id,p.display_name project_name,coalesce(m.done,false) done,coalesce(m.version,0)::int version,r.created_at received_at
    from app.fact_candidates f join app.evidence_organizations o on o.tenant_id=f.tenant_id and o.revision_id=f.source_revision
    join app.document_revisions r on r.tenant_id=f.tenant_id and r.id=f.source_revision
    left join app.projects p on p.tenant_id=o.tenant_id and p.id=o.project_id
    left join app.journal_task_marks m on m.tenant_id=f.tenant_id and m.fact_id=f.id and m.user_id=${actor.userId}::uuid
    where f.tenant_id=${tenant}::uuid and f.assertion_kind in ('request','plan') and f.status<>'rejected'
    and not exists(select 1 from app.work_event_sources context where context.tenant_id=f.tenant_id and context.source_kind='revision' and context.source_ref=f.source_revision and context.state='done')
    and not exists(select 1 from app.jobs a where a.tenant_id=f.tenant_id and a.evidence_revision_id=f.source_revision and a.work_lane='archive')
    and app.revision_accessible(f.tenant_id,f.source_revision)
    and not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number)
    order by coalesce(m.done,false),r.created_at desc,f.id limit 101`;
   // Context-restored follow-ups join the same checklist. revision_id points at the fragment the event came from.
   const followups=await tx`select f.id,e.source_ref revision_id,e.source_kind,f.title text,'followup'::text kind,f.due_on effective_at,e.project_id,p.display_name project_name,f.state='done' done,f.version::int version,f.created_at received_at,e.id event_id,e.summary event_summary,e.missing,e.confidence
    from app.work_followups f join app.work_events e on e.tenant_id=f.tenant_id and e.id=f.event_id left join app.projects p on p.tenant_id=e.tenant_id and p.id=e.project_id
    where f.tenant_id=${tenant}::uuid and f.state<>'dismissed' and e.status in ('open','resolved') and app.work_event_readable(e.tenant_id,e.id) order by (f.state='done'),f.created_at desc,f.id limit 101`;
   const events=await readWorkEvents(tx,tenant,null,20);
   return {status:200,body:{items:[...followups.slice(0,100),...rows.slice(0,100)],partial:rows.length>100||followups.length>100,events}};
  });
 }));
 app.post('/v1/work/journal/commands',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),parsed=command.safeParse(req.body);
  if(!parsed.success)throw new ApiFault('INVALID_CONTRACT');const c=parsed.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   const role=await membership(tx,tenant,actor.userId);if(!['owner','operator'].includes(role)||(c.action==='draft'&&role!=='owner'))throw new ApiFault('NOT_FOUND');
   if(c.action==='event')return once(tx,tenant,actor.userId,'journal.command',c.client_command_id,createHash('sha256').update(JSON.stringify(c)).digest('hex'),async()=>{
    const [saved]=await tx`select app.correct_work_event(${tenant}::uuid,${c.id}::uuid,${c.expected_version}::bigint,${c.project_id}::uuid,${c.summary},${c.reason}) value`;
    if(!saved?.value)throw new ApiFault('NOT_FOUND');if(saved.value.conflict)throw new ApiFault('VERSION_CONFLICT',Number(saved.value.version));
    if(saved.value.correction_id)await captureContextCorrection(tx,tenant,actor.userId,String(saved.value.correction_id));
    const detail=await readWorkEventDetail(tx,tenant,c.id);return {status:200,body:{event:detail?.event}};
   });
   if(c.action==='task'){
    const [followup]=await tx`select id from app.work_followups where tenant_id=${tenant}::uuid and id=${c.id}::uuid`;
    if(followup)return once(tx,tenant,actor.userId,'journal.command',c.client_command_id,createHash('sha256').update(JSON.stringify(c)).digest('hex'),async()=>{
     const [row]=await tx`select app.mark_work_followup(${tenant}::uuid,${c.id}::uuid,${c.expected_version}::bigint,${c.done}) value`;
     if(!row?.value)throw new ApiFault('NOT_FOUND');if(row.value.conflict)throw new ApiFault('VERSION_CONFLICT',Number(row.value.version));
     return {status:200,body:{done:Boolean(row.value.done),version:Number(row.value.version)}};
    });
   }
   if(c.action==='draft'){
    const [local]=await tx`select id from app.local_journal_entries where tenant_id=${tenant}::uuid and id=${c.id}::uuid and excerpt<>'' and app.local_document_source_readable(tenant_id,id)`;
    if(local){return once(tx,tenant,actor.userId,'journal.command',c.client_command_id,createHash('sha256').update(JSON.stringify(c)).digest('hex'),async()=>{
      const [current]=await tx`select project_id,version from app.local_journal_entries where tenant_id=${tenant}::uuid and id=${c.id}::uuid for update`;if(!current)throw new ApiFault('NOT_FOUND');if(Number(current.version)!==c.expected_version)throw new ApiFault('VERSION_CONFLICT');if(current.project_id&&current.project_id!==c.project_id)throw new ApiFault('NOT_FOUND');
      if(!current.project_id){const [site]=await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${c.project_id}::uuid`;if(!site)throw new ApiFault('NOT_FOUND');await tx`update app.local_journal_entries set project_id=${c.project_id}::uuid,project_origin='manual',version=version+1,updated_at=now() where tenant_id=${tenant}::uuid and id=${c.id}::uuid`;}
      return {status:200,body:await prepareDocument(tx,tenant,actor.userId,c.project_id,c.type,c.client_command_id,{local_source_id:c.id})};
     });
    }
   }
   const [source]=c.action==='task'?await tx`select source_revision id from app.fact_candidates where tenant_id=${tenant}::uuid and id=${c.id}::uuid and assertion_kind in ('request','plan') and status<>'rejected'`: [{id:c.id}];
   if(!source)throw new ApiFault('NOT_FOUND');
   const [current]=await tx`select id from app.document_revisions r where tenant_id=${tenant}::uuid and id=${source.id}::uuid and app.revision_accessible(r.tenant_id,r.id) and not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number)`;
   if(!current)throw new ApiFault('NOT_FOUND');
   return once(tx,tenant,actor.userId,'journal.command',c.client_command_id,createHash('sha256').update(JSON.stringify(c)).digest('hex'),async()=>{
    if(c.action==='draft'){
     const [row]=await tx`select app.journal_document_context(${tenant}::uuid,${c.id}::uuid,${c.project_id}::uuid,${c.expected_version}) id`;
     if(!row?.id)throw new ApiFault('VERSION_CONFLICT');
     await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:document:${c.project_id}`},0))`;
     const [pointer]=await tx`select draft_id from app.document_readiness where tenant_id=${tenant}::uuid and context_id=${row.id}::uuid and document_type=${c.type}`;
     if(pointer){const old=await readDraft(tx,tenant,String(pointer.draft_id));if(!old.stale)return {status:200,body:{id:old.latest_id,type:c.type,state:old.state}};}
     const draft=await prepareDocument(tx,tenant,actor.userId,c.project_id,c.type,c.client_command_id,{context_id:String(row.id)});
     await tx`insert into app.document_readiness(tenant_id,context_id,document_type,draft_id) values(${tenant}::uuid,${row.id}::uuid,${c.type},${draft.id}::uuid) on conflict(tenant_id,context_id,document_type) do update set draft_id=excluded.draft_id,version=app.document_readiness.version+1`;
     return {status:200,body:draft};
    }
    await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':'+actor.userId+':journal-task:'+c.id},0))`;
    const [old]=await tx`select version from app.journal_task_marks where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and fact_id=${c.id}::uuid`;
    if(Number(old?.version??0)!==c.expected_version)throw new ApiFault('VERSION_CONFLICT');
    const [mark]=await tx`insert into app.journal_task_marks(tenant_id,user_id,fact_id,done,version) values(${tenant}::uuid,${actor.userId}::uuid,${c.id}::uuid,${c.done},1) on conflict(tenant_id,user_id,fact_id) do update set done=excluded.done,version=app.journal_task_marks.version+1,updated_at=now() returning done,version::int`;
    return {status:200,body:mark};
   });
  });
 }));
}
