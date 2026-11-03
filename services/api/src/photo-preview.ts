import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const workerRoot=fileURLToPath(new URL('../../document-worker/',import.meta.url));
import {z} from 'zod';
import {parserEnvironment} from './parse-worker.js';
import {ApiFault,type Services} from './routes.js';
let active=0;
/** Bounded native decoding; no image bytes, EXIF location or filenames enter model prompts. */
export async function photoPreview(source:{storage_key:string;sha256:string;byte_length:string|number},services:Pick<Services,'storage'>){
 if(Number(source.byte_length)>20_971_520)throw new ApiFault('PAYLOAD_TOO_LARGE');
 if(active>=2)throw new ApiFault('TEMPORARILY_UNAVAILABLE');active++;
 try{
  if(!services.storage?.readBytes)throw new ApiFault('TEMPORARILY_UNAVAILABLE');
  const bytes=await services.storage.readBytes(source.storage_key,20_971_520);
  if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new ApiFault('DOMAIN_INVARIANT');
  const output=await new Promise<string>((done,fail)=>{
   const child=spawn(process.env.DOCUMENT_PYTHON??resolve(workerRoot,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['-m','sigongnote_worker.photo_preview'],{windowsHide:true,env:parserEnvironment(workerRoot),stdio:['pipe','pipe','pipe'],signal:AbortSignal.timeout(20_000)});
   let text='';child.stdout.setEncoding('utf8');child.stdout.on('data',(v:string)=>{text+=v;if(text.length>300_000)child.kill();});child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',fail);child.on('close',code=>code===0?done(text):fail(new Error('PHOTO_PREVIEW_FAILED')));child.stdin.end(bytes);
  });
  return z.strictObject({base64:z.string().max(280000).regex(/^[A-Za-z0-9+/]+={0,2}$/),mime:z.literal('image/jpeg'),width:z.number().int().positive(),height:z.number().int().positive(),exif_date_hint:z.string().max(19).nullable()}).parse(JSON.parse(output));
 }finally{active--;}
}
