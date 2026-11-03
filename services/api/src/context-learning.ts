import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
import {CONTEXT_READING_HINT,CONTEXT_READING_PROCEDURE,contextReadingLeakageKeys,contextReadingPrediction,evaluateContextReading,makeContextReadingCandidate,type ContextLearningCase,type ContextReadingEvidence,type ContextReadingCandidate} from '@sigongnote/domain';

type Source={tenant:string;actor:string;source_kind:'local'|'revision';source_ref:string;source_version:string;received_at:string};
const iso=(value:unknown)=>value instanceof Date?value.toISOString():new Date(String(value)).toISOString();
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function owner(tx:Tx,tenant:string,user:string){if(await membership(tx,tenant,user)!=='owner')throw new ApiFault('NOT_FOUND');}
async function consent(tx:Tx,tenant:string,user:string){const [row]=await tx`select learning_consent_id id,learning_allowed allowed from app.activity_consents where tenant_id=${tenant}::uuid and user_id=${user}::uuid`;return row?.allowed?String(row.id):null;}
const asCase=(row:Record<string,any>):ContextLearningCase=>({id:String(row.id),family:String(row.snapshot.source_family),sourceVersion:String(row.source_version),correctedAt:iso(row.created_at),adoptedAt:row.reviewed_at?iso(row.reviewed_at):null,state:String(row.state),eligible:Boolean(row.eligible),targetProject:row.snapshot.replacement.project_id??null,previousProject:row.snapshot.previous.project_id??null});

/** Called in the same transaction as the real correction. No source prose is duplicated. */
export async function captureContextCorrection(tx:Tx,tenant:string,user:string,correctionId:string){
 const generation=await consent(tx,tenant,user);if(!generation)return null;
 await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':context-learning:'+correctionId},0))`;
 const [existing]=await tx`select id from app.context_learning_cases where tenant_id=${tenant}::uuid and correction_id=${correctionId}::uuid`;if(existing)return null;
 const [row]=await tx`select c.*,e.source_kind,e.source_ref,e.source_version,e.version event_version,e.evidence_refs,p.display_name project_name,b.display_name previous_name
  from app.work_event_corrections c join app.work_events e on e.tenant_id=c.tenant_id and e.id=c.event_id
  left join app.projects p on p.tenant_id=c.tenant_id and p.id=(c.replacement->>'project_id')::uuid
  left join app.projects b on b.tenant_id=c.tenant_id and b.id=(c.previous->>'project_id')::uuid
  where c.tenant_id=${tenant}::uuid and c.id=${correctionId}::uuid and c.actor_id=${user}::uuid and app.work_event_readable(e.tenant_id,e.id)`;
 if(!row)return null;
 const [source]=await tx`select app.context_learning_source_version(${tenant}::uuid,${row.source_kind},${row.source_ref}::uuid) version,app.context_learning_source_family(${tenant}::uuid,${row.source_kind},${row.source_ref}::uuid) family`;
 if(!source?.version||!source.family||source.version!==row.source_version)return null;
 const evidence:ContextReadingEvidence[]=[];
 for(const id of [...new Set([String(row.source_ref),...(row.evidence_refs as string[])])]){
  const [kind]=await tx`select case when exists(select 1 from app.local_journal_entries where tenant_id=${tenant}::uuid and id=${id}::uuid) then 'local' else 'revision' end value`;
  const [proof]=await tx`select app.context_learning_source_version(${tenant}::uuid,${String(kind!.value)},${id}::uuid) version`;
  if(!proof?.version)return null;
  evidence.push({kind:String(kind!.value),id,version:String(proof.version),projectId:null,receivedAt:iso(row.created_at)});
 }
 const snapshot={previous:{...row.previous,project_name:row.previous_name},replacement:{...row.replacement,project_name:row.project_name},evidence:evidence.map(({kind,id,version})=>({kind,id,version})),source_family:String(source.family),correction_id:correctionId,corrected_at:iso(row.created_at),scope:'site_reading_only'};
 const eligible=Boolean(row.replacement.project_id)&&row.previous.project_id!==row.replacement.project_id;
 const id=randomUUID();
 await tx`insert into app.context_learning_cases(tenant_id,id,correction_id,event_id,actor_id,consent_id,source_kind,source_ref,source_version,event_version,snapshot,snapshot_hash,eligible)
  values(${tenant}::uuid,${id}::uuid,${correctionId}::uuid,${row.event_id}::uuid,${user}::uuid,${generation}::uuid,${row.source_kind},${row.source_ref}::uuid,${row.source_version},${row.event_version},${tx.json(snapshot)},${hash(snapshot)},${eligible})`;
 // The currentness policy reads the completed row in a new statement snapshot.
 const [saved]=await tx`select id from app.context_learning_cases where tenant_id=${tenant}::uuid and id=${id}::uuid`;
 return saved?.id??null;
}

/** Runtime hook: observe real, earlier journal rows before a new source is interpreted or corrected. */
export async function observeContextReading(tx:Tx,input:Source){
 const generation=await consent(tx,input.tenant,input.actor);if(!generation)return;
 const [identity]=await tx`select app.context_learning_source_family(${input.tenant}::uuid,${input.source_kind},${input.source_ref}::uuid) family,app.context_learning_source_version(${input.tenant}::uuid,${input.source_kind},${input.source_ref}::uuid) version`;
 if(!identity?.family||identity.version!==input.source_version)return;
 const sourceFamily=String(identity.family),keys=contextReadingLeakageKeys({family:sourceFamily,sourceVersion:input.source_version});if(keys.length!==2)return;
 const procedures=await tx`select * from app.context_reading_procedures where tenant_id=${input.tenant}::uuid and app.context_learning_procedure_current(tenant_id,id) and created_at<${input.received_at}::timestamptz order by created_at,id limit 20`;
 const eligible=procedures.filter(p=>!keys.some(key=>(p.train_families as string[]).includes(key)));if(!eligible.length)return;
 const rows=await tx`with earlier as (
  select 'local'::text kind,l.id,l.project_id,l.received_at,app.context_learning_source_version(l.tenant_id,'local',l.id) version,app.context_learning_source_family(l.tenant_id,'local',l.id) family
   from app.local_journal_entries l where l.tenant_id=${input.tenant}::uuid and l.excerpt<>'' and app.local_native_revision_for_read(l.tenant_id,l.id) is null
  union all
  select 'revision',r.id,o.project_id,r.created_at,app.context_learning_source_version(r.tenant_id,'revision',r.id),app.context_learning_source_family(r.tenant_id,'revision',r.id)
   from app.document_revisions r left join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id
   where r.tenant_id=${input.tenant}::uuid and not r.generated_output
 ) select * from earlier where version is not null and project_id is not null and not(kind=${input.source_kind} and id=${input.source_ref}::uuid)
  and received_at<=${input.received_at}::timestamptz and received_at>${input.received_at}::timestamptz-interval '30 days' order by received_at desc,id desc limit 20`;
 const evidence:ContextReadingEvidence[]=rows.map(r=>({kind:String(r.kind),id:String(r.id),version:String(r.version),family:String(r.family),projectId:r.project_id?String(r.project_id):null,receivedAt:iso(r.received_at)}));
 const prediction=contextReadingPrediction({family:sourceFamily,sourceVersion:input.source_version,receivedAt:iso(input.received_at)},evidence);
 for(const procedure of eligible)await tx`insert into app.context_reading_shadows(tenant_id,procedure_id,actor_id,consent_id,source_kind,source_ref,source_version,source_received_at,prediction,observations)
  values(${input.tenant}::uuid,${procedure.id}::uuid,${input.actor}::uuid,${generation}::uuid,${input.source_kind},${input.source_ref}::uuid,${input.source_version},${input.received_at}::timestamptz,${prediction}::uuid,${tx.json({rule:CONTEXT_READING_PROCEDURE,source_family:sourceFamily,read_tools:['recent_journal'],evidence})}) on conflict(tenant_id,procedure_id,source_kind,source_ref,source_version) do nothing`;
}

/** A promoted procedure is a bounded read instruction, never a remembered site answer or business effect. */
export async function readContextReadingHints(tx:Tx,tenant:string,_sourceKind?:string){
 const rows=await tx`select id,version,rule from app.context_reading_procedures where tenant_id=${tenant}::uuid and state='promoted' and app.context_learning_procedure_current(tenant_id,id) order by promoted_at desc,id limit 5`;
 return rows.map(row=>({id:row.id,version:Number(row.version),rule:row.rule,steps:CONTEXT_READING_HINT,scope:'read_evidence_only',business_effects:false}));
}

async function evaluate(tx:Tx,tenant:string,procedure:Record<string,any>){
 const cases=await tx`select * from app.context_learning_cases where tenant_id=${tenant}::uuid and state='adopted' order by created_at,id limit 500`;
 const shadows=await tx`select * from app.context_reading_shadows s where tenant_id=${tenant}::uuid and procedure_id=${procedure.id}::uuid
  and not exists(select 1 from jsonb_array_elements(s.observations->'evidence') p where app.context_learning_source_version(s.tenant_id,p->>'kind',(p->>'id')::uuid) is distinct from p->>'version') order by observed_at,id limit 1000`;
 const candidate:ContextReadingCandidate={rule:String(procedure.rule),trainIds:procedure.train_ids,trainFamilies:procedure.train_families,createdAt:iso(procedure.created_at)};
 return evaluateContextReading(candidate,cases.map(asCase),shadows.map(s=>({family:String(s.observations.source_family),sourceVersion:String(s.source_version),receivedAt:iso(s.source_received_at),observedAt:iso(s.observed_at),projectId:s.prediction?String(s.prediction):null})));
}

const commands=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('case.review'),command_id:z.uuid(),id:z.uuid(),version:z.number().int().positive(),state:z.enum(['adopted','excluded']),reason:z.string().trim().min(1).max(500)}),
 z.strictObject({action:z.literal('procedure.create'),command_id:z.uuid(),case_ids:z.array(z.uuid()).min(1).max(20)}),
 z.strictObject({action:z.enum(['procedure.evaluate','procedure.promote','procedure.withdraw']),command_id:z.uuid(),id:z.uuid(),version:z.number().int().positive()})
]);
export function registerContextLearning(app:FastifyInstance,services:Services){
 app.get('/v1/context-learning',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{
   await owner(tx,tenant,actor.userId);await tx`select app.purge_context_learning(${tenant}::uuid)`;
   const generation=await consent(tx,tenant,actor.userId);
   const cases=generation?await tx`select id,version,state,eligible,source_kind,source_ref,source_version,snapshot,snapshot_hash,review_reason,reviewed_at,created_at from app.context_learning_cases where tenant_id=${tenant}::uuid order by created_at desc,id desc limit 100`:[];
   const procedures=generation?await tx`select p.id,p.version,p.rule,p.train_ids,p.state,p.created_at,p.promoted_at,app.context_learning_procedure_current(p.tenant_id,p.id) usable,(select report from app.context_reading_evaluations e where e.tenant_id=p.tenant_id and e.procedure_id=p.id order by e.created_at desc,e.id desc limit 1) evaluation from app.context_reading_procedures p where p.tenant_id=${tenant}::uuid order by p.created_at desc,p.id desc limit 30`:[];
   return {status:200,body:{consent:{allowed:!!generation},cases,procedures,retention_days:90,scope:'site_reading_only',business_effects_changed:false}};
  });
 }));
 app.post('/v1/context-learning/commands',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),parsed=commands.safeParse(req.body);if(!parsed.success)throw new ApiFault('INVALID_CONTRACT');const b=parsed.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   await owner(tx,tenant,actor.userId);const generation=await consent(tx,tenant,actor.userId);if(!generation)throw new ApiFault('DOMAIN_INVARIANT');
   return once(tx,tenant,actor.userId,'context-learning.command',b.command_id,hash(b),async()=>{
    if(b.action==='case.review'){
     const [row]=await tx`select * from app.context_learning_cases where tenant_id=${tenant}::uuid and id=${b.id}::uuid for update`;if(!row)throw new ApiFault('NOT_FOUND');if(Number(row.version)!==b.version)throw new ApiFault('VERSION_CONFLICT');
     if(b.state==='adopted'&&!row.eligible)throw new ApiFault('DOMAIN_INVARIANT');
     await tx`update app.context_learning_cases set state=${b.state},version=version+1,reviewed_by=${actor.userId}::uuid,reviewed_at=now(),review_reason=${b.reason} where tenant_id=${tenant}::uuid and id=${b.id}::uuid`;
     return {status:200,body:{saved:true,version:b.version+1,business_effects_changed:false}};
    }
    if(b.action==='procedure.create'){
     if(new Set(b.case_ids).size!==b.case_ids.length)throw new ApiFault('INVALID_CONTRACT');
     const rows=await tx`select * from app.context_learning_cases where tenant_id=${tenant}::uuid and id=any(${b.case_ids}::uuid[]) order by id`;
     if(rows.length!==b.case_ids.length)throw new ApiFault('NOT_FOUND');
     const [clock]=await tx`select now() at`;let candidate:ContextReadingCandidate;try{candidate=makeContextReadingCandidate(rows.map(asCase),iso(clock!.at));}catch{throw new ApiFault('DOMAIN_INVARIANT');}
     const [saved]=await tx`insert into app.context_reading_procedures(tenant_id,owner_id,consent_id,rule,train_ids,train_families) values(${tenant}::uuid,${actor.userId}::uuid,${generation}::uuid,${candidate.rule},${candidate.trainIds}::uuid[],${candidate.trainFamilies}::text[]) returning id`;
     return {status:200,body:{id:saved!.id,state:'shadow',business_effects_changed:false}};
    }
    const [procedure]=await tx`select * from app.context_reading_procedures where tenant_id=${tenant}::uuid and id=${b.id}::uuid for update`;
    if(!procedure)throw new ApiFault('NOT_FOUND');if(Number(procedure.version)!==b.version)throw new ApiFault('VERSION_CONFLICT');
    if(b.action==='procedure.withdraw'){await tx`update app.context_reading_procedures set state='withdrawn',version=version+1 where tenant_id=${tenant}::uuid and id=${b.id}::uuid`;return {status:200,body:{saved:true,state:'withdrawn',business_effects_changed:false}};}
    const [current]=await tx`select app.context_learning_procedure_current(${tenant}::uuid,${b.id}::uuid) allowed`;if(!current?.allowed)throw new ApiFault('DOMAIN_INVARIANT');
    const report=await evaluate(tx,tenant,procedure);
    await tx`insert into app.context_reading_evaluations(tenant_id,procedure_id,owner_id,report) values(${tenant}::uuid,${b.id}::uuid,${actor.userId}::uuid,${tx.json(report)})`;
    if(b.action==='procedure.promote'){
     if(!report.canPromote)throw new ApiFault('DOMAIN_INVARIANT');
     await tx`update app.context_reading_procedures set state='promoted',version=version+1,promoted_at=now() where tenant_id=${tenant}::uuid and id=${b.id}::uuid`;
    }
    return {status:200,body:{report,state:b.action==='procedure.promote'?'promoted':procedure.state,version:b.action==='procedure.promote'?b.version+1:b.version,business_effects_changed:false}};
   });
  });
 }));
}
