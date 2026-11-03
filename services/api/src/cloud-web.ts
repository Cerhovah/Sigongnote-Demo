import {createCipheriv,createDecipheriv,randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {WorkRequestSchema,workHttp,UuidSchema} from '@sigongnote/contracts';

export type CloudWebOptions={authOrigin:string;publishableKey:string;sessionSecret:string;publicOrigin:string;providers:string[];webRoot:string;transport?:typeof fetch};
type Session={id:string;access:string;refresh:string;user:string;expires:number;started:number};
type Flow={verifier:string;state:string;started:number;user?:string;sessionId?:string};
const sessionAge=30*86400,flowAge=600;
const cookieSession='sigongnote_web',cookieFlow='sigongnote_login';
const providerNames=new Set(['google','custom:naver','custom:kakao']);
class AuthFailure extends Error {constructor(readonly status:number){super('AUTH_UNAVAILABLE');}}
function origin(value:string){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Invalid public web origin');return u.origin;}
function cookie(request:FastifyRequest,name:string){return request.headers.cookie?.split(';').map(p=>p.trim()).find(p=>p.startsWith(name+'='))?.slice(name.length+1);}

/** Same-origin browser BFF. Native credentials and browser refresh tokens never enter page JavaScript. */
export async function registerCloudWeb(app:FastifyInstance,options:CloudWebOptions){
 const site=origin(options.publicOrigin),auth=origin(options.authOrigin),transport=options.transport??fetch;
 const key=Buffer.from(options.sessionSecret,'base64');if(key.length!==32)throw new Error('CLOUD_WEB_SESSION_SECRET must encode 32 random bytes');
 if(options.providers.some(p=>!providerNames.has(p))||options.publishableKey.startsWith('sb_secret_'))throw new Error('Invalid public login config');
 const root=resolve(options.webRoot),callback=site+'/web/auth/callback';
 const seal=(value:unknown)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(JSON.stringify(value),'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64url');};
 function open<T>(value:string|undefined):T|null{try{if(!value||value.length>6000)return null;const b=Buffer.from(value,'base64url');if(b.length<29||b.toString('base64url')!==value)return null;const decipher=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));decipher.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([decipher.update(b.subarray(12,-16)),decipher.final()]).toString('utf8')) as T;}catch{return null;}}
 function set(reply:FastifyReply,name:string,value:string,age:number){const item=`${name}=${value}; Path=/web; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;const prior=reply.getHeader('set-cookie');reply.header('set-cookie',[...(Array.isArray(prior)?prior:prior?[String(prior)]:[]),item]);}
 function noCache(reply:FastifyReply){reply.header('Cache-Control','no-store');reply.header('Referrer-Policy','no-referrer');}
 function sameOrigin(request:FastifyRequest){return request.headers.origin===site;}
 async function authCall(path:string,body:unknown,access?:string){const r=await transport(auth+'/auth/v1/'+path,{method:'POST',headers:{apikey:options.publishableKey,'Content-Type':'application/json',...(access?{Authorization:`Bearer ${access}`}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw new AuthFailure(r.status);return r;}
 function decodeLogin(data:Record<string,unknown>,previous?:Session):Session {const user=UuidSchema.parse((data.user as {id?:unknown})?.id);const seconds=Number(data.expires_in);if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string'||!data.access_token||!data.refresh_token||!Number.isFinite(seconds)||seconds<60||seconds>86400||previous&&previous.user!==user)throw new Error('Invalid login');return {id:previous?.id??randomUUID(),access:data.access_token,refresh:data.refresh_token,user,expires:Date.now()+seconds*1000,started:previous?.started??Date.now()};}
 // Concurrent tabs presenting the previous cookie share one refresh, including refresh-token rotation.
 const refreshing=new Map<string,Promise<Session>>(),recent=new Map<string,{expires:number;session:Session}>();
 async function session(request:FastifyRequest,reply:FastifyReply){
  noCache(reply);let current=open<Session>(cookie(request,cookieSession));
  if(!current||!UuidSchema.safeParse(current.user).success||Date.now()-current.started>sessionAge*1000||current.started>Date.now()||!current.id)return null;
  if(current.expires>Date.now()+60000)return current;
  for(const [id,row]of recent)if(row.expires<Date.now())recent.delete(id);
  const rotated=recent.get(current.id);if(rotated)current=rotated.session;
  else {let pending=refreshing.get(current.id);if(!pending){const before=current;pending=(async()=>decodeLogin(await(await authCall('token?grant_type=refresh_token',{refresh_token:before.refresh})).json() as Record<string,unknown>,before))();refreshing.set(current.id,pending);}
   try{current=await pending;recent.set(current.id,{expires:Date.now()+120000,session:current});}catch(error){if(error instanceof AuthFailure&&[400,401].includes(error.status)){set(reply,cookieSession,'',0);return null;}throw error;}finally{refreshing.delete(current.id);}}
  set(reply,cookieSession,seal(current),sessionAge);return current;
 }
 const providers=['custom:naver','custom:kakao','google'].filter(p=>options.providers.includes(p));
 app.get('/connection.json',async(_request,reply)=>{noCache(reply);return {mode:'cloud',providers,apiOrigin:site};});
 app.post('/web/auth/start',async(request,reply)=>{
  noCache(reply);if(!sameOrigin(request))return reply.code(403).send({error:'ORIGIN_REQUIRED'});
  const login=await session(request,reply);if(!login)return reply.code(401).send({error:'LOGIN_REQUIRED'});
  const body=request.body as {provider?:unknown;expected_user_id?:unknown};
  if(body?.expected_user_id!==login.user)return reply.code(409).send({error:{code:'ACCOUNT_CHANGED'}});
  if(typeof body.provider!=='string'||!providers.includes(body.provider))return reply.code(400).send({error:'LOGIN_PROVIDER_UNAVAILABLE'});
  const flow:Flow={verifier:randomBytes(32).toString('base64url'),state:randomBytes(32).toString('base64url'),started:Date.now(),user:login.user,sessionId:login.id};
  const params=new URLSearchParams({provider:body.provider,redirect_to:callback+'?state='+flow.state,code_challenge:createHash('sha256').update(flow.verifier).digest('base64url'),code_challenge_method:'s256',skip_http_redirect:'true'});
  try{
   const result=await transport(auth+'/auth/v1/user/identities/authorize?'+params,{headers:{apikey:options.publishableKey,Authorization:`Bearer ${login.access}`},redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!result.ok)return reply.code(503).send({error:{code:'IDENTITY_LINK_UNAVAILABLE'}});
   const payload=await result.json() as {url?:unknown};if(typeof payload.url!=='string'||payload.url.length>8192)throw Error('Invalid authorization');const url=new URL(payload.url);
   const host={'custom:naver':'nid.naver.com','custom:kakao':'kauth.kakao.com',google:'accounts.google.com'}[body.provider];
   if(url.protocol!=='https:'||url.hostname!==host||url.username||url.password||url.hash||(url.port&&url.port!=='443'))throw Error('Invalid authorization');
   set(reply,cookieFlow,seal(flow),flowAge);return {url:url.href};
  }catch{return reply.code(503).send({error:{code:'IDENTITY_LINK_UNAVAILABLE'}});}
 });
 app.get('/web/auth/start',async(request,reply)=>{
  noCache(reply);const provider=(request.query as {provider?:string}).provider;if(!provider||!options.providers.includes(provider))return reply.code(400).send({error:'LOGIN_PROVIDER_UNAVAILABLE'});
  const flow:Flow={verifier:randomBytes(32).toString('base64url'),state:randomBytes(32).toString('base64url'),started:Date.now()};set(reply,cookieFlow,seal(flow),flowAge);
  const url=new URL(auth+'/auth/v1/authorize');url.search=new URLSearchParams({provider,redirect_to:callback+'?state='+flow.state,code_challenge:createHash('sha256').update(flow.verifier).digest('base64url'),code_challenge_method:'s256'}).toString();return reply.redirect(url.href);
 });
 app.get('/web/auth/callback',async(request,reply)=>{
  noCache(reply);const flow=open<Flow>(cookie(request,cookieFlow)),q=request.query as Record<string,unknown>;set(reply,cookieFlow,'',0);
  const retry=flow?.user?'/?account=retry':'/?login=retry';
  if(!flow||Date.now()-flow.started>flowAge*1000||flow.started>Date.now()||q.state!==flow.state||typeof q.code!=='string'||q.code.length>2048||q.error)return reply.redirect(retry);
  try{
   const before=flow.user?await session(request,reply):null;
   if(flow.user&&(!before||before.user!==flow.user||before.id!==flow.sessionId))return reply.redirect(retry);
   const login=decodeLogin(await(await authCall('token?grant_type=pkce',{auth_code:q.code,code_verifier:flow.verifier})).json() as Record<string,unknown>,before??undefined);
   if(before)recent.delete(before.id);set(reply,cookieSession,seal(login),sessionAge);return reply.redirect(flow.user?'/?account=linked':'/');
  }catch{return reply.redirect(retry);}
 });
 app.get('/web/session',async(request,reply)=>{
  const login=await session(request,reply);if(!login)return reply.code(401).send({error:'LOGIN_REQUIRED'});
  const result=await app.inject({method:'GET',url:'/v1/me',headers:{authorization:`Bearer ${login.access}`}});
  if(result.statusCode===200&&(request.query as {connections?:string}).connections==='1'){
   try{const r=await transport(auth+'/auth/v1/user',{headers:{apikey:options.publishableKey,Authorization:`Bearer ${login.access}`},redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Unavailable');const user=await r.json() as {id:string;identities?:{provider:string}[]};if(user.id!==login.user)throw Error('Account changed');return {...result.json<Record<string,unknown>>(),linked_providers:(user.identities??[]).map(i=>i.provider).filter(p=>providerNames.has(p))};}
   catch{return reply.code(503).send({error:{code:'IDENTITY_LINK_UNAVAILABLE'}});}
  }
  return reply.code(result.statusCode).type('application/json').send(result.body);
 });
 app.post('/web/work',{bodyLimit:1100000},async(request,reply)=>{
  noCache(reply);if(!sameOrigin(request))return reply.code(403).send({error:'ORIGIN_REQUIRED'});const login=await session(request,reply);if(!login)return reply.code(401).send({error:{code:'login_required'}});
  const body=request.body as {tenantId?:unknown;request?:unknown;expected_user_id?:unknown};const tenant=UuidSchema.safeParse(body?.tenantId),input=WorkRequestSchema.safeParse(body?.request);if(!tenant.success||!input.success)return reply.code(400).send({error:{code:'INVALID_REQUEST'}});
  if(body.expected_user_id!==undefined&&body.expected_user_id!==login.user)return reply.code(409).send({error:{code:'ACCOUNT_CHANGED'}});
  const call=workHttp(input.data),result=await app.inject({method:call.method,url:call.path,headers:{authorization:`Bearer ${login.access}`,'x-tenant-id':tenant.data,...(call.key?{'idempotency-key':call.key}:{}),...(call.body?{'content-type':'application/json'}:{})},...(call.body?{payload:JSON.stringify(call.body)}:{})});return reply.code(result.statusCode).type('application/json').send(result.body);
 });
 app.post('/web/workspace',async(request,reply)=>{
  noCache(reply);if(!sameOrigin(request))return reply.code(403).send({error:'ORIGIN_REQUIRED'});const login=await session(request,reply);if(!login)return reply.code(401).send({error:'LOGIN_REQUIRED'});
  const body=request.body as {name?:unknown;key?:unknown;expected_user_id?:unknown};if(typeof body?.name!=='string'||body.name.trim().length<1||body.name.length>120||!UuidSchema.safeParse(body.key).success)return reply.code(400).send({error:'INVALID_REQUEST'});
  if(body.expected_user_id!==undefined&&body.expected_user_id!==login.user)return reply.code(409).send({error:{code:'ACCOUNT_CHANGED'}});
  const result=await app.inject({method:'POST',url:'/v1/workspaces',headers:{authorization:`Bearer ${login.access}`,'content-type':'application/json','idempotency-key':String(body.key)},payload:{display_name:body.name.trim()}});return reply.code(result.statusCode).type('application/json').send(result.body);
 });
 app.post('/web/logout',async(request,reply)=>{
  noCache(reply);if(!sameOrigin(request))return reply.code(403).send({error:'ORIGIN_REQUIRED'});const login=await session(request,reply);
  if(login){try{await authCall('logout?scope=local',{},login.access);}catch{return reply.code(503).send({error:'LOGOUT_RETRY'});}recent.delete(login.id);}
  set(reply,cookieSession,'',0);set(reply,cookieFlow,'',0);return {signedOut:true};
 });
 async function file(name:string,reply:FastifyReply){try{const data=await readFile(join(root,name));reply.header('X-Content-Type-Options','nosniff');reply.header('Referrer-Policy','no-referrer');reply.header('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${auth}; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`);reply.header('Cache-Control',name==='index.html'?'no-cache':'public,max-age=31536000,immutable');return reply.type(name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8').send(data);}catch{return reply.code(404).send({error:'NOT_FOUND'});}}
 const index=async(request:FastifyRequest,reply:FastifyReply)=>{const q=request.query as Record<string,unknown>;if(q.demo!==undefined||(q.work!==undefined&&q.work!=='cloud'))return reply.redirect('/');return file('index.html',reply);};
 app.get('/',index);app.get('/index.html',index);app.get('/install',async(_request,reply)=>file('index.html',reply));
 app.get('/activity',async(_request,reply)=>reply.redirect('/#/activity'));
 const release='https://github.com/Cerhovah/Sigongnote-downloads/releases/download/';
 const downloads:Record<string,string>={android:'v0.3.0-rc.13/Sigongnote-Android.apk',windows:'v0.3.0-rc.13/Sigongnote-Setup.exe',checksums:'v0.3.0-rc.13/SHA256SUMS.txt','windows-checksums':'v0.3.0-rc.13/SHA256SUMS.txt'};
 app.get('/download/:platform',async(request,reply)=>{noCache(reply);const platform=(request.params as {platform:string}).platform;const target=Object.hasOwn(downloads,platform)?downloads[platform]:undefined;if(!target)return reply.code(404).send({error:'NOT_FOUND'});return reply.redirect(release+target);});
 app.get('/manifest.webmanifest',async(_request,reply)=>reply.header('Cache-Control','no-cache').type('application/manifest+json').send({id:'/',name:'시공노트',short_name:'시공노트',lang:'ko',start_url:'/',scope:'/',display:'standalone',background_color:'#f6f7f9',theme_color:'#243e8b',icons:[{src:'/app-icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]}));
 app.get('/app-icon.svg',async(_request,reply)=>reply.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#243e8b"/><path d="M128 224 256 112 384 224V392H288V288H224V392H128Z" fill="white"/></svg>'));
 app.get('/assets/:name',async(request,reply)=>{const name=(request.params as {name:string}).name;if(!/^[a-zA-Z0-9_-]+\.(js|css|svg)$/.test(name))return reply.code(404).send();return file('assets/'+name,reply);});
}
