import type { FastifyInstance } from "fastify";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, membership, principal, tenantHeader, type Services } from "./routes.js";
import {readReadiness} from './readiness.js';
import {readSetup} from './work-setup.js';
import {readLocalAiConsent} from './local-journal-sync.js';
export function registerWorkContext(app:FastifyInstance,services:Services){
 app.get("/v1/work/context",async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   const role=await membership(tx,tenant,actor.userId);if(role==="viewer")throw new ApiFault("NOT_FOUND");
   const [company]=await tx`select display_name from app.tenants where id=${tenant}::uuid`;
   const projects=await tx`select id,display_name from app.projects where tenant_id=${tenant}::uuid order by display_name,id limit 1000`;
   if(!company)throw new ApiFault("NOT_FOUND");
   reply.header('Cache-Control','no-store');
   return {status:200,body:{user_id:actor.userId,tenant_id:tenant,company:company.display_name,can_maintain:role==="owner",can_resolve_site:role==="owner"||role==="operator",projects,ai_consent:await readLocalAiConsent(tx,tenant,actor.userId,services.capturePolicy),setup:['owner','operator'].includes(role)?await readSetup(tx,tenant,actor.userId):null,readiness:await readReadiness(tx,tenant,actor.userId)}};
  });
 }));
}
