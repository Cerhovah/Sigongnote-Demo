import { organizeNext } from "./organize-worker.js";
import {parseNotification} from './notification-parser.js';
import {MESSAGE_MIME,messageTextChunks,parseMessageBundle,readMessageBundle} from './message-bundle.js';
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Db } from "./auth.js";
import type { CapturePolicy } from "./capture-scope.js";
import { mergePdfManifest, mergePdfOutput } from './pdf-continuation.js';

export const PARSE_PROCESSOR = "document-python-v1";
export const EVIDENCE_PROCESSOR = "document-evidence-v1";
export const PDF_PROCESSOR = "document-pdf-pages-v1";
export const evidenceChunkSchema=z.strictObject({ordinal:z.number().int().min(0),text:z.string().min(1).max(1000),
 locator:z.string().min(1).max(1000),position:z.record(z.string(),z.json()),contentHash:z.string().regex(/^[a-f0-9]{64}$/)});
export type EvidenceChunk=z.infer<typeof evidenceChunkSchema>;
const evidenceManifest=z.strictObject({schemaVersion:z.literal("evidence-chunks-v1"),chunkCount:z.number().int().min(0),
 parserVersion:z.string().max(100),sourceStatus:z.string().max(30),coverage:z.record(z.string(),z.json()),completeExtractedText:z.boolean()});
export type EvidenceManifest=z.infer<typeof evidenceManifest>;
export type EvidenceSink={begin:(manifest:EvidenceManifest)=>Promise<void>;append:(chunks:EvidenceChunk[])=>Promise<void>};
const span = z.object({ text:z.string().max(1000), locator:z.string().max(300) });
const excerptSchema = z.object({status:z.enum(["complete","partial","encrypted","corrupt","unsupported","quarantined","failed"]),
 sourceHash:z.string().regex(/^[a-f0-9]{64}$/),parserVersion:z.string().max(100),spans:z.array(span).max(1000),
 excerptTruncated:z.boolean(),issues:z.array(z.string().max(100)).max(40),coverage:z.record(z.string(),z.json()).default({}),evidence:evidenceManifest.optional()});
export type ParseOutput=z.infer<typeof excerptSchema>&{processorVersion:string;schemaVersion:string;decoderVersion:string;modelVersion:null;promptVersion:null};
const extensions:Record<string,string> = {"text/plain":".txt","text/csv":".csv","application/pdf":".pdf",
 "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":".xlsx","application/vnd.ms-excel":".xls",
 "application/x-hwp":".hwp","application/haansofthwp":".hwp","application/vnd.hancom.hwp":".hwp",
 "application/vnd.hancom.hwpx":".hwpx","application/hwp+zip":".hwpx","image/jpeg":".jpg","image/png":".png","image/webp":".webp"};
export type ParseInput = {storage_key:string;byte_length:string|number;sha256:string;mime:string};
export type WorkerOptions = {db:Db;policy:CapturePolicy;download:(input:ParseInput,signal:AbortSignal)=>Promise<Uint8Array>;
 python:string;pythonRoot:string;timeoutMs?:number;owner?:string;tenantScope?:string;pdfBatchPages?:number};
export function parserEnvironment(root:string){
 const env:NodeJS.ProcessEnv={PYTHONPATH:resolve(root,"src"),PYTHONIOENCODING:"utf-8",PYTHONNOUSERSITE:"1"};
 for(const name of ["PATH","SystemRoot","SYSTEMROOT","TEMP","TMP","LOCALAPPDATA","PROGRAMFILES","SIGONGNOTE_TESSERACT","SIGONGNOTE_TESSDATA_DIR"])if(process.env[name])env[name]=process.env[name];
 return env;
}
export function rendererEnvironment(root:string,fontPath=process.env.SIGONGNOTE_PDF_FONT_PATH){
 const env=parserEnvironment(root);
 if(fontPath)env.SIGONGNOTE_PDF_FONT_PATH=fontPath;
 return env;
}

export async function parseBytes(bytes:Uint8Array,mime:string,options:Pick<WorkerOptions,"python"|"pythonRoot">,signal:AbortSignal,sink?:EvidenceSink,pdfWindow?:{startPage:number;pageLimit:number}):Promise<ParseOutput> {
 if(signal.aborted)throw new Error('PARSER_UNAVAILABLE');
 if(mime==='application/json'){
  const {output,chunks}=parseNotification(bytes);
  if(sink){await sink.begin(output.evidence!);for(let offset=0;offset<chunks.length;offset+=200){if(signal.aborted)throw Error('PARSER_UNAVAILABLE');await sink.append(chunks.slice(offset,offset+200));}}
  return output;
 }
 if(mime===MESSAGE_MIME){
  const source=readMessageBundle(bytes),chunks:EvidenceChunk[]=[];let partIndex=0;
  for(const [line,text] of source.body.split(/\r?\n/).entries())for(const {start,text:value} of messageTextChunks(text)){chunks.push({ordinal:chunks.length,text:value,locator:`message:body:${line+1}:${start}`,position:{character_start:start,character_end:start+value.length,character_unit:'utf16_code_unit'},contentHash:createHash('sha256').update(value).digest('hex')});}
  const out=await parseMessageBundle(bytes,(image,type)=>{const id=source.parts[partIndex++]!.id;return parseBytes(image,type,options,signal,{begin:async()=>{},append:async batch=>{for(const c of batch)chunks.push({...c,ordinal:chunks.length,locator:`message:part:${id}:${c.locator}`});}});});
  const evidence:EvidenceManifest={schemaVersion:'evidence-chunks-v1',chunkCount:chunks.length,parserVersion:out.parserVersion,sourceStatus:out.status,coverage:{occurred_at:source.occurred_at,direction:source.direction,parts_seen:source.parts.length+source.missing_parts,parts_read:source.parts.length},completeExtractedText:true};
  if(sink){await sink.begin(evidence);for(let start=0;start<chunks.length;start+=200){if(signal.aborted)throw Error('PARSER_UNAVAILABLE');await sink.append(chunks.slice(start,start+200));}}
  return {...out,status:out.status as ParseOutput['status'],coverage:evidence.coverage,evidence};
 }
 const hash=createHash("sha256").update(bytes).digest("hex");
 const directory=await mkdtemp(join(tmpdir(),"sigongnote-parse-"));
 try {
  const file=join(directory,`original${extensions[mime]??".unsupported"}`);
  await writeFile(file,bytes,{mode:0o600});
  const raw=await new Promise<string>((done,reject)=>{
   const child=spawn(options.python,["-m","sigongnote_worker"],{cwd:resolve(options.pythonRoot),windowsHide:true,
    env:parserEnvironment(options.pythonRoot),stdio:["pipe","pipe","pipe"],signal});
   let output="";let count=0;let overflow=false;
   child.stdout.setEncoding("utf8");
   child.stdout.on("data",(chunk:string)=>{count+=Buffer.byteLength(chunk);if(count>4194304){overflow=true;child.kill();}else output+=chunk;});
   // Never send source-bearing diagnostics to process logs.
   child.stderr.resume();child.on("error",()=>reject(new Error("PARSER_UNAVAILABLE")));
   child.on("close",code=>code===0&&!overflow?done(output):reject(new Error("PARSER_FAILED")));
   child.stdin.on("error",()=>{});
   child.stdin.end(JSON.stringify({path:file,output:join(directory,"parsed.json"),evidence_output:join(directory,"evidence.jsonl"),
    ...(pdfWindow?{pdf_start_page:pdfWindow.startPage,pdf_page_limit:pdfWindow.pageLimit}:{})})+"\n");
  });
  const parsed=excerptSchema.parse(JSON.parse(raw));
  if(parsed.sourceHash!==hash)throw new Error("PARSER_HASH_MISMATCH");
  if(!parsed.evidence)throw Error('EVIDENCE_MANIFEST_MISSING');
  if(sink){
   await sink.begin(parsed.evidence);let count=0;let batch:EvidenceChunk[]=[];
   const input=createReadStream(join(directory,'evidence.jsonl'),{encoding:'utf8',signal});
   try{for await(const line of createInterface({input,crlfDelay:Infinity})){
    if(signal.aborted)throw Error('PARSER_UNAVAILABLE');
    const chunk=evidenceChunkSchema.parse(JSON.parse(line));
    if(chunk.ordinal!==count++||createHash('sha256').update(chunk.text).digest('hex')!==chunk.contentHash)throw Error('EVIDENCE_CHUNK_INVALID');
    batch.push(chunk);if(batch.length===200){await sink.append(batch);batch=[];}
   }if(batch.length)await sink.append(batch);
   if(count!==parsed.evidence.chunkCount)throw Error('EVIDENCE_COUNT_MISMATCH');
   }finally{input.destroy();}
  }
  return {...parsed,status:parsed.excerptTruncated&&parsed.status==="complete"?"partial":parsed.status,
   processorVersion:PARSE_PROCESSOR,schemaVersion:"parse-output-v1",decoderVersion:"python-mime-v1",modelVersion:null,promptVersion:null};
 } finally {await rm(directory,{recursive:true,force:true});}
}

/** One durable lease; the UI never owns or drives this process. */
export async function runParseOnce(options:WorkerOptions):Promise<"idle"|"stored"|"continued"|"retry"|"stale"> {
 const {db}=options;
 const owner=options.owner??`parse-${process.pid}`;
 let [lease]=options.tenantScope?await db`select * from app.claim_parse_job_for_tenant(${owner},60,${PARSE_PROCESSOR},${options.tenantScope}::uuid)`:
  await db`select * from app.claim_parse_job(${owner},60,${PARSE_PROCESSOR})`;
 if(!lease)[lease]=options.tenantScope?await db`select * from app.claim_parse_job_for_tenant(${owner},60,${EVIDENCE_PROCESSOR},${options.tenantScope}::uuid)`:
  await db`select * from app.claim_parse_job(${owner},60,${EVIDENCE_PROCESSOR})`;
 if(!lease)[lease]=options.tenantScope?await db`select * from app.claim_parse_job_for_tenant(${owner},60,${PDF_PROCESSOR},${options.tenantScope}::uuid)`:
  await db`select * from app.claim_parse_job(${owner},60,${PDF_PROCESSOR})`;
 if(!lease){try{await organizeNext(options);}catch{/* Connection failure is retried by the next worker cycle. */}return "idle";}
 const tenant=String(lease.tenant_id),job=String(lease.job_id),token=String(lease.lease_token);
 let timedOut=false,parsingPdf=false,pageLimit=options.pdfBatchPages??20;
 const controller=new AbortController();
 let timeout=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs??180000);
 let heartbeatBusy=false;
 const heartbeat=setInterval(()=>{
  if(heartbeatBusy)return;heartbeatBusy=true;
  void db`select app.extend_parse_job_lease(${tenant}::uuid,${job}::uuid,${token}::uuid,60) ok`
   .then(rows=>{if(!rows[0]?.ok)controller.abort();},()=>controller.abort()).finally(()=>{heartbeatBusy=false;});
 },15000);
 try {
  if(![PARSE_PROCESSOR,EVIDENCE_PROCESSOR,PDF_PROCESSOR].includes(String(lease.processor_version)))throw new Error("PROCESSOR_UNAVAILABLE");
  const [input]=await db`select * from app.parse_job_input(${tenant}::uuid,${job}::uuid,${token}::uuid,${db.json(options.policy)})`;
  if(!input)throw new Error("SOURCE_UNAVAILABLE");
  const bytes=await options.download(input as ParseInput,controller.signal);
  if(bytes.length<Number(input.byte_length))throw new Error("DOWNLOAD_INCOMPLETE");
  if(bytes.length!==Number(input.byte_length)||createHash("sha256").update(bytes).digest("hex")!==input.sha256)throw new Error("SOURCE_HASH_MISMATCH");
  const isPdf=input.mime==='application/pdf';
  const progress=isPdf?(await db`select app.pdf_parse_progress(${tenant}::uuid,${job}::uuid,${token}::uuid,${db.json(options.policy)}) progress`)[0]?.progress:null;
  if(isPdf&&!progress)throw Error('SOURCE_UNAVAILABLE');
  const previous=(progress?.output??null) as ParseOutput|null,startPage=Number(progress?.nextPage??1),offset=Number(progress?.chunkCount??0);
  pageLimit=Math.min(pageLimit,Number(progress?.pageLimit??pageLimit));parsingPdf=isPdf;
  clearTimeout(timeout);timeout=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs??180000);
  let output=await parseBytes(bytes,String(input.mime),options,controller.signal,{
   begin:async manifest=>{
    const [r]=isPdf?await db`select app.begin_pdf_evidence_batch(${tenant}::uuid,${job}::uuid,${token}::uuid,${startPage},${db.json(mergePdfManifest(previous,manifest,startPage))},${db.json(options.policy)}) ok`:
     await db`select app.begin_evidence_index(${tenant}::uuid,${job}::uuid,${token}::uuid,${db.json(manifest)},${db.json(options.policy)}) ok`;
    if(!r?.ok)throw Error('SOURCE_UNAVAILABLE');
   },
   append:async chunks=>{const [r]=await db`select app.stage_evidence_chunks(${tenant}::uuid,${job}::uuid,${token}::uuid,${db.json(chunks.map(c=>({...c,ordinal:c.ordinal+offset})))},${db.json(options.policy)}) ok`;if(!r?.ok)throw Error('SOURCE_UNAVAILABLE');},
  },isPdf?{startPage,pageLimit}:undefined);
  parsingPdf=false;
  if(isPdf)output=mergePdfOutput(previous,output,startPage);
  output.processorVersion=String(lease.processor_version);
  const [result]=isPdf?await db`select app.checkpoint_pdf_parse(${tenant}::uuid,${job}::uuid,${token}::uuid,${startPage},${db.json(output)},${db.json(options.policy)}) ok`:
   await db`select app.complete_parse_output(${tenant}::uuid,${job}::uuid,${token}::uuid,${db.json(output)},${db.json(options.policy)}) ok`;
  if(isPdf&&output.coverage.next_page!=null)return result?.ok?'continued':'stale';
  if(result?.ok){try{await organizeNext(options);}catch{/* A saved parse remains saved; next idle cycle resumes organization. */}}
  return result?.ok?"stored":"stale";
 } catch(error) {
  if(timedOut&&parsingPdf){
   await db`select app.fail_pdf_timeout(${tenant}::uuid,${job}::uuid,${token}::uuid,${pageLimit},${db.json(options.policy)})`;
   return 'retry';
  }
  const code=error instanceof Error&&["PROCESSOR_UNAVAILABLE","SOURCE_UNAVAILABLE","SOURCE_HASH_MISMATCH"].includes(error.message)?error.message:"PARSER_RETRY";
  await db`select app.fail_parse_job(${tenant}::uuid,${job}::uuid,${token}::uuid,${code},${code==="PARSER_RETRY"||code==="SOURCE_UNAVAILABLE"})`;
  return "retry";
 } finally {clearTimeout(timeout);clearInterval(heartbeat);controller.abort();}
}

export async function assertWorkerRole(db:Db) {
 const [role]=await db`select current_user name,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
 exists(select 1 from pg_auth_members where member=pg_roles.oid) member from pg_roles where rolname=current_user`;
 if(role?.name!=="sigongnote_worker"||role.rolsuper||role.rolbypassrls||role.rolcreaterole||role.rolcreatedb||role.rolreplication||role.member)throw new Error("WORKER_ROLE_INVALID");
}
export function workerOwner(){return `parse-${randomUUID()}`;}
