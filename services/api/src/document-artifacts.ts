import {z} from 'zod';
import {PublicDocumentSchema} from './public-document.js';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction} from './auth.js';
import {readIssuedDocument,jsonHash} from './document-issuance.js';
import {readDraft} from './document-drafts.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';

export function registerDocumentArtifacts(app:FastifyInstance,services:Services){
 app.get('/v1/documents',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{
  const rows=await tx`select id from app.business_documents where tenant_id=${tenant}::uuid order by created_at desc,id desc limit 100`;const documents=[];
  for(const row of rows){try{const d=await readIssuedDocument(tx,tenant,String(row.id));documents.push({id:d.id,state:d.state,snapshot_hash:d.snapshot_hash,number:d.document.document_number,type:d.document.type,project:d.document.project,total:d.document.totals.total,recipient:d.document.recipient.name});}catch(e){if(!(e instanceof ApiFault)||e.code!=='NOT_FOUND')throw e;}}
  const pending=await tx`select d.id draft_id,d.project_id,coalesce(w.label,p.display_name) label from app.document_drafts d join app.projects p on p.tenant_id=d.tenant_id and p.id=d.project_id left join app.work_contexts w on w.tenant_id=d.tenant_id and w.id=nullif(d.internal_snapshot->'overrides'->>'context_id','')::uuid where d.tenant_id=${tenant}::uuid and not exists(select 1 from app.document_drafts n where n.tenant_id=d.tenant_id and n.supersedes_id=d.id) and not exists(select 1 from app.business_document_revisions b where b.tenant_id=d.tenant_id and b.draft_id=d.id) order by d.created_at desc,d.id limit 20`;
  const prepared=[];for(const p of pending){try{const d=await readDraft(tx,tenant,String(p.draft_id));if(d.latest_id===d.id)prepared.push({id:d.id,type:d.document.type,project_id:p.project_id,work_label:p.label,state:d.state,stale:d.stale});}catch(e){if(!(e instanceof ApiFault)||e.code!=='NOT_FOUND')throw e;}}
  return {status:200,body:{documents,prepared}};
 });}));
 app.get<{Params:{id:string;format:string}}>('/v1/documents/:id/files/:format',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id),format=z.enum(['pdf','xlsx']).safeParse(req.params.format);if(!id.success||!format.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{const doc=await readIssuedDocument(tx,tenant,id.data);if(doc.state!=='approved')throw new ApiFault('DOMAIN_INVARIANT');
   const [file]=await tx`select bytes,sha256 from app.document_artifacts where tenant_id=${tenant}::uuid and revision_id=${doc.revision_id}::uuid and format=${format.data}`;if(!file)throw new ApiFault('TEMPORARILY_UNAVAILABLE');
   const title=({estimate:'견적서',purchase_order:'발주서',invoice:'청구서',delivery_statement:'거래명세서'} as Record<string,string>)[doc.document.type];
   // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filenames must replace every C0 control character, including NUL.
   const project=String(doc.document.project.name).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,60);
   return {status:200,body:{name:`${title}_${doc.document.document_number}_${project}.${format.data}`,mime:format.data==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',sha256:file.sha256,base64:Buffer.from(file.bytes).toString('base64')}};
  });
 }));
 app.post<{Params:{id:string}}>('/v1/documents/:id/render-retry',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id),p=z.strictObject({client_command_id:z.uuid()}).safeParse(req.body);if(!id.success||!p.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{if(await membership(tx,tenant,actor.userId)!=='owner')throw new ApiFault('NOT_FOUND');return once(tx,tenant,actor.userId,'documents.render-retry',p.data.client_command_id,jsonHash({id:id.data}),async()=>{
   const doc=await readIssuedDocument(tx,tenant,id.data);if(doc.state!=='approved')throw new ApiFault('DOMAIN_INVARIANT');
   if(!PublicDocumentSchema.safeParse(doc.document).success)throw new ApiFault('DOMAIN_INVARIANT');
   await tx`select app.retry_document_render(${tenant}::uuid,${doc.revision_id}::uuid)`;
   return {status:200,body:{id:id.data,invoice_unchanged:true}};
  });});
 }));
}
