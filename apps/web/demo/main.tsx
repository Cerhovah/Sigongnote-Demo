import {createRoot} from 'react-dom/client';
import {WorkFieldLedger,type FieldLedgerClient,type FieldLedgerQuery} from '../src/work-field-ledger.js';
import type {FieldLedgerSnapshot} from '../../../packages/domain/src/field-ledger.js';
import '../src/work-field-ledger.css';
import './demo.css';

type Reply={projects:{id:string;name:string}[];snapshot:FieldLedgerSnapshot;csrfToken:string};
let csrfToken='';
async function request<T>(url:string,init?:RequestInit):Promise<T>{
 const response=await fetch(url,{credentials:'same-origin',...init});
 if(!response.ok){const body=await response.json().catch(()=>({message:'요청을 처리하지 못했습니다.'})) as {message?:string};throw new Error(body.message??'요청을 처리하지 못했습니다.');}
 return response.json() as Promise<T>;
}
async function ledger(query:FieldLedgerQuery={}):Promise<Reply>{
 const values=new URLSearchParams();
 if(query.projectId)values.set('project',query.projectId);
 for(const key of ['from','to','search','attribution'] as const)if(query[key])values.set(key,query[key]);
 const result=await request<Reply>('/api/ledger?'+values);csrfToken=result.csrfToken;return result;
}
function base64(file:File):Promise<string>{return new Promise((resolve,reject)=>{
 const reader=new FileReader();reader.onerror=()=>reject(new Error('파일을 읽지 못했습니다.'));
 reader.onload=()=>{const result=reader.result;if(typeof result!=='string')reject(new Error('파일을 읽지 못했습니다.'));else resolve(result.slice(result.indexOf(',')+1));};reader.readAsDataURL(file);
});}
const client:FieldLedgerClient={
 projects:async()=>(await ledger({attribution:'assigned'})).projects,
 snapshot:async query=>(await ledger(query)).snapshot,
 upload:async(file,projectId)=>{
  if(file.size>16*1024*1024)throw new Error('16MB 이하의 파일을 선택해 주세요.');
  if(!csrfToken)await ledger();
  await request('/api/import',{method:'POST',headers:{'Content-Type':'application/json','X-Sigongnote-CSRF':csrfToken},body:JSON.stringify({name:file.name,base64:await base64(file),projectId})});
 },
 exportUrl:(id,format)=>'/api/snapshots/'+encodeURIComponent(id)+'.'+format,
};
const root=document.getElementById('root');if(!root)throw new Error('ROOT_REQUIRED');
createRoot(root).render(<WorkFieldLedger client={client}/>);
