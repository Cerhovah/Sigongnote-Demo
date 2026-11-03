import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {readIssuedDocument,jsonHash} from './document-issuance.js';
import {ApiFault,execute,once,principal,tenantHeader,type Services} from './routes.js';

export function registerDocumentSharing(app:FastifyInstance,services:Services){
 app.post<{Params:{id:string}}>('/v1/documents/:id/share-intents',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id),p=z.strictObject({client_command_id:z.uuid(),format:z.enum(['pdf','xlsx'])}).safeParse(req.body);
  if(!id.success||!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   const doc=await readIssuedDocument(tx,tenant,id.data);if(doc.state!=='approved')throw new ApiFault('DOMAIN_INVARIANT');
   const file=doc.files.find(f=>f.format===p.data.format);if(!file)throw new ApiFault('TEMPORARILY_UNAVAILABLE');
   return once(tx,tenant,actor.userId,'documents.share',p.data.client_command_id,jsonHash({id:id.data,format:p.data.format}),async()=>{
    const intent=randomUUID();await tx`insert into app.document_share_intents(tenant_id,id,actor_id,document_id,revision_id,format,sha256) values(${tenant}::uuid,${intent}::uuid,${actor.userId}::uuid,${id.data}::uuid,${doc.revision_id}::uuid,${p.data.format},${file.sha256})`;
    return {status:201,body:{id:intent,revision_id:doc.revision_id,sha256:file.sha256,state:'prepared',delivery_confirmed:false}};
   });
  });
 }));
 app.post<{Params:{id:string;intent:string}}>('/v1/documents/:id/share-intents/:intent/outcomes',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),ids=z.object({id:z.uuid(),intent:z.uuid()}).safeParse(req.params),p=z.strictObject({client_command_id:z.uuid(),outcome:z.enum(['cancelled','unknown','user_confirmed'])}).safeParse(req.body);
  if(!ids.success||!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   await readIssuedDocument(tx,tenant,ids.data.id);
   const [intent]=await tx`select id from app.document_share_intents where tenant_id=${tenant}::uuid and id=${ids.data.intent}::uuid and document_id=${ids.data.id}::uuid and actor_id=${actor.userId}::uuid`;if(!intent)throw new ApiFault('NOT_FOUND');
   return once(tx,tenant,actor.userId,'documents.share-outcome',p.data.client_command_id,jsonHash({intent:ids.data.intent,outcome:p.data.outcome}),async()=>{
    await tx`insert into app.document_share_outcomes(tenant_id,intent_id,id,outcome) values(${tenant}::uuid,${ids.data.intent}::uuid,${randomUUID()}::uuid,${p.data.outcome}) on conflict(tenant_id,intent_id,outcome) do nothing`;
    return {status:200,body:{recorded:true,delivery_confirmed:false,payment_confirmed:false}};
   });
  });
 }));
}
