import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {readIssuedDocument} from './document-issuance.js';
import {readPhotoSheet} from './photo-sheets.js';
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from './routes.js';

export function registerSyncChanges(app:FastifyInstance,services:Services){
 app.get('/v1/sync/changes',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),p=z.strictObject({sync_version:z.literal('2').optional(),cursor:z.string().max(120).optional(),kind:z.enum(['material','document','photo_sheet']).optional(),id:z.uuid().optional()}).safeParse(req.query);if(!p.success||Boolean(p.data.id)!==Boolean(p.data.kind)||(p.data.id&&p.data.cursor))throw new ApiFault('INVALID_CONTRACT');
  const scope=`${tenant}:${actor.userId}:`,cursor=p.data.cursor;
  if(cursor&&(!cursor.startsWith(scope)||!/^\d{1,19}$/.test(cursor.slice(scope.length))))throw new ApiFault('INVALID_CONTRACT');
  const after=cursor?BigInt(cursor.slice(scope.length)):0n;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');
   const [head]=await tx`select position,(select max(c.position) from app.sync_changes c where c.tenant_id=${tenant}::uuid and c.kind='reset') reset_sequence from app.sync_heads where tenant_id=${tenant}::uuid`;
   if(after>BigInt(head?.position??0))throw new ApiFault('INVALID_CONTRACT');
   const rows=p.data.id?[{position:0,kind:p.data.kind,target_id:p.data.id,removed:false}]:await tx`select position,kind,target_id,removed from app.sync_changes where tenant_id=${tenant}::uuid and position>${after.toString()}::bigint order by position limit 51`;
   const changes=[];
   for(const r of rows.slice(0,50)){
    if(r.kind==='photo_sheet'&&!p.data.sync_version&&!p.data.id)continue;
    const base={sequence:String(r.position),kind:String(r.kind),id:r.target_id};
    if(r.kind==='reset'||r.target_id==null){changes.push({...base,kind:'reset',tombstone:true});continue;}
    if(r.kind==='document'){
     try{const d=await readIssuedDocument(tx,tenant,String(r.target_id));changes.push({...base,tombstone:d.state!=='approved',title:d.document.document_number,revision_id:d.revision_id,sha256:d.snapshot_hash,project_id:d.document.project.id,project_name:d.document.project.name,state:d.state,files:d.files});}
     catch(e){if(!(e instanceof ApiFault)||!['NOT_FOUND','DOMAIN_INVARIANT'].includes(e.code))throw e;changes.push({...base,tombstone:true});}
    }else if(r.kind==='photo_sheet'){
     try{const s=await readPhotoSheet(tx,tenant,String(r.target_id));const [project]=await tx`select display_name from app.projects where tenant_id=${tenant}::uuid and id=${s.snapshot.project_id}::uuid`;changes.push({...base,tombstone:false,title:s.snapshot.title,revision_id:s.id,project_id:s.snapshot.project_id,project_name:project?.display_name??null,state:s.state,files:s.sha256?[{format:'pdf',sha256:s.sha256}]:[]});}
     catch(e){if(!(e instanceof ApiFault)||!['NOT_FOUND','SOURCE_SCOPE_MISMATCH'].includes(e.code))throw e;changes.push({...base,tombstone:true});}
    }else{
     const [material]=await tx`select r.id revision_id,r.document_id,r.revision_number,left(coalesce((select p.output->'spans'->0->>'text' from app.parse_results p where p.tenant_id=r.tenant_id and p.revision_id=r.id order by p.created_at desc limit 1),'업무자료'),60) title,b.sha256,b.byte_length,b.sniffed_mime mime,r.declared_mime,app.mirror_copy_allowed(r.tenant_id,r.id) copy_allowed,o.project_id,(select display_name from app.projects p where p.tenant_id=o.tenant_id and p.id=o.project_id) project_name,o.state organization_state,o.categories,o.version work_revision,o.context_id work_id,r.parse_state state from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id left join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id where r.tenant_id=${tenant}::uuid and r.id=${r.target_id}::uuid and not r.generated_output and app.revision_accessible(r.tenant_id,r.id)
      and (${p.data.sync_version??(p.data.id?'2':null)}::text is null or not exists(select 1 from app.document_revisions newer where newer.tenant_id=r.tenant_id and newer.document_id=r.document_id and newer.revision_number>r.revision_number))`;
     changes.push(material?{...base,tombstone:false,...material,revision_number:Number(material.revision_number)}:{...base,tombstone:true});
    }
   }
   const position=rows.slice(0,50).at(-1)?.position??after.toString();
   return {status:200,body:{changes,reset_sequence:String(head?.reset_sequence??0),next_cursor:scope+String(position),has_more:rows.length>50}};
  });
 }));
}
