import assert from 'node:assert/strict';import {test} from 'node:test';import {randomUUID} from 'node:crypto';import {tmpdir} from 'node:os';import Fastify from 'fastify';
import {registerCloudWeb} from '../services/api/src/cloud-web.js';import {cloudWorkClient} from '../apps/web/src/cloud-app.js';import {workspaceIntent} from '../apps/web/src/cloud-connection.js';
const site='https://fixture.example',user=randomUUID(),tenant=randomUUID();
const cookie=(r:any,name:string)=>(Array.isArray(r.headers['set-cookie'])?r.headers['set-cookie']:[r.headers['set-cookie']]).find((v:string)=>v.startsWith(name+'='))?.split(';')[0];
test('N25 enabled Naver and Kakao link back to the same account; cancellation and foreign sessions preserve the old company',async()=>{
 const app=Fastify();let returnedUser=user,exchanges=0,workCalls=0,linkState='',malicious=false;
 app.get('/v1/me',async()=>({user_id:user,memberships:[{tenant_id:tenant,tenant_name:'합성 회사',role:'owner'}]}));
 app.get('/v1/work/context',async()=>{workCalls++;return {tenant_id:tenant,user_id:user};});
 await registerCloudWeb(app,{authOrigin:'https://auth.example',publicOrigin:site,publishableKey:'fixture-public',providers:['custom:kakao','custom:naver'],sessionSecret:Buffer.alloc(32,4).toString('base64'),webRoot:tmpdir(),transport:async(input,init)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/identities/authorize')){assert.equal((init?.headers as Record<string,string>|undefined)?.Authorization,'Bearer synthetic-access');assert.equal(url.searchParams.get('code_challenge_method'),'s256');linkState=new URL(url.searchParams.get('redirect_to')??'').searchParams.get('state')!;return Response.json({url:malicious?'https://other.example/steal':'https://kauth.kakao.com/oauth/authorize?state=synthetic'});}
  if(url.pathname.endsWith('/user'))return Response.json({id:user,identities:[{provider:'custom:naver'}]});
  if(url.pathname.endsWith('/token')){exchanges++;return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,user:{id:returnedUser}});}
  throw Error('Unexpected auth call');
 }});
 try{
  assert.deepEqual((await app.inject('/connection.json')).json().providers,['custom:naver','custom:kakao']);
  const start=await app.inject('/web/auth/start?provider=custom%3Anaver'),state=new URL(new URL(String(start.headers.location)).searchParams.get('redirect_to')!).searchParams.get('state');
  const signed=await app.inject({url:`/web/auth/callback?state=${state}&code=fixture`,headers:{cookie:cookie(start,'sigongnote_login')}}),session=cookie(signed,'sigongnote_web');
  const post=(origin=site,expected=user)=>app.inject({method:'POST',url:'/web/auth/start',headers:{cookie:session,origin},payload:{provider:'custom:kakao',expected_user_id:expected}});
  const info=await app.inject({url:'/web/session?connections=1',headers:{cookie:session}});assert.deepEqual(info.json().linked_providers,['custom:naver']);assert.equal(info.json().memberships[0].tenant_id,tenant);assert.ok(!info.body.includes('synthetic-access'));
  assert.equal((await post('https://other.example')).statusCode,403);assert.equal((await post(site,randomUUID())).statusCode,409);
  malicious=true;assert.equal((await post()).statusCode,503);malicious=false;
  let link=await post();assert.equal(link.statusCode,200);let flow=cookie(link,'sigongnote_login');const before=exchanges;
  assert.equal((await app.inject({url:`/web/auth/callback?state=${linkState}&error=access_denied`,headers:{cookie:session+'; '+flow}})).headers.location,'/?account=retry');assert.equal(exchanges,before);
  link=await post();flow=cookie(link,'sigongnote_login');assert.equal((await app.inject({url:`/web/auth/callback?state=${linkState}&code=fixture`,headers:{cookie:flow}})).headers.location,'/?account=retry');assert.equal(exchanges,before);
  returnedUser=randomUUID();const wrong=await app.inject({url:`/web/auth/callback?state=${linkState}&code=fixture`,headers:{cookie:session+'; '+flow}});assert.equal(wrong.headers.location,'/?account=retry');assert.equal(cookie(wrong,'sigongnote_web'),undefined);
  returnedUser=user;link=await post();flow=cookie(link,'sigongnote_login');const linked=await app.inject({url:`/web/auth/callback?state=${linkState}&code=fixture`,headers:{cookie:session+'; '+flow}});assert.equal(linked.headers.location,'/?account=linked');
  const next=cookie(linked,'sigongnote_web');assert.equal((await app.inject({url:'/web/session',headers:{cookie:next}})).json().memberships[0].tenant_id,tenant);
  const foreign=await app.inject({method:'POST',url:'/web/work',headers:{cookie:next,origin:site},payload:{tenantId:tenant,expected_user_id:randomUUID(),request:{route:'context'}}});assert.equal(foreign.statusCode,409);assert.equal(workCalls,0);
  assert.equal((await app.inject({method:'POST',url:'/web/work',headers:{cookie:next,origin:site},payload:{tenantId:tenant,expected_user_id:user,request:{route:'context'}}})).statusCode,200);assert.equal(workCalls,1);
 }finally{await app.close();}
});

test('N25 browser queue rejects late replies after company switch and sends the expected user',async()=>{
 const previous=globalThis.fetch;let release!:(v:Response)=>void;let expired=0;
 globalThis.fetch=async(_input,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.expected_user_id,user);assert.equal(body.tenantId,tenant);return new Promise< Response>(resolve=>{release=resolve;});};
 try{const client=cloudWorkClient(tenant,()=>{expired++;},user),pending=client.request({route:'context'});client.dispose();release(Response.json({user_id:user}));await assert.rejects(pending,(e:any)=>e.code==='account_changed');assert.equal(expired,0);await assert.rejects(client.request({route:'context'}),(e:any)=>e.code==='account_changed');
  globalThis.fetch=async()=>Response.json({error:{code:'ACCOUNT_CHANGED'}},{status:409});const next=cloudWorkClient(tenant,()=>{expired++;},user);await assert.rejects(next.request({route:'context'}),(e:any)=>e.code==='account_changed');assert.equal(expired,1);
 }finally{globalThis.fetch=previous;}
});
test('N25 a lost first-company response keeps its key and submitted name across reload and account changes',()=>{
 const data=new Map<string,string>(),store={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
 const first=workspaceIntent(store,site,user,'합성 회사');assert.deepEqual(workspaceIntent(store,site,user,'나중에 바꾼 이름'),first);
 assert.notEqual(workspaceIntent(store,site,randomUUID(),'다른 합성 회사').key,first.key);assert.notEqual(workspaceIntent(store,'https://other.example',user,'합성 회사').key,first.key);
});
