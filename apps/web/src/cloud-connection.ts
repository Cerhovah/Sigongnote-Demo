import {WorkFailure} from './work-client.js';
import {workId} from './work-id.js';
export async function cloudJson(path:string,body?:unknown){
 const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
 if(!response.ok){const value=await response.json().catch(()=>null);throw new WorkFailure(response.status===401?'login_required':value?.error?.code==='ACCOUNT_CHANGED'?'account_changed':value?.error?.code??'connection_wait');}return response.json();
}
export type WorkspaceIntent={user:string;key:string;name:string};
export const workspaceIntentKey=(origin:string,user:string)=>`sigongnote:workspace:v1:${origin}:${user}`;
/** Company creation retries preserve the originally submitted name, including page reloads. */
export function workspaceIntent(store:Pick<Storage,'getItem'|'setItem'>,origin:string,user:string,name:string):WorkspaceIntent{
 const key=workspaceIntentKey(origin,user);let previous:WorkspaceIntent|null=null;try{previous=JSON.parse(store.getItem(key)??'null');}catch{/* Invalid local preference is not a request. */}
 if(previous?.user===user&&typeof previous.key==='string'&&/^[a-f0-9-]{36}$/.test(previous.key)&&typeof previous.name==='string'&&previous.name.trim().length>0&&previous.name.length<=120)return previous;
 const intent={user,key:workId(),name:name.trim()};store.setItem(key,JSON.stringify(intent));return intent;
}
