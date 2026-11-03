import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import type {Tx} from './auth.js';
import {inAuthorizedTransaction} from './auth.js';
import {ApiFault,execute,membership,principal,tenantHeader,once,type Services} from './routes.js';

export async function readSetup(tx:Tx,tenant:string,user:string){
 const [row]=await tx`select project_id,version,dismissed,completed from app.first_site_setup where tenant_id=${tenant}::uuid and user_id=${user}::uuid`;
 const [existing]=row?[]:await tx`select 1 from app.document_revisions r where r.tenant_id=${tenant}::uuid and app.revision_accessible(r.tenant_id,r.id) limit 1`;
 return {project_id:row?.project_id??null,version:Number(row?.version??0),dismissed:row?.dismissed??false,completed:row?.completed??Boolean(existing)};
}
const command=z.strictObject({client_command_id:z.uuid(),expected_version:z.number().int().nonnegative(),action:z.enum(['select','dismiss','complete']),project_id:z.uuid().optional(),display_name:z.string().trim().min(1).max(180).optional()});
export function registerWorkSetup(app:FastifyInstance,services:Services){
 app.get('/v1/work/setup',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('FORBIDDEN');
   return {status:200,body:{...await readSetup(tx,tenant,actor.userId),policy:services.capturePolicy??null}};
  });
 }));
 app.post('/v1/work/setup',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=command.safeParse(req.body);
  if(!p.success)throw new ApiFault('INVALID_CONTRACT');const v=p.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('FORBIDDEN');
   return once(tx,tenant,actor.userId,'POST /v1/work/setup',v.client_command_id,createHash('sha256').update(JSON.stringify(v)).digest('hex'),async()=>{
    await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':'+actor.userId+':setup'},0))`;
    const old=await readSetup(tx,tenant,actor.userId);if(old.version!==v.expected_version)throw new ApiFault('VERSION_CONFLICT');
    let project=old.project_id;
    if(v.action==='select'){
     if(Boolean(v.project_id)===Boolean(v.display_name))throw new ApiFault('INVALID_CONTRACT');
     if(v.project_id){const [found]=await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${v.project_id}::uuid`;if(!found)throw new ApiFault('NOT_FOUND');project=found.id;}
     else {const [created]=await tx`insert into app.projects(tenant_id,display_name) values(${tenant}::uuid,${v.display_name!}) returning id`;project=created!.id;}
    }
    if(v.action==='complete'&&!project)throw new ApiFault('INVALID_CONTRACT');
    await tx`insert into app.first_site_setup(tenant_id,user_id,project_id,version,dismissed,completed) values(${tenant}::uuid,${actor.userId}::uuid,${project}::uuid,1,${v.action==='dismiss'||old.dismissed},${v.action==='complete'||old.completed}) on conflict(tenant_id,user_id) do update set project_id=excluded.project_id,version=app.first_site_setup.version+1,dismissed=excluded.dismissed,completed=excluded.completed,updated_at=now()`;
    return {status:200,body:await readSetup(tx,tenant,actor.userId)};
   });
  });
 }));
 // Fixed route allow-list. Existing endpoints remain the only authority for consent,
 // tenant isolation, revocation, quota, hash verification and idempotency.
 app.post('/v1/work/setup/capture',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req);
  const p=z.strictObject({action:z.enum(['device','source','binding','prepare','complete','abandon']),key:z.uuid(),id:z.uuid().optional(),body:z.record(z.string(),z.unknown())}).safeParse(req.body);
  if(!p.success)throw new ApiFault('INVALID_CONTRACT');const v=p.data;
  const paths={device:'/v1/devices',source:'/v1/capture-sources',binding:'/v1/site-folder-bindings',prepare:'/v1/ingestions',complete:'/v1/ingestions/'+v.id+'/complete',abandon:'/v1/ingestions/'+v.id+'/abandon'};
  if(['complete','abandon'].includes(v.action)&&!v.id)throw new ApiFault('INVALID_CONTRACT');
  await inAuthorizedTransaction(services.db,actor,async tx=>{if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('FORBIDDEN');return {status:200,body:{}};});
  const result=await app.inject({method:'POST',url:paths[v.action],headers:{authorization:String(req.headers.authorization),'x-tenant-id':tenant,'idempotency-key':v.key,'content-type':'application/json'},payload:JSON.stringify(v.body)});
  return {status:result.statusCode,body:result.json()};
 }));
}
