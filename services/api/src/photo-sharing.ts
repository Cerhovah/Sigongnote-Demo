import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,principal,tenantHeader,type Services} from './routes.js';
import {deliverySource} from './delivery-source.js';
export function registerPhotoSharing(app:FastifyInstance,services:Services){
 app.post('/v1/photo-sheets/share',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({id:z.uuid(),intent_id:z.uuid(),outcome:z.enum(['prepared','unknown','cancelled'])}).safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');const b=p.data;return inAuthorizedTransaction(services.db,actor,async tx=>{
  const file=await deliverySource(tx,tenant,'photo_sheet',b.id,false,false);const [old]=await tx`select * from app.photo_share_events where tenant_id=${tenant}::uuid and intent_id=${b.intent_id}::uuid and outcome='prepared'`;
  if(old&&(old.sheet_id!==b.id||old.actor_id!==actor.userId||old.sha256!==file.sha256))throw new ApiFault('IDEMPOTENCY_CONFLICT');if(b.outcome!=='prepared'&&!old)throw new ApiFault('NOT_FOUND');
  await tx`insert into app.photo_share_events(tenant_id,id,sheet_id,actor_id,intent_id,outcome,sha256) values(${tenant}::uuid,${randomUUID()}::uuid,${b.id}::uuid,${actor.userId}::uuid,${b.intent_id}::uuid,${b.outcome},${file.sha256}) on conflict(tenant_id,intent_id,outcome) do nothing`;return {status:200,body:{intent_id:b.intent_id,sha256:file.sha256,outcome:b.outcome,delivery_confirmed:false}};
 });}));
}
