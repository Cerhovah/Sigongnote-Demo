import {z} from "zod";
import {registerWorkSetup} from './work-setup.js';
import type {FastifyInstance} from "fastify";
import {inAuthorizedTransaction} from "./auth.js";
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from "./routes.js";
export function registerWorkActions(app:FastifyInstance,services:Services){
 registerWorkSetup(app,services);
 app.get("/v1/work/guide",async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{
  await membership(tx,tenant,actor.userId);const [progress]=await tx`select step,completed from app.work_guide_progress where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and guide_version='work-v1'`;return {status:200,body:progress??{step:0,completed:false}};
 });}));
 app.post("/v1/work/guide",async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({step:z.number().int().min(0).max(2),completed:z.boolean()}).safeParse(req.body);if(!p.success)throw new ApiFault("INVALID_CONTRACT");return inAuthorizedTransaction(services.db,actor,async tx=>{
  await membership(tx,tenant,actor.userId);await tx`insert into app.work_guide_progress(tenant_id,user_id,guide_version,step,completed) values(${tenant}::uuid,${actor.userId}::uuid,'work-v1',${p.data.step},${p.data.completed}) on conflict(tenant_id,user_id,guide_version) do update set step=excluded.step,completed=excluded.completed,updated_at=now()`;return {status:200,body:{saved:true}};
 });}));
 app.post<{Params:{id:string}}>("/v1/work/materials/:id/organization",async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id),p=z.strictObject({project_id:z.uuid(),version:z.number().int().positive().safe()}).safeParse(req.body);if(!id.success||!p.success)throw new ApiFault("INVALID_CONTRACT");return inAuthorizedTransaction(services.db,actor,async tx=>{
  if(!["owner","operator"].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault("NOT_FOUND");
  const [local]=await tx`select id from app.local_journal_entries where tenant_id=${tenant}::uuid and id=${id.data}::uuid`;
  if(local){const [project]=await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${p.data.project_id}::uuid`;if(!project)throw new ApiFault('NOT_FOUND');const [saved]=await tx`update app.local_journal_entries set project_id=${p.data.project_id}::uuid,version=version+1,updated_at=now() where tenant_id=${tenant}::uuid and id=${id.data}::uuid and version=${p.data.version} returning id`;if(!saved)throw new ApiFault('VERSION_CONFLICT');return {status:200,body:{saved:true,money_confirmed:false}};}
  const [result]=await tx`select app.answer_organization(${tenant}::uuid,${id.data}::uuid,${p.data.version},${p.data.project_id}::uuid) ok`;if(!result?.ok)throw new ApiFault("VERSION_CONFLICT");return {status:200,body:{saved:true,money_confirmed:false}};
 });}));
 app.get<{Params:{id:string}}>("/v1/work/materials/:id/original",async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id);if(!id.success)throw new ApiFault("INVALID_CONTRACT");return inAuthorizedTransaction(services.db,actor,async tx=>{
  if(await membership(tx,tenant,actor.userId)==="viewer")throw new ApiFault("NOT_FOUND");
  const [blob]=await tx`select b.storage_key,b.sniffed_mime,b.sha256 from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id where r.tenant_id=${tenant}::uuid and r.id=${id.data}::uuid and app.revision_accessible(r.tenant_id,r.id)`;
  if(!blob||!services.storage?.readUrl)throw new ApiFault("NOT_FOUND");return {status:200,body:{url:await services.storage.readUrl(String(blob.storage_key)),mime:blob.sniffed_mime,sha256:blob.sha256,expires_in:60}};
 });}));
}
