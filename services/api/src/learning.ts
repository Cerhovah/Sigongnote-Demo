import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
import {workHash} from './work-decisions.js';
const reviewState=z.enum(['confirmed','correction','new_fact','excluded']);
const command=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('consent'),command_id:z.uuid(),allowed:z.boolean(),purpose:z.literal('company-improvement-v1')}),
 z.strictObject({action:z.literal('review'),command_id:z.uuid(),id:z.uuid(),version:z.number().int().positive(),state:reviewState,reason:z.string().trim().min(3).max(1000)}),
 z.strictObject({action:z.literal('delete'),command_id:z.uuid(),id:z.uuid(),version:z.number().int().positive()}),
 z.strictObject({action:z.literal('delete_mine'),command_id:z.uuid()})
]);
async function owner(tx:Tx,tenant:string,user:string){if(await membership(tx,tenant,user)!=='owner')throw new ApiFault('NOT_FOUND');}

export async function readLearningCase(tx:Tx,tenant:string,user:string,id:string){
 await owner(tx,tenant,user);
 const [row]=await tx`select * from app.decision_examples where tenant_id=${tenant}::uuid and id=${id}::uuid and learning_consent_id is not null and learning_state<>'deleted' and created_at>now()-interval '90 days'`;
 if(!row)throw new ApiFault('NOT_FOUND');
 const refs=z.array(z.object({revision:z.uuid()}).passthrough()).min(1).parse(row.learning_snapshot.source_refs);
 const revisions=refs.map(r=>r.revision);
 const evidence=await tx`select r.id,r.revision_number,b.sha256 source_hash,r.declared_mime from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id where r.tenant_id=${tenant}::uuid and r.id=any(${revisions}::uuid[]) and app.revision_accessible(r.tenant_id,r.id)`;
 if(evidence.length!==new Set(revisions).size)throw new ApiFault('NOT_FOUND');
 // Immutable provider metadata and usage only: no chain of thought or raw provider response.
 const trace=await tx`select id,channel,state,revision_id,coalesce(actual_krw,reserved_krw)::text cost_minor,(actual_krw is not null) cost_known,
 config->>'model' model,config->>'prompt' prompt_version,config->>'schema' schema_version,config->>'parser' parser_version,
 config->>'first_ordinal' first_ordinal,config->>'last_ordinal' last_ordinal,created_at
 from app.product_ai_usage where tenant_id=${tenant}::uuid and revision_id=any(${revisions}::uuid[]) and created_at<=${row.created_at} order by created_at,id limit 100`;
 const [scope]=await tx`select not exists(select 1 from app.work_command_effects e join app.decisions d on d.tenant_id=e.tenant_id and d.id=e.decision_id join app.work_decision_cases c on c.tenant_id=d.tenant_id and c.id=d.target_ids[1],jsonb_array_elements(c.source_refs) r where e.tenant_id=${tenant}::uuid and e.context_id=${row.learning_snapshot.context_id}::uuid and not app.revision_accessible(e.tenant_id,(r->>'revision')::uuid)) allowed`;
 const [now]=scope?.allowed?await tx`select state,version from app.work_projections where tenant_id=${tenant}::uuid and context_id=${row.learning_snapshot.context_id}::uuid`:[];
 const effects=scope?.allowed?await tx`select d.id,d.actor_kind,d.created_at,e.effects from app.work_command_effects e join app.decisions d on d.tenant_id=e.tenant_id and d.id=e.decision_id where e.tenant_id=${tenant}::uuid and e.context_id=${row.learning_snapshot.context_id}::uuid and d.created_at>=${row.learning_snapshot.decision_at} order by d.created_at,d.id limit 100`:[];
 return {id:row.id,version:row.learning_version,state:row.learning_state,reason:row.learning_reason,reviewed_at:row.learning_reviewed_at,
  snapshot:row.learning_snapshot,proposal:row.proposal,answer:row.answer,result:row.result,evidence,trace,trace_limit:100,
  history:row.learning_history,current:{available:scope?.allowed===true,state:now?.state??null,version:now?.version??null,effects,limit:100},ground_truth:row.learning_state==='confirmed'||row.learning_state==='correction',use_scope:'company_improvement',retention_days:90};
}

export function registerLearning(app:FastifyInstance,services:Services){
 app.get('/v1/learning',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({cursor:z.uuid().optional()}).safeParse(req.query);if(!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   await owner(tx,tenant,actor.userId);await tx`select app.purge_learning_cases()`;
   const [consent]=await tx`select learning_allowed allowed,learning_since since from app.activity_consents where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid`;
   const [cursor]=p.data.cursor?await tx`select created_at,id from app.decision_examples where tenant_id=${tenant}::uuid and id=${p.data.cursor}::uuid and learning_consent_id is not null`:[];if(p.data.cursor&&!cursor)throw new ApiFault('NOT_FOUND');
   const rows=await tx`select id,decision_id,created_at,learning_state state,learning_version version,learning_reason reason,learning_snapshot->>'prompt' prompt,learning_snapshot->>'actor_kind' actor_kind,learning_snapshot->>'period' period from app.decision_examples where tenant_id=${tenant}::uuid and learning_consent_id is not null and learning_state<>'deleted' and created_at>now()-interval '90 days' and (${cursor?.id??null}::uuid is null or (created_at,id)<(${cursor?.created_at??null}::timestamptz,${cursor?.id??null}::uuid)) order by created_at desc,id desc limit 31`;
   const [summary]=await tx`select count(*)::int available,count(*) filter(where learning_state='unreviewed')::int unreviewed,count(*) filter(where learning_state='correction')::int corrections,count(*) filter(where learning_state='new_fact')::int new_facts from app.decision_examples where tenant_id=${tenant}::uuid and learning_consent_id is not null and learning_state<>'deleted' and created_at>now()-interval '90 days'`;
   return {status:200,body:{consent:consent??{allowed:false,since:null},summary,cases:rows.slice(0,30),next_cursor:rows.length>30?rows[29]!.id:null,retention_days:90,purpose:'company-improvement-v1'}};
  });
 }));
 app.get<{Params:{id:string}}>('/v1/learning/:id',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id);if(!id.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await readLearningCase(tx,tenant,actor.userId,id.data)}));
 }));
 app.post('/v1/learning/commands',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=command.safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');const b=p.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   await owner(tx,tenant,actor.userId);
   return once(tx,tenant,actor.userId,'POST /v1/learning/commands',b.command_id,workHash(b),async()=>{
    if(b.action==='consent'||b.action==='delete_mine'){
     if(b.action==='delete_mine')await tx`select app.erase_learning_case(${tenant}::uuid)`;
     const allowed=b.action==='consent'&&b.allowed;
     await tx`insert into app.activity_consents(tenant_id,user_id,allowed,learning_allowed) values(${tenant}::uuid,${actor.userId}::uuid,false,${allowed}) on conflict(tenant_id,user_id) do update set learning_allowed=excluded.learning_allowed,learning_consent_id=case when app.activity_consents.learning_allowed=excluded.learning_allowed and ${b.action!=='delete_mine'} then app.activity_consents.learning_consent_id else gen_random_uuid() end,learning_since=case when app.activity_consents.learning_allowed=excluded.learning_allowed and ${b.action!=='delete_mine'} then app.activity_consents.learning_since else now() end`;
     await tx`select app.purge_learning_cases()`;await tx`select app.purge_strategies(${tenant}::uuid,null)`;return {status:200,body:{saved:true,allowed}};
    }
    const [row]=await tx`select learning_version version,learning_state state,learning_reason reason,learning_history history,learning_reviewed_by reviewed_by,learning_reviewed_at reviewed_at from app.decision_examples where tenant_id=${tenant}::uuid and id=${b.id}::uuid and learning_consent_id is not null and learning_state<>'deleted' for update`;
    if(!row)throw new ApiFault('NOT_FOUND');if(row.version!==b.version)throw new ApiFault('VERSION_CONFLICT');
    if(b.action==='delete'){await tx`select app.erase_learning_case(${tenant}::uuid,${b.id}::uuid)`;return {status:200,body:{saved:true,deleted:true}};}
    if(row.history.length>=100)throw new ApiFault('DOMAIN_INVARIANT');
    await tx`update app.decision_examples set learning_state=${b.state},learning_reason=${b.reason},learning_version=learning_version+1,learning_reviewed_by=${actor.userId}::uuid,learning_reviewed_at=now(),learning_history=learning_history||${tx.json([{version:row.version,state:row.state,reason:row.reason,reviewed_by:row.reviewed_by,reviewed_at:row.reviewed_at}])}::jsonb where tenant_id=${tenant}::uuid and id=${b.id}::uuid`;
    return {status:200,body:{saved:true,version:b.version+1,state:b.state,business_effects_changed:false}};
   });
  });
 }));
}
