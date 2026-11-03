import { createHash } from "node:crypto";
import {
 ProjectCreateRequestSchema,ProjectResponseSchema,
 SiteFolderBatchRequestSchema,SiteFolderBindingRequestSchema,SiteFolderBindingResponseSchema,SiteFolderBindingsResponseSchema,
} from "@sigongnote/contracts";
import type { FastifyInstance } from "fastify";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault,execute,principal,tenantHeader,idempotencyKey,membership,once,type Services } from "./routes.js";

const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function binding(row:Record<string,unknown>) {
 return SiteFolderBindingResponseSchema.parse({id:row.id,source_id:row.source_id,
  source_generation:Number(row.source_generation),scope_fingerprint:row.scope_fingerprint,
  scope_mode:row.scope_mode,project_id:row.project_id,version:Number(row.version),display_name:row.display_name??null});
}
export function registerSiteFolderRoutes(app:FastifyInstance,services:Services) {
 app.post("/v1/projects",async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request),key=idempotencyKey(request);
  const parsed=ProjectCreateRequestSchema.safeParse(request.body);
  if(!parsed.success)throw new ApiFault("INVALID_CONTRACT");
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!["owner","operator"].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault("FORBIDDEN");
   return once(tx,tenant,actor.userId,"POST /v1/projects",key,hash(parsed.data),async()=>{
    const [row]=await tx`insert into app.projects(tenant_id,display_name)
     values (${tenant}::uuid,${parsed.data.display_name}) returning id,display_name,version`;
    return {status:201,body:ProjectResponseSchema.parse({...row,version:Number(row?.version)})};
   });
  });
 }));
 app.get("/v1/site-folder-bindings",async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   await membership(tx,tenant,actor.userId);
   const rows=await tx`select b.* from app.site_folder_bindings b
    join app.capture_sources s on s.tenant_id=b.tenant_id and s.id=b.source_id
    join app.devices d on d.tenant_id=s.tenant_id and d.id=s.device_id
    where b.tenant_id=${tenant}::uuid and b.user_id=${actor.userId}::uuid
    and s.active and d.active and s.generation=b.source_generation order by b.created_at,b.id`;
   return {status:200,body:SiteFolderBindingsResponseSchema.parse({bindings:rows.map(binding)})};
  });
 }));
 app.post("/v1/site-folder-bindings/batch",async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request);
  const p=SiteFolderBatchRequestSchema.safeParse(request.body);if(!p.success)throw new ApiFault("INVALID_CONTRACT");const key=p.data.client_command_id;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!["owner","operator"].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault("FORBIDDEN");
   return once(tx,tenant,actor.userId,"POST /v1/site-folder-bindings/batch",key,hash(p.data),async()=>{
    const [r]=await tx`select app.correct_folder_bindings(${tenant}::uuid,${key}::uuid,${tx.json(p.data.changes)}) result`;
    if(!r?.result?.ok)throw new ApiFault(r?.result?.code??"VERSION_CONFLICT");
    return {status:200,body:SiteFolderBindingsResponseSchema.parse({bindings:r.result.bindings.map(binding)})};
   });
  });
 }));
 app.post("/v1/site-folder-bindings",async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request),key=idempotencyKey(request);
  const parsed=SiteFolderBindingRequestSchema.safeParse(request.body);
  if(!parsed.success)throw new ApiFault("INVALID_CONTRACT");
  const body=parsed.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!["owner","operator"].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault("FORBIDDEN");
   return once(tx,tenant,actor.userId,"POST /v1/site-folder-bindings",key,hash(body),async()=>{
    const [reference]=await tx`select device_id from app.capture_sources
     where tenant_id=${tenant}::uuid and id=${body.source_id}::uuid and user_id=${actor.userId}::uuid`;
    if(!reference)throw new ApiFault("NOT_FOUND");
    // Device revocation locks device before sources; keep that order here too.
    const [device]=await tx`select active from app.devices where tenant_id=${tenant}::uuid
     and id=${reference.device_id}::uuid and user_id=${actor.userId}::uuid for share`;
    const [source]=await tx`select * from app.capture_sources where tenant_id=${tenant}::uuid
     and id=${body.source_id}::uuid and user_id=${actor.userId}::uuid for share`;
    if(!source)throw new ApiFault("NOT_FOUND");
    if(!source.active || !device?.active || Number(source.generation)!==body.source_generation)
     throw new ApiFault("SOURCE_EXPIRED");
    if(!["folder","photos","call_recording","manual_share","sms"].includes(String(source.kind)))throw new ApiFault("INVALID_CONTRACT");
    if(body.project_id){
     const [project]=await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${body.project_id}::uuid`;
     if(!project)throw new ApiFault("NOT_FOUND");
    }
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:binding:${body.source_id}:${body.source_generation}:${body.scope_fingerprint}`},0))`;
    const [old]=await tx`select * from app.site_folder_bindings where tenant_id=${tenant}::uuid
     and source_id=${body.source_id}::uuid and source_generation=${body.source_generation}
     and scope_fingerprint=${body.scope_fingerprint}`;
    if(old){
     if(old.project_id!==body.project_id || old.scope_mode!==body.scope_mode)throw new ApiFault("IDEMPOTENCY_CONFLICT");
     return {status:200,body:binding(old)};
    }
    const [row]=await tx`insert into app.site_folder_bindings
     (tenant_id,user_id,device_id,source_id,source_generation,scope_fingerprint,scope_mode,project_id,display_name)
     values (${tenant}::uuid,${actor.userId}::uuid,${source.device_id}::uuid,${body.source_id}::uuid,
      ${body.source_generation},${body.scope_fingerprint},${body.scope_mode},${body.project_id}::uuid,${body.display_name??null}) returning *`;
    if(!row)throw new ApiFault("NOT_FOUND");
    return {status:201,body:binding(row)};
   });
  });
 }));
}
