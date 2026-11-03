import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from './agent.js';
export async function renderApprovedQuote(dataDir:string,snapshot:unknown){
 const repo=process.env.SIGONGNOTE_REPO??fileURLToPath(new URL('../../../',import.meta.url)),worker=path.join(repo,'services/document-worker'),out=path.join(dataDir,'quote-copies');
 const body=JSON.stringify(snapshot);if(Buffer.byteLength(body)>262144)throw new Error('FIELD_QUOTE_TOO_LARGE');
 const result=await new Promise<{approval_id:string;pdf_sha256:string}>((resolve,reject)=>{
  const child=spawn(process.env.SIGONGNOTE_PYTHON??path.join(worker,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),['-m','sigongnote_worker.quote_command',out],{
   cwd:worker,windowsHide:true,stdio:'pipe',env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,LOCALAPPDATA:process.env.LOCALAPPDATA,PYTHONPATH:path.join(worker,'src'),PYTHONIOENCODING:'utf-8'}});
  let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('FIELD_QUOTE_TIMEOUT'));},60000);
  child.stdout.on('data',(chunk:Buffer)=>{output+=chunk.toString('utf8');if(output.length>10000){child.kill();reject(new Error('FIELD_QUOTE_FAILED'));}});child.stderr.resume();
  child.on('error',()=>{clearTimeout(timer);reject(new Error('FIELD_QUOTE_FAILED'));});
  child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw new Error();const value=JSON.parse(output);if(!/^[a-f0-9-]{36}$/.test(value.approval_id)||!/^[a-f0-9]{64}$/.test(value.pdf_sha256))throw new Error();resolve(value);}catch{reject(new Error('FIELD_QUOTE_FAILED'));}});
  child.stdin.on('error',()=>{});child.stdin.end(body);
 });
 const bytes=await readFile(path.join(out,result.approval_id,'quote.pdf'));if(sha256(bytes)!==result.pdf_sha256)throw new Error('FIELD_QUOTE_FAILED');return {bytes,sha256:result.pdf_sha256};
}
