import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {WorkRequestSchema,workHttp} from '@sigongnote/contracts';

export const liveOrigin='http://127.0.0.1:5189';
export function localApiBase(port=process.env.SIGONGNOTE_LOCAL_API_PORT??'3001'){
 if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw Error('LOCAL_API_PORT_INVALID');
 return `http://127.0.0.1:${Number(port)}`;
}
export type LocalWorkBackend={tenantId:string;call:(path:string,method:string,body?:unknown,key?:string)=>Promise<Response>};

/** Developer-only server, never registered by the production API. Normal API JWT/RLS still applies. */
export async function registerLiveWork(app:FastifyInstance,backend:LocalWorkBackend,root:string,revision:string){
 const sessions=new Map<string,number>();
 const cookieName='sigongnote_local_work';
 const cookie=(request:FastifyRequest)=>request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)??'';
 const authenticated=(request:FastifyRequest)=>(sessions.get(cookie(request))??0)>Date.now();
 app.addHook('onRequest',async(request,reply)=>{
  reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff');
  reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  // A README link may navigate to the public landing page, but never to API/session data.
  const landingNavigation=request.method==='GET'&&request.url.split('?')[0]==='/'&&request.headers['sec-fetch-mode']==='navigate'&&request.headers['sec-fetch-dest']==='document';
  if(request.headers.host!==new URL(liveOrigin).host||(request.headers['sec-fetch-site']==='cross-site'&&!landingNavigation)||(request.headers.origin&&request.headers.origin!==liveOrigin))return reply.code(403).send({error:{code:'LOCAL_ONLY'}});
  if(request.method!=='GET'&&request.method!=='HEAD'&&(request.headers.origin!==liveOrigin||!request.headers['content-type']?.startsWith('application/json')))return reply.code(403).send({error:{code:'ORIGIN_REQUIRED'}});
 });
 app.setErrorHandler((error,_request,reply)=>{const status=(error as {statusCode?:number}).statusCode;return status&&status>=400&&status<500?reply.code(status).send({error:{code:'INVALID_REQUEST'}}):reply.code(503).send({error:{code:'connection_wait'}});});
 app.get('/health',async()=>({service:'sigongnote-live-work',revision}));
 app.get('/connection.json',async()=>({mode:'local-live',providers:[],revision}));
 app.post('/web/local/open',async(_request,reply)=>{
  for(const [key,expiry]of sessions)if(expiry<=Date.now())sessions.delete(key);
  if(sessions.size>=100)return reply.code(429).send({error:{code:'TRY_LATER'}});
  const token=randomBytes(32).toString('base64url');sessions.set(token,Date.now()+12*3600000);
  reply.header('set-cookie',`${cookieName}=${token}; Path=/web; HttpOnly; SameSite=Strict; Max-Age=43200`);
  return {opened:true};
 });
 app.post('/web/logout',async(request,reply)=>{
  sessions.delete(cookie(request));reply.header('set-cookie',`${cookieName}=; Path=/web; HttpOnly; SameSite=Strict; Max-Age=0`);return {signedOut:true};
 });
 app.get('/web/session',async(request,reply)=>{
  if(!authenticated(request))return reply.code(401).send({error:{code:'login_required'}});
  const result=await backend.call('/v1/me','GET');
  if(!result.ok)return reply.code([401,403].includes(result.status)?503:result.status).send({error:{code:'connection_wait'}});
  const profile=await result.json() as {user_id:string;memberships:Array<{tenant_id:string}>};
  return {...profile,memberships:profile.memberships.filter(m=>m.tenant_id===backend.tenantId)};
 });
 app.post('/web/work',{bodyLimit:1100000},async(request,reply)=>{
  if(!authenticated(request))return reply.code(401).send({error:{code:'login_required'}});
  const body=request.body as {tenantId?:unknown;request?:unknown};
  if(body?.tenantId!==backend.tenantId)return reply.code(403).send({error:{code:'FORBIDDEN'}});
  const parsed=WorkRequestSchema.safeParse(body.request);
  if(!parsed.success)return reply.code(400).send({error:{code:'INVALID_REQUEST'}});
  let call;try{call=workHttp(parsed.data);}catch{return reply.code(400).send({error:{code:'INVALID_REQUEST'}});}
  const result=await backend.call(call.path,call.method,call.body,call.key);
  return reply.code(result.status).type('application/json').send(await result.text());
 });
 app.get('/install',async(_request,reply)=>reply.redirect('https://sigongnote-api.onrender.com/install'));
 app.get('/activity',async(_request,reply)=>reply.redirect('/#/activity'));
 app.get('/manifest.webmanifest',async()=>({name:'시공노트 · 이 PC 작업실',short_name:'시공노트 작업실',start_url:'/',display:'standalone'}));
 app.get('/',async(_request,reply)=>reply.type('text/html; charset=utf-8').send(await readFile(join(root,'index.html'))));
 app.get('/assets/:name',async(request,reply)=>{
  const name=(request.params as {name:string}).name;
  if(!/^[\w-]+\.(js|css|svg)$/.test(name))return reply.code(404).send();
  return reply.type(name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'image/svg+xml').send(await readFile(join(root,'assets',name)));
 });
}
