import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Tx} from './auth.js';
import {ApiFault} from './routes.js';
import {readPhotoSheet} from './photo-sheets.js';
import {readIssuedDocument} from './document-issuance.js';
import {parserEnvironment} from './parse-worker.js';
const root=fileURLToPath(new URL('../../document-worker/',import.meta.url));
export async function pdfPages(bytes:Buffer){
 const text=await new Promise<string>((done,fail)=>{const child=spawn(process.env.DOCUMENT_PYTHON??resolve(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['-m','sigongnote_worker.pdf_pages'],{windowsHide:true,env:parserEnvironment(root),stdio:['pipe','pipe','pipe'],signal:AbortSignal.timeout(15000)});let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',(v:string)=>{output+=v;if(output.length>100)child.kill();});child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',()=>fail(new ApiFault('TEMPORARILY_UNAVAILABLE')));child.on('close',code=>code===0?done(output):fail(new ApiFault('DOMAIN_INVARIANT')));child.stdin.end(bytes);});
 const pages=Number(text.trim());if(!Number.isInteger(pages)||pages<1||pages>100)throw new ApiFault('DOMAIN_INVARIANT');return pages;
}
export async function deliverySource(tx:Tx,tenant:string,kind:'document'|'photo_sheet',id:string,count=false,loadBytes=true){
 if(kind==='photo_sheet'){
  const s=await readPhotoSheet(tx,tenant,id),[a]=await tx`select case when ${loadBytes} then bytes else null end bytes,sha256,pages from app.photo_sheet_artifacts where tenant_id=${tenant}::uuid and sheet_id=${id}::uuid`;
  if(!a)throw new ApiFault('TEMPORARILY_UNAVAILABLE');return {project:s.snapshot.project_id,revision:id,title:s.snapshot.title,sha256:String(a.sha256),bytes:loadBytes?Buffer.from(a.bytes):Buffer.alloc(0),pages:Number(a.pages)};
 }
 const d=await readIssuedDocument(tx,tenant,id);if(d.state!=='approved')throw new ApiFault('DOMAIN_INVARIANT');
 // Reuse the page count only for exactly the same approved revision and artifact hash.
 const [a]=await tx`select a.sha256,c.pages,case when ${loadBytes} or (${count} and c.pages is null) then a.bytes else null end bytes from app.document_artifacts a left join lateral(select pages from app.deliveries where tenant_id=a.tenant_id and source_kind='document' and source_id=${id}::uuid and revision_id=a.revision_id and document_hash=a.sha256 limit 1)c on true where a.tenant_id=${tenant}::uuid and a.revision_id=${d.revision_id}::uuid and a.format='pdf'`;
 if(!a)throw new ApiFault('TEMPORARILY_UNAVAILABLE');
 return {project:d.document.project.id,revision:d.revision_id,title:d.document.document_number,sha256:String(a.sha256),bytes:loadBytes?Buffer.from(a.bytes):Buffer.alloc(0),pages:count?(a.pages===null?await pdfPages(Buffer.from(a.bytes)):Number(a.pages)):null};
}
