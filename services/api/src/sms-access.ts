import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from './routes.js';
import {smsActivation,smsDocumentId} from './sms-activation.js';
import {sourcePolicyCurrent} from './capture-scope.js';
import {UuidSchema} from '@sigongnote/contracts';
export function registerSmsAccess(app:FastifyInstance,services:Services){
 app.get<{Params:{id:string};Querystring:{message_key?:string}}>('/v1/capture-sources/:id/sms-access',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=UuidSchema.safeParse(req.params.id);if(!id.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('FORBIDDEN');
   const [source]=await tx`select s.*,d.platform,d.active device_active from app.capture_sources s join app.devices d on d.tenant_id=s.tenant_id and d.id=s.device_id where s.tenant_id=${tenant}::uuid and s.id=${id.data}::uuid and s.user_id=${actor.userId}::uuid`;
   if(!source)throw new ApiFault('NOT_FOUND');const gate=smsActivation(source);
   const ready=gate.ready&&source.active&&source.device_active&&source.server_upload_consent&&sourcePolicyCurrent(source.scope,source.processing_policy,services.capturePolicy);
   let previous=null;
   if(ready&&req.query.message_key){if(!/^[a-f0-9]{64}$/.test(req.query.message_key))throw new ApiFault('INVALID_CONTRACT');
    const doc=smsDocumentId(tenant,actor.userId,req.query.message_key);
    const [row]=await tx`select r.document_id,r.id revision_id,r.revision_number,b.sha256,u.source_id from app.documents d join app.document_revisions r on r.tenant_id=d.tenant_id and r.document_id=d.id and r.revision_number=d.version join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id join app.upload_intents u on u.tenant_id=r.tenant_id and u.completed_revision_id=r.id where d.tenant_id=${tenant}::uuid and d.id=${doc}::uuid and u.actor_id=${actor.userId}::uuid and r.declared_mime='application/vnd.sigongnote.message+json' limit 1`;
    if(row)previous={...row,revision_number:Number(row.revision_number)};
   }
   return {status:200,body:{...gate,ready:Boolean(ready),generation:Number(source.generation),previous}};
  });
 }));
}
