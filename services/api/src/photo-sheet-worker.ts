import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {Db} from './auth.js';
import {rendererEnvironment,type ParseInput} from './parse-worker.js';
import {PhotoSheetSnapshot} from './photo-sheets.js';
type Options={db:Db;python:string;pythonRoot:string;owner?:string;tenantScope?:string;fontPath?:string;download:(input:ParseInput,signal:AbortSignal)=>Promise<Buffer>};
export async function runPhotoSheetOnce(o:Options){
 const [j]=await o.db`select * from app.claim_photo_sheet(${o.owner??'photo-worker'},${o.tenantScope??null}::uuid)`;if(!j)return 'idle';
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),180000);let dir:string|undefined;let extending=false;const heartbeat=setInterval(()=>{if(extending)return;extending=true;void o.db`select app.extend_parse_job_lease(${j.tenant_id}::uuid,${j.job_id}::uuid,${j.lease_token}::uuid,120) ok`.then(r=>{if(!r[0]?.ok)abort.abort();},()=>abort.abort()).finally(()=>{extending=false;});},15000);
 try{
  const [r]=await o.db`select app.photo_sheet_input(${j.tenant_id}::uuid,${j.job_id}::uuid,${j.lease_token}::uuid) value`;if(!r?.value)throw Error('SOURCE_UNAVAILABLE');const input=r.value,snapshot=PhotoSheetSnapshot.parse(input.snapshot);
  dir=await mkdtemp(join(tmpdir(),'sigongnote-photo-'));
  for(const [i,s] of input.sources.entries()){if(s.byte_length>20971520)throw Error('PHOTO_LIMIT');if(abort.signal.aborted)throw Error('RENDER_RETRY');const bytes=await o.download(s,abort.signal);if(bytes.length!==Number(s.byte_length)||createHash('sha256').update(bytes).digest('hex')!==s.sha256)throw Error('PHOTO_HASH');await writeFile(join(dir,i+'.image'),bytes,{mode:0o600});}
  const text=await new Promise<string>((resolve,reject)=>{const child=spawn(o.python,['-m','sigongnote_worker.photo_sheet',dir!],{windowsHide:true,signal:abort.signal,env:rendererEnvironment(o.pythonRoot,o.fontPath),stdio:['pipe','pipe','pipe']});let output='',size=0,overflow=false;child.stdout.setEncoding('utf8');child.stdout.on('data',(s:string)=>{size+=Buffer.byteLength(s);if(size>7100000){overflow=true;child.kill();}else output+=s;});child.stderr.resume();child.on('error',()=>reject(Error('RENDER_RETRY')));child.on('close',code=>code===0&&!overflow?resolve(output):reject(Error('PHOTO_RENDER')));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(snapshot));});
  const result=JSON.parse(text),pdf=Buffer.from(result.pdf,'base64');if(pdf.length>5242880||pdf.subarray(0,5).toString()!=='%PDF-')throw Error('PHOTO_LIMIT');
  const [done]=await o.db`select app.complete_photo_sheet(${j.tenant_id}::uuid,${j.job_id}::uuid,${j.lease_token}::uuid,${input.input_hash},${pdf},${result.pages}) ok`;return done?.ok?'stored':'stale';
 }catch(e){const permanent=e instanceof Error&&['PHOTO_LIMIT','PHOTO_HASH','SOURCE_UNAVAILABLE','PHOTO_RENDER'].includes(e.message);await o.db`select app.fail_parse_job(${j.tenant_id}::uuid,${j.job_id}::uuid,${j.lease_token}::uuid,${permanent?(e as Error).message:'PHOTO_RETRY'},${!permanent})`;return permanent?'unavailable':'retry';}
 finally{clearInterval(heartbeat);clearTimeout(timer);abort.abort();if(dir)await rm(dir,{recursive:true,force:true});}
}
