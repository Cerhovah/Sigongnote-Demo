import { z } from "zod";
import {EvidenceResumeRequestSchema,EvidenceResumeResponseSchema} from '@sigongnote/contracts';
import type { FastifyInstance } from "fastify";
import { inAuthorizedTransaction } from "./auth.js";
import { ApiFault, execute, membership, principal, tenantHeader, type Services } from "./routes.js";

const query=z.strictObject({cursor:z.string().min(1).max(240).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)});
const cursorSchema=z.strictObject({job:z.uuid(),after:z.number().int().min(0)});
function readCursor(value:string|undefined){
 if(!value)return null;
 try {return cursorSchema.parse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));}
 catch {throw new ApiFault("INVALID_CONTRACT");}
}

/** Paginate published source evidence; a cursor never grants access to its source. */
export function registerEvidenceChunkRoutes(app:FastifyInstance,services:Services){
 app.post<{Params:{revision:string}}>("/v1/evidence/:revision/resume",async(request,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request);
  const revision=z.uuid().safeParse(request.params.revision),input=EvidenceResumeRequestSchema.safeParse(request.body);
  if(!revision.success||!input.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(!['owner','operator'].includes(await membership(tx,tenant,actor.userId)))throw new ApiFault('NOT_FOUND');
   const [accessible]=await tx`select app.revision_accessible(${tenant}::uuid,${revision.data}::uuid) ok`;
   if(!accessible?.ok)throw new ApiFault('NOT_FOUND');
   const [result]=await tx`select app.resume_pdf_parse(${tenant}::uuid,${revision.data}::uuid,${input.data.job_id}::uuid,${input.data.resume_generation}) ok`;
   if(!result?.ok)throw new ApiFault('VERSION_CONFLICT');
   return {status:200,body:EvidenceResumeResponseSchema.parse({resumed:true})};
  });
 }));
 app.get<{Params:{revision:string}}>("/v1/evidence/:revision/chunks",async(request,reply)=>execute(reply.header("Cache-Control","no-store"),async()=>{
  const actor=await principal(request,services),tenant=tenantHeader(request);
  const revision=z.uuid().safeParse(request.params.revision),parsed=query.safeParse(request.query);
  if(!revision.success||!parsed.success)throw new ApiFault("INVALID_CONTRACT");
  const cursor=readCursor(parsed.data.cursor),limit=parsed.data.limit;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==="viewer")throw new ApiFault("NOT_FOUND");
   const [source]=await tx`select r.id,b.sha256 from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id where r.tenant_id=${tenant}::uuid and r.id=${revision.data}::uuid and app.revision_accessible(r.tenant_id,r.id)`;
   if(!source)throw new ApiFault("NOT_FOUND");
   const [index]=await tx`select job_id,source_hash,parser_version,manifest,chunk_count from app.evidence_chunk_indexes where tenant_id=${tenant}::uuid and revision_id=${revision.data}::uuid and published order by created_at desc,job_id desc limit 1`;
   const [legacy]=index?[]:await tx`select job_id,processor_version,output from app.parse_results where tenant_id=${tenant}::uuid and revision_id=${revision.data}::uuid order by created_at desc,job_id desc limit 1`;
   const [progress]=await tx`select app.read_pdf_parse_progress(${tenant}::uuid,${revision.data}::uuid) value`;
   const job=index?.job_id??legacy?.job_id??null;
   if(cursor&&cursor.job!==job)throw new ApiFault("VERSION_CONFLICT");
   const rows=job?await tx`select ordinal,text,locator,position from app.revision_search_spans(${tenant}::uuid,${revision.data}::uuid) where ordinal>${cursor?.after??-1} order by ordinal limit ${limit+1}`:[];
   const chunks=rows.slice(0,limit),last=chunks.at(-1);
   return {status:200,body:{revision_id:revision.data,index_job_id:job,source_hash:source.sha256,
    parser_version:index?.parser_version??legacy?.output.parserVersion??null,
    source_status:index?.manifest.sourceStatus??legacy?.output.status??"pending",
    coverage:{...(index?.manifest.coverage??legacy?.output.coverage??{}),...(progress?.value?{pdf_processing:progress.value}:{})},
    complete_extracted_text:Boolean(index),indexed_chunks:Number(index?.chunk_count??legacy?.output.spans?.length??0),
    index_status:index?"complete":legacy?"legacy_excerpt_only":"pending",chunks,
    next_cursor:rows.length>limit&&last?Buffer.from(JSON.stringify({job,after:last.ordinal})).toString("base64url"):null}};
  });
 }));
}
