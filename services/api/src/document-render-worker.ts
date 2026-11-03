import {PublicDocumentSchema} from './public-document.js';
import {spawn} from 'node:child_process';
import type {Db} from './auth.js';
import {rendererEnvironment} from './parse-worker.js';

type RenderOptions={db:Db;python:string;pythonRoot:string;owner?:string;tenantScope?:string;timeoutMs?:number;fontPath?:string};
export async function renderDocumentBytes(snapshot:unknown,options:Pick<RenderOptions,'python'|'pythonRoot'|'fontPath'>,signal:AbortSignal){
 const parsed=PublicDocumentSchema.safeParse(snapshot);
 if(!parsed.success)throw new Error('INVALID_PUBLIC_DOCUMENT');
 const safe=parsed.data;
 const output=await new Promise<string>((resolve,reject)=>{
  const child=spawn(options.python,['-m','sigongnote_worker.business_document'],{windowsHide:true,env:rendererEnvironment(options.pythonRoot,options.fontPath),stdio:['pipe','pipe','pipe'],signal});
  let text='',bytes=0,overflow=false;child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{bytes+=Buffer.byteLength(chunk);if(bytes>14500000){overflow=true;child.kill();}else text+=chunk;});
  child.stderr.resume();child.on('error',()=>reject(new Error('RENDER_UNAVAILABLE')));child.on('close',code=>code===0&&!overflow?resolve(text):reject(new Error('RENDER_FAILED')));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(safe)+'\n');
 });
 const result=JSON.parse(output) as Record<string,unknown>;
 const decode=(key:string)=>{const raw=result[key];if(typeof raw!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(raw))throw new Error('INVALID_RENDER');const bytes=Buffer.from(raw,'base64');if(bytes.length===0||bytes.length>5242880)throw new Error('RENDER_LIMIT');return bytes;};
 const pdf=decode('pdf'),xlsx=decode('xlsx');if(pdf.subarray(0,5).toString()!=='%PDF-'||xlsx.subarray(0,2).toString()!=='PK')throw new Error('INVALID_RENDER');return {pdf,xlsx};
}
export async function runRenderOnce(options:RenderOptions){
 const {db}=options;const [job]=await db`select * from app.claim_render_job(${options.owner??'render-worker'},${options.tenantScope??null}::uuid)`;if(!job)return 'idle';
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),options.timeoutMs??45000);
 let extending=false;
 const heartbeat=setInterval(()=>{if(extending)return;extending=true;void db`select app.extend_parse_job_lease(${job.tenant_id}::uuid,${job.job_id}::uuid,${job.lease_token}::uuid,60) ok`.then(rows=>{if(!rows[0]?.ok)controller.abort();},()=>controller.abort()).finally(()=>{extending=false;});},15000);
 try{
  const [input]=await db`select * from app.render_job_input(${job.tenant_id}::uuid,${job.job_id}::uuid,${job.lease_token}::uuid)`;
  if(!input){await db`select app.fail_parse_job(${job.tenant_id}::uuid,${job.job_id}::uuid,${job.lease_token}::uuid,'RENDER_SOURCE_UNAVAILABLE',false)`;return 'unavailable';}
  const files=await renderDocumentBytes(input.snapshot,options,controller.signal);
  const [result]=await db`select app.complete_render_job(${job.tenant_id}::uuid,${job.job_id}::uuid,${job.lease_token}::uuid,${input.input_hash},${files.pdf},${files.xlsx}) ok`;
  return result?.ok?'stored':'stale';
 }catch(error){
  const permanent=error instanceof Error&&['INVALID_PUBLIC_DOCUMENT','INVALID_RENDER','RENDER_LIMIT'].includes(error.message);
  await db`select app.fail_parse_job(${job.tenant_id}::uuid,${job.job_id}::uuid,${job.lease_token}::uuid,${permanent?(error as Error).message:'RENDER_RETRY'},${!permanent})`;
  return permanent?'invalid':'retry';
 }
 finally{clearInterval(heartbeat);clearTimeout(timeout);controller.abort();}
}
