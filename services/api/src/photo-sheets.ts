import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from './routes.js';
import {jsonHash} from './document-issuance.js';
import {PhotoItemSchema,photoEvidence,readPhotoGroup} from './photo-groups.js';
import type {AgentScope} from './agent-tools.js';

export const PhotoSheetSnapshot=z.strictObject({title:z.string().max(120),project_id:z.uuid(),project_name:z.string().max(200),context_id:z.uuid().nullable(),layout:z.union([z.literal(2),z.literal(4)]),grayscale:z.boolean(),photos:z.array(PhotoItemSchema.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/)})).min(1).max(20)});
export const PrepareSheetSchema=z.strictObject({group_id:z.uuid().optional(),layout:z.union([z.literal(2),z.literal(4)]).default(4),grayscale:z.boolean().default(false)});
export async function readPhotoSheet(tx:Tx,tenant:string,id:string){
 const [s]=await tx`select s.*,j.state,j.last_error_code,a.sha256,a.pages from app.photo_sheets s join app.jobs j on j.tenant_id=s.tenant_id and j.photo_sheet_id=s.id left join app.photo_sheet_artifacts a on a.tenant_id=s.tenant_id and a.sheet_id=s.id where s.tenant_id=${tenant}::uuid and s.id=${id}::uuid`;
 if(!s)throw new ApiFault('NOT_FOUND');const snapshot=PhotoSheetSnapshot.parse(s.snapshot);
 for(const p of snapshot.photos){const e=await photoEvidence(tx,tenant,p.revision_id);if(e.sha256!==p.sha256||e.project_id&&e.project_id!==snapshot.project_id||snapshot.context_id&&e.context_id&&e.context_id!==snapshot.context_id)throw new ApiFault('SOURCE_SCOPE_MISMATCH');}
 return {id:String(s.id),group_id:String(s.group_id),group_version:Number(s.group_version),snapshot,state:String(s.state),error_code:s.last_error_code as string|null,sha256:s.sha256 as string|null,pages:s.pages as number|null};
}
export async function preparePhotoSheet(tx:Tx,scope:Pick<AgentScope,'tenant'|'user'|'project'>,input:unknown){
 const parsed=PrepareSheetSchema.safeParse(input);if(!parsed.success)throw new ApiFault('INVALID_CONTRACT');const b=parsed.data;
 if(!scope.project)throw new ApiFault('INVALID_CONTRACT');if(await membership(tx,scope.tenant,scope.user)!=='owner')throw new ApiFault('NOT_FOUND');
 let groupId=b.group_id;
 if(!groupId){const rows=await tx`select id from app.photo_groups where tenant_id=${scope.tenant}::uuid and project_id=${scope.project}::uuid order by created_at desc,id desc limit 2`;if(rows.length!==1)return {photo_choices:true};groupId=String(rows[0]!.id);}
 const g=await readPhotoGroup(tx,scope.tenant,groupId);if(g.project_id!==scope.project)throw new ApiFault('NOT_FOUND');if(g.context_conflict)throw new ApiFault('SOURCE_SCOPE_MISMATCH');
 const snapshot=PhotoSheetSnapshot.parse({title:g.title,project_id:g.project_id,project_name:g.project_name,context_id:g.context_id,layout:b.layout,grayscale:b.grayscale,photos:g.photos}),hash=jsonHash(snapshot);
 await tx`select pg_advisory_xact_lock(hashtextextended(${scope.tenant+':photo-sheet:'+hash},0))`;
 const [old]=await tx`select id from app.photo_sheets where tenant_id=${scope.tenant}::uuid and group_id=${g.id}::uuid and group_version=${g.version} and snapshot_hash=${hash}`;
 let id=old?.id as string|undefined;
 if(!id){id=randomUUID();await tx`insert into app.photo_sheets(tenant_id,id,group_id,group_version,actor_id,snapshot,snapshot_hash) values(${scope.tenant}::uuid,${id}::uuid,${g.id}::uuid,${g.version},${scope.user}::uuid,${tx.json(snapshot)},${hash})`;
  const [j]=await tx`insert into app.jobs(tenant_id,job_type,photo_sheet_id,processor_version,input_hash) values(${scope.tenant}::uuid,'render_photo_sheet',${id}::uuid,'photo-a4-v1',${hash}) returning id`;
  await tx`insert into app.outbox(tenant_id,job_id,topic,operation_key) values(${scope.tenant}::uuid,${j!.id}::uuid,'render_photo_sheet_ready',${'render_photo_sheet:'+j!.id})`;
 }
 return {photo_sheet:{id,title:g.title,state:(await readPhotoSheet(tx,scope.tenant,id)).state}};
}
export function localPhotoPlan(text:string){return /사진\s*대지/u.test(text)&&/준비|만들|작성/u.test(text)?{tool:'prepare_photo_sheet' as const,input:JSON.stringify({layout:/2장|두 장/u.test(text)?2:4,grayscale:/흑백|팩스/u.test(text)})}:null;}
export function registerPhotoSheets(app:FastifyInstance,services:Services){
 app.post('/v1/photo-sheets',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({project_id:z.uuid(),group_id:z.uuid(),layout:z.union([z.literal(2),z.literal(4)]),grayscale:z.boolean()}).safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');const {project_id,...b}=p.data;return inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await preparePhotoSheet(tx,{tenant,user:actor.userId,project:project_id},b)}));}));
 for(const file of [false,true])app.get<{Params:{id:string}}>('/v1/photo-sheets/:id'+(file?'/file':''),async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req),p=z.uuid().safeParse(req.params.id);if(!p.success)throw new ApiFault('INVALID_CONTRACT');return inAuthorizedTransaction(services.db,actor,async tx=>{const s=await readPhotoSheet(tx,tenant,p.data);if(!file)return {status:200,body:s};const [a]=await tx`select bytes,sha256 from app.photo_sheet_artifacts where tenant_id=${tenant}::uuid and sheet_id=${s.id}::uuid`;if(!a)throw new ApiFault('TEMPORARILY_UNAVAILABLE');return {status:200,body:{name:'사진대지.pdf',mime:'application/pdf',sha256:a.sha256,base64:Buffer.from(a.bytes).toString('base64')}};});}));
}
