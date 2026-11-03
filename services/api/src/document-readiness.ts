import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {DocumentType} from '@sigongnote/domain';
import {documentIntent} from '@sigongnote/domain';
import type {Db,Tx} from './auth.js';
import {ApiFault,membership,type Services} from './routes.js';
import {prepareDocument,readDraft,documentNames} from './document-drafts.js';

const types:DocumentType[]=['estimate','purchase_order','invoice','delivery_statement'];
/** A durable pointer, not a second document ledger. A committed draft is immutable. */
export async function refreshDocumentReadiness(tx:Tx,tenant:string,user:string,context:string){
 const [work]=await tx`select project_id from app.work_contexts where tenant_id=${tenant}::uuid and id=${context}::uuid`;
 if(!work)return;
 await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':document:'+work.project_id},0))`;
 await tx`insert into app.document_readiness_checks(tenant_id,context_id) values(${tenant}::uuid,${context}::uuid) on conflict(tenant_id,context_id) do update set checked_at=clock_timestamp()`;
 for(const type of types){
  const [pointer]=await tx`select * from app.document_readiness where tenant_id=${tenant}::uuid and context_id=${context}::uuid and document_type=${type}`;
  let previous:any;
  if(pointer){
   const [latest]=await tx`with recursive chain as (select * from app.document_drafts where tenant_id=${tenant}::uuid and id=${pointer.draft_id}::uuid union all select d.* from app.document_drafts d join chain c on d.supersedes_id=c.id where d.tenant_id=${tenant}::uuid) select * from chain order by version desc limit 1`;
   if(!latest)throw new ApiFault('NOT_FOUND');previous=latest;
   try{if(!(await readDraft(tx,tenant,String(latest.id))).stale){if(latest.id!==pointer.draft_id)await tx`update app.document_readiness set draft_id=${latest.id}::uuid,version=version+1 where tenant_id=${tenant}::uuid and context_id=${context}::uuid and document_type=${type}`;continue;}}catch(e){if(!(e instanceof ApiFault)||e.code!=='NOT_FOUND')throw e;}
  }
  // Pending drafts may advance automatically. Issued snapshots and approvals are never rewritten.
  const overrides={...(previous?.internal_snapshot.overrides??{}),context_id:context};
  if(previous&&(await tx`select 1 from app.business_document_revisions where tenant_id=${tenant}::uuid and draft_id=${previous.id}::uuid`).length)delete overrides.quantities;
  const id=randomUUID();await prepareDocument(tx,tenant,user,String(work.project_id),type,id,overrides,previous?{id:previous.id,version:Number(previous.version),number:previous.public_snapshot.document_number}:undefined);
  await tx`insert into app.document_readiness(tenant_id,context_id,document_type,draft_id) values(${tenant}::uuid,${context}::uuid,${type},${id}::uuid) on conflict(tenant_id,context_id,document_type) do update set draft_id=excluded.draft_id,version=app.document_readiness.version+1`;
 }
}

export async function prepareAgentDocument(tx:Tx,scope:{tenant:string;user:string;project:string|null;run:string},type:DocumentType,context?:string,project?:string){
 if(await membership(tx,scope.tenant,scope.user)!=='owner')throw new ApiFault('NOT_FOUND');
 if(scope.project&&project&&scope.project!==project)throw new ApiFault('NOT_FOUND');
 const selected=scope.project??project;if(!selected)throw new ApiFault('INVALID_CONTRACT');
 const rows=await tx`select id,label from app.work_contexts where tenant_id=${scope.tenant}::uuid and project_id=${selected}::uuid and (${context??null}::uuid is null or id=${context??null}::uuid) order by label,id limit 21`;
 if(!context&&rows.length===0&&type==='estimate'){const draft=await prepareDocument(tx,scope.tenant,scope.user,selected,type,randomUUID());return documentReceipt(tx,scope.tenant,String(draft.id));}
 if(rows.length!==1){if(context)throw new ApiFault('NOT_FOUND');return {document_choices:{type,project_id:selected,contexts:rows.slice(0,20).map(r=>({id:String(r.id),label:String(r.label)})),partial:rows.length>20}};}
 await refreshDocumentReadiness(tx,scope.tenant,scope.user,String(rows[0]!.id));
 const [pointer]=await tx`select draft_id from app.document_readiness where tenant_id=${scope.tenant}::uuid and context_id=${rows[0]!.id}::uuid and document_type=${type}`;
 return documentReceipt(tx,scope.tenant,String(pointer!.draft_id));
}
export async function documentReceipt(tx:Tx,tenant:string,id:string){
 const d=await readDraft(tx,tenant,id);return {document:{id:String(d.id),type:d.document.type as DocumentType,state:String(d.state),stale:d.stale,latest_id:String(d.latest_id),missing:d.missing as string[],label:documentNames[d.document.type as DocumentType]}};
}
/** Fast local intent is also available while a paid provider is paused or not configured. */
export function localDocumentPlan(instruction:string){const type=documentIntent(instruction);return type?{tool:'prepare_document' as const,input:JSON.stringify({type})}:null;}
export async function runDocumentReadiness(db:Db,stopped=()=>false){
 const targets=await db`select * from app.document_readiness_targets()`;
 for(const row of targets){if(stopped())break;try{
  await db.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${String(row.user_id)},true)`;await tx`insert into app.document_readiness_checks(tenant_id,context_id) values(${row.tenant_id}::uuid,${row.context_id}::uuid) on conflict(tenant_id,context_id) do update set checked_at=clock_timestamp()`;});
  await db.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${String(row.user_id)},true)`;await refreshDocumentReadiness(tx,String(row.tenant_id),String(row.user_id),String(row.context_id));});}catch{
  console.warn('DOCUMENT_READINESS_RETRY');
  // Rotate failures too. One malformed work item cannot starve other workspaces.
  await db.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${String(row.user_id)},true)`;await tx`insert into app.document_readiness_checks(tenant_id,context_id) values(${row.tenant_id}::uuid,${row.context_id}::uuid) on conflict(tenant_id,context_id) do update set checked_at=clock_timestamp()`;}).catch(()=>{});
 }}
}
export function startDocumentReadiness(app:FastifyInstance,services:Pick<Services,'db'>){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<void>=Promise.resolve();
 const tick=()=>{running=runDocumentReadiness(services.db,()=>stopped).catch(()=>{}).finally(()=>{if(!stopped){timer=setTimeout(tick,15000);timer.unref();}});};
 app.addHook('onReady',async()=>{tick();});app.addHook('onClose',async()=>{stopped=true;if(timer)clearTimeout(timer);await running;});
}
