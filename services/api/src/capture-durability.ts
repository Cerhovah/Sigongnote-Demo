import {z} from 'zod';
import {CaptureDurabilityRequestSchema,CaptureDurabilityResponseSchema,CaptureStorageUsageSchema,CaptureStatusResponseSchema} from '@sigongnote/contracts';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Principal} from './auth.js';
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from './routes.js';
import type {StorageGateway} from './ingestions.js';
import {sourcePolicyCurrent} from './capture-scope.js';
const proofInput=CaptureDurabilityRequestSchema;
/** ACK is not permission to reclaim. Check the canonical object and current access again. */
export function registerCaptureDurability(app:FastifyInstance,services:Services,storage:StorageGateway){
 // Share only simultaneous checks. No cached proof survives a completed request.
 const checks=new Map<string,ReturnType<StorageGateway['verify']>>();
 app.get('/v1/capture-status',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);
  return inAuthorizedTransaction(services.db,actor,async tx=>{await membership(tx,tenant,actor.userId);
   const [row]=await tx`select app.capture_storage_usage() usage,app.capture_recovery_status(${tenant}::uuid) recovery`;
   return {status:200,body:CaptureStatusResponseSchema.parse({...CaptureStorageUsageSchema.parse(row?.usage),recovery:row?.recovery})};
  });
 }));
 app.get('/v1/capture-storage',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);
  return inAuthorizedTransaction(services.db,actor,async tx=>{await membership(tx,tenant,actor.userId);const [row]=await tx`select app.capture_storage_usage() as usage`;return {status:200,body:CaptureStorageUsageSchema.parse(row?.usage)};});
 }));
 async function lookup(actor:Principal,tenant:string,id:string,byRevision=false){
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');
   const [row]=await tx`select i.id,r.id revision_id,b.storage_key,b.sha256,b.byte_length,i.source_generation,
    s.generation,s.active,s.server_upload_consent,s.scope,s.processing_policy
    from app.upload_intents i join app.document_revisions r on r.tenant_id=i.tenant_id and r.id=i.completed_revision_id
    join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
    left join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id
    where i.tenant_id=${tenant}::uuid and i.actor_id=${actor.userId}::uuid and
      ((${byRevision}=false and i.id=${id}::uuid) or (${byRevision}=true and r.id=${id}::uuid)) and i.status='verified'
    and b.storage_location='server' and app.revision_accessible(r.tenant_id,r.id)
    and not exists(select 1 from app.jobs j where j.tenant_id=r.tenant_id and j.evidence_revision_id=r.id and j.state in ('queued','leased','retry_wait'))`;
   if(!row)throw new ApiFault('NOT_FOUND');
   if(row.source_generation!==null&&(!row.active||!row.server_upload_consent||Number(row.generation)!==Number(row.source_generation)||!sourcePolicyCurrent(row.scope,row.processing_policy,services.capturePolicy)))throw new ApiFault('SOURCE_EXPIRED');
   return {status:200,body:row};
  });
 }
 for(const route of ['/v1/ingestions/:id/durability','/v1/revisions/:id/durability'])app.post<{Params:{id:string}}>(route,async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),parsedId=z.uuid().safeParse(req.params.id),parsedInput=proofInput.safeParse(req.body);
  if(!parsedId.success||!parsedInput.success)throw new ApiFault('INVALID_CONTRACT');
  const id=parsedId.data,input=parsedInput.data;
  const byRevision=route.includes('/revisions/');
  const before=await lookup(actor,tenant,id,byRevision);if(!before)throw new ApiFault('UNAUTHENTICATED');
  const row=before.body as Record<string,unknown>;
  if(row.sha256!==input.sha256||Number(row.byte_length)!==input.byte_length)throw new ApiFault('DOMAIN_INVARIANT');
  const key=JSON.stringify([row.storage_key,input.sha256,input.byte_length]);
  let check=checks.get(key);
  if(!check){check=Promise.resolve().then(()=>storage.verify(String(row.storage_key),input.sha256,input.byte_length));checks.set(key,check);}
  let verified:Awaited<ReturnType<StorageGateway['verify']>>;
  try{verified=await check;}catch{verified=null;}finally{if(checks.get(key)===check)checks.delete(key);}
  const record=async(ok:boolean)=>inAuthorizedTransaction(services.db,actor,async tx=>{await tx`select app.record_capture_recovery(${tenant}::uuid,${String(row.id)}::uuid,${ok})`;return {status:200,body:{}};});
  if(!verified?.matches||!storage.readUrl){await record(false);throw new ApiFault('TEMPORARILY_UNAVAILABLE');}
  let url:string;
  try{url=await storage.readUrl(String(row.storage_key));}catch{await record(false);throw new ApiFault('TEMPORARILY_UNAVAILABLE');}
  const after=await lookup(actor,tenant,id,byRevision);if(!after)throw new ApiFault('UNAUTHENTICATED');
  const current=after.body as Record<string,unknown>;
  if(current.storage_key!==row.storage_key||current.sha256!==row.sha256||current.revision_id!==row.revision_id){await record(false);throw new ApiFault('TEMPORARILY_UNAVAILABLE');}
  const body=CaptureDurabilityResponseSchema.parse({state:'recoverable',ingestion_id:row.id,revision_id:row.revision_id,sha256:input.sha256,byte_length:input.byte_length,source_generation:row.source_generation,verified_at:new Date().toISOString(),restore_url:url,expires_in:60});
  await record(true);
  return {status:200,body};
 }));
}
