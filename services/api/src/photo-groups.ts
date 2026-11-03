import {photoPreview} from './photo-preview.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
import {jsonHash} from './document-issuance.js';

export const PhotoItemSchema=z.strictObject({revision_id:z.uuid(),caption:z.string().trim().max(180).default(''),location:z.string().trim().max(100).default(''),taken_date:z.iso.date().nullable().default(null),rotation:z.union([z.literal(0),z.literal(90),z.literal(180),z.literal(270)]).default(0)});
export const PhotoGroupCommandSchema=z.strictObject({client_command_id:z.uuid(),id:z.uuid().optional(),expected_version:z.number().int().positive().optional(),project_id:z.uuid(),context_id:z.uuid().nullable().default(null),title:z.string().trim().min(1).max(120),photos:z.array(PhotoItemSchema).min(1).max(20)});
function parse<T>(schema:z.ZodType<T>,input:unknown):T{const result=schema.safeParse(input);if(!result.success)throw new ApiFault('INVALID_CONTRACT');return result.data;}
export async function photoEvidence(tx:Tx,tenant:string,id:string){
 const [row]=await tx`select r.id,r.declared_mime,r.created_at,b.sha256,b.byte_length,b.storage_key,o.project_id,o.context_id,w.label work_label from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id left join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id left join app.work_contexts w on w.tenant_id=o.tenant_id and w.id=o.context_id where r.tenant_id=${tenant}::uuid and r.id=${id}::uuid and not r.generated_output and r.declared_mime in ('image/jpeg','image/png') and app.revision_accessible(r.tenant_id,r.id)`;
 if(!row)throw new ApiFault('NOT_FOUND');return row;
}
export async function readPhotoGroup(tx:Tx,tenant:string,id:string){
 const [row]=await tx`select g.*,v.title,v.photos,v.snapshot_hash,p.display_name project_name from app.photo_groups g join app.photo_group_versions v on v.tenant_id=g.tenant_id and v.group_id=g.id and v.version=g.version join app.projects p on p.tenant_id=g.tenant_id and p.id=g.project_id where g.tenant_id=${tenant}::uuid and g.id=${id}::uuid`;
 if(!row)throw new ApiFault('NOT_FOUND');let conflict=false;
 for(const photo of row.photos){const source=await photoEvidence(tx,tenant,photo.revision_id);if(source.sha256!==photo.sha256||source.project_id&&source.project_id!==row.project_id||row.context_id&&source.context_id&&source.context_id!==row.context_id)conflict=true;}
 return {id:row.id,version:Number(row.version),project_id:row.project_id,project_name:row.project_name,context_id:row.context_id,title:row.title,photos:row.photos,snapshot_hash:row.snapshot_hash,context_conflict:conflict};
}
export async function savePhotoGroup(tx:Tx,tenant:string,user:string,input:unknown){
 const b=parse(PhotoGroupCommandSchema,input);if(await membership(tx,tenant,user)!=='owner')throw new ApiFault('NOT_FOUND');
 return once(tx,tenant,user,'photos.save',b.client_command_id,jsonHash(b),async()=>{
  const [project]=await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${b.project_id}::uuid`;if(!project)throw new ApiFault('NOT_FOUND');
  if(b.context_id){const [context]=await tx`select id from app.work_contexts where tenant_id=${tenant}::uuid and id=${b.context_id}::uuid and project_id=${b.project_id}::uuid`;if(!context)throw new ApiFault('NOT_FOUND');}
  const photos=[];const seen=new Set<string>();
  for(const p of b.photos){const source=await photoEvidence(tx,tenant,p.revision_id);if(source.project_id&&source.project_id!==b.project_id||b.context_id&&source.context_id&&source.context_id!==b.context_id)throw new ApiFault('SOURCE_SCOPE_MISMATCH');if(seen.has(source.sha256))continue;seen.add(source.sha256);photos.push({...p,sha256:String(source.sha256)});}
  const id=b.id??randomUUID();let version=1;
  if(b.id){const [old]=await tx`select * from app.photo_groups where tenant_id=${tenant}::uuid and id=${id}::uuid for update`;if(!old)throw new ApiFault('NOT_FOUND');if(old.version!==b.expected_version||old.project_id!==b.project_id||old.context_id!==b.context_id)throw new ApiFault('VERSION_CONFLICT');version=Number(old.version)+1;await tx`update app.photo_groups set version=${version} where tenant_id=${tenant}::uuid and id=${id}::uuid`;}
  else{if(b.expected_version)throw new ApiFault('INVALID_CONTRACT');await tx`insert into app.photo_groups(tenant_id,id,project_id,context_id,actor_id) values(${tenant}::uuid,${id}::uuid,${b.project_id}::uuid,${b.context_id}::uuid,${user}::uuid)`;}
  const hash=jsonHash({project_id:b.project_id,context_id:b.context_id,title:b.title,photos});
  await tx`insert into app.photo_group_versions(tenant_id,group_id,version,title,photos,snapshot_hash,actor_id) values(${tenant}::uuid,${id}::uuid,${version},${b.title},${tx.json(photos)},${hash},${user}::uuid)`;
  return {status:200,body:{id,version,photo_count:photos.length,snapshot_hash:hash}};
 });
}
export function registerPhotoGroups(app:FastifyInstance,services:Services){
 app.get<{Params:{id:string}}>('/v1/photos/:id/preview',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),id=parse(z.uuid(),req.params.id);let source:{storage_key:string;sha256:string;byte_length:number}|undefined;await inAuthorizedTransaction(services.db,actor,async tx=>{if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');const p=await photoEvidence(tx,tenant,id);source={storage_key:String(p.storage_key),sha256:String(p.sha256),byte_length:Number(p.byte_length)};return {status:200,body:null};});if(!source)throw new ApiFault("NOT_FOUND");const preview=await photoPreview(source,services);return inAuthorizedTransaction(services.db,actor,async tx=>{await photoEvidence(tx,tenant,id);return {status:200,body:preview};});}));
 app.post('/v1/photos/groups',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,tx=>savePhotoGroup(tx,tenant,actor.userId,req.body));}));
 app.get<{Params:{id:string}}>('/v1/photos/groups/:id',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),id=parse(z.uuid(),req.params.id);return inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await readPhotoGroup(tx,tenant,id)}));}));
 app.get('/v1/photos',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),q=parse(z.strictObject({project_id:z.uuid(),cursor:z.uuid().optional()}),req.query);
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');
   const rows=await tx`select * from (select distinct on(b.sha256) r.id,b.sha256,b.byte_length,r.created_at,o.project_id,o.context_id,w.label work_label from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id left join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id left join app.work_contexts w on w.tenant_id=o.tenant_id and w.id=o.context_id where r.tenant_id=${tenant}::uuid and not r.generated_output and r.declared_mime in ('image/jpeg','image/png') and (o.project_id=${q.project_id}::uuid or o.project_id is null) and app.revision_accessible(r.tenant_id,r.id) order by b.sha256,r.created_at desc,r.id desc) photos where (${q.cursor??null}::uuid is null or (created_at,id)<(select r.created_at,r.id from app.document_revisions r where r.tenant_id=${tenant}::uuid and r.id=${q.cursor??null}::uuid)) order by created_at desc,id desc limit 51`;
   const ordered=rows,page=rows.slice(0,50);
   const groups=await tx`select g.id,v.title,g.version from app.photo_groups g join app.photo_group_versions v on v.tenant_id=g.tenant_id and v.group_id=g.id and v.version=g.version where g.tenant_id=${tenant}::uuid and g.project_id=${q.project_id}::uuid order by g.created_at desc,g.id desc limit 20`;
   const visible=[];for(const g of groups){try{await readPhotoGroup(tx,tenant,String(g.id));visible.push(g);}catch(e){if(!(e instanceof ApiFault)||e.code!=='NOT_FOUND')throw e;}}
   return {status:200,body:{photos:page,next_cursor:ordered.length>50?page.at(-1)?.id:null,groups:visible,original_metadata:'preserved',date_note:'사진에 날짜가 없으면 확인 전으로 남겨요.'}};
  });
 }));
}
