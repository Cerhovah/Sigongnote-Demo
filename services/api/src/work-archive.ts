import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
export function registerArchiveProcessing(app:FastifyInstance,services:Services){
 app.get('/v1/work/archive',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)!=='owner')throw new ApiFault('NOT_FOUND');
   const [p]=await tx`select enabled,version::int from app.archive_processing where tenant_id=${tenant}::uuid`;
   const [counts]=await tx`select count(*) filter(where state in ('queued','retry_wait'))::int waiting,count(*) filter(where state='leased')::int running,count(*) filter(where state='succeeded')::int finished from app.jobs where tenant_id=${tenant}::uuid and job_type='parse_original' and work_lane='archive'`;
   return {status:200,body:{enabled:p?.enabled??false,version:p?.version??0,...counts}};
  });
 }));
 app.post('/v1/work/archive',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=z.union([z.strictObject({client_command_id:z.uuid(),revision_id:z.uuid()}),z.strictObject({client_command_id:z.uuid(),expected_version:z.number().int().nonnegative(),enabled:z.boolean()})]).safeParse(req.body);
  if(!p.success)throw new ApiFault('INVALID_CONTRACT');const c=p.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)!=='owner')throw new ApiFault('NOT_FOUND');
   if('revision_id' in c){
    await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':reference:'+c.revision_id},0))`;
    const [r]=await tx`select r.id from app.document_revisions r where r.tenant_id=${tenant}::uuid and r.id=${c.revision_id}::uuid and app.revision_accessible(r.tenant_id,r.id) and not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number) and r.declared_mime not in ('image/vnd.dwg','image/x-dwg','application/acad','application/x-autocad','application/x-dwg','application/dxf','image/vnd.dxf')`;
    if(!r)throw new ApiFault('NOT_FOUND');
    return once(tx,tenant,actor.userId,'archive.reference',c.client_command_id,createHash('sha256').update(JSON.stringify(c)).digest('hex'),async()=>{
     await tx`update app.jobs set work_lane='current' where tenant_id=${tenant}::uuid and evidence_revision_id=${c.revision_id}::uuid and job_type='parse_original'`;
     return {status:200,body:{saved:true}};
    });
   }
   return once(tx,tenant,actor.userId,'archive.processing',c.client_command_id,createHash('sha256').update(JSON.stringify(c)).digest('hex'),async()=>{
    await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':archive'},0))`;
    const [old]=await tx`select version from app.archive_processing where tenant_id=${tenant}::uuid`;
    if(Number(old?.version??0)!==c.expected_version)throw new ApiFault('VERSION_CONFLICT');
    const [row]=await tx`insert into app.archive_processing(tenant_id,enabled,actor_id) values(${tenant}::uuid,${c.enabled},${actor.userId}::uuid) on conflict(tenant_id) do update set enabled=excluded.enabled,actor_id=excluded.actor_id,version=app.archive_processing.version+1,updated_at=now() returning enabled,version::int`;
    return {status:200,body:row};
   });
  });
 }));
}
