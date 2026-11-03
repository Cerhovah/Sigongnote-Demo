import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,principal,tenantHeader,type Services} from './routes.js';
import {readReadiness} from './readiness.js';
export function registerMaintenance(app:FastifyInstance,services:Services){
 app.get('/v1/work/maintenance',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   const [row]=await tx`select app.maintenance_status(${tenant}::uuid) summary`;
   if(!row?.summary)throw new ApiFault('NOT_FOUND');
   reply.header('Cache-Control','no-store');
   return {status:200,body:{...row.summary,readiness:await readReadiness(tx,tenant,actor.userId),support_id:randomUUID(),backup:{verified_at:null,status:'not_verified',scope:'server_and_devices'}}};
  });
 }));
}
