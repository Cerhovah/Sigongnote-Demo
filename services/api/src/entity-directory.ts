import {createHash} from 'node:crypto';
import {z} from 'zod';
import {EntityObjectRequestSchema,EntityAliasRequestSchema,EntityAliasStatusRequestSchema} from '@sigongnote/contracts';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,principal,tenantHeader,idempotencyKey,membership,once,type Services} from './routes.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function registerEntityDirectory(app:FastifyInstance,services:Services){
 app.get('/v1/entities',async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request);
  return inAuthorizedTransaction(services.db,actor,async tx=>{if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');
   const entities=await tx`select * from app.entity_catalog where tenant_id=${tenant}::uuid order by kind,id limit 20001`;
   const aliases=await tx`select *,alias alias_text from app.entity_aliases where tenant_id=${tenant}::uuid and evidence_revision is not null order by id limit 20001`;
   return {status:200,body:{entities:entities.slice(0,20000),aliases:aliases.slice(0,20000),partial:entities.length>20000||aliases.length>20000}};});
 }));
 for(const kind of ['objects','aliases'] as const)app.post(`/v1/entities/${kind}`,async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request),key=idempotencyKey(request);
  const parsed=(kind==='objects'?EntityObjectRequestSchema:EntityAliasRequestSchema).safeParse(request.body);if(!parsed.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('FORBIDDEN');
   return once(tx,tenant,actor.userId,`POST /v1/entities/${kind}`,key,hash(parsed.data),async()=>{
    const catalog=await tx`select * from app.entity_catalog where tenant_id=${tenant}::uuid`;
    const ref=(id:string|null,target:string)=>!id||catalog.some(c=>c.id===id&&c.kind===target);
    if(kind==='objects'){
     const b=EntityObjectRequestSchema.parse(parsed.data);
     if(!ref(b.project_id,'project')||!ref(b.contract_id,'contract')||!ref(b.party_id,'party')||!ref(b.item_type_id,'item_type'))throw new ApiFault('NOT_FOUND');
     if(b.contract_id&&catalog.find(c=>c.id===b.contract_id&&c.kind==='contract')?.project_id!==b.project_id)throw new ApiFault('INVALID_CONTRACT');
     const [row]=await tx`insert into app.entity_objects(tenant_id,kind,display_name,project_id,contract_id,party_id,role,item_type_id) values(${tenant}::uuid,${b.kind},${b.display_name},${b.project_id}::uuid,${b.contract_id}::uuid,${b.party_id}::uuid,${b.role},${b.item_type_id}::uuid) returning *`;
     return {status:201,body:row};
    }
    const b=EntityAliasRequestSchema.parse(parsed.data);
    if(!ref(b.target_id,b.target_kind)||(b.scope==='company'?b.scope_id!==tenant:!ref(b.scope_id,b.scope)))throw new ApiFault('NOT_FOUND');
    const [evidence]=await tx`select text from app.revision_search_spans(${tenant}::uuid,${b.evidence_revision}::uuid) where locator=${b.evidence_locator} and app.revision_accessible(${tenant}::uuid,${b.evidence_revision}::uuid)`;
    if(!evidence||!String(evidence.text).normalize('NFKC').toLowerCase().includes(b.alias_text.normalize('NFKC').toLowerCase()))throw new ApiFault('INVALID_CONTRACT');
    const [row]=await tx`insert into app.entity_aliases(tenant_id,actor_id,target_kind,target_id,alias,scope,scope_id,role,valid_from,valid_until,evidence_revision,evidence_locator) values(${tenant}::uuid,${actor.userId}::uuid,${b.target_kind},${b.target_id}::uuid,${b.alias_text},${b.scope},${b.scope_id}::uuid,${b.role},${b.valid_from}::timestamptz,${b.valid_until}::timestamptz,${b.evidence_revision}::uuid,${b.evidence_locator}) returning *`;
    return {status:201,body:row};
   });
  });
 }));
 app.post<{Params:{id:string}}>('/v1/entities/aliases/:id/status',async(request,reply)=>execute(reply,async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request),key=idempotencyKey(request),id=z.uuid().safeParse(request.params.id),body=EntityAliasStatusRequestSchema.safeParse(request.body);
  if(!id.success||!body.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('FORBIDDEN');
   return once(tx,tenant,actor.userId,`POST /v1/entities/aliases/${id.data}/status`,key,hash(body.data),async()=>{
    const [old]=await tx`select version from app.entity_aliases where tenant_id=${tenant}::uuid and id=${id.data}::uuid for update`;if(!old)throw new ApiFault('NOT_FOUND');
    if(Number(old.version)!==body.data.expected_version)throw new ApiFault('VERSION_CONFLICT',Number(old.version));
    const [row]=await tx`update app.entity_aliases set status=${body.data.status},version=version+1 where tenant_id=${tenant}::uuid and id=${id.data}::uuid returning *`;
    return {status:200,body:row};
   });
  });
 }));
}
