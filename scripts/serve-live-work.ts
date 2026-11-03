import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import Fastify from 'fastify';
import {createClient,type Session} from '@supabase/supabase-js';
import {UuidSchema,WorkspaceResponseSchema} from '@sigongnote/contracts';
import {loadLocalApiConfig} from '../services/api/src/config.js';
import {registerLiveWork,localApiBase,type LocalWorkBackend} from './live-work-routes.js';

const repo=resolve(fileURLToPath(new URL('..',import.meta.url))),dir=join(repo,'.work/live-work');
const api=localApiBase();
type Identity={marker:string;userId:string;workspaceKey:string;tenantId?:string};
let stage='config';

async function main(){
 const config=loadLocalApiConfig(); // Explicitly rejects production Auth/DB endpoints.
 const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
 const admin=createClient(config.supabaseUrl,config.secretKey,options),auth=createClient(config.supabaseUrl,config.publishableKey,options);
 await mkdir(dir,{recursive:true});
 let identity:Identity;
 const save=async()=>{await writeFile(join(dir,'identity.tmp'),JSON.stringify(identity),{mode:0o600});await rename(join(dir,'identity.tmp'),join(dir,'identity.json'));};
 try{identity=JSON.parse(await readFile(join(dir,'identity.json'),'utf8')) as Identity;UuidSchema.parse(identity.marker);UuidSchema.parse(identity.userId);UuidSchema.parse(identity.workspaceKey);if(identity.tenantId)UuidSchema.parse(identity.tenantId);}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('LOCAL_IDENTITY_INVALID');
  const marker=randomUUID();const {data,error}=await admin.auth.admin.createUser({email:`local-work-${marker}@sigongnote.invalid`,email_confirm:true,app_metadata:{local_live_workspace:marker}});
  if(error||!data.user)throw Error('LOCAL_IDENTITY_CREATE_FAILED');
  identity={marker,userId:data.user.id,workspaceKey:randomUUID()};await save();
 }
 stage='identity';const {data:owner,error:ownerError}=await admin.auth.admin.getUserById(identity.userId);
 const email=`local-work-${identity.marker}@sigongnote.invalid`;
 if(ownerError||owner.user?.email!==email||owner.user.app_metadata.local_live_workspace!==identity.marker)throw Error('LOCAL_IDENTITY_MISMATCH');
 // Local Auth only. generateLink does not send mail. No existing user is impersonated.
 const {data:link,error:linkError}=await admin.auth.admin.generateLink({type:'magiclink',email});
 if(linkError||!link.properties?.hashed_token)throw Error('LOCAL_SIGNIN_FAILED');
 const {data:login,error:loginError}=await auth.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'email'});
 if(loginError||!login.session||login.user?.id!==identity.userId)throw Error('LOCAL_SIGNIN_FAILED');
 stage='workspace';let session:Session=login.session,pending:Promise<void>|undefined;
 const access=async()=>{
  if((session.expires_at??0)*1000<Date.now()+60000){
   pending??=(async()=>{const {data,error}=await auth.auth.refreshSession({refresh_token:session.refresh_token});if(error||!data.session||data.user?.id!==identity.userId)throw Error('LOCAL_SESSION_EXPIRED');session=data.session;})();
   try{await pending;}finally{pending=undefined;}
  }return session.access_token;
 };
 const call:LocalWorkBackend['call']=async(path,method,body,key)=>{
  if(!path.startsWith('/v1/')||path.startsWith('//'))throw Error('INVALID_API_PATH');
  return fetch(api+path,{method,headers:{authorization:`Bearer ${await access()}`,...(path==='/v1/me'||path==='/v1/workspaces'?{}:{'x-tenant-id':identity.tenantId!}),...(body===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(45000)});
 };
 if(!identity.tenantId){
  const result=await call('/v1/workspaces','POST',{display_name:'내 개발 작업실'},identity.workspaceKey);
  if(!result.ok)throw Error('LOCAL_WORKSPACE_CREATE_FAILED');identity.tenantId=WorkspaceResponseSchema.parse(await result.json()).tenant_id;await save();
 }
 stage='profile';const profile=await call('/v1/me','GET');
 if(!profile.ok||!(await profile.json() as {memberships:Array<{tenant_id:string}>}).memberships.some(m=>m.tenant_id===identity.tenantId))throw Error('LOCAL_WORKSPACE_NOT_ACCESSIBLE');
 stage='web-build';const build=JSON.parse(await readFile(join(dir,'web/build-info.json'),'utf8')) as {revision:string;sourceDirty:boolean};
 const app=Fastify({logger:false});
 stage='routes';await registerLiveWork(app,{tenantId:identity.tenantId,call},join(dir,'web'),build.revision+(build.sourceDirty?' + 로컬 수정':''));
 stage='listen';await app.listen({host:'127.0.0.1',port:5189});
 console.log('READY http://127.0.0.1:5189/');
}
main().catch(error=>{const code=error instanceof Error&&/^LOCAL_[A-Z_]+$/.test(error.message)?error.message:/^[A-Z_]+$/.test(error?.code??'')?error.code:'LOCAL_START_FAILED';console.error(`${code} (${stage}): Check local API/Auth, identity.json and the web build; no credentials were logged.`);process.exitCode=1;});
